/**
 * Client-half tests for `@aghost-prj/dsh-auto-review-model`.
 *
 * The browser bundle is a plain CJS factory registered through
 * `window.__ModuleLoader__.load`. These tests emulate only the loader and the
 * `react` module; no component is ever rendered. The exported `__testing`
 * helpers are exercised directly so the behavior that matters for a correct
 * settings form (normalization, catalog lookup, draft transitions and the
 * settings RPC shape) is covered without a DOM or a browser.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const TARGET_BUNDLE = '@deepseek-ai/dsh-experimental-auto-review';
const SETTINGS_NS = 'auto-review-model';

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

interface ReactLike {
  createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): ReactElementLike;
  useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
  useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
  useCallback<T extends (...args: unknown[]) => unknown>(callback: T, dependencies?: readonly unknown[]): T;
  useRef<T>(initial: T): { current: T };
}

/** Minimal, predictable React surface. Components are never rendered. */
const fakeReact: ReactLike = {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): ReactElementLike {
    const nextProps: Record<string, unknown> = props === null || props === undefined ? {} : { ...props };
    if (children.length === 1) nextProps.children = children[0];
    else if (children.length > 1) nextProps.children = children;
    return { type, props: nextProps };
  },
  useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
    let value = typeof initial === 'function' ? (initial as () => T)() : initial;
    const setValue = (next: T | ((previous: T) => T)): void => {
      value = typeof next === 'function' ? (next as (prev: T) => T)(value) : next;
    };
    return [value, setValue];
  },
  useEffect(): void {},
  useRef<T>(initial: T): { current: T } {
    return { current: initial === undefined ? (null as T) : initial };
  },
  useCallback<T extends (...args: unknown[]) => unknown>(callback: T): T {
    return callback;
  },
};

interface ModuleLoaderEntry {
  id: string;
  chunk?: string;
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>;
}

interface WindowLike {
  __ModuleLoader__: {
    load(entry: ModuleLoaderEntry): void;
  };
  [key: string]: unknown;
}

/** Bundle registrations performed while importing the file: the ./remote chunk first, then the main factory. */
const registrations: ModuleLoaderEntry[] = [];

(globalThis as unknown as { window: WindowLike }).window = {
  __ModuleLoader__: {
    load(entry: ModuleLoaderEntry): void {
      registrations.push(entry);
    },
  },
};

let importError: Error | null = null;
try {
  const clientUrl = import.meta.resolve('@aghost-prj/dsh-auto-review-model/client');
  await import(clientUrl);
} catch (error) {
  importError = error as Error;
}

/** One explicit route saved in the `fallbacks` array. */
interface FallbackEntry {
  mode: 'route';
  enabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
}

/** One editable row of the ordered review-route list. */
interface ReviewRoute {
  enabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
}

interface ReviewerSettings {
  primaryEnabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
  fallbacks?: FallbackEntry[];
}

interface EffortInfo {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface ModelInfo {
  id: string;
  name: string;
  reasoning?: {
    efforts?: readonly (EffortInfo | string)[];
    defaultEffort?: string;
  };
  [key: string]: unknown;
}

interface ProviderGroup {
  id: string;
  name: string;
  models: ModelInfo[];
  [key: string]: unknown;
}

interface RemoteResponse<T = unknown> {
  ok?: boolean;
  value?: T;
  error?: unknown;
  revision?: number;
}

interface LoadResultOk {
  ok: true;
  value: ReviewerSettings;
  revision: number | undefined;
  groups: ProviderGroup[];
  catalogError: string;
}

interface LoadResultErr {
  ok: false;
  error: unknown;
}

type LoadResult = LoadResultOk | LoadResultErr;

interface ClientTesting {
  NS: string;
  BUNDLE: string;
  REMOTE_CONTRIBUTION_SPECIFIER: string;
  DEFAULT_SETTINGS: ReviewerSettings;
  normalizeSettings(raw?: unknown): ReviewerSettings;
  namespaceSection(value: unknown): unknown;
  providerGroups(catalog: unknown): ProviderGroup[];
  modelsFor(groups: unknown, provider: unknown): ModelInfo[];
  effortsFor(model: unknown): EffortInfo[];
  reconcileDraft(value: unknown, groups?: unknown): ReviewerSettings;
  MAX_ROUTES: number;
  INHERIT_EFFORT: string;
  isLegacySessionEntry(raw: unknown): boolean;
  normalizeRoute(raw: unknown): ReviewRoute;
  normalizeRoutes(raw: unknown): ReviewRoute[];
  storedFallback(route: unknown): FallbackEntry;
  rowsFromSettings(raw: unknown): ReviewRoute[];
  settingsFromRows(rows: unknown): ReviewerSettings;
  routesEqual(left: unknown, right: unknown): boolean;
  routeAfterProvider(route: unknown, provider: unknown): ReviewRoute;
  routeAfterModel(route: unknown, modelId: unknown, groups: unknown): ReviewRoute;
  replaceRoute(list: unknown, index: number, next: unknown): ReviewRoute[];
  addRoute(list: unknown): ReviewRoute[];
  removeRoute(list: unknown, index: number): ReviewRoute[];
  moveRoute(list: unknown, index: number, delta: number): ReviewRoute[];
  summaryLine(draft: ReviewerSettings, loading: boolean, t: (key: string) => string): string;
  loadReviewerSettings(remote: unknown, ns: string): Promise<LoadResult>;
  saveReviewerSettings(remote: unknown, ns: string, draft: unknown, revision?: number): Promise<RemoteResponse>;
  formatText(template: string, values: Record<string, string>): string;
  delayText(milliseconds: number, fallbackSeconds: number, t: (key: string) => string): string;
  mapTestResult(result: unknown, t: (key: string) => string): TestOutcome;
  mapTestTransportFailure(error: unknown, t: (key: string) => string): TestOutcome;
  mapTestUnknownResult(t: (key: string) => string): TestOutcome;
  safeErrorCode(error: unknown): string;
  testedRouteText(result: unknown): string;
  testStatusClass(tone: string): string;
  TEST_MESSAGE_KEYS: Record<string, string>;
  TEST_HINT_KEYS: Record<string, string>;
}

/** Localized outcome shape returned by the client test helpers. */
interface TestOutcome {
  tone: 'ok' | 'warning' | 'error' | 'blocked';
  message: string;
  route: string;
  hint: string;
  detail: string;
  note: string;
}

interface ClientExports {
  apply(ctx: unknown): Promise<(() => Promise<void>) | void> | void;
  inject: string[];
  name: string;
  __testing: ClientTesting;
}

/** Factory-instantiated client exports, populated by the suite's `before`. */
let client: ClientExports;

test.before(() => {
  assert.equal(
    importError,
    null,
    `client failed to import: ${importError?.stack ?? ''}`,
  );
  assert.equal(registrations.length, 2, 'the bundle must register the ./remote chunk and the main factory');
  const chunkEntry = registrations.find((entry) => entry.chunk !== undefined);
  const mainEntry = registrations.find((entry) => entry.id === '@aghost-prj/dsh-auto-review-model' && entry.chunk === undefined);
  assert.ok(chunkEntry, 'the generated prelude must register the ./remote contribution chunk');
  assert.ok(mainEntry, 'the bundle must register its main factory');
  assert.equal(typeof mainEntry.factory, 'function');
  const factories = new Map<string, ModuleLoaderEntry['factory']>();
  for (const entry of registrations) {
    const id = entry.chunk === undefined ? entry.id : `${entry.id}/${entry.chunk}`;
    factories.set(id, entry.factory);
  }
  const requireFromTable = (specifier: string): unknown => {
    if (specifier === 'react') return fakeReact;
    const factory = factories.get(specifier);
    if (factory === undefined) throw new Error(`module table missed ${specifier}`);
    return factory(requireFromTable);
  };
  client = mainEntry.factory(requireFromTable) as unknown as ClientExports;
});

function testing(): ClientTesting {
  assert.ok(client, 'the client bundle did not expose exports');
  assert.ok(client.__testing, 'the client bundle did not export __testing');
  return client.__testing;
}

const GROUPS: ProviderGroup[] = [
  {
    id: 'provider-a',
    name: 'Provider A',
    models: [
      {
        id: 'model-a1',
        name: 'Model A1',
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'low',
        },
      },
      {
        id: 'model-a2',
        name: 'Model A2',
        reasoning: {
          efforts: [{ id: 'low', name: 'Low' }],
          defaultEffort: 'low',
        },
      },
      { id: 'model-a3', name: 'Model A3' },
    ],
  },
  { id: 'provider-b', name: 'Provider B', models: [] },
];

