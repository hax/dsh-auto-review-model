/**
 * Typert contract and generated-artifact tests for
 * `@aghost-prj/dsh-auto-review-model`.
 *
 * The installed DSH release validates three different boundaries, and this
 * suite mirrors each of them against the artifacts this package ships:
 *
 * 1. `@deepseek-ai/dsh-typert-loader` imports `./typert`, checks the manifest
 *    (package/face/schemas/model/invocations, strict codecs), and registers the
 *    invocations in `ctx.typert`. The manifest must register NO named schema:
 *    the registry's `toJSONSchema()` hands a contributed schema to
 *    `z.toJSONSchema()`, which rejects the parser-only factory this
 *    dependency-free package ships. The strict result codec remains on the
 *    invocation descriptor, which the Gateway consumes directly.
 * 2. `@deepseek-ai/dsh-api-gateway` dispatches `autoReviewModel/testReviewRoute`
 *    through a strict descriptor and resolves the live service named by
 *    `service`, which must expose a matching `typertRemote` binding.
 * 3. The Client borrows the `./remote` contribution and mounts it with
 *    `ctx.remote.$mount()`, which requires at least `package` plus strict
 *    descriptors.
 *
 * No Harness package is importable from this linked checkout, so the checks are
 * deliberate mirrors of the validators read from DSH 0.2.2-rc.3 (loader
 * `validateTypertManifest`, registry `validateInvocation`, client
 * `validateContribution`). They are intentionally stricter than the artifacts:
 * every failure names the artifact defect.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const packageJsonPath = fileURLToPath(
  import.meta.resolve('@aghost-prj/dsh-auto-review-model/package.json'),
);
const PKG_ROOT = path.dirname(packageJsonPath);

/** Exact identity every face of the contract must carry. */
const ENDPOINT = {
  package: '@aghost-prj/dsh-auto-review-model',
  service: 'autoReviewModel',
  namespace: 'autoReviewModel',
  method: 'testReviewRoute',
  endpoint: 'autoReviewModel/testReviewRoute',
  invocationId: '@aghost-prj/dsh-auto-review-model#autoReviewModel/testReviewRoute',
} as const;

/** Full strict result field list; the parser rejects anything else. */
const RESULT_FIELDS = [
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
] as const;

/** Healthy result used by codec tests. */
function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    code: 'OK',
    route: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
    authKind: 'account',
    providerName: 'Provider A',
    settingsNs: 'provider-a',
    credentialEnv: [],
    effortUsed: 'high',
    effortNotAdvertised: false,
    latencyMs: 123,
    retryAfterMs: 0,
    failureCode: '',
    detail: '',
    ...overrides,
  };
}

/** Minimal typed view of the generated-artifact invocation descriptor. */
interface Descriptor {
  id: string;
  service: string;
  namespace: string;
  method: string;
  description?: string;
  invocation: { kind: string };
  parameters: Array<{
    name: string;
    wire: string;
    source: string;
    acceptsUndefined?: true;
    codec: Codec;
  }>;
  cancellation?: { parameter: string };
  result: Codec;
}

/** Minimal typed view of a strict codec. */
interface Codec {
  mode: string;
  typeSymbol: string;
  create: () => { parse(value: unknown): unknown };
  /** Client Gateway boundary: runs after carrier reconstruction. */
  decode?: (value: unknown) => unknown;
  /** Host Gateway boundary: runs before framing a unary result. */
  encode?: (
    value: unknown,
    writeBytes: (bytes: Uint8Array, path: readonly (string | number)[]) => null,
  ) => unknown;
  description?: string;
  jsonSchema?: Record<string, any>;
  jsonSchemaError?: string;
}

/** Minimal typed view of one manifest. */
interface Manifest {
  package: string;
  face: string;
  schemas: Array<{ name: string; create: () => unknown }>;
  model: {
    services: Array<{
      key: string;
      exportName: string;
      description?: string;
      summary?: string;
      tags: unknown[];
      members: Array<{ kind: string; name: string; signature: string }>;
      types: Array<{ name: string; declaration: string }>;
    }>;
    events: unknown[];
    objects: unknown[];
  };
  invocations: Descriptor[];
}

/** Minimal typed view of a mountable contribution. */
interface Contribution {
  package: string;
  descriptors: Descriptor[];
}

