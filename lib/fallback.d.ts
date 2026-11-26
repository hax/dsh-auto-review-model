import type { FailureFacts } from './failure.js';
import type { ReviewerConfig } from './policy.js';
/** Largest number of configurable fallback entries a Host will schedule. */
export declare const MAX_FALLBACK_ENTRIES = 10;
/** Stable `name` of the aggregate all-routes-failed error. */
export declare const ROUTES_ERROR_NAME = "AutoReviewModelRoutesError";
/** Stable `code` of the aggregate all-routes-failed error. */
export declare const ROUTES_ERROR_CODE = "AUTO_REVIEW_MODEL_ALL_ROUTES_FAILED";
/** Stable `name` of one non-retryable attempt failure. */
export declare const ROUTE_ERROR_NAME = "AutoReviewModelRouteError";
/** Stable `code` of one non-retryable attempt failure. */
export declare const ROUTE_ERROR_CODE = "AUTO_REVIEW_MODEL_ROUTE_FAILED";
/** Error code: one attempt's finish reported an unclassified protocol failure. */
export declare const PROTOCOL_FAILURE_CODE = "AUTO_REVIEW_MODEL_PROTOCOL_FAILURE";
/** How one attempt obtains its route: an explicit config route or the implicit session route. */
export type RouteMode = 'route' | 'session';
/** One normalized explicit fallback entry (an ordered reviewer route). */
export interface FallbackEntry {
    /** Whether this row is eligible; disabled rows are skipped, never deleted. */
    enabled: boolean;
    /** Relative share for weighted new-session starts. */
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
    /** Configured weight, zero for implicit session attempts. */
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
export declare function readRoutes(config: ReviewerConfig | undefined): FallbackEntry[];
/** Build the short diagnostic label of one attempt. */
export declare function routeAttemptLabel(provider: string, model: string, mode: RouteMode): string;
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
/** Draw a weighted start for one fresh session, leaving zero weights last. */
export declare function pickWeightedStart(plan: readonly ReviewRouteAttempt[], random?: () => number): ReviewRouteAttempt[];
export declare function buildReviewPlan(routes: readonly FallbackEntry[], request: {
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
 * Content/protocol problems, adapter-side aborts, and a failure after the
 * route already emitted output belong to that route: another route would hide
 * the problem, duplicate output, or fail the same way, so the review fails
 * closed with this actionable error.
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
/** Whether a value is an async iterable the Host can consume. */
export declare function isAsyncIterable(value: unknown): value is AsyncIterable<unknown>;
/** Stable surface for host tests; not part of the plugin contract. */
export declare const __testing: {
    MAX_FALLBACK_ENTRIES: number;
    ROUTES_ERROR_NAME: string;
    ROUTES_ERROR_CODE: string;
    ROUTE_ERROR_NAME: string;
    ROUTE_ERROR_CODE: string;
    PROTOCOL_FAILURE_CODE: string;
    normalizeFallbackEntry: typeof normalizeFallbackEntry;
    isLegacySessionEntry: typeof isLegacySessionEntry;
    readFallbackEntries: typeof readFallbackEntries;
    readRoutes: typeof readRoutes;
    buildReviewPlan: typeof buildReviewPlan;
    pickWeightedStart: typeof pickWeightedStart;
    isFallbackEligibleFailure: typeof isFallbackEligibleFailure;
    failureFromThrown: typeof failureFromThrown;
    failureFromFinish: typeof failureFromFinish;
    isAsyncIterable: typeof isAsyncIterable;
    ReviewerRoutesError: typeof ReviewerRoutesError;
    ReviewerRouteError: typeof ReviewerRouteError;
};
