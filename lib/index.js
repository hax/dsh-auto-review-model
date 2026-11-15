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
 * five-minute deadline, the review rejects immediately with an actionable error
 * that names the exact route and repair steps; the failed lookup is not cached
 * and the review never silently degrades to the provider's default effort.
 *
 * @module @aghost-prj/dsh-auto-review-model
 */
import z from '@deepseek-ai/schemastery';
import { effortCacheKey, isAutoReviewRequest, normalizeEffort, readReviewerSettings, shouldOverrideRoute, } from './policy.js';
/** Loader line id used by the host entry. */
export const name = 'auto-review-model';
/** Host services required before the listener may be installed. */
export const inject = ['llm', 'sessionLogDeepSeek'];
/**
 * Review-model settings. All fields are volatile so the settings UI can update
 * them in place; the listener always reads their current values per request.
 */
export const Config = z.object({
    enabled: z.boolean().default(true).volatile(),
    provider: z.string().default('').volatile(),
    model: z.string().default('').volatile(),
    reasoningEffort: z.string().default('').volatile(),
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
    const key = effortCacheKey(provider, model);
    const cached = cache.entries.get(key);
    if (cached !== undefined) {
        return cached.has(effort);
    }
    const startGen = cache.generation;
    const efforts = await resolveRouteEfforts(ctx, provider, model, signal);
    if (cache.generation === startGen) {
        cache.entries.set(key, efforts);
    }
    return efforts.has(effort);
}
/**
 * Copy one frozen reviewer request and rewrite its route once.
 *
 * The generator defers the capability lookup until iteration, which keeps the
 * `llm/stream` listener itself synchronous (the waterfall returns listener
 * results without awaiting them) while still allowing an async
 * `resolveModelInfo` call before the downstream stream starts.
 *
 * @param {HostContext} ctx - plugin context exposing `llm`.
 * @param {GenerateOptions} options - frozen original reviewer `GenerateOptions`.
 * @param {ReviewerSettings} settings - live settings.
 * @param {WeakSet<object>} patchedRequests - objects already rewritten.
 * @param {CapabilityCache} effortCache - capability cache.
 * @returns {AsyncGenerator<unknown>} the rewritten request's chunk stream.
 */
async function* rewriteAutoReviewStream(ctx, options, settings, patchedRequests, effortCache) {
    const patched = {
        ...options,
        provider: settings.provider,
        model: settings.model,
    };
    const effort = settings.reasoningEffort;
    if (effort !== '' &&
        (await isEffortSupported(ctx, effortCache, settings.provider, settings.model, effort, options.signal))) {
        patched.reasoningEffort = effort;
    }
    else {
        // No configured effort, or a successful lookup proved the route does not
        // advertise it: the provider default applies, so never forward a stale
        // caller effort. A failed or timed-out lookup throws above instead of
        // reaching this fallback, so a transient route problem never silently
        // degrades the review to a default reasoning effort.
        delete patched.reasoningEffort;
    }
    patchedRequests.add(patched);
    yield* ctx.llm.stream(patched);
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
        const settings = readReviewerSettings(config);
        if (!shouldOverrideRoute(settings))
            return next();
        return rewriteAutoReviewStream(ctx, options, settings, patchedRequests, effortCache);
    }, { global: true, prepend: true });
}
/** Stable surface for host tests; not part of the plugin contract. */
export const __testing = {
    isAutoReviewRequest,
    readReviewerSettings,
    normalizeEffort,
    shouldOverrideRoute,
    effortCacheKey,
    CAPABILITY_TIMEOUT_MS,
    ReviewerCapabilityError,
};
