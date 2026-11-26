/**
 * Ordered reviewer-route policy for `@aghost-prj/dsh-auto-review-model`.
 *
 * Reviews are served by one ordered list of explicit routes: the legacy primary
 * route (`provider`, `model`, `reasoningEffort`, kept as a separate config field
 * for backward compatibility) followed by the ordered `fallbacks` array. The
 * intercepted review request's own provider/model is always the implicit FINAL
 * attempt; it cannot be configured, reordered or stored, and it never forces a
 * reasoning effort.
 *
 * Legacy configuration values may still contain `{ mode: 'session' }` entries
 * from the older "follow session" row type. Those entries are ignored: the
 * session model is implicit now, so an explicit entry carrying that marker is
 * never scheduled as a configured route.
 *
 * This module owns everything that is pure and testable:
 *
 * - reading and normalizing the volatile `fallbacks` value;
 * - building the deterministic attempt order (primary first when complete,
 *   then the array in order, skipping incomplete entries, then the implicit
 *   session route unless an explicit attempt already uses it);
 * - deciding whether one observed failure may be answered by trying the next
 *   route (route / credential / quota / rate-limit / transport failures only),
 *   using the installed `@deepseek-ai/dsh-llm` provider-neutral taxonomy;
 * - the aggregate `ReviewerRoutesError` and the non-retryable
 *   `ReviewerRouteError` thrown back to Auto review.
 *
 * The Host entry (`./index.ts`) performs the actual streaming. It forwards the
 * winning route's chunks immediately and can only switch routes before the
 * first chunk reaches the caller: once output has been emitted, a later failure
 * is surfaced rather than retried, so the caller's decision stream is never
 * contaminated with a second route.
 *
 * @module @aghost-prj/dsh-auto-review-model/fallback
 */
import {
  httpStatusOf,
  isRecord,
  normalizeFailureCode,
  readFinishFailureMessage,
  readFinishFailure,
  readThrownFailure,
} from './failure.js';
import type { FailureFacts } from './failure.js';
import { normalizeEffort } from './policy.js';
import type { ConfigValue, ReviewerConfig, ReviewerSettings } from './policy.js';

/** Largest number of configurable fallback entries a Host will schedule. */
export const MAX_FALLBACK_ENTRIES = 10;

/** Stable `name` of the aggregate all-routes-failed error. */
export const ROUTES_ERROR_NAME = 'AutoReviewModelRoutesError';

/** Stable `code` of the aggregate all-routes-failed error. */
export const ROUTES_ERROR_CODE = 'AUTO_REVIEW_MODEL_ALL_ROUTES_FAILED';

/** Stable `name` of one non-retryable attempt failure. */
export const ROUTE_ERROR_NAME = 'AutoReviewModelRouteError';

/** Stable `code` of one non-retryable attempt failure. */
export const ROUTE_ERROR_CODE = 'AUTO_REVIEW_MODEL_ROUTE_FAILED';

/** Error code: one attempt's finish reported an unclassified protocol failure. */
export const PROTOCOL_FAILURE_CODE = 'AUTO_REVIEW_MODEL_PROTOCOL_FAILURE';

/** How one attempt obtains its route: an explicit config route or the implicit session route. */
export type RouteMode = 'route' | 'session';

/** One normalized explicit fallback entry (an ordered reviewer route). */
export interface FallbackEntry {
  /** Whether this row is eligible; disabled rows are skipped, never deleted. */
  enabled: boolean;
  /**
   * Relative share of new sessions this route starts on, 0-9.
   *
   * A positive weight joins the weighted draw that picks a session's first route.
   * Weight 0 never starts a session and is only reached after every positive
   * route in the same session has failed, which makes it a last-resort row.
   */
  weight: number;
  /** Configured provider id. */
  provider: string;
  /** Configured model id. */
  model: string;
  /** Configured reasoning effort; `''` for the provider default, `inherit` for the session effort. */
  reasoningEffort: string;
}

/** One concrete route the Host will try, in order. */
export interface ReviewRouteAttempt {
  /** How the route was resolved: an explicit entry or the implicit session route. */
  mode: RouteMode;
  /** Declared weight; the implicit session route always uses 0. */
  weight: number;
  /** Provider id to send. */
  provider: string;
  /** Model id to send. */
  model: string;
  /** Reasoning effort to prove and send; `''` for the provider default. */
  reasoningEffort: string;
  /** Stable short label used in diagnostics (`provider/model`, plus ` (session)`). */
  label: string;
}