test('exports the plugin surface expected by the client loader', () => {
  assert.equal(typeof client.apply, 'function');
  assert.ok(Array.isArray(client.inject));
  for (const service of ['slots', 'locale', 'remote', 'remote.settings', 'remote.session']) {
    assert.ok(client.inject.includes(service), `inject is missing ${service}`);
  }
  assert.equal(client.inject.length, 5, 'inject must not declare services the client does not use');
  assert.equal(typeof client.name, 'string');
  assert.ok(client.name.length > 0);
  assert.equal(typeof client.__testing, 'object');
  for (const helper of [
    'normalizeSettings',
    'namespaceSection',
    'modelsFor',
    'effortsFor',
    'isLegacySessionEntry',
    'normalizeRoute',
    'normalizeRoutes',
    'storedFallback',
    'rowsFromSettings',
    'settingsFromRows',
    'routesEqual',
    'routeAfterProvider',
    'routeAfterModel',
    'replaceRoute',
    'addRoute',
    'removeRoute',
    'moveRoute',
    'reconcileDraft',
    'summaryLine',
    'loadReviewerSettings',
    'saveReviewerSettings',
    'formatText',
    'delayText',
    'mapTestResult',
    'mapTestTransportFailure',
    'mapTestUnknownResult',
    'testStatusClass',
  ] as const) {
    assert.equal(typeof client.__testing[helper], 'function', `__testing.${helper} is missing`);
  }
  assert.equal(
    client.__testing.REMOTE_CONTRIBUTION_SPECIFIER,
    '@aghost-prj/dsh-auto-review-model/client.remote.js',
    'the bundle must require its own ./remote contribution module',
  );
  assert.ok(client.__testing.TEST_MESSAGE_KEYS.OK === 'testOkMessage');
  assert.ok(client.__testing.TEST_HINT_KEYS.ACCOUNT_SIGN_IN_REQUIRED === 'testAccountSignInHint');
});

interface Registration {
  meta: {
    name: string;
    key: string;
    locale: string;
    inject: () => { t: unknown; remote: unknown; testRoute?: unknown };
  };
  render: unknown;
}

/** One fake saved-route test endpoint and its recorded calls. */
interface FakeEndpoint {
  calls: number;
  lastSignal: AbortSignal | undefined;
  testReviewRoute(signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
}

interface ApplyHarnessOptions {
  /** Make the fake `remote.$mount` reject, exercising graceful degradation. */
  mountFails?: boolean;
  /** Response returned by the fake mounted endpoint. */
  response?: { ok: boolean; value?: unknown; error?: unknown };
}

/**
 * Fake Cordis context plus slots/locale/remote services. `slots.inject` and
 * `ctx.inject` are invoked synchronously, matching how the settings page
 * installs keyed contributions, and every mount/inject/dispose step is recorded
 * so ordering and cleanup can be asserted.
 */
function createApplyHarness(options: ApplyHarnessOptions = {}) {
  const registrations: Registration[] = [];
  const injectedKeys: string[] = [];
  const injectedDeps: string[][] = [];
  const localeRegistrations: { ns: string; dictionaries: unknown }[] = [];
  const localeBinds: string[] = [];
  const effects: (string | undefined)[] = [];
  const events: string[] = [];
  const mounted: unknown[] = [];
  const t = (key: string) => `t:${key}`;
  const endpoint: FakeEndpoint = {
    calls: 0,
    lastSignal: undefined,
    async testReviewRoute(signal?: AbortSignal) {
      endpoint.calls += 1;
      endpoint.lastSignal = signal;
      return options.response ?? { ok: true, value: validTestResult() };
    },
  };
  const remote = {
    settings: {
      describe: async () => ({ ok: true, value: { namespaces: [] } }),
      replace: async () => ({ ok: true }),
    },
    session: {
      modelCatalog: async () => ({ ok: true, value: { groups: [] } }),
    },
    async $mount(contribution: unknown) {
      events.push('mount');
      mounted.push(contribution);
      if (options.mountFails === true) throw new Error('endpoint mount failed');
      services['remote.autoReviewModel'] = endpoint;
      return async () => {
        events.push('unmount');
        delete services['remote.autoReviewModel'];
      };
    },
  };
  const slots = {
    inject(key: string, callback: () => unknown) {
      injectedKeys.push(key);
      assert.equal(typeof callback, 'function');
      return callback();
    },
    register(meta: Registration['meta'], render: unknown) {
      registrations.push({ meta, render });
      return meta;
    },
  };
  const locale = {
    register(ns: string, dictionaries: unknown) {
      localeRegistrations.push({ ns, dictionaries });
      return () => {};
    },
    bind(ns: string) {
      localeBinds.push(ns);
      return t;
    },
  };
  const services: Record<string, unknown> = {
    slots,
    locale,
    remote,
    'remote.settings': remote.settings,
    'remote.session': remote.session,
  };
  const childContext = {
    get(service: string) {
      return services[service];
    },
  };
  const ctx = {
    get(service: string) {
      return services[service];
    },
    effect(callback: () => (() => void) | void, label?: string) {
      effects.push(label);
      const result = callback();
      return typeof result === 'function' ? result : () => {};
    },
    inject(deps: readonly string[], callback: (child: typeof childContext) => unknown) {
      events.push('inject');
      injectedDeps.push([...deps]);
      const disposer = callback(childContext);
      return {
        dispose() {
          events.push('ui-dispose');
          if (typeof disposer === 'function') disposer();
        },
      };
    },
  };
  return {
    ctx,
    remote,
    t,
    endpoint,
    registrations,
    injectedKeys,
    injectedDeps,
    localeRegistrations,
    localeBinds,
    effects,
    events,
    mounted,
  };
}

/** Healthy saved-route test result used by the fake endpoint. */
function validTestResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    code: 'OK',
    route: { provider: 'provider-a', model: 'model-a1', reasoningEffort: 'high' },
    authKind: 'api-key',
    providerName: 'Provider A',
    settingsNs: 'provider-a',
    credentialEnv: ['PROVIDER_A_API_KEY'],
    effortUsed: 'high',
    effortNotAdvertised: false,
    latencyMs: 42,
    retryAfterMs: 0,
    failureCode: '',
    detail: '',
    ...overrides,
  };
}

