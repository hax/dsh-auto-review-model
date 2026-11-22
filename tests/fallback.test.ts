/**
 * Host tests for multi-level Auto review fallback.
 *
 * The LLM service is faked with an in-process waterfall that mirrors the real
 * `ctx.llm.stream` contract: registered `llm/stream` listeners wrap a base
 * provider stream, and a rewrite calls `ctx.llm.stream` again to re-enter it.
 * Every provider route is scripted independently, so the tests can inject quota
 * finishes, partial reasoning before a failure, thrown stream errors, hanging
 * streams, missing terminal finishes, and bounded-buffer overflows without any
 * network or live loader.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Config,
  ReviewerCapabilityError,
  ReviewerRouteError,
  ReviewerRoutesError,
  __testing,
  apply,
  inject,
  name,
} from '@aghost-prj/dsh-auto-review-model';
import { REVIEW_POLICY_MARKER, REVIEW_POLICY_PREFIX } from '@aghost-prj/dsh-auto-review-model/policy';
import type { ReviewerConfig } from '@aghost-prj/dsh-auto-review-model/policy';

/** A realistic reviewer system prompt with the fixed policy prefix and marker. */
const REVIEW_SYSTEM =
  'REVIEW_POLICY\nYou are the final authorization reviewer for exactly one pending tool call.\n\nReturn exactly one JSON object and no other text.';

/** The generate options structure used in tests. */
interface TestGenerateOptions {
  provider: string;
  model: string;
  system?: string;
  messages?: Array<{ role: string; content: unknown }>;
  reasoningEffort?: string;
  signal?: AbortSignal;
  [key: string]: unknown;
}

/** One scripted stream step. */
type StreamStep =
  | { chunk: Record<string, unknown> }
  | { error: unknown }
  | { hang: true };

/** Script for one exact `provider/model` route. */
interface RouteScript {
  /** Steps yielded/observed in order; a natural end after the last step. */
  steps?: StreamStep[];
  /** Throw synchronously from `llm.stream` before any iterable exists. */
  syncThrow?: unknown;
  /** Emit `return()` on the stream; defaults to true. */
  withReturn?: boolean;
}

/** What one route observed during the test. */
interface RouteStats {
  /** Requests that reached this route, in order. */
  requests: TestGenerateOptions[];
  /** Chunk indices yielded so far. */
  yielded: number;
  /** How often the stream's `return()` was called. */
  returnCalls: number;
}

/** Registered host event listener entry. */
interface ListenerRegistration {
  event: string;
  listener: (...args: any[]) => any;
  options?: { global?: boolean; prepend?: boolean };
}

/** Live config state the volatile refs read. */
interface HarnessState {
  enabled: boolean;
  primaryEnabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
  streamCapture: string;
  fallbacks: unknown[];
}

/** Recorded resolveModelInfo invocation. */
interface ResolveCall {
  provider: string;
  model: string;
  signal?: AbortSignal;
}

/** Options for harness creation. */
interface HarnessOptions {
  config?: Partial<HarnessState>;
  routes?: Record<string, RouteScript>;
  /** Exact-route effort answers; an `Error` means the lookup fails. */
  modelInfo?: (provider: string, model: string) => { efforts?: string[] } | Error | undefined;
}

/** Fake host environment returned by createHarness. */
interface Harness {
  ctx: Parameters<typeof apply>[0];
  state: HarnessState;
  configRefs: ReviewerConfig;
  registrations: ListenerRegistration[];
  streamCalls: TestGenerateOptions[];
  resolveCalls: ResolveCall[];
  routeStats: Map<string, RouteStats>;
  exclusions: Array<(request: { purpose?: string }) => boolean>;
  stats(route: string): RouteStats;
}

/** Build one auto-review-shaped request. */
function reviewOptions(overrides: Partial<TestGenerateOptions> = {}): TestGenerateOptions {
  return {
    provider: 'session-provider',
    model: 'session-model',
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'PENDING_ACTION' }] }],
    temperature: 0,
    purpose: 'auto-review',
    ...overrides,
  };
}

/** Consume one chunk stream. */
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
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

