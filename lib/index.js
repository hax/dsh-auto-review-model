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
import { zstdCompressSync } from 'node:zlib';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { INHERIT_EFFORT, adaptEffortToAdvertised, effortCacheKey, effortRank, isAutoReviewRequest, normalizeEffort, readReviewerSettings, shouldOverrideRoute, } from './policy.js';
import { installRouteTestEndpoint, __testing as routeTestTesting } from './route-test.js';
import { isRecord, readThrownFailure } from './failure.js';
export { ReviewerRouteError, ReviewerRoutesError } from './fallback.js';
import { PROTOCOL_FAILURE_CODE, ReviewerRouteError, ReviewerRoutesError, buildReviewPlan, pickWeightedStart, failureFromThrown, isAsyncIterable, isFallbackEligibleFailure, readRoutes, __testing as fallbackTesting, } from './fallback.js';
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
export const Config = z.object({
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
    /**
     * Unified ordered routes. Deliberately has no default: an absent value means a
     * config written before this list existed, which `readRoutes` migrates from the
     * legacy row-1 fields. A defaulted empty array would make every legacy config
     * look like "the user deleted all routes".
     */
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
const CAPABILITY_REPAIR_HINT = 'Check that the provider is configured with valid credentials, that the model is available and correctly routed for this account, and that the network can reach the provider; then update the Auto review model in Settings or retry.';
/**
 * Describe an unknown thrown value without ever throwing from the describer.
 *
 * The text lands in the Auto review failure reason the Agent receives, so it
 * must stay readable even when an adapter rejects with a non-Error value.
 *
 * @param {unknown} error - the caught rejection reason.
 * @returns {string} a non-empty diagnostic message.
 */
function errorText(error) {
    if (error instanceof Error && error.message !== '')
        return error.message;
    if (typeof error === 'string' && error !== '')
        return error;
    try {
        const text = String(error);
        if (text !== '' && text !== '[object Object]')
            return text;
    }
    catch {
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
    code;
    /** Configured provider id used in the failed lookup. */
    provider;
    /** Configured model id used in the failed lookup. */
    model;
    /** Exact `provider/model` route named in the message. */
    route;
    /** Capability lookup deadline in milliseconds. */
    timeoutMs;
    /** Whether the deadline expired rather than the lookup failing. */
    timedOut;
    /**
     * @param {string} provider - configured reviewer provider id.
     * @param {string} model - configured reviewer model id.
     * @param {boolean} timedOut - true when the deadline expired.
     * @param {unknown} [cause] - the underlying lookup failure, if any.
     */
    constructor(provider, model, timedOut, cause) {
        const route = `${provider}/${model}`;
        const detail = timedOut
            ? `timed out after ${CAPABILITY_TIMEOUT_MS}ms (5 min)`
            : `failed: ${errorText(cause)}. The capability query has a ${CAPABILITY_TIMEOUT_MS}ms (5 min) timeout`;
        super(`auto-review-model: capability lookup for reviewer route "${route}" ${detail}. ${CAPABILITY_REPAIR_HINT}`, cause === undefined ? undefined : { cause });
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
function rejectWhenAborted(signal) {
    let remove = () => { };
    const promise = new Promise((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        remove = () => signal.removeEventListener('abort', onAbort);
    });
    return { promise, dispose: () => remove() };
}
/** Construct an empty capability cache. */
function createCapabilityCache() {
    return {
        generation: 0,
        entries: new Map(),
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
async function resolveRouteEfforts(ctx, provider, model, signal) {
    // A pre-aborted request must not start a lookup (or a five-minute timer).
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(CAPABILITY_TIMEOUT_MS);
    const querySignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    const aborted = rejectWhenAborted(querySignal);
    let info;
    try {
        info = await Promise.race([
            ctx.llm.resolveModelInfo(provider, model, querySignal),
            aborted.promise,
        ]);
    }
    catch (cause) {
        // Caller cancellation wins over the deadline or an adapter-side failure:
        // the request was cancelled, so blame the route only when it was not.
        if (signal?.aborted)
            signal.throwIfAborted();
        throw new ReviewerCapabilityError(provider, model, deadline.aborted, cause);
    }
    finally {
        aborted.dispose();
    }
    // The lookup may resolve even though the request or deadline was aborted
    // between the race settling and this check; such a result is unusable.
    if (signal?.aborted)
        signal.throwIfAborted();
    if (deadline.aborted) {
        throw new ReviewerCapabilityError(provider, model, true, deadline.reason);
    }
    if (info === undefined) {
        throw new ReviewerCapabilityError(provider, model, false, new Error('the provider returned no model information for this route'));
    }
    const advertised = info.reasoning?.efforts;
    return new Set(Array.isArray(advertised)
        ? advertised
            .map((entry) => entry?.id)
            .filter((id) => id !== undefined)
        : []);
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
async function isEffortSupported(ctx, cache, provider, model, effort, signal) {
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
async function routeEfforts(ctx, cache, provider, model, signal) {
    const key = effortCacheKey(provider, model);
    const cached = cache.entries.get(key);
    if (cached !== undefined)
        return cached;
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
function readSessionEffort(ctx, options) {
    if (typeof options.sessionId !== 'string' || options.sessionId === '')
        return '';
    let header;
    try {
        header = ctx.sessions.get(options.sessionId)?.requestHeader?.();
    }
    catch {
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
async function buildRoutedRequest(ctx, options, provider, model, configEffort, effortCache) {
    const patched = { ...options, provider, model };
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
    }
    else if (configEffort !== ''
        && (await isEffortSupported(ctx, effortCache, provider, model, configEffort, options.signal))) {
        effortToSend = configEffort;
    }
    if (effortToSend !== '') {
        patched.reasoningEffort = effortToSend;
    }
    else {
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
async function* rewriteSingleRoute(ctx, options, attempt, patchedRequests, effortCache) {
    const patched = await buildRoutedRequest(ctx, options, attempt.provider, attempt.model, attempt.reasoningEffort, effortCache);
    patchedRequests.add(patched);
    const iterable = ctx.llm.stream(patched);
    if (!isAsyncIterable(iterable)) {
        throw new ReviewerRouteError(attempt.label, PROTOCOL_FAILURE_CODE, 'the provider returned no chunk stream');
    }
    const outcome = await collectAnswer(iterable[Symbol.asyncIterator](), options.signal);
    if ('failure' in outcome) {
        throw new ReviewerRouteError(attempt.label, outcome.failure.code === '' ? PROTOCOL_FAILURE_CODE : outcome.failure.code, outcome.failure.detail);
    }
    for (const chunk of outcome.answer.chunks)
        yield chunk;
    yield outcome.answer.finish;
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
function isUsableReviewAnswer(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return false;
    let value;
    try {
        value = JSON.parse(trimmed);
    }
    catch {
        return false;
    }
    if (!isRecord(value))
        return false;
    const record = value;
    const risk = record['risk'];
    const decision = record['decision'];
    return ((risk === 'low' || risk === 'medium' || risk === 'high') &&
        (decision === 'allow' || decision === 'deny'));
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
async function collectAnswer(iterator, signal) {
    const chunks = [];
    let text = '';
    let usage;
    try {
        for (;;) {
            signal?.throwIfAborted();
            let step;
            try {
                step = await iterator.next();
            }
            catch (error) {
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
                    usage = chunk.usage;
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
            const parsed = JSON.parse(text.trim());
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
    }
    finally {
        try {
            await iterator.return?.();
        }
        catch {
            // Cleanup must never mask the failure that abandoned the stream.
        }
    }
}
/**
 * Turn one thrown provider failure into a retryable route failure, or throw a
 * non-retryable {@link ReviewerRouteError}.
 *
 * An unclassified throw during streaming is treated as a transport-level route
 * failure: the route produced no decision, so trying the next configured route
 * is the whole point of the fallback list. A throw that *does* carry an official
 * provider-neutral code (or a valid HTTP status) is judged by the same
 * classification table as a terminal `finish`: only route / credential / quota /
 * rate-limit / transport failures move on, while content and protocol failures
 * are surfaced instead of being hidden behind another route.
 *
 * @param {ReviewRouteAttempt} attempt - the route that threw.
 * @param {unknown} error - the caught rejection.
 * @returns {ReviewerRouteFailure} a retryable failure record.
 * @throws {ReviewerRouteError} for a classified non-retryable failure.
 */
function routeFailureFromThrown(attempt, error) {
    const facts = readThrownFailure(error);
    const failure = failureFromThrown(attempt, error);
    if (facts.code === '' && facts.status === undefined) {
        // Unclassified thrown stream error: treat it as a route failure.
        return failure;
    }
    if (isFallbackEligibleFailure(facts))
        return failure;
    throw new ReviewerRouteError(attempt.label, failure.code === '' ? PROTOCOL_FAILURE_CODE : failure.code, failure.detail, error);
}
/**
 * Try each planned route in order and forward the winning route's chunks as
 * they arrive.
 *
 * The failover contract is a commit point: a route may only be replaced while
 * NO chunk has reached the caller. Every chunk is yielded immediately (no
 * capture), so a reasoning-heavy reviewer can stream as long as the provider
 * allows. Once a chunk has been
 * emitted, a later failure is surfaced as a {@link ReviewerRouteError} because
 * the caller's single-decision stream is already contaminated and switching
 * routes would duplicate or mix output. Failures before the first emitted chunk
 * — a failed capability lookup, a thrown stream, a retryable terminal finish,
 * or a premature end with no output — advance to the next route, and all of them
 * still produce one aggregate error when no route can answer.
 *
 * Caller aborts keep the same semantics (propagated, never retried), and every
 * abandoned provider stream gets a best-effort close.
 *
 * @param {HostContext} ctx - plugin context exposing `llm` and `sessions`.
 * @param {GenerateOptions} options - frozen original reviewer `GenerateOptions`.
 * @param {readonly ReviewRouteAttempt[]} plan - ordered attempts.
 * @param {WeakSet<object>} patchedRequests - objects already rewritten.
 * @param {CapabilityCache} effortCache - capability cache.
 * @returns {AsyncGenerator<unknown>} the winning route's live chunk stream.
 * @throws {ReviewerRouteError} when a failure happens after output was emitted.
 * @throws {ReviewerRoutesError} when every route fails before any output.
 */
/**
 * Append one review-route trace line.
 *
 * Review routing fails silently by design: a failing route is replaced before the
 * caller sees anything, so without a trace there is no way to tell a healthy
 * review from one that fell back. The file is small (one line per route attempt)
 * and writing it can never fail a review.
 */
/** Directory holding the captured review ledger. */
export const REVIEW_LEDGER_DIR = join(homedir(), '.dsh');
/**
 * ISO-8601 week of one date, used to rotate the ledger once per week.
 *
 * Weekly rotation keeps one file small enough to read and one week of reviews in
 * a single place, which is the granularity the cost study compares at.
 */
function isoWeekOf(date) {
    const shifted = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = shifted.getUTCDay() || 7;
    shifted.setUTCDate(shifted.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(shifted.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((shifted.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return { year: shifted.getUTCFullYear(), week };
}
/** Absolute ledger path for one moment, rotated by ISO week. */
export function reviewLedgerPath(now = new Date()) {
    const { year, week } = isoWeekOf(now);
    return join(REVIEW_LEDGER_DIR, `auto-review-ledger-${year}-W${String(week).padStart(2, '0')}.jsonl`);
}
/** Whether ledger capture is enabled (`DSH_AUTO_REVIEW_LEDGER=0` disables it). */
function ledgerEnabled() {
    return process.env['DSH_AUTO_REVIEW_LEDGER'] !== '0';
}
/** Week whose sealed predecessor has already been checked, to avoid restatting per write. */
let sealedWeek;
/**
 * Compress the previous ISO week's ledger once it is no longer being appended to.
 *
 * The current week stays a plain append-only `.jsonl` so it can be tailed while a
 * review is happening. Once a new week starts, the finished file is immutable, so
 * a single whole-file Zstandard frame is both cheaper and denser than the
 * concatenated frames the session backend needs for live appends.
 */
function sealPreviousWeek(now) {
    const current = isoWeekOf(now);
    const currentId = `${current.year}-W${String(current.week).padStart(2, '0')}`;
    if (sealedWeek === currentId)
        return;
    sealedWeek = currentId;
    try {
        const previous = new Date(now.getTime());
        previous.setUTCDate(previous.getUTCDate() - 7);
        const { year, week } = isoWeekOf(previous);
        const plain = join(REVIEW_LEDGER_DIR, `auto-review-ledger-${year}-W${String(week).padStart(2, '0')}.jsonl`);
        if (!existsSync(plain))
            return;
        const compressed = zstdCompressSync(readFileSync(plain));
        writeFileSync(`${plain}.zst`, compressed);
        rmSync(plain);
    }
    catch {
        // Sealing is housekeeping: a failure keeps the plain file for the next attempt.
    }
}
/** Append one review record to this week's ledger; failures are swallowed. */
function writeLedger(record) {
    if (!ledgerEnabled())
        return;
    try {
        const now = new Date();
        sealPreviousWeek(now);
        appendFileSync(reviewLedgerPath(now), `${JSON.stringify(record)}\n`);
    }
    catch {
        // Ledger capture must never affect a review.
    }
}
/**
 * Session-scoped sticky route: once a route answers a review, later reviews from
 * the same session go straight to it instead of retrying routes that already
 * failed. Review latency is the whole point of this plugin, so a session pays for
 * a failing route at most once.
 */
const stickyReviewRoutes = new Map();
/** Identity of one route inside the sticky table. */
function reviewRouteKey(attempt) {
    return `${attempt.provider}\u0000${attempt.model}\u0000${attempt.reasoningEffort}`;
}
/** Remember the route that answered, or forget it when that same route failed. */
function noteReviewRoute(sessionId, attempt, answered) {
    if (sessionId === undefined || sessionId === '')
        return;
    const key = reviewRouteKey(attempt);
    if (answered)
        stickyReviewRoutes.set(sessionId, key);
    else if (stickyReviewRoutes.get(sessionId) === key)
        stickyReviewRoutes.delete(sessionId);
}
/**
 * Move the session's sticky route to the front of one plan.
 *
 * The route keeps its position when it is already first or absent, so a session
 * without history still starts from the configured order.
 */
function preferStickyRoute(plan, sessionId) {
    if (sessionId === undefined || sessionId === '')
        return plan;
    const sticky = stickyReviewRoutes.get(sessionId);
    if (sticky === undefined)
        return plan;
    const index = plan.findIndex((attempt) => reviewRouteKey(attempt) === sticky);
    if (index <= 0)
        return plan;
    return [plan[index], ...plan.slice(0, index), ...plan.slice(index + 1)];
}
/**
 * Run one configured route far enough to know whether it can review.
 *
 * Nothing is forwarded here: the answer is buffered and validated, so a route
 * that cannot produce a decision is reported as a failure instead of being
 * committed to the caller.
 */
async function tryReviewRoute(ctx, options, attempt, patchedRequests, effortCache) {
    let patched;
    try {
        patched = await buildRoutedRequest(ctx, options, attempt.provider, attempt.model, attempt.reasoningEffort, effortCache);
    }
    catch (error) {
        options.signal?.throwIfAborted();
        if (!(error instanceof ReviewerCapabilityError))
            throw error;
        return { ok: false, failure: failureFromThrown(attempt, error) };
    }
    patchedRequests.add(patched);
    let iterable;
    try {
        iterable = ctx.llm.stream(patched);
    }
    catch (error) {
        options.signal?.throwIfAborted();
        return { ok: false, failure: routeFailureFromThrown(attempt, error) };
    }
    if (!isAsyncIterable(iterable)) {
        return {
            ok: false,
            failure: { attempt, code: PROTOCOL_FAILURE_CODE, detail: 'the provider returned no chunk stream' },
        };
    }
    let iterator;
    try {
        iterator = iterable[Symbol.asyncIterator]();
    }
    catch (error) {
        options.signal?.throwIfAborted();
        return { ok: false, failure: routeFailureFromThrown(attempt, error) };
    }
    const outcome = await collectAnswer(iterator, options.signal);
    if ('failure' in outcome) {
        options.signal?.throwIfAborted();
        return { ok: false, failure: { attempt, code: outcome.failure.code, detail: outcome.failure.detail } };
    }
    return {
        ok: true,
        chunks: outcome.answer.chunks,
        finish: outcome.answer.finish,
        ...(outcome.answer.usage === undefined ? {} : { usage: outcome.answer.usage }),
        ...(outcome.answer.decision === undefined ? {} : { decision: outcome.answer.decision }),
    };
}
/**
 * Try configured routes until one produces a usable risk/decision answer.
 *
 * Every failure advances to the next route, whatever its kind: a transport error,
 * a capability lookup miss, a stream that closed early, and an answer whose text
 * is not a risk/decision object all mean "this route could not review". The answer
 * is buffered before it is forwarded, so the caller never sees chunks from a route
 * that is about to be abandoned and never parses an unusable answer.
 *
 * A session that already answered through one route starts there. If that sticky
 * route fails, the whole configured order is retried from the top instead of
 * continuing at whatever follows it: a sticky route is a latency optimization, not
 * an ordering decision, so a broken one must not skip the routes before it.
 *
 * @param ctx - Cordis context with `llm`.
 * @param options - the frozen original reviewer request.
 * @param plan - ordered candidate routes.
 * @param patchedRequests - objects already rewritten, to keep the waterfall idempotent.
 * @param effortCache - capability cache.
 */
async function* streamReviewWithFallback(ctx, options, plan, patchedRequests, effortCache) {
    const failures = [];
    const sessionId = options.sessionId;
    const sticky = sessionId === undefined || sessionId === '' ? undefined : stickyReviewRoutes.get(sessionId);
    const tried = new Set();
    let candidates = preferStickyRoute(plan, sessionId);
    let restartedFromTop = false;
    const startedAt = Date.now();
    const attempts = [];
    /** Emit the measured record for this review exactly once, however it ends. */
    const recordReview = (winner, decision) => {
        writeLedger({
            v: 1,
            t: startedAt,
            local: new Date(startedAt).toISOString(),
            ...(sessionId === undefined || sessionId === '' ? {} : { sid: sessionId }),
            totalMs: Date.now() - startedAt,
            fallback: attempts.length > 1,
            ...(sticky === undefined ? {} : { stickyUsed: sticky }),
            ...(decision === undefined ? {} : { decision }),
            attempts,
            ...(winner === undefined ? {} : { winner: `${winner.provider}/${winner.model}` }),
        });
    };
    for (;;) {
        let restart = false;
        for (const attempt of candidates) {
            const key = reviewRouteKey(attempt);
            if (tried.has(key))
                continue;
            tried.add(key);
            const attemptStarted = Date.now();
            const outcome = await tryReviewRoute(ctx, options, attempt, patchedRequests, effortCache);
            const attemptMs = Date.now() - attemptStarted;
            const base = {
                route: `${attempt.provider}/${attempt.model}`,
                effort: attempt.reasoningEffort,
                mode: attempt.mode,
                ms: attemptMs,
            };
            if (outcome.ok) {
                attempts.push({
                    ...base,
                    ok: true,
                    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
                    ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
                });
                noteReviewRoute(sessionId, attempt, true);
                recordReview(attempt, outcome.decision);
                for (const chunk of outcome.chunks)
                    yield chunk;
                yield outcome.finish;
                return;
            }
            attempts.push({
                ...base,
                ok: false,
                code: outcome.failure.code,
                detail: outcome.failure.detail.slice(0, 300),
            });
            noteReviewRoute(sessionId, attempt, false);
            failures.push(outcome.failure);
            // The sticky route broke: drop it and retry the configured order from the
            // top, so a route that sits before it is not skipped.
            if (!restartedFromTop && sticky !== undefined && key === sticky) {
                restartedFromTop = true;
                restart = true;
                candidates = plan;
                attempts.push({ event: 'sticky-failed-restart-from-top' });
                break;
            }
        }
        if (!restart)
            break;
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
export function apply(ctx, config) {
    // A rerouted review carries the original Session id. Exclude it explicitly so
    // the DeepSeek request cannot upload the conversation's canonical Session log.
    ctx.inject(['sessionLogDeepSeek'], (child) => {
        child.sessionLogDeepSeek.registerExclusion(request => request.purpose === 'auto-review');
    });
    /** Requests already rewritten by this listener, so re-entry is a no-op. */
    const patchedRequests = new WeakSet();
    /** Exact-route reasoning capability cache; cleared on settings or adapter changes. */
    const effortCache = createCapabilityCache();
    ctx.on('loader/volatile-update', () => {
        effortCache.clear();
    }, { global: true });
    ctx.on('llm/adapters-updated', () => {
        effortCache.clear();
    }, { global: true });
    ctx.on('llm/stream', (options, next) => {
        if (options === null ||
            typeof options !== 'object' ||
            patchedRequests.has(options) ||
            !isAutoReviewRequest(options)) {
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
        const plan = hasSticky
            ? preferStickyRoute(basePlan, options.sessionId)
            : pickWeightedStart(basePlan);
        // No usable explicit route: reviews already use the native session model,
        // so there is nothing to rewrite (the session route is implicit).
        if (plan.length === 0)
            return next();
        const only = plan[0];
        if (plan.length === 1
            && only.provider === requestRoute.provider
            && only.model === requestRoute.model
            && only.reasoningEffort === '') {
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
    }, { global: true, prepend: true });
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