test('apply mounts the ./remote contribution and registers the configuration page', async () => {
  const harness = createApplyHarness();
  const dispose = await client.apply(harness.ctx);

  assert.deepEqual(harness.events.slice(0, 2), ['mount', 'inject'], 'apply must mount the endpoint before registering the UI');
  assert.equal(harness.mounted.length, 1, 'apply must mount exactly one contribution');
  const contribution = harness.mounted[0] as { package?: string; descriptors?: unknown[] };
  assert.equal(contribution.package, '@aghost-prj/dsh-auto-review-model');
  assert.ok(Array.isArray(contribution.descriptors) && contribution.descriptors.length === 1);
  assert.deepEqual(harness.injectedDeps[0], ['slots', 'locale']);

  assert.ok(
    harness.injectedKeys.includes('plugins.bundle.config'),
    'apply must inject into plugins.bundle.config',
  );
  const registration = harness.registrations.find(
    ({ meta }) => meta.name === 'plugins.bundle.config',
  );
  assert.ok(registration, 'no plugins.bundle.config entry was registered');
  assert.equal(registration.meta.key, TARGET_BUNDLE);
  assert.equal(registration.meta.locale, SETTINGS_NS);
  assert.equal(typeof registration.meta.inject, 'function');

  const injected = registration.meta.inject();
  assert.equal(injected.t, harness.t);
  assert.equal(injected.remote, harness.remote);
  assert.equal(injected.testRoute, harness.endpoint, 'the settings body must receive the mounted endpoint');

  assert.ok(
    harness.localeRegistrations.some(({ ns }) => ns === SETTINGS_NS),
    'apply must register the auto-review-model locale dictionaries',
  );
  assert.ok(
    harness.localeBinds.includes(SETTINGS_NS),
    'apply must bind the auto-review-model translator',
  );

  // Verify registered zh and en dictionaries align exactly in keys
  const reg = harness.localeRegistrations.find(({ ns }) => ns === SETTINGS_NS);
  assert.ok(reg);
  const dicts = reg.dictionaries as { zh: Record<string, string>; en: Record<string, string> };
  assert.ok(dicts.zh && dicts.en);
  const zhKeys = Object.keys(dicts.zh).sort();
  const enKeys = Object.keys(dicts.en).sort();
  assert.deepEqual(zhKeys, enKeys, 'zh and en dictionary keys must be identical');
  assert.equal(zhKeys.includes('enabled'), false, 'the master-enable copy must be removed');
  assert.equal(zhKeys.includes('enabledDesc'), false, 'the master-enable copy must be removed');
  assert.equal(zhKeys.includes('summaryModelFallback'), false, 'dead key summaryModelFallback must be removed');
  assert.equal(zhKeys.includes('sessionRowTitle'), false, 'the fixed session row copy must be removed');
  assert.ok(zhKeys.includes('unverified'), 'unverified key must exist');
  assert.ok(zhKeys.includes('notAdvertised'), 'notAdvertised key must exist');
  assert.ok(zhKeys.includes('effortInherit'), 'the inherit effort option must be localized');
  assert.ok(zhKeys.includes('routeEnabled'), 'the per-row enable copy must be localized');

  // Resource cleanup: UI first, then the mounted Remote namespace.
  assert.equal(typeof dispose, 'function');
  await (dispose as () => Promise<void>)();
  assert.deepEqual(harness.events.slice(-2), ['ui-dispose', 'unmount'], 'disposal must withdraw the UI before the Remote namespace');
});

test('apply keeps the settings body usable when the endpoint cannot mount', async () => {
  const harness = createApplyHarness({ mountFails: true });
  const dispose = await client.apply(harness.ctx);

  assert.equal(harness.mounted.length, 1, 'apply attempts the mount');
  assert.equal(harness.registrations.length, 1, 'the settings body must still be registered');
  const injected = harness.registrations[0].meta.inject();
  assert.equal(injected.testRoute, undefined, 'no endpoint is exposed when the mount failed');
  assert.equal(typeof dispose, 'function', 'apply still returns a disposer');
  await (dispose as () => Promise<void>)();
  assert.ok(!harness.events.includes('unmount'), 'nothing is unmounted when the mount failed');
});

test('formatText interpolates route facts and leaves unknown placeholders alone', () => {
  const { formatText } = testing();
  assert.equal(formatText('a {provider} b {env}', { provider: 'p', env: 'E' }), 'a p b E');
  assert.equal(formatText('{unknown}', {}), '{unknown}');
  assert.equal(formatText('static', { provider: 'p' }), 'static');
});

