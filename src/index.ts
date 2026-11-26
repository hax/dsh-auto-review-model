/**
 * Host entry for `@aghost-prj/dsh-auto-review-model`.
 *
 * The plugin installs one globally prepended `llm/stream` waterfall listener.
 * When the experimental auto-review package asks the LLM service to classify a
 * pending tool call, the listener rewrites only that request from the fixed
 * reviewer route to the provider/model (and optional reasoning effort) chosen
 * in this plugin's settings. Every other request passes through untouched.
 *
 * Rewriting is performed on a fresh object because auto-review freezes its
 * `GenerateOptions` with `deepFreeze`. The rewritten object is then streamed
 * through `ctx.llm.stream`, which re-enters the same waterfall; a `WeakSet`
 * marks that object so the listener forwards it immediately instead of
 * rewriting it again. Each reviewer request is therefore rewritten exactly
 * once, with no recursion.
 *
 * A configured reasoning effort is verified against the reviewer route's live
 * capabilities before the first review. If that lookup fails or exceeds its
 * five-minute deadline, the review either moves on to the next configured
 * fallback route or rejects immediately with an actionable error that names the
 * exact route and repair steps; the failed lookup is not cached and the review
 * never silently degrades to the provider's default effort.
 *
 * Optional ordered multi-route review: row 1 is the legacy primary route
 * (`provider`/`model`/`reasoningEffort`), followed by the ordered `fallbacks`
 * array of explicit routes. The intercepted review request's own
 * provider/model is ALWAYS the implicit final fallback (reasoning effort `''`),
 * so it is never configurable, never stored as a settings row, and never
 * duplicated when an explicit attempt already uses the same provider+model.
 * With no usable explicit route the listener does not rewrite at all and the
 * native session model serves the review. Legacy `{ mode: 'session' }` entries
 * are ignored because that fallback is implicit now. Only route-level failures
 * — capability lookup failure, a thrown provider stream, or a terminal `finish`
 * whose official failure code is a quota / auth / credential / rate-limit /
 * server / timeout / transport / adapter failure — advance to the next route.
 * A caller abort is propagated untouched, and content/protocol failures are
 * surfaced instead of retried. Chunks are forwarded to the caller immediately:
 * a route may only be replaced before its first chunk is emitted. Once output
 * has crossed that commit point, a later failure is surfaced as an actionable
 * error instead of retrying, so the caller's single-decision stream never sees
 * chunks from two different routes. When every route fails before any output,
 * one aggregate error lists each attempted route with its code and raw provider message.
 *
 * The same plugin instance publishes one small Typert Remote endpoint,
 * `autoReviewModel/testReviewRoute`, so the settings page can probe the SAVED
 * reviewer route with one fixed harmless prompt. The endpoint reads the live
 * settings itself, accepts no browser-provided route or credential, sends no
 * session id, purpose, tools, or conversation history, returns a classified
 * outcome instead of model output, and throttles probes Host-wide. Its
 * manifest and Client contribution are hand-written generated-style artifacts
 * in `./typert.host.js` / `./typert.remote-client.js`.
 *
 * @module @aghost-prj/dsh-auto-review-model
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import z from '@deepseek-ai/schemastery';
import {
  INHERIT_EFFORT,
  adaptEffortToAdvertised,
  effortCacheKey,
  effortRank,
  isAutoReviewRequest,
  normalizeEffort,
  readReviewerSettings,
  shouldOverrideRoute,
} from './policy.js';
import type { ReviewerConfig, ReviewerSettings } from './policy.js';
import { installRouteTestEndpoint, __testing as routeTestTesting } from './route-test.js';
import { isRecord, readThrownFailure } from './failure.js';
export { ReviewerRouteError, ReviewerRoutesError } from './fallback.js';
import {
  PROTOCOL_FAILURE_CODE,
  ReviewerRouteError,
  ReviewerRoutesError,
  buildReviewPlan,
  pickWeightedStart,
  failureFromFinish,
  failureFromThrown,
  isAsyncIterable,
  isFallbackEligibleFailure,
  readRoutes,
  __testing as fallbackTesting,
} from './fallback.js';
import type {
  ReviewRouteAttempt,
  ReviewerRouteFailure,
} from './fallback.js';

/** One adapter-owned reasoning effort advertised for an exact route. */
interface LlmEffortInfo {
  id?: string;
}

/** The subset of `LlmModelInfo` this listener consults. */
interface LlmModelInfo {
  reasoning?: {
    efforts?: readonly LlmEffortInfo[];
  };
}

/** The `GenerateOptions` fields the listener reads or rewrites. */
interface GenerateOptions {
  provider: string;
  model: string;
  system?: string;
  reasoningEffort?: string;
  /** Session that issued the review; used to resolve an `inherit` effort. */
  sessionId?: string;
  signal?: AbortSignal;
}

/** One adapter-provided configurable-provider directory entry (subset). */
interface ConfigurableProviderInfo {
  provider: string;
  displayName?: string;
  settingsNs?: string;
  nativeAuth?: {
    env?: readonly string[];
    oauth?: boolean;
  };
}

/** The subset of the `llm` service used by this plugin. */
interface LlmService {
  stream(options: GenerateOptions): AsyncIterable<unknown>;
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmModelInfo | undefined>;
  /** Adapter-provided provider metadata; present on the real `LlmRuntime`. */
  listConfigurableProviders?(): readonly ConfigurableProviderInfo[];
}