/** Create a deferred promise helper compatible with ES2022. */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Build one scripted provider stream for an exact route. */
function createRouteStream(
  options: TestGenerateOptions,
  route: string,
  script: RouteScript,
  stats: RouteStats,
): AsyncIterable<unknown> {
  let index = 0;
  let closed = false;
  let rejectPending: ((reason: unknown) => void) | undefined;
  const signal = options.signal;
  const onAbort = (): void => {
    rejectPending?.(signal?.reason ?? new Error('aborted'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const stream = {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return stream as unknown as AsyncIterator<unknown>;
    },
    async next(): Promise<IteratorResult<unknown>> {
      if (closed) return { done: true, value: undefined };
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const step = script.steps?.[index];
      index += 1;
      if (step === undefined) {
        closed = true;
        return { done: true, value: undefined };
      }
      if ('error' in step) {
        closed = true;
        throw step.error;
      }
      if ('hang' in step) {
        return new Promise<IteratorResult<unknown>>((_resolve, reject) => {
          rejectPending = reject;
          if (signal?.aborted) reject(signal.reason ?? new Error('aborted'));
          else signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
        });
      }
      stats.yielded += 1;
      return { done: false, value: step.chunk };
    },
    async return(): Promise<IteratorResult<unknown>> {
      if (script.withReturn === false) {
        throw new TypeError(`route ${route} has no return()`);
      }
      stats.returnCalls += 1;
      closed = true;
      signal?.removeEventListener('abort', onAbort);
      return { done: true, value: undefined };
    },
  };
  return stream as AsyncIterable<unknown>;
}

/** Build the fake host: config refs, listener registration, and a routed `llm`. */
function createHarness({ config = {}, routes = {}, modelInfo = () => ({}) }: HarnessOptions = {}): Harness {
  const state: HarnessState = {
    enabled: true,
    primaryEnabled: true,
    provider: 'primary-provider',
    model: 'primary-model',
    reasoningEffort: '',
    streamCapture: 'buffered',
    fallbacks: [],
    ...config,
  };
  const configRefs: ReviewerConfig = {
    enabled: { get: () => state.enabled },
    primaryEnabled: { get: () => state.primaryEnabled },
    provider: { get: () => state.provider },
    model: { get: () => state.model },
    reasoningEffort: { get: () => state.reasoningEffort },
    streamCapture: { get: () => state.streamCapture },
    fallbacks: { get: () => state.fallbacks },
  };

  const registrations: ListenerRegistration[] = [];
  const streamCalls: TestGenerateOptions[] = [];
  const resolveCalls: ResolveCall[] = [];
  const routeStats = new Map<string, RouteStats>();
  const exclusions: Array<(request: { purpose?: string }) => boolean> = [];

  const statsFor = (route: string): RouteStats => {
    const existing = routeStats.get(route);
    if (existing !== undefined) return existing;
    const created: RouteStats = { requests: [], yielded: 0, returnCalls: 0 };
    routeStats.set(route, created);
    return created;
  };

  /** Base provider stream for one rewritten/caller request. */
  function providerStream(options: TestGenerateOptions): AsyncIterable<unknown> {
    const route = `${options.provider}/${options.model}`;
    const script = routes[route];
    if (script === undefined) throw new Error(`fallback test: no script for route ${route}`);
    const stats = statsFor(route);
    stats.requests.push(options);
    if (script.syncThrow !== undefined) throw script.syncThrow;
    return createRouteStream(options, route, script, stats);
  }

  const ctx: Parameters<typeof apply>[0] = {
    on(event: string, listener: (...args: any[]) => any, options?: { global?: boolean; prepend?: boolean }) {
      registrations.push({ event, listener, options });
      return () => {};
    },
    inject(_services, callback) {
      callback({
        sessionLogDeepSeek: {
          registerExclusion: (exclude: (request: { purpose?: string }) => boolean) => {
            exclusions.push(exclude);
          },
        },
      });
    },
    provide() {
      return () => {};
    },
    sessions: {
      get() {
        return undefined;
      },
    },
    llm: {
      stream(options: TestGenerateOptions): AsyncIterable<unknown> {
        streamCalls.push(options);
        const listeners = registrations
          .filter((registration) => registration.event === 'llm/stream')
          .map((registration) => registration.listener);
        let next = (): AsyncIterable<unknown> => providerStream(options);
        for (let index = listeners.length - 1; index >= 0; index -= 1) {
          const listener = listeners[index];
          const inner = next;
          next = () => listener(options, inner);
        }
        return next();
      },
      async resolveModelInfo(provider: string, model: string, signal?: AbortSignal) {
        resolveCalls.push({ provider, model, signal });
        const answer = modelInfo(provider, model);
        if (answer instanceof Error) throw answer;
        return answer === undefined
          ? undefined
          : { reasoning: { efforts: (answer.efforts ?? []).map((id) => ({ id })) } };
      },
      listConfigurableProviders() {
        return [];
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
    resolveCalls,
    routeStats,
    exclusions,
    stats: statsFor,
  };
}

/** Terminal error finish chunk with a provider-neutral code. */
function errorFinish(code: string, message = 'provider failure'): Record<string, unknown> {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } };
}

/** Terminal success finish chunk. */
const STOP_FINISH = { type: 'finish', reason: { kind: 'stop' } };

/** One reasoning delta. */
function reasoning(text: string): Record<string, unknown> {
  return { type: 'reasoning-delta', index: 0, text };
}

/** One text delta. */
function text(value: string): Record<string, unknown> {
  return { type: 'text-delta', index: 1, text: value };
}

/** Read the reasoning effort exactly as it was sent (absent means inherit). */
function sentEffort(options: TestGenerateOptions): string | undefined {
  return Object.hasOwn(options, 'reasoningEffort')
    ? options.reasoningEffort
    : undefined;
}

test('Config keeps a volatile explicit route list and never stores the session fallback', () => {
  assert.equal(name, 'auto-review-model');
  assert.deepEqual(inject, ['llm', 'sessionLogDeepSeek', 'sessions']);
  const config = Config({}) as unknown as Record<string, { get: () => unknown }>;
  assert.equal(typeof config.fallbacks?.get, 'function', 'fallbacks must be a volatile ref');
  assert.deepEqual(config.fallbacks.get(), [], 'fallbacks default to an empty list');
  assert.equal(typeof config.streamCapture?.get, 'function', 'streamCapture must be a volatile ref');
  assert.equal(config.streamCapture.get(), 'buffered', 'buffered capture is the default');
  const withFallbacks = Config({
    fallbacks: [
      // A legacy "follow session" row: kept in the schema so it cannot silently
      // turn into an explicit route, but the Host ignores it.
      { mode: 'session' },
      { provider: 'p', model: 'm', reasoningEffort: 'high' },
    ],
  }) as unknown as Record<string, { get: () => unknown }>;
  assert.deepEqual(withFallbacks.fallbacks.get(), [
    { enabled: true, mode: 'session', provider: '', model: '', reasoningEffort: '' },
    { enabled: true, mode: 'route', provider: 'p', model: 'm', reasoningEffort: 'high' },
  ]);
});

test('an empty explicit list leaves the review on native passthrough', async () => {
  const harness = createHarness({
    config: { provider: '', model: '', fallbacks: [] },
    routes: {
      'session-provider/session-model': { steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }] },
    },
  });
  const options = reviewOptions();

  const chunks = await collect(harness.ctx.llm.stream(options));

  assert.equal(chunks.length, 2);
  assert.equal(harness.streamCalls.length, 1, 'an empty list must not rewrite the review request');
  assert.equal(harness.stats('session-provider/session-model').requests[0], options);
});

