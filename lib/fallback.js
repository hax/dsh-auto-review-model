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
 *   `ReviewerRouteError` thrown back to Auto review;
 * - the bounded content measurement and stream-closing helper used by the
 *   Host's all-or-nothing attempt buffering.
 *
 * The Host entry (`./index.ts`) performs the actual streaming; it buffers one
 * attempt until its terminal `finish` proves success, so a failed attempt can
 * never leak reasoning or partial text into the caller's single-decision
 * stream.
 *
 * @module @aghost-prj/dsh-auto-review-model/fallback
 */
import { httpStatusOf, isRecord, normalizeFailureCode, readFinishFailureMessage, readFinishFailure, readThrownFailure, } from './failure.js';
import { normalizeEffort } from './policy.js';
/** Largest number of configurable fallback entries a Host will schedule. */
export const MAX_FALLBACK_ENTRIES = 10;
/**
 * Largest number of stream chunks one BUFFERED attempt may hold before the
 * attempt is abandoned.
 *
 * This ceiling is deliberately non-binding in practice: a provider stream is
 * already bounded by the model's max output tokens, and adapters emit roughly
 * one chunk per token, so a legitimate reasoning-heavy stream cannot approach
 * 131 072 chunks. It exists only to stop a pathological unbounded stream from
 * exhausting memory. Exceeding it is a ROUTE failure: the buffered chunks are
 * discarded and the next route (and finally the session route) is tried.
 *
 * The `pass-through` capture mode does not buffer and therefore has no ceiling.
 */
export const FALLBACK_MAX_BUFFER_CHUNKS = 131_072;
/**
 * Largest number of model-content characters one BUFFERED attempt may hold.
 *
 * 8 000 000 characters (roughly 8 MB of model text) is far above any legitimate
 * reviewer reply, including long reasoning chains. ATTEMPTS ARE SEQUENTIAL, so
 * at most one attempt's backlog is alive at a time: the memory bound is roughly
 * `FALLBACK_MAX_BUFFER_CHARS` characters plus one JS array slot per buffered
 * chunk (at most `FALLBACK_MAX_BUFFER_CHUNKS`). Exceeding it abandons the
 * attempt, discards its buffer, and advances to the next route exactly like a
 * quota/transport failure.
 */
