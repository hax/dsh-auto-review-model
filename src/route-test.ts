/**
 * Safe saved-route probe for `@aghost-prj/dsh-auto-review-model`.
 *
 * The settings page can ask the Host to prove that the currently SAVED review
 * route (provider, model, reasoning effort) still answers. The endpoint is
 * deliberately tiny and side-effect free:
 *
 * - it takes no browser parameters at all (only an optional transport
 *   `AbortSignal`), so a page cannot test an arbitrary route or read a
 *   credential through it;
 * - it reads the live volatile config with {@link readReviewerSettings} on
 *   every call, so it always probes exactly what the Host has saved;
 * - it sends one fixed harmless system/user prompt with `maxTokens` at most
 *   {@link ROUTE_TEST_MAX_TOKENS}, `temperature: 0`, and no `sessionId`,
 *   `purpose`, `tools`, `toolHistory`, or conversation history, so no Session
 *   log can be attached and no tool can run;
 * - it consumes the chunk stream to a terminal `finish`, discards every model
 *   byte, and additionally bounds the number of chunks and the amount of model
 *   text read, so no provider prose can be returned or accumulated;
 * - it distinguishes DeepSeek Account sign-in/authorization/connection failures
 *   from API-key `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `AUTH` failures,
 *   and reduces every underlying provider error to a stable code — only when
 *   that code is part of the installed Harness's official provider-neutral
 *   taxonomy, or a valid `HTTP_<status>` token — plus a fixed actionable
 *   sentence (never a raw token, credential, or unbounded provider message);
 * - it applies a Host-wide single-flight guard, a minimum inter-test interval,
 *   a sliding request budget, and a hard deadline whose `AbortSignal` is passed
 *   to both capability resolution and streaming. The single-flight slot is
 *   handed back only when every provider operation the probe started — a
 *   capability lookup, a stream `next()`, or a stream `return()` — has actually
 *   settled, so a timed-out or cancelled probe cannot accumulate a second
 *   provider stream beside an orphaned one.
 *
 * The result is exactly the strict `ReviewRouteTestResult` codec declared in
 * `./typert.contract.ts`; that module owns the wire shape and this module keeps
 * only dependency-free runtime code. The endpoint object is published with
 * `ctx.provide()` and carries the manual `typertRemote` binding the Gateway
 * validates when it dispatches the strict descriptor `autoReviewModel/testReviewRoute`
 * contributed by the package's `./typert` artifact. No Typert registry call is
 * made here: the loader auto-registers one manifest per package, and a manual
 * registration would duplicate it.
 *
 * @module @aghost-prj/dsh-auto-review-model/route-test
 */
import {
  REMOTE_NAMESPACE,
  REMOTE_SERVICE_KEY,
} from './typert.contract.js';
import type {
  ReviewRouteTestAuthKind,
  ReviewRouteTestCode,
  ReviewRouteTestResult,
  ReviewRouteTestRoute,
  ReviewRouteTestStatus,
} from './typert.contract.js';
import { readReviewerSettings } from './policy.js';
import type { ReviewerConfig } from './policy.js';

/** Hard deadline for one saved-route probe. */
export const ROUTE_TEST_TIMEOUT_MS = 20_000;

/** Minimum wall-clock gap between two probes of the same Host endpoint. */
export const ROUTE_TEST_MIN_INTERVAL_MS = 3_000;

/** Length of the sliding probe-budget window. */
export const ROUTE_TEST_WINDOW_MS = 60_000;

/** Probe budget per {@link ROUTE_TEST_WINDOW_MS} window. */
export const ROUTE_TEST_MAX_PER_WINDOW = 5;

/** Largest output-token budget the probe may request (hard cap, not a default). */
export const ROUTE_TEST_MAX_TOKENS = 16;

/** Deterministic sampling temperature for the harmless probe. */
export const ROUTE_TEST_TEMPERATURE = 0;

/** Largest number of model text characters the probe consumes. */
export const ROUTE_TEST_MAX_OUTPUT_CHARS = 64;

/** Largest number of stream chunks the probe consumes. */
export const ROUTE_TEST_MAX_OUTPUT_CHUNKS = 32;

/**
 * Grace period for closing a model stream whose `return()` ignores completion.
 *
 * The deadline bounds waiting for chunks; this second small bound keeps a
 * degraded adapter from holding the endpoint open forever during cleanup.
 */
export const ROUTE_TEST_CLOSE_GRACE_MS = 250;

/** Fixed system prompt of the harmless probe; carries no review policy and no session data. */
export const ROUTE_TEST_SYSTEM_PROMPT =
  'You are a connectivity probe for a model settings page. Follow the user instruction exactly and keep the reply minimal.';

/** Fixed user prompt of the harmless probe. */
export const ROUTE_TEST_USER_PROMPT = 'Reply with OK';

/** Detail override for a probe that hit its output bound instead of a terminal finish. */
const ROUTE_TEST_OVERSIZE_DETAIL =
  'The saved route produced more stream output than the bounded probe allows, so the probe stopped early. Test again; if this repeats, choose another model.';

/** Detail override for a route that answered with no model information. */
const ROUTE_TEST_UNKNOWN_MODEL_DETAIL =
  'The saved provider returned no information about the saved model. Choose a model the provider advertises in Auto review model settings, then test the route again.';

/** Detail override for a stream that ended without its terminal finish chunk. */
const ROUTE_TEST_PREMATURE_DETAIL =
  'The saved route closed the test stream before reporting a terminal result. Test again; if this repeats, check the provider endpoint and network connection.';

/**
 * The action a user can take for one outcome code.
 *
 * Every sentence is static for its code and never derives from provider prose,
 * so a result can never echo a credential, a response, or an unbounded error.
 */
const ROUTE_TEST_DETAILS: Readonly<Record<ReviewRouteTestCode, string>> = {
  OK: '',
  ROUTE_DISABLED:
    'Auto review model routing is disabled. Enable it in Auto review model settings, choose a provider and model, then test the route again.',
  ROUTE_INCOMPLETE:
    'The saved review route is incomplete. Choose both a provider and a model in Auto review model settings, then test the route again.',
  BUSY:
    'Another route test is already running. Wait for it to finish, then test the route again.',
  RATE_LIMITED:
    'Route tests are rate limited. Wait for the retry delay to pass, then test the route again.',
  CANCELLED: 'The route test was cancelled before it finished.',
  TIMEOUT:
    'The saved review route did not answer before the test deadline. Check that the provider is reachable and properly configured, then test the route again.',
  NO_ADAPTER:
    'No LLM adapter is registered for the saved provider. Choose a mounted provider in Auto review model settings.',
  UNKNOWN_MODEL:
    'The saved provider does not recognize the saved model. Update the model in Auto review model settings, then test the route again.',
  MODEL_UNSUPPORTED:
    'The saved provider rejected this model or the probe request. Choose a supported model in Auto review model settings.',
  MISSING_CREDENTIAL:
    'The saved provider has no credential configured. Add its API key in the provider settings, then test the route again.',
  INVALID_CREDENTIAL:
    'The saved provider rejected its stored credential. Replace the API key in the provider settings, then test the route again.',
  NO_CREDENTIAL_STORE:
    'No credential store is available for the saved provider. Configure credentials for the provider, then test the route again.',
  AUTH:
    'The saved provider rejected the request as unauthorized. Check the provider credential, then test the route again.',
  ACCOUNT_SIGN_IN_REQUIRED:
    'DeepSeek Account is not signed in for the saved route. Sign in to DeepSeek Account, then test the route again.',
  ACCOUNT_AUTH_FAILED:
    'DeepSeek Account rejected its stored authorization. Sign in again to refresh it, then test the route again.',
  ACCOUNT_CONNECTION:
    'DeepSeek Account could not be reached. Check the network connection, then test the route again.',
  CONNECTION:
    'The saved provider could not be reached. Check the endpoint, proxy, and network connection, then test the route again.',
  RATE_LIMIT:
    'The saved provider is rate limiting the route. Wait for the limit to reset, then test the route again.',
  QUOTA:
    'The saved provider reports exhausted quota or balance. Replenish the account, then test the route again.',
  CONTEXT_WINDOW_EXCEEDED:
    'The saved provider rejected the probe as too large for its context window. The route may be misrouted; choose another model.',
  UNSUPPORTED_REASONING_EFFORT:
    'The saved reasoning effort is not accepted by this route. Clear or change the reasoning effort in Auto review model settings, then test the route again.',
  EMPTY_RESPONSE:
    'The saved route answered without any content. It may be misrouted or degraded; test again or choose another model.',
  UNKNOWN:
    'The saved route failed the test for an unclassified reason. Check the provider settings and credentials, then test the route again.',
};

