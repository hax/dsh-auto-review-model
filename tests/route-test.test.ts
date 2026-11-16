/**
 * Host endpoint tests for the safe saved review-route test.
 *
 * The LLM service is faked in-process: `stream`, `resolveModelInfo`, and
 * `listConfigurableProviders` are recorded closures, so every assertion can
 * inspect the exact `GenerateOptions` the Host built and every failure can be
 * injected without network access. A fake Cordis context captures what
 * `ctx.provide` publishes and verifies the manual `typertRemote` Gateway
 * binding. Every returned result is also validated by the package's strict
 * wire codec, so the Host and the Client contribution cannot drift.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __testing,
  buildRouteTestRequest,
  checkRouteTestThrottle,
  classifyRouteTestFailure,
  classifyRouteTestProvider,
  createRouteTestState,
  installRouteTestEndpoint,
  markRouteTestStarted,
  normalizeFailureCode,
  readFinishFailure,
  readThrownFailure,
  routeTestStatusOf,
} from '../src/route-test.js';
import type {
  RouteTestContext,
  RouteTestGenerateOptions,
  RouteTestModelInfoLike,
  RouteTestOptions,
  RouteTestProviderLike,
} from '../src/route-test.js';
import { createResultSchema } from '../src/typert.contract.js';
import type { ReviewRouteTestResult } from '../src/typert.contract.js';
import type { ReviewerConfig } from '../src/policy.js';

/** One fake stream chunk; the shape is intentionally loose like real wire chunks. */
interface TestChunk {
  type: string;
  [key: string]: unknown;
}

/** Fake model-info resolver. */
type ModelInfoFn = (
  provider: string,
  model: string,
  signal?: AbortSignal,
) => Promise<RouteTestModelInfoLike | undefined> | RouteTestModelInfoLike | undefined;

/** Fake stream factory. */
type StreamFactory = (options?: RouteTestGenerateOptions) => AsyncIterable<TestChunk>;

/** Mutable reviewer settings the live config refs read. */
interface ReviewerState {
  enabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
}

/** Options accepted by {@link createHarness}. */
interface HarnessOptions {
  config?: Partial<ReviewerState>;
  directory?: RouteTestProviderLike[];
  modelInfo?: ModelInfoFn;
  stream?: StreamFactory;
  endpointOptions?: RouteTestOptions;
}

/** Fake Host environment returned by {@link createHarness}. */
interface Harness {
  state: ReviewerState;
  configRefs: ReviewerConfig;
  ctx: RouteTestContext;
  provided: Array<{ name: string; value: unknown }>;
  streamCalls: RouteTestGenerateOptions[];
  resolveCalls: Array<{ provider: string; model: string; signal?: AbortSignal }>;
  endpoint: TestRouteEndpoint;
  advance(ms: number): void;
  invoke(options?: { signal?: AbortSignal; extraArgs?: unknown[] }): Promise<ReviewRouteTestResult>;
}

/** The published endpoint shape as the Remote carrier calls it. */
interface TestRouteEndpoint {
  testReviewRoute(signal?: AbortSignal): Promise<ReviewRouteTestResult>;
}

/** Strict codec the Gateway and Client mount validate results with. */
const parseWireResult = createResultSchema().parse;

/**
 * The exact directory entry the installed `@deepseek-ai/dsh-llm-deepseek-account`
 * adapter registers in DSH 0.2.2-rc.3: provider/displayName/settingsNs/
 * settingsPath only — there is NO `nativeAuth` field to read.
 */
const DEEPSEEK_ACCOUNT_OFFICIAL_ENTRY: RouteTestProviderLike = {
  provider: 'deepseek-account',
  displayName: 'DeepSeek Account',
  settingsNs: 'llm-deepseek-account',
  settingsPath: [],
};

/**
 * The exact directory entry the installed `@deepseek-ai/dsh-llm-deepseek-api-key`
 * adapter registers in DSH 0.2.2-rc.3: also no `nativeAuth`, so no credential
 * environment variable names exist for it and none may be invented.
 */
const DEEPSEEK_API_KEY_OFFICIAL_ENTRY: RouteTestProviderLike = {
  provider: 'deepseek-official',
  displayName: 'DeepSeek',
  settingsNs: 'llm-deepseek-api-key',
  settingsPath: [],
};

/** A declared-OAuth entry, covering the supported `nativeAuth.oauth` branch. */
const DECLARED_OAUTH_ENTRY: RouteTestProviderLike = {
  provider: 'signed-in-provider',
  displayName: 'Signed In Provider',
  settingsNs: 'llm.signed-in',
  settingsPath: [],
  nativeAuth: { oauth: true, env: [] },
};

/** Assert a raw value is exactly the strict, prose-free wire result. */
function strictResult(value: unknown): ReviewRouteTestResult {
  const parsed = parseWireResult(value);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed, 'result must survive a JSON boundary losslessly');
  return parsed;
}

/** Assert one result is a local refusal / failure with the expected code and tone. */
function assertResultCode(result: ReviewRouteTestResult, code: ReviewRouteTestResult['code'], status: ReviewRouteTestResult['status']): void {
  assert.equal(result.code, code);
  assert.equal(result.status, status);
  strictResult(result);
}

/** Build a generator yielding exactly the supplied chunks. */
async function* streamOf(chunks: readonly TestChunk[]): AsyncGenerator<TestChunk> {
  for (const chunk of chunks) yield chunk;
}

/** A successful probe stream that carries one text block. */
function okStream(text = 'OK'): StreamFactory {
  return () => streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
}

/** A terminal-error probe stream that also carries one text delta first. */
function finishErrorStream(
  code: string,
  options: { status?: number; message?: string; retryAfterMs?: number; kind?: 'error' | 'aborted' } = {},
): StreamFactory {
  const failure: Record<string, unknown> = { code };
  if (options.status !== undefined) failure.status = options.status;
  if (options.message !== undefined) failure.message = options.message;
  if (options.retryAfterMs !== undefined) failure.providerRetryAfterMs = options.retryAfterMs;
  return () => streamOf([
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: options.kind ?? 'error', failure } },
  ]);
}

/** A stream whose iteration throws one Harness-style error. */
function throwingStream(makeError: () => unknown): StreamFactory {
  return () => (async function* failingStream(): AsyncGenerator<TestChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    throw makeError();
  })();
}