const TYPERT = ((await import('@aghost-prj/dsh-auto-review-model/typert')) as unknown as { TYPERT: Manifest }).TYPERT;
const REMOTE_MODULE = (await import('@aghost-prj/dsh-auto-review-model/remote')) as unknown as {
  TYPERT_REMOTE: Contribution;
  default: Contribution;
};

const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** Mirror the Loader's `requireString` guard. */
function requireNonEmptyString(value: unknown, subject: string): void {
  assert.equal(typeof value, 'string', `${subject} must be a string`);
  assert.ok((value as string).length > 0, `${subject} must be non-empty`);
}

/** Mirror the Loader's wire-segment guard. */
function requireWireName(value: unknown, subject: string): void {
  requireNonEmptyString(value, subject);
  assert.ok(ENDPOINT_PATTERN.test(value as string), `${subject} must be a Remote segment: ${String(value)}`);
}

/** Mirror the Loader's strict-codec guard. */
function assertStrictCodec(codec: unknown, subject: string): asserts codec is Codec {
  assert.ok(codec !== null && typeof codec === 'object', `${subject} must be an object`);
  const value = codec as Record<string, unknown>;
  assert.equal(value.mode, 'strict', `${subject} must use a strict codec`);
  requireNonEmptyString(value.typeSymbol, `${subject}.typeSymbol`);
  assert.equal(typeof value.create, 'function', `${subject}.create must be a factory`);
  for (const method of ['decode', 'encode'] as const) {
    assert.ok(
      value[method] === undefined || typeof value[method] === 'function',
      `${subject}.${method} must be a function when present`,
    );
  }
  if (value.description !== undefined) {
    assert.equal(typeof value.description, 'string', `${subject}.description must be a string`);
  }
  if (value.jsonSchemaError !== undefined) {
    assert.equal(typeof value.jsonSchemaError, 'string', `${subject}.jsonSchemaError must be a string`);
  }
  if (value.jsonSchema !== undefined) {
    assert.ok(value.jsonSchema !== null && typeof value.jsonSchema === 'object', `${subject}.jsonSchema must be an object`);
  }
}

/** Mirror the Loader's invocation guard. */
function assertInvocation(descriptor: Descriptor): void {
  requireNonEmptyString(descriptor.id, 'invocation.id');
  requireNonEmptyString(descriptor.service, 'invocation.service');
  requireWireName(descriptor.namespace, 'invocation.namespace');
  requireWireName(descriptor.method, 'invocation.method');
  assert.equal(descriptor.invocation?.kind, 'direct', 'the endpoint must be a direct Service invocation');
  assert.ok(Array.isArray(descriptor.parameters), 'invocation.parameters must be an array');
  const wires = new Set<string>();
  for (const parameter of descriptor.parameters) {
    requireWireName(parameter.name, 'parameter.name');
    requireWireName(parameter.wire, 'parameter.wire');
    assert.ok(!wires.has(parameter.wire), `parameter wire field ${parameter.wire} must be unique`);
    wires.add(parameter.wire);
    assert.equal(parameter.source, 'json', 'only JSON parameters are supported');
    assertStrictCodec(parameter.codec, `parameter ${parameter.wire}`);
  }
  if (descriptor.cancellation !== undefined) {
    assert.equal(descriptor.cancellation.parameter, 'signal', 'cancellation parameter must be "signal"');
  }
  assertStrictCodec(descriptor.result, 'invocation.result');
}

/**
 * Validate both artifacts the way the Loader and Client mount boundaries do.
 * @returns the descriptor shared by both faces.
 */