test('explicit routes are tried in list order and the implicit session route is last', async () => {
  const harness = createHarness({
    config: {
      reasoningEffort: 'high',
      fallbacks: [
        { mode: 'route', provider: 'second-provider', model: 'second-model' },
        { mode: 'route', provider: 'third-provider', model: 'third-model' },
      ],
    },
    modelInfo: () => ({ efforts: ['high'] }),
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: errorFinish('QUOTA') }] },
      'second-provider/second-model': { steps: [{ chunk: errorFinish('AUTH') }] },
      'third-provider/third-model': { steps: [{ chunk: errorFinish('RATE_LIMIT') }] },
      'session-provider/session-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.deepEqual(
    harness.streamCalls.map((call) => `${call.provider}/${call.model}`),
    [
      'session-provider/session-model', // the caller's original request
      'primary-provider/primary-model',
      'second-provider/second-model',
      'third-provider/third-model',
      'session-provider/session-model', // the implicit final fallback
    ],
  );
  assert.equal(chunks.filter((chunk) => (chunk as { type: string }).type === 'finish').length, 1);
  assert.equal(
    Object.hasOwn(harness.stats('session-provider/session-model').requests[0], 'reasoningEffort'),
    false,
    'the implicit session attempt must not force a reasoning effort',
  );
});

test('legacy { mode: session } entries are ignored while explicit entries keep working', async () => {
  const harness = createHarness({
    config: {
      fallbacks: [
        { mode: 'route', provider: 'backup-provider', model: 'backup-model' },
        // Legacy row with leftover fields: must not become an explicit route
        // and must not be scheduled twice (the session model is implicit).
        { mode: 'session', provider: 'stale-provider', model: 'stale-model' },
        { mode: 'route', provider: 'third-provider', model: 'third-model' },
      ],
    },
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: errorFinish('QUOTA') }] },
      'backup-provider/backup-model': { steps: [{ chunk: errorFinish('AUTH') }] },
      'third-provider/third-model': { steps: [{ chunk: errorFinish('RATE_LIMIT') }] },
      'session-provider/session-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
  });

  await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.deepEqual(
    harness.streamCalls.map((call) => `${call.provider}/${call.model}`).slice(1),
    [
      'primary-provider/primary-model',
      'backup-provider/backup-model',
      'third-provider/third-model',
      'session-provider/session-model',
    ],
    'the legacy row must be ignored, not turned into a stale explicit route',
  );
  assert.equal(harness.stats('stale-provider/stale-model').requests.length, 0);
  assert.equal(
    harness.streamCalls.filter((call) => call.provider === 'session-provider').length,
    2,
    'the session route is tried exactly once (plus the original caller request)',
  );
});

test('an explicit route equal to the request route is not followed by a duplicate session attempt', async () => {
  const harness = createHarness({
    config: {
      provider: 'session-provider',
      model: 'session-model',
      fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }],
    },
    routes: {
      'session-provider/session-model': { steps: [{ chunk: errorFinish('QUOTA') }] },
      'backup-provider/backup-model': { steps: [{ chunk: errorFinish('AUTH') }] },
    },
  });

  await assert.rejects(
    collect(harness.ctx.llm.stream(reviewOptions())),
    (error: unknown) => {
      assert.ok(error instanceof ReviewerRoutesError, `expected ReviewerRoutesError, got ${String(error)}`);
      const aggregate = error as ReviewerRoutesError;
      assert.deepEqual(aggregate.routes, [
        'session-provider/session-model',
        'backup-provider/backup-model',
      ], 'the session route must not be appended again');
      return true;
    },
  );
  assert.equal(harness.stats('session-provider/session-model').requests.length, 1);
});

test('incomplete fallback entries are skipped instead of half-applied', async () => {
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: errorFinish('QUOTA') }] },
      'session-provider/session-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: {
      fallbacks: [
        { mode: 'route', provider: '', model: 'orphan-model' },
        { mode: 'route', provider: 'orphan-provider', model: '' },
      ],
    },
  });

  await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.deepEqual(
    harness.streamCalls.map((call) => `${call.provider}/${call.model}`).slice(1),
    ['primary-provider/primary-model', 'session-provider/session-model'],
  );
});

test('a fallback entry with an unknown mode is treated as an explicit route', async () => {
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: errorFinish('QUOTA') }] },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: {
      fallbacks: [{ mode: 'SESSION-typo', provider: 'backup-provider', model: 'backup-model' }],
    },
  });

  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 1);
});

test('a quota finish on the primary route falls back to the next explicit route and yields only its chunks', async () => {
  const primaryReasoning = 'thinking about the pending action '.repeat(3);
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': {
        steps: [
          { chunk: reasoning(primaryReasoning) },
          { chunk: text('{"risk":"high","decision":"deny"}') },
          { chunk: errorFinish('QUOTA', 'the account balance is exhausted') },
        ],
      },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: {
      fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }],
    },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));
  const types = chunks.map((chunk) => (chunk as { type: string }).type);

  assert.deepEqual(types, ['text-delta', 'finish'], 'only the winning route may reach the caller');
  assert.equal(
    (chunks[0] as { text: string }).text,
    '{"risk":"low","decision":"allow"}',
    'the failed attempt\'s reasoning and text must be discarded',
  );
  assert.equal(chunks.filter((chunk) => (chunk as { type: string }).type === 'finish').length, 1);
  assert.equal(harness.stats('primary-provider/primary-model').requests.length, 1);
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 1);
  assert.equal(harness.stats('primary-provider/primary-model').returnCalls, 1, 'the failed stream must be closed');
  assert.equal(harness.stats('session-provider/session-model').requests.length, 0, 'the session route is not reached');
});

test('the implicit session route follows the actual request route', async () => {
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: errorFinish('QUOTA') }] },
      'other-session-provider/other-session-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: { fallbacks: [] },
  });

  await collect(
    harness.ctx.llm.stream(
      reviewOptions({ provider: 'other-session-provider', model: 'other-session-model' }),
    ),
  );

  const sessionRequest = harness.stats('other-session-provider/other-session-model').requests[0];
  assert.equal(sessionRequest.provider, 'other-session-provider');
  assert.equal(sessionRequest.model, 'other-session-model');
  assert.equal(
    Object.hasOwn(sessionRequest, 'reasoningEffort'),
    false,
    'the implicit session attempt must not force a reasoning effort',
  );
});