/** A stream that never produces a chunk until its consumer aborts. */
function hangingStream(tracker?: { closed: boolean; consumed: number }): StreamFactory {
  return () => ({
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<TestChunk>> {
          return new Promise<IteratorResult<TestChunk>>(() => {});
        },
        return(): Promise<IteratorResult<TestChunk>> {
          if (tracker !== undefined) tracker.closed = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  });
}

/** A generator tracking how many chunks were consumed and whether it was closed. */
function trackedStream(
  chunks: readonly TestChunk[],
  tracker: { closed: boolean; consumed: number },
): StreamFactory {
  return () => (async function* tracked(): AsyncGenerator<TestChunk> {
    try {
      for (const chunk of chunks) {
        tracker.consumed += 1;
        yield chunk;
      }
    } finally {
      tracker.closed = true;
    }
  })();
}

/** One manually settled promise. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/** Create one manually settled promise. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Let queued promise settlement handlers and zero-delay timers run. */
async function settleTick(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

/**
 * Run one body while asserting that no later provider promise rejection leaks
 * as an unhandled rejection after the endpoint has returned.
 */
async function withUnhandledWatch(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await body();
  } finally {
    await settleTick();
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, [], 'no late provider rejection may surface as unhandled');
}

/**
 * A stream whose pending `next()` rejects when the probe signal aborts.
 *
 * This models a cooperative adapter: cancellation settles the provider
 * operation, so the single-flight slot is released honestly.
 */
function abortAwareStream(tracker?: { closed: boolean }): StreamFactory {
  return (options) => ({
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<TestChunk>> {
          return new Promise<IteratorResult<TestChunk>>((_resolve, reject) => {
            const signal = options?.signal;
            if (signal === undefined) return; // never settles without a signal
            const fail = (): void => { reject(signal.reason); };
            if (signal.aborted) {
              fail();
              return;
            }
            signal.addEventListener('abort', fail, { once: true });
          });
        },
        return(): Promise<IteratorResult<TestChunk>> {
          if (tracker !== undefined) tracker.closed = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  });
}

/** A stream whose first `next()` returns a manually settled promise, forever. */
function deferredNextStream(gate: Deferred<IteratorResult<TestChunk>>): StreamFactory {
  return () => ({
    [Symbol.asyncIterator]() {
      return {
        next: () => gate.promise,
        return: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
  });
}

/**
 * A custom stream WITHOUT `return()` whose first next() already settles with
 * oversize content; any later next() would hang. This is the reviewer repro for
 * a non-terminal early exit on an unclosable stream.
 */
function oversizeNoReturnStream(): AsyncIterable<TestChunk> {
  return {
    [Symbol.asyncIterator]() {
      let step = 0;
      return {
        next(): Promise<IteratorResult<TestChunk>> {
          step += 1;
          if (step === 1) {
            return Promise.resolve({
              done: false,
              value: { type: 'text-delta', index: 0, text: 'x'.repeat(100) },
            });
          }
          return new Promise<IteratorResult<TestChunk>>(() => {});
        },
      };
    },
  };
}

/** A custom stream WITHOUT `return()` that reports a terminal finish chunk. */
function finishNoReturnStream(): AsyncIterable<TestChunk> {
  return {
    [Symbol.asyncIterator]() {
      let step = 0;
      return {
        next(): Promise<IteratorResult<TestChunk>> {
          step += 1;
          if (step === 1) {
            return Promise.resolve({ done: false, value: { type: 'text-delta', index: 0, text: 'OK' } });
          }
          if (step === 2) {
            return Promise.resolve({ done: false, value: { type: 'finish', reason: { kind: 'stop' } } });
          }
          return new Promise<IteratorResult<TestChunk>>(() => {});
        },
      };
    },
  };
}

/** A custom stream WITHOUT `return()` that ends naturally via `step.done`. */
function endedNoReturnStream(): AsyncIterable<TestChunk> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
  };
}

/** A stream that finishes after one text delta, then hangs in `return()`. */
function finishThenHangingClose(gate: Deferred<IteratorResult<TestChunk>>): StreamFactory {
  return () => {
    let step = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<TestChunk>> {
            step += 1;
            return Promise.resolve(step === 1
              ? { done: false, value: { type: 'text-delta', index: 0, text: 'OK' } }
              : { done: false, value: { type: 'finish', reason: { kind: 'stop' } } });
          },
          return(): Promise<IteratorResult<TestChunk>> {
            return gate.promise;
          },
        };
      },
    };
  };
}

/** Build one fake Harness-style LLM error carrying a stable code and optional status. */
function llmError(
  code: string,
  message = 'provider failed',
  status?: number,
): Error & { code: string; status?: number; failure: Record<string, unknown> } {
  const error = new Error(message) as Error & {
    code: string;
    status?: number;
    failure: Record<string, unknown>;
  };
  error.code = code;
  if (status !== undefined) error.status = status;
  error.failure = { code, message, ...status === undefined ? {} : { status } };
  return error;
}

/** Live config refs over one mutable settings object, like volatile loader config. */
function createReviewerConfig(state: ReviewerState): ReviewerConfig {
  return {
    enabled: { get: () => state.enabled },
    provider: { get: () => state.provider },
    model: { get: () => state.model },
    reasoningEffort: { get: () => state.reasoningEffort },
  };
}

/**
 * Build one fake Host environment around the real endpoint installer.
 *
 * @param options - settings, fakes, and endpoint tuning.
 * @returns the fake context, recorded calls, and a stable invocation helper.
 */
function createHarness(options: HarnessOptions = {}): Harness {
  const state: ReviewerState = {
    enabled: true,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: '',
    ...options.config,
  };
  let clock = 1_000_000;
  const provided: Array<{ name: string; value: unknown }> = [];
  const streamCalls: RouteTestGenerateOptions[] = [];
  const resolveCalls: Array<{ provider: string; model: string; signal?: AbortSignal }> = [];
  const directory = options.directory ?? [DEEPSEEK_ACCOUNT_OFFICIAL_ENTRY];
  const modelInfo: ModelInfoFn = options.modelInfo
    ?? (() => ({ reasoning: { efforts: [{ id: 'max' }, { id: 'high' }] } }));
  const streamFactory: StreamFactory = options.stream ?? okStream();
  const llm = {
    stream(generate: RouteTestGenerateOptions): AsyncIterable<TestChunk> {
      streamCalls.push(generate);
      return streamFactory(generate);
    },
    resolveModelInfo(
      provider: string,
      model: string,
      signal?: AbortSignal,
    ): Promise<RouteTestModelInfoLike | undefined> | RouteTestModelInfoLike | undefined {
      resolveCalls.push({ provider, model, signal });
      return modelInfo(provider, model, signal);
    },
    listConfigurableProviders(): readonly RouteTestProviderLike[] {
      return directory;
    },
  };
  const ctx: RouteTestContext = {
    llm,
    provide(name: string, value: unknown): unknown {
      provided.push({ name, value });
      return () => {};
    },
  };
  const configRefs = createReviewerConfig(state);
  installRouteTestEndpoint(ctx, configRefs, {
    now: () => clock,
    minIntervalMs: 0,
    windowMs: 60_000,
    maxPerWindow: 1_000,
    timeoutMs: 1_000,
    ...options.endpointOptions,
  });
  const published = provided[0];
  assert.ok(published !== undefined, 'installRouteTestEndpoint must publish one service');
  const endpoint = published.value as TestRouteEndpoint;

  return {
    state,
    configRefs,
    ctx,
    provided,
    streamCalls,
    resolveCalls,
    endpoint,
    advance(ms: number): void {
      clock += ms;
    },
    invoke(invokeOptions = {}): Promise<ReviewRouteTestResult> {
      const method = endpoint.testReviewRoute as unknown as (
        signal?: AbortSignal,
        ...rest: unknown[]
      ) => Promise<ReviewRouteTestResult>;
      return invokeOptions.extraArgs === undefined
        ? method.call(endpoint, invokeOptions.signal)
        : method.call(endpoint, invokeOptions.signal, ...invokeOptions.extraArgs);
    },
  };
}