/** One failed attempt, preserved for the aggregate error. */
export interface ReviewerRouteFailure {
  /** The route that failed. */
  attempt: ReviewRouteAttempt;
  /** Accepted provider-neutral failure code, `''` when none was recognized. */
  code: string;
  /** Valid HTTP status observed with the failure, if any. */
  status?: number;
  /** Raw provider-neutral code as carried on the wire, when one was present. */
  rawCode?: string;
  /** Raw provider message, verbatim (official Auto review surfaces it the same way). */
  detail: string;
  /** Original thrown / capability error, kept for programmatic diagnostics. */
  cause?: unknown;
}

/**
 * Failure codes that mean "this route cannot serve the review right now".
 *
 * Quota, authentication, credential, rate limit, provider availability,
 * transport, and adapter/model routing failures are in the set. Content and
 * protocol codes (`INVALID_REQUEST`, `MALFORMED_RESPONSE`,
 * `CONTEXT_WINDOW_EXCEEDED`, `UNSUPPORTED_*`, `EMPTY_RESPONSE`, `ABORTED`,
 * `UNKNOWN`) are deliberately absent: the next route would fail identically or
 * the caller cancelled, so those failures are surfaced instead of retried.
 */
const FALLBACK_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ACCOUNT_QUOTA',
  'QUOTA',
  'AUTH',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'NO_CREDENTIAL_STORE',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
  'RATE_LIMIT',
  'SERVER',
  'TRANSPORT',
  'STREAM_CLOSED',
  'TIMEOUT',
  'DISCOVERY_FAILED',
  'DISCOVERY_UNSUPPORTED',
  'NO_DISCOVERY',
  'NO_ADAPTER',
  'INVALID_ADAPTER',
  'DUPLICATE_ADAPTER',
  'UNKNOWN_MODEL',
  'MODEL_UNSUPPORTED',
  'INVALID_CONFIG',
  'INVALID_CATALOG',
  'INVALID_MODEL_INFO',
]);

/**
 * HTTP statuses that identify a route-level problem when no official code was
 * carried: auth, payment, not-found, timeout, throttling, and provider errors.
 */
const FALLBACK_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 404, 408, 429]);

/** Read one config entry that may be a volatile ref or a plain value. */
function readConfigValue<T>(entry: ConfigValue<unknown>): unknown {
  if (entry !== null && typeof entry === 'object' && typeof (entry as { get?: unknown }).get === 'function') {
    return (entry as { get: () => unknown }).get();
  }
  return entry;
}

/** Coerce one configured string, trimming it. */
function configText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * Whether one raw config entry carries the legacy `{ mode: 'session' }` marker.
 *
 * That row type no longer exists: the intercepted request's own route is the
 * implicit final fallback, so such an entry must never be scheduled as a
 * configured route even when it still holds provider/model values from an older
 * settings page.
 *
 * @param raw - one array element from the volatile config.
 * @returns true when the entry was a legacy "follow session" row.
 */
export function isLegacySessionEntry(raw: unknown): boolean {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return configText(readConfigValue(source.mode)).toLowerCase() === 'session';
}

/**
 * Normalize one configured fallback entry into an explicit route.
 *
 * Only provider/model/reasoningEffort matter: the removed `mode` field is not
 * forwarded. Callers that read the config should use {@link readFallbackEntries}
 * so legacy `session` entries are discarded before normalization.
 *
 * @param raw - one array element from the volatile config.
 * @returns a normalized explicit entry.
 */
/**
 * Clamp one configured weight to the supported 0-9 range.
 *
 * An absent or malformed weight means an ordinary equal-share route. Weight 0 is
 * a valid, meaningful value: a route that never starts a session and is only
 * reached after every positive route has failed.
 */
function normalizeWeight(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const clamped = Math.trunc(numeric);
  return clamped >= 0 && clamped <= 9 ? clamped : 0;
}

export function normalizeFallbackEntry(raw: unknown): FallbackEntry {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    enabled: readConfigValue(source.enabled) !== false,
    weight: normalizeWeight(readConfigValue(source.weight)),
    provider: configText(readConfigValue(source.provider)),
    model: configText(readConfigValue(source.model)),
    reasoningEffort: normalizeEffort(readConfigValue(source.reasoningEffort)),
  };
}

/**
 * Read the live ordered fallback list from the plugin config.
 *
 * The whole array is one volatile field, so a settings save is visible to the
 * very next review. Non-array values degrade to "no fallbacks" (the legacy
 * single-route behavior). Legacy `{ mode: 'session' }` entries are ignored —
 * the session model is implicit now — and at most
 * {@link MAX_FALLBACK_ENTRIES} explicit entries are scheduled.
 *
 * @param config - injected plugin config of refs or plain values.
 * @returns normalized explicit entries in configured order.
 */