/** Cordis listener options used by this plugin's waterfall registration. */
interface ListenerOptions {
  global?: boolean;
  prepend?: boolean;
}

/** Session-log exclusion service required to keep rerouted reviews free of conversation-log uploads. */
interface SessionLogDeepSeek {
  registerExclusion(exclude: (request: { purpose?: string }) => boolean): unknown;
}

/** The live request header fields this plugin reads from one session. */
interface SessionRequestHeaderLike {
  config?: {
    reasoningEffort?: string;
  };
}

/** The structural subset of one resolved session needed for `inherit`. */
interface SessionLike {
  requestHeader?(): SessionRequestHeaderLike | undefined;
}

/** The structural subset of the `sessions` service needed for `inherit`. */
interface SessionDirectory {
  get(id: string): SessionLike | undefined;
}

/** The subset of the host context used by this plugin. */
interface HostContext {
  llm: LlmService;
  /** Session directory used to resolve the `inherit` reasoning effort. */
  sessions: SessionDirectory;
  on(
    event: string,
    listener: (...args: any[]) => any,
    options?: ListenerOptions,
  ): unknown;
  inject(
    services: readonly string[],
    callback: (child: { sessionLogDeepSeek: SessionLogDeepSeek }) => void,
  ): unknown;
  /**
   * Publish one Cordis service for this plugin's lifetime (used to expose the
   * saved-route test endpoint object the Typert Gateway dispatches to).
   */
  provide(name: string, value: unknown): unknown;
}

/** Loader line id used by the host entry. */
export const name = 'auto-review-model';

/** Host services required before the listener may be installed. */
export const inject = ['llm', 'sessionLogDeepSeek', 'sessions'];

/**
 * Review-model settings. All fields are volatile so the settings UI can update
 * them in place; the listener always reads their current values per request.
 *
 * The schema is annotated with the plain `z` type on purpose: the inferred type
 * of the volatile array would mention the schemastery-internal
 * `@deepseek-ai/cosmokit` `Volatile` helper, which this package must not add as
 * a dependency just to emit a portable declaration file. Runtime validation is
 * unchanged; the Host reads the live values through `readReviewerSettings` and
 * `readFallbackEntries`.
 */
export const Config: z = z.object({
  /**
   * @deprecated Ignored. The plugin is always active; this field stays in the
   * schema only so configurations written by older versions still validate.
   */
  enabled: z.boolean().default(true).volatile(),
  /** Whether settings-list row 1 (the top-level route) is eligible. */
  primaryEnabled: z.boolean().default(true).volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  reasoningEffort: z.string().default('').volatile(),
  /**
   * Ordered explicit fallback routes tried after the primary route.
   *
   * Each entry is an explicit `{ enabled?, provider, model, reasoningEffort? }`
   * route; a disabled entry stays saved but is skipped when building the plan.
   * `mode` is kept only so legacy `{ mode: 'session' }` rows round-trip without
   * suddenly becoming explicit routes: the Host ignores those entries, because
   * the intercepted request's own route is always the implicit final fallback.
   * `mode` is a plain volatile-owned string rather than a union so an older or
   * hand-edited value cannot make the whole config invalid.
   */
  fallbacks: z.array(z.object({
    enabled: z.boolean().default(true),
    mode: z.string().default('route'),
    provider: z.string().default(''),
    model: z.string().default(''),
    reasoningEffort: z.string().default(''),
  })).default([]).volatile(),
  /** Unified ordered reviewer routes; absent/empty means legacy migration. */
  routes: z.array(z.object({
    enabled: z.boolean().default(true),
    weight: z.number().default(0),
    provider: z.string().default(''),
    model: z.string().default(''),
    reasoningEffort: z.string().default(''),
  })).volatile(),
});

/**
 * Hard deadline for one reviewer capability lookup.
 *
 * A route that cannot answer within five minutes is treated as a route that
 * cannot serve the review, not as a route without reasoning support: the review
 * fails closed with an actionable error instead of silently falling back to the
 * provider's default reasoning effort.
 */
const CAPABILITY_TIMEOUT_MS = 300_000;

/** Stable error name for capability-query failures. */
const CAPABILITY_ERROR_NAME = 'AutoReviewModelCapabilityError';

/** Error code: the reviewer route did not answer within {@link CAPABILITY_TIMEOUT_MS}. */
const CAPABILITY_TIMEOUT_CODE = 'AUTO_REVIEW_MODEL_CAPABILITY_TIMEOUT';

/** Error code: the reviewer route capability lookup failed for another reason. */
const CAPABILITY_FAILED_CODE = 'AUTO_REVIEW_MODEL_CAPABILITY_FAILED';

/** Repair advice shared by every capability failure. */
const CAPABILITY_REPAIR_HINT =
  'Check that the provider is configured with valid credentials, that the model is available and correctly routed for this account, and that the network can reach the provider; then update the Auto review model in Settings or retry.';