function validatedDescriptor(): Descriptor {
  assert.equal(TYPERT.package, ENDPOINT.package, 'TYPERT.package must equal the owning package');
  assert.equal(TYPERT.face, 'host', 'TYPERT.face must be "host"');
  assert.ok(Array.isArray(TYPERT.schemas), 'TYPERT.schemas must be an array');
  for (const schema of TYPERT.schemas) {
    assert.ok(schema !== null && typeof schema === 'object', 'TYPERT.schemas entries must be objects');
    requireNonEmptyString(schema.name, 'schema.name');
    assert.equal(typeof schema.create, 'function', `schema ${schema.name} must expose create()`);
  }
  assert.ok(TYPERT.model !== null && typeof TYPERT.model === 'object', 'TYPERT.model must be an object');
  for (const key of ['services', 'events', 'objects'] as const) {
    assert.ok(Array.isArray(TYPERT.model[key]), `TYPERT.model.${key} must be an array`);
  }
  for (const service of TYPERT.model.services) {
    requireNonEmptyString(service.key, 'service.key');
    requireNonEmptyString(service.exportName, 'service.exportName');
    assert.ok(Array.isArray(service.tags), `service ${service.key} tags must be an array`);
    for (const member of service.members) {
      assert.ok(['property', 'method', 'getter', 'setter', 'call', 'construct', 'index'].includes(member.kind));
      requireNonEmptyString(member.name, `service ${service.key} member.name`);
      requireNonEmptyString(member.signature, `service ${service.key} member.signature`);
    }
    for (const type of service.types) {
      requireNonEmptyString(type.name, `service ${service.key} type.name`);
      requireNonEmptyString(type.declaration, `service ${service.key} type.declaration`);
    }
  }
  assert.ok(Array.isArray(TYPERT.invocations), 'TYPERT.invocations must be an array');
  assert.equal(TYPERT.invocations.length, 1, 'exactly one Remote invocation is contributed');
  const descriptor = TYPERT.invocations[0];
  assertInvocation(descriptor);
  assert.equal(descriptor.id, ENDPOINT.invocationId);
  assert.equal(descriptor.service, ENDPOINT.service);
  assert.equal(descriptor.namespace, ENDPOINT.namespace);
  assert.equal(descriptor.method, ENDPOINT.method);
  assert.equal(
    `${descriptor.namespace}/${descriptor.method}`,
    ENDPOINT.endpoint,
    'descriptor endpoint must equal the Gateway endpoint',
  );
  // The browser may send exactly one optional explicit-route input; no
  // credential, prompt, URL, or session id is part of the wire contract.
  assert.equal(descriptor.parameters.length, 1, 'the probe accepts one optional route input');
  const input = descriptor.parameters[0];
  assert.equal(input.name, 'input');
  assert.equal(input.wire, 'input');
  assert.equal(input.source, 'json');
  assert.equal(input.acceptsUndefined, true, 'the route input must be optional');
  assert.equal(input.codec.typeSymbol, `${ENDPOINT.package}#ReviewRouteTestInput`);

  // Client mount boundary: `$mount()` checks package plus strict input codecs.
  assert.equal(REMOTE_MODULE.default, REMOTE_MODULE.TYPERT_REMOTE, 'the remote artifact must default-export its contribution');
  assert.equal(REMOTE_MODULE.TYPERT_REMOTE.package, ENDPOINT.package);
  assert.equal(REMOTE_MODULE.TYPERT_REMOTE.descriptors.length, 1);
  const clientDescriptor = REMOTE_MODULE.TYPERT_REMOTE.descriptors[0];
  assertInvocation(clientDescriptor);
  assert.equal(clientDescriptor.id, descriptor.id, 'Host and Client descriptor ids must match');
  assert.equal(clientDescriptor.result.typeSymbol, descriptor.result.typeSymbol);
  return descriptor;
}

test('Host manifest passes the Typert Loader structural contract', () => {
  const descriptor = validatedDescriptor();
  assert.equal(TYPERT.package, ENDPOINT.package);
  assert.equal(TYPERT.face, 'host');
  assert.ok(
    TYPERT.model.services.some((service) => service.key === ENDPOINT.service),
    'the endpoint service must appear in the generated reflection model',
  );
  assert.equal(descriptor.result.mode, 'strict');
  assert.ok(descriptor.result.jsonSchema, 'the strict result codec must publish a JSON Schema projection');
});