test('an explicit route with a capability failure falls back to the session route', async () => {
  const harness = createHarness({
    config: { reasoningEffort: 'high' },
    modelInfo: () => new Error('capability endpoint down'),
    routes: {
      'session-provider/session-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.equal(chunks.length, 2);
  assert.equal(harness.stats('session-provider/session-model').requests.length, 1);
  assert.equal(harness.stats('primary-provider/primary-model').requests.length, 0);
});

test('a capability failure with no usable session route rejects with ReviewerCapabilityError', async () => {
  const harness = createHarness({
    config: { reasoningEffort: 'high' },
    modelInfo: () => new Error('capability endpoint down'),
  });

  await assert.rejects(
    collect(harness.ctx.llm.stream(reviewOptions({ provider: '', model: '' }))),
    (error: unknown) => {
      assert.ok(error instanceof ReviewerCapabilityError);
      assert.equal((error as ReviewerCapabilityError).route, 'primary-provider/primary-model');
      return true;
    },
  );
  assert.equal(harness.streamCalls.length, 1, 'the capability failure must not send a request');
});

test('a single explicit route with no usable request route streams directly (no fallback)', async () => {
  const harness = createHarness({
    config: { provider: 'backup-provider', model: 'backup-model', fallbacks: [] },
    routes: {
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
  });

  const chunks = await collect(
    harness.ctx.llm.stream(reviewOptions({ provider: '', model: '' })),
  );

  assert.equal(chunks.length, 2);
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 1);
});

test('a thrown provider stream falls back to the next explicit route', async () => {
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': { syncThrow: new Error('socket hang up') },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: { fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }] },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.equal(chunks.length, 2);
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 1);
});

test('a stream rejection after partial output falls back and discards the partial output', async () => {
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': {
        steps: [{ chunk: reasoning('partial reasoning') }, { error: new Error('connection reset') }],
      },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: { fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }] },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.deepEqual(
    chunks.map((chunk) => (chunk as { type: string }).type),
    ['text-delta', 'finish'],
  );
});

test('a stream that ends without a terminal finish falls back', async () => {
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: text('{"risk":"low"') }] },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: { fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }] },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(chunks.filter((chunk) => (chunk as { type: string }).type === 'finish').length, 1);
});

test('a classified content failure is surfaced instead of retried', async () => {
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': {
        steps: [{ chunk: errorFinish('INVALID_REQUEST', 'reviewer request was rejected as malformed') }],
      },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: { fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }] },
  });

  await assert.rejects(
    collect(harness.ctx.llm.stream(reviewOptions())),
    (error: unknown) => {
      assert.ok(error instanceof ReviewerRouteError, `expected ReviewerRouteError, got ${String(error)}`);
      const failure = error as ReviewerRouteError;
      assert.equal(failure.failureCode, 'INVALID_REQUEST');
      assert.equal(failure.route, 'primary-provider/primary-model');
      assert.match(failure.message, /malformed/);
      return true;
    },
  );
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 0, 'a protocol failure must not fall back');
  assert.equal(harness.stats('session-provider/session-model').requests.length, 0);
});

test('a classified non-retryable thrown error is surfaced instead of retried', async () => {
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': {
        steps: [{ error: Object.assign(new Error('bad request body'), { code: 'MALFORMED_RESPONSE' }) }],
      },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: { fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }] },
  });

  await assert.rejects(
    collect(harness.ctx.llm.stream(reviewOptions())),
    (error: unknown) => {
      assert.ok(error instanceof ReviewerRouteError);
      assert.equal((error as ReviewerRouteError).failureCode, 'MALFORMED_RESPONSE');
      return true;
    },
  );
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 0);
});

test('an adapter-side aborted finish is surfaced instead of retried', async () => {
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': {
        steps: [{ chunk: { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '' } } } }],
      },
      'backup-provider/backup-model': { steps: [{ chunk: STOP_FINISH }] },
    },
    config: { fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }] },
  });

  await assert.rejects(
    collect(harness.ctx.llm.stream(reviewOptions())),
    (error: unknown) => {
      assert.ok(error instanceof ReviewerRouteError);
      assert.equal((error as ReviewerRouteError).failureCode, 'ABORTED');
      return true;
    },
  );
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 0);
});

test('cancelling the request during a stream aborts without falling back', async () => {
  const controller = new AbortController();
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': {
        steps: [{ chunk: reasoning('thinking') }, { hang: true }],
      },
      'backup-provider/backup-model': { steps: [{ chunk: STOP_FINISH }] },
      'session-provider/session-model': { steps: [{ chunk: STOP_FINISH }] },
    },
    config: { fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }] },
  });
  const pending = collect(harness.ctx.llm.stream(reviewOptions({ signal: controller.signal })));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.stats('primary-provider/primary-model').requests.length, 1);
  controller.abort();

  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as Error).name, 'AbortError');
    return true;
  });
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 0, 'an abort must never fall back');
  assert.equal(harness.stats('session-provider/session-model').requests.length, 0);
});

test('cancelling the request during a capability lookup aborts without falling back', async () => {
  const controller = new AbortController();
  const harness = createHarness({
    config: {
      reasoningEffort: 'high',
      fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }],
    },
    modelInfo: () => {
      throw new Error('unused');
    },
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: STOP_FINISH }] },
      'backup-provider/backup-model': { steps: [{ chunk: STOP_FINISH }] },
    },
  });
  // Replace the resolver with one that only settles through the combined signal.
  harness.ctx.llm.resolveModelInfo = (
    _provider: string,
    _model: string,
    signal?: AbortSignal,
  ): Promise<{ reasoning: { efforts: Array<{ id: string }> } }> => {
    assert.ok(signal !== undefined, 'the capability lookup must receive a combined signal');
    return new Promise((_resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  const pending = collect(harness.ctx.llm.stream(reviewOptions({ signal: controller.signal })));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as Error).name, 'AbortError');
    return true;
  });
  assert.equal(harness.streamCalls.length, 1, 'only the caller request may reach the LLM service');
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 0);
});

