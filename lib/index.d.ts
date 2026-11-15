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
import { effortCacheKey, isAutoReviewRequest, normalizeEffort, readReviewerSettings, shouldOverrideRoute } from './policy.js';
import type { ReviewerConfig } from './policy.js';
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
    signal?: AbortSignal;
    [key: string]: unknown;
}
/** The subset of the `llm` service used by this plugin. */
interface LlmService {
    stream(options: GenerateOptions): AsyncIterable<unknown>;
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmModelInfo | undefined>;
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
/** The subset of the host context used by this plugin. */
interface HostContext {
    llm: LlmService;
    on(event: string, listener: (...args: any[]) => any, options?: ListenerOptions): unknown;
    inject(services: readonly string[], callback: (child: {
        sessionLogDeepSeek: SessionLogDeepSeek;
    }) => void): unknown;
}
/** Loader line id used by the host entry. */
export declare const name = "auto-review-model";
/** Host services required before the listener may be installed. */
export declare const inject: string[];
/**
 * Review-model settings. All fields are volatile so the settings UI can update
 * them in place; the listener always reads their current values per request.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    provider: z<string, string, "volatile-defined">;
    model: z<string, string, "volatile-defined">;
    reasoningEffort: z<string, string, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    provider: z<string, string, "volatile-defined">;
    model: z<string, string, "volatile-defined">;
    reasoningEffort: z<string, string, "volatile-defined">;
}>>, "plain">;
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
    CAPABILITY_TIMEOUT_MS: number;
    ReviewerCapabilityError: typeof ReviewerCapabilityError;
};
export {};