test('mapTestResult localizes successes and failures with actionable hints', () => {
  const { mapTestResult } = testing();
  // Fake dictionary carrying the placeholders the real locale templates use.
  const templates: Record<string, string> = {
    testOkHint: '',
    testSeconds: '{seconds}s',
    testNoEnvVar: 'THE_PROVIDER_SETTING',
    testDetail: 'Detail',
    testAccountSignInHint: 'Open Settings → DeepSeek Account and sign in ({provider})',
    testMissingCredentialHint: 'Add a credential for {provider} ({env})',
    testInvalidCredentialHint: 'Correct the credential for {provider}',
    testTimeoutHint: 'Check the network for {provider}',
    testUnknownHint: 'Review the detail',
    testRateLimitedHint: 'Wait for the provider rate limit to reset',
    testFailureCode: 'Failure code',
    testTransportHint: 'Retry the test',
    testEffortNote: 'The saved effort {effort} is not advertised',
  };
  const t = (key: string): string => (key in templates ? templates[key] : `[${key}]`);

  const ok = mapTestResult(validTestResult(), t);
  assert.equal(ok.tone, 'ok');
  assert.equal(ok.message, '[testOkMessage]');
  assert.equal(ok.hint, '');
  assert.equal(ok.detail, '');
  assert.equal(ok.note, '');

  const account = mapTestResult(validTestResult({
    status: 'error',
    code: 'ACCOUNT_SIGN_IN_REQUIRED',
    authKind: 'account',
    providerName: 'DeepSeek Account',
    credentialEnv: [],
  }), t);
  assert.equal(account.tone, 'error');
  assert.equal(account.message, '[testAccountSignInMessage]');
  assert.match(account.hint, /DeepSeek Account/);
  assert.match(account.hint, /\(DeepSeek Account\)/);

  const missing = mapTestResult(validTestResult({
    status: 'error',
    code: 'MISSING_CREDENTIAL',
    credentialEnv: ['PROVIDER_A_API_KEY'],
  }), t);
  assert.equal(missing.message, '[testMissingCredentialMessage]');
  assert.match(missing.hint, /Provider A/);
  assert.match(missing.hint, /PROVIDER_A_API_KEY/);

  const diagnosed = mapTestResult(validTestResult({
    status: 'error',
    code: 'AUTH',
    failureCode: 'HTTP_401',
    detail: 'Host advisory sentence that must not be duplicated',
  }), t);
  assert.match(diagnosed.detail, /HTTP_401/);
  assert.ok(!diagnosed.detail.includes('Host advisory sentence'), 'classified outcomes must not duplicate host prose');

  const invalid = mapTestResult(validTestResult({ status: 'error', code: 'INVALID_CREDENTIAL' }), t);
  assert.equal(invalid.message, '[testInvalidCredentialMessage]');
  assert.match(invalid.hint, /Provider A/);

  const noAdapter = mapTestResult(validTestResult({ status: 'error', code: 'NO_ADAPTER' }), t);
  assert.equal(noAdapter.message, '[testNoAdapterMessage]');

  const throttled = mapTestResult(validTestResult({
    status: 'blocked',
    code: 'RATE_LIMITED',
    retryAfterMs: 4000,
  }), t);
  assert.equal(throttled.tone, 'blocked');
  assert.match(throttled.hint, /provider rate limit/);
  assert.ok(ok.route.includes('Provider A'), 'the outcome must name the tested route');
  assert.equal(ok.route, 'Provider A / model-a1 · high');

  const timedOut = mapTestResult(validTestResult({ status: 'error', code: 'TIMEOUT' }), t);
  assert.equal(timedOut.message, '[testTimeoutMessage]');
  assert.match(timedOut.hint, /Check the network for Provider A/);

  const unknown = mapTestResult(validTestResult({ code: 'SOMETHING_NEW', status: 'error' }), t);
  assert.equal(unknown.message, '[testUnknownMessage]');
  assert.equal(unknown.hint, 'Review the detail');

  // The note explains the saved-effort fallback without changing the tone.
  const fallback = mapTestResult(validTestResult({
    effortUsed: '',
    effortNotAdvertised: true,
    route: { provider: 'provider-a', model: 'model-a1', reasoningEffort: 'high' },
  }), t);
  assert.equal(fallback.tone, 'ok');
  assert.match(fallback.note, /high/);
});

test('mapTestResult never renders provider output as prose', () => {
  const { mapTestResult } = testing();
  const t = (key: string) => `[${key}]`;
  const outcome = mapTestResult(validTestResult({
    status: 'error',
    code: 'UNKNOWN',
    detail: 'provider returned 503',
    prose: 'the model wrote this sentence',
  }) as never, t);
  const rendered = [outcome.message, outcome.hint, outcome.detail, outcome.note].join('\n');
  assert.ok(!rendered.includes('the model wrote this sentence'), 'model prose must never be displayed');
  assert.match(outcome.detail, /provider returned 503/);
});

test('mapTestTransportFailure and mapTestUnknownResult localize local failures', () => {
  const { mapTestTransportFailure, mapTestUnknownResult, safeErrorCode } = testing();
  const templates: Record<string, string> = {
    testFailureCode: 'Failure code',
    testTransportHint: 'Retry the test',
  };
  const t = (key: string): string => (key in templates ? templates[key] : `[${key}]`);

  // Arbitrary error messages (which may contain credentials or URLs) never
  // reach the page; only an identifier-shaped code does.
  const transport = mapTestTransportFailure(new Error('offline sk-live-SECRET'), t);
  assert.equal(transport.tone, 'error');
  assert.equal(transport.message, '[testTransportFailed]');
  assert.equal(transport.hint, 'Retry the test');
  assert.equal(transport.detail, '');
  assert.equal(transport.route, '');

  const coded = mapTestTransportFailure({ code: 'gateway/cancelled', message: 'secret sk-live-X' }, t);
  assert.equal(coded.detail, 'Failure code: gateway/cancelled');
  assert.ok(!coded.detail.includes('sk-live-X'), 'error messages must not be rendered');
  assert.equal(safeErrorCode({ code: 'a b' }), '');
  assert.equal(safeErrorCode({ code: 'gateway/internal' }), 'gateway/internal');
  assert.equal(safeErrorCode(undefined), '');

  const unknown = mapTestUnknownResult(t);
  assert.equal(unknown.message, '[testUnknownResult]');
  assert.equal(unknown.tone, 'error');
});

test('client retry delay text is locale-driven', () => {
  const { delayText } = testing();
  const t = (key: string) => (key === 'testSeconds' ? '{seconds}s' : `[${key}]`);
  assert.equal(delayText(4000, 30, t), '4s');
  assert.equal(delayText(0, 5, t), '5s');
  assert.equal(delayText(500, 30, t), '1s');
});

test('normalizeSettings supplies the route defaults and ignores the deprecated enabled knob', () => {
  const expected: ReviewerSettings = {
    primaryEnabled: true,
    provider: '',
    model: '',
    reasoningEffort: '',
  };
  assert.deepEqual(testing().normalizeSettings(), expected);
  assert.deepEqual(testing().normalizeSettings(undefined), expected);
  assert.deepEqual(testing().normalizeSettings(null), expected);
  const withDeprecated = testing().normalizeSettings({
    enabled: false,
    primaryEnabled: true,
    provider: 'p',
    model: 'm',
    reasoningEffort: '',
  });
  assert.equal(Object.hasOwn(withDeprecated, 'enabled'), false, 'the deprecated knob is never loaded');
  assert.equal(withDeprecated.primaryEnabled, true);
});