/** The structural subset of `resolveModelInfo` this module consults. */
export interface RouteTestModelInfoLike {
  /** Adapter-owned reasoning efforts advertised for the exact route. */
  reasoning?: {
    efforts?: readonly { id?: string }[];
  };
}

/** One entry of the adapter-provided configurable-provider directory. */
export interface RouteTestProviderLike {
  /** Provider route id this entry describes. */
  provider: string;
  /** Human-readable provider name. */
  displayName?: string;
  /** Settings namespace that configures the provider. */
  settingsNs?: string;
  /** Path from the namespace's section root to this provider's profile. */
  settingsPath?: readonly string[];
  /**
   * Authentication the route performs without a credential reference.
   *
   * The official DeepSeek Account and DeepSeek API-key adapters register
   * directory entries WITHOUT this field, so its absence says nothing about
   * the auth style; the exact provider id and the entry's presence decide it.
   */
  nativeAuth?: {
    /** Environment variables the route's authentication reads. */
    env?: readonly string[];
    /** Whether a stored OAuth sign-in authenticates the route. */
    oauth?: boolean;
  };
}

/** The exact `GenerateOptions` shape the probe builds (no other keys are ever added). */
export interface RouteTestGenerateOptions {
  /** Saved provider route to probe. */
  provider: string;
  /** Saved model id to probe. */
  model: string;
  /** Probed reasoning effort; omitted for the provider default. */
  reasoningEffort?: string;
  /** Fixed harmless system prompt. */
  system: string;
  /** One fixed user message. */
  messages: RouteTestRequestMessage[];
  /** Bounded output-token budget. */
  maxTokens: number;
  /** Deterministic sampling temperature. */
  temperature: number;
  /** Combined caller/deadline cancellation signal. */
  signal: AbortSignal;
}

/** One fixed request message; content blocks follow the LLM message vocabulary. */
export interface RouteTestRequestMessage {
  /** User role; the probe never sends a durable conversation role. */
  role: 'user';
  /** Exactly one fixed text block. */
  content: ReadonlyArray<{ type: 'text'; text: string }>;
}

/** The subset of the `llm` service the probe uses. */
export interface RouteTestLlmLike {
  /** Stream one hand-built one-shot request. */
  stream(options: RouteTestGenerateOptions): AsyncIterable<unknown>;
  /** Resolve exact-route model metadata (efforts) with cancellation. */
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<RouteTestModelInfoLike | undefined> | RouteTestModelInfoLike | undefined;
  /** List every declared configurable provider, registered or dormant. */
  listConfigurableProviders?(): readonly RouteTestProviderLike[];
}

/** The subset of the Host context needed to publish the endpoint. */
export interface RouteTestContext {
  /** Live LLM service. */
  llm: RouteTestLlmLike;
  /** Cordis service publication used to expose the endpoint object. */
  provide(name: string, value: unknown): unknown;
}

/** Tuning overrides for {@link installRouteTestEndpoint}; production uses the defaults. */
export interface RouteTestOptions {
  /** Clock used for throttling and latency; defaults to `Date.now`. */
  now?: () => number;
  /** Hard probe deadline in milliseconds; defaults to {@link ROUTE_TEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Minimum gap between two probes in milliseconds; defaults to {@link ROUTE_TEST_MIN_INTERVAL_MS}. */
  minIntervalMs?: number;
  /** Probe-budget window length in milliseconds; defaults to {@link ROUTE_TEST_WINDOW_MS}. */
  windowMs?: number;
  /** Probes allowed per window; defaults to {@link ROUTE_TEST_MAX_PER_WINDOW}. */
  maxPerWindow?: number;
  /** Requested output-token budget; capped at {@link ROUTE_TEST_MAX_TOKENS}. */
  maxTokens?: number;
}

/** Auth style and directory metadata of the probed provider. */
export interface RouteTestProviderClassification {
  /** How the route authenticates. */
  authKind: ReviewRouteTestAuthKind;
  /** Human-readable provider name, or the provider id when unknown. */
  providerName: string;
  /** Settings namespace configuring the provider, or `''`. */
  settingsNs: string;
  /** Environment variables the provider authentication reads, in lookup order. */
  credentialEnv: string[];
}

/** Provider-neutral failure facts observed on the wire; the probe never keeps prose. */
export interface RouteTestFailureFacts {
  /** Official provider-neutral failure code (or `HTTP_<status>`), `''` when none was recognized. */
  code: string;
  /** HTTP status accompanying the failure, when valid. */
  status?: number;
}

/** Host-wide probe throttle state; one instance per installed endpoint. */
export interface RouteTestState {
  /** Whether one probe currently holds the single-flight slot. */
  inFlight: boolean;
  /** Clock value of the most recently started probe. */
  lastStartedAt: number | undefined;
  /** Clock value at which the current request-budget window started. */
  windowStartedAt: number;
  /** Probes started inside the current request-budget window. */
  windowCount: number;
  /**
   * Provider operations started by the last admitted probe that have not
   * settled yet. While this is non-zero the single-flight slot stays held, so
   * a timeout/cancellation can return a result without allowing a second
   * provider stream to accumulate beside an orphaned one.
   */
  pendingProviderOperations: number;
}

/** Provider operations still running inside one admitted probe. */
interface RouteTestFlight {
  /** Started provider operations whose promise has not settled yet. */
  pending: number;
  /** Whether the probe result has already been decided (the endpoint returned). */
  finished: boolean;
  /** Whether the single-flight slot has been handed back. */
  released: boolean;
}

/** Tracks provider operations against one flight's single-flight ownership. */
interface RouteTestOperationTracker {
  /**
   * Start and observe one provider operation.
   *
   * @param operation - thunk creating the provider promise; a synchronous throw
   *   becomes a tracked rejection instead of escaping the accounting.
   * @returns the provider promise, observed so a late rejection is never unhandled.
   */
  track<T>(operation: () => Promise<T> | T): Promise<T>;
}

/** Effective probe-budget settings. */
export interface RouteTestRateLimits {
  /** Minimum gap between two probes in milliseconds. */
  minIntervalMs: number;
  /** Probe-budget window length in milliseconds. */
  windowMs: number;
  /** Probes allowed per window. */
  maxPerWindow: number;
}

/** A refusal from {@link checkRouteTestThrottle}. */
export interface RouteTestThrottleRefusal {
  /** Stable refusal code. */
  code: 'BUSY' | 'RATE_LIMITED';
  /** Local throttle delay to respect before retrying. */
  retryAfterMs: number;
}