test('installRouteTestEndpoint publishes the strict Gateway-bound endpoint once', () => {
  const harness = createHarness();
  assert.equal(harness.provided.length, 1);
  const published = harness.provided[0]!;
  assert.equal(published.name, 'autoReviewModel');
  assert.equal(published.name, __testing.REMOTE_SERVICE_KEY);
  const endpoint = published.value as TestRouteEndpoint & {
    typertRemote?: { service: unknown; serviceKey: string; namespace: string };
  };
  assert.equal(typeof endpoint.testReviewRoute, 'function');
  assert.ok(endpoint.typertRemote, 'published endpoint must carry the visible typertRemote binding');
  assert.equal(endpoint.typertRemote.service, endpoint, 'binding.service must be the published object itself');
  assert.equal(endpoint.typertRemote.serviceKey, 'autoReviewModel');
  assert.equal(endpoint.typertRemote.namespace, 'autoReviewModel');
  assert.ok(Object.isFrozen(endpoint), 'the published endpoint must be frozen');
  assert.ok(Object.isFrozen(endpoint.typertRemote), 'the visible binding must be frozen');
});

test('probe request is the fixed harmless one-shot with no session or tool fields', async () => {
  const harness = createHarness({ config: { reasoningEffort: 'max' } });
  const result = await harness.invoke();
  assertResultCode(result, 'OK', 'ok');
  assert.equal(result.route.provider, 'deepseek-account');
  assert.equal(result.route.model, 'deepseek-flash');
  assert.equal(result.route.reasoningEffort, 'max');
  assert.equal(result.authKind, 'account');
  assert.equal(result.providerName, 'DeepSeek Account');
  assert.equal(result.settingsNs, 'llm-deepseek-account');
  assert.deepEqual(result.credentialEnv, []);
  assert.equal(result.effortUsed, 'max');
  assert.equal(result.effortNotAdvertised, false);
  assert.equal(result.failureCode, '');
  assert.equal(result.detail, '');
  assert.ok(result.latencyMs >= 0);
  assert.equal(result.retryAfterMs, 0);

  assert.equal(harness.streamCalls.length, 1);
  const request = harness.streamCalls[0]!;
  assert.deepEqual(Object.keys(request).sort(), [
    'maxTokens',
    'messages',
    'model',
    'provider',
    'reasoningEffort',
    'signal',
    'system',
    'temperature',
  ]);
  assert.equal(request.provider, 'deepseek-account');
  assert.equal(request.model, 'deepseek-flash');
  assert.equal(request.reasoningEffort, 'max');
  assert.equal(request.system, __testing.ROUTE_TEST_SYSTEM_PROMPT);
  assert.equal(request.maxTokens, __testing.ROUTE_TEST_MAX_TOKENS);
  assert.ok(request.maxTokens <= 16);
  assert.equal(request.temperature, 0);
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(request.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Reply with OK' }] },
  ]);
  for (const forbidden of ['sessionId', 'purpose', 'tools', 'toolHistory', 'history']) {
    assert.ok(!(forbidden in request), `probe request must not carry ${forbidden}`);
  }
  assert.equal(
    request.signal.aborted,
    false,
    'a normal terminal probe must not abort its request signal',
  );
});

test('probe reads the saved route live and never mutates settings', async () => {
  const harness = createHarness();
  const before = JSON.stringify(harness.state);
  await harness.invoke();
  harness.state.provider = 'second-provider';
  harness.state.model = 'second-model';
  harness.state.reasoningEffort = 'max';
  const result = await harness.invoke();
  assertResultCode(result, 'OK', 'ok');
  assert.deepEqual(harness.streamCalls.map(call => [call.provider, call.model]), [
    ['deepseek-account', 'deepseek-flash'],
    ['second-provider', 'second-model'],
  ]);
  assert.equal(result.route.provider, 'second-provider');
  assert.equal(result.route.model, 'second-model');
  assert.equal(result.effortUsed, 'max');
  assert.equal(harness.resolveCalls.length, 1, 'only the second probe had a saved effort to verify');
  assert.equal(harness.resolveCalls[0]!.provider, 'second-provider');
  assert.equal(harness.state.provider, 'second-provider');
  assert.equal(harness.state.model, 'second-model');
  assert.equal(JSON.stringify(harness.state), JSON.stringify({
    enabled: true,
    provider: 'second-provider',
    model: 'second-model',
    reasoningEffort: 'max',
  }), 'settings must not be rewritten by the probe');
  assert.notEqual(before, JSON.stringify(harness.state), 'sanity: the test itself changed the saved route');
});

test('saved effort is sent only when the route advertises it', async () => {
  // Supported effort: retained in both the request and the report.
  const supported = createHarness({
    config: { reasoningEffort: 'max' },
    modelInfo: () => ({ reasoning: { efforts: [{ id: 'max' }] } }),
  });
  const supportedResult = await supported.invoke();
  assertResultCode(supportedResult, 'OK', 'ok');
  assert.equal(supported.streamCalls[0]!.reasoningEffort, 'max');
  assert.equal(supportedResult.effortUsed, 'max');
  assert.equal(supportedResult.effortNotAdvertised, false);

  // Unadvertised effort: omitted from the request, reported as not advertised.
  const unadvertised = createHarness({
    config: { reasoningEffort: 'max' },
    modelInfo: () => ({ reasoning: { efforts: [{ id: 'high' }] } }),
  });
  const unadvertisedResult = await unadvertised.invoke();
  assertResultCode(unadvertisedResult, 'OK', 'ok');
  assert.equal('reasoningEffort' in unadvertised.streamCalls[0]!, false);
  assert.equal(unadvertisedResult.effortUsed, '');
  assert.equal(unadvertisedResult.effortNotAdvertised, true);

  // No saved effort: no capability round-trip is made at all.
  const inherited = createHarness({ modelInfo: () => ({ reasoning: { efforts: [{ id: 'max' }] } }) });
  const inheritedResult = await inherited.invoke();
  assertResultCode(inheritedResult, 'OK', 'ok');
  assert.equal(inherited.resolveCalls.length, 0);
  assert.equal('reasoningEffort' in inherited.streamCalls[0]!, false);
  assert.equal(inheritedResult.effortUsed, '');
  assert.equal(inheritedResult.effortNotAdvertised, false);
});

test('probe discards model prose and returns classification metadata only', async () => {
  const tracker = { closed: false, consumed: 0 };
  const harness = createHarness({
    stream: trackedStream([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'MODEL_PROSE_MARKER_ONE' },
      { type: 'text-delta', index: 0, text: 'MODEL_PROSE_MARKER_TWO' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'MODEL_PROSE_MARKER_ONE_MODEL_PROSE_MARKER_TWO' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ], tracker),
  });
  const result = await harness.invoke();
  assertResultCode(result, 'OK', 'ok');
  const wire = JSON.stringify(result);
  assert.ok(!wire.includes('MODEL_PROSE'), 'no model prose may reach the result');
  assert.ok(tracker.consumed > 0, 'the probe must actually consume the stream');
  assert.ok(tracker.closed, 'the probe must close the model stream even after a terminal finish');
});

test('EMPTY_RESPONSE is a warning and carries no model output', async () => {
  const emptySuccess = createHarness({
    stream: () => streamOf([{ type: 'finish', reason: { kind: 'stop' } }]),
  });
  const successResult = await emptySuccess.invoke();
  assertResultCode(successResult, 'EMPTY_RESPONSE', 'warning');
  assert.equal(successResult.detail, __testing.ROUTE_TEST_DETAILS.EMPTY_RESPONSE);

  const emptyFailure = createHarness({ stream: finishErrorStream('EMPTY_RESPONSE') });
  const failureResult = await emptyFailure.invoke();
  assertResultCode(failureResult, 'EMPTY_RESPONSE', 'warning');
  assert.equal(failureResult.failureCode, 'EMPTY_RESPONSE');
});