test('the optional input codec accepts only the documented route ids', () => {
  const descriptor = validatedDescriptor();
  const inputCodec = descriptor.parameters[0].codec;
  const schema = inputCodec.create();
  assert.equal(schema.parse(undefined), undefined, 'an absent input probes the saved row 1');
  assert.deepEqual(schema.parse({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' });
  assert.deepEqual(
    schema.parse({ provider: 'p', model: 'm', reasoningEffort: 'inherit' }),
    { provider: 'p', model: 'm', reasoningEffort: 'inherit' },
  );
  assert.deepEqual(schema.parse({}), {});
  assert.deepEqual(
    schema.parse({ mode: 'review', provider: 'p', model: 'm' }),
    { mode: 'review', provider: 'p', model: 'm' },
    'the review mode is an accepted wire value',
  );
  assert.deepEqual(
    schema.parse({ mode: 'health' }),
    { mode: 'health' },
    'the health mode needs no route',
  );
  for (const [label, value] of [
    ['a non-object input', 'route'],
    ['an array input', []],
    ['an undeclared field', { provider: 'p', model: 'm', apiKey: 'sk-secret' }],
    ['a non-string provider', { provider: 42 }],
    ['a non-string model', { model: {} }],
    ['a non-string effort', { reasoningEffort: false }],
    ['an unknown mode', { mode: 'prompt' }],
  ] as const) {
    assert.throws(() => schema.parse(value), TypeError, `the input codec must reject ${label}`);
  }
  assert.ok(inputCodec.jsonSchema, 'the input codec must publish a JSON Schema projection');
  assert.deepEqual(
    Object.keys((inputCodec.jsonSchema as { properties: Record<string, unknown> }).properties).sort(),
    ['mode', 'model', 'provider', 'reasoningEffort'],
  );
});

test('the Host manifest registers no parser-only named schema', () => {
  // Regression for the Typert Registry boundary: `ctx.typert.toJSONSchema(key)`
  // resolves a registered named schema and calls `z.toJSONSchema(schema)`; the
  // hand-written, dependency-free result parser is not a Zod schema, so
  // registering it as one would make an unrelated schema projection throw.
  assert.equal(
    TYPERT.schemas.some((schema) => schema.name === 'ReviewRouteTestResult'),
    false,
    'the result parser must not be registered as a named Zod schema',
  );
  assert.deepEqual(TYPERT.schemas, [], 'TYPERT.schemas must stay empty for a dependency-free artifact');
  // The strict result codec is not lost: it stays complete on the invocation
  // descriptor, which is what the Gateway and the Client mount consume.
  const descriptor = validatedDescriptor();
  assert.equal(descriptor.result.mode, 'strict');
  assert.equal(descriptor.result.typeSymbol, `${ENDPOINT.package}#ReviewRouteTestResult`);
  const schema = descriptor.result.create();
  assert.equal(typeof schema.parse, 'function', 'the invocation codec still exposes a parser');
  assert.equal((schema.parse(validResult()) as Record<string, unknown>).code, 'OK');
  assert.throws(() => schema.parse(validResult({ prose: 'x' })), TypeError);
});

test('Host and Client faces are generated from the same descriptor', () => {
  const descriptor = validatedDescriptor();
  const clientDescriptor = REMOTE_MODULE.TYPERT_REMOTE.descriptors[0];
  for (const key of ['id', 'service', 'namespace', 'method', 'invocation', 'parameters', 'cancellation'] as const) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(clientDescriptor[key])),
      JSON.parse(JSON.stringify(descriptor[key])),
      `Host and Client descriptor disagree on ${key}`,
    );
  }
  assert.equal(clientDescriptor.result.typeSymbol, descriptor.result.typeSymbol);
  assert.deepEqual(
    JSON.parse(JSON.stringify(clientDescriptor.result.jsonSchema)),
    JSON.parse(JSON.stringify(descriptor.result.jsonSchema)),
    'both faces must publish the same result JSON Schema',
  );
});

