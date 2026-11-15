/**
 * Host tests for `@aghost-prj/dsh-auto-review-model`.
 *
 * The LLM service is faked with an in-process waterfall that mirrors the real
 * `ctx.llm.stream` contract: registered `llm/stream` listeners wrap a base
 * chunk stream, and a rewrite calls `ctx.llm.stream` again to re-enter it.
 * Nothing here touches the network or a live loader.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Config, ReviewerCapabilityError, __testing, apply, inject, name } from '@aghost-prj/dsh-auto-review-model';
import {
  REVIEW_POLICY_MARKER,
  REVIEW_POLICY_PREFIX,
  effortCacheKey,
  isAutoReviewRequest,
  normalizeEffort,
  readReviewerSettings,
} from '@aghost-prj/dsh-auto-review-model/policy';
import type { ReviewerConfig } from '@aghost-prj/dsh-auto-review-model/policy';

/** A realistic reviewer system prompt with the fixed policy prefix and marker. */
const REVIEW_SYSTEM =
  'REVIEW_POLICY\nYou are the final authorization reviewer for exactly one pending tool call.\n\nReturn exactly one JSON object and no other text.';

/** One adapter-owned reasoning effort advertised for an exact route. */
interface TestEffortInfo {
  id?: string;
}

/** The subset of model information consultable by the listener. */
interface TestModelInfo {
  reasoning?: {
    efforts?: readonly TestEffortInfo[];
  };
}

/** The generate options structure used in tests. */
interface TestGenerateOptions {
  provider: string;
  model: string;
  system?: string;
  messages?: Array<{ role: string; content: unknown }>;
  reasoningEffort?: string;
  signal?: AbortSignal;
  temperature?: number;
  [key: string]: unknown;
}

/** Model info resolver function signature. */
type ModelInfoFn = (
  provider: string,
  model: string,
  signal?: AbortSignal,
) => Promise<TestModelInfo | undefined> | TestModelInfo | undefined;

/** Registered host event listener entry. */
interface ListenerRegistration {
  event: string;
  listener: (...args: any[]) => any;
  options?: { global?: boolean; prepend?: boolean };
}

/** Internal state of the test config refs. */
interface HarnessState {
  enabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
}

/** Recorded resolveModelInfo invocation. */
interface ResolveCall {
  provider: string;
  model: string;
  signal?: AbortSignal;
}

/** Stream chunk item. */
interface StreamChunk {
  type: string;
  [key: string]: unknown;
}

/** Options for harness creation. */
interface HarnessOptions {
  config?: Partial<HarnessState>;
  modelInfo?: ModelInfoFn;
}

/** Fake host environment returned by createHarness. */
interface Harness {
  ctx: Parameters<typeof apply>[0];
  state: HarnessState;
  configRefs: ReviewerConfig;
  registrations: ListenerRegistration[];
  streamCalls: TestGenerateOptions[];
  baseCalls: TestGenerateOptions[];
  resolveCalls: ResolveCall[];
  warnings: unknown[][];
  baseChunks: StreamChunk[];
  emitWithFilter: (event: string, filter: (target: unknown) => boolean, ...args: unknown[]) => void;
}

/** Build one auto-review-shaped request. */
function reviewOptions(overrides: Partial<TestGenerateOptions> = {}): TestGenerateOptions {
  return {
    provider: 'request-provider',
    model: 'request-model',
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'PENDING_ACTION' }] }],
    temperature: 0,
    purpose: 'auto-review',
    ...overrides,
  };
}

/** Deferred promise helper compatible with ES2022. */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Recursively freeze a JSON-like value, matching auto-review's deepFreeze. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Consume one chunk stream. */
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/**
 * Fake host: config refs, listener registration, and a minimal `llm` service.
 * `state` is mutated by tests to simulate a live settings ref change.
 */