test('an effort capability lookup failure falls back to the next explicit route', async () => {
  const harness = createHarness({
    config: {
      reasoningEffort: 'high',
      fallbacks: [
        { mode: 'route', provider: 'backup-provider', model: 'backup-model', reasoningEffort: 'high' },
      ],
    },
    modelInfo: (provider) => {
      if (provider === 'primary-provider') return new Error('capability endpoint unreachable');
      return { efforts: ['high'] };
    },
    routes: {
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.equal(chunks.length, 2);
  assert.deepEqual(
    harness.resolveCalls.map((call) => `${call.provider}/${call.model}`),
    ['primary-provider/primary-model', 'backup-provider/backup-model'],
  );
  const backup = harness.stats('backup-provider/backup-model').requests[0];
  assert.equal(sentEffort(backup), 'high', 'the fallback keeps its own advertised effort');
});

test('a fallback effort that is not advertised drops to the provider default', async () => {
  const harness = createHarness({
    config: {
      fallbacks: [
        { mode: 'route', provider: 'backup-provider', model: 'backup-model', reasoningEffort: 'high' },
      ],
    },
    modelInfo: () => ({ efforts: ['low'] }),
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: errorFinish('QUOTA') }] },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
  });

  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(sentEffort(harness.stats('backup-provider/backup-model').requests[0]), undefined);
});

test('the production attempt-buffer limits are large enough for reasoning-heavy reviewers', () => {
  assert.equal(__testing.fallback.FALLBACK_MAX_BUFFER_CHUNKS, 131_072);
  assert.equal(__testing.fallback.FALLBACK_MAX_BUFFER_CHARS, 8_000_000);
  assert.ok(__testing.fallback.FALLBACK_MAX_BUFFER_CHUNKS >= 131_072);
  assert.ok(__testing.fallback.FALLBACK_MAX_BUFFER_CHARS >= 8_000_000);
});

test('an attempt that overflows the buffer falls back and leaks none of its chunks', async () => {
  const marker = 'OVERFLOWED_ATTEMPT_REASONING_MARKER';
  const overflow = 'x'.repeat(__testing.fallback.FALLBACK_MAX_BUFFER_CHARS + 1);
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': {
        steps: [
          { chunk: reasoning(marker) },
          { chunk: text(overflow) },
          { chunk: STOP_FINISH },
        ],
      },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: { fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }] },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.deepEqual(
    chunks.map((chunk) => (chunk as { type: string }).type),
    ['text-delta', 'finish'],
    'only the next route may reach the caller',
  );
  assert.equal((chunks[0] as { text: string }).text, '{"risk":"low","decision":"allow"}');
  assert.equal(chunks.filter((chunk) => (chunk as { type: string }).type === 'finish').length, 1);
  const wire = JSON.stringify(chunks);
  assert.ok(!wire.includes(marker), 'the overflowed attempt reasoning must not leak');
  assert.ok(!wire.includes('xxxxxxxxxxxxxxxxxxxx'), 'the overflowed attempt text must not leak');
  assert.equal(harness.stats('primary-provider/primary-model').requests.length, 1);
  assert.equal(harness.stats('primary-provider/primary-model').returnCalls, 1, 'the overflowed stream must be closed');
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 1);
});

test('a chunk-count overflow also advances to the next route', async () => {
  const manyChunks: StreamStep[] = Array.from(
    { length: __testing.fallback.FALLBACK_MAX_BUFFER_CHUNKS + 1 },
    () => ({ chunk: reasoning('r') }),
  );
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': { steps: manyChunks },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: { fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }] },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(chunks.filter((chunk) => (chunk as { type: string }).type === 'finish').length, 1);
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 1);
});

test('all routes overflowing surfaces one aggregate error per route with the buffer code', async () => {
  const overflow = 'x'.repeat(__testing.fallback.FALLBACK_MAX_BUFFER_CHARS + 1);
  const harness = createHarness({
    config: {
      fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }],
    },
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: text(overflow) }] },
      'backup-provider/backup-model': { steps: [{ chunk: text(overflow) }] },
      'session-provider/session-model': { steps: [{ chunk: text(overflow) }] },
    },
  });

  await assert.rejects(
    collect(harness.ctx.llm.stream(reviewOptions())),
    (error: unknown) => {
      assert.ok(error instanceof ReviewerRoutesError, `expected ReviewerRoutesError, got ${String(error)}`);
      const aggregate = error as ReviewerRoutesError;
      assert.deepEqual(aggregate.routes, [
        'primary-provider/primary-model',
        'backup-provider/backup-model',
        'session-provider/session-model (session)',
      ]);
      assert.equal(aggregate.failures.length, 3);
      for (const failure of aggregate.failures) {
        assert.equal(failure.code, __testing.fallback.BUFFER_LIMIT_CODE);
        assert.match(failure.detail, /exceeded the bounded attempt buffer/, 'the raw overflow message is kept');
        assert.ok(
          aggregate.message.includes(`${failure.attempt.label}: ${__testing.fallback.BUFFER_LIMIT_CODE}:`),
          'each attempted route shows its code in the aggregate message',
        );
      }
      assert.ok(
        aggregate.message.includes(__testing.fallback.BUFFER_LIMIT_CODE),
        'the aggregate message must name the buffer-limit code',
      );
      return true;
    },
  );
});