export function readFallbackEntries(config: ReviewerConfig | undefined): FallbackEntry[] {
  const raw = readConfigValue((config ?? {}).fallbacks);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(entry => !isLegacySessionEntry(entry))
    .slice(0, MAX_FALLBACK_ENTRIES)
    .map(entry => normalizeFallbackEntry(entry));
}

/**
 * Read the ordered reviewer routes from one live config snapshot.
 *
 * The unified `routes` list is authoritative. A config written before that list
 * existed is migrated in place on read: its row 1 becomes the first route and its
 * `fallbacks` follow, so an old settings document keeps behaving exactly as it
 * did and rewrites into the new shape on the next save.
 *
 * @param config - live volatile settings.
 * @returns every configured route in order, including disabled ones.
 */
export function readRoutes(config: ReviewerConfig | undefined): FallbackEntry[] {
  const source = config ?? {};
  const raw = readConfigValue(source.routes);
  // The schema fills a missing volatile list with `[]`, so an empty array cannot
  // be distinguished from "this config predates `routes`". Migrating in that case
  // is safe both ways: a legacy config yields its old rows, and a config the
  // settings page already rewrote carries empty legacy fields, so it stays empty.
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .filter(entry => !isLegacySessionEntry(entry))
      .slice(0, MAX_FALLBACK_ENTRIES)
      .map(entry => normalizeFallbackEntry(entry));
  }
  // Migration: the pre-`routes` document had a top-level route plus fallbacks.
  const legacy: FallbackEntry[] = [];
  const primaryEnabled = readConfigValue(source.primaryEnabled) !== false;
  const provider = readConfigValue(source.provider);
  const model = readConfigValue(source.model);
  const trimmedProvider = provider === undefined || provider === null ? '' : String(provider).trim();
  const trimmedModel = model === undefined || model === null ? '' : String(model).trim();
  if (primaryEnabled && trimmedProvider !== '' && trimmedModel !== '') {
    legacy.push({
      enabled: true,
      weight: 0,
      provider: trimmedProvider,
      model: trimmedModel,
      reasoningEffort: normalizeEffort(readConfigValue(source.reasoningEffort)),
    });
  }
  for (const entry of readFallbackEntries(source)) legacy.push(entry);
  return legacy;
}

/** Build the short diagnostic label of one attempt. */
export function routeAttemptLabel(provider: string, model: string, mode: RouteMode): string {
  const route = `${provider}/${model}`;
  return mode === 'session' ? `${route} (session)` : route;
}

/**
 * Build the deterministic attempt order for one intercepted review request.
 *
 * Every enabled, complete route is included in configured order, and the
 * intercepted request's own provider/model is appended as the implicit final
 * route — the route the pending review was issued for, never the plugin's idea of
 * "the current session model" — with no explicit reasoning effort. It is omitted
 * when the request has no usable route, and when an explicit route already uses
 * the same provider/model, so the same route is never tried twice.
 *
 * An empty result means "do not take the review over at all": with no usable
 * enabled route the native session model already is the review route.
 *
 * @param routes - configured routes in order.
 * @param request - provider/model of the intercepted review request.
 * @returns the ordered attempts; empty when nothing may be routed.
 */
/**
 * Reorder one plan so a weighted draw decides where a fresh session starts.
 *
 * Only routes with a positive weight are candidates; the session's start is drawn
 * in proportion to those weights. Weight-0 routes are last-resort rows: they are
 * placed after every positive route, and the implicit session route stays last of
 * all because it is the caller's own fallback, not a configured one.
 *
 * A plan with zero or one positive route keeps the configured order, so a single
 * configured route behaves exactly as before.
 *
 * @param plan - attempts in configured order.
 * @param random - injectable uniform source, `[0, 1)`, for deterministic tests.
 * @returns attempts in the order this session should try them.
 */
export function pickWeightedStart(
  plan: readonly ReviewRouteAttempt[],
  random: () => number = Math.random,
): ReviewRouteAttempt[] {
  const explicit = plan.filter(attempt => attempt.mode === 'route');
  const positive = explicit.filter(attempt => attempt.weight > 0);
  const rest = explicit.filter(attempt => attempt.weight === 0);
  const session = plan.filter(attempt => attempt.mode === 'session');
  if (positive.length <= 1) return [...positive, ...rest, ...session];

  const total = positive.reduce((sum, attempt) => sum + attempt.weight, 0);
  let roll = random() * total;
  let picked = positive[positive.length - 1]!;
  for (const attempt of positive) {
    roll -= attempt.weight;
    if (roll <= 0) {
      picked = attempt;
      break;
    }
  }
  return [picked, ...positive.filter(attempt => attempt !== picked), ...rest, ...session];
}