function createHarness({ config = {}, modelInfo = () => ({}) }: HarnessOptions = {}): Harness {
  const state: HarnessState = {
    enabled: true,
    provider: 'review-provider',
    model: 'review-model',
    reasoningEffort: '',
    ...config,
  };
  const configRefs: ReviewerConfig = {
    enabled: { get: () => state.enabled },
    provider: { get: () => state.provider },
    model: { get: () => state.model },
    reasoningEffort: { get: () => state.reasoningEffort },
  };

  const registrations: ListenerRegistration[] = [];
  const streamCalls: TestGenerateOptions[] = [];
  const baseCalls: TestGenerateOptions[] = [];
  const resolveCalls: ResolveCall[] = [];
  const warnings: unknown[][] = [];
  const baseChunks: StreamChunk[] = [
    { type: 'text-delta', text: '{"risk":"low","decision":"allow"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ];

  async function* baseStream(options: TestGenerateOptions): AsyncGenerator<StreamChunk> {
    baseCalls.push(options);
    yield* baseChunks;
  }

  const ctx: Parameters<typeof apply>[0] = {
    on(event: string, listener: (...args: any[]) => any, options?: { global?: boolean; prepend?: boolean }) {
      registrations.push({ event, listener, options });
      return () => {};
    },
    inject(_services, callback) {
      callback({
        sessionLogDeepSeek: {
          registerExclusion: () => () => {},
        },
      });
    },
    llm: {
      stream(options: TestGenerateOptions): AsyncIterable<unknown> {
        streamCalls.push(options);
        const listeners = registrations
          .filter((registration) => registration.event === 'llm/stream')
          .map((registration) => registration.listener);
        let next = (): AsyncIterable<unknown> => baseStream(options);
        for (let index = listeners.length - 1; index >= 0; index -= 1) {
          const listener = listeners[index];
          const inner = next;
          next = () => listener(options, inner);
        }
        return next();
      },
      async resolveModelInfo(provider: string, model: string, signal?: AbortSignal) {
        resolveCalls.push({ provider, model, signal });
        return modelInfo(provider, model, signal);
      },
    },
  };

  apply(ctx, configRefs);
  return {
    ctx,
    state,
    configRefs,
    registrations,
    streamCalls,
    baseCalls,
    resolveCalls,
    warnings,
    baseChunks,
    emitWithFilter(event: string, filter: (target: unknown) => boolean, ...args: unknown[]) {
      const listeners = registrations
        .filter((r) => r.event === event && (r.options?.global || filter(ctx)))
        .map((r) => r.listener);
      for (const listener of listeners) {
        listener(...args);
      }
    },
  };
}

/** Fire every registered settings-change listener. */
function fireLoaderUpdate(harness: Harness): void {
  const updates = harness.registrations.filter(
    (registration) => registration.event === 'loader/volatile-update',
  );
  assert.ok(updates.length > 0, 'apply must listen for loader/volatile-update');
  for (const update of updates) update.listener();
}

/** Fire every registered adapters-updated listener. */
function fireAdaptersUpdate(harness: Harness): void {
  const updates = harness.registrations.filter(
    (registration) => registration.event === 'llm/adapters-updated',
  );
  assert.ok(updates.length > 0, 'apply must listen for llm/adapters-updated');
  for (const update of updates) update.listener();
}

/** Message fragments every actionable capability error must carry. */
const CAPABILITY_ERROR_FRAGMENTS = [
  '300000ms',
  '(5 min)',
  'valid credentials',
  'correctly routed',
  'network',
  'Auto review model in Settings',
] as const;

/**
 * Assert that a rejected review carries the actionable capability failure for
 * one exact route and the requested timeout kind.
 */
function assertCapabilityFailure(
  error: unknown,
  route: string,
  timedOut: boolean,
): asserts error is ReviewerCapabilityError {
  assert.ok(
    error instanceof ReviewerCapabilityError,
    `expected a ReviewerCapabilityError, got ${String(error)}`,
  );
  const failure = error as ReviewerCapabilityError;
  assert.equal(failure.name, 'AutoReviewModelCapabilityError');
  assert.equal(failure.route, route);
  assert.equal(failure.provider, route.slice(0, route.indexOf('/')));
  assert.equal(failure.model, route.slice(route.indexOf('/') + 1));
  assert.equal(failure.timeoutMs, 300_000);
  assert.equal(failure.timedOut, timedOut);
  assert.equal(
    failure.code,
    timedOut ? 'AUTO_REVIEW_MODEL_CAPABILITY_TIMEOUT' : 'AUTO_REVIEW_MODEL_CAPABILITY_FAILED',
  );
  for (const fragment of [route, ...CAPABILITY_ERROR_FRAGMENTS]) {
    assert.ok(
      failure.message.includes(fragment),
      `error message must include ${JSON.stringify(fragment)}: ${failure.message}`,
    );
  }
  if (timedOut) {
    assert.ok(failure.message.includes('timed out'), `timeout message must say so: ${failure.message}`);
  } else {
    assert.ok(failure.message.includes('failed'), `failure message must say so: ${failure.message}`);
  }
}

test('plugin metadata follows the shared loader contract', () => {
  assert.equal(name, 'auto-review-model');
  assert.deepEqual(inject, ['llm', 'sessionLogDeepSeek']);
  assert.equal(typeof apply, 'function');
});

test('Config declares four volatile settings with the shared defaults', () => {
  const config = Config({}) as unknown as Record<string, { get: () => unknown }>;
  for (const key of ['enabled', 'provider', 'model', 'reasoningEffort']) {
    assert.equal(typeof config[key]?.get, 'function', `${key} must be a volatile ref`);
  }
  assert.equal(config.enabled.get(), true);
  assert.equal(config.provider.get(), '');
  assert.equal(config.model.get(), '');
  assert.equal(config.reasoningEffort.get(), '');
});

test('capability query deadline is 300000ms (5 min)', () => {
  assert.equal(__testing.CAPABILITY_TIMEOUT_MS, 300_000);
  assert.equal(__testing.CAPABILITY_TIMEOUT_MS, 5 * 60_000);
  assert.equal(__testing.ReviewerCapabilityError, ReviewerCapabilityError);
});

test('marker recognition accepts only the fixed auto-review prompt', () => {
  assert.equal(REVIEW_POLICY_PREFIX, 'REVIEW_POLICY\n');
  assert.equal(
    REVIEW_POLICY_MARKER,
    'You are the final authorization reviewer for exactly one pending tool call.',
  );
  assert.equal(isAutoReviewRequest(reviewOptions()), true);
  assert.equal(isAutoReviewRequest(reviewOptions({ purpose: undefined })), false, 'prompt-only decoys must not be rerouted');
  assert.equal(isAutoReviewRequest(reviewOptions({ purpose: 'session-title' })), false, 'other purposes must not be rerouted');
  assert.equal(__testing.isAutoReviewRequest, isAutoReviewRequest);
  assert.equal(
    isAutoReviewRequest({ purpose: 'auto-review', system: `${REVIEW_POLICY_PREFIX}header\n${REVIEW_POLICY_MARKER}` }),
    true,
    'the marker only has to appear after the fixed prefix',
  );
  assert.equal(isAutoReviewRequest({ purpose: 'auto-review', system: `${REVIEW_POLICY_PREFIX}${REVIEW_POLICY_MARKER}` }), true);
  assert.equal(
    isAutoReviewRequest({ system: `${REVIEW_POLICY_PREFIX}${REVIEW_POLICY_MARKER.slice(0, -1)}` }),
    false,
    'the marker must be complete',
  );
  assert.equal(
    isAutoReviewRequest({ system: `${REVIEW_POLICY_MARKER}\n` }),
    false,
    'the policy prefix must come first',
  );
  assert.equal(isAutoReviewRequest({ system: 'You are a helpful assistant.' }), false);
  assert.equal(isAutoReviewRequest({ system: '' }), false);
  assert.equal(isAutoReviewRequest({}), false);
  assert.equal(isAutoReviewRequest(null), false);
  assert.equal(isAutoReviewRequest('REVIEW_POLICY\nnot an object'), false);
});

test('normalizeEffort trims and treats inherit/default as empty', () => {
  assert.equal(normalizeEffort(undefined), '');
  assert.equal(normalizeEffort(null), '');
  assert.equal(normalizeEffort(''), '');
  assert.equal(normalizeEffort('   '), '');
  assert.equal(normalizeEffort('default'), '');
  assert.equal(normalizeEffort(' inherit '), '');
  assert.equal(normalizeEffort(' high '), 'high');
  assert.equal(normalizeEffort('xhigh'), 'xhigh');
});

test('readReviewerSettings reads volatile refs live and defaults enabled', () => {
  let values: Record<string, unknown> = { enabled: false, provider: 'p1', model: 'm1', reasoningEffort: ' high ' };
  const config = Object.fromEntries(
    Object.entries(values).map(([key]) => [key, { get: () => values[key] }]),
  ) as ReviewerConfig;
  assert.deepEqual(readReviewerSettings(config), {
    enabled: false,
    provider: 'p1',
    model: 'm1',
    reasoningEffort: 'high',
  });

  values = { enabled: true, provider: 'p2', model: 'm2', reasoningEffort: 'inherit' };
  assert.deepEqual(readReviewerSettings(config), {
    enabled: true,
    provider: 'p2',
    model: 'm2',
    reasoningEffort: '',
  });

  assert.deepEqual(readReviewerSettings(undefined), {
    enabled: true,
    provider: '',
    model: '',
    reasoningEffort: '',
  });
});

test('effortCacheKey separates provider and model', () => {
  assert.equal(effortCacheKey('provider', 'model'), 'provider\u0000model');
  assert.notEqual(effortCacheKey('a', 'b'), effortCacheKey('b', 'a'));
});

test('non-review requests pass through untouched', async () => {
  const harness = createHarness({
    config: { reasoningEffort: 'high' },
    modelInfo: () => ({ reasoning: { efforts: [{ id: 'high' }] } }),
  });
  const ordinary: TestGenerateOptions = {
    provider: 'request-provider',
    model: 'request-model',
    system: 'You are a helpful assistant.',
    messages: [],
  };
  const decoy: TestGenerateOptions = {
    ...ordinary,
    system: `${REVIEW_POLICY_PREFIX}but this is not the reviewer`,
  };
  const missingSystem: TestGenerateOptions = {
    provider: 'request-provider',
    model: 'request-model',
    messages: [],
  };

  await collect(harness.ctx.llm.stream(ordinary));
  await collect(harness.ctx.llm.stream(decoy));
  await collect(harness.ctx.llm.stream(missingSystem));

  assert.equal(harness.baseCalls.length, 3);
  assert.equal(harness.baseCalls[0], ordinary);
  assert.equal(harness.baseCalls[1], decoy);
  assert.equal(harness.baseCalls[2], missingSystem);
  assert.equal(harness.streamCalls.length, 3, 'no re-entry for non-review requests');
  assert.equal(harness.resolveCalls.length, 0);
});

test('enabled=false passes the reviewer request through', async () => {
  const harness = createHarness({ config: { enabled: false, reasoningEffort: 'high' } });
  const options = reviewOptions();

  await collect(harness.ctx.llm.stream(options));

  assert.equal(harness.baseCalls.length, 1);
  assert.equal(harness.baseCalls[0], options);
  assert.equal(harness.streamCalls.length, 1);
  assert.equal(harness.resolveCalls.length, 0);
});

test('whitespace-only provider and model do not override the reviewer route', async () => {
  const harness = createHarness({
    config: { provider: '   ', model: '  ', reasoningEffort: 'high' },
  });
  const options = reviewOptions();

  await collect(harness.ctx.llm.stream(options));

  assert.equal(harness.baseCalls.length, 1);
  assert.equal(harness.baseCalls[0], options);
  assert.equal(harness.streamCalls.length, 1);
  assert.equal(harness.resolveCalls.length, 0);
  assert.deepEqual(
    readReviewerSettings({ provider: '  p1  ', model: '  m1  ' }),
    { enabled: true, provider: 'p1', model: 'm1', reasoningEffort: '' },
  );
});

test('an incomplete provider/model route passes the reviewer request through', async () => {
  for (const route of [
    { provider: '' },
    { model: '' },
    { provider: '', model: '' },
  ]) {
    const harness = createHarness({
      config: { ...route, reasoningEffort: 'high' },
    });
    const options = reviewOptions();

    await collect(harness.ctx.llm.stream(options));

    assert.equal(harness.baseCalls.length, 1, `route ${JSON.stringify(route)} must pass through`);
    assert.equal(harness.baseCalls[0], options);
    assert.equal(harness.streamCalls.length, 1);
    assert.equal(harness.resolveCalls.length, 0);
  }
});

test('overrides provider, model, and supported effort', async () => {
  const harness = createHarness({
    config: { provider: 'review-provider-2', model: 'review-model-2', reasoningEffort: ' high ' },
    modelInfo: () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
  });
  const options = reviewOptions();

  const chunks = await collect(harness.ctx.llm.stream(options));

  assert.deepEqual(chunks, harness.baseChunks);
  const used = harness.baseCalls[0];
  assert.notEqual(used, options, 'the frozen request must be copied');
  assert.equal(used.provider, 'review-provider-2');
  assert.equal(used.model, 'review-model-2');
  assert.equal(used.reasoningEffort, 'high');
  assert.equal(used.system, REVIEW_SYSTEM);
  assert.equal(used.temperature, 0);
  assert.deepEqual(
    harness.resolveCalls.map((c) => [c.provider, c.model]),
    [['review-provider-2', 'review-model-2']],
  );
  assert.equal(harness.baseCalls.length, 1);
  assert.equal(harness.streamCalls.length, 2, 'the rewritten request re-enters the waterfall');
  assert.equal(options.provider, 'request-provider');
  assert.equal(options.model, 'request-model');
  assert.equal(Object.hasOwn(options, 'reasoningEffort'), false);
});

test('drops an effort the target route does not advertise', async () => {
  // A successful lookup that advertises other efforts is not a capability
  // failure: the unsupported effort is dropped to the provider default.
  for (const modelInfo of [
    () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
    () => ({}),
  ]) {
    const harness = createHarness({
      config: { provider: 'review-provider-2', model: 'review-model-2', reasoningEffort: 'high' },
      modelInfo,
    });
    const options = reviewOptions({ reasoningEffort: 'stale-caller-effort' });

    await collect(harness.ctx.llm.stream(options));

    const used = harness.baseCalls[0];
    assert.equal(used.provider, 'review-provider-2');
    assert.equal(used.model, 'review-model-2');
    assert.equal(Object.hasOwn(used, 'reasoningEffort'), false);
    assert.equal(options.reasoningEffort, 'stale-caller-effort');
    assert.equal(harness.resolveCalls.length, 1);
  }
});

test('capability lookup failure rejects with an actionable error instead of silently dropping effort', async () => {
  const harness = createHarness({
    config: { provider: 'review-provider-2', model: 'review-model-2', reasoningEffort: 'high' },
    modelInfo: () => {
      throw new Error('capability lookup failed');
    },
  });
  const options = reviewOptions();

  await assert.rejects(
    collect(harness.ctx.llm.stream(options)),
    (error: unknown) => {
      assertCapabilityFailure(error, 'review-provider-2/review-model-2', false);
      assert.match(error.message, /capability lookup failed/);
      assert.ok(error.cause instanceof Error, 'the original lookup failure must be preserved as cause');
      return true;
    },
  );

  assert.equal(harness.baseCalls.length, 0, 'a failed lookup must fail closed, not send a default-effort request');
  assert.deepEqual(
    harness.resolveCalls.map((c) => [c.provider, c.model]),
    [['review-provider-2', 'review-model-2']],
  );
  assert.equal(options.provider, 'request-provider', 'the frozen original request must stay untouched');
});

test('a failed capability lookup is not cached and every review retries it', async () => {
  let attempts = 0;
  const harness = createHarness({
    config: { provider: 'review-provider-fail', model: 'review-model-fail', reasoningEffort: 'high' },
    modelInfo: () => {
      attempts += 1;
      throw new Error(`provider unreachable (attempt ${attempts})`);
    },
  });

  for (const attempt of [1, 2]) {
    await assert.rejects(
      collect(harness.ctx.llm.stream(reviewOptions())),
      (error: unknown) => {
        assertCapabilityFailure(error, 'review-provider-fail/review-model-fail', false);
        assert.match(error.message, new RegExp(`provider unreachable \\(attempt ${attempt}\\)`));
        return true;
      },
    );
  }

  assert.equal(attempts, 2, 'a failed lookup must not be cached');
  assert.equal(harness.baseCalls.length, 0, 'no retry may send a degraded request');
  assert.equal(harness.resolveCalls.length, 2);
});

test('a capability lookup that exceeds the 300000ms deadline rejects actionably and is not cached', async () => {
  const originalTimeoutMethod = AbortSignal.timeout;
  const realTimeout = originalTimeoutMethod.bind(AbortSignal);
  const requested: number[] = [];
  let hang = true;
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number): AbortSignal => {
    requested.push(ms);
    // Delegate to a real short timeout so the combined signal actually aborts.
    return realTimeout(5);
  };

  try {
    const harness = createHarness({
      config: { provider: 'review-provider-timeout', model: 'review-model-timeout', reasoningEffort: 'high' },
      modelInfo: (_provider, _model, signal) => {
        if (!hang) return { reasoning: { efforts: [{ id: 'high' }] } };
        return new Promise<TestModelInfo>((_resolve, reject) => {
          assert.ok(signal, 'resolveModelInfo must receive the combined capability signal');
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    await assert.rejects(
      collect(harness.ctx.llm.stream(reviewOptions())),
      (error: unknown) => {
        assertCapabilityFailure(error, 'review-provider-timeout/review-model-timeout', true);
        assert.match(error.message, /timed out after 300000ms \(5 min\)/);
        return true;
      },
    );

    assert.deepEqual(requested, [300_000], 'the lookup must use AbortSignal.timeout(300_000)');
    assert.equal(harness.baseCalls.length, 0, 'a timed-out lookup must not fall back to a default effort');

    hang = false;
    await collect(harness.ctx.llm.stream(reviewOptions()));
    assert.equal(harness.baseCalls.length, 1);
    assert.equal(harness.baseCalls[0].reasoningEffort, 'high', 'the retry after a timeout must use the configured effort');
    assert.equal(harness.resolveCalls.length, 2, 'a timeout must not be cached');
    assert.deepEqual(requested, [300_000, 300_000]);
  } finally {
    (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = originalTimeoutMethod;
  }
});

test('a lookup that yields no model information fails closed', async () => {
  const harness = createHarness({
    config: { provider: 'review-provider-empty', model: 'review-model-empty', reasoningEffort: 'high' },
    modelInfo: () => undefined,
  });

  await assert.rejects(
    collect(harness.ctx.llm.stream(reviewOptions())),
    (error: unknown) => {
      assertCapabilityFailure(error, 'review-provider-empty/review-model-empty', false);
      assert.match(error.message, /no model information/);
      return true;
    },
  );

  assert.equal(harness.baseCalls.length, 0, 'an unresolved route must not fall back to a default effort');
});

test('cancelling the original request during a capability lookup rejects and is not cached', async () => {
  const controller = new AbortController();
  let hanging = true;
  const harness = createHarness({
    config: { provider: 'review-provider-cancel', model: 'review-model-cancel', reasoningEffort: 'high' },
    modelInfo: (_provider, _model, signal) => {
      if (!hanging) return { reasoning: { efforts: [{ id: 'high' }] } };
      return new Promise<TestModelInfo>((_resolve, reject) => {
        assert.ok(signal, 'resolveModelInfo must receive the combined capability signal');
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const options = reviewOptions({ signal: controller.signal });
  const pending = collect(harness.ctx.llm.stream(options));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.resolveCalls.length, 1);
  const combined = harness.resolveCalls[0].signal;
  assert.ok(combined instanceof AbortSignal);
  assert.notEqual(combined, controller.signal, 'the caller signal must be combined with the timeout signal');

  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(
      (error as Error).name,
      'AbortError',
      'caller cancellation must propagate instead of being reported as a route failure',
    );
    return true;
  });
  assert.equal(combined.aborted, true, 'the combined signal must follow caller cancellation');
  assert.equal(harness.baseCalls.length, 0, 'a cancelled lookup must not send a degraded request');

  hanging = false;
  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.resolveCalls.length, 2, 'a cancellation must not be cached as a route failure');
  assert.equal(harness.baseCalls[0].reasoningEffort, 'high');
});

test('never mutates deeply frozen reviewer options', async () => {
  const options = deepFreeze(reviewOptions({ reasoningEffort: 'caller-effort' }));
  const snapshot = structuredClone(options);
  const harness = createHarness({
    config: { provider: 'review-provider-2', model: 'review-model-2', reasoningEffort: 'high' },
    modelInfo: () => ({ reasoning: { efforts: [{ id: 'high' }] } }),
  });

  await collect(harness.ctx.llm.stream(options));

  assert.ok(Object.isFrozen(options));
  assert.deepEqual(options, snapshot, 'the frozen request must not change in any nested field');
  assert.equal(options.provider, 'request-provider');
  assert.equal(options.model, 'request-model');
  assert.equal(options.reasoningEffort, 'caller-effort');
  const used = harness.baseCalls[0];
  assert.notEqual(used, options);
  assert.equal(used.provider, 'review-provider-2');
  assert.equal(used.model, 'review-model-2');
  assert.equal(used.reasoningEffort, 'high');
});

test('a rewritten request reaches the base stream exactly once', async () => {
  const harness = createHarness({
    config: { provider: 'review-provider-2', model: 'review-model-2', reasoningEffort: 'high' },
    modelInfo: () => ({ reasoning: { efforts: [{ id: 'high' }] } }),
  });
  const original = reviewOptions();

  const chunks = await collect(harness.ctx.llm.stream(original));

  assert.deepEqual(chunks, harness.baseChunks);
  assert.equal(harness.baseCalls.length, 1);
  const patched = harness.baseCalls[0];
  assert.notEqual(patched, original);
  assert.equal(harness.streamCalls.length, 2);
  assert.equal(harness.resolveCalls.length, 1);

  // Re-streaming the marked object must not rewrite it or recurse again.
  await collect(harness.ctx.llm.stream(patched));
  assert.equal(harness.baseCalls.length, 2);
  assert.equal(harness.baseCalls[1], patched);
  assert.equal(harness.streamCalls.length, 3);
  assert.equal(harness.resolveCalls.length, 1);
});

test('config ref changes take effect on the next request', async () => {
  const harness = createHarness({
    config: { provider: 'first-provider', model: 'first-model' },
    modelInfo: () => ({ reasoning: { efforts: [{ id: 'high' }] } }),
  });

  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.baseCalls[0].provider, 'first-provider');
  assert.equal(harness.baseCalls[0].model, 'first-model');
  assert.equal(Object.hasOwn(harness.baseCalls[0], 'reasoningEffort'), false);

  harness.state.provider = 'second-provider';
  harness.state.model = 'second-model';
  harness.state.reasoningEffort = 'high';

  await collect(harness.ctx.llm.stream(reviewOptions({ reasoningEffort: 'stale-caller-effort' })));
  assert.equal(harness.baseCalls[1].provider, 'second-provider');
  assert.equal(harness.baseCalls[1].model, 'second-model');
  assert.equal(harness.baseCalls[1].reasoningEffort, 'high');
  assert.deepEqual(
    harness.resolveCalls.map((c) => [c.provider, c.model]),
    [['second-provider', 'second-model']],
  );

  harness.state.enabled = false;
  const disabled = reviewOptions();
  await collect(harness.ctx.llm.stream(disabled));
  assert.equal(harness.baseCalls[2], disabled, 'the live enabled toggle must pass through');
  assert.equal(harness.resolveCalls.length, 1, 'a disabled override must not resolve capabilities');
});

test('loader/volatile-update clears the effort capability cache', async () => {
  let advertised = ['high'];
  const harness = createHarness({
    config: { provider: 'review-provider-2', model: 'review-model-2', reasoningEffort: 'high' },
    modelInfo: () => ({ reasoning: { efforts: advertised.map((id) => ({ id })) } }),
  });

  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.baseCalls[0].reasoningEffort, 'high');
  assert.equal(harness.resolveCalls.length, 1);

  // Without a settings change the cached capability is reused.
  advertised = ['low'];
  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.baseCalls[1].reasoningEffort, 'high');
  assert.equal(harness.resolveCalls.length, 1, 'cache hit must not resolve again');

  fireLoaderUpdate(harness);
  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(Object.hasOwn(harness.baseCalls[2], 'reasoningEffort'), false);
  assert.equal(harness.resolveCalls.length, 2, 'the settings change must force a fresh lookup');
});

test('loader/volatile-update registration has global: true', () => {
  const harness = createHarness();
  const registrations = harness.registrations.filter(
    (registration) => registration.event === 'loader/volatile-update',
  );

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options?.global, true, 'loader/volatile-update listener must specify global: true');
});

test('provider-scoped loader/volatile-update with Cordis Context.filter clears reviewer cache', async () => {
  let advertised = ['high'];
  const harness = createHarness({
    config: { provider: 'review-provider-scoped', model: 'review-model-scoped', reasoningEffort: 'high' },
    modelInfo: () => ({ reasoning: { efforts: advertised.map((id) => ({ id })) } }),
  });

  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.baseCalls[0].reasoningEffort, 'high');
  assert.equal(harness.resolveCalls.length, 1);

  // Simulate Cordis emit with Context.filter restricting to provider fiber
  advertised = ['low'];
  const providerFilter = (_targetCtx: unknown) => false; // Reviewer fiber is NOT provider fiber
  harness.emitWithFilter('loader/volatile-update', providerFilter);

  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(Object.hasOwn(harness.baseCalls[1], 'reasoningEffort'), false, 'cache should be cleared despite provider filter');
  assert.equal(harness.resolveCalls.length, 2, 'lookup should run again');
});

test('late-settling lookup (success) started before cache invalidation does not pollute cache', async () => {
  const deferred1 = createDeferred<TestModelInfo | undefined>();
  const deferred2 = createDeferred<TestModelInfo | undefined>();
  let resolveCallsCount = 0;

  const harness = createHarness({
    config: { provider: 'review-provider-race', model: 'review-model-race', reasoningEffort: 'high' },
    modelInfo: () => {
      resolveCallsCount += 1;
      if (resolveCallsCount === 1) return deferred1.promise;
      return deferred2.promise;
    },
  });

  // Start request 1 (in-flight query with old capabilities)
  const req1Promise = collect(harness.ctx.llm.stream(reviewOptions()));

  // Wait a tick to ensure resolveModelInfo was invoked
  await new Promise((r) => setImmediate(r));
  assert.equal(resolveCallsCount, 1);

  // Invalidate cache (e.g. settings change or adapter update)
  fireLoaderUpdate(harness);

  // Start request 2
  const req2Promise = collect(harness.ctx.llm.stream(reviewOptions()));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolveCallsCount, 2);

  // Request 2 completes first with NEW capabilities that only support 'low' (dropping 'high')
  deferred2.resolve({ reasoning: { efforts: [{ id: 'low' }] } });
  await req2Promise;
  assert.equal(Object.hasOwn(harness.baseCalls[0], 'reasoningEffort'), false);

  // Request 1 late-resolves afterwards with OLD capabilities that claimed 'high'
  deferred1.resolve({ reasoning: { efforts: [{ id: 'high' }] } });
  await req1Promise;

  // Request 3 should consult the cache. If request 1 overwrote the cache with 'high', this would fail!
  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.baseCalls.length, 3);
  assert.equal(
    Object.hasOwn(harness.baseCalls[2], 'reasoningEffort'),
    false,
    'late lookup from before invalidation must not overwrite newer cache',
  );
  // It shouldn't have used the stale 'high' from deferred1
  assert.equal(harness.baseCalls[2].reasoningEffort, undefined);
});

test('late-settling lookup (failure) started before cache invalidation propagates and does not pollute cache', async () => {
  const deferred1 = createDeferred<TestModelInfo | undefined>();
  const deferred2 = createDeferred<TestModelInfo | undefined>();
  let resolveCallsCount = 0;

  const harness = createHarness({
    config: { provider: 'review-provider-fail-race', model: 'review-model-fail-race', reasoningEffort: 'high' },
    modelInfo: () => {
      resolveCallsCount += 1;
      if (resolveCallsCount === 1) return deferred1.promise;
      return deferred2.promise;
    },
  });

  // Start request 1
  const req1Promise = collect(harness.ctx.llm.stream(reviewOptions()));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolveCallsCount, 1);

  // Invalidate cache
  fireLoaderUpdate(harness);

  // Start request 2
  const req2Promise = collect(harness.ctx.llm.stream(reviewOptions()));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolveCallsCount, 2);

  // Request 2 completes successfully with 'high'
  deferred2.resolve({ reasoning: { efforts: [{ id: 'high' }] } });
  await req2Promise;
  assert.equal(harness.baseCalls[0].reasoningEffort, 'high');

  // Request 1 late-rejects: it must surface its actionable failure instead of
  // silently sending a default-effort request.
  deferred1.reject(new Error('network error from old provider'));
  await assert.rejects(req1Promise, (error: unknown) => {
    assertCapabilityFailure(error, 'review-provider-fail-race/review-model-fail-race', false);
    assert.match(error.message, /network error from old provider/);
    return true;
  });
  assert.equal(harness.baseCalls.length, 1, 'the late failure must not reach the base stream');

  // Request 3 should use the cached 'high' from request 2, not a failure entry.
  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.baseCalls.length, 2);
  assert.equal(
    harness.baseCalls[1].reasoningEffort,
    'high',
    'a late failure from before invalidation must not overwrite the valid newer cache',
  );
  assert.equal(harness.resolveCalls.length, 2, 'request 3 must hit the successful cache');
});