test('normalizeSettings trims strings and honors explicit enable flags', () => {
  assert.deepEqual(
    testing().normalizeSettings({
      enabled: false,
      primaryEnabled: false,
      provider: '  provider-a  ',
      model: '  model-a1  ',
      reasoningEffort: '  high  ',
    }),
    {
      primaryEnabled: false,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'high',
    },
  );
});

test('normalizeSettings tolerates dirty field values without throwing', () => {
  const normalized = testing().normalizeSettings({
    enabled: 'not-a-boolean',
    primaryEnabled: 'not-a-boolean',
    provider: 42,
    model: { unexpected: true },
    reasoningEffort: false,
  });
  assert.deepEqual(Object.keys(normalized).sort(), [
    'model',
    'primaryEnabled',
    'provider',
    'reasoningEffort',
  ]);
  assert.equal(typeof normalized.primaryEnabled, 'boolean');
  assert.equal(typeof normalized.provider, 'string');
  assert.equal(typeof normalized.model, 'string');
  assert.equal(typeof normalized.reasoningEffort, 'string');
});

test('namespaceSection unwraps namespace view and leaves regular sections intact', () => {
  const { namespaceSection } = testing();

  const view = {
    ns: 'auto-review-model',
    value: {
      primaryEnabled: false,
      provider: 'prov-1',
      model: 'mod-1',
      reasoningEffort: 'low',
    },
    revision: 5,
  };
  assert.deepEqual(namespaceSection(view), view.value);

  assert.equal(namespaceSection({ ns: 'test', value: 'hello', revision: 1 }), 'hello');

  const plain = { primaryEnabled: true, provider: 'prov-2' };
  assert.equal(namespaceSection(plain), plain);

  assert.equal(namespaceSection(null), null);
  assert.equal(namespaceSection(undefined), undefined);
  assert.equal(namespaceSection('string-val'), 'string-val');
  assert.equal(namespaceSection(123), 123);
  assert.equal(namespaceSection(false), false);
});

test('reconcileDraft retains provider, model, effort and enable flags when catalog is empty or missing', () => {
  const { reconcileDraft } = testing();
  const savedSettings: ReviewerSettings = {
    primaryEnabled: true,
    provider: 'provider-custom',
    model: 'model-custom',
    reasoningEffort: 'high',
  };

  assert.deepEqual(reconcileDraft(savedSettings, []), savedSettings);
  assert.deepEqual(reconcileDraft(savedSettings, undefined), savedSettings);
  assert.deepEqual(reconcileDraft(savedSettings, null), savedSettings);

  assert.deepEqual(
    reconcileDraft({
      primaryEnabled: false,
      provider: '  prov  ',
      model: '  mod  ',
      reasoningEffort: '  med  ',
    }, []),
    {
      primaryEnabled: false,
      provider: 'prov',
      model: 'mod',
      reasoningEffort: 'med',
    },
  );
});

test('providerGroups parses various catalog shapes and filters invalid entries', () => {
  const { providerGroups } = testing();
  assert.deepEqual(providerGroups(GROUPS), GROUPS);
  assert.deepEqual(providerGroups({ groups: GROUPS }), GROUPS);
  assert.deepEqual(providerGroups({ value: { groups: GROUPS } }), GROUPS);
  assert.deepEqual(providerGroups(null), []);
  assert.deepEqual(providerGroups(undefined), []);
  assert.deepEqual(providerGroups({ groups: [{ id: '', name: 'Empty' }] }), []);
  assert.deepEqual(providerGroups([{ id: 'p1' }]), [{ id: 'p1', name: 'p1', models: [] }]);
});

test('modelsFor selects the models of one provider group', () => {
  assert.deepEqual(testing().modelsFor(GROUPS, 'provider-a'), GROUPS[0].models);
  assert.deepEqual(testing().modelsFor(GROUPS, 'provider-b'), []);
  assert.deepEqual(testing().modelsFor(GROUPS, 'missing'), []);
  assert.deepEqual(testing().modelsFor(undefined, 'provider-a'), []);
  assert.deepEqual(testing().modelsFor(GROUPS, ''), []);
});

test('effortsFor normalizes advertised reasoning efforts to id/name entries', () => {
  assert.deepEqual(testing().effortsFor(GROUPS[0].models[0]), [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ]);
  assert.deepEqual(testing().effortsFor({ reasoning: { efforts: [' low ', 'high'] } }), [
    { id: 'low', name: 'low' },
    { id: 'high', name: 'high' },
  ]);
  assert.deepEqual(testing().effortsFor(GROUPS[0].models[2]), []);
  assert.deepEqual(testing().effortsFor(undefined), []);
  assert.deepEqual(testing().effortsFor({ reasoning: { efforts: [] } }), []);
});

test('routeAfterProvider clears model and effort on switch, but is a no-op when selecting the current provider', () => {
  const route: ReviewRoute = { enabled: true, provider: 'provider-a', model: 'model-a1', reasoningEffort: 'high' };
  assert.deepEqual(testing().routeAfterProvider(route, 'provider-b'), {
    enabled: true,
    provider: 'provider-b',
    model: '',
    reasoningEffort: '',
  });
  assert.deepEqual(testing().routeAfterProvider(route, ''), {
    enabled: true,
    provider: '',
    model: '',
    reasoningEffort: '',
  });
  assert.deepEqual(testing().routeAfterProvider(route, 'provider-a'), route);
  assert.deepEqual(testing().routeAfterProvider(route, '  provider-a  '), route);
  assert.deepEqual(
    testing().routeAfterProvider({ ...route, reasoningEffort: 'inherit' }, 'provider-b'),
    { enabled: true, provider: 'provider-b', model: '', reasoningEffort: 'inherit' },
    'the route-independent inherit sentinel survives a provider change',
  );
  assert.deepEqual(route, {
    enabled: true,
    provider: 'provider-a',
    model: 'model-a1',
    reasoningEffort: 'high',
  }, 'the input row must stay untouched');
});

test('routeAfterModel drops effort when switching model, but is a no-op when selecting the current model', () => {
  const route: ReviewRoute = { enabled: true, provider: 'provider-a', model: 'model-a1', reasoningEffort: 'high' };
  assert.deepEqual(testing().routeAfterModel(route, 'model-a2', GROUPS), {
    enabled: true,
    provider: 'provider-a',
    model: 'model-a2',
    reasoningEffort: '',
  });
  assert.deepEqual(testing().routeAfterModel(route, 'model-a3', GROUPS), {
    enabled: true,
    provider: 'provider-a',
    model: 'model-a3',
    reasoningEffort: '',
  });
  assert.deepEqual(testing().routeAfterModel(route, 'model-a1', GROUPS), route);
  assert.deepEqual(testing().routeAfterModel(route, '  model-a1  ', GROUPS), route);

  const unknown: ReviewRoute = { enabled: true, provider: 'provider-a', model: 'model-unknown-not-in-catalog', reasoningEffort: 'high' };
  assert.deepEqual(
    testing().routeAfterModel(unknown, 'model-unknown-not-in-catalog', GROUPS),
    unknown,
    're-selecting the current unknown model must not clear reasoningEffort',
  );
  assert.deepEqual(
    testing().routeAfterModel({ ...route, reasoningEffort: '' }, 'model-a2', GROUPS),
    { ...route, model: 'model-a2', reasoningEffort: '' },
  );
  assert.deepEqual(
    testing().routeAfterModel({ ...route, reasoningEffort: 'inherit' }, 'model-a2', GROUPS),
    { ...route, model: 'model-a2', reasoningEffort: 'inherit' },
    'the inherit sentinel survives a model change',
  );
});