/**
 * Describe an unknown thrown value without ever throwing from the describer.
 *
 * The text lands in the Auto review failure reason the Agent receives, so it
 * must stay readable even when an adapter rejects with a non-Error value.
 *
 * @param {unknown} error - the caught rejection reason.
 * @returns {string} a non-empty diagnostic message.
 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  try {
    const text = String(error);
    if (text !== '' && text !== '[object Object]') return text;
  } catch {
    // Fall through to the generic label.
  }
  return 'unknown error';
}

/**
 * Failure raised when the configured reviewer route cannot prove its reasoning
 * capabilities.
 *
 * The message names the exact route, the five-minute deadline, and concrete
 * repair steps so the Auto review failure reason stays actionable instead of a
 * bare "review failed". The original lookup error is preserved as `cause`.
 */
export class ReviewerCapabilityError extends Error {
  /** Diagnostic code: timeout versus another lookup failure. */
  readonly code: string;
  /** Configured provider id used in the failed lookup. */
  readonly provider: string;
  /** Configured model id used in the failed lookup. */
  readonly model: string;
  /** Exact `provider/model` route named in the message. */
  readonly route: string;
  /** Capability lookup deadline in milliseconds. */
  readonly timeoutMs: number;
  /** Whether the deadline expired rather than the lookup failing. */
  readonly timedOut: boolean;

