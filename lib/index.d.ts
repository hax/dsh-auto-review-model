import z from '@deepseek-ai/schemastery';
import { adaptEffortToAdvertised, effortCacheKey, effortRank, isAutoReviewRequest, normalizeEffort, readReviewerSettings, shouldOverrideRoute } from './policy.js';
import type { ReviewerConfig } from './policy.js';
import { installRouteTestEndpoint } from './route-test.js';
import { readThrownFailure } from './failure.js';
export { ReviewerRouteError, ReviewerRoutesError } from './fallback.js';
import { ReviewerRouteError, ReviewerRoutesError, buildReviewPlan, pickWeightedStart, failureFromFinish, failureFromThrown, isAsyncIterable, isFallbackEligibleFailure, readRoutes } from './fallback.js';
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
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmModelInfo | undefined>;
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
    registerExclusion(exclude: (request: {
        purpose?: string;
    }) => boolean): unknown;
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
    on(event: string, listener: (...args: any[]) => any, options?: ListenerOptions): unknown;
    inject(services: readonly string[], callback: (child: {
        sessionLogDeepSeek: SessionLogDeepSeek;
    }) => void): unknown;
    /**
     * Publish one Cordis service for this plugin's lifetime (used to expose the
     * saved-route test endpoint object the Typert Gateway dispatches to).
     */
    provide(name: string, value: unknown): unknown;
}
/** Loader line id used by the host entry. */
export declare const name = "auto-review-model";
/** Host services required before the listener may be installed. */
export declare const inject: string[];
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
export declare const Config: z;
/**
 * Failure raised when the configured reviewer route cannot prove its reasoning
 * capabilities.
 *
 * The message names the exact route, the five-minute deadline, and concrete
 * repair steps so the Auto review failure reason stays actionable instead of a
 * bare "review failed". The original lookup error is preserved as `cause`.
 */
export declare class ReviewerCapabilityError extends Error {
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
    constructor(provider: string, model: string, timedOut: boolean, cause?: unknown);
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
export declare const REVIEW_LEDGER_DIR: string;
/** Absolute ledger path for one moment, rotated by ISO week. */
export declare function reviewLedgerPath(now?: Date): string;
/**
 * Install the reviewer-model override.
 *
 * @param {HostContext} ctx - Cordis context with `on` and `llm`.
 * @param {ReviewerConfig} config - injected volatile settings.
 */
export declare function apply(ctx: HostContext, config: ReviewerConfig): void;
/** Stable surface for host tests; not part of the plugin contract. */
export declare const __testing: {
    isAutoReviewRequest: typeof isAutoReviewRequest;
    readReviewerSettings: typeof readReviewerSettings;
    normalizeEffort: typeof normalizeEffort;
    shouldOverrideRoute: typeof shouldOverrideRoute;
    effortCacheKey: typeof effortCacheKey;
    effortRank: typeof effortRank;
    adaptEffortToAdvertised: typeof adaptEffortToAdvertised;
    INHERIT_EFFORT: string;
    CAPABILITY_TIMEOUT_MS: number;
    ReviewerCapabilityError: typeof ReviewerCapabilityError;
    /** Fallback policy and streaming helpers exported by `./fallback.js` for Host tests. */
    fallback: {
        MAX_FALLBACK_ENTRIES: number;
        ROUTES_ERROR_NAME: string;
        ROUTES_ERROR_CODE: string;
        ROUTE_ERROR_NAME: string;
        ROUTE_ERROR_CODE: string;
        PROTOCOL_FAILURE_CODE: string;
        normalizeFallbackEntry: typeof import("./fallback.js").normalizeFallbackEntry;
        normalizeWeight: (value: unknown) => number;
        isLegacySessionEntry: typeof import("./fallback.js").isLegacySessionEntry;
        readFallbackEntries: typeof import("./fallback.js").readFallbackEntries;
        readRoutes: typeof readRoutes;
        pickWeightedStart: typeof pickWeightedStart;
        buildReviewPlan: typeof buildReviewPlan;
        isFallbackEligibleFailure: typeof isFallbackEligibleFailure;
        failureFromThrown: typeof failureFromThrown;
        failureFromFinish: typeof failureFromFinish;
        isAsyncIterable: typeof isAsyncIterable;
        ReviewerRoutesError: typeof ReviewerRoutesError;
        ReviewerRouteError: typeof ReviewerRouteError;
    };
    ReviewerRoutesError: typeof ReviewerRoutesError;
    ReviewerRouteError: typeof ReviewerRouteError;
    /** Saved-route probe helpers exported by `./route-test.js` for Host tests. */
    routeTest: {
        ROUTE_TEST_TIMEOUT_MS: number;
        ROUTE_TEST_MIN_INTERVAL_MS: number;
        ROUTE_TEST_WINDOW_MS: number;
        ROUTE_TEST_MAX_PER_WINDOW: number;
        ROUTE_TEST_MAX_TOKENS: number;
        ROUTE_TEST_TEMPERATURE: number;
        ROUTE_TEST_MAX_OUTPUT_CHARS: number;
        ROUTE_TEST_MAX_OUTPUT_CHUNKS: number;
        ROUTE_TEST_CLOSE_GRACE_MS: number;
        ROUTE_TEST_SYSTEM_PROMPT: string;
        ROUTE_TEST_USER_PROMPT: string;
        ROUTE_TEST_DETAILS: Readonly<Record<"OK" | "ROUTE_DISABLED" | "ROUTE_INCOMPLETE" | "BUSY" | "RATE_LIMITED" | "CANCELLED" | "TIMEOUT" | "NO_ADAPTER" | "UNKNOWN_MODEL" | "MODEL_UNSUPPORTED" | "MISSING_CREDENTIAL" | "INVALID_CREDENTIAL" | "NO_CREDENTIAL_STORE" | "AUTH" | "ACCOUNT_SIGN_IN_REQUIRED" | "ACCOUNT_AUTH_FAILED" | "ACCOUNT_CONNECTION" | "CONNECTION" | "RATE_LIMIT" | "QUOTA" | "CONTEXT_WINDOW_EXCEEDED" | "UNSUPPORTED_REASONING_EFFORT" | "EMPTY_RESPONSE" | "UNKNOWN", string>>;
        REMOTE_SERVICE_KEY: string;
        REMOTE_NAMESPACE: string;
        createRouteTestState: typeof import("./route-test.js").createRouteTestState;
        checkRouteTestThrottle: typeof import("./route-test.js").checkRouteTestThrottle;
        markRouteTestStarted: typeof import("./route-test.js").markRouteTestStarted;
        classifyRouteTestFailure: typeof import("./route-test.js").classifyRouteTestFailure;
        classifyRouteTestProvider: typeof import("./route-test.js").classifyRouteTestProvider;
        normalizeFailureCode: typeof import("./failure.js").normalizeFailureCode;
        readThrownFailure: typeof readThrownFailure;
        readFinishFailure: typeof import("./failure.js").readFinishFailure;
        buildRouteTestRequest: typeof import("./route-test.js").buildRouteTestRequest;
        normalizeRouteTestInput: typeof import("./route-test.js").normalizeRouteTestInput;
        routeTestStatusOf: typeof import("./route-test.js").routeTestStatusOf;
        installRouteTestEndpoint: typeof installRouteTestEndpoint;
    };
};