test('a reasoning-heavy attempt under the new limit succeeds', async () => {
  const steps: StreamStep[] = Array.from(
    { length: 5_000 },
    (_value, index) => ({ chunk: reasoning(`thought ${index} `) }),
  );
  steps.push({ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH });
  assert.ok(steps.length < __testing.fallback.FALLBACK_MAX_BUFFER_CHUNKS);
  const harness = createHarness({
    routes: { 'primary-provider/primary-model': { steps } },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.equal(chunks.length, 5_002);
  assert.equal(chunks.filter((chunk) => (chunk as { type: string }).type === 'finish').length, 1);
  assert.equal((chunks[5_001] as { type: string }).type, 'finish');
  assert.equal(harness.stats('primary-provider/primary-model').requests.length, 1);
  assert.equal(harness.stats('session-provider/session-model').requests.length, 0);
});

test('all routes failing lists routes in order and surfaces raw provider messages verbatim', async () => {
  const harness = createHarness({
    config: {
      fallbacks: [{ mode: 'route', provider: 'third-provider', model: 'third-model' }],
    },
    routes: {
      'primary-provider/primary-model': {
        steps: [{ chunk: errorFinish('QUOTA', 'balance exhausted (sk-live-ABCDEF123456)') }],
      },
      'third-provider/third-model': { syncThrow: Object.assign(new Error('gateway timeout'), { code: 'TIMEOUT' }) },
      'session-provider/session-model': {
        syncThrow: new Error('request failed: api_key=super-secret-value for session route'),
      },
    },
  });

  await assert.rejects(
    collect(harness.ctx.llm.stream(reviewOptions())),
    (error: unknown) => {
      assert.ok(error instanceof ReviewerRoutesError, `expected ReviewerRoutesError, got ${String(error)}`);
      const aggregate = error as ReviewerRoutesError;
      assert.equal(aggregate.code, 'AUTO_REVIEW_MODEL_ALL_ROUTES_FAILED');
      assert.equal(aggregate.name, 'AutoReviewModelRoutesError');
      assert.deepEqual(aggregate.routes, [
        'primary-provider/primary-model',
        'third-provider/third-model',
        'session-provider/session-model (session)',
      ], 'the implicit session attempt is the final route');
      for (const fragment of [
        'primary-provider/primary-model',
        'session-provider/session-model (session)',
        'third-provider/third-model',
        'QUOTA',
        'TIMEOUT',
        'tool call was not executed',
      ]) {
        assert.ok(aggregate.message.includes(fragment), `aggregate message must include ${fragment}: ${aggregate.message}`);
      }
      // Raw provider text is surfaced exactly like official Auto review; the
      // plugin never adds credentials or request bodies itself.
      for (const fragment of [
        'primary-provider/primary-model: QUOTA: balance exhausted (sk-live-ABCDEF123456)',
        'third-provider/third-model: TIMEOUT: gateway timeout',
        'session-provider/session-model (session): unclassified error: request failed: api_key=super-secret-value for session route',
      ]) {
        assert.ok(aggregate.message.includes(fragment), `aggregate message must preserve ${fragment}: ${aggregate.message}`);
      }
      assert.ok(
        aggregate.message.indexOf('primary-provider/primary-model') < aggregate.message.indexOf('third-provider/third-model')
        && aggregate.message.indexOf('third-provider/third-model') < aggregate.message.indexOf('session-provider/session-model'),
        'routes must stay in attempt order',
      );
      assert.equal(aggregate.failures[0]?.code, 'QUOTA');
      assert.equal(aggregate.failures[1]?.code, 'TIMEOUT');
      assert.equal(aggregate.failures[0]?.detail, 'balance exhausted (sk-live-ABCDEF123456)');
      assert.equal(aggregate.failures[1]?.detail, 'gateway timeout');
      assert.equal(aggregate.failures[2]?.detail, 'request failed: api_key=super-secret-value for session route');
      const causes = aggregate.cause as unknown[];
      assert.ok(Array.isArray(causes), 'the original causes must be preserved');
      assert.ok(causes.length >= 2);
      return true;
    },
  );
  assert.equal(harness.stats('third-provider/third-model').requests.length, 1);
  assert.equal(harness.stats('session-provider/session-model').requests.length, 1);
});

test('the deprecated enabled=false is ignored and routes still apply', async () => {
  const harness = createHarness({
    config: {
      enabled: false,
      fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }],
    },
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: errorFinish('QUOTA') }] },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.equal(chunks.length, 2);
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 1);
});

test('a disabled primary row is skipped while enabled fallbacks still apply', async () => {
  const harness = createHarness({
    config: {
      primaryEnabled: false,
      fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }],
    },
    routes: {
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
  });

  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.equal(chunks.length, 2);
  assert.equal(harness.stats('primary-provider/primary-model').requests.length, 0);
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 1);
});

test('a disabled fallback row is skipped but stays in config order', async () => {
  const harness = createHarness({
    config: {
      fallbacks: [
        { mode: 'route', enabled: false, provider: 'disabled-provider', model: 'disabled-model' },
        { mode: 'route', enabled: true, provider: 'backup-provider', model: 'backup-model' },
      ],
    },
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: errorFinish('QUOTA') }] },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
  });

  await collect(harness.ctx.llm.stream(reviewOptions()));

  assert.equal(harness.stats('disabled-provider/disabled-model').requests.length, 0);
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 1);
  assert.equal(
    harness.stats('primary-provider/primary-model').requests.length,
    1,
    'the primary row is still attempted before the enabled fallback',
  );
});

test('all rows disabled or empty keeps native passthrough', async () => {
  const harness = createHarness({
    config: {
      primaryEnabled: false,
      fallbacks: [
        { mode: 'route', enabled: false, provider: 'disabled-provider', model: 'disabled-model' },
        { mode: 'route', enabled: true, provider: '', model: '' },
      ],
    },
    routes: {
      'session-provider/session-model': { steps: [{ chunk: STOP_FINISH }] },
    },
  });
  const options = reviewOptions();

  await collect(harness.ctx.llm.stream(options));

  assert.equal(harness.streamCalls.length, 1, 'no rewrite at all');
  assert.equal(harness.stats('session-provider/session-model').requests[0], options);
  assert.equal(harness.stats('disabled-provider/disabled-model').requests.length, 0);
});

test('a non-auto-review request passes through untouched with routes configured', async () => {
  const harness = createHarness({
    config: { fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }] },
    routes: {
      'session-provider/session-model': { steps: [{ chunk: STOP_FINISH }] },
    },
  });
  const ordinary: TestGenerateOptions = {
    provider: 'session-provider',
    model: 'session-model',
    system: 'You are a helpful assistant.',
    messages: [],
  };

  await collect(harness.ctx.llm.stream(ordinary));

  assert.equal(harness.streamCalls.length, 1);
  assert.equal(harness.stats('session-provider/session-model').requests[0], ordinary);
});