export const FALLBACK_MAX_BUFFER_CHARS = 8_000_000;
/** Bound on closing an abandoned attempt's provider stream. */
export const FALLBACK_CLOSE_GRACE_MS = 250;
/** Stable `name` of the aggregate all-routes-failed error. */
export const ROUTES_ERROR_NAME = 'AutoReviewModelRoutesError';
/** Stable `code` of the aggregate all-routes-failed error. */
export const ROUTES_ERROR_CODE = 'AUTO_REVIEW_MODEL_ALL_ROUTES_FAILED';
/** Stable `name` of one non-retryable attempt failure. */
export const ROUTE_ERROR_NAME = 'AutoReviewModelRouteError';
/** Stable `code` of one non-retryable attempt failure. */
export const ROUTE_ERROR_CODE = 'AUTO_REVIEW_MODEL_ROUTE_FAILED';
/** Error code: one attempt exceeded the bounded attempt buffer (a retryable route failure). */
export const BUFFER_LIMIT_CODE = 'AUTO_REVIEW_MODEL_BUFFER_LIMIT';
/** Error code: one attempt's finish reported an unclassified protocol failure. */
export const PROTOCOL_FAILURE_CODE = 'AUTO_REVIEW_MODEL_PROTOCOL_FAILURE';
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
const FALLBACK_FAILURE_CODES = new Set([
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
const FALLBACK_HTTP_STATUSES = new Set([401, 402, 403, 404, 408, 429]);
/** Read one config entry that may be a volatile ref or a plain value. */
function readConfigValue(entry) {
    if (entry !== null && typeof entry === 'object' && typeof entry.get === 'function') {
        return entry.get();
    }
    return entry;
}
/** Coerce one configured string, trimming it. */
function configText(value) {
    if (value === undefined || value === null)
        return '';
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
export function isLegacySessionEntry(raw) {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
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
export function normalizeFallbackEntry(raw) {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
        : {};
    return {
        enabled: readConfigValue(source.enabled) !== false,
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
export function readFallbackEntries(config) {
    const raw = readConfigValue((config ?? {}).fallbacks);
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter(entry => !isLegacySessionEntry(entry))
        .slice(0, MAX_FALLBACK_ENTRIES)
        .map(entry => normalizeFallbackEntry(entry));
}
/** Build the short diagnostic label of one attempt. */
export function routeAttemptLabel(provider, model, mode) {
    const route = `${provider}/${model}`;
    return mode === 'session' ? `${route} (session)` : route;
}
/**
 * Build the deterministic attempt order for one intercepted review request.
 *
 * The complete primary route comes first (row 1 of the settings list), then
 * every enabled explicit fallback entry in array order. A disabled row
 * (`primaryEnabled: false` or `enabled: false`) is skipped exactly like an
 * incomplete one. The intercepted request's own provider/model is then appended
 * as the implicit final fallback — the route the pending review was issued for,
 * never the plugin's idea of "the current session model" — and it never
 * overrides the reasoning effort. It is omitted when the request has no usable
 * route and when an explicit attempt already uses the same provider/model, so
 * the same route is never tried twice in a row.
 *
 * An empty result means "do not take the review over at all": with no usable
 * enabled route the native session model already is the review route.
 *
 * @param settings - live primary settings (settings-list row 1).
 * @param fallbacks - normalized explicit fallback entries in order.
 * @param request - provider/model of the intercepted review request.
 * @returns the ordered attempts; empty when nothing may be routed.
 */
export function buildReviewPlan(settings, fallbacks, request) {
    const plan = [];
    if (settings.primaryEnabled !== false && settings.provider !== '' && settings.model !== '') {
        plan.push({
            source: 'primary',
            mode: 'route',
            index: -1,
            provider: settings.provider,
            model: settings.model,
            reasoningEffort: settings.reasoningEffort,
            label: routeAttemptLabel(settings.provider, settings.model, 'route'),
        });
    }
    fallbacks.forEach((entry, index) => {
        if (entry.enabled === false)
            return;
        if (entry.provider === '' || entry.model === '')
            return;
        plan.push({
            source: 'fallback',
            mode: 'route',
            index,
            provider: entry.provider,
            model: entry.model,
            reasoningEffort: entry.reasoningEffort,
            label: routeAttemptLabel(entry.provider, entry.model, 'route'),
        });
    });
    if (plan.length > 0
        && request.provider !== ''
        && request.model !== ''
        && !plan.some(attempt => attempt.provider === request.provider && attempt.model === request.model)) {
        plan.push({
            source: 'fallback',
            mode: 'session',
            index: -1,
            provider: request.provider,
            model: request.model,
            reasoningEffort: '',
            label: routeAttemptLabel(request.provider, request.model, 'session'),
        });
    }
    return plan;
}
/** Whether one HTTP status identifies a route-level problem. */
function isFallbackEligibleStatus(status) {
    if (status === undefined)
        return false;
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
export function isFallbackEligibleFailure(facts) {
    if (facts === undefined)
        return false;
    const code = normalizeFailureCode(facts.code);
    if (code !== '') {
        if (FALLBACK_FAILURE_CODES.has(code))
            return true;
        // An `HTTP_<status>` code names the status itself, never a protocol error.
        if (/^HTTP_\d{3}$/.test(code))
            return isFallbackEligibleStatus(httpStatusOf(code, facts.status));
        return false;
    }
    return isFallbackEligibleStatus(facts.status);
}
/** Read the raw provider message from a thrown value, verbatim. */
function errorText(error) {
    if (error instanceof Error && error.message !== '')
        return error.message;
    if (typeof error === 'string' && error !== '')
        return error;
    if (isRecord(error)) {
        if (typeof error.message === 'string' && error.message !== '')
            return error.message;
        if (isRecord(error.failure) && typeof error.failure.message === 'string') {
            return error.failure.message;
        }
    }
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
/** Read the raw failure code carried by a thrown value, without classification. */
function rawFailureCode(value) {
    if (!isRecord(value))
        return '';
    const failure = isRecord(value.failure) ? value.failure : undefined;
    const raw = typeof value.code === 'string'
        ? value.code
        : failure !== undefined && typeof failure.code === 'string'
            ? failure.code
            : '';
    return raw.trim();
}
/** Display code for one failure: classified code, then raw code, then HTTP status. */
function displayFailureCode(failure) {
    if (failure.code !== '')
        return failure.code;
    if (failure.rawCode !== undefined && failure.rawCode !== '')
        return failure.rawCode;
    if (failure.status !== undefined)
        return `HTTP_${failure.status}`;
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
export function failureFromThrown(attempt, error) {
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
export function failureFromFinish(attempt, reason) {
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
    code = ROUTES_ERROR_CODE;
    /** Per-route failures in attempt order. */
    failures;
    /** Attempted route labels in order. */
    routes;
    /**
     * @param failures - one record per attempted route, in order.
     */
    constructor(failures) {
        const details = failures
            .map((failure) => {
            const code = displayFailureCode(failure);
            return failure.detail === ''
                ? `${failure.attempt.label}: ${code}`
                : `${failure.attempt.label}: ${code}: ${failure.detail}`;
        })
            .join('; ');
        const count = failures.length;
        super(`auto-review-model: auto review failed on all ${count} reviewer route${count === 1 ? '' : 's'}: ${details}. `
            + 'The tool call was not executed. Check the Auto review model fallback list, provider credentials and network in Settings, then retry.', {
            cause: failures
                .map(failure => failure.cause)
                .filter((cause) => cause !== undefined),
        });
        this.name = ROUTES_ERROR_NAME;
        this.failures = [...failures];
        this.routes = failures.map(failure => failure.attempt.label);
    }
}
/**
 * Throwable raised when one route failed in a way that must not be retried.
 *
 * Content/protocol problems, adapter-side aborts, and attempt-buffer overflows
 * belong to the route that produced them: another route would hide the problem
 * or fail the same way, so the review fails closed with this actionable error.
 */
export class ReviewerRouteError extends Error {
    /** Stable diagnostic code. */
    code = ROUTE_ERROR_CODE;
    /** Provider-neutral failure code or one of this module's local codes. */
    failureCode;
    /** Exact `provider/model` route that failed. */
    route;
    /**
     * @param route - the failing route label.
     * @param failureCode - provider-neutral or local failure code.
     * @param detail - raw provider message, verbatim.
     * @param cause - optional underlying error.
     */
    constructor(route, failureCode, detail, cause) {
        const suffix = detail === '' ? '' : `: ${detail}`;
        super(`auto-review-model: reviewer route "${route}" failed with ${failureCode}${suffix}. `
            + 'The review was not completed and the tool call was not executed.', cause === undefined ? undefined : { cause });
        this.name = ROUTE_ERROR_NAME;
        this.failureCode = failureCode;
        this.route = route;
    }
}
/** Maximum number of nodes one bounded chunk measurement walks. */
const MAX_MEASURE_NODES = 256;
/**
 * Measure one stream chunk's model content without retaining or serializing it.
 *
 * Stream content can arrive as delta text, assembled blocks, tool arguments, or
 * future merge-extensible chunk types, so the walker counts string lengths
 * across a node-bounded walk and stops as soon as {@link FALLBACK_MAX_BUFFER_CHARS}
 * is exceeded. The cap is reported as `limit + 1`, which is all the caller needs
 * to refuse the attempt.
 *
 * @param value - one stream chunk.
 * @returns measured characters, clamped to `FALLBACK_MAX_BUFFER_CHARS + 1`.
 */
export function measureChunkContent(value) {
    const limit = FALLBACK_MAX_BUFFER_CHARS;
    const seen = { chars: 0, nodes: 0, exceeded: false };
    const visit = (current) => {
        if (seen.exceeded)
            return;
        seen.nodes += 1;
        if (seen.nodes > MAX_MEASURE_NODES) {
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
                if (current === null)
                    break;
                if (Array.isArray(current)) {
                    for (const item of current) {
                        visit(item);
                        if (seen.exceeded)
                            return;
                    }
                    break;
                }
                const record = current;
                for (const key in record) {
                    if (!Object.hasOwn(record, key))
                        continue;
                    seen.chars += key.length;
                    if (seen.chars > limit) {
                        seen.exceeded = true;
                        return;
                    }
                    try {
                        visit(record[key]);
                    }
                    catch {
                        // A hostile getter/proxy is unknown content: refuse rather than read it.
                        seen.exceeded = true;
                        return;
                    }
                    if (seen.exceeded)
                        return;
                }
                break;
            }
            default:
                // Functions, symbols, and bigints are not JSON model content.
                break;
        }
        if (seen.chars > limit)
            seen.exceeded = true;
    };
    visit(value);
    return Math.min(seen.chars, limit + 1);
}
/** Whether a value is an async iterable the Host can consume. */
export function isAsyncIterable(value) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
        return false;
    const iterator = value[Symbol.asyncIterator];
    return typeof iterator === 'function';
}
/**
 * Close one abandoned attempt's provider iterator under a small grace bound.
 *
 * A failed attempt may still hold a live provider request. Closing it is
 * cleanup, so every error is swallowed; a degraded adapter that never settles
 * `return()` must not hold the review open, hence the grace race. The returned
 * promise never rejects.
 *
 * @param iterator - the attempt's stream iterator.
 */
export async function closeReviewStream(iterator) {
    const close = iterator.return;
    if (typeof close !== 'function')
        return;
    let timer;
    try {
        await Promise.race([
            Promise.resolve()
                .then(() => close.call(iterator))
                .then(() => { }, () => { }),
            new Promise((resolve) => {
                timer = setTimeout(resolve, FALLBACK_CLOSE_GRACE_MS);
                timer.unref?.();
            }),
        ]);
    }
    catch {
        // Cleanup must never mask the failure that made the attempt abandoned.
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/** Stable surface for host tests; not part of the plugin contract. */
export const __testing = {
    MAX_FALLBACK_ENTRIES,
    FALLBACK_MAX_BUFFER_CHUNKS,
    FALLBACK_MAX_BUFFER_CHARS,
    FALLBACK_CLOSE_GRACE_MS,
    ROUTES_ERROR_NAME,
    ROUTES_ERROR_CODE,
    ROUTE_ERROR_NAME,
    ROUTE_ERROR_CODE,
    BUFFER_LIMIT_CODE,
    PROTOCOL_FAILURE_CODE,
    normalizeFallbackEntry,
    isLegacySessionEntry,
    readFallbackEntries,
    buildReviewPlan,
    isFallbackEligibleFailure,
    failureFromThrown,
    failureFromFinish,
    measureChunkContent,
    isAsyncIterable,
    closeReviewStream,
    ReviewerRoutesError,
    ReviewerRouteError,
};