test('apply registers a global, prepended llm/stream listener', () => {
  const harness = createHarness();
  const registrations = harness.registrations.filter(
    (registration) => registration.event === 'llm/stream',
  );

  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].options, { global: true, prepend: true });
  assert.equal(typeof registrations[0].listener, 'function');
});

test('resolveModelInfo receives a combined signal that follows the original request signal', async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const harness = createHarness({
    config: { provider: 'review-provider-signal', model: 'review-model-signal', reasoningEffort: 'high' },
    modelInfo: (_provider, _model, signal) => {
      observed = signal;
      return { reasoning: { efforts: [{ id: 'high' }] } };
    },
  });
  const options = reviewOptions({ signal: controller.signal });

  const chunks = await collect(harness.ctx.llm.stream(options));
  assert.deepEqual(chunks, harness.baseChunks);
  assert.equal(harness.resolveCalls.length, 1);
  assert.equal(harness.resolveCalls[0].provider, 'review-provider-signal');
  assert.equal(harness.resolveCalls[0].model, 'review-model-signal');
  const combined = harness.resolveCalls[0].signal;
  assert.ok(combined instanceof AbortSignal);
  assert.notEqual(combined, controller.signal, 'the caller signal must be combined with the 300000ms timeout');
  assert.equal(observed, combined, 'resolveModelInfo must receive the combined signal');
  assert.equal(combined.aborted, false);
  controller.abort();
  assert.equal(combined.aborted, true, 'cancelling the request must abort the combined lookup signal');
  assert.equal(harness.baseCalls[0].reasoningEffort, 'high');
});

