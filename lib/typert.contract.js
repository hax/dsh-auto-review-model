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
export const PACKAGE_NAME = '@aghost-prj/dsh-auto-review-model';
/** Cordis service key of the Host endpoint object. */
export const REMOTE_SERVICE_KEY = 'autoReviewModel';
/** Wire namespace of the Remote method. */
export const REMOTE_NAMESPACE = 'autoReviewModel';
/** Wire method name of the Remote method. */
export const REMOTE_METHOD = 'testReviewRoute';
/** Full two-segment endpoint the Gateway claims. */
export const REMOTE_ENDPOINT = `${REMOTE_NAMESPACE}/${REMOTE_METHOD}`;
/** Package-local chunk id the browser bundle registers the contribution under. */
export const REMOTE_CHUNK_FILE = 'client.remote.js';
/** Module specifier the browser bundle requires for its own contribution. */
export const REMOTE_CONTRIBUTION_SPECIFIER = `${PACKAGE_NAME}/${REMOTE_CHUNK_FILE}`;
/** Result type name used to build the codec's stable type symbol (not a registered named schema). */
export const RESULT_SCHEMA_NAME = 'ReviewRouteTestResult';
/** Stable type symbol carried by the strict result codec. */
export const RESULT_TYPE_SYMBOL = `${PACKAGE_NAME}#${RESULT_SCHEMA_NAME}`;
/** Globally stable invocation id recorded by the Typert registry. */
export const REMOTE_INVOCATION_ID = `${PACKAGE_NAME}#${REMOTE_ENDPOINT}`;
/**
 * Every outcome code the saved-route test can report.
 *
 * The list is the `enum` of the wire `code` field, so the Host, the Client
 * locale table, and tests all validate against this one declaration.
 */
export const REVIEW_ROUTE_TEST_CODES = [
    'OK',
    'ROUTE_DISABLED',
    'ROUTE_INCOMPLETE',
    'BUSY',
    'RATE_LIMITED',
    'CANCELLED',
    'TIMEOUT',
    'NO_ADAPTER',
    'UNKNOWN_MODEL',
    'MODEL_UNSUPPORTED',
    'MISSING_CREDENTIAL',
    'INVALID_CREDENTIAL',
    'NO_CREDENTIAL_STORE',
    'AUTH',
    'ACCOUNT_SIGN_IN_REQUIRED',
    'ACCOUNT_AUTH_FAILED',
    'ACCOUNT_CONNECTION',
    'CONNECTION',
    'RATE_LIMIT',
    'QUOTA',
    'CONTEXT_WINDOW_EXCEEDED',
    'UNSUPPORTED_REASONING_EFFORT',
    'EMPTY_RESPONSE',
    'UNKNOWN',
];
/** Type name of the optional input codec's stable type symbol. */
export const INPUT_SCHEMA_NAME = 'ReviewRouteTestInput';
/** Stable type symbol of the optional input codec. */
export const INPUT_TYPE_SYMBOL = `${PACKAGE_NAME}#${INPUT_SCHEMA_NAME}`;
/** Ordered optional field list of {@link ReviewRouteTestInput}. */
const INPUT_KEYS = ['provider', 'model', 'reasoningEffort'];
/**
 * Strict parser for the optional explicit-route input.
 *
 * `undefined` (no wire field) is valid and means "probe the saved row 1". Any
 * present field must be a string; unknown fields are rejected so a caller
 * cannot smuggle credentials, prompts, or session data through the probe.
 *
 * @returns a parser accepting only the documented optional input.
 */
export function createInputSchema() {
    return {
        parse(value) {
            // Generated optional-input codecs return `undefined` for an absent field;
            // the Gateway then leaves the wire key out entirely.
            if (value === undefined)
                return undefined;
            if (!isRecord(value))
                throw new TypeError('ReviewRouteTestInput must be an object');
            for (const key of Object.keys(value)) {
                if (!INPUT_KEYS.includes(key)) {
                    throw new TypeError(`ReviewRouteTestInput has undeclared field ${JSON.stringify(key)}`);
                }
            }
            const input = {};
            for (const key of INPUT_KEYS) {
                const field = value[key];
                if (field === undefined)
                    continue;
                if (typeof field !== 'string')
                    throw new TypeError(`ReviewRouteTestInput.${key} must be a string`);
                input[key] = field;
            }
            return input;
        },
    };
}
/** JSON Schema projection of {@link ReviewRouteTestInput}. */
export const INPUT_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
    },
};
/** Ordered field list of {@link ReviewRouteTestResult}; the strict parser rejects anything else. */
const RESULT_KEYS = [
    'status',
    'code',
    'route',
    'authKind',
    'providerName',
    'settingsNs',
    'credentialEnv',
    'effortUsed',
    'effortNotAdvertised',
    'latencyMs',
    'retryAfterMs',
    'failureCode',
    'detail',
];
const RESULT_STATUSES = ['ok', 'warning', 'error', 'blocked'];
const RESULT_AUTH_KINDS = ['account', 'api-key', 'unknown'];
const RESULT_ROUTE_KEYS = ['provider', 'model', 'reasoningEffort'];
const RESULT_CODE_SET = new Set(REVIEW_ROUTE_TEST_CODES);
const RESULT_STATUS_SET = new Set(RESULT_STATUSES);
const RESULT_AUTH_KIND_SET = new Set(RESULT_AUTH_KINDS);
/** Reject a non-object JSON value. */
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Read one required string field. */
function stringField(record, key) {
    const value = record[key];
    if (typeof value !== 'string')
        throw new TypeError(`ReviewRouteTestResult.${key} must be a string`);
    return value;
}
/** Read one required finite non-negative number field. */
function numberField(record, key) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`ReviewRouteTestResult.${key} must be a finite non-negative number`);
    }
    return value;
}
/** Read one required boolean field. */
function booleanField(record, key) {
    const value = record[key];
    if (typeof value !== 'boolean')
        throw new TypeError(`ReviewRouteTestResult.${key} must be a boolean`);
    return value;
}
/** Read one required plain-object field. */
function recordField(record, key) {
    const value = record[key];
    if (!isRecord(value))
        throw new TypeError(`ReviewRouteTestResult.${key} must be an object`);
    return value;
}
/**
 * Reject unknown keys so a Host-side result cannot carry model prose, a
 * conversation log, or any other field the Client did not opt into.
 */
