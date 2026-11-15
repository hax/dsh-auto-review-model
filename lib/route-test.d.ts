import type { ReviewRouteTestAuthKind, ReviewRouteTestCode, ReviewRouteTestRoute, ReviewRouteTestStatus } from './typert.contract.js';
import type { ReviewerConfig } from './policy.js';
/** Hard deadline for one saved-route probe. */
export declare const ROUTE_TEST_TIMEOUT_MS = 20000;
/** Minimum wall-clock gap between two probes of the same Host endpoint. */
export declare const ROUTE_TEST_MIN_INTERVAL_MS = 3000;
/** Length of the sliding probe-budget window. */
export declare const ROUTE_TEST_WINDOW_MS = 60000;
/** Probe budget per {@link ROUTE_TEST_WINDOW_MS} window. */
export declare const ROUTE_TEST_MAX_PER_WINDOW = 5;
/** Largest output-token budget the probe may request (hard cap, not a default). */
export declare const ROUTE_TEST_MAX_TOKENS = 16;
/** Deterministic sampling temperature for the harmless probe. */
export declare const ROUTE_TEST_TEMPERATURE = 0;
/** Largest number of model text characters the probe consumes. */
export declare const ROUTE_TEST_MAX_OUTPUT_CHARS = 64;
/** Largest number of stream chunks the probe consumes. */
export declare const ROUTE_TEST_MAX_OUTPUT_CHUNKS = 32;
/**
 * Grace period for closing a model stream whose `return()` ignores completion.
 *
 * The deadline bounds waiting for chunks; this second small bound keeps a
 * degraded adapter from holding the endpoint open forever during cleanup.
 */
export declare const ROUTE_TEST_CLOSE_GRACE_MS = 250;
/** Fixed system prompt of the harmless probe; carries no review policy and no session data. */
export declare const ROUTE_TEST_SYSTEM_PROMPT = "You are a connectivity probe for a model settings page. Follow the user instruction exactly and keep the reply minimal.";
/** Fixed user prompt of the harmless probe. */
export declare const ROUTE_TEST_USER_PROMPT = "Reply with OK";
/** The structural subset of `resolveModelInfo` this module consults. */
export interface RouteTestModelInfoLike {
    /** Adapter-owned reasoning efforts advertised for the exact route. */
    reasoning?: {
        efforts?: readonly {
            id?: string;
        }[];
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
    content: ReadonlyArray<{
        type: 'text';
        text: string;
    }>;
}
/** The subset of the `llm` service the probe uses. */
export interface RouteTestLlmLike {
    /** Stream one hand-built one-shot request. */
    stream(options: RouteTestGenerateOptions): AsyncIterable<unknown>;
    /** Resolve exact-route model metadata (efforts) with cancellation. */
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<RouteTestModelInfoLike | undefined> | RouteTestModelInfoLike | undefined;
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
     * provider stream to accumulate beside an orphaned one. An abandoned
     * unclosable stream also keeps the slot held even after this reaches zero.
     */
    pendingProviderOperations: number;
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
export declare function normalizeFailureCode(value: unknown): string;
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
export declare function classifyRouteTestFailure(failureCode: string, authKind: ReviewRouteTestAuthKind, status?: number): ReviewRouteTestCode;
/**
 * Map one result code to its presentation tone.
 *
 * @param code - stable result code.
 * @returns success, warning, blocked (locally refused/cancelled), or error.
 */
export declare function routeTestStatusOf(code: ReviewRouteTestCode): ReviewRouteTestStatus;
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
export declare function classifyRouteTestProvider(provider: string, directory: readonly RouteTestProviderLike[]): RouteTestProviderClassification;
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
export declare function buildRouteTestRequest(route: ReviewRouteTestRoute, effortUsed: string, signal: AbortSignal, maxTokens: number): RouteTestGenerateOptions;
/**
 * Construct an empty Host-wide throttle state.
 *
 * @param now - current clock value; starts the first budget window here.
 * @returns fresh state with no probe in flight.
 */
export declare function createRouteTestState(now: number): RouteTestState;
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
export declare function checkRouteTestThrottle(state: RouteTestState, nowMs: number, limits: RouteTestRateLimits): RouteTestThrottleRefusal | undefined;
/**
 * Record that one allowed probe has started.
 *
 * @param state - Host-wide throttle state.
 * @param nowMs - current clock value.
 */
export declare function markRouteTestStarted(state: RouteTestState, nowMs: number): void;
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
export declare function readThrownFailure(error: unknown): RouteTestFailureFacts;
/**
 * Extract provider-neutral facts from a terminal `finish` reason.
 *
 * @param reason - finish reason carried by the terminal stream chunk.
 * @returns failure facts for `error`/`aborted` finishes, else `undefined`.
 */
export declare function readFinishFailure(reason: unknown): RouteTestFailureFacts | undefined;
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
export declare function installRouteTestEndpoint(ctx: RouteTestContext, config: ReviewerConfig, options?: RouteTestOptions): void;
/**
 * Stable helpers exposed for regression tests and Host integration checks.
 *
 * This object is not part of the plugin contract and may grow with the tests.
 */
export declare const __testing: {
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
    createRouteTestState: typeof createRouteTestState;
    checkRouteTestThrottle: typeof checkRouteTestThrottle;
    markRouteTestStarted: typeof markRouteTestStarted;
    classifyRouteTestFailure: typeof classifyRouteTestFailure;
    classifyRouteTestProvider: typeof classifyRouteTestProvider;
    normalizeFailureCode: typeof normalizeFailureCode;
    readThrownFailure: typeof readThrownFailure;
    readFinishFailure: typeof readFinishFailure;
    buildRouteTestRequest: typeof buildRouteTestRequest;
    routeTestStatusOf: typeof routeTestStatusOf;
    installRouteTestEndpoint: typeof installRouteTestEndpoint;
};