/** The manual Gateway binding this package's `./typert` identity expects. */
export interface RouteTestTypertBinding {
  /** The published endpoint object itself. */
  readonly service: object;
  /** Exact Cordis service key. */
  readonly serviceKey: string;
  /** Exact wire namespace. */
  readonly namespace: string;
}

/** Outcome of consuming one probe stream. */
type RouteTestStreamOutcome =
  | { readonly kind: 'finish'; readonly reason: unknown; readonly sawContent: boolean }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'oversize' }
  | { readonly kind: 'failure'; readonly failure: RouteTestFailureFacts };

/** Mutable builder state shared by every result path of one probe. */
interface RouteTestStats {
  route: ReviewRouteTestRoute;
  authKind: ReviewRouteTestAuthKind;
  providerName: string;
  settingsNs: string;
  credentialEnv: string[];
  effortUsed: string;
  effortNotAdvertised: boolean;
}

/** One deadline/cancellation pair created for one probe. */
interface RouteTestDeadline {
  /** Combined caller/deadline signal passed to every asynchronous step. */
  readonly signal: AbortSignal;
  /** Caller cancellation signal, when the transport supplied one. */
  readonly callerSignal: AbortSignal | undefined;
  /** Whether the hard deadline (rather than the caller) aborted the signal. */
  timedOut(): boolean;
  /** Release the timer and the caller abort listener. */
  dispose(): void;
}

/** Reject a non-object JSON value. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a value is an AsyncIterable the probe can consume. */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const iterator = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  return typeof iterator === 'function';
}

/** Coerce a finite integer at or above `minimum`, else return the fallback. */
function finiteInteger(value: unknown, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
    ? Math.floor(value)
    : fallback;
}

/** Clip one display string without changing its identity characters. */
function clipText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Maximum number of nodes the bounded content measurement walks before refusing. */
const ROUTE_TEST_MAX_CONTENT_NODES = 256;

/** Result of one bounded model-content measurement. */
interface RouteTestContentMeasure {
  /** Characters observed before the bound stopped the walker. */
  readonly chars: number;
  /** Whether the measured value carries more content than the probe may read. */
  readonly exceeded: boolean;
}

/**
 * Measure one model-content value without copying or retaining it.
 *
 * Stream content can arrive through several shapes (delta text, assembled
 * `block-end` blocks, tool-call arguments, and future merge-extensible chunk
 * types), and every one of them is attacker-adjacent provider data. This walker
 * only counts string lengths and node visits, stops as soon as the probe's
 * character bound is exceeded, and never serializes, clones, or stores the
 * value, so a single 100k-character block is rejected by its length alone.
 *
 * @param value - arbitrary chunk field that may carry model content.
 * @returns measured size plus whether it already exceeds the probe bound.
 */
function measureModelContent(value: unknown): RouteTestContentMeasure {
  const seen = { chars: 0, nodes: 0, exceeded: false };
  const limit = ROUTE_TEST_MAX_OUTPUT_CHARS;

  const visit = (current: unknown): void => {
    if (seen.exceeded) return;
    seen.nodes += 1;
    if (seen.nodes > ROUTE_TEST_MAX_CONTENT_NODES) {
      seen.exceeded = true;
      return;
    }
    switch (typeof current) {
      case 'string':
        seen.chars += current.length;
        break;
      case 'number':
      case 'boolean':
      case 'undefined':
        seen.chars += 1;
        break;
      case 'object': {
        if (current === null) {
          seen.chars += 1;
          break;
        }
        if (Array.isArray(current)) {
          for (let index = 0; index < current.length; index += 1) {
            visit(current[index]);
            if (seen.exceeded) return;
          }
          break;
        }
        const record = current as Record<string, unknown>;
        for (const key in record) {
          if (!Object.hasOwn(record, key)) continue;
          seen.chars += key.length;
          if (seen.chars > limit) {
            seen.exceeded = true;
            return;
          }
          try {
            visit(record[key]);
          } catch {
            // A hostile getter/proxy is unknown content: refuse rather than read it.
            seen.exceeded = true;
            return;
          }
          if (seen.exceeded) return;
        }
        break;
      }
      default:
        // Functions, symbols, and bigints are not JSON model content; ignore them.
        break;
    }
    if (seen.chars > limit) seen.exceeded = true;
  };

  visit(value);
  return { chars: Math.min(seen.chars, limit + 1), exceeded: seen.exceeded || seen.chars > limit };
}

/**
 * Measure a string-or-arbitrary model field through one bounded walk.
 *
 * @param value - candidate model field.
 * @returns measured characters and whether the bound was exceeded.
 */
function measureModelField(value: unknown): RouteTestContentMeasure {
  return typeof value === 'string' ? { chars: value.length, exceeded: value.length > ROUTE_TEST_MAX_OUTPUT_CHARS } : measureModelContent(value);
}

/**
 * Provider-neutral failure codes shipped by the installed `@deepseek-ai/dsh-llm`
 * (0.2.2-rc.3 `src/error.ts` `LLM_FAILURE_CODES`).
 *
 * A wire code is only carried into the result when it is one of these exact
 * official tokens, so an arbitrary provider string — which is what a leaked
 * credential or an unbounded provider message looks like — is dropped instead
 * of being forwarded to the settings page.
 */
const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ABORTED',
  'ACCOUNT_QUOTA',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
  'AUTH',
  'CLIENT_UPGRADE_REQUIRED',
  'CONTEXT_WINDOW_EXCEEDED',
  'DISCOVERY_FAILED',
  'DISCOVERY_UNSUPPORTED',
  'DUPLICATE_ADAPTER',
  'DUPLICATE_DIRECTORY',
  'DUPLICATE_DISCOVERY',
  'EMPTY_RESPONSE',
  'FILES_API',
  'IMAGE_OFFLOAD_REQUIRED',
  'INVALID_ADAPTER',
  'INVALID_CATALOG',
  'INVALID_CONFIG',
  'INVALID_CREDENTIAL',
  'INVALID_DIRECTORY',
  'INVALID_DISCOVERY',
  'INVALID_MODEL_CONTEXT',
  'INVALID_MODEL_INFO',
  'INVALID_MODEL_MAX_TOKENS',
  'INVALID_MODEL_REASONING',
  'INVALID_PREPARED_CALL',
  'INVALID_REPLAY_STATE',
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'MALFORMED_RESPONSE',
  'MISSING_CREDENTIAL',
  'MODEL_SWITCH_COMPACTION_FAILED',
  'MODEL_UNSUPPORTED',
  'NO_ADAPTER',
  'NO_CREDENTIAL_STORE',
  'NO_DISCOVERY',
  'PI_AI_ERROR',
  'QUOTA',
  'RATE_LIMIT',
  'REGISTRATION_DISPOSED',
  'REQUEST_EXTENSION',
  'REQUEST_HEADERS',
  'SERVER',
  'STREAM_CLOSED',
  'TIMEOUT',
  'TRANSPORT',
  'UNKNOWN',
  'UNKNOWN_MODEL',
  'UNSTORABLE_PROVIDER_ID',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OPTION',
  'UNSUPPORTED_REASONING_EFFORT',
]);

/** Official shape for an unclassified provider HTTP status (`HTTP_<100..599>`). */
const HTTP_FAILURE_CODE_PATTERN = /^HTTP_[1-5]\d{2}$/;