test('loadReviewerSettings reads settings and the model catalog', async () => {
  let describeCalls = 0;
  let catalogCalls = 0;
  const remote = {
    settings: {
      describe: async () => {
        describeCalls += 1;
        return {
          ok: true,
          value: {
            namespaces: [
              { ns: 'other-plugin', value: {}, revision: 1 },
              {
                ns: SETTINGS_NS,
                value: {
                  enabled: false,
                  primaryEnabled: false,
                  provider: 'provider-a',
                  model: 'model-a1',
                  reasoningEffort: 'high',
                },
                revision: 11,
              },
            ],
          },
        };
      },
      replace: async () => {
        throw new Error('loadReviewerSettings must not write settings');
      },
    },
    session: {
      modelCatalog: async () => {
        catalogCalls += 1;
        return { ok: true, value: { groups: GROUPS } };
      },
    },
  };

  const loaded = await testing().loadReviewerSettings(remote, SETTINGS_NS);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.deepEqual(loaded.value, {
    primaryEnabled: false,
    provider: 'provider-a',
    model: 'model-a1',
    reasoningEffort: 'high',
  }, 'the deprecated enabled knob is not loaded');
  assert.equal(loaded.revision, 11);
  assert.deepEqual(loaded.groups, GROUPS);
  assert.equal(loaded.catalogError, '');
  assert.equal(describeCalls, 1);
  assert.equal(catalogCalls, 1);
});

test('loadReviewerSettings returns ok:true with empty groups and catalogError when modelCatalog fails or throws', async () => {
  const expectedSettings: ReviewerSettings = {
    primaryEnabled: true,
    provider: 'provider-saved',
    model: 'model-saved',
    reasoningEffort: 'low',
  };

  const remoteCatalogFailed = {
    settings: {
      describe: async () => ({
        ok: true,
        value: { namespaces: [{ ns: SETTINGS_NS, value: expectedSettings, revision: 20 }] },
      }),
      replace: async () => ({ ok: true }),
    },
    session: {
      modelCatalog: async () => ({ ok: false, error: { message: 'catalog service timeout' } }),
    },
  };
  const res1 = await testing().loadReviewerSettings(remoteCatalogFailed, SETTINGS_NS);
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.deepEqual(res1.value, expectedSettings);
    assert.equal(res1.revision, 20);
    assert.deepEqual(res1.groups, []);
    assert.match(res1.catalogError, /catalog service timeout/);
  }

  const remoteCatalogThrows = {
    settings: {
      describe: async () => ({
        ok: true,
        value: { namespaces: [{ ns: SETTINGS_NS, value: expectedSettings, revision: 21 }] },
      }),
      replace: async () => ({ ok: true }),
    },
    session: {
      modelCatalog: async () => {
        throw new Error('network disconnected');
      },
    },
  };
  const res2 = await testing().loadReviewerSettings(remoteCatalogThrows, SETTINGS_NS);
  assert.equal(res2.ok, true);
  if (res2.ok) {
    assert.deepEqual(res2.value, expectedSettings);
    assert.equal(res2.revision, 21);
    assert.deepEqual(res2.groups, []);
    assert.match(res2.catalogError, /network disconnected/);
  }
});

test('loadReviewerSettings reports settings RPC failures as { ok: false, error }', async () => {
  const failed = await testing().loadReviewerSettings(
    {
      settings: {
        describe: async () => ({ ok: false, error: { message: 'settings unavailable' } }),
        replace: async () => ({ ok: true }),
      },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
    },
    SETTINGS_NS,
  );
  assert.equal(failed.ok, false);
  assert.ok((failed as LoadResultErr).error, 'a failed load must carry an error');

  const thrown = await testing().loadReviewerSettings(
    {
      settings: {
        describe: async () => {
          throw new Error('boom');
        },
        replace: async () => ({ ok: true }),
      },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
    },
    SETTINGS_NS,
  );
  assert.equal(thrown.ok, false);
  assert.ok((thrown as LoadResultErr).error, 'a thrown load must carry an error');
});

test('summaryLine reflects loading, enabled rows and the implicit session fallback', () => {
  const { summaryLine } = testing();
  const t = (key: string) => `[${key}]`;

  assert.equal(
    summaryLine({ primaryEnabled: true, provider: 'p1', model: 'm1', reasoningEffort: '' }, true, t),
    '[summaryLabel]: [summaryLoading]',
  );
  assert.equal(
    summaryLine({ primaryEnabled: true, provider: '', model: '', reasoningEffort: '' }, false, t),
    '[summaryLabel]: [summarySession]',
  );
  assert.equal(
    summaryLine({ primaryEnabled: false, provider: 'p1', model: 'm1', reasoningEffort: 'high' }, false, t),
    '[summaryLabel]: [summarySession]',
    'a disabled row is not summarized as the active route',
  );
  assert.equal(
    summaryLine({ primaryEnabled: true, provider: 'p1', model: '', reasoningEffort: '' }, false, t),
    '[summaryLabel]: [summarySession]',
  );
  assert.equal(
    summaryLine({ primaryEnabled: true, provider: 'p1', model: 'm1', reasoningEffort: '' }, false, t),
    '[summaryLabel]: p1 / m1',
  );
  assert.equal(
    summaryLine({ primaryEnabled: true, provider: 'p1', model: 'm1', reasoningEffort: 'high' }, false, t),
    '[summaryLabel]: p1 / m1 · high',
  );
  assert.equal(
    summaryLine({ primaryEnabled: true, provider: 'p1', model: 'm1', reasoningEffort: 'inherit' }, false, t),
    '[summaryLabel]: p1 / m1 · inherit',
  );
});