  /**
   * @param {string} provider - configured reviewer provider id.
   * @param {string} model - configured reviewer model id.
   * @param {boolean} timedOut - true when the deadline expired.
   * @param {unknown} [cause] - the underlying lookup failure, if any.
   */
  constructor(provider: string, model: string, timedOut: boolean, cause?: unknown) {
    const route = `${provider}/${model}`;
    const detail = timedOut
      ? `timed out after ${CAPABILITY_TIMEOUT_MS}ms (5 min)`
      : `failed: ${errorText(cause)}. The capability query has a ${CAPABILITY_TIMEOUT_MS}ms (5 min) timeout`;
    super(
      `auto-review-model: capability lookup for reviewer route "${route}" ${detail}. ${CAPABILITY_REPAIR_HINT}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = CAPABILITY_ERROR_NAME;
    this.code = timedOut ? CAPABILITY_TIMEOUT_CODE : CAPABILITY_FAILED_CODE;
    this.provider = provider;
    this.model = model;
    this.route = route;
    this.timeoutMs = CAPABILITY_TIMEOUT_MS;
    this.timedOut = timedOut;
  }
}

/**
 * Reject as soon as `signal` aborts, even when the adapter-owned lookup ignores
 * cancellation.
 *
 * The listener is removed when the lookup settles first, so a long-lived
 * reviewer request does not accumulate abort listeners.
 *
 * @param {AbortSignal} signal - combined request/deadline signal.
 * @returns {{ promise: Promise<never>, dispose: () => void }} abort rejection plus cleanup.
 */
function rejectWhenAborted(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
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

/** Reasoning capability cache tracking generations to guard against stale writes. */
interface CapabilityCache {
  generation: number;
  entries: Map<string, Set<string>>;
  clear(): void;
}

/** Construct an empty capability cache. */
function createCapabilityCache(): CapabilityCache {
  return {
    generation: 0,
    entries: new Map<string, Set<string>>(),
    clear() {
      this.generation += 1;
      this.entries.clear();
    },
  };
}

/**
 * Query the live reasoning capabilities of one exact reviewer route.
 *
 * The original reviewer request signal is combined with an
 * `AbortSignal.timeout(300_000)` deadline, so caller cancellation still takes
 * effect and a stuck provider cannot hold the review open indefinitely. The
 * lookup is additionally raced against the combined signal, so the deadline
 * rejects even if the adapter ignores cancellation.
 *
 * A timeout, cancellation, lookup failure, or an undefined model-info result
 * rejects with an actionable {@link ReviewerCapabilityError}; nothing is
 * invented and no cache entry is written here, so a transient failure is
 * retried on the next review instead of being remembered as "unsupported".
 *
 * @param {HostContext} ctx - plugin context exposing `llm`.
 * @param {string} provider - configured reviewer provider id.
 * @param {string} model - configured reviewer model id.
 * @param {AbortSignal} [signal] - original reviewer request cancellation signal.
 * @returns {Promise<Set<string>>} the effort ids advertised by the route.
 * @throws {ReviewerCapabilityError} when the route capability cannot be proven.
 */
async function resolveRouteEfforts(
  ctx: HostContext,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  // A pre-aborted request must not start a lookup (or a five-minute timer).
  signal?.throwIfAborted();

  const deadline = AbortSignal.timeout(CAPABILITY_TIMEOUT_MS);
  const querySignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  const aborted = rejectWhenAborted(querySignal);

  let info: LlmModelInfo | undefined;
  try {
    info = await Promise.race([
      ctx.llm.resolveModelInfo(provider, model, querySignal),
      aborted.promise,
    ]);
  } catch (cause) {
    // Caller cancellation wins over the deadline or an adapter-side failure:
    // the request was cancelled, so blame the route only when it was not.
    if (signal?.aborted) signal.throwIfAborted();
    throw new ReviewerCapabilityError(provider, model, deadline.aborted, cause);
  } finally {
    aborted.dispose();
  }

  // The lookup may resolve even though the request or deadline was aborted
  // between the race settling and this check; such a result is unusable.
  if (signal?.aborted) signal.throwIfAborted();
  if (deadline.aborted) {
    throw new ReviewerCapabilityError(provider, model, true, deadline.reason);
  }
  if (info === undefined) {
    throw new ReviewerCapabilityError(
      provider,
      model,
      false,
      new Error('the provider returned no model information for this route'),
    );
  }

  const advertised = info.reasoning?.efforts;
  return new Set(
    Array.isArray(advertised)
      ? advertised
          .map((entry) => entry?.id)
          .filter((id): id is string => id !== undefined)
      : [],
  );
}

/**
 * Ask the live LLM service whether one exact route advertises an effort.
 *
 * Capability lookups are cached per `provider\0model` because
 * `resolveModelInfo` is an async service call and reviewer requests may be
 * frequent. Only successful lookups are cached: failures and timeouts propagate
 * as actionable errors and are retried on the next request. The cache is
 * cleared on `loader/volatile-update` or `llm/adapters-updated` so reconfiguring
 * a route or changing adapter topology picks up fresh capabilities. An absent
 * `reasoning` block means the route advertises no efforts, so the configured
 * effort must not be sent; that is a successful lookup result, not a failure.
 *
 * Lookups track cache generation so older asynchronous queries that settle
 * after cache invalidation do not overwrite newer cached capabilities.
 *
 * @param {HostContext} ctx - plugin context exposing `llm`.
 * @param {CapabilityCache} cache - capability cache with generation tracking.
 * @param {string} provider - target provider id.
 * @param {string} model - target model id.
 * @param {string} effort - normalized configured effort.
 * @param {AbortSignal} [signal] - optional cancellation signal from reviewer request.
 * @returns {Promise<boolean>} true only when the route advertises this effort.
 * @throws {ReviewerCapabilityError} when the capability query fails or times out.
 */
async function isEffortSupported(
  ctx: HostContext,
  cache: CapabilityCache,
  provider: string,
  model: string,
  effort: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await routeEfforts(ctx, cache, provider, model, signal)).has(effort);
}

/**
 * Read one route's advertised effort ids through the shared capability cache.
 *
 * This is the same lookup {@link isEffortSupported} performs, exposed as a set
 * so an inherited session effort can be adapted to the target route's
 * vocabulary. Only successful lookups are cached; failures propagate as
 * actionable {@link ReviewerCapabilityError}s and are retried on the next
 * review.
 *
 * @param {HostContext} ctx - plugin context exposing `llm`.
 * @param {CapabilityCache} cache - capability cache with generation tracking.
 * @param {string} provider - target provider id.
 * @param {string} model - target model id.
 * @param {AbortSignal} [signal] - optional cancellation signal from reviewer request.
 * @returns {Promise<Set<string>>} the effort ids the route advertises.
 * @throws {ReviewerCapabilityError} when the capability query fails or times out.
 */
async function routeEfforts(
  ctx: HostContext,
  cache: CapabilityCache,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const key = effortCacheKey(provider, model);
  const cached = cache.entries.get(key);
  if (cached !== undefined) return cached;
  const startGen = cache.generation;
  const efforts = await resolveRouteEfforts(ctx, provider, model, signal);
  if (cache.generation === startGen) {
    cache.entries.set(key, efforts);
  }
  return efforts;
}

/**
 * Resolve the reasoning effort the main session currently uses.
 *
 * The intercepted review request carries the session id it was issued for; the
 * session's live request header owns the effort the main conversation uses.
 * An unresolvable session, a missing header, or an empty/default header effort
 * all mean "no inherited effort", which falls back to the provider default.
 * The `inherit` sentinel itself is never inherited (it would be circular).
 *
 * @param {HostContext} ctx - plugin context exposing `sessions`.
 * @param {GenerateOptions} options - intercepted review request.
 * @returns {string} a concrete inherited effort id, or `''` when none applies.
 */
function readSessionEffort(ctx: HostContext, options: GenerateOptions): string {
  if (typeof options.sessionId !== 'string' || options.sessionId === '') return '';
  let header: SessionRequestHeaderLike | undefined;
  try {
    header = ctx.sessions.get(options.sessionId)?.requestHeader?.();
  } catch {
    // A broken session directory must degrade to the provider default, not
    // fail the review: the inheritance is an optimization, not a requirement.
    return '';
  }
  const effort = normalizeEffort(header?.config?.reasoningEffort);
  return effort === INHERIT_EFFORT ? '' : effort;
}

/**
 * Build one rewritten reviewer request for an explicit route.
 *
 * Effort handling has three cases:
 *
 * - `''` (provider default): no caller effort is forwarded, so a stale
 *   review-request effort never leaks onto a rerouted review;
 * - a concrete effort: it is proven against the route's live capabilities. A
 *   successful lookup that does not advertise it drops to the provider default
 *   (the legacy behavior), while a failed/timed-out lookup rejects with
 *   {@link ReviewerCapabilityError} and a successful one is cached. Explicit
 *   efforts are never adapted;
 * - {@link INHERIT_EFFORT}: the main session's current effort is read and then
 *   adapted to the target route's advertised efforts by
 *   {@link adaptEffortToAdvertised} (nearest canonical rank, tie toward the
 *   higher rank, no ranked target effort → provider default). An unresolvable
 *   session or a session without an effort also means provider default.
 *
 * @param {HostContext} ctx - plugin context exposing `llm` and `sessions`.
 * @param {GenerateOptions} options - frozen original reviewer `GenerateOptions`.
 * @param {string} provider - resolved provider id.
 * @param {string} model - resolved model id.
 * @param {string} configEffort - normalized configured effort, `''`, or `inherit`.
 * @param {CapabilityCache} effortCache - capability cache owned by this plugin instance.
 * @returns {Promise<GenerateOptions>} the request to send.
 * @throws {ReviewerCapabilityError} when the route capability cannot be proven.
 */
async function buildRoutedRequest(
  ctx: HostContext,
  options: GenerateOptions,
  provider: string,
  model: string,
  configEffort: string,
  effortCache: CapabilityCache,
): Promise<GenerateOptions> {
  const patched: GenerateOptions = { ...options, provider, model };
  let effortToSend = '';
  if (configEffort === INHERIT_EFFORT) {
    const inherited = readSessionEffort(ctx, options);
    if (inherited !== '') {
      // The inherited effort belongs to another model, so it must be mapped to
      // this route's vocabulary. A capability failure is a route failure and is
      // handled by the caller exactly like an explicit-effort lookup failure.
      const advertised = await routeEfforts(ctx, effortCache, provider, model, options.signal);
      effortToSend = adaptEffortToAdvertised(inherited, advertised);
    }
  } else if (
    configEffort !== ''
    && (await isEffortSupported(ctx, effortCache, provider, model, configEffort, options.signal))
  ) {
    effortToSend = configEffort;
  }
  if (effortToSend !== '') {
    patched.reasoningEffort = effortToSend;
  } else {
    // No applicable effort, or a successful lookup proved the route does not
    // advertise it: the provider default applies, so never forward a stale
    // caller effort. A failed or timed-out lookup throws instead, so a
    // transient route problem never silently degrades the reasoning effort.
    delete patched.reasoningEffort;
  }
  return patched;
}

/**
 * Copy one frozen reviewer request and rewrite its route once.
 *
 * Used whenever the plan has exactly one route (a request without a usable
 * route, or an explicit route that already equals it with no forced effort):
 * there is nothing to fall back to, so the original streaming behavior is
 * preserved exactly — chunks flow through directly, and a capability failure propagates
 * as the original {@link ReviewerCapabilityError}.
 *
 * The generator defers the capability lookup until iteration, which keeps the
 * `llm/stream` listener itself synchronous (the waterfall returns listener
 * results without awaiting them) while still allowing an async
 * `resolveModelInfo` call before the downstream stream starts.
 *
 * @param {HostContext} ctx - plugin context exposing `llm`.
 * @param {GenerateOptions} options - frozen original reviewer `GenerateOptions`.
 * @param {ReviewRouteAttempt} attempt - the single resolved route.
 * @param {WeakSet<object>} patchedRequests - objects already rewritten.
 * @param {CapabilityCache} effortCache - capability cache.
 * @returns {AsyncGenerator<unknown>} the rewritten request's chunk stream.
 */
async function* rewriteSingleRoute(
  ctx: HostContext,
  options: GenerateOptions,
  attempt: ReviewRouteAttempt,
  patchedRequests: WeakSet<object>,
  effortCache: CapabilityCache,
): AsyncGenerator<unknown> {
  const patched = await buildRoutedRequest(
    ctx,
    options,
    attempt.provider,
    attempt.model,
    attempt.reasoningEffort,
    effortCache,
  );
  patchedRequests.add(patched);
  const iterable = ctx.llm.stream(patched);
  if (!isAsyncIterable(iterable)) {
    throw new ReviewerRouteError(attempt.label, PROTOCOL_FAILURE_CODE, 'the provider returned no chunk stream');
  }
  const outcome = await collectAnswer(iterable[Symbol.asyncIterator](), options.signal);
  if ('failure' in outcome) {
    throw new ReviewerRouteError(attempt.label, outcome.failure.code === '' ? PROTOCOL_FAILURE_CODE : outcome.failure.code, outcome.failure.detail);
  }
  for (const chunk of outcome.answer.chunks) yield chunk;
  yield outcome.answer.finish;
}

/**
 * One reviewer answer buffered far enough to decide whether to keep it.
 *
 * A reviewer answer is one short JSON object by contract, so buffering it costs
 * nothing measurable. Doing so is what lets this plugin treat "the model answered
 * something that is not a risk/decision object" as a route failure: the caller's
 * parser never has to see the bad answer, so the next configured route still gets
 * a chance and the failing route only fails once.
 */
interface BufferedAnswer {
  /** Every chunk before the terminal `finish`, in arrival order. */
  chunks: unknown[];
  /** Concatenated `text-delta` content of the answer. */
  text: string;
  /** The terminal `finish` chunk. */
  finish: unknown;
  usage?: Record<string, unknown>;
  decision?: { risk?: string; decision?: string };
}

/** A buffered answer could not be produced; the route failed. */
interface AnswerFailure {
  code: string;
  detail: string;
}

/** Reviewer answers are one JSON object; refuse to buffer an unbounded stream. */
const ANSWER_BUFFER_LIMIT = 1 << 20;

/**
 * Whether a reviewer answer is a usable risk/decision object.
 *
 * Only the outer shape is checked here: one JSON object carrying a known `risk`
 * and `decision`. DSH applies the stricter combination rules itself; this check
 * exists only to keep a route that answered something else (prose, tool-call
 * markup, an empty block) from being committed as the reviewer's decision.
 */
function isUsableReviewAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!isRecord(value)) return false;
  const record = value as Record<string, unknown>;
  const risk = record['risk'];
  const decision = record['decision'];
  return (
    (risk === 'low' || risk === 'medium' || risk === 'high') &&
    (decision === 'allow' || decision === 'deny')
  );
}

/**
 * Drain one reviewer stream into a {@link BufferedAnswer} without forwarding it.
 *
 * Both transport-level and content-level failures are reported the same way:
 * the caller decides which route to try next. A stream that ends without a
 * terminal `finish` fails as `STREAM_CLOSED`; a `finish` whose reason is an
 * error or an abort fails with that reason; a clean stop whose text is not a
 * risk/decision object fails as `UNUSABLE_ANSWER`.
 */
async function collectAnswer(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal | undefined,
): Promise<{ answer: BufferedAnswer } | { failure: AnswerFailure }> {
  const chunks: unknown[] = [];
  let text = '';
  let usage: Record<string, unknown> | undefined;
  try {
    for (;;) {
      signal?.throwIfAborted();
      let step: IteratorResult<unknown>;
      try {
        step = await iterator.next();
      } catch (error) {
        signal?.throwIfAborted();
        const facts = readThrownFailure(error);
        return {
          failure: {
            code: facts.code,
            detail: error instanceof Error && error.message !== '' ? error.message : String(error),
          },
        };
      }
      signal?.throwIfAborted();
      if (step.done === true) {
        return { failure: { code: 'STREAM_CLOSED', detail: 'the reviewer stream ended before its terminal finish' } };
      }
      const chunk = step.value;
      if (!isRecord(chunk) || chunk.type !== 'finish') {
        chunks.push(chunk);
        if (isRecord(chunk) && chunk.type === 'usage' && isRecord(chunk.usage)) {
          usage = chunk.usage as Record<string, unknown>;
        }
        if (isRecord(chunk) && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text;
          if (text.length > ANSWER_BUFFER_LIMIT) {
            return {
              failure: { code: 'ANSWER_TOO_LARGE', detail: `reviewer answer exceeded ${ANSWER_BUFFER_LIMIT} characters` },
            };
          }
        }
        continue;
      }
      const reason = chunk.reason;
      const kind = isRecord(reason) && typeof reason.kind === 'string' ? reason.kind : '';
      if (kind === 'error') {
        signal?.throwIfAborted();
        const facts = isRecord(reason) && isRecord(reason.failure) ? reason.failure : undefined;
        const code = facts !== undefined && typeof facts.code === 'string' ? facts.code : '';
        const detail = facts !== undefined && typeof facts.message === 'string' ? facts.message : 'the reviewer stream failed';
        return { failure: { code, detail } };
      }
      if (kind === 'aborted') {
        return { failure: { code: 'ABORTED', detail: 'the provider aborted the reviewer stream' } };
      }
      if (!isUsableReviewAnswer(text)) {
        return {
          failure: {
            code: 'UNUSABLE_ANSWER',
            detail: `the reviewer answered ${JSON.stringify(text.slice(0, 120))}, which is not a risk/decision object`,
          },
        };
      }
      const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
      return {
        answer: {
          chunks,
          text,
          finish: chunk,
          ...(usage === undefined ? {} : { usage }),
          decision: {
            ...(typeof parsed['risk'] === 'string' ? { risk: parsed['risk'] } : {}),
            ...(typeof parsed['decision'] === 'string' ? { decision: parsed['decision'] } : {}),
          },
        },
      };
    }
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // Cleanup must never mask the failure that abandoned the stream.
    }
  }
}

/** Convert an observed thrown failure to one attempt record. */
function routeFailureFromThrown(attempt: ReviewRouteAttempt, error: unknown): ReviewerRouteFailure {
  return failureFromThrown(attempt, error);
}

/** Directory holding one append-only measured ledger per ISO week. */
export const REVIEW_LEDGER_DIR = join(homedir(), '.dsh');

function isoWeekOf(date: Date): { year: number; week: number } {
  const shifted = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = shifted.getUTCDay() || 7;
  shifted.setUTCDate(shifted.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(shifted.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((shifted.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: shifted.getUTCFullYear(), week };
}

export function reviewLedgerPath(now: Date = new Date()): string {
  const { year, week } = isoWeekOf(now);
  return join(REVIEW_LEDGER_DIR, `auto-review-ledger-${year}-W${String(week).padStart(2, '0')}.jsonl`);
}

function ledgerEnabled(): boolean { return process.env['DSH_AUTO_REVIEW_LEDGER'] !== '0'; }

interface ReviewLedgerRecord {
  v: 1;
  t: number;
  local: string;
  sid?: string;
  totalMs: number;
  fallback: boolean;
  stickyUsed?: string;
  attempts: Array<Record<string, unknown>>;
  winner?: string;
}

let sealedWeek: string | undefined;
function sealPreviousWeek(now: Date): void {
  const current = isoWeekOf(now);
  const currentId = `${current.year}-W${String(current.week).padStart(2, '0')}`;
  if (sealedWeek === currentId) return;
  sealedWeek = currentId;
  try {
    const previous = new Date(now.getTime());
    previous.setUTCDate(previous.getUTCDate() - 7);
    const { year, week } = isoWeekOf(previous);
    const plain = join(REVIEW_LEDGER_DIR, `auto-review-ledger-${year}-W${String(week).padStart(2, '0')}.jsonl`);
    if (!existsSync(plain)) return;
    writeFileSync(`${plain}.zst`, zstdCompressSync(readFileSync(plain)));
    rmSync(plain);
  } catch {
    // Housekeeping failures leave the plain ledger intact for a later retry.
  }
}

function writeLedger(record: ReviewLedgerRecord): void {
  if (!ledgerEnabled()) return;
  try {
    const now = new Date();
    sealPreviousWeek(now);
    appendFileSync(reviewLedgerPath(now), `${JSON.stringify(record)}\n`);
  } catch {
    // Ledger capture must never affect review delivery.
  }
}

/** Session-scoped preferred route, learned only from a usable answer. */
const stickyReviewRoutes = new Map<string, string>();

function reviewRouteKey(attempt: ReviewRouteAttempt): string {
  return `${attempt.provider}\u0000${attempt.model}\u0000${attempt.reasoningEffort}`;
}

function noteReviewRoute(sessionId: string | undefined, attempt: ReviewRouteAttempt, answered: boolean): void {
  if (sessionId === undefined || sessionId === '') return;
  const key = reviewRouteKey(attempt);
  if (answered) stickyReviewRoutes.set(sessionId, key);
  else if (stickyReviewRoutes.get(sessionId) === key) stickyReviewRoutes.delete(sessionId);
}

function preferStickyRoute(plan: readonly ReviewRouteAttempt[], sessionId: string | undefined): readonly ReviewRouteAttempt[] {
  if (sessionId === undefined || sessionId === '') return plan;
  const sticky = stickyReviewRoutes.get(sessionId);
  if (sticky === undefined) return plan;
  const index = plan.findIndex(attempt => reviewRouteKey(attempt) === sticky);
  if (index <= 0) return plan;
  return [plan[index]!, ...plan.slice(0, index), ...plan.slice(index + 1)];
}

/** Try one route without forwarding until the complete answer is validated. */
async function tryReviewRoute(
  ctx: HostContext,
  options: GenerateOptions,
  attempt: ReviewRouteAttempt,
  patchedRequests: WeakSet<object>,
  effortCache: CapabilityCache,
): Promise<{ ok: true; chunks: unknown[]; finish: unknown; usage?: Record<string, unknown>; decision?: { risk?: string; decision?: string } } | { ok: false; failure: ReviewerRouteFailure }> {
  let patched: GenerateOptions;
  try {
    patched = await buildRoutedRequest(ctx, options, attempt.provider, attempt.model, attempt.reasoningEffort, effortCache);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof ReviewerCapabilityError)) throw error;
    return { ok: false, failure: failureFromThrown(attempt, error) };
  }
  patchedRequests.add(patched);
  let iterable: AsyncIterable<unknown>;
  try { iterable = ctx.llm.stream(patched); }
  catch (error) { options.signal?.throwIfAborted(); return { ok: false, failure: routeFailureFromThrown(attempt, error) }; }
  if (!isAsyncIterable(iterable)) {
    return { ok: false, failure: { attempt, code: PROTOCOL_FAILURE_CODE, detail: 'the provider returned no chunk stream' } };
  }
  let iterator: AsyncIterator<unknown>;
  try { iterator = iterable[Symbol.asyncIterator](); }
  catch (error) { options.signal?.throwIfAborted(); return { ok: false, failure: routeFailureFromThrown(attempt, error) }; }
  const outcome = await collectAnswer(iterator, options.signal);
  if ('failure' in outcome) {
    options.signal?.throwIfAborted();
    return { ok: false, failure: { attempt, code: outcome.failure.code, detail: outcome.failure.detail } };
  }
  return { ok: true, chunks: outcome.answer.chunks, finish: outcome.answer.finish, ...(outcome.answer.usage === undefined ? {} : { usage: outcome.answer.usage }), ...(outcome.answer.decision === undefined ? {} : { decision: outcome.answer.decision }) };
}

async function* streamReviewWithFallback(
  ctx: HostContext,
  options: GenerateOptions,
  plan: readonly ReviewRouteAttempt[],
  patchedRequests: WeakSet<object>,
  effortCache: CapabilityCache,
): AsyncGenerator<unknown> {
  const failures: ReviewerRouteFailure[] = [];
  const sessionId = options.sessionId;
  const sticky = sessionId === undefined || sessionId === '' ? undefined : stickyReviewRoutes.get(sessionId);
  const tried = new Set<string>();
  let candidates: readonly ReviewRouteAttempt[] = preferStickyRoute(plan, sessionId);
  let restartedFromTop = false;
  const startedAt = Date.now();
  const attempts: Array<Record<string, unknown>> = [];
  const recordReview = (winner?: ReviewRouteAttempt): void => {
    writeLedger({
      v: 1,
      t: startedAt,
      local: new Date(startedAt).toISOString(),
      ...(sessionId === undefined || sessionId === '' ? {} : { sid: sessionId }),
      totalMs: Date.now() - startedAt,
      fallback: attempts.length > 1,
      ...(sticky === undefined ? {} : { stickyUsed: sticky }),
      attempts,
      ...(winner === undefined ? {} : { winner: `${winner.provider}/${winner.model}` }),
    });
  };
  for (;;) {
    let restart = false;
    for (const attempt of candidates) {
      const key = reviewRouteKey(attempt);
      if (tried.has(key)) continue;
      tried.add(key);
      const attemptStarted = Date.now();
      const outcome = await tryReviewRoute(ctx, options, attempt, patchedRequests, effortCache);
      const base = { route: `${attempt.provider}/${attempt.model}`, effort: attempt.reasoningEffort, mode: attempt.mode, ms: Date.now() - attemptStarted };
      if (outcome.ok) {
        attempts.push({ ...base, ok: true, ...(outcome.usage === undefined ? {} : { usage: outcome.usage }), ...(outcome.decision === undefined ? {} : { decision: outcome.decision }) });
        noteReviewRoute(sessionId, attempt, true);
        recordReview(attempt);
        for (const chunk of outcome.chunks) yield chunk;
        yield outcome.finish;
        return;
      }
      attempts.push({ ...base, ok: false, code: outcome.failure.code, detail: outcome.failure.detail.slice(0, 300) });
      noteReviewRoute(sessionId, attempt, false);
      failures.push(outcome.failure);
      if (!restartedFromTop && sticky !== undefined && key === sticky) {
        restartedFromTop = true;
        restart = true;
        candidates = plan;
        attempts.push({ event: 'sticky-failed-restart-from-top' });
        break;
      }
    }
    if (!restart) break;
  }
  recordReview();
  throw new ReviewerRoutesError(failures);
}

/**
 * Install the reviewer-model override.
 *
 * @param {HostContext} ctx - Cordis context with `on` and `llm`.
 * @param {ReviewerConfig} config - injected volatile settings.
 */
export function apply(ctx: HostContext, config: ReviewerConfig): void {
  // A rerouted review carries the original Session id. Exclude it explicitly so
  // the DeepSeek request cannot upload the conversation's canonical Session log.
  ctx.inject(['sessionLogDeepSeek'], (child) => {
    child.sessionLogDeepSeek.registerExclusion(request => request.purpose === 'auto-review');
  });

  /** Requests already rewritten by this listener, so re-entry is a no-op. */
  const patchedRequests = new WeakSet<object>();

  /** Exact-route reasoning capability cache; cleared on settings or adapter changes. */
  const effortCache = createCapabilityCache();

  ctx.on(
    'loader/volatile-update',
    () => {
      effortCache.clear();
    },
    { global: true },
  );

  ctx.on(
    'llm/adapters-updated',
    () => {
      effortCache.clear();
    },
    { global: true },
  );

  ctx.on(
    'llm/stream',
    (options: GenerateOptions, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> => {
      if (
        options === null ||
        typeof options !== 'object' ||
        patchedRequests.has(options) ||
        !isAutoReviewRequest(options)
      ) {
        return next();
      }
      // The deprecated `enabled` knob is ignored: this plugin is always active.
      const requestRoute = {
        provider: typeof options.provider === 'string' ? options.provider.trim() : '',
        model: typeof options.model === 'string' ? options.model.trim() : '',
      };
      const basePlan = buildReviewPlan(readRoutes(config), requestRoute);
      const hasSticky = options.sessionId !== undefined
        && options.sessionId !== ''
        && stickyReviewRoutes.has(options.sessionId);
      const plan = hasSticky ? preferStickyRoute(basePlan, options.sessionId) : pickWeightedStart(basePlan);
      // No usable explicit route: reviews already use the native session model,
      // so there is nothing to rewrite (the session route is implicit).
      if (plan.length === 0) return next();
      const only = plan[0];
      if (
        plan.length === 1
        && only.provider === requestRoute.provider
        && only.model === requestRoute.model
        && only.reasoningEffort === ''
      ) {
        // The only usable route is the request's own route (an explicit entry
        // equal to the session route, with the session attempt de-duplicated):
        // keep native plumbing instead of taking over a review that is not
        // rerouted at all.
        return next();
      }
      if (plan.length === 1) {
        return rewriteSingleRoute(ctx, options, only, patchedRequests, effortCache);
      }
      return streamReviewWithFallback(ctx, options, plan, patchedRequests, effortCache);
    },
    { global: true, prepend: true },
  );

  // Publish the saved-route test endpoint as the `autoReviewModel` Cordis service
  // this package's `./typert` manifest declares. The Typert Gateway dispatches
  // `autoReviewModel/testReviewRoute` to it; the endpoint reads the same volatile
  // settings as the listener and never writes them. `ctx.provide` is owned by this
  // plugin's fiber, so unmounting the plugin withdraws both the service and the
  // Typert registration (the Loader withdraws the latter with the entry).
  installRouteTestEndpoint(ctx, config);
}

/** Stable surface for host tests; not part of the plugin contract. */
export const __testing = {
  isAutoReviewRequest,
  readReviewerSettings,
  normalizeEffort,
  shouldOverrideRoute,
  effortCacheKey,
  effortRank,
  adaptEffortToAdvertised,
  INHERIT_EFFORT,
  CAPABILITY_TIMEOUT_MS,
  ReviewerCapabilityError,
  /** Fallback policy and streaming helpers exported by `./fallback.js` for Host tests. */
  fallback: fallbackTesting,
  ReviewerRoutesError,
  ReviewerRouteError,
  /** Saved-route probe helpers exported by `./route-test.js` for Host tests. */
  routeTest: routeTestTesting,
};