test('the strict result codec accepts only the documented outcome shape', () => {
  const descriptor = validatedDescriptor();
  const schema = descriptor.result.create();
  const parsed = schema.parse(validResult()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [...RESULT_FIELDS].sort(), 'parsed result must carry exactly the documented fields');
  assert.equal(parsed.code, 'OK');
  assert.deepEqual(parsed.route, { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' });
  assert.notEqual(parsed, validResult(), 'the parser must detach its result from the caller value');

  const rejects: Array<[string, Record<string, unknown>]> = [
    ['an undeclared field (model prose or a session log cannot cross the wire)', validResult({ prose: 'model output' })],
    ['a missing field', (() => { const value = validResult(); delete value.detail; return value; })()],
    ['an unknown code', validResult({ code: 'SOMETHING_ELSE' })],
    ['an unknown status', validResult({ status: 'fine' })],
    ['an unknown auth kind', validResult({ authKind: 'oauth' })],
    ['a non-array credentialEnv', validResult({ credentialEnv: 'DEEPSEEK_API_KEY' })],
    ['a negative latency', validResult({ latencyMs: -1 })],
    ['a non-finite retry delay', validResult({ retryAfterMs: Number.POSITIVE_INFINITY })],
    ['a malformed route', validResult({ route: { provider: 'p' } })],
    ['a non-boolean effort flag', validResult({ effortNotAdvertised: 'no' })],
  ];
  for (const [label, value] of rejects) {
    assert.throws(() => schema.parse(value), TypeError, `the codec must reject ${label}`);
  }
});

test('the result codec enforces both production wire boundaries', () => {
  const descriptor = validatedDescriptor();
  const codec = descriptor.result;
  // The Host Gateway calls `codec.encode(value, writeBytes)` before framing;
  // the Client Gateway calls `codec.decode(value)` after reconstruction. Both
  // must be the same strict, detaching parser, not merely a test-only parse().
  assert.equal(typeof codec.encode, 'function', 'the result codec must expose the Host encode boundary');
  assert.equal(typeof codec.decode, 'function', 'the result codec must expose the Client decode boundary');

  for (const [boundary, transform] of [
    ['encode', codec.encode as (value: unknown) => unknown],
    ['decode', codec.decode as (value: unknown) => unknown],
  ] as const) {
    const input = validResult();
    const output = transform(input);
    assert.notEqual(output, input, `${boundary} must detach its result from the caller value`);
    assert.deepEqual(
      Object.keys(output as Record<string, unknown>).sort(),
      [...RESULT_FIELDS].sort(),
      `${boundary} must emit exactly the documented wire fields`,
    );
    assert.equal((output as Record<string, unknown>).code, 'OK', `${boundary} must accept a documented result`);

    for (const [label, value] of [
      ['an undeclared prose field', validResult({ prose: 'model output' })],
      ['an undeclared conversation log field', validResult({ messages: [{ role: 'user' }] })],
      ['a missing field', (() => { const missing = validResult(); delete missing.detail; return missing; })()],
      ['an unknown outcome code', validResult({ code: 'SOMETHING_ELSE' })],
      ['a negative latency', validResult({ latencyMs: -1 })],
    ] as const) {
      assert.throws(
        () => transform(value),
        TypeError,
        `${boundary} must reject ${label} at the production boundary`,
      );
    }
  }

  // Encoding then decoding is identity over a detached, validated value.
  assert.deepEqual(
    codec.decode?.(codec.encode?.(validResult(), () => null)),
    validResult(),
  );
});

test('the result JSON Schema enumerates every outcome code the Host can report', () => {
  const descriptor = validatedDescriptor();
  const jsonSchema = descriptor.result.jsonSchema as {
    properties: { code: { enum: string[] }; status: { enum: string[] } };
    additionalProperties?: boolean;
  };
  assert.equal(jsonSchema.additionalProperties, false, 'the wire result must not admit undeclared fields');
  const codes = jsonSchema.properties.code.enum;
  for (const expected of ['OK', 'ROUTE_INCOMPLETE', 'NO_ADAPTER', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_AUTH_FAILED', 'ACCOUNT_CONNECTION', 'TIMEOUT', 'RATE_LIMIT', 'RATE_LIMITED', 'EMPTY_RESPONSE', 'UNKNOWN']) {
    assert.ok(codes.includes(expected), `the result schema must enumerate ${expected}`);
  }
  assert.deepEqual(jsonSchema.properties.status.enum, ['ok', 'warning', 'error', 'blocked']);
});

test('generated artifacts import no runtime package (no zod, no Harness package)', () => {
  for (const file of ['lib/typert.host.js', 'lib/typert.remote-client.js', 'lib/typert.contract.js']) {
    const source = fs.readFileSync(path.join(PKG_ROOT, file), 'utf8');
    assert.ok(
      !/from\s+['"](?:zod|@deepseek-ai\/)/.test(source),
      `${file} must not import zod or a Harness package (a linked package cannot resolve them)`,
    );
    assert.ok(!/\brequire\(['"](?:zod|@deepseek-ai\/)/.test(source), `${file} must not require zod or a Harness package`);
  }
});

test('the browser bundle mounts this package\'s ./remote contribution', () => {
  const bundle = fs.readFileSync(path.join(PKG_ROOT, 'client', 'client.js'), 'utf8');
  assert.match(
    bundle,
    /window\.__ModuleLoader__\.load/,
    'the browser bundle must register through the module loader',
  );
  const registrations: Array<{ id: string; chunk?: string; factory: (require: (specifier: string) => unknown) => Record<string, unknown> }> = [];
  const fakeReact = {
    createElement: (type: unknown, props?: unknown) => ({ type, props }),
    useState: (initial: unknown) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (callback: unknown) => callback,
    useRef: (initial: unknown) => ({ current: initial }),
  };
  const factories = new Map<string, (require: (specifier: string) => unknown) => Record<string, unknown>>();
  const stripClientSuffix = (specifier: string): string => (
    specifier.endsWith('/client') ? specifier.slice(0, -'/client'.length) : specifier
  );
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (registration: typeof registrations[number]) => { registrations.push(registration); } } },
    document: undefined,
    console,
  });
  vm.runInContext(bundle, context);
  for (const registration of registrations) {
    const ownerId = stripClientSuffix(registration.id);
    const id = registration.chunk === undefined ? ownerId : `${ownerId}/${registration.chunk}`;
    assert.ok(!factories.has(id), `the bundle must not register "${id}" twice`);
    factories.set(id, registration.factory);
  }
  assert.deepEqual(
    registrations.map((registration) => [registration.id, registration.chunk ?? '']),
    [
      ['@aghost-prj/dsh-auto-review-model', 'client.remote.js'],
      ['@aghost-prj/dsh-auto-review-model', ''],
    ],
    'the bundle must register the ./remote chunk factory before the main factory',
  );
  const requireFromTable = (specifier: string): unknown => {
    if (specifier === 'react') return fakeReact;
    const id = stripClientSuffix(specifier);
    const factory = factories.get(id);
    if (factory === undefined) throw new Error(`module table missed ${specifier}`);
    return factory(requireFromTable);
  };
  const main = factories.get('@aghost-prj/dsh-auto-review-model')?.(requireFromTable) as Record<string, unknown>;
  assert.equal(typeof main.apply, 'function');
  const mounted = factories.get('@aghost-prj/dsh-auto-review-model/client.remote.js')?.(requireFromTable) as {
    TYPERT_REMOTE: Contribution;
    default: Contribution;
  };
  assert.equal(mounted.default, mounted.TYPERT_REMOTE);
  assert.equal(mounted.TYPERT_REMOTE.package, ENDPOINT.package);
  assert.equal(
    mounted.TYPERT_REMOTE.descriptors[0].id,
    ENDPOINT.invocationId,
    'the browser-embedded contribution must match the ./remote artifact identity',
  );
  assert.equal(
    mounted.TYPERT_REMOTE.descriptors[0].result.typeSymbol,
    (REMOTE_MODULE.TYPERT_REMOTE.descriptors[0] as Descriptor).result.typeSymbol,
    'the browser-embedded codec must match the shipped ./remote artifact',
  );
});

test('package exports expose the Typert faces and ship their built files', () => {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    exports: Record<string, unknown>;
    files: string[];
  };
  const target = (entry: unknown): string => {
    if (typeof entry === 'string') return entry;
    const record = entry as Record<string, unknown> | null;
    return record !== null && typeof record === 'object' && typeof record.default === 'string'
      ? record.default
      : '';
  };
  assert.equal(target(pkg.exports['./typert']), './lib/typert.host.js');
  assert.equal(target(pkg.exports['./remote']), './lib/typert.remote-client.js');
  assert.equal(typeof (pkg.exports['./typert'] as Record<string, unknown>).types, 'string');
  assert.equal(typeof (pkg.exports['./remote'] as Record<string, unknown>).types, 'string');
  for (const artifact of ['lib', 'client', 'src']) {
    assert.ok(pkg.files.includes(artifact), `files must ship ${artifact}`);
  }
  for (const file of ['lib/typert.host.js', 'lib/typert.host.d.ts', 'lib/typert.remote-client.js', 'lib/typert.contract.js']) {
    assert.ok(fs.existsSync(path.join(PKG_ROOT, file)), `${file} must exist in the build output`);
  }
  assert.ok(
    !JSON.stringify(pkg).includes('"zod"'),
    'the package must not declare a zod dependency for the hand-written artifacts',
  );
});