test('the route list is volatile: a config change applies to the next review', async () => {
  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: errorFinish('QUOTA') }] },
      'first-backup/first-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
      'second-backup/second-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: { fallbacks: [{ mode: 'route', provider: 'first-backup', model: 'first-model' }] },
  });

  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.stats('first-backup/first-model').requests.length, 1);

  harness.state.fallbacks = [{ mode: 'route', provider: 'second-backup', model: 'second-model' }];
  await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.equal(harness.stats('second-backup/second-model').requests.length, 1);
  assert.equal(harness.stats('first-backup/first-model').requests.length, 1, 'the old list must not be reused');
});

test('deeply frozen reviewer options are never mutated by fallback attempts', async () => {
  const harness = createHarness({
    config: {
      reasoningEffort: 'high',
      fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }],
    },
    modelInfo: () => ({ efforts: ['high'] }),
    routes: {
      'primary-provider/primary-model': { steps: [{ chunk: errorFinish('QUOTA') }] },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
  });
  const options = deepFreeze(reviewOptions());
  const snapshot = structuredClone(options);

  await collect(harness.ctx.llm.stream(options));

  assert.deepEqual(options, snapshot);
  assert.equal(harness.stats('primary-provider/primary-model').requests[0].provider, 'primary-provider');
  assert.equal(harness.stats('backup-provider/backup-model').requests[0].provider, 'backup-provider');
});

test('the session-log exclusion for auto-review is still registered', () => {
  const harness = createHarness();
  assert.equal(harness.exclusions.length, 1);
  assert.equal(harness.exclusions[0]({ purpose: 'auto-review' }), true);
  assert.equal(harness.exclusions[0]({ purpose: 'session-title' }), false);
  assert.equal(harness.exclusions[0]({}), false);
});

test('pass-through forwards each chunk before the terminal finish', async () => {
  const harness = createHarness({
    config: { streamCapture: 'pass-through' },
    routes: {
      'primary-provider/primary-model': {
        steps: [{ chunk: text('{"risk":"low"') }, { hang: true }],
      },
    },
  });
  const stream = harness.ctx.llm.stream(reviewOptions());
  const iterator = stream[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal((first.value as { type: string }).type, 'text-delta');
  assert.equal((first.value as { text: string }).text, '{"risk":"low"');
  assert.equal(
    harness.stats('primary-provider/primary-model').requests.length,
    1,
    'the chunk reached the caller without waiting for a terminal finish',
  );
  await iterator.return?.();
});

test('pass-through falls back only before any chunk has been emitted', async () => {
  const beforeChunks = createHarness({
    config: {
      streamCapture: 'pass-through',
      fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }],
    },
    routes: {
      'primary-provider/primary-model': { syncThrow: new Error('socket hang up') },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
  });
  const chunks = await collect(beforeChunks.ctx.llm.stream(reviewOptions()));
  assert.deepEqual(chunks.map(chunk => (chunk as { type: string }).type), ['text-delta', 'finish']);
  assert.equal(beforeChunks.stats('backup-provider/backup-model').requests.length, 1);

  const afterChunks = createHarness({
    config: {
      streamCapture: 'pass-through',
      fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }],
    },
    routes: {
      'primary-provider/primary-model': {
        steps: [{ chunk: text('{"risk":"low"') }, { chunk: errorFinish('QUOTA') }],
      },
      'backup-provider/backup-model': { steps: [{ chunk: STOP_FINISH }] },
    },
  });
  const stream = afterChunks.ctx.llm.stream(reviewOptions());
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal((first.value as { text: string }).text, '{"risk":"low"');
  await assert.rejects(iterator.next(), (error: unknown) => {
    assert.ok(error instanceof ReviewerRouteError, `expected ReviewerRouteError, got ${String(error)}`);
    assert.equal((error as ReviewerRouteError).failureCode, 'QUOTA');
    return true;
  });
  assert.equal(
    afterChunks.stats('backup-provider/backup-model').requests.length,
    0,
    'a failure after the first emitted chunk must not switch routes',
  );
});

test('pass-through yields the winning route once and never duplicates it', async () => {
  const harness = createHarness({
    config: {
      streamCapture: 'pass-through',
      fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }],
    },
    routes: {
      'primary-provider/primary-model': {
        steps: [
          { chunk: reasoning('thinking') },
          { chunk: text('{"risk":"low","decision":"allow"}') },
          { chunk: STOP_FINISH },
        ],
      },
    },
  });
  const chunks = await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.deepEqual(
    chunks.map(chunk => (chunk as { type: string }).type),
    ['reasoning-delta', 'text-delta', 'finish'],
  );
  assert.equal(harness.stats('primary-provider/primary-model').requests.length, 1);
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 0);
});

test('streamCapture is volatile and unknown values normalize to buffered', async () => {
  assert.equal(__testing.normalizeStreamCapture(' PASS-THROUGH '), 'pass-through');
  assert.equal(__testing.normalizeStreamCapture('nonsense'), 'buffered');
  assert.equal(__testing.normalizeStreamCapture(undefined), 'buffered');
  assert.equal(__testing.normalizeStreamCapture(42), 'buffered');

  const harness = createHarness({
    routes: {
      'primary-provider/primary-model': {
        steps: [{ chunk: text('{"risk":"low"') }, { chunk: errorFinish('QUOTA') }],
      },
      'backup-provider/backup-model': {
        steps: [{ chunk: text('{"risk":"low","decision":"allow"}') }, { chunk: STOP_FINISH }],
      },
    },
    config: {
      fallbacks: [{ mode: 'route', provider: 'backup-provider', model: 'backup-model' }],
    },
  });

  // Buffered: the failed attempt's chunk is discarded and the next route wins.
  const bufferedChunks = await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.deepEqual(bufferedChunks.map(chunk => (chunk as { type: string }).type), ['text-delta', 'finish']);
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 1);

  // Pass-through: the same failure after output is surfaced, no retry.
  harness.state.streamCapture = 'pass-through';
  const iterator = harness.ctx.llm.stream(reviewOptions())[Symbol.asyncIterator]();
  await iterator.next();
  await assert.rejects(iterator.next(), (error: unknown) => {
    assert.ok(error instanceof ReviewerRouteError);
    assert.equal((error as ReviewerRouteError).failureCode, 'QUOTA');
    return true;
  });
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 1, 'no extra backup attempt');

  // Unknown/old value: normalized back to buffered on the next review.
  harness.state.streamCapture = 'legacy-value';
  const normalized = await collect(harness.ctx.llm.stream(reviewOptions()));
  assert.deepEqual(normalized.map(chunk => (chunk as { type: string }).type), ['text-delta', 'finish']);
  assert.equal(harness.stats('backup-provider/backup-model').requests.length, 2);
});

