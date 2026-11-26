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
import z from '@deepseek-ai/schemastery';
import { adaptEffortToAdvertised, effortCacheKey, effortRank, isAutoReviewRequest, normalizeEffort, readReviewerSettings, shouldOverrideRoute } from './policy.js';
import type { ReviewerConfig } from './policy.js';
import { installRouteTestEndpoint } from './route-test.js';
import { readThrownFailure } from './failure.js';
export { ReviewerRouteError, ReviewerRoutesError } from './fallback.js';
import { ReviewerRouteError, ReviewerRoutesError, buildReviewPlan, failureFromFinish, failureFromThrown, isAsyncIterable, isFallbackEligibleFailure, readRoutes } from './fallback.js';
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
        isLegacySessionEntry: typeof import("./fallback.js").isLegacySessionEntry;
        readFallbackEntries: typeof import("./fallback.js").readFallbackEntries;
        readRoutes: typeof readRoutes;
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