export function buildReviewPlan(
  routes: readonly FallbackEntry[],
  request: { provider: string; model: string },
): ReviewRouteAttempt[] {
  const plan: ReviewRouteAttempt[] = [];
  for (const entry of routes) {
    if (entry.enabled === false) continue;
    if (entry.provider === '' || entry.model === '') continue;
    plan.push({
      mode: 'route',
      weight: entry.weight,
      provider: entry.provider,
      model: entry.model,
      reasoningEffort: entry.reasoningEffort,
      label: routeAttemptLabel(entry.provider, entry.model, 'route'),
    });
  }
  if (
    plan.length > 0
    && request.provider !== ''
    && request.model !== ''
    && !plan.some(attempt => attempt.provider === request.provider && attempt.model === request.model)
  ) {
    plan.push({
      mode: 'session',
      weight: 0,
      provider: request.provider,
      model: request.model,
      reasoningEffort: '',
      label: routeAttemptLabel(request.provider, request.model, 'session'),
    });
  }
  return plan;
}

/** Whether one HTTP status identifies a route-level problem. */
function isFallbackEligibleStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return FALLBACK_HTTP_STATUSES.has(status) || (status >= 500 && status <= 599);
}

/**
 * Whether one observed failure may be answered by trying the next route.
 *
 * The decision uses only the official provider-neutral taxonomy: an accepted
 * code controls the answer when present, otherwise a valid HTTP status does.
 * An unclassified failure (`code: ''`, no status) is not retried here; the Host
 * treats an unclassified thrown stream error as a route failure, but an
 * unclassified terminal `finish` is surfaced instead.
 *
 * @param facts - provider-neutral failure facts, or `undefined`.
 * @returns true only for route / credential / quota / rate-limit / transport failures.
 */
export function isFallbackEligibleFailure(facts: FailureFacts | undefined): boolean {
  if (facts === undefined) return false;
  const code = normalizeFailureCode(facts.code);
  if (code !== '') {
    if (FALLBACK_FAILURE_CODES.has(code)) return true;
    // An `HTTP_<status>` code names the status itself, never a protocol error.
    if (/^HTTP_\d{3}$/.test(code)) return isFallbackEligibleStatus(httpStatusOf(code, facts.status));
    return false;
  }
  return isFallbackEligibleStatus(facts.status);
}

/** Read the raw provider message from a thrown value, verbatim. */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  if (isRecord(error)) {
    if (typeof error.message === 'string' && error.message !== '') return error.message;
    if (isRecord(error.failure) && typeof error.failure.message === 'string') {
      return error.failure.message;
    }
  }
  try {
    const text = String(error);
    if (text !== '' && text !== '[object Object]') return text;
  } catch {
    // Fall through to the generic label.
  }
  return 'unknown error';
}

/** Read the raw failure code carried by a thrown value, without classification. */
function rawFailureCode(value: unknown): string {
  if (!isRecord(value)) return '';
  const failure = isRecord(value.failure) ? value.failure : undefined;
  const raw = typeof value.code === 'string'
    ? value.code
    : failure !== undefined && typeof failure.code === 'string'
      ? failure.code
      : '';
  return raw.trim();
}

/** Display code for one failure: classified code, then raw code, then HTTP status. */
function displayFailureCode(failure: ReviewerRouteFailure): string {
  if (failure.code !== '') return failure.code;
  if (failure.rawCode !== undefined && failure.rawCode !== '') return failure.rawCode;
  if (failure.status !== undefined) return `HTTP_${failure.status}`;
  return 'unclassified error';
}

/**
 * Build the failure record for one attempt that threw before producing a
 * decision (a synchronous `ctx.llm.stream` throw, an iterator rejection, or a
 * capability lookup failure).
 *
 * @param attempt - the route that failed.
 * @param error - the caught value.
 * @returns the failure record with the raw provider message and cause preserved.
 */
export function failureFromThrown(
  attempt: ReviewRouteAttempt,
  error: unknown,
): ReviewerRouteFailure {
  const facts = readThrownFailure(error);
  const detail = errorText(error);
  const rawCode = rawFailureCode(error);
  return facts.status === undefined
    ? { attempt, code: facts.code, rawCode, detail, cause: error }
    : { attempt, code: facts.code, status: facts.status, rawCode, detail, cause: error };
}