function rejectUnknownKeys(record, keys, subject) {
    for (const key of Object.keys(record)) {
        if (!keys.includes(key))
            throw new TypeError(`${subject} has undeclared field ${JSON.stringify(key)}`);
    }
    for (const key of keys) {
        if (!Object.hasOwn(record, key))
            throw new TypeError(`${subject} is missing field ${JSON.stringify(key)}`);
    }
}
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
export function createResultSchema() {
    return {
        parse(value) {
            if (!isRecord(value))
                throw new TypeError('ReviewRouteTestResult must be an object');
            rejectUnknownKeys(value, RESULT_KEYS, 'ReviewRouteTestResult');
            const route = recordField(value, 'route');
            rejectUnknownKeys(route, RESULT_ROUTE_KEYS, 'ReviewRouteTestResult.route');
            const status = stringField(value, 'status');
            if (!RESULT_STATUS_SET.has(status)) {
                throw new TypeError(`ReviewRouteTestResult.status is not a known status: ${status}`);
            }
            const code = stringField(value, 'code');
            if (!RESULT_CODE_SET.has(code)) {
                throw new TypeError(`ReviewRouteTestResult.code is not a known outcome: ${code}`);
            }
            const authKind = stringField(value, 'authKind');
            if (!RESULT_AUTH_KIND_SET.has(authKind)) {
                throw new TypeError(`ReviewRouteTestResult.authKind is not a known kind: ${authKind}`);
            }
            const credentialEnv = value.credentialEnv;
            if (!Array.isArray(credentialEnv) || credentialEnv.some((entry) => typeof entry !== 'string')) {
                throw new TypeError('ReviewRouteTestResult.credentialEnv must be an array of strings');
            }
            return {
                status: status,
                code: code,
                route: {
                    provider: stringField(route, 'provider'),
                    model: stringField(route, 'model'),
                    reasoningEffort: stringField(route, 'reasoningEffort'),
                },
                authKind: authKind,
                providerName: stringField(value, 'providerName'),
                settingsNs: stringField(value, 'settingsNs'),
                credentialEnv: [...credentialEnv],
                effortUsed: stringField(value, 'effortUsed'),
                effortNotAdvertised: booleanField(value, 'effortNotAdvertised'),
                latencyMs: numberField(value, 'latencyMs'),
                retryAfterMs: numberField(value, 'retryAfterMs'),
                failureCode: stringField(value, 'failureCode'),
                detail: stringField(value, 'detail'),
            };
        },
    };
}
/**
 * JSON Schema projection of {@link ReviewRouteTestResult}.
 *
 * The projection is lossless for this all-JSON result, so the codec exposes it
 * instead of a `jsonSchemaError`; tool-schema consumers and packaging tests can
 * read the outcome-code enum without materializing the parser.
 */
export const RESULT_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: [...RESULT_KEYS],
    properties: {
        status: { type: 'string', enum: [...RESULT_STATUSES] },
        code: { type: 'string', enum: [...REVIEW_ROUTE_TEST_CODES] },
        route: {
            type: 'object',
            additionalProperties: false,
            required: [...RESULT_ROUTE_KEYS],
            properties: {
                provider: { type: 'string' },
                model: { type: 'string' },
                reasoningEffort: { type: 'string' },
            },
        },
        authKind: { type: 'string', enum: [...RESULT_AUTH_KINDS] },
        providerName: { type: 'string' },
        settingsNs: { type: 'string' },
        credentialEnv: { type: 'array', items: { type: 'string' } },
        effortUsed: { type: 'string' },
        effortNotAdvertised: { type: 'boolean' },
        latencyMs: { type: 'number', minimum: 0 },
        retryAfterMs: { type: 'number', minimum: 0 },
        failureCode: { type: 'string' },
        detail: { type: 'string' },
    },
};
/**
 * Build the strict input codec for the optional explicit route.
 * @returns the codec descriptor in generated-artifact shape.
 */