test('structurally empty streams report EMPTY_RESPONSE instead of OK', async () => {
  // Reviewer boundary: block-start and an empty text block are structure, not
  // model content, so neither stream may be reported as a successful answer.
  const cases: Array<{ name: string; chunks: TestChunk[] }> = [
    {
      name: 'block-start then empty text block',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
    {
      name: 'block-start then finish',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  for (const entry of cases) {
    const tracker = { closed: false, consumed: 0 };
    const harness = createHarness({ stream: trackedStream(entry.chunks, tracker) });
    const result = await harness.invoke();
    assertResultCode(result, 'EMPTY_RESPONSE', 'warning');
    assert.equal(result.failureCode, '');
    assert.equal(result.detail, __testing.ROUTE_TEST_DETAILS.EMPTY_RESPONSE);
    assert.ok(tracker.closed, `${entry.name}: the consumed stream must be closed`);
  }

  // A normal short reply still carries real content and stays OK.
  assertResultCode(await createHarness({ stream: okStream() }).invoke(), 'OK', 'ok');
});

test('the official DeepSeek Account entry (no nativeAuth) maps account failures', async () => {
  const cases: Array<{ failure: string; status?: number; expected: ReviewRouteTestResult['code'] }> = [
    { failure: 'ACCOUNT_SIGN_IN_REQUIRED', expected: 'ACCOUNT_SIGN_IN_REQUIRED' },
    { failure: 'MISSING_CREDENTIAL', expected: 'ACCOUNT_SIGN_IN_REQUIRED' },
    { failure: 'NO_CREDENTIAL_STORE', expected: 'ACCOUNT_SIGN_IN_REQUIRED' },
    { failure: 'ACCOUNT_TOKEN_INVALID', expected: 'ACCOUNT_AUTH_FAILED' },
    { failure: 'INVALID_CREDENTIAL', expected: 'ACCOUNT_AUTH_FAILED' },
    { failure: 'AUTH', expected: 'ACCOUNT_AUTH_FAILED' },
    { failure: 'HTTP_401', expected: 'ACCOUNT_AUTH_FAILED' },
    { failure: 'HTTP_403', expected: 'ACCOUNT_AUTH_FAILED' },
    { failure: 'TRANSPORT', expected: 'ACCOUNT_CONNECTION' },
    { failure: 'SERVER', expected: 'ACCOUNT_CONNECTION' },
    { failure: 'STREAM_CLOSED', expected: 'ACCOUNT_CONNECTION' },
    { failure: 'HTTP_500', expected: 'ACCOUNT_CONNECTION' },
    { failure: 'HTTP_503', expected: 'ACCOUNT_CONNECTION' },
    { failure: 'UNKNOWN_PROVIDER_CODE', status: 500, expected: 'ACCOUNT_CONNECTION' },
  ];
  for (const entry of cases) {
    const harness = createHarness({
      directory: [DEEPSEEK_ACCOUNT_OFFICIAL_ENTRY],
      stream: finishErrorStream(entry.failure, { status: entry.status }),
    });
    const result = await harness.invoke();
    assertResultCode(result, entry.expected, 'error');
    assert.equal(result.authKind, 'account', `official deepseek-account must stay an account route for ${entry.failure}`);
    assert.equal(result.providerName, 'DeepSeek Account');
    assert.equal(result.settingsNs, 'llm-deepseek-account');
    assert.deepEqual(result.credentialEnv, [], 'the official entry declares no credential env names');
    assert.ok(result.detail.length > 0, 'every failure must carry an actionable sentence');
  }
});

test('the official DeepSeek API-key entry (no nativeAuth) keeps API-key failures', async () => {
  const cases: Array<{ failure: string; status?: number; expected: ReviewRouteTestResult['code'] }> = [
    { failure: 'MISSING_CREDENTIAL', expected: 'MISSING_CREDENTIAL' },
    { failure: 'INVALID_CREDENTIAL', expected: 'INVALID_CREDENTIAL' },
    { failure: 'NO_CREDENTIAL_STORE', expected: 'NO_CREDENTIAL_STORE' },
    { failure: 'AUTH', expected: 'AUTH' },
    { failure: 'HTTP_401', expected: 'AUTH' },
    { failure: 'HTTP_403', expected: 'AUTH' },
    { failure: 'TRANSPORT', expected: 'CONNECTION' },
    { failure: 'SERVER', expected: 'CONNECTION' },
    { failure: 'STREAM_CLOSED', expected: 'CONNECTION' },
    { failure: 'HTTP_500', expected: 'CONNECTION' },
    { failure: 'HTTP_502', expected: 'CONNECTION' },
  ];
  for (const entry of cases) {
    const harness = createHarness({
      config: { provider: 'deepseek-official', model: 'deepseek-chat' },
      directory: [DEEPSEEK_API_KEY_OFFICIAL_ENTRY],
      stream: finishErrorStream(entry.failure, { status: entry.status }),
    });
    const result = await harness.invoke();
    assertResultCode(result, entry.expected, 'error');
    assert.equal(result.authKind, 'api-key');
    assert.equal(result.providerName, 'DeepSeek');
    assert.equal(result.settingsNs, 'llm-deepseek-api-key');
    assert.deepEqual(result.credentialEnv, [], 'official API-key entries declare no credential env names');
  }
});

test('provider-neutral capacity and terminal failures share one mapping', async () => {
  const cases: Array<{ failure: string; status?: number; expected: ReviewRouteTestResult['code']; wire?: string }> = [
    { failure: 'NO_ADAPTER', expected: 'NO_ADAPTER' },
    { failure: 'UNKNOWN_MODEL', expected: 'UNKNOWN_MODEL' },
    { failure: 'MODEL_UNSUPPORTED', expected: 'UNKNOWN_MODEL' },
    { failure: 'UNSUPPORTED_REASONING_EFFORT', expected: 'UNSUPPORTED_REASONING_EFFORT' },
    { failure: 'RATE_LIMIT', expected: 'RATE_LIMIT' },
    { failure: 'HTTP_429', expected: 'RATE_LIMIT' },
    { failure: 'QUOTA', expected: 'QUOTA' },
    { failure: 'ACCOUNT_QUOTA', expected: 'QUOTA' },
    { failure: 'HTTP_402', expected: 'QUOTA' },
    { failure: 'CONTEXT_WINDOW_EXCEEDED', expected: 'CONTEXT_WINDOW_EXCEEDED' },
    { failure: 'TIMEOUT', expected: 'TIMEOUT' },
    { failure: 'ABORTED', expected: 'CANCELLED' },
    { failure: 'EMPTY_RESPONSE', expected: 'EMPTY_RESPONSE' },
    // Unknown tokens are dropped from the wire while still classifying as UNKNOWN.
    { failure: 'SOMETHING_NEW', expected: 'UNKNOWN', wire: '' },
  ];
  for (const entry of cases) {
    const harness = createHarness({ stream: finishErrorStream(entry.failure, { status: entry.status }) });
    const result = await harness.invoke();
    assertResultCode(result, entry.expected, routeTestStatusOf(entry.expected));
    assert.equal(result.failureCode, entry.wire ?? entry.failure);
  }
});

test('classifyRouteTestFailure is pure and matches the end-to-end mapping', () => {
  assert.equal(classifyRouteTestFailure('MISSING_CREDENTIAL', 'account'), 'ACCOUNT_SIGN_IN_REQUIRED');
  assert.equal(classifyRouteTestFailure('MISSING_CREDENTIAL', 'api-key'), 'MISSING_CREDENTIAL');
  assert.equal(classifyRouteTestFailure('MISSING_CREDENTIAL', 'unknown'), 'MISSING_CREDENTIAL');
  assert.equal(classifyRouteTestFailure('AUTH', 'account'), 'ACCOUNT_AUTH_FAILED');
  assert.equal(classifyRouteTestFailure('', 'api-key', 401), 'AUTH');
  assert.equal(classifyRouteTestFailure('', 'account', 403), 'ACCOUNT_AUTH_FAILED');
  assert.equal(classifyRouteTestFailure('', 'api-key', 500), 'CONNECTION');
  assert.equal(classifyRouteTestFailure('', 'account', 503), 'ACCOUNT_CONNECTION');
  assert.equal(classifyRouteTestFailure('MODEL_UNSUPPORTED', 'account'), 'UNKNOWN_MODEL');
  assert.equal(classifyRouteTestFailure('ACCOUNT_TOKEN_INVALID', 'unknown'), 'ACCOUNT_AUTH_FAILED');
  assert.equal(classifyRouteTestFailure('SK-SECRET-abc123', 'api-key'), 'UNKNOWN');
  assert.equal(routeTestStatusOf('OK'), 'ok');
  assert.equal(routeTestStatusOf('EMPTY_RESPONSE'), 'warning');
  assert.equal(routeTestStatusOf('ROUTE_DISABLED'), 'blocked');
  assert.equal(routeTestStatusOf('CANCELLED'), 'blocked');
  assert.equal(routeTestStatusOf('AUTH'), 'error');
  assert.equal(normalizeFailureCode('auth'), 'AUTH');
  assert.equal(normalizeFailureCode('sk-AbC123Secret'), '');
  assert.equal(normalizeFailureCode('X'.repeat(41)), '');
});

test('provider classification trusts the official account id and declared auth', () => {
  // Missing directory entries fall back to the conventional account id shape.
  assert.equal(classifyRouteTestProvider('deepseek-account', []).authKind, 'account');
  assert.equal(classifyRouteTestProvider('my_account', []).authKind, 'account');
  assert.equal(classifyRouteTestProvider('mystery-provider', []).authKind, 'unknown');
  assert.equal(classifyRouteTestProvider('mystery-provider', []).providerName, 'mystery-provider');
  assert.equal(classifyRouteTestProvider('deepseek-account', []).settingsNs, '');
  assert.deepEqual(classifyRouteTestProvider('deepseek-account', []).credentialEnv, []);

  // HIGH regression: the official deepseek-account entry has NO nativeAuth field.
  const officialAccount = classifyRouteTestProvider('deepseek-account', [DEEPSEEK_ACCOUNT_OFFICIAL_ENTRY]);
  assert.equal(officialAccount.authKind, 'account');
  assert.equal(officialAccount.providerName, 'DeepSeek Account');
  assert.equal(officialAccount.settingsNs, 'llm-deepseek-account');
  assert.deepEqual(officialAccount.credentialEnv, []);

  // The official API-key entry also has no nativeAuth: API-key, no invented env.
  const officialApiKey = classifyRouteTestProvider('deepseek-official', [DEEPSEEK_API_KEY_OFFICIAL_ENTRY]);
  assert.equal(officialApiKey.authKind, 'api-key');
  assert.equal(officialApiKey.providerName, 'DeepSeek');
  assert.equal(officialApiKey.settingsNs, 'llm-deepseek-api-key');
  assert.deepEqual(officialApiKey.credentialEnv, []);

  // The supported declared-OAuth branch still classifies as an account route.
  assert.equal(classifyRouteTestProvider('signed-in-provider', [DECLARED_OAUTH_ENTRY]).authKind, 'account');

  // A declared API-key entry that really reports env names keeps reporting them.
  const declaredApiKey = classifyRouteTestProvider('custom-key', [{
    provider: 'custom-key',
    displayName: 'Custom Key',
    settingsNs: 'llm.custom',
    nativeAuth: { oauth: false, env: ['CUSTOM_API_KEY'] },
  }]);
  assert.equal(declaredApiKey.authKind, 'api-key');
  assert.deepEqual(declaredApiKey.credentialEnv, ['CUSTOM_API_KEY']);
});

test('the probe never leaks provider prose, messages, or credentials', async () => {
  const harness = createHarness({
    config: { provider: 'deepseek-official', model: 'deepseek-chat' },
    directory: [DEEPSEEK_API_KEY_OFFICIAL_ENTRY],
    stream: finishErrorStream('AUTH', {
      status: 401,
      message: 'invalid key sk-live-SECRET12345 and unauthorized MODEL_PROSE_MARKER',
    }),
  });
  const result = await harness.invoke();
  assertResultCode(result, 'AUTH', 'error');
  assert.equal(result.failureCode, 'AUTH');
  const wire = JSON.stringify(result);
  for (const leaked of ['sk-live-SECRET12345', 'SECRET12345', 'MODEL_PROSE_MARKER', 'invalid key']) {
    assert.ok(!wire.includes(leaked), `result must not leak ${JSON.stringify(leaked)}`);
  }
  // The official API-key entry declares no credential env names, so none is invented.
  assert.deepEqual(result.credentialEnv, []);
});

test('a throwing stream is reduced to a stable code without its raw message', async () => {
  const harness = createHarness({
    stream: throwingStream(() => llmError('NO_ADAPTER', 'secret-provider-detail-42')),
  });
  const result = await harness.invoke();
  assertResultCode(result, 'NO_ADAPTER', 'error');
  assert.equal(result.failureCode, 'NO_ADAPTER');
  assert.ok(!JSON.stringify(result).includes('secret-provider-detail-42'));
});

test('a thrown capability lookup failure maps like a terminal failure', async () => {
  const harness = createHarness({
    config: { reasoningEffort: 'max' },
    modelInfo: () => {
      throw llmError('NO_ADAPTER', 'no adapter for provider');
    },
  });
  const result = await harness.invoke();
  assertResultCode(result, 'NO_ADAPTER', 'error');
  assert.equal(harness.streamCalls.length, 0, 'a failed capability lookup must not stream');
});

test('undefined model information is reported as an unknown model, not a success', async () => {
  const harness = createHarness({
    config: { reasoningEffort: 'max' },
    modelInfo: () => undefined,
  });
  const result = await harness.invoke();
  assertResultCode(result, 'UNKNOWN_MODEL', 'error');
  assert.equal(harness.streamCalls.length, 0);
  assert.ok(result.detail.includes('model'));
});

test('the hard deadline aborts a hanging capability lookup', async () => {
  const harness = createHarness({
    config: { reasoningEffort: 'max' },
    endpointOptions: { timeoutMs: 25 },
    modelInfo: () => new Promise<RouteTestModelInfoLike | undefined>(() => {}),
  });
  const started = Date.now();
  const result = await harness.invoke();
  assertResultCode(result, 'TIMEOUT', 'error');
  assert.ok(Date.now() - started < 1_000, 'the deadline must reject promptly');
  assert.equal(harness.streamCalls.length, 0);
});

test('the hard deadline aborts and closes a hanging probe stream', async () => {
  const tracker = { closed: false, consumed: 0 };
  const harness = createHarness({
    stream: hangingStream(tracker),
    endpointOptions: { timeoutMs: 25 },
  });
  const started = Date.now();
  const result = await harness.invoke();
  assertResultCode(result, 'TIMEOUT', 'error');
  assert.ok(Date.now() - started < 1_000);
  assert.equal(harness.streamCalls.length, 1);
  assert.ok(tracker.closed, 'the aborted model stream must be closed');

  // The hanging next() never settles, so the single-flight slot stays held:
  // a second probe must not accumulate another provider stream.
  const busy = await harness.invoke();
  assertResultCode(busy, 'BUSY', 'blocked');
  assert.equal(harness.streamCalls.length, 1, 'an unsettled provider operation must block a second stream');

  // A fresh endpoint instance is unaffected.
  const healthy = createHarness();
  await healthy.invoke().then((later) => assertResultCode(later, 'OK', 'ok'));
});

test('a hanging close() keeps the endpoint responsive but holds the slot until it settles', async () => {
  await withUnhandledWatch(async () => {
    const gate = deferred<IteratorResult<TestChunk>>();
    let call = 0;
    const harness = createHarness({
      endpointOptions: { timeoutMs: 5_000 },
      stream: () => {
        call += 1;
        return call === 1 ? finishThenHangingClose(gate)() : okStream()();
      },
    });
    const started = Date.now();
    const result = await harness.invoke();
    assertResultCode(result, 'OK', 'ok');
    assert.ok(
      Date.now() - started < 1_500,
      `cleanup must stay bounded, took ${Date.now() - started}ms`,
    );

    // `return()` is still pending: the slot stays held, so no second provider
    // stream can start beside the orphaned cleanup.
    const busy = await harness.invoke();
    assertResultCode(busy, 'BUSY', 'blocked');
    assert.equal(harness.streamCalls.length, 1);

    // A late close settlement releases the slot for a later healthy test.
    gate.resolve({ done: true, value: undefined });
    await settleTick();
    assertResultCode(await harness.invoke(), 'OK', 'ok');
    assert.equal(harness.streamCalls.length, 2);
  });
});

test('caller cancellation wins over the deadline and releases the single-flight slot', async () => {
  // Pre-aborted signal: nothing runs and nothing is rate-limited.
  const preAborted = createHarness();
  const controller = new AbortController();
  controller.abort();
  const preResult = await preAborted.invoke({ signal: controller.signal });
  assertResultCode(preResult, 'CANCELLED', 'blocked');
  assert.equal(preAborted.streamCalls.length, 0);
  assert.equal(preAborted.resolveCalls.length, 0);

  // Abort while the stream waits: reported as cancelled, stream closed, and
  // the cooperative provider rejection releases the slot.
  const tracker = { closed: false, consumed: 0 };
  let call = 0;
  const harness = createHarness({
    endpointOptions: { timeoutMs: 5_000 },
    stream: (options) => {
      call += 1;
      return call === 1 ? abortAwareStream(tracker)(options) : okStream()(options);
    },
  });
  const running = new AbortController();
  const first = harness.invoke({ signal: running.signal });
  await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  running.abort();
  const cancelled = await first;
  assertResultCode(cancelled, 'CANCELLED', 'blocked');
  assert.ok(tracker.closed, 'the cancelled model stream must be closed');
  await settleTick();
  const later = await harness.invoke();
  assertResultCode(later, 'OK', 'ok');
  assert.equal(harness.streamCalls.length, 2);
});

test('a concurrent probe is refused globally with BUSY', async () => {
  const tracker = { closed: false, consumed: 0 };
  let call = 0;
  const harness = createHarness({
    endpointOptions: { minIntervalMs: 0, maxPerWindow: 1_000, timeoutMs: 5_000 },
    stream: (options) => {
      call += 1;
      return call === 1 ? abortAwareStream(tracker)(options) : okStream()(options);
    },
  });
  const controller = new AbortController();
  const first = harness.invoke({ signal: controller.signal });
  const busy = await harness.invoke();
  assertResultCode(busy, 'BUSY', 'blocked');
  assert.ok(busy.retryAfterMs >= 0);
  assert.equal(harness.streamCalls.length, 1, 'the refused probe must not reach the provider');
  controller.abort();
  assertResultCode(await first, 'CANCELLED', 'blocked');
  await settleTick();
  assertResultCode(await harness.invoke(), 'OK', 'ok');
});

test('the Host rate limit enforces the minimum interval and the window budget', async () => {
  const harness = createHarness({
    endpointOptions: {
      minIntervalMs: 1_000,
      windowMs: 10_000,
      maxPerWindow: 3,
      timeoutMs: 5_000,
    },
  });

  assertResultCode(await harness.invoke(), 'OK', 'ok');

  harness.advance(500);
  const tooSoon = await harness.invoke();
  assertResultCode(tooSoon, 'RATE_LIMITED', 'blocked');
  assert.equal(tooSoon.retryAfterMs, 500);

  harness.advance(500);
  assertResultCode(await harness.invoke(), 'OK', 'ok');
  harness.advance(1_000);
  assertResultCode(await harness.invoke(), 'OK', 'ok');

  harness.advance(1_000);
  const budget = await harness.invoke();
  assertResultCode(budget, 'RATE_LIMITED', 'blocked');
  assert.equal(budget.retryAfterMs, 7_000);

  harness.advance(8_001);
  assertResultCode(await harness.invoke(), 'OK', 'ok');
  assert.equal(harness.streamCalls.length, 4, 'only admitted probes reach the provider');
});

test('ROUTE_DISABLED and ROUTE_INCOMPLETE are blocked before any provider call', async () => {
  const disabled = createHarness({ config: { enabled: false } });
  assertResultCode(await disabled.invoke(), 'ROUTE_DISABLED', 'blocked');
  assert.equal(disabled.streamCalls.length, 0);

  const incompleteProvider = createHarness({ config: { provider: '' } });
  assertResultCode(await incompleteProvider.invoke(), 'ROUTE_INCOMPLETE', 'blocked');
  assert.equal(incompleteProvider.streamCalls.length, 0);

  const incompleteModel = createHarness({ config: { model: '' } });
  assertResultCode(await incompleteModel.invoke(), 'ROUTE_INCOMPLETE', 'blocked');
  assert.equal(incompleteModel.streamCalls.length, 0);
});

test('a premature stream end is reported as a connection failure', async () => {
  const account = createHarness({
    stream: () => streamOf([{ type: 'text-delta', index: 0, text: 'partial' }]),
  });
  const accountResult = await account.invoke();
  assertResultCode(accountResult, 'ACCOUNT_CONNECTION', 'error');
  assert.equal(accountResult.failureCode, 'STREAM_CLOSED');

  const apiKey = createHarness({
    config: { provider: 'deepseek-official', model: 'deepseek-chat' },
    directory: [DEEPSEEK_API_KEY_OFFICIAL_ENTRY],
    stream: () => streamOf([{ type: 'text-delta', index: 0, text: 'partial' }]),
  });
  const apiKeyResult = await apiKey.invoke();
  assertResultCode(apiKeyResult, 'CONNECTION', 'error');
  assert.equal(apiKeyResult.failureCode, 'STREAM_CLOSED');
});

test('model output is bounded even when a provider streams far too much', async () => {
  const chunks: TestChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }];
  for (let index = 0; index < 10_000; index += 1) {
    chunks.push({ type: 'text-delta', index: 0, text: 'MODEL_PROSE_MARKER' });
  }
  chunks.push({ type: 'finish', reason: { kind: 'stop' } });
  const tracker = { closed: false, consumed: 0 };
  const harness = createHarness({ stream: trackedStream(chunks, tracker) });
  const result = await harness.invoke();
  assertResultCode(result, 'UNKNOWN', 'error');
  assert.ok(!JSON.stringify(result).includes('MODEL_PROSE_MARKER'));
  assert.ok(
    tracker.consumed <= __testing.ROUTE_TEST_MAX_OUTPUT_CHUNKS + 1,
    `the probe must stop reading early, consumed ${tracker.consumed}`,
  );
  assert.ok(tracker.closed, 'the bounded probe must close the stream');
});

test('assembled blocks and tool-call payloads are bounded, not just deltas', async () => {
  const marker = 'MODEL_PROSE_MARKER';
  const huge = marker.repeat(6_000);
  const cases: Array<{ name: string; chunks: TestChunk[] }> = [
    {
      name: 'block-end text without deltas',
      chunks: [
        { type: 'block-end', index: 0, block: { type: 'text', text: huge } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
    {
      name: 'small deltas then a huge assembled block',
      chunks: [
        { type: 'text-delta', index: 0, text: 'OK' },
        { type: 'block-end', index: 0, block: { type: 'text', text: huge } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
    {
      name: 'block-end reasoning text',
      chunks: [
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: huge } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
    {
      name: 'block-end tool-call arguments',
      chunks: [
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'probe', arguments: huge } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
    {
      name: 'tool-call-delta arguments',
      chunks: [
        { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'probe', argumentsDelta: huge },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
    {
      name: 'unknown merge-extensible chunk content',
      chunks: [
        { type: 'future-content-chunk', index: 0, text: huge },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ];
  for (const entry of cases) {
    const tracker = { closed: false, consumed: 0 };
    const harness = createHarness({ stream: trackedStream(entry.chunks, tracker) });
    const result = await harness.invoke();
    assertResultCode(result, 'UNKNOWN', 'error');
    const wire = JSON.stringify(result);
    assert.ok(!wire.includes(marker), `${entry.name}: model prose must not reach the result`);
    assert.ok(wire.length < 2_000, `${entry.name}: result must stay small`);
    assert.ok(tracker.closed, `${entry.name}: the bounded stream must be closed`);
    assert.ok(tracker.consumed <= 2, `${entry.name}: the probe must stop at the huge value`);
  }

  // Sanity: harmless content of the same shapes still succeeds.
  assertResultCode(await createHarness({ stream: okStream() }).invoke(), 'OK', 'ok');
});

test('an unknown uppercase token can never reach the wire result', async () => {
  const harness = createHarness({
    stream: finishErrorStream('SECRET_TOKEN_12345', {
      message: 'provider echoed SECRET_TOKEN_12345 in its error',
    }),
  });
  const result = await harness.invoke();
  assertResultCode(result, 'UNKNOWN', 'error');
  assert.equal(result.failureCode, '');
  const wire = JSON.stringify(result);
  assert.ok(!wire.includes('SECRET_TOKEN_12345'), 'an unofficial token must be dropped');
  assert.ok(!wire.includes('provider echoed'), 'provider message text must never reach the result');
});

test('an unsettled capability lookup holds the slot and a late settle releases it', async () => {
  await withUnhandledWatch(async () => {
    const gate = deferred<RouteTestModelInfoLike | undefined>();
    let infoCalls = 0;
    const harness = createHarness({
      config: { reasoningEffort: 'max' },
      endpointOptions: { timeoutMs: 25, minIntervalMs: 0, maxPerWindow: 1_000 },
      modelInfo: () => {
        infoCalls += 1;
        return infoCalls === 1 ? gate.promise : { reasoning: { efforts: [{ id: 'max' }] } };
      },
    });
    const started = Date.now();
    assertResultCode(await harness.invoke(), 'TIMEOUT', 'error');
    assert.ok(Date.now() - started < 1_000, 'the endpoint must return on time');
    assertResultCode(await harness.invoke(), 'BUSY', 'blocked');
    assert.equal(harness.streamCalls.length, 0, 'no provider stream may start beside the orphaned lookup');
    gate.resolve({ reasoning: { efforts: [{ id: 'max' }] } });
    await settleTick();
    assertResultCode(await harness.invoke(), 'OK', 'ok');
    assert.equal(infoCalls, 2);
  });
});

test('a late capability rejection is observed and releases the slot', async () => {
  await withUnhandledWatch(async () => {
    const gate = deferred<RouteTestModelInfoLike | undefined>();
    let infoCalls = 0;
    const harness = createHarness({
      config: { reasoningEffort: 'max' },
      endpointOptions: { timeoutMs: 25, minIntervalMs: 0, maxPerWindow: 1_000 },
      modelInfo: () => {
        infoCalls += 1;
        return infoCalls === 1 ? gate.promise : { reasoning: { efforts: [{ id: 'max' }] } };
      },
    });
    assertResultCode(await harness.invoke(), 'TIMEOUT', 'error');
    assertResultCode(await harness.invoke(), 'BUSY', 'blocked');
    gate.reject(llmError('RATE_LIMIT', 'late lookup failure'));
    await settleTick();
    assertResultCode(await harness.invoke(), 'OK', 'ok');
    assert.equal(infoCalls, 2);
  });
});

test('an unsettled stream next() holds the slot and a late settle releases it', async () => {
  await withUnhandledWatch(async () => {
    const gate = deferred<IteratorResult<TestChunk>>();
    let call = 0;
    const harness = createHarness({
      endpointOptions: { timeoutMs: 25, minIntervalMs: 0, maxPerWindow: 1_000 },
      stream: () => {
        call += 1;
        return call === 1 ? deferredNextStream(gate)() : okStream()();
      },
    });
    const started = Date.now();
    assertResultCode(await harness.invoke(), 'TIMEOUT', 'error');
    assert.ok(Date.now() - started < 1_000, 'the endpoint must return on time');
    assertResultCode(await harness.invoke(), 'BUSY', 'blocked');
    assert.equal(harness.streamCalls.length, 1, 'the orphaned next() must block a second stream');
    gate.resolve({ done: true, value: undefined });
    await settleTick();
    assertResultCode(await harness.invoke(), 'OK', 'ok');
    assert.equal(harness.streamCalls.length, 2);
  });
});

test('a late stream next() rejection is observed and releases the slot', async () => {
  await withUnhandledWatch(async () => {
    const gate = deferred<IteratorResult<TestChunk>>();
    let call = 0;
    const harness = createHarness({
      endpointOptions: { timeoutMs: 25, minIntervalMs: 0, maxPerWindow: 1_000 },
      stream: () => {
        call += 1;
        return call === 1 ? deferredNextStream(gate)() : okStream()();
      },
    });
    assertResultCode(await harness.invoke(), 'TIMEOUT', 'error');
    assertResultCode(await harness.invoke(), 'BUSY', 'blocked');
    gate.reject(llmError('TRANSPORT', 'late stream failure'));
    await settleTick();
    assertResultCode(await harness.invoke(), 'OK', 'ok');
    assert.equal(harness.streamCalls.length, 2);
  });
});

test('a late close rejection is observed and releases the slot', async () => {
  await withUnhandledWatch(async () => {
    const gate = deferred<IteratorResult<TestChunk>>();
    let call = 0;
    const harness = createHarness({
      endpointOptions: { timeoutMs: 5_000 },
      stream: () => {
        call += 1;
        return call === 1 ? finishThenHangingClose(gate)() : okStream()();
      },
    });
    assertResultCode(await harness.invoke(), 'OK', 'ok');
    assertResultCode(await harness.invoke(), 'BUSY', 'blocked');
    assert.equal(harness.streamCalls.length, 1, 'the orphaned close() must block a second stream');
    gate.reject(llmError('TRANSPORT', 'late close failure'));
    await settleTick();
    assertResultCode(await harness.invoke(), 'OK', 'ok');
    assert.equal(harness.streamCalls.length, 2);
  });
});

test('a non-terminal early exit on a stream without return() abandons the slot', async () => {
  // Reviewer repro: oversize stops consuming, the last next() has already
  // settled, and the custom iterator has no return(). Releasing the slot would
  // let a second provider stream accumulate beside one that can never be closed.
  let providerCalls = 0;
  const signals: AbortSignal[] = [];
  const harness = createHarness({
    stream: (options) => {
      providerCalls += 1;
      if (options !== undefined) signals.push(options.signal);
      return oversizeNoReturnStream();
    },
  });

  const first = await harness.invoke();
  assertResultCode(first, 'UNKNOWN', 'error');
  assert.equal(providerCalls, 1);
  assert.equal(signals.length, 1);
  assert.equal(harness.streamCalls.length, 1);
  assert.equal(
    harness.streamCalls[0]!.signal.aborted,
    true,
    'the request signal must be aborted after an oversize early return',
  );
  assert.equal(signals[0]?.aborted, true);

  // The unclosable stream is abandoned: the slot is never released.
  assertResultCode(await harness.invoke(), 'BUSY', 'blocked');
  assert.equal(providerCalls, 1, 'an abandoned probe must never start a second provider stream');
  assert.equal(harness.streamCalls.length, 1);
});

test('a terminal stream without return() still releases the slot', async () => {
  // A consumed finish chunk is terminal even without a return() method.
  let finishCalls = 0;
  const finished = createHarness({
    stream: () => {
      finishCalls += 1;
      return finishCalls === 1 ? finishNoReturnStream() : okStream()();
    },
  });
  assertResultCode(await finished.invoke(), 'OK', 'ok');
  assert.equal(
    finished.streamCalls[0]!.signal.aborted,
    false,
    'a fully settled terminal probe must not abort its request signal',
  );
  assertResultCode(await finished.invoke(), 'OK', 'ok');
  assert.equal(finishCalls, 2, 'a terminal no-return stream must not lock the slot');

  // A natural step.done ends the stream terminally too (reported as a
  // premature-close connection failure, but ownership is released normally).
  let endedCalls = 0;
  const ended = createHarness({
    stream: () => {
      endedCalls += 1;
      return endedCalls === 1 ? endedNoReturnStream() : okStream()();
    },
  });
  assertResultCode(await ended.invoke(), 'ACCOUNT_CONNECTION', 'error');
  assert.equal(
    ended.streamCalls[0]!.signal.aborted,
    false,
    'a naturally ended probe must not abort its request signal',
  );
  assertResultCode(await ended.invoke(), 'OK', 'ok');
  assert.equal(endedCalls, 2, 'a natural step.done must not lock the slot');
});

test('the endpoint probes the SAVED route even when a caller injects arguments', async () => {
  const harness = createHarness();
  // A malicious page can only call the Remote method; extra positional values
  // must be ignored rather than used as a route or credential.
  const result = await harness.invoke({
    extraArgs: [{ provider: 'evil-provider', model: 'evil-model', apiKey: 'sk-evil-credential' }],
  });
  assertResultCode(result, 'OK', 'ok');
  assert.equal(harness.streamCalls[0]!.provider, 'deepseek-account');
  assert.equal(harness.streamCalls[0]!.model, 'deepseek-flash');
  assert.equal(result.route.provider, 'deepseek-account');
  const wire = JSON.stringify(result);
  assert.ok(!wire.includes('evil-provider'));
  assert.ok(!wire.includes('sk-evil-credential'));
  assert.ok(!Object.hasOwn(harness.streamCalls[0]!, 'apiKey'));
});

test('latencyMs is a bounded wall-clock measurement of the probe attempt', async () => {
  let clock = 500;
  const harness = createHarness({
    config: { reasoningEffort: 'max' },
    endpointOptions: { now: () => clock },
    modelInfo: () => {
      clock += 25;
      return { reasoning: { efforts: [{ id: 'max' }] } };
    },
  });
  const result = await harness.invoke();
  assertResultCode(result, 'OK', 'ok');
  assert.equal(result.latencyMs, 25);
});

test('pure request/throttle helpers keep the fixed safety contract', () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const fixed = buildRouteTestRequest(
    { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: '' },
    '',
    signal,
    16,
  );
  assert.deepEqual(Object.keys(fixed).sort(), [
    'maxTokens', 'messages', 'model', 'provider', 'signal', 'system', 'temperature',
  ]);
  assert.equal(fixed.temperature, 0);
  const withEffort = buildRouteTestRequest(
    { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
    'max',
    signal,
    16,
  );
  assert.equal(withEffort.reasoningEffort, 'max');

  const state = createRouteTestState(100);
  assert.equal(state.pendingProviderOperations, 0);
  assert.equal(checkRouteTestThrottle(state, 100, { minIntervalMs: 3_000, windowMs: 60_000, maxPerWindow: 5 }), undefined);
  markRouteTestStarted(state, 100);
  assert.deepEqual(
    checkRouteTestThrottle(state, 100, { minIntervalMs: 3_000, windowMs: 60_000, maxPerWindow: 5 }),
    { code: 'BUSY', retryAfterMs: 3_000 },
  );
  state.inFlight = false;
  assert.deepEqual(
    checkRouteTestThrottle(state, 1_000, { minIntervalMs: 3_000, windowMs: 60_000, maxPerWindow: 5 }),
    { code: 'RATE_LIMITED', retryAfterMs: 2_100 },
  );

  assert.deepEqual(readThrownFailure({ code: 'AUTH', status: 401 }), { code: 'AUTH', status: 401 });
  assert.deepEqual(readThrownFailure(new Error('plain')), { code: '' });
  assert.deepEqual(
    readFinishFailure({ kind: 'aborted' }),
    { code: 'ABORTED' },
  );
  assert.equal(readFinishFailure({ kind: 'stop' }), undefined);

  // Only official provider-neutral codes (and valid HTTP status tokens) survive.
  assert.equal(normalizeFailureCode('SECRET_TOKEN_12345'), '');
  assert.equal(normalizeFailureCode('PI_AI_ERROR'), 'PI_AI_ERROR');
  assert.equal(normalizeFailureCode('http_503'), 'HTTP_503');
  assert.equal(normalizeFailureCode('HTTP_429'), 'HTTP_429');
  assert.equal(normalizeFailureCode('HTTP_999'), '');
  assert.equal(classifyRouteTestFailure('SECRET_TOKEN_12345', 'account'), 'UNKNOWN');
  assert.deepEqual(readThrownFailure({ code: 'SECRET_TOKEN_12345' }), { code: '' });
});