test('saveReviewerSettings writes row 1 with primaryEnabled and no deprecated enabled field', async () => {
  let replaceArgs: unknown[] | null = null;
  const remote = {
    settings: {
      describe: async () => ({ ok: true, value: { namespaces: [] } }),
      replace: async (...args: unknown[]) => {
        replaceArgs = args;
        return { ok: true };
      },
    },
    session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
  };
  const draft: ReviewerSettings = {
    primaryEnabled: false,
    provider: 'provider-a',
    model: 'model-a1',
    reasoningEffort: 'high',
  };

  await testing().saveReviewerSettings(remote, SETTINGS_NS, draft, 11);
  assert.deepEqual(replaceArgs, [
    SETTINGS_NS,
    {
      primaryEnabled: false,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'high',
    },
    11,
  ]);
});

/* ============================================================
 * Ordered review-route list
 *
 * Row 1 maps to the top-level primaryEnabled/provider/model/reasoningEffort
 * fields and rows 2..N to the `fallbacks` array with a per-row `enabled` flag.
 * The session model is the implicit final fallback: it is never a row and
 * never persisted. The deprecated top-level `enabled` knob is never read or
 * written.
 * ============================================================ */

/** One explicit saved fallback entry (row 2..N shape). */
const SAVED_FALLBACK: FallbackEntry = {
  mode: 'route',
  enabled: true,
  provider: 'provider-b',
  model: 'model-b1',
  reasoningEffort: 'high',
};

/** One enabled explicit row in the catalog shared with the fallback rows. */
const ROUTE_A_ROW: ReviewRoute = {
  enabled: true,
  provider: 'provider-a',
  model: 'model-a1',
  reasoningEffort: 'high',
};

test('normalizeSettings keeps legacy sections without a fallbacks key', () => {
  const legacy = testing().normalizeSettings({
    provider: 'provider-a',
    model: 'model-a1',
    reasoningEffort: 'high',
  });
  assert.deepEqual(Object.keys(legacy).sort(), [
    'model',
    'primaryEnabled',
    'provider',
    'reasoningEffort',
  ]);
  assert.ok(!Object.hasOwn(legacy, 'fallbacks'), 'a legacy section must not gain a fallbacks key');
  assert.equal(legacy.primaryEnabled, true);
});

test('normalizeSettings drops legacy { mode: session } rows and keeps per-row enable flags', () => {
  const normalized = testing().normalizeSettings({
    primaryEnabled: true,
    provider: 'provider-a',
    model: 'model-a1',
    reasoningEffort: '',
    fallbacks: [
      { mode: 'session', provider: 'stale', model: 'stale', reasoningEffort: '' },
      { mode: ' ROUTE ', enabled: false, provider: ' provider-b ', model: ' model-b1 ', reasoningEffort: ' high ' },
      { mode: 'nonsense', provider: 'provider-a', model: 'model-a1' },
      'not-an-object',
    ],
  });
  assert.deepEqual(normalized.fallbacks, [
    { mode: 'route', enabled: false, provider: 'provider-b', model: 'model-b1', reasoningEffort: 'high' },
    { mode: 'route', enabled: true, provider: 'provider-a', model: 'model-a1', reasoningEffort: '' },
    { mode: 'route', enabled: true, provider: '', model: '', reasoningEffort: '' },
  ], 'only the legacy session row is dropped');

  assert.equal(testing().isLegacySessionEntry({ mode: 'SESSION' }), true);
  assert.equal(testing().isLegacySessionEntry({ mode: 'route' }), false);
  assert.equal(testing().isLegacySessionEntry(undefined), false);
  assert.deepEqual(testing().normalizeRoutes(undefined), []);
  assert.deepEqual(testing().normalizeRoutes('nope'), []);
});

test('rowsFromSettings maps row 1 and keeps incomplete or disabled rows visible', () => {
  assert.deepEqual(
    testing().rowsFromSettings({ primaryEnabled: true, provider: '', model: '', reasoningEffort: '' }),
    [],
    'an empty, enabled section has no explicit row',
  );
  assert.deepEqual(
    testing().rowsFromSettings({
      primaryEnabled: false,
      provider: '',
      model: '',
      reasoningEffort: '',
    }),
    [{ enabled: false, provider: '', model: '', reasoningEffort: '' }],
    'an explicitly disabled empty row 1 stays visible',
  );
  assert.deepEqual(
    testing().rowsFromSettings({
      primaryEnabled: true,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'high',
      fallbacks: [SAVED_FALLBACK],
    }),
    [
      { enabled: true, provider: 'provider-a', model: 'model-a1', reasoningEffort: 'high' },
      { enabled: true, provider: 'provider-b', model: 'model-b1', reasoningEffort: 'high' },
    ],
  );
  assert.deepEqual(
    testing().rowsFromSettings({
      primaryEnabled: true,
      provider: 'provider-a',
      model: '',
      reasoningEffort: '',
      fallbacks: [SAVED_FALLBACK],
    }),
    [
      { enabled: true, provider: 'provider-a', model: '', reasoningEffort: '' },
      { enabled: true, provider: 'provider-b', model: 'model-b1', reasoningEffort: 'high' },
    ],
    'an incomplete saved row 1 must stay visible',
  );
});

test('settingsFromRows splits row 1 and keeps per-row enable flags', () => {
  assert.deepEqual(
    testing().settingsFromRows([
      { enabled: false, provider: 'provider-a', model: 'model-a1', reasoningEffort: 'high' },
      { enabled: true, provider: 'provider-b', model: 'model-b1', reasoningEffort: '' },
    ]),
    {
      primaryEnabled: false,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'high',
      fallbacks: [{ mode: 'route', enabled: true, provider: 'provider-b', model: 'model-b1', reasoningEffort: '' }],
    },
  );
  assert.deepEqual(
    testing().settingsFromRows([]),
    { primaryEnabled: true, provider: '', model: '', reasoningEffort: '' },
    'an empty list keeps the legacy shape without a fallbacks key',
  );
  assert.deepEqual(
    testing().settingsFromRows([{ enabled: true, provider: 'provider-a', model: 'model-a1', reasoningEffort: '' }]),
    { primaryEnabled: true, provider: 'provider-a', model: 'model-a1', reasoningEffort: '' },
    'a single row needs no fallbacks key',
  );
});

test('settingsFromRows and rowsFromSettings round-trip the whole ordered list', () => {
  const rows: ReviewRoute[] = [
    { enabled: true, provider: 'p1', model: 'm1', reasoningEffort: 'inherit' },
    { enabled: false, provider: 'p2', model: 'm2', reasoningEffort: '' },
    { enabled: true, provider: '', model: '', reasoningEffort: '' },
  ];
  assert.deepEqual(testing().rowsFromSettings(testing().settingsFromRows(rows)), rows);
});