/**
 * Keep one wire failure code only when it is an official provider-neutral code.
 *
 * Codes are opaque provider values, so only the exact `LLM_FAILURE_CODES`
 * vocabulary shipped by the installed Harness, or a valid `HTTP_<status>`
 * token, is accepted. Every other token — including an uppercase
 * `SECRET_TOKEN_12345`-shaped string — becomes `''` so it can never reach the
 * wire result or the settings page.
 *
 * @param value - raw provider-neutral failure code.
 * @returns the accepted official token, or `''`.
 */
export function normalizeFailureCode(value: unknown): string {
  if (typeof value !== 'string') return '';
  const code = value.trim().toUpperCase();
  if (KNOWN_FAILURE_CODES.has(code)) return code;
  if (HTTP_FAILURE_CODE_PATTERN.test(code)) {
    const status = Number(code.slice('HTTP_'.length));
    if (status >= 100 && status <= 599) return code;
  }
  return '';
}

/** Extract the valid HTTP status carried by failure facts or an `HTTP_<status>` code. */
function httpStatusOf(code: string, status: number | undefined): number | undefined {
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    return status;
  }
  const match = /^HTTP_(\d{3})$/.exec(code);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

/**
 * Map one provider-neutral failure to a stable result code.
 *
 * Account routes translate credential and connectivity failures into
 * DeepSeek Account sign-in / authorization / connection outcomes; API-key
 * routes keep the credential vocabulary a key-based provider can fix. Local
 * capacity and terminal codes (adapter, model, effort, rate, quota, timeout)
 * are shared by both.
 *
 * @param failureCode - raw provider-neutral code, `''` when none was observed.
 * @param authKind - authentication style classified for the probed provider.
 * @param status - optional HTTP status observed with the failure.
 * @returns the stable result code the Client renders.
 */
export function classifyRouteTestFailure(
  failureCode: string,
  authKind: ReviewRouteTestAuthKind,
  status?: number,
): ReviewRouteTestCode {
  const code = normalizeFailureCode(failureCode);
  const http = httpStatusOf(code, status);

  // Codes whose meaning does not depend on the authentication style.
  if (code === 'NO_ADAPTER') return 'NO_ADAPTER';
  if (code === 'UNKNOWN_MODEL' || code === 'MODEL_UNSUPPORTED') return 'UNKNOWN_MODEL';
  if (code === 'UNSUPPORTED_REASONING_EFFORT') return 'UNSUPPORTED_REASONING_EFFORT';
  if (code === 'RATE_LIMIT' || http === 429) return 'RATE_LIMIT';
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || http === 402) return 'QUOTA';
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return 'CONTEXT_WINDOW_EXCEEDED';
  if (code === 'EMPTY_RESPONSE') return 'EMPTY_RESPONSE';
  if (code === 'TIMEOUT') return 'TIMEOUT';
  if (code === 'ABORTED') return 'CANCELLED';
  if (code === 'ACCOUNT_SIGN_IN_REQUIRED') return 'ACCOUNT_SIGN_IN_REQUIRED';
  if (code === 'ACCOUNT_TOKEN_INVALID') return 'ACCOUNT_AUTH_FAILED';

  if (authKind === 'account') {
    if (code === 'MISSING_CREDENTIAL' || code === 'NO_CREDENTIAL_STORE') {
      return 'ACCOUNT_SIGN_IN_REQUIRED';
    }
    if (code === 'INVALID_CREDENTIAL' || code === 'AUTH' || http === 401 || http === 403) {
      return 'ACCOUNT_AUTH_FAILED';
    }
    if (
      code === 'TRANSPORT'
      || code === 'SERVER'
      || code === 'STREAM_CLOSED'
      || code === 'DISCOVERY_FAILED'
      || (http !== undefined && http >= 500)
    ) {
      return 'ACCOUNT_CONNECTION';
    }
    return 'UNKNOWN';
  }

  // API-key routes, and routes whose authentication style could not be classified.
  if (code === 'MISSING_CREDENTIAL') return 'MISSING_CREDENTIAL';
  if (code === 'INVALID_CREDENTIAL') return 'INVALID_CREDENTIAL';
  if (code === 'NO_CREDENTIAL_STORE') return 'NO_CREDENTIAL_STORE';
  if (code === 'AUTH' || http === 401 || http === 403) return 'AUTH';
  if (
    code === 'TRANSPORT'
    || code === 'SERVER'
    || code === 'STREAM_CLOSED'
    || (http !== undefined && http >= 500)
  ) {
    return 'CONNECTION';
  }
  return 'UNKNOWN';
}

/**
 * Map one result code to its presentation tone.
 *
 * @param code - stable result code.
 * @returns success, warning, blocked (locally refused/cancelled), or error.
 */
export function routeTestStatusOf(code: ReviewRouteTestCode): ReviewRouteTestStatus {
  if (code === 'OK') return 'ok';
  if (code === 'EMPTY_RESPONSE') return 'warning';
  if (
    code === 'ROUTE_DISABLED'
    || code === 'ROUTE_INCOMPLETE'
    || code === 'BUSY'
    || code === 'RATE_LIMITED'
    || code === 'CANCELLED'
  ) {
    return 'blocked';
  }
  return 'error';
}

/**
 * Exact provider ids whose official adapter signs in through a stored account
 * while declaring no `nativeAuth` in its configurable-provider directory.
 *
 * `@deepseek-ai/dsh-llm-deepseek-account` 0.2.2-rc.3 registers exactly
 * `{ provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs,
 * settingsPath: [] }`, so the id must be trusted before inspecting `nativeAuth`.
 */
const SIGNED_IN_ACCOUNT_PROVIDER_IDS: ReadonlySet<string> = new Set(['deepseek-account']);

/** Conventional account-shaped route id, used only when the directory has no entry. */
const CONVENTIONAL_ACCOUNT_PROVIDER_ID = /(^|[-_])account($|[-_])/i;

/**
 * Classify the probed provider from the live configurable-provider directory.
 *
 * The exact `deepseek-account` provider id is authoritative for a signed-in
 * account route: the installed `@deepseek-ai/dsh-llm-deepseek-account` adapter
 * registers its directory entry without a `nativeAuth` field, so relying on
 * that field alone would misclassify the real adapter as an API-key provider.
 * A declared `nativeAuth.oauth: true` still marks an account route, and any
 * other declared routing style (including the official DeepSeek API-key
 * adapter, whose entry also omits `nativeAuth`) is API-key style with an empty
 * credential-environment list unless the adapter actually declares one. A
 * route missing from the directory falls back to the conventional account id
 * shape, and is otherwise unknown — never guessed to be API-key.
 *
 * @param provider - saved provider route id.
 * @param directory - current directory entries.
 * @returns auth style plus display and credential metadata.
 */
export function classifyRouteTestProvider(
  provider: string,
  directory: readonly RouteTestProviderLike[],
): RouteTestProviderClassification {
  const entry = directory.find(candidate => candidate.provider === provider);
  const accountRoute = entry?.nativeAuth?.oauth === true
    || SIGNED_IN_ACCOUNT_PROVIDER_IDS.has(provider)
    || (entry === undefined && CONVENTIONAL_ACCOUNT_PROVIDER_ID.test(provider));
  if (entry === undefined) {
    return {
      authKind: accountRoute ? 'account' : 'unknown',
      providerName: provider,
      settingsNs: '',
      credentialEnv: [],
    };
  }
  return {
    authKind: accountRoute ? 'account' : 'api-key',
    providerName: typeof entry.displayName === 'string' && entry.displayName !== ''
      ? entry.displayName
      : provider,
    settingsNs: typeof entry.settingsNs === 'string' ? entry.settingsNs : '',
    credentialEnv: Array.isArray(entry.nativeAuth?.env)
      ? entry.nativeAuth.env.filter((name): name is string => typeof name === 'string')
      : [],
  };
}