function createInputCodec() {
    return {
        mode: 'strict',
        typeSymbol: INPUT_TYPE_SYMBOL,
        create: createInputSchema,
        description: 'Optional explicit review route to probe; omitted probes the saved row 1.',
        jsonSchema: INPUT_JSON_SCHEMA,
    };
}
/**
 * Build the strict result codec.
 * @returns the codec descriptor in generated-artifact shape.
 */
function createResultCodec() {
    /**
     * One strict, detaching validator shared by both production boundaries: the
     * Host Gateway calls it as `encode` before framing a result, and the Client
     * Gateway calls it as `decode` after reconstructing one. A result carrying an
     * undeclared field (for example bundled model prose) therefore fails at the
     * wire boundary instead of merely relying on a test to call `parse()`.
     */
    const parseResultValue = (value) => createResultSchema().parse(value);
    return {
        mode: 'strict',
        typeSymbol: RESULT_TYPE_SYMBOL,
        create: createResultSchema,
        decode: parseResultValue,
        encode: parseResultValue,
        description: 'Outcome of one saved review-route probe; carries no model output.',
        jsonSchema: RESULT_JSON_SCHEMA,
    };
}
/**
 * Build the one invocation descriptor shared by the Host manifest and the
 * Client contribution, so both faces cannot drift.
 * @returns a fresh descriptor object.
 */
export function createInvocationDescriptor() {
    return {
        id: REMOTE_INVOCATION_ID,
        service: REMOTE_SERVICE_KEY,
        namespace: REMOTE_NAMESPACE,
        method: REMOTE_METHOD,
        description: 'Probe one review route (the saved row 1 by default) with one fixed harmless prompt.',
        invocation: { kind: 'direct' },
        parameters: [
            {
                name: 'input',
                wire: 'input',
                source: 'json',
                acceptsUndefined: true,
                codec: createInputCodec(),
                description: 'Optional explicit route to probe; omitted probes the saved settings-list row 1.',
            },
        ],
        cancellation: { parameter: 'signal' },
        result: createResultCodec(),
    };
}
/**
 * Build the Client-mountable contribution for this package's `./remote` export.
 * @returns the `TypertRemoteContribution` `ctx.remote.$mount()` accepts.
 */
export function createRemoteContribution() {
    return {
        package: PACKAGE_NAME,
        descriptors: [createInvocationDescriptor()],
    };
}
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
export function createHostManifest() {
    return {
        package: PACKAGE_NAME,
        face: 'host',
        // Intentionally empty: a named schema registered here would reach
        // `ctx.typert.toJSONSchema()` -> `z.toJSONSchema()`, which rejects the
        // parser-only factory this dependency-free package can provide. The strict
        // result codec remains complete on the invocation descriptor below.
        schemas: [],
        invocations: [createInvocationDescriptor()],
        model: {
            services: [
                {
                    description: 'Host endpoint object that probes the saved auto-review route and reports a classified outcome without returning model output.',
                    summary: 'Probes the saved auto-review route with one fixed harmless prompt.',
                    tags: [],
                    key: REMOTE_SERVICE_KEY,
                    exportName: 'ReviewRouteTestEndpoint',
                    members: [
                        {
                            kind: 'method',
                            name: REMOTE_METHOD,
                            signature: `${REMOTE_METHOD}(input?: ReviewRouteTestInput, signal?: AbortSignal): Promise<ReviewRouteTestResult>`,
                            summary: 'Probe the saved row 1 or an explicit route and return a classified, prose-free outcome.',
                        },
                    ],
                    types: [
                        {
                            name: 'ReviewRouteTestInput',
                            declaration: 'export interface ReviewRouteTestInput {\n'
                                + '  readonly provider?: string;\n'
                                + '  readonly model?: string;\n'
                                + '  readonly reasoningEffort?: string;\n'
                                + '}',
                        },
                        {
                            name: 'ReviewRouteTestResult',
                            declaration: 'export interface ReviewRouteTestResult {\n'
                                + '  readonly status: ReviewRouteTestStatus;\n'
                                + '  readonly code: ReviewRouteTestCode;\n'
                                + '  readonly route: ReviewRouteTestRoute;\n'
                                + '  readonly authKind: ReviewRouteTestAuthKind;\n'
                                + '  readonly providerName: string;\n'
                                + '  readonly settingsNs: string;\n'
                                + '  readonly credentialEnv: string[];\n'
                                + '  readonly effortUsed: string;\n'
                                + '  readonly effortNotAdvertised: boolean;\n'
                                + '  readonly latencyMs: number;\n'
                                + '  readonly retryAfterMs: number;\n'
                                + '  readonly failureCode: string;\n'
                                + '  readonly detail: string;\n'
                                + '}',
                        },
                        {
                            name: 'ReviewRouteTestCode',
                            declaration: `export type ReviewRouteTestCode = ${REVIEW_ROUTE_TEST_CODES.map((code) => JSON.stringify(code)).join(' | ')};`,
                        },
                    ],
                },
            ],
            events: [],
            objects: [],
        },
    };
}