test('routesEqual detects enable changes and every meaningful list change', () => {
  const { routesEqual } = testing();
  const a: ReviewRoute[] = [ROUTE_A_ROW, { enabled: true, provider: 'provider-b', model: 'model-b1', reasoningEffort: 'high' }];
  const b = [
    { reasoningEffort: 'high', model: 'model-a1', provider: 'provider-a', enabled: true },
    { reasoningEffort: 'high', model: 'model-b1', provider: 'provider-b', enabled: true },
  ];
  assert.equal(routesEqual(a, b), true);
  assert.equal(routesEqual(undefined, []), true);
  assert.equal(routesEqual(a, [b[1], b[0]]), false, 'order must matter');
  assert.equal(routesEqual(a, [{ ...b[0], enabled: false }, b[1]]), false, 'enable flags must matter');
  assert.equal(routesEqual(a, [{ ...b[0], model: 'model-a2' }, b[1]]), false);
});

test('route row helpers keep the list immutable, ordered and capped at ten rows', () => {
  const {
    addRoute, removeRoute, moveRoute, replaceRoute, MAX_ROUTES, INHERIT_EFFORT,
  } = testing();
  assert.equal(MAX_ROUTES, 10);
  assert.equal(INHERIT_EFFORT, 'inherit');
  const base: ReviewRoute[] = [
    { enabled: true, provider: 'p1', model: 'm1', reasoningEffort: '' },
    { enabled: true, provider: 'p2', model: 'm2', reasoningEffort: '' },
    { enabled: true, provider: 'p3', model: 'm3', reasoningEffort: '' },
  ];
  const snapshot = structuredClone(base);

  const added = addRoute(base);
  assert.equal(added.length, 4);
  assert.deepEqual(added[3], {
    enabled: true,
    provider: '',
    model: '',
    reasoningEffort: 'inherit',
  }, 'a new row defaults to the inherit effort');
  assert.deepEqual(base, snapshot, 'the input list must not be mutated');

  assert.deepEqual(removeRoute(base, 1).map((route) => route.provider), ['p1', 'p3']);
  assert.deepEqual(removeRoute(base, 9), base);
  assert.deepEqual(moveRoute(base, 2, -1).map((route) => route.provider), ['p1', 'p3', 'p2']);
  assert.deepEqual(moveRoute(base, 0, 1).map((route) => route.provider), ['p2', 'p1', 'p3']);
  assert.deepEqual(moveRoute(base, 0, -1), base);
  assert.deepEqual(moveRoute(base, 2, 1), base);
  assert.deepEqual(
    replaceRoute(base, 1, { enabled: false, provider: 'px', model: 'mx', reasoningEffort: 'low' }),
    [
      base[0],
      { enabled: false, provider: 'px', model: 'mx', reasoningEffort: 'low' },
      base[2],
    ],
  );
  assert.deepEqual(base, snapshot);

  const full: ReviewRoute[] = Array.from({ length: MAX_ROUTES }, () => ({
    enabled: true,
    provider: 'p',
    model: 'm',
    reasoningEffort: '',
  }));
  assert.equal(addRoute(full).length, MAX_ROUTES, 'the whole explicit list is capped at 10 rows');
});

test('saveReviewerSettings persists enable flags with the split list', async () => {
  let replaceArgs: unknown[] | null = null;
  const remote = {
    settings: {
      describe: async () => ({ ok: true, value: { namespaces: [] } }),
      replace: async (...args: unknown[]) => {
        replaceArgs = args;
        return { ok: true };
      },
    },
    session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
  };
  const saved = await testing().saveReviewerSettings(
    remote,
    SETTINGS_NS,
    {
      primaryEnabled: false,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'inherit',
      fallbacks: [
        { mode: 'route', enabled: false, provider: ' provider-b ', model: ' model-b1 ', reasoningEffort: 'high' },
        { mode: 'route', enabled: true, provider: '', model: '', reasoningEffort: '' },
      ],
    },
    7,
  );
  assert.deepEqual(saved, { ok: true });
  assert.deepEqual(replaceArgs, [
    SETTINGS_NS,
    {
      primaryEnabled: false,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'inherit',
      fallbacks: [
        { mode: 'route', enabled: false, provider: 'provider-b', model: 'model-b1', reasoningEffort: 'high' },
        { mode: 'route', enabled: true, provider: '', model: '', reasoningEffort: '' },
      ],
    },
    7,
  ]);
  const payload = (replaceArgs as unknown[])[1] as Record<string, unknown>;
  assert.ok(!('enabled' in payload), 'the deprecated knob is never written');
});

test('summaryLine counts only enabled later rows', () => {
  const { summaryLine } = testing();
  const t = (key: string) => {
    if (key === 'summaryFallbacks') return '+{count} more routes';
    return `[${key}]`;
  };
  assert.equal(
    summaryLine(
      {
        primaryEnabled: true,
        provider: 'p1',
        model: 'm1',
        reasoningEffort: '',
        fallbacks: [SAVED_FALLBACK, { ...SAVED_FALLBACK, enabled: false }],
      },
      false,
      t,
    ),
    '[summaryLabel]: p1 / m1 · +1 more routes',
  );
});

test('the locale dictionaries cover the per-row enable, inherit and inline test copy', async () => {
  const harness = createApplyHarness();
  await client.apply(harness.ctx);
  const registered = harness.localeRegistrations.find(({ ns }) => ns === SETTINGS_NS);
  assert.ok(registered !== undefined, 'the client must register its dictionaries');
  const reg = registered.dictionaries as { zh: Record<string, string>; en: Record<string, string> };
  const zhKeys = Object.keys(reg.zh).sort();
  const enKeys = Object.keys(reg.en).sort();
  assert.deepEqual(zhKeys, enKeys);
  for (const key of [
    'reviewRoutesTitle',
    'reviewRoutesHint',
    'reviewRoutesEmpty',
    'routeAdd',
    'routeCapHint',
    'routeEnabled',
    'routeRowLabel',
    'routeTableLabel',
    'routeActions',
    'routeProvider',
    'routeProviderPlaceholder',
    'routeModel',
    'routeModelPlaceholder',
    'routeEffort',
    'routeIncompleteHint',
    'routeMoveUp',
    'routeMoveDown',
    'routeRemove',
    'effortInherit',
    'summarySession',
    'summaryFallbacks',
    'testUnavailableHint',
  ]) {
    assert.equal(typeof reg.zh[key], 'string', `${key} missing from zh`);
    assert.equal(typeof reg.en[key], 'string', `${key} missing from en`);
  }
  for (const removed of [
    'enabled',
    'enabledDesc',
    'fallbackMode',
    'fallbackModeRoute',
    'fallbackModeSession',
    'fallbackSessionHint',
    'fallbacksTitle',
    'summaryInherit',
    'sessionRowTitle',
    'sessionRowDesc',
    'testLabel',
    'testHint',
    'testHintDirty',
    'testOtherRoutesNote',
  ]) {
    assert.equal(zhKeys.includes(removed), false, `${removed} must be removed from zh`);
  }
});