test('llm/adapters-updated clears the effort capability cache and triggers new resolveModelInfo', async () => {
  let advertised = ['high'];
  const harness = createHarness({
    config: { provider: 'review-provider-adapters', model: 'review-model-adapters', reasoningEffort: 'high' },
    modelInfo: () => ({ reasoning: { efforts: advertised.map((id) => ({ id })) } }),
  });

  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.baseCalls[0].reasoningEffort, 'high');
  assert.equal(harness.resolveCalls.length, 1);

  // Before adapters-updated, cached capability is reused for the same route
  advertised = ['low'];
  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.baseCalls[1].reasoningEffort, 'high');
  assert.equal(harness.resolveCalls.length, 1, 'cache hit must not resolve again');

  // Trigger all llm/adapters-updated listeners registered in harness
  fireAdaptersUpdate(harness);

  // Next review for the same provider/model must call resolveModelInfo again
  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(
    Object.hasOwn(harness.baseCalls[2], 'reasoningEffort'),
    false,
    'dropped effort because newly resolved info only has low',
  );
  assert.equal(harness.resolveCalls.length, 2, 'adapters update must clear cache and force fresh lookup');
  assert.equal(harness.resolveCalls[1].provider, 'review-provider-adapters');
  assert.equal(harness.resolveCalls[1].model, 'review-model-adapters');
});

test('pre-aborted request rejects without querying and without caching a failure', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const harness = createHarness({
    config: { provider: 'review-provider-aborted', model: 'review-model-aborted', reasoningEffort: 'high' },
    modelInfo: () => {
      calls += 1;
      return { reasoning: { efforts: [{ id: 'high' }] } };
    },
  });
  const options = reviewOptions({ signal: controller.signal });

  await assert.rejects(
    collect(harness.ctx.llm.stream(options)),
    (error: unknown) => {
      assert.equal((error as Error).name, 'AbortError', 'a pre-aborted request must keep abort semantics');
      return true;
    },
  );
  assert.equal(calls, 0, 'a pre-aborted request must not start a capability lookup');
  assert.equal(harness.baseCalls.length, 0);

  // The cancellation must not poison the cache for a later live request.
  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(calls, 1);
  assert.equal(harness.baseCalls[0].reasoningEffort, 'high');
});
