/**
 * Dependency-free Typert contract for the saved review-route test Remote method.
 *
 * This module is the single source of truth for the one Remote endpoint this
 * package contributes:
 *
 * - the endpoint identity (`autoReviewModel/testReviewRoute`),
 * - the strict result codec the Gateway and the Client mount both validate,
 * - the generated-style Host `TYPERT` manifest the typert Loader registers, and
 * - the mountable `TypertRemoteContribution` the Client browser bundle mounts.
 *
 * It deliberately imports nothing. The package is installed as a linked
 * directory outside the DSH installation, so a runtime import of
 * `@deepseek-ai/dsh-typert-protocol` or `zod` would not resolve; the generated
 * artifacts this package ships are therefore hand-written in the shape the
 * Typert loader validates (package/face/schemas/model/invocations), with a
 * strict codec whose `create()` returns a parser instead of a Zod schema. The
 * Host calls the codec's `encode` before framing a result and the Client calls
 * its `decode` after reconstructing one; both point at the same strict parser,
 * so real wire traffic is validated and detached rather than only test code
 * calling `parse()` directly.
 *
 * The manifest therefore contributes `schemas: []`: the Typert registry's
 * `toJSONSchema()` materializes a contributed named schema and hands it to
 * `z.toJSONSchema()`, which requires a real Zod schema. A parser-only object is
 * not one, so registering it would turn an unrelated schema projection into a
 * runtime throw. The strict result codec stays on the invocation descriptor,
 * which is the only place the Gateway consumes it.
 *
 * The browser bundle embeds a transpiled copy of this module (see
 * `scripts/build-client.cjs`), so the Host and Client faces cannot drift.
 *
 * @module @aghost-prj/dsh-auto-review-model/typert-contract
 */
/** Exact npm package name owning the Remote method. */
export declare const PACKAGE_NAME = "@aghost-prj/dsh-auto-review-model";
/** Cordis service key of the Host endpoint object. */
export declare const REMOTE_SERVICE_KEY = "autoReviewModel";
/** Wire namespace of the Remote method. */
export declare const REMOTE_NAMESPACE = "autoReviewModel";
/** Wire method name of the Remote method. */
export declare const REMOTE_METHOD = "testReviewRoute";
/** Full two-segment endpoint the Gateway claims. */
export declare const REMOTE_ENDPOINT = "autoReviewModel/testReviewRoute";
/** Package-local chunk id the browser bundle registers the contribution under. */
export declare const REMOTE_CHUNK_FILE = "client.remote.js";
/** Module specifier the browser bundle requires for its own contribution. */
export declare const REMOTE_CONTRIBUTION_SPECIFIER = "@aghost-prj/dsh-auto-review-model/client.remote.js";
/** Result type name used to build the codec's stable type symbol (not a registered named schema). */
export declare const RESULT_SCHEMA_NAME = "ReviewRouteTestResult";
/** Stable type symbol carried by the strict result codec. */
export declare const RESULT_TYPE_SYMBOL = "@aghost-prj/dsh-auto-review-model#ReviewRouteTestResult";
/** Globally stable invocation id recorded by the Typert registry. */
export declare const REMOTE_INVOCATION_ID = "@aghost-prj/dsh-auto-review-model#autoReviewModel/testReviewRoute";
/**
 * Every outcome code the saved-route test can report.
 *
 * The list is the `enum` of the wire `code` field, so the Host, the Client
 * locale table, and tests all validate against this one declaration.
 */
export declare const REVIEW_ROUTE_TEST_CODES: readonly ["OK", "ROUTE_DISABLED", "ROUTE_INCOMPLETE", "BUSY", "RATE_LIMITED", "CANCELLED", "TIMEOUT", "NO_ADAPTER", "UNKNOWN_MODEL", "MODEL_UNSUPPORTED", "MISSING_CREDENTIAL", "INVALID_CREDENTIAL", "NO_CREDENTIAL_STORE", "AUTH", "ACCOUNT_SIGN_IN_REQUIRED", "ACCOUNT_AUTH_FAILED", "ACCOUNT_CONNECTION", "CONNECTION", "RATE_LIMIT", "QUOTA", "CONTEXT_WINDOW_EXCEEDED", "UNSUPPORTED_REASONING_EFFORT", "EMPTY_RESPONSE", "NO_REVIEW_PROMPT", "REVIEW_MISMATCH", "UNKNOWN"];
/** One saved-route test outcome code. */
export type ReviewRouteTestCode = (typeof REVIEW_ROUTE_TEST_CODES)[number];
/** Presentation tone of one outcome: success, reachable-with-issue, failure, or local refusal. */
export type ReviewRouteTestStatus = 'ok' | 'warning' | 'error' | 'blocked';
/** How the tested route authenticates, as classified from the provider directory. */
export type ReviewRouteTestAuthKind = 'account' | 'api-key' | 'unknown';
/**
 * Optional explicit route input for one probe.
 *
 * Omitting the whole input (or sending an empty provider+model) keeps the
 * original behavior: probe settings-list row 1. Every field is an id string;
 * the Host trims and bounds them, and never accepts a URL or a credential.
 */