test('route policy helpers normalize, order and de-duplicate exactly as documented', () => {
  const { fallback } = __testing;
  assert.equal(fallback.isLegacySessionEntry({ mode: ' SESSION ' }), true);
  assert.equal(fallback.isLegacySessionEntry({ mode: 'route' }), false);
  assert.equal(fallback.isLegacySessionEntry(null), false);
  assert.deepEqual(
    fallback.normalizeFallbackEntry({ mode: 'route', provider: ' p ', model: ' m ' }),
    { enabled: true, provider: 'p', model: 'm', reasoningEffort: '' },
  );
  assert.deepEqual(
    fallback.normalizeFallbackEntry({ enabled: false, provider: 'p', model: 'm' }),
    { enabled: false, provider: 'p', model: 'm', reasoningEffort: '' },
  );
  assert.deepEqual(
    fallback.normalizeFallbackEntry(null),
    { enabled: true, provider: '', model: '', reasoningEffort: '' },
  );
  assert.deepEqual(
    fallback.readFallbackEntries({
      fallbacks: [
        { mode: 'session', provider: 'stale', model: 'stale' },
        { enabled: false, mode: 'route', provider: 'disabled', model: 'disabled' },
        { mode: 'route', provider: ' p ', model: ' m ', reasoningEffort: ' high ' },
      ],
    }),
    [
      { enabled: false, provider: 'disabled', model: 'disabled', reasoningEffort: '' },
      { enabled: true, provider: 'p', model: 'm', reasoningEffort: 'high' },
    ],
    'legacy session entries are ignored and disabled rows are preserved',
  );

  // Row 1 (primary), then explicit fallbacks, then the implicit session route.
  const ordered = fallback.buildReviewPlan(
    { provider: 'p', model: 'm', reasoningEffort: 'high' },
    [{ enabled: true, provider: 'b', model: 'bm', reasoningEffort: '' }],
    { provider: 'sp', model: 'sm' },
  );
  assert.deepEqual(
    ordered.map((attempt: { label: string; reasoningEffort: string }) => [attempt.label, attempt.reasoningEffort]),
    [['p/m', 'high'], ['b/bm', ''], ['sp/sm (session)', '']],
  );

  // An explicit route equal to the request route suppresses the session attempt.
  assert.deepEqual(
    fallback.buildReviewPlan(
      { provider: 'sp', model: 'sm', reasoningEffort: '' },
      [],
      { provider: 'sp', model: 'sm' },
    ).map((attempt: { label: string }) => attempt.label),
    ['sp/sm'],
  );

  // No request route: the session attempt is not appended.
  assert.deepEqual(
    fallback.buildReviewPlan(
      { provider: 'p', model: 'm', reasoningEffort: '' },
      [],
      { provider: '', model: '' },
    ).map((attempt: { label: string }) => attempt.label),
    ['p/m'],
  );

  // No usable explicit route: nothing is rewritten at all.
  assert.deepEqual(
    fallback.buildReviewPlan(
      { provider: '', model: '', reasoningEffort: '' },
      [{ enabled: true, provider: '', model: 'incomplete', reasoningEffort: '' }],
      { provider: 'sp', model: 'sm' },
    ),
    [],
  );

  // Disabled rows never enter the plan; disabling row 1 skips it.
  assert.deepEqual(
    fallback.buildReviewPlan(
      { primaryEnabled: false, provider: 'p', model: 'm', reasoningEffort: '' },
      [{ enabled: false, provider: 'b', model: 'bm', reasoningEffort: '' }],
      { provider: 'sp', model: 'sm' },
    ),
    [],
  );

  for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'NO_ADAPTER', 'UNKNOWN_MODEL']) {
    assert.equal(fallback.isFallbackEligibleFailure({ code }), true, `${code} must be retryable`);
  }
  for (const code of ['', 'UNKNOWN', 'INVALID_REQUEST', 'MALFORMED_RESPONSE', 'CONTEXT_WINDOW_EXCEEDED', 'UNSUPPORTED_CONTENT', 'EMPTY_RESPONSE', 'ABORTED']) {
    assert.equal(fallback.isFallbackEligibleFailure({ code }), false, `${code} must not be retryable`);
  }
  assert.equal(fallback.isFallbackEligibleFailure({ code: '', status: 503 }), true);
  assert.equal(fallback.isFallbackEligibleFailure({ code: 'HTTP_429' }), true);
  assert.equal(fallback.isFallbackEligibleFailure({ code: 'HTTP_400' }), false);
  assert.equal(fallback.isFallbackEligibleFailure(undefined), false);

  // Failure records carry the raw provider message; only classification codes
  // are normalized to the official taxonomy.
  const attempt = {
    source: 'primary' as const,
    mode: 'route' as const,
    index: -1,
    provider: 'p',
    model: 'm',
    reasoningEffort: '',
    label: 'p/m',
  };
  const thrown = fallback.failureFromThrown(
    attempt,
    Object.assign(new Error('raw sk-live-SECRET message'), { code: 'TIMEOUT' }),
  );
  assert.equal(thrown.detail, 'raw sk-live-SECRET message', 'the raw message is preserved verbatim');
  assert.equal(thrown.code, 'TIMEOUT');
  assert.equal(thrown.rawCode, 'TIMEOUT');
  const finish = fallback.failureFromFinish(attempt, {
    kind: 'error',
    failure: { code: 'QUOTA', message: 'raw balance exhausted' },
  });
  assert.equal(finish.detail, 'raw balance exhausted', 'the raw finish message is preserved verbatim');
  assert.equal(finish.code, 'QUOTA');
  assert.equal(finish.rawCode, 'QUOTA');
});