/**
 * Build the one fixed harmless request the probe sends.
 *
 * The object is rebuilt per call with exactly these keys; there is deliberately
 * no index signature, no `sessionId`, no `purpose`, no `tools`, no
 * `toolHistory`, and no conversation history.
 *
 * @param route - saved route being probed.
 * @param effortUsed - advertised effort to send, or `''` for the provider default.
 * @param signal - combined caller/deadline cancellation signal.
 * @param maxTokens - bounded output-token budget.
 * @returns the exact `GenerateOptions` handed to `ctx.llm.stream`.
 */
export function buildRouteTestRequest(
  route: ReviewRouteTestRoute,
  effortUsed: string,
  signal: AbortSignal,
  maxTokens: number,
): RouteTestGenerateOptions {
  return {
    provider: route.provider,
    model: route.model,
    ...effortUsed === '' ? {} : { reasoningEffort: effortUsed },
    system: ROUTE_TEST_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: ROUTE_TEST_USER_PROMPT }],
      },
    ],
    maxTokens,
    temperature: ROUTE_TEST_TEMPERATURE,
    signal,
  };
}

/**
 * Construct an empty Host-wide throttle state.
 *
 * @param now - current clock value; starts the first budget window here.
 * @returns fresh state with no probe in flight.
 */
export function createRouteTestState(now: number): RouteTestState {
  return {
    inFlight: false,
    lastStartedAt: undefined,
    windowStartedAt: now,
    windowCount: 0,
    pendingProviderOperations: 0,
  };
}

/**
 * Check whether a new probe is allowed to start now.
 *
 * A probe already in flight wins over every budget refusal, because the answer
 * "one is running" is more actionable than "wait for the interval". The
 * request-budget window is rotated lazily on the first allowed check, so an
 * idle endpoint does not accumulate refusals.
 *
 * @param state - Host-wide throttle state.
 * @param nowMs - current clock value.
 * @param limits - effective budget settings.
 * @returns a refusal, or `undefined` when the probe may start.
 */
export function checkRouteTestThrottle(
  state: RouteTestState,
  nowMs: number,
  limits: RouteTestRateLimits,
): RouteTestThrottleRefusal | undefined {
  if (state.inFlight) {
    return { code: 'BUSY', retryAfterMs: Math.max(0, Math.ceil(limits.minIntervalMs)) };
  }
  if (state.lastStartedAt !== undefined) {
    const wait = limits.minIntervalMs - (nowMs - state.lastStartedAt);
    if (wait > 0) {
      return { code: 'RATE_LIMITED', retryAfterMs: Math.max(1, Math.ceil(wait)) };
    }
  }
  if (nowMs - state.windowStartedAt >= limits.windowMs) {
    state.windowStartedAt = nowMs;
    state.windowCount = 0;
  }
  if (state.windowCount >= limits.maxPerWindow) {
    const wait = state.windowStartedAt + limits.windowMs - nowMs;
    return { code: 'RATE_LIMITED', retryAfterMs: Math.max(1, Math.ceil(wait)) };
  }
  return undefined;
}

/**
 * Record that one allowed probe has started.
 *
 * @param state - Host-wide throttle state.
 * @param nowMs - current clock value.
 */
export function markRouteTestStarted(state: RouteTestState, nowMs: number): void {
  state.inFlight = true;
  state.lastStartedAt = nowMs;
  state.windowCount += 1;
}

/**
 * Extract provider-neutral facts from an arbitrary thrown value.
 *
 * Only the stable `code` and a valid HTTP status are retained; messages, causes,
 * request ids, and any other provider payload are deliberately dropped so they
 * cannot reach the result.
 *
 * @param error - caught rejection reason.
 * @returns sanitized failure facts; `code: ''` when nothing stable was carried.
 */
export function readThrownFailure(error: unknown): RouteTestFailureFacts {
  if (isRecord(error)) {
    const failure = isRecord(error.failure) ? error.failure : undefined;
    const rawCode = typeof error.code === 'string'
      ? error.code
      : failure !== undefined && typeof failure.code === 'string'
        ? failure.code
        : '';
    const rawStatus = typeof error.status === 'number'
      ? error.status
      : failure !== undefined && typeof failure.status === 'number'
        ? failure.status
        : undefined;
    const code = normalizeFailureCode(rawCode);
    const status = httpStatusOf(code, rawStatus);
    if (code !== '' || status !== undefined) {
      return status === undefined ? { code } : { code, status };
    }
    if (error.name === 'AbortError') return { code: 'ABORTED' };
  }
  return { code: '' };
}

/**
 * Extract provider-neutral facts from a terminal `finish` reason.
 *
 * @param reason - finish reason carried by the terminal stream chunk.
 * @returns failure facts for `error`/`aborted` finishes, else `undefined`.
 */
export function readFinishFailure(reason: unknown): RouteTestFailureFacts | undefined {
  if (!isRecord(reason)) return undefined;
  if (reason.kind !== 'error' && reason.kind !== 'aborted') return undefined;
  const failure = isRecord(reason.failure) ? readThrownFailure(reason.failure) : { code: '' };
  if (reason.kind === 'aborted' && failure.code === '') return { code: 'ABORTED' };
  return failure;
}

/**
 * Read the advertised reasoning-effort ids from one model-info reply.
 *
 * @param info - adapter-owned exact-route metadata.
 * @returns the advertised effort ids, never throwing on malformed entries.
 */
function readAdvertisedEfforts(info: RouteTestModelInfoLike | undefined): ReadonlySet<string> {
  const efforts = info?.reasoning?.efforts;
  if (!Array.isArray(efforts)) return new Set<string>();
  return new Set(
    efforts
      .map(effort => effort?.id)
      .filter((id): id is string => typeof id === 'string' && id !== ''),
  );
}

/**
 * Create the combined caller/deadline cancellation pair for one probe.
 *
 * The timer is always cleared by {@link RouteTestDeadline.dispose}, so a fast
 * probe never leaves a pending deadline behind. The caller listener is also
 * removed there, so a long-lived transport signal does not accumulate
 * listeners across probes.
 *
 * @param timeoutMs - hard deadline in milliseconds.
 * @param callerSignal - optional transport cancellation.
 * @returns combined deadline state.
 */
function createRouteTestDeadline(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): RouteTestDeadline {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal?.aborted === true) {
    controller.abort(callerSignal.reason);
  } else {
    if (callerSignal !== undefined) {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('route test deadline exceeded'));
    }, timeoutMs);
    timer.unref();
  }

  return {
    signal: controller.signal,
    callerSignal,
    timedOut: () => timedOut,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/** Reject as soon as `signal` aborts, with cleanup for the losing branch. */
function abortRace(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let remove = (): void => {};
  const promise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    remove = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, dispose: () => remove() };
}

/**
 * Race one asynchronous step against the probe deadline.
 *
 * @param operation - step that may ignore cancellation.
 * @param signal - combined caller/deadline signal.
 * @returns the step result.
 */
async function raceWithDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = abortRace(signal);
  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    aborted.dispose();
  }
}

/**
 * Classify an abort that has already happened, if any.
 *
 * Caller cancellation wins over the hard deadline because it is the reason the
 * request stopped waiting; only a deadline with no caller abort is a timeout.
 *
 * @param deadline - combined deadline state.
 * @returns `'CANCELLED'`, `'TIMEOUT'`, or `undefined` when nothing aborted.
 */