export interface ReviewRouteTestInput {
    /**
     * What to run.
     *
     * `probe` (the default) proves the route answers at all; `review` runs the two
     * scripted pending calls the settings page shows; `health` only reads the
     * measured ledger and never contacts a provider.
     */
    mode?: ReviewRouteTestMode;
    /** Provider id to probe. */
    provider?: string;
    /** Model id to probe. */
    model?: string;
    /** Effort to probe; `inherit` is sent as the provider default for a probe. */
    reasoningEffort?: string;
}
/** One selectable saved-route test mode. */
export type ReviewRouteTestMode = 'probe' | 'review' | 'health';
/** Every mode the endpoint accepts. */
export declare const REVIEW_ROUTE_TEST_MODES: readonly ReviewRouteTestMode[];
/** Type name of the optional input codec's stable type symbol. */
export declare const INPUT_SCHEMA_NAME = "ReviewRouteTestInput";
/** Stable type symbol of the optional input codec. */
export declare const INPUT_TYPE_SYMBOL = "@aghost-prj/dsh-auto-review-model#ReviewRouteTestInput";
/** The exact saved route the test probed. */
export interface ReviewRouteTestRoute {
    /** Saved provider id. */
    provider: string;
    /** Saved model id. */
    model: string;
    /** Saved normalized reasoning effort; `''` means the provider default. */
    reasoningEffort: string;
}
/**
 * Wire result of one saved-route probe.
 *
 * The value is JSON-safe and contains no model output: only classification
 * metadata a settings page can render. Provider prose is never carried.
 */
export interface ReviewRouteTestResult {
    /** Presentation tone for the Client. */
    status: ReviewRouteTestStatus;
    /** Stable outcome code. */
    code: ReviewRouteTestCode;
    /** Saved route that was probed. */
    route: ReviewRouteTestRoute;
    /** Authentication style of the probed provider. */
    authKind: ReviewRouteTestAuthKind;
    /** Human-readable provider name, or the provider id when unknown. */
    providerName: string;
    /** Settings namespace that configures the provider, when the directory reports one. */
    settingsNs: string;
    /** Environment variables the provider authentication reads, in lookup order. */
    credentialEnv: string[];
    /** Reasoning effort actually sent with the probe request; `''` for the provider default. */
    effortUsed: string;
    /** Whether the saved effort was not advertised, so the probe used the default instead. */
    effortNotAdvertised: boolean;
    /** Wall-clock duration of the probe attempt in milliseconds. */
    latencyMs: number;
    /** Local throttle delay to respect before a retry, or 0. */
    retryAfterMs: number;
    /** Provider-neutral failure code observed on the wire, or `''` when none. */
    failureCode: string;
    /** Short classified diagnostic detail, or `''` when none. */
    detail: string;
    /** Scripted review-case results; present only for a `review` run. */
    cases?: ReviewRouteTestCase[];
    /** Measured ledger health; present only for a `health` run. */
    health?: ReviewRouteHealth;
}
/** One scripted review case run against a route. */
export interface ReviewRouteTestCase {
    /** Which scripted pending call this case is. */
    case: 'allow' | 'deny';
    /** Decision the case expects from a correct reviewer. */
    expected: 'allow' | 'deny';
    /** Decision the route actually returned; `''` when it produced nothing usable. */
    actual: '' | 'allow' | 'deny';
    /** Risk class the route reported; `''` when it reported none. */
    risk: '' | 'low' | 'medium' | 'high';
    /** Whether {@link actual} matched {@link expected}. */
    ok: boolean;
    /** Provider-neutral failure code of this case; `''` when the route answered. */
    failureCode: string;
    /** Wall-clock duration of this case in milliseconds. */
    latencyMs: number;
    /** Short classified diagnostic detail; `''` when none. */
    detail: string;
}
/** One route's measured health within the current ledger week. */
export interface ReviewRouteHealthEntry {
    /** Provider id of the measured route. */
    provider: string;
    /** Model id of the measured route. */
    model: string;
    /** Attempts this route was asked for. */
    attempts: number;
    /** Attempts that produced the review decision. */
    answered: number;
    /** Attempts that failed and moved on. */
    failed: number;
    /** Mean attempt duration in milliseconds, rounded. */
    avgMs: number;
    /** Epoch milliseconds of the newest measured attempt, `0` when never used. */
    lastAt: number;
    /** Newest observed failure code, `''` when the route never failed. */
    lastFailureCode: string;
}
/** Ledger health snapshot served to the settings page. */
export interface ReviewRouteHealth {
    /** Ledger file the numbers came from (basename), `''` when unavailable. */
    ledger: string;
    /** ISO week the ledger covers, e.g. `2026-W48`. */
    week: string;
    /** Review records that contributed at least one route attempt. */
    records: number;
    /** Measured routes, ordered by attempt count. */
    routes: ReviewRouteHealthEntry[];
}
/**
 * Strict parser for the optional explicit-route input.
 *
 * `undefined` (no wire field) is valid and means "probe the saved row 1". Any
 * present field must be a string; unknown fields are rejected so a caller
 * cannot smuggle credentials, prompts, or session data through the probe.
 *
 * @returns a parser accepting only the documented optional input.
 */
