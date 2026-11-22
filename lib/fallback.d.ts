import type { FailureFacts } from './failure.js';
import type { ReviewerConfig, ReviewerSettings } from './policy.js';
/** Largest number of configurable fallback entries a Host will schedule. */
export declare const MAX_FALLBACK_ENTRIES = 10;
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
export declare const FALLBACK_MAX_BUFFER_CHUNKS = 131072;
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
export declare const FALLBACK_MAX_BUFFER_CHARS = 8000000;
/** Bound on closing an abandoned attempt's provider stream. */
export declare const FALLBACK_CLOSE_GRACE_MS = 250;
/** Stable `name` of the aggregate all-routes-failed error. */
export declare const ROUTES_ERROR_NAME = "AutoReviewModelRoutesError";
/** Stable `code` of the aggregate all-routes-failed error. */
export declare const ROUTES_ERROR_CODE = "AUTO_REVIEW_MODEL_ALL_ROUTES_FAILED";
/** Stable `name` of one non-retryable attempt failure. */
export declare const ROUTE_ERROR_NAME = "AutoReviewModelRouteError";
/** Stable `code` of one non-retryable attempt failure. */
export declare const ROUTE_ERROR_CODE = "AUTO_REVIEW_MODEL_ROUTE_FAILED";
/** Error code: one attempt exceeded the bounded attempt buffer (a retryable route failure). */
export declare const BUFFER_LIMIT_CODE = "AUTO_REVIEW_MODEL_BUFFER_LIMIT";
/** Error code: one attempt's finish reported an unclassified protocol failure. */
export declare const PROTOCOL_FAILURE_CODE = "AUTO_REVIEW_MODEL_PROTOCOL_FAILURE";
/** How one attempt obtains its route: an explicit config route or the implicit session route. */
export type RouteMode = 'route' | 'session';
/** One normalized explicit fallback entry (an ordered reviewer route). */
export interface FallbackEntry {
    /** Whether this row is eligible; disabled rows are skipped, never deleted. */
    enabled: boolean;
    /** Configured provider id. */
    provider: string;
    /** Configured model id. */
    model: string;
    /** Configured reasoning effort; `''` for the provider default, `inherit` for the session effort. */
    reasoningEffort: string;
}
/** One concrete route the Host will try, in order. */
export interface ReviewRouteAttempt {
    /** Where the route came from. */
    source: 'primary' | 'fallback';
    /** How the route was resolved. */
    mode: RouteMode;
    /** Index in the fallback array, or `-1` for the primary and implicit session routes. */
    index: number;
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
export declare function isLegacySessionEntry(raw: unknown): boolean;
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
export declare function normalizeFallbackEntry(raw: unknown): FallbackEntry;
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
export declare function readFallbackEntries(config: ReviewerConfig | undefined): FallbackEntry[];
/** Build the short diagnostic label of one attempt. */
export declare function routeAttemptLabel(provider: string, model: string, mode: RouteMode): string;
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
export declare function buildReviewPlan(settings: Pick<ReviewerSettings, 'provider' | 'model' | 'reasoningEffort'> & {
    primaryEnabled?: boolean;
}, fallbacks: readonly FallbackEntry[], request: {
    provider: string;
    model: string;
}): ReviewRouteAttempt[];
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
export declare function isFallbackEligibleFailure(facts: FailureFacts | undefined): boolean;
/**
 * Build the failure record for one attempt that threw before producing a
 * decision (a synchronous `ctx.llm.stream` throw, an iterator rejection, or a
 * capability lookup failure).
 *
 * @param attempt - the route that failed.
 * @param error - the caught value.
 * @returns the failure record with the raw provider message and cause preserved.
 */
export declare function failureFromThrown(attempt: ReviewRouteAttempt, error: unknown): ReviewerRouteFailure;
/**
 * Build the failure record for one attempt whose terminal `finish` reported an
 * error.
 *
 * @param attempt - the route that failed.
 * @param reason - the terminal `finish` reason.
 * @returns the failure record; `cause` is absent because the wire carries facts, not an Error.
 */
export declare function failureFromFinish(attempt: ReviewRouteAttempt, reason: unknown): ReviewerRouteFailure;
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
export declare class ReviewerRoutesError extends Error {
    /** Stable diagnostic code. */
    readonly code = "AUTO_REVIEW_MODEL_ALL_ROUTES_FAILED";
    /** Per-route failures in attempt order. */
    readonly failures: readonly ReviewerRouteFailure[];
    /** Attempted route labels in order. */
    readonly routes: readonly string[];
    /**
     * @param failures - one record per attempted route, in order.
     */
    constructor(failures: readonly ReviewerRouteFailure[]);
}
/**
 * Throwable raised when one route failed in a way that must not be retried.
 *
 * Content/protocol problems, adapter-side aborts, and attempt-buffer overflows
 * belong to the route that produced them: another route would hide the problem
 * or fail the same way, so the review fails closed with this actionable error.
 */
export declare class ReviewerRouteError extends Error {
    /** Stable diagnostic code. */
    readonly code = "AUTO_REVIEW_MODEL_ROUTE_FAILED";
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
    constructor(route: string, failureCode: string, detail: string, cause?: unknown);
}
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
export declare function measureChunkContent(value: unknown): number;
/** Whether a value is an async iterable the Host can consume. */
export declare function isAsyncIterable(value: unknown): value is AsyncIterable<unknown>;
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
export declare function closeReviewStream(iterator: AsyncIterator<unknown>): Promise<void>;
/** Stable surface for host tests; not part of the plugin contract. */
export declare const __testing: {
    MAX_FALLBACK_ENTRIES: number;
    FALLBACK_MAX_BUFFER_CHUNKS: number;
    FALLBACK_MAX_BUFFER_CHARS: number;
    FALLBACK_CLOSE_GRACE_MS: number;
    ROUTES_ERROR_NAME: string;
    ROUTES_ERROR_CODE: string;
    ROUTE_ERROR_NAME: string;
    ROUTE_ERROR_CODE: string;
    BUFFER_LIMIT_CODE: string;
    PROTOCOL_FAILURE_CODE: string;
    normalizeFallbackEntry: typeof normalizeFallbackEntry;
    isLegacySessionEntry: typeof isLegacySessionEntry;
    readFallbackEntries: typeof readFallbackEntries;
    buildReviewPlan: typeof buildReviewPlan;
    isFallbackEligibleFailure: typeof isFallbackEligibleFailure;
    failureFromThrown: typeof failureFromThrown;
    failureFromFinish: typeof failureFromFinish;
    measureChunkContent: typeof measureChunkContent;
    isAsyncIterable: typeof isAsyncIterable;
    closeReviewStream: typeof closeReviewStream;
    ReviewerRoutesError: typeof ReviewerRoutesError;
    ReviewerRouteError: typeof ReviewerRouteError;
};