function abortOutcome(deadline: RouteTestDeadline): 'CANCELLED' | 'TIMEOUT' | undefined {
  if (deadline.callerSignal?.aborted === true) return 'CANCELLED';
  if (deadline.signal.aborted) return 'TIMEOUT';
  return undefined;
}

/**
 * Close one model stream under a small grace bound.
 *
 * The deadline already bounds chunk waiting; cleanup still needs its own bound
 * because a degraded adapter may never settle `return()`. The close operation
 * is tracked like every other provider operation: if it never settles the
 * single-flight slot stays held (no second provider stream may accumulate),
 * while the endpoint itself returns after the grace period.
 *
 * @param iterator - live model stream iterator.
 * @param tracker - provider-operation tracker owning the single-flight slot.
 */
async function closeRouteTestIterator(
  iterator: AsyncIterator<unknown>,
  tracker: RouteTestOperationTracker,
): Promise<void> {
  const close = iterator.return;
  if (typeof close !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let closePromise: Promise<void>;
    try {
      closePromise = tracker.track(() => close.call(iterator)).then(() => {}, () => {});
    } catch {
      return;
    }
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ROUTE_TEST_CLOSE_GRACE_MS);
      timer.unref();
    });
    await Promise.race([closePromise, grace]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Measure one assembled `block-end` content block without retaining it.
 *
 * Known assembled shapes are measured by their model-visible string fields, so
 * structural metadata cannot dominate the probe budget; unknown merge-extensible
 * block types fall back to the bounded generic walk.
 *
 * @param block - assembled content block carried by a `block-end` chunk.
 * @returns measured size and whether the bound was already exceeded.
 */
function measureBlockEnd(block: unknown): RouteTestContentMeasure {
  if (!isRecord(block)) return measureModelContent(block);
  const type = typeof block.type === 'string' ? block.type : '';
  if (type === 'text' || type === 'reasoning') return measureModelField(block.text);
  if (type === 'tool-call') return measureModelContent([block.id, block.name, block.arguments]);
  return measureModelContent(block);
}

/**
 * Consume one probe stream to its terminal finish, discarding every model byte.
 *
 * The loop bounds the number of chunks and the model-visible content it will
 * read across every content shape: delta text, assembled `block-end` blocks,
 * tool-call arguments, and unknown merge-extensible chunks all pass through a
 * bounded measurement that never copies or stores the value. Every `next()`
 * promise is tracked so an adapter that ignores cancellation keeps the
 * single-flight slot until it actually settles, and the iterator is always
 * closed through the same tracker.
 *
 * @param llm - live LLM service.
 * @param request - fixed probe request.
 * @param deadline - combined cancellation state.
 * @param tracker - provider-operation tracker owning the single-flight slot.
 * @returns terminal finish, cancellation/timeout, output-bound, or failure facts.
 */
async function consumeRouteTestStream(
  llm: RouteTestLlmLike,
  request: RouteTestGenerateOptions,
  deadline: RouteTestDeadline,
  tracker: RouteTestOperationTracker,
): Promise<RouteTestStreamOutcome> {
  let iterable: AsyncIterable<unknown>;
  try {
    iterable = llm.stream(request);
  } catch (error) {
    return { kind: 'failure', failure: readThrownFailure(error) };
  }
  if (!isAsyncIterable(iterable)) {
    return { kind: 'failure', failure: { code: '' } };
  }

  let iterator: AsyncIterator<unknown>;
  try {
    iterator = iterable[Symbol.asyncIterator]();
  } catch (error) {
    return { kind: 'failure', failure: readThrownFailure(error) };
  }

  let chunks = 0;
  let sawContent = false;
  // Assembled content is counted once: deltas for one block index are replaced
  // by the block's assembled size when its `block-end` arrives, so the same
  // bytes are never double counted but can never bypass the bound either.
  let completedChars = 0;
  let openDeltaChars = 0;
  let miscChars = 0;
  const deltaCharsByIndex = new Map<number, number>();
  const totalChars = (): number => completedChars + openDeltaChars + miscChars;
  const exceedsContentBound = (): boolean => totalChars() > ROUTE_TEST_MAX_OUTPUT_CHARS;
  const addMisc = (measured: RouteTestContentMeasure): boolean => {
    if (measured.exceeded) return true;
    miscChars += measured.chars;
    return exceedsContentBound();
  };
  const addDelta = (index: number | undefined, measured: RouteTestContentMeasure): boolean => {
    if (measured.exceeded) return true;
    if (index === undefined) {
      miscChars += measured.chars;
      return exceedsContentBound();
    }
    deltaCharsByIndex.set(index, (deltaCharsByIndex.get(index) ?? 0) + measured.chars);
    openDeltaChars += measured.chars;
    return exceedsContentBound();
  };
  const closeBlock = (index: number | undefined, measured: RouteTestContentMeasure): boolean => {
    if (measured.exceeded) return true;
    const pending = index === undefined ? 0 : deltaCharsByIndex.get(index) ?? 0;
    if (index !== undefined) {
      deltaCharsByIndex.delete(index);
      openDeltaChars -= pending;
    }
    completedChars += Math.max(pending, measured.chars);
    return exceedsContentBound();
  };

  try {
    for (;;) {
      // Track the provider operation before racing it: a `next()` that never
      // settles must keep the single-flight slot after the endpoint returns.
      const next = tracker.track(() => iterator.next());
      let step: IteratorResult<unknown>;
      try {
        step = await raceWithDeadline(next, deadline.signal);
      } catch (error) {
        const aborted = abortOutcome(deadline);
        if (aborted === 'CANCELLED') return { kind: 'cancelled' };
        if (aborted === 'TIMEOUT') return { kind: 'timeout' };
        return { kind: 'failure', failure: readThrownFailure(error) };
      }
      const aborted = abortOutcome(deadline);
      if (aborted === 'CANCELLED') return { kind: 'cancelled' };
      if (aborted === 'TIMEOUT') return { kind: 'timeout' };
      if (step.done === true) {
        // No terminal finish: the provider closed the stream prematurely.
        return { kind: 'failure', failure: { code: 'STREAM_CLOSED' } };
      }

      chunks += 1;
      if (chunks > ROUTE_TEST_MAX_OUTPUT_CHUNKS) return { kind: 'oversize' };

      const chunk = step.value;
      if (!isRecord(chunk)) {
        sawContent = true;
        if (addMisc(measureModelContent(chunk))) return { kind: 'oversize' };
        continue;
      }
      const type = typeof chunk.type === 'string' ? chunk.type : '';
      const index = typeof chunk.index === 'number' && Number.isSafeInteger(chunk.index) && chunk.index >= 0
        ? chunk.index
        : undefined;

      if (type === 'finish') {
        if (exceedsContentBound()) return { kind: 'oversize' };
        return { kind: 'finish', reason: chunk.reason, sawContent };
      }
      if (type === 'text-delta' || type === 'reasoning-delta') {
        sawContent = true;
        if (addDelta(index, measureModelField(chunk.text))) return { kind: 'oversize' };
        continue;
      }
      if (type === 'tool-call-delta') {
        sawContent = true;
        if (addDelta(index, measureModelContent([chunk.id, chunk.name, chunk.argumentsDelta]))) {
          return { kind: 'oversize' };
        }
        continue;
      }
      if (type === 'block-end') {
        sawContent = true;
        if (closeBlock(index, measureBlockEnd(chunk.block))) return { kind: 'oversize' };
        continue;
      }
      if (type === 'block-start') {
        // A type tag carries no model content; only the block itself is bounded.
        sawContent = true;
        continue;
      }
      if (type === 'usage') continue;
      // Future merge-extensible chunks may carry content: measure them too.
      sawContent = true;
      if (addMisc(measureModelContent(chunk))) return { kind: 'oversize' };
    }
  } finally {
    await closeRouteTestIterator(iterator, tracker);
  }
}

/**
 * Build more granular counting stats to merge into a probe result.
 *
 * @param stats - mutable probe stats.
 * @param classification - provider classification from the directory.
 */
function applyProviderClassification(
  stats: RouteTestStats,
  classification: RouteTestProviderClassification,
): void {
  stats.authKind = classification.authKind;
  stats.providerName = clipText(classification.providerName, 120);
  stats.settingsNs = clipText(classification.settingsNs, 120);
  stats.credentialEnv = classification.credentialEnv
    .map(name => clipText(name, 120))
    .filter(name => name !== '');
}

/** Build the stats snapshot one probe report starts from. */
function createRouteTestStats(route: ReviewRouteTestRoute): RouteTestStats {
  return {
    route,
    authKind: 'unknown',
    providerName: route.provider,
    settingsNs: '',
    credentialEnv: [],
    effortUsed: '',
    effortNotAdvertised: false,
  };
}

/** One builder input for a strict review-route result. */
interface RouteTestResultInput {
  code: ReviewRouteTestCode;
  stats: RouteTestStats;
  startedAt: number;
  now: () => number;
  retryAfterMs?: number;
  failureCode?: string;
  detail?: string;
}

/**
 * Build one strict wire result.
 *
 * Exactly the 13 fields of `ReviewRouteTestResult` are emitted, with the route
 * copied by value and every provider-derived string clipped. The detail comes
 * from the static per-code table unless an internal override applies; it never
 * carries provider prose.
 *
 * @param input - code, stats snapshot, timing, and optional overrides.
 * @returns a codec-valid result.
 */
function buildRouteTestResult(input: RouteTestResultInput): ReviewRouteTestResult {
  const { code, stats } = input;
  const latency = Math.max(0, Math.round(input.now() - input.startedAt));
  const retryAfter = typeof input.retryAfterMs === 'number' && Number.isFinite(input.retryAfterMs)
    ? Math.max(0, Math.round(input.retryAfterMs))
    : 0;
  return {
    status: routeTestStatusOf(code),
    code,
    route: {
      provider: clipText(stats.route.provider, 200),
      model: clipText(stats.route.model, 200),
      reasoningEffort: clipText(stats.route.reasoningEffort, 200),
    },
    authKind: stats.authKind,
    providerName: stats.providerName,
    settingsNs: stats.settingsNs,
    credentialEnv: [...stats.credentialEnv],
    effortUsed: clipText(stats.effortUsed, 200),
    effortNotAdvertised: stats.effortNotAdvertised === true,
    latencyMs: latency,
    retryAfterMs: retryAfter,
    failureCode: normalizeFailureCode(input.failureCode ?? ''),
    detail: input.detail ?? ROUTE_TEST_DETAILS[code],
  };
}

/**
 * Classify one observed failure into a strict result.
 *
 * @param stats - probe stats snapshot.
 * @param failure - provider-neutral failure facts.
 * @param options - result timing plus optional code/detail overrides.
 * @returns the failing result.
 */
function buildRouteTestFailure(
  stats: RouteTestStats,
  failure: RouteTestFailureFacts,
  options: { startedAt: number; now: () => number; code?: ReviewRouteTestCode; detail?: string },
): ReviewRouteTestResult {
  const code = options.code
    ?? classifyRouteTestFailure(failure.code, stats.authKind, failure.status);
  return buildRouteTestResult({
    code,
    stats,
    startedAt: options.startedAt,
    now: options.now,
    failureCode: failure.code,
    detail: options.detail,
  });
}

/**
 * Install the saved-route test endpoint for this Host plugin.
 *
 * The endpoint object is published through `ctx.provide()`, which ties its
 * lifetime to the plugin fiber, and carries the manual `typertRemote` binding
 * the strict Gateway dispatch validates: the binding's `service` is the same
 * object, and its `serviceKey`/`namespace` are exactly the contributed
 * `autoReviewModel` identity. No settings are written, no tool runs, and no
 * Session or credential value is read or changed.
 *
 * Call this once from the Host plugin's `apply(ctx, config)` with the same
 * volatile config the listener reads: `installRouteTestEndpoint(ctx, config)`.
 *
 * @param ctx - Host context exposing `llm` and `provide`.
 * @param config - live reviewer config (volatile refs or plain values).
 * @param options - test-only tuning overrides; production omits them.
 */
export function installRouteTestEndpoint(
  ctx: RouteTestContext,
  config: ReviewerConfig,
  options: RouteTestOptions = {},
): void {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = finiteInteger(options.timeoutMs, ROUTE_TEST_TIMEOUT_MS, 1);
  const maxTokens = Math.min(
    finiteInteger(options.maxTokens, ROUTE_TEST_MAX_TOKENS, 1),
    ROUTE_TEST_MAX_TOKENS,
  );
  const limits: RouteTestRateLimits = {
    minIntervalMs: finiteInteger(options.minIntervalMs, ROUTE_TEST_MIN_INTERVAL_MS, 0),
    windowMs: finiteInteger(options.windowMs, ROUTE_TEST_WINDOW_MS, 1),
    maxPerWindow: finiteInteger(options.maxPerWindow, ROUTE_TEST_MAX_PER_WINDOW, 1),
  };
  const state = createRouteTestState(now());

  /** The admitted probe flight that currently owns the single-flight slot. */
  let activeFlight: RouteTestFlight | undefined;

  /**
   * Hand the single-flight slot back, but only for the flight that owns it.
   *
   * A probe can return its result while a provider operation is still pending;
   * the slot then stays held until {@link settleFlightOperation} sees the last
   * operation settle, so a second provider stream can never accumulate beside
   * an orphaned one.
   */
  const releaseFlight = (flight: RouteTestFlight): void => {
    if (flight.released) return;
    flight.released = true;
    if (activeFlight !== flight) return;
    activeFlight = undefined;
    state.inFlight = false;
  };

  /** Observe one provider operation settlement and release the slot when idle. */
  const settleFlightOperation = (flight: RouteTestFlight): void => {
    flight.pending -= 1;
    state.pendingProviderOperations = Math.max(0, state.pendingProviderOperations - 1);
    if (flight.pending === 0 && flight.finished) releaseFlight(flight);
  };

  /** Mark the probe result decided; release only when no provider operation is left. */
  const finishFlight = (flight: RouteTestFlight): void => {
    flight.finished = true;
    if (flight.pending === 0) releaseFlight(flight);
  };

  /** Build the operation tracker bound to one admitted flight. */
  const createTracker = (flight: RouteTestFlight): RouteTestOperationTracker => ({
    track<T>(operation: () => Promise<T> | T): Promise<T> {
      let promise: Promise<T>;
      try {
        promise = Promise.resolve(operation());
      } catch (error) {
        promise = Promise.reject(error);
      }
      flight.pending += 1;
      state.pendingProviderOperations += 1;
      // Observe both settlement arms so a late rejection can never surface as
      // an unhandled rejection after the endpoint already returned.
      promise.then(
        () => settleFlightOperation(flight),
        () => settleFlightOperation(flight),
      );
      return promise;
    },
  });

  const endpoint = {
    /**
     * Probe the currently saved review route once.
     *
     * @param signal - optional transport cancellation from the Remote carrier.
     * @returns a strict, prose-free probe result.
     */
    async testReviewRoute(signal?: AbortSignal): Promise<ReviewRouteTestResult> {
      const startedAt = now();
      const settings = readReviewerSettings(config);
      const route: ReviewRouteTestRoute = {
        provider: settings.provider,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
      };
      const stats = createRouteTestStats(route);

      /** Build a local refusal or deadline outcome that never reached the provider. */
      const refuse = (
        code: 'ROUTE_DISABLED' | 'ROUTE_INCOMPLETE' | 'BUSY' | 'RATE_LIMITED' | 'CANCELLED' | 'TIMEOUT',
        retryAfterMs?: number,
      ): ReviewRouteTestResult => buildRouteTestResult({
        code,
        stats,
        startedAt,
        now,
        retryAfterMs,
      });

      if (signal?.aborted === true) return refuse('CANCELLED');
      if (!settings.enabled) return refuse('ROUTE_DISABLED');
      if (route.provider === '' || route.model === '') return refuse('ROUTE_INCOMPLETE');

      const refusal = checkRouteTestThrottle(state, now(), limits);
      if (refusal !== undefined) return refuse(refusal.code, refusal.retryAfterMs);

      const deadline = createRouteTestDeadline(timeoutMs, signal);
      markRouteTestStarted(state, now());
      const flight: RouteTestFlight = { pending: 0, finished: false, released: false };
      activeFlight = flight;
      const tracker = createTracker(flight);
      try {
        applyProviderClassification(
          stats,
          classifyRouteTestProvider(route.provider, readProviderDirectory(ctx.llm)),
        );

        if (route.reasoningEffort !== '') {
          const infoPromise = tracker.track(
            () => Promise.resolve().then(
              () => ctx.llm.resolveModelInfo(route.provider, route.model, deadline.signal),
            ),
          );
          let info: RouteTestModelInfoLike | undefined;
          try {
            info = await raceWithDeadline(infoPromise, deadline.signal);
          } catch (error) {
            const aborted = abortOutcome(deadline);
            if (aborted === 'CANCELLED') return refuse('CANCELLED');
            if (aborted === 'TIMEOUT') return refuse('TIMEOUT');
            return buildRouteTestFailure(stats, readThrownFailure(error), { startedAt, now });
          }
          const aborted = abortOutcome(deadline);
          if (aborted === 'CANCELLED') return refuse('CANCELLED');
          if (aborted === 'TIMEOUT') return refuse('TIMEOUT');
          if (info === undefined) {
            return buildRouteTestFailure(
              stats,
              { code: '' },
              { startedAt, now, code: 'UNKNOWN_MODEL', detail: ROUTE_TEST_UNKNOWN_MODEL_DETAIL },
            );
          }
          if (readAdvertisedEfforts(info).has(route.reasoningEffort)) {
            stats.effortUsed = route.reasoningEffort;
          } else {
            stats.effortNotAdvertised = true;
          }
        }

        const request = buildRouteTestRequest(route, stats.effortUsed, deadline.signal, maxTokens);
        const outcome = await consumeRouteTestStream(ctx.llm, request, deadline, tracker);
        switch (outcome.kind) {
          case 'cancelled':
            return refuse('CANCELLED');
          case 'timeout':
            return refuse('TIMEOUT');
          case 'oversize':
            return buildRouteTestFailure(
              stats,
              { code: '' },
              { startedAt, now, code: 'UNKNOWN', detail: ROUTE_TEST_OVERSIZE_DETAIL },
            );
          case 'failure': {
            const aborted = abortOutcome(deadline);
            if (aborted === 'CANCELLED') return refuse('CANCELLED');
            if (aborted === 'TIMEOUT') return refuse('TIMEOUT');
            const premature = outcome.failure.code === 'STREAM_CLOSED';
            return buildRouteTestFailure(stats, outcome.failure, {
              startedAt,
              now,
              detail: premature ? ROUTE_TEST_PREMATURE_DETAIL : undefined,
            });
          }
          case 'finish': {
            const finishFailure = readFinishFailure(outcome.reason);
            if (finishFailure !== undefined) {
              const aborted = abortOutcome(deadline);
              if (aborted === 'CANCELLED') return refuse('CANCELLED');
              if (aborted === 'TIMEOUT') return refuse('TIMEOUT');
              return buildRouteTestFailure(stats, finishFailure, { startedAt, now });
            }
            if (!outcome.sawContent) {
              return buildRouteTestResult({
                code: 'EMPTY_RESPONSE',
                stats,
                startedAt,
                now,
              });
            }
            return buildRouteTestResult({
              code: 'OK',
              stats,
              startedAt,
              now,
            });
          }
          /* v8 ignore next -- the outcome union is exhaustive. */
          default:
            return buildRouteTestResult({ code: 'UNKNOWN', stats, startedAt, now });
        }
      } catch (error) {
        const aborted = abortOutcome(deadline);
        if (aborted === 'CANCELLED') return refuse('CANCELLED');
        if (aborted === 'TIMEOUT') return refuse('TIMEOUT');
        return buildRouteTestFailure(stats, readThrownFailure(error), { startedAt, now });
      } finally {
        // The endpoint has decided its result; the slot is handed back only
        // when every tracked provider operation has actually settled, so an
        // orphaned capability/next/return keeps later probes at BUSY.
        finishFlight(flight);
        deadline.dispose();
      }
    },
  };

  // The Gateway validates this visible binding against the strict descriptor:
  // its `service` must be this exact object, `serviceKey` the Cordis key, and
  // `namespace` the descriptor's wire namespace.
  const binding: RouteTestTypertBinding = Object.freeze({
    service: endpoint,
    serviceKey: REMOTE_SERVICE_KEY,
    namespace: REMOTE_NAMESPACE,
  });
  Object.defineProperty(endpoint, 'typertRemote', {
    value: binding,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  Object.freeze(endpoint);

  ctx.provide(REMOTE_SERVICE_KEY, endpoint);
}

/** Read the configurable-provider directory; a broken directory degrades to unknown auth. */
function readProviderDirectory(llm: RouteTestLlmLike): readonly RouteTestProviderLike[] {
  if (typeof llm.listConfigurableProviders !== 'function') return [];
  try {
    const entries = llm.listConfigurableProviders();
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

/**
 * Stable helpers exposed for regression tests and Host integration checks.
 *
 * This object is not part of the plugin contract and may grow with the tests.
 */
export const __testing = {
  ROUTE_TEST_TIMEOUT_MS,
  ROUTE_TEST_MIN_INTERVAL_MS,
  ROUTE_TEST_WINDOW_MS,
  ROUTE_TEST_MAX_PER_WINDOW,
  ROUTE_TEST_MAX_TOKENS,
  ROUTE_TEST_TEMPERATURE,
  ROUTE_TEST_MAX_OUTPUT_CHARS,
  ROUTE_TEST_MAX_OUTPUT_CHUNKS,
  ROUTE_TEST_CLOSE_GRACE_MS,
  ROUTE_TEST_SYSTEM_PROMPT,
  ROUTE_TEST_USER_PROMPT,
  ROUTE_TEST_DETAILS,
  REMOTE_SERVICE_KEY,
  REMOTE_NAMESPACE,
  createRouteTestState,
  checkRouteTestThrottle,
  markRouteTestStarted,
  classifyRouteTestFailure,
  classifyRouteTestProvider,
  normalizeFailureCode,
  readThrownFailure,
  readFinishFailure,
  buildRouteTestRequest,
  routeTestStatusOf,
  installRouteTestEndpoint,
};