export declare function createInputSchema(): {
    readonly parse: (value: unknown) => ReviewRouteTestInput | undefined;
};
/** JSON Schema projection of {@link ReviewRouteTestInput}. */
export declare const INPUT_JSON_SCHEMA: Readonly<Record<string, unknown>>;
/**
 * Build the strict result parser.
 *
 * This is the `create()` factory of the strict result codec. The Gateway calls
 * `create().parse(value)` for strict parameter decoding and consumers may
 * validate a result the same way; the parser detaches the value into a plain
 * JSON object and rejects shape drift at the wire boundary.
 *
 * @returns a parser accepting only a complete {@link ReviewRouteTestResult}.
 */
export declare function createResultSchema(): {
    readonly parse: (value: unknown) => ReviewRouteTestResult;
};
/**
 * JSON Schema projection of {@link ReviewRouteTestResult}.
 *
 * The projection is lossless for this all-JSON result, so the codec exposes it
 * instead of a `jsonSchemaError`; tool-schema consumers and packaging tests can
 * read the outcome-code enum without materializing the parser.
 */
export declare const RESULT_JSON_SCHEMA: Readonly<Record<string, unknown>>;
/** One strict codec in the generated-artifact shape the Typert Loader validates. */
export interface ContractCodecSpec {
    /** Strict codecs are the only ones the Gateway and Client mount accept. */
    readonly mode: 'strict';
    /** Stable source type symbol. */
    readonly typeSymbol: string;
    /** Lazy parser factory, as generated artifacts emit for Zod schemas. */
    readonly create: () => {
        readonly parse: (value: unknown) => unknown;
    };
    /**
     * Unary-result decoder the Client Gateway applies after carrier
     * reconstruction (`descriptor.result.decode(result.value)`).
     */
    readonly decode?: (value: unknown) => unknown;
    /**
     * Unary-result encoder the Host Gateway applies before framing
     * (`codec.encode?.(value, writeBytes) ?? value`). This result is plain JSON,
     * so `writeBytes` is accepted for signature compatibility and never called.
     */
    readonly encode?: (value: unknown, writeBytes: (bytes: Uint8Array, path: readonly (string | number)[]) => null) => unknown;
    /** Optional documentation carried onto result JSON Schema projections. */
    readonly description?: string;
    /** Optional lossless JSON Schema projection. */
    readonly jsonSchema?: Readonly<Record<string, unknown>>;
}
/** One ordered business parameter of the contributed invocation. */
export interface ContractParameterSpec {
    /** Source-level parameter name. */
    readonly name: string;
    /** Wire `args` key. */
    readonly wire: string;
    /** Optional documentation carried into the generated manifest. */
    readonly description?: string;
    /** JSON or Host lookup value. */
    readonly source: 'json';
    /**
     * Declares an optional parameter: the Gateway then accepts a missing wire
     * field and the method receives `undefined` (the generated optional-input
     * shape).
     */
    readonly acceptsUndefined?: true;
    /** Strict boundary codec. */
    readonly codec: ContractCodecSpec;
}
/** Generated-artifact invocation descriptor the Typert registry and Gateway consume. */
export interface ContractInvocationDescriptor {
    /** Globally stable generated identity. */
    readonly id: string;
    /** Cordis service key owning the method. */
    readonly service: string;
    /** Wire namespace. */
    readonly namespace: string;
    /** Public instance method name. */
    readonly method: string;
    /** Source-owned method documentation. */
    readonly description?: string;
    /** Direct Service invocation; the Client has no scoped Context projection. */
    readonly invocation: {
        readonly kind: 'direct';
    };
    /**
     * Ordered business parameters: exactly one optional explicit-route input.
     * The browser supplies ids only; no credential, prompt, session id, or URL
     * crosses the wire.
     */
    readonly parameters: readonly ContractParameterSpec[];
    /** Transport cancellation injected after business parameters. */
    readonly cancellation: {
        readonly parameter: 'signal';
    };
    /** Codec for the unary JSON result. */
    readonly result: ContractCodecSpec;
}
/** One documented public member in the generated package reflection model. */
export interface ContractMemberModel {
    /** Member kind accepted by the Typert Loader. */
    readonly kind: 'method';
    /** Member name. */
    readonly name: string;
    /** Human-readable signature. */
    readonly signature: string;
    /** Short member summary. */
    readonly summary?: string;
}
/** One named type declaration in the generated package reflection model. */
export interface ContractTypeModel {
    /** Type name. */
    readonly name: string;
    /** TypeScript declaration retained for consumers. */
    readonly declaration: string;
}
/** Generated package reflection for the Host service owning the endpoint. */
export interface ContractServiceModel {
    /** Service documentation. */
    readonly description: string;
    /** Short service summary. */
    readonly summary: string;
    /** Structured documentation tags; the Loader requires the array. */
    readonly tags: readonly string[];
    /** Cordis service key. */
    readonly key: string;
    /** Source class/export name retained for documentation. */
    readonly exportName: string;
    /** Public members. */
    readonly members: readonly ContractMemberModel[];
    /** Named types referenced by the members. */
    readonly types: readonly ContractTypeModel[];
}
/** Complete Host Typert manifest registered by `@deepseek-ai/dsh-typert-loader`. */
export interface ContractTypertManifest {
    /** Owning npm package; must equal the package that exports `./typert`. */
    readonly package: string;
    /** Independently compiled face. */
    readonly face: 'host';
    /**
     * Named Zod schema factories contributed to the Host registry.
     *
     * This hand-written artifact contributes none: the registry's
     * `toJSONSchema()` requires a real Zod schema, and this package deliberately
     * has no zod runtime dependency. The strict result codec lives on the
     * invocation descriptor instead. Must stay `[]` unless a real Zod factory is
     * ever available.
     */
    readonly schemas: readonly {
        readonly name: string;
        readonly create: () => unknown;
    }[];
    /** Generated business reflection. */
    readonly model: {
        readonly services: readonly ContractServiceModel[];
        readonly events: readonly unknown[];
        readonly objects: readonly unknown[];
    };
    /** Host invocation descriptors. */
    readonly invocations: readonly ContractInvocationDescriptor[];
}
/** Mountable Host-for-Client contribution consumed by `ctx.remote.$mount()`. */
export interface ContractRemoteContribution {
    /** npm package owning the Remote methods. */
    readonly package: string;
    /** Consumer-side invocation descriptors. */
    readonly descriptors: readonly ContractInvocationDescriptor[];
}
/**
 * Build the one invocation descriptor shared by the Host manifest and the
 * Client contribution, so both faces cannot drift.
 * @returns a fresh descriptor object.
 */
export declare function createInvocationDescriptor(): ContractInvocationDescriptor;
/**
 * Build the Client-mountable contribution for this package's `./remote` export.
 * @returns the `TypertRemoteContribution` `ctx.remote.$mount()` accepts.
 */
export declare function createRemoteContribution(): ContractRemoteContribution;
/**
 * Build the complete Host `TYPERT` manifest exported by this package's `./typert`
 * export and validated by `@deepseek-ai/dsh-typert-loader`.
 *
 * The manifest registers no named schema: the Typert registry would project a
 * contributed schema through `z.toJSONSchema()`, which requires a real Zod
 * schema that this dependency-free package cannot ship. The strict result codec
 * is carried by the invocation descriptor, which the Gateway consumes directly.
 * @returns a fresh manifest object.
 */
export declare function createHostManifest(): ContractTypertManifest;