/**
 * Build the failure record for one attempt whose terminal `finish` reported an
 * error.
 *
 * @param attempt - the route that failed.
 * @param reason - the terminal `finish` reason.
 * @returns the failure record; `cause` is absent because the wire carries facts, not an Error.
 */
export function failureFromFinish(attempt: ReviewRouteAttempt, reason: unknown): ReviewerRouteFailure {
  const facts = readFinishFailure(reason) ?? { code: '' };
  const code = normalizeFailureCode(facts.code);
  const rawCode = isRecord(reason) && isRecord(reason.failure) && typeof reason.failure.code === 'string'
    ? reason.failure.code.trim()
    : '';
  const detail = readFinishFailureMessage(reason);
  return facts.status === undefined
    ? { attempt, code, rawCode, detail }
    : { attempt, code, status: facts.status, rawCode, detail };
}

/**
 * Throwable raised when every planned reviewer route failed.
 *
 * The message lists each attempted `provider/model` with its failure code and
 * raw provider message, verbatim — the same text official Auto review embeds in
 * its deny reason — so the Agent sees an actionable reason (Auto review wraps it
 * as `Auto review of tool "<name>" failed; its body was not executed: <reason>`).
 * Each route's original error is preserved in `failures[].cause` and the raw
 * cause list is attached as the Error `cause`.
 */
export class ReviewerRoutesError extends Error {
  /** Stable diagnostic code. */
  readonly code = ROUTES_ERROR_CODE;
  /** Per-route failures in attempt order. */
  readonly failures: readonly ReviewerRouteFailure[];
  /** Attempted route labels in order. */
  readonly routes: readonly string[];

  /**
   * @param failures - one record per attempted route, in order.
   */
  constructor(failures: readonly ReviewerRouteFailure[]) {
    const details = failures
      .map((failure) => {
        const code = displayFailureCode(failure);
        return failure.detail === ''
          ? `${failure.attempt.label}: ${code}`
          : `${failure.attempt.label}: ${code}: ${failure.detail}`;
      })
      .join('; ');
    const count = failures.length;
    super(
      `auto-review-model: auto review failed on all ${count} reviewer route${count === 1 ? '' : 's'}: ${details}. `
      + 'The tool call was not executed. Check the Auto review model fallback list, provider credentials and network in Settings, then retry.',
      {
        cause: failures
          .map(failure => failure.cause)
          .filter((cause): cause is unknown => cause !== undefined),
      },
    );
    this.name = ROUTES_ERROR_NAME;
    this.failures = [...failures];
    this.routes = failures.map(failure => failure.attempt.label);
  }
}

/**
 * Throwable raised when one route failed in a way that must not be retried.
 *
 * Content/protocol problems, adapter-side aborts, and a failure after the
 * route already emitted output belong to that route: another route would hide
 * the problem, duplicate output, or fail the same way, so the review fails
 * closed with this actionable error.
 */
export class ReviewerRouteError extends Error {
  /** Stable diagnostic code. */
  readonly code = ROUTE_ERROR_CODE;
  /** Provider-neutral failure code or one of this module's local codes. */
  readonly failureCode: string;
  /** Exact `provider/model` route that failed. */
  readonly route: string;

  /**
   * @param route - the failing route label.
   * @param failureCode - provider-neutral or local failure code.
   * @param detail - raw provider message, verbatim.
   * @param cause - optional underlying error.
   */
  constructor(route: string, failureCode: string, detail: string, cause?: unknown) {
    const suffix = detail === '' ? '' : `: ${detail}`;
    super(
      `auto-review-model: reviewer route "${route}" failed with ${failureCode}${suffix}. `
      + 'The review was not completed and the tool call was not executed.',
      cause === undefined ? undefined : { cause },
    );
    this.name = ROUTE_ERROR_NAME;
    this.failureCode = failureCode;
    this.route = route;
  }
}

/** Whether a value is an async iterable the Host can consume. */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const iterator = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  return typeof iterator === 'function';
}

/** Stable surface for host tests; not part of the plugin contract. */
export const __testing = {
  MAX_FALLBACK_ENTRIES,
  ROUTES_ERROR_NAME,
  ROUTES_ERROR_CODE,
  ROUTE_ERROR_NAME,
  ROUTE_ERROR_CODE,
  PROTOCOL_FAILURE_CODE,
  normalizeFallbackEntry,
  normalizeWeight,
  isLegacySessionEntry,
  readFallbackEntries,
  readRoutes,
  pickWeightedStart,
  buildReviewPlan,
  isFallbackEligibleFailure,
  failureFromThrown,
  failureFromFinish,
  isAsyncIterable,
  ReviewerRoutesError,
  ReviewerRouteError,
};
