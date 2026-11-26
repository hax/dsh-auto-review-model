/**
 * Component-level tests for ReviewerModelConfig in `@aghost-prj/dsh-auto-review-model`.
 *
 * Exercises the actual React component functions and event handlers using a
 * minimal deterministic React hook driver. Verifies the single ordered route
 * list: per-row enable checkboxes, the inherit effort option, disabled-row
 * styling, the per-row test button and its independent inline result, and the
 * absence of the master switch, the visible index text and the fixed session
 * row.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

interface ReactElementLike {
  type: unknown;
  props: Record<string, any>;
}

interface ReactLike {
  createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): ReactElementLike;
  useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
  useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
  useCallback<T extends (...args: any[]) => any>(callback: T, dependencies?: readonly unknown[]): T;
  useRef<T>(initial: T): { current: T };
}

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

/** Hook driver state */
let hookIndex = 0;
let hookState: Array<{ value?: any; deps?: readonly unknown[]; cleanup?: () => void }> = [];
let pendingEffects: Array<() => void> = [];

const equalDeps = (a?: readonly unknown[], b?: readonly unknown[]): boolean => {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((x, i) => Object.is(x, b[i]));
};

const driverReact: ReactLike = {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): ReactElementLike {
    const nextProps: Record<string, any> = props === null || props === undefined ? {} : { ...props };
    if (children.length === 1) nextProps.children = children[0];
    else if (children.length > 1) nextProps.children = children;
    return { type, props: nextProps };
  },
  useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
    const i = hookIndex++;
    if (!hookState[i]) {
      hookState[i] = { value: typeof initial === 'function' ? (initial as () => T)() : initial };
    }
    const setValue = (next: T | ((previous: T) => T)): void => {
      hookState[i].value = typeof next === 'function' ? (next as (prev: T) => T)(hookState[i].value) : next;
    };
    return [hookState[i].value, setValue];
  },
  useCallback<T extends (...args: any[]) => any>(callback: T, deps?: readonly unknown[]): T {
    const i = hookIndex++;
    if (!hookState[i] || !equalDeps(hookState[i].deps, deps)) {
      hookState[i] = { value: callback, deps };
    }
    return hookState[i].value;
  },
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
    const i = hookIndex++;
    if (!hookState[i] || !equalDeps(hookState[i].deps, deps)) {
      hookState[i]?.cleanup?.();
      hookState[i] = { deps };
      pendingEffects.push(() => {
        const cleanup = effect();
        if (typeof cleanup === 'function') {
          hookState[i].cleanup = cleanup;
        }
      });
    }
  },
  useRef<T>(initial: T): { current: T } {
    const i = hookIndex++;
    if (!hookState[i]) {
      hookState[i] = { value: { current: initial } };
    }
    return hookState[i].value;
  },
};

function resetDriver(): void {
  for (const entry of hookState) {
    entry?.cleanup?.();
  }
  hookIndex = 0;
  hookState = [];
  pendingEffects = [];
}

function flattenNodes(tree: unknown): Array<{ type: unknown; props: Record<string, any> }> {
  if (!tree || typeof tree !== 'object') return [];
  const node = tree as { type: unknown; props?: Record<string, any> };
  const children = node.props?.children;
  let childNodes: Array<{ type: unknown; props: Record<string, any> }> = [];
  if (Array.isArray(children)) {
    childNodes = children.flat(Infinity).flatMap(flattenNodes);
  } else if (children && typeof children === 'object') {
    childNodes = flattenNodes(children);
  }
  return [{ type: node.type, props: node.props ?? {} }, ...childNodes];
}

function findButton(
  nodes: Array<{ type: unknown; props: Record<string, any> }>,
  text: string,
): { type: unknown; props: Record<string, any> } | undefined {
  return nodes.find((n) => {
    if (n.type !== 'button') return false;
    const c = n.props?.children;
    if (typeof c === 'string') return c === text;
    if (Array.isArray(c)) return c[0] === text || c.includes(text);
    return false;
  });
}

function findNodeByClass(
  nodes: Array<{ type: unknown; props: Record<string, any> }>,
  className: string,
): { type: unknown; props: Record<string, any> } | undefined {
  return nodes.find((n) => typeof n.props?.className === 'string' && n.props.className.includes(className));
}

/** Find one ARMSelect/button/input element by its action attribute. */
function findByAction(
  nodes: Array<{ type: unknown; props: Record<string, any> }>,
  action: string,
): { type: unknown; props: Record<string, any> } | undefined {
  return nodes.find((node) => node.props?.['data-arm-action'] === action);
}

/** Find one ARMSelect element by its `testId` prop (the driver never renders it). */
function findByTestId(
  nodes: Array<{ type: unknown; props: Record<string, any> }>,
  testId: string,
): { type: unknown; props: Record<string, any> } | undefined {
  return nodes.find((node) => node.props?.testId === testId);
}

/** Every rendered explicit route row, in DOM order. */
function routeRows(nodes: Array<{ type: unknown; props: Record<string, any> }>) {
  return nodes.filter((node) => node.props?.['data-route-index'] !== undefined);
}

interface ClientPluginExports {
  apply(ctx: unknown): unknown;
  inject: string[];
  name: string;
  __testing: Record<string, any>;
}

let clientPlugin: ClientPluginExports;

test.before(() => {
  assert.equal(importError, null, `client failed to import: ${importError?.stack ?? ''}`);
  assert.equal(registrations.length, 2, 'the bundle must register the ./remote chunk and the main factory');
  const mainEntry = registrations.find(
    (entry) => entry.id === '@aghost-prj/dsh-auto-review-model' && entry.chunk === undefined,
  );
  assert.ok(mainEntry, 'client did not register its main factory');
  const factories = new Map<string, ModuleLoaderEntry['factory']>();
  for (const entry of registrations) {
    const id = entry.chunk === undefined ? entry.id : `${entry.id}/${entry.chunk}`;
    factories.set(id, entry.factory);
  }
  const requireFromTable = (specifier: string): unknown => {
    if (specifier === 'react') return driverReact;
    const factory = factories.get(specifier);
    if (factory === undefined) throw new Error(`module table missed ${specifier}`);
    return factory(requireFromTable);
  };
  clientPlugin = mainEntry.factory(requireFromTable) as unknown as ClientPluginExports;
});

interface FallbackSetting {
  mode: string;
  enabled?: boolean;
  weight?: number;
  provider: string;
  model: string;
  reasoningEffort: string;
}

interface SetupTestEnvOptions {
  savedSettings?: {
    primaryEnabled?: boolean;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    fallbacks?: FallbackSetting[];
    routes?: FallbackSetting[];
  };
  revision?: number;
  catalogAvailable?: boolean;
  catalogGroups?: any[];
  lang?: 'zh' | 'en';
  /** Response returned by the mounted per-row test endpoint. */
  testResponse?: { ok: boolean; value?: unknown; error?: unknown };
  /** Response selector based on the probed input. */
  testResponseFor?: (input: { provider?: string; model?: string; reasoningEffort?: string }) => { ok: boolean; value?: unknown; error?: unknown };
  /** Simulate the Remote endpoint failing to mount (optional action unavailable). */
  endpointUnavailable?: boolean;
  /** Simulate the Remote call itself rejecting. */
  testRejects?: boolean;
  /** Hold the Remote call open until this promise settles. */
  testPending?: Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
}

/** Healthy wire result of one saved-route probe. */
function testResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Measured ledger health the page reads once on mount. */
const healthSnapshot = {
  ledger: 'auto-review-ledger-2026-W48.jsonl',
  week: '2026-W48',
  records: 12,
  routes: [
    {
      provider: 'provider-a',
      model: 'model-a1',
      attempts: 8,
      answered: 7,
      failed: 1,
      avgMs: 2100,
      lastAt: 1,
      lastFailureCode: 'QUOTA',
    },
    {
      provider: 'provider-b',
      model: 'model-b1',
      attempts: 4,
      answered: 4,
      failed: 0,
      avgMs: 900,
      lastAt: 2,
      lastFailureCode: '',
    },
  ],
};

/** Reject with the caller's signal as soon as it aborts, like a real Remote call. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function setupComponent(options: SetupTestEnvOptions = {}) {
  resetDriver();
  const saved = {
    primaryEnabled: true,
    provider: '',
    model: '',
    reasoningEffort: '',
    ...options.savedSettings,
  };
  const revision = options.revision ?? 1;
  const writes: any[] = [];
  let currentSettings = { ...saved };
  let currentRevision = revision;

  const endpoint = {
    calls: [] as Array<{ input?: { provider?: string; model?: string; reasoningEffort?: string }; signal?: AbortSignal }>,
    inputs: [] as Array<{ mode?: string; provider?: string; model?: string; reasoningEffort?: string } | undefined>,
    healthCalls: 0,
    async testReviewRoute(
      input?: { mode?: string; provider?: string; model?: string; reasoningEffort?: string },
      signal?: AbortSignal,
    ) {
      // The page reads the measured ledger once on mount; that read is not a
      // probe and must not consume the probe call log the tests assert on.
      if (input?.mode === 'health') {
        endpoint.healthCalls += 1;
        return { ok: true, value: { ...testResult(), health: healthSnapshot } };
      }
      endpoint.calls.push({ input, signal });
      endpoint.inputs.push(input);
      if (options.testPending !== undefined) return await raceAbort(options.testPending, signal);
      if (options.testRejects === true) throw new Error('remote call failed');
      if (options.testResponseFor !== undefined) return options.testResponseFor(input ?? {});
      return options.testResponse ?? { ok: true, value: testResult() };
    },
  };
  let mountedContributions = 0;

  const remote = {
    settings: {
      async describe(): Promise<any> {
        return {
          ok: true,
          value: {
            namespaces: [
              {
                ns: 'auto-review-model',
                value: currentSettings,
                revision: currentRevision,
              },
            ],
          },
        };
      },
      async replace(ns: string, nextSettings: any, expectedRevision?: number): Promise<any> {
        writes.push({ ns, nextSettings, expectedRevision });
        currentSettings = { ...nextSettings };
        currentRevision += 1;
        return {
          ok: true,
          value: {
            ns,
            value: nextSettings,
            revision: currentRevision,
          },
        };
      },
    },
    session: {
      async modelCatalog() {
        if (options.catalogAvailable === false) {
          return { ok: false, error: { message: 'model catalog offline' } };
        }
        return {
          ok: true,
          value: {
            groups: options.catalogGroups ?? DEFAULT_CATALOG,
          },
        };
      },
    },
    async $mount() {
      mountedContributions += 1;
      if (options.endpointUnavailable === true) throw new Error('endpoint unavailable');
      return async () => {
        mountedContributions -= 1;
      };
    },
  };

  const registeredLocale: Record<string, Record<string, string>> = {};
  const slots: Array<{ meta: any; component: (props: any) => ReactElementLike }> = [];

  const lang = options.lang ?? 'zh';
  const t = (key: string): string => {
    const dict = registeredLocale[lang] ?? {};
    return dict[key] ?? key;
  };

  const ctx = {
    get(name: string) {
      if (name === 'slots') {
        return {
          inject(_name: string, cb: () => void) {
            cb();
          },
          register(meta: any, component: any) {
            slots.push({ meta, component });
          },
        };
      }
      if (name === 'locale') {
        return {
          register(_ns: string, dicts: Record<string, Record<string, string>>) {
            Object.assign(registeredLocale, dicts);
          },
          bind() {
            return t;
          },
        };
      }
      if (name === 'remote') return remote;
      if (name === 'remote.autoReviewModel') {
        return options.endpointUnavailable === true ? undefined : endpoint;
      }
      return undefined;
    },
    effect(cb: () => void) {
      cb();
    },
    inject(_deps: readonly string[], cb: (child: unknown) => unknown) {
      const disposer = cb(ctx);
      return {
        dispose() {
          if (typeof disposer === 'function') disposer();
        },
      };
    },
  };

  await clientPlugin.apply(ctx);
  const Component = slots[0].component;

  let lastTree: ReactElementLike | null = null;
  function render(view: 'page' | 'summary' = 'page'): ReactElementLike {
    hookIndex = 0;
    lastTree = Component({ view, remote, t, testRoute: options.endpointUnavailable === true ? undefined : endpoint });
    const pending = pendingEffects;
    pendingEffects = [];
    for (const effect of pending) effect();
    return lastTree;
  }

  async function flush(view: 'page' | 'summary' = 'page'): Promise<ReactElementLike> {
    await new Promise((resolve) => setImmediate(resolve));
    return render(view);
  }

  return {
    remote,
    endpoint,
    writes,
    t,
    render,
    flush,
    mountedContributions: () => mountedContributions,
    unmount: () => resetDriver(),
  };
}

/** Default catalog with one provider carrying two efforts. */
const DEFAULT_CATALOG = [
  {
    id: 'provider-a',
    name: 'Provider A',
    models: [
      {
        id: 'model-a1',
        name: 'Model A1',
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
      },
    ],
  },
];

/** Catalog with two providers so rows can pick different routes. */
const ROUTE_CATALOG = [
  ...DEFAULT_CATALOG,
  {
    id: 'provider-b',
    name: 'Provider B',
    models: [{ id: 'model-b1', name: 'Model B1' }],
  },
];

/** A saved route the default fake catalog can represent. */
const SAVED_ROUTE = {
  primaryEnabled: true,
  provider: 'provider-a',
  model: 'model-a1',
  reasoningEffort: 'high',
} as const;

/** Toggle row 1's enable checkbox to create a dirty edit. */
function toggleRow(nodes: Array<{ type: unknown; props: Record<string, any> }>, index: number, enabled: boolean): void {
  findByAction(nodes, `route-${index}-enable`)?.props.onChange({ target: { checked: enabled } });
}

/* ============================================================
 * Saved effort display and editing
 * ============================================================ */

test('unknown saved effort is displayed and preserved when model catalog fails', async () => {
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE },
    catalogAvailable: false,
  });

  env.render();
  let tree = await env.flush();
  let allNodes = flattenNodes(tree);
  const effortControl = allNodes.find((n) => n.props?.label === env.t('routeEffort') + ' 1');
  assert.ok(effortControl, 'reasoning effort control must exist');
  assert.equal(effortControl.props.value, 'high');
  const effortOptions = effortControl.props.options as Array<{ value: string; label: string }>;
  const highOption = effortOptions.find((o) => o.value === 'high');
  assert.ok(highOption, 'options must include the saved unknown effort');
  assert.match(highOption.label, /high.*未验证|high.*unverified/i);
  assert.equal(effortControl.props.disabled, false);

  toggleRow(allNodes, 0, false);
  tree = env.render();

  env.remote.session.modelCatalog = async () => ({
    ok: true,
    value: {
      groups: [
        {
          id: 'provider-a',
          name: 'Provider A',
          models: [
            {
              id: 'model-a1',
              name: 'Model A1',
              reasoning: { efforts: [{ id: 'low', name: 'Low' }] },
            },
          ],
        },
      ],
    },
  });

  const saveButton = findButton(flattenNodes(env.render()), env.t('save'));
  assert.ok(saveButton);
  assert.equal(saveButton.props.disabled, false);
  saveButton.props.onClick();
  const postSaveTree = await env.flush();

  assert.equal(env.writes.length, 1);
  const written = env.writes[0].nextSettings;
  assert.equal(written.routes.length, 1);
  assert.equal(written.routes[0].reasoningEffort, 'high');
  assert.equal(written.routes[0].enabled, false);
  const postSaveEffort = flattenNodes(postSaveTree).find((n) => n.props?.label === env.t('routeEffort') + ' 1');
  assert.ok(postSaveEffort);
  const postSaveHigh = (postSaveEffort.props.options as Array<{ value: string; label: string }>)
    .find((o) => o.value === 'high');
  assert.ok(postSaveHigh);
  assert.match(postSaveHigh.label, /high.*未声明|high.*not advertised/i);
});

test('unknown saved effort is displayed when the model has no reasoning metadata', async () => {
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE, model: 'model-no-reasoning' },
    catalogGroups: [
      {
        id: 'provider-a',
        name: 'Provider A',
        models: [{ id: 'model-no-reasoning', name: 'Model Without Reasoning' }],
      },
    ],
  });
  env.render();
  const tree = await env.flush();
  const effortControl = flattenNodes(tree).find((n) => n.props?.label === env.t('routeEffort') + ' 1');
  assert.ok(effortControl);
  assert.equal(effortControl.props.value, 'high');
  assert.equal(effortControl.props.disabled, false);
  const highOption = (effortControl.props.options as Array<{ value: string; label: string }>)
    .find((o) => o.value === 'high');
  assert.ok(highOption);
  assert.match(highOption.label, /high.*未声明|high.*not advertised/i);
});

test('user can explicitly clear an unknown effort to default when catalog fails', async () => {
  const env = await setupComponent({ savedSettings: { ...SAVED_ROUTE }, catalogAvailable: false });
  env.render();
  let tree = await env.flush();
  const effortControl = flattenNodes(tree).find((n) => n.props?.label === env.t('routeEffort') + ' 1');
  assert.ok(effortControl);
  effortControl.props.onChange('');
  tree = env.render();
  const updated = flattenNodes(tree).find((n) => n.props?.label === env.t('routeEffort') + ' 1');
  assert.equal(updated?.props.value, '');
  findButton(flattenNodes(tree), env.t('save'))?.props.onClick();
  await env.flush();
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].nextSettings.routes[0].reasoningEffort, '');
});

test('saved non-empty effort with empty model can be explicitly cleared in UI', async () => {
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE, model: '' },
    catalogAvailable: true,
  });
  env.render();
  let tree = await env.flush();
  const effortControl = flattenNodes(tree).find((n) => n.props?.label === env.t('routeEffort') + ' 1');
  assert.ok(effortControl);
  assert.equal(effortControl.props.value, 'high');
  assert.equal(effortControl.props.disabled, false);
  effortControl.props.onChange('');
  tree = env.render();
  const updated = flattenNodes(tree).find((n) => n.props?.label === env.t('routeEffort') + ' 1');
  assert.equal(updated?.props.value, '');
  assert.equal(updated?.props.disabled, true);
  const saveButton = findButton(flattenNodes(tree), env.t('save'));
  assert.ok(saveButton);
  saveButton.props.onClick();
  await env.flush();
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].nextSettings.routes[0].reasoningEffort, '');
  assert.equal(env.writes[0].nextSettings.routes[0].model, '');
});

test('re-selecting current provider or model is a no-op and preserves dirty state', async () => {
  const env = await setupComponent({ savedSettings: { ...SAVED_ROUTE } });
  env.render();
  let tree = await env.flush();
  let allNodes = flattenNodes(tree);

  assert.equal(findNodeByClass(allNodes, 'dsh_arm_unsaved'), undefined);

  allNodes.find((n) => n.props?.label === env.t('routeModel') + ' 1')?.props.onChange('model-a1');
  allNodes = flattenNodes(env.render());
  assert.equal(findNodeByClass(allNodes, 'dsh_arm_unsaved'), undefined, 're-selecting the model is a no-op');
  assert.equal(
    allNodes.find((n) => n.props?.label === env.t('routeEffort') + ' 1')?.props.value,
    'high',
  );

  allNodes.find((n) => n.props?.label === env.t('routeProvider') + ' 1')?.props.onChange('provider-a');
  allNodes = flattenNodes(env.render());
  assert.equal(findNodeByClass(allNodes, 'dsh_arm_unsaved'), undefined, 're-selecting the provider is a no-op');
  assert.equal(
    allNodes.find((n) => n.props?.label === env.t('routeModel') + ' 1')?.props.value,
    'model-a1',
  );
  tree = env.render();
  assert.ok(tree);
});

/* ============================================================
 * Incomplete rows and summary
 * ============================================================ */

test('an incomplete row is marked as skipped and save is still permitted', async () => {
  const env = await setupComponent({
    savedSettings: { primaryEnabled: true, provider: 'provider-a', model: '' },
  });
  env.render();
  let tree = await env.flush();
  let allNodes = flattenNodes(tree);
  const hints = allNodes.filter(
    (node) => node.props?.className?.includes('dsh_arm_routeHintCell')
      && typeof node.props?.children === 'string',
  );
  assert.ok(
    hints.some((node) => node.props.children === env.t('routeIncompleteHint')),
    'an incomplete row must say it will be skipped',
  );

  toggleRow(allNodes, 0, false);
  tree = env.render();
  const saveButton = findButton(flattenNodes(tree), env.t('save'));
  assert.ok(saveButton);
  assert.equal(saveButton.props.disabled, false);
  saveButton.props.onClick();
  await env.flush();
  assert.equal(env.writes.length, 1);
  const written = env.writes[0].nextSettings;
  assert.equal(written.routes[0].model, '');
  assert.equal(written.routes[0].enabled, false);
  assert.equal(written.routes[0].provider, 'provider-a');
});

test('the English incomplete-row hint matches the Chinese meaning', async () => {
  const env = await setupComponent({
    savedSettings: { primaryEnabled: true, provider: 'provider-a', model: '' },
    lang: 'en',
  });
  env.render();
  const allNodes = flattenNodes(await env.flush());
  const hint = allNodes.find(
    (node) => node.props?.className?.includes('dsh_arm_routeHintCell')
      && node.props?.children === env.t('routeIncompleteHint'),
  );
  assert.ok(hint, 'the incomplete-row hint must render in English');
  assert.match(String(hint?.props?.children ?? ''), /incomplete.*skipped during review/i);
});

test('summaryLine reports the implicit session fallback when row 1 is incomplete', async () => {
  const env = await setupComponent({
    savedSettings: { primaryEnabled: true, provider: 'provider-a', model: '' },
  });
  env.render();
  const tree = await env.flush('summary');
  const summaryNode = flattenNodes(tree).find((n) => n.props?.className?.includes('dsh_arm_summary'));
  assert.ok(summaryNode);
  const summaryText = String(summaryNode.props?.children ?? '');
  assert.doesNotMatch(summaryText, /provider-a\s*\//);
  assert.match(summaryText, /主会话模型/);
});

/* ============================================================
 * Save / reload / discard
 * ============================================================ */

test('handles save, reload, discard and revision conflicts correctly', async () => {
  let conflictOnSave = true;
  const env = await setupComponent({ savedSettings: { ...SAVED_ROUTE } });
  const originalReplace = env.remote.settings.replace;
  env.remote.settings.replace = async (ns: string, settings: any, expectedRevision?: number) => {
    if (conflictOnSave) {
      conflictOnSave = false;
      return { ok: false, error: { code: 'settings/conflict', message: 'revision mismatch' } };
    }
    return originalReplace(ns, settings, expectedRevision);
  };

  env.render();
  let tree = await env.flush();
  let allNodes = flattenNodes(tree);
  toggleRow(allNodes, 0, false);
  tree = env.render();

  let saveButton = findButton(flattenNodes(tree), env.t('save'));
  assert.ok(saveButton);
  saveButton.props.onClick();
  tree = await env.flush();

  let statusNode = flattenNodes(tree).find((n) => n.props?.className?.includes('dsh_arm_statusError'));
  assert.ok(statusNode, 'status error element should appear on conflict');
  assert.match(String(statusNode.props?.children ?? ''), /设置已被其他窗口修改/);

  findButton(flattenNodes(tree), env.t('reload'))?.props.onClick();
  tree = await env.flush();
  statusNode = flattenNodes(tree).find((n) => n.props?.className?.includes('dsh_arm_statusError'));
  assert.equal(statusNode, undefined);

  allNodes = flattenNodes(tree);
  toggleRow(allNodes, 0, false);
  tree = env.render();
  saveButton = findButton(flattenNodes(tree), env.t('save'));
  assert.ok(saveButton);
  saveButton.props.onClick();
  tree = await env.flush();

  const statusOk = flattenNodes(tree).find((n) => n.props?.className?.includes('dsh_arm_statusOk'));
  assert.ok(statusOk, 'status ok element should appear on successful save');
  assert.equal(statusOk.props?.children, env.t('saved'));

  allNodes = flattenNodes(tree);
  toggleRow(allNodes, 0, true);
  tree = env.render();
  assert.ok(findNodeByClass(flattenNodes(tree), 'dsh_arm_unsaved'));
  findButton(flattenNodes(tree), env.t('discard'))?.props.onClick();
  tree = env.render();
  assert.equal(findNodeByClass(flattenNodes(tree), 'dsh_arm_unsaved'), undefined);
});

test('handles save re-read failure with fallback to response snapshot and revision', async () => {
  for (const variant of ['viewRevision', 'responseRevision'] as const) {
    let reReadFails = false;
    const env = await setupComponent({
      savedSettings: { ...SAVED_ROUTE },
      revision: 10,
    });

    const originalDescribe = env.remote.settings.describe;
    env.remote.settings.describe = async () => {
      if (reReadFails) {
        return {
          ok: false,
          error: { code: 'settings/network_error', message: 'connection dropped on re-read' },
        };
      }
      return originalDescribe();
    };

    env.remote.settings.replace = async (ns: string, nextSettings: any, expectedRevision?: number) => {
      env.writes.push({ ns, nextSettings, expectedRevision });
      if (variant === 'viewRevision') {
        return {
          ok: true,
          revision: 999,
          value: { ns, value: nextSettings, revision: 15 },
        };
      }
      return { ok: true, revision: 15, value: { ns, value: nextSettings } };
    };

    env.render();
    let tree = await env.flush();
    toggleRow(flattenNodes(tree), 0, false);
    tree = env.render();

    reReadFails = true;
    findButton(flattenNodes(tree), env.t('save'))?.props.onClick();
    tree = await env.flush();

    const statusError = flattenNodes(tree).find((n) => n.props?.className?.includes('dsh_arm_statusError'));
    assert.ok(statusError, `[${variant}] a re-read failure must be reported`);
    assert.match(String(statusError.props?.children ?? ''), /已保存.*重新读取.*失败|saved.*reloading.*failed/i);
    assert.equal(
      findNodeByClass(flattenNodes(tree), 'dsh_arm_unsaved'),
      undefined,
      `[${variant}] the form must not look dirty after a successful save`,
    );

    reReadFails = false;
    toggleRow(flattenNodes(tree), 0, true);
    tree = env.render();
    findButton(flattenNodes(tree), env.t('save'))?.props.onClick();
    await env.flush();

    assert.equal(env.writes.length, 2);
    assert.equal(env.writes[1].expectedRevision, 15);
  }
});

/* ============================================================
 * Single ordered route list
 * ============================================================ */

test('rows have no visible index text, a position-based accessible name and no session row', async () => {
  const env = await setupComponent({
    savedSettings: {
      ...SAVED_ROUTE,
      fallbacks: [
        { mode: 'route', enabled: true, provider: 'provider-b', model: 'model-b1', reasoningEffort: '' },
      ],
    },
    catalogGroups: ROUTE_CATALOG,
  });
  env.render();
  const nodes = flattenNodes(await env.flush());
  const rows = routeRows(nodes);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.props['data-route-index']), [0, 1]);
  assert.equal(rows[0].props['aria-label'], env.t('routeRowLabel').replace('{index}', '1'));
  assert.equal(rows[1].props['aria-label'], env.t('routeRowLabel').replace('{index}', '2'));

  // No visible "#n" ordinal anywhere in the rendered page.
  assert.equal(
    nodes.some((node) => typeof node.props?.children === 'string' && /^#\d+$/.test(node.props.children)),
    false,
    'no visible ordinal label may be rendered',
  );

  // No fixed session-model row and no master enable checkbox.
  assert.equal(nodes.some((node) => node.props?.['data-route-session'] === 'true'), false);
  const checkboxes = nodes.filter((node) => node.type === 'input' && node.props?.type === 'checkbox');
  assert.ok(checkboxes.length >= 2);
  for (const checkbox of checkboxes) {
    assert.match(String(checkbox.props['data-arm-action'] ?? ''), /^route-\d+-enable$/);
  }

  // No standalone test section with duplicated hint text.
  assert.equal(nodes.some((node) => node.props?.className === 'dsh_arm_test'), false);
  assert.equal(nodes.some((node) => node.props?.['data-arm-test'] === 'true'), false);

  // Real table semantics: one table, a colgroup and one header cell per column.
  const table = nodes.find((node) => node.type === 'table' && node.props?.['data-arm-table'] === 'true');
  assert.ok(table, 'the routes must render as a real table');
  assert.equal(table.props.className, 'dsh_arm_table');
  assert.equal(nodes.filter((node) => node.type === 'col').length, 6, 'six fixed columns');
  assert.equal(nodes.filter((node) => node.type === 'th').length, 6, 'six scoped column headers');
  for (const header of nodes.filter((node) => node.type === 'th')) {
    assert.equal(header.props.scope, 'col');
  }
  assert.equal(routeRows(nodes).length, 2, 'one <tr data-route-index> per route');
  for (const row of rows) assert.equal(row.type, 'tr');
});

test('each row shows an enabled checkbox and the inherit effort option', async () => {
  const env = await setupComponent({
    savedSettings: {
      ...SAVED_ROUTE,
      fallbacks: [
        { mode: 'route', enabled: false, provider: 'provider-b', model: 'model-b1', reasoningEffort: 'inherit' },
      ],
    },
    catalogGroups: ROUTE_CATALOG,
  });
  env.render();
  const nodes = flattenNodes(await env.flush());

  assert.equal(findByAction(nodes, 'route-0-enable')?.props.checked, true);
  assert.equal(findByAction(nodes, 'route-1-enable')?.props.checked, false);

  const effort1 = findByTestId(nodes, 'route-1-effort');
  assert.equal(effort1?.props.value, 'inherit');
  const effectOptions = effort1?.props.options as Array<{ value: string; label: string }>;
  assert.ok(effectOptions.some((option) => option.value === 'inherit' && option.label === env.t('effortInherit')));

  // A disabled row is de-emphasised but stays editable and testable.
  assert.match(String(rowClassName(nodes, 1)), /dsh_arm_rowDisabled/);
  assert.equal(findByTestId(nodes, 'route-1-provider')?.props.disabled, false);
  assert.equal(findByAction(nodes, 'route-1-test')?.props.disabled, false);
});

/** Read one route row's class name by index. */
function rowClassName(nodes: Array<{ type: unknown; props: Record<string, any> }>, index: number): string {
  return String(routeRows(nodes)[index]?.props?.className ?? '');
}

test('new rows default to the inherit effort and are saved enabled', async () => {
  const env = await setupComponent({
    savedSettings: { primaryEnabled: true, provider: 'provider-a', model: 'model-a1', reasoningEffort: '' },
    catalogGroups: ROUTE_CATALOG,
  });
  env.render();
  let nodes = flattenNodes(await env.flush());
  findByAction(nodes, 'route-add')?.props.onClick();
  nodes = flattenNodes(await env.flush());
  assert.equal(routeRows(nodes).length, 2);
  assert.equal(findByTestId(nodes, 'route-1-effort')?.props.value, 'inherit');
  assert.equal(findByAction(nodes, 'route-1-enable')?.props.checked, true);
  assert.ok(findNodeByClass(nodes, 'dsh_arm_unsaved'));

  findByTestId(nodes, 'route-1-provider')?.props.onChange('provider-b');
  nodes = flattenNodes(await env.flush());
  findByTestId(nodes, 'route-1-model')?.props.onChange('model-b1');
  nodes = flattenNodes(await env.flush());

  findButton(nodes, env.t('save'))?.props.onClick();
  await env.flush();
  assert.equal(env.writes.length, 1);
  assert.deepEqual(env.writes[0].nextSettings.routes, [
    { mode: 'route', enabled: true, weight: 0, provider: 'provider-a', model: 'model-a1', reasoningEffort: '' },
    { mode: 'route', enabled: true, weight: 0, provider: 'provider-b', model: 'model-b1', reasoningEffort: 'inherit' },
  ]);
});

test('rows can be reordered, removed and saved with their enable flags', async () => {
  const env = await setupComponent({
    savedSettings: { primaryEnabled: true, provider: '', model: '', reasoningEffort: '' },
    catalogGroups: ROUTE_CATALOG,
  });
  env.render();
  let nodes = flattenNodes(await env.flush());
  assert.equal(routeRows(nodes).length, 0);
  assert.ok(nodes.some((node) => node.props?.children === env.t('reviewRoutesEmpty')));

  findByAction(nodes, 'route-add')?.props.onClick();
  nodes = flattenNodes(await env.flush());
  findByTestId(nodes, 'route-0-provider')?.props.onChange('provider-b');
  nodes = flattenNodes(await env.flush());
  findByTestId(nodes, 'route-0-model')?.props.onChange('model-b1');
  nodes = flattenNodes(await env.flush());

  findByAction(nodes, 'route-add')?.props.onClick();
  nodes = flattenNodes(await env.flush());
  findByTestId(nodes, 'route-1-provider')?.props.onChange('provider-a');
  nodes = flattenNodes(await env.flush());
  findByTestId(nodes, 'route-1-model')?.props.onChange('model-a1');
  nodes = flattenNodes(await env.flush());

  // Disable the second row, then move it up: enable flags travel with rows.
  findByAction(nodes, 'route-1-enable')?.props.onChange({ target: { checked: false } });
  nodes = flattenNodes(await env.flush());
  findByAction(nodes, 'route-1-up')?.props.onClick();
  nodes = flattenNodes(await env.flush());
  assert.equal(findByTestId(nodes, 'route-0-provider')?.props.value, 'provider-a');
  assert.equal(findByAction(nodes, 'route-0-enable')?.props.checked, false);
  assert.equal(findByTestId(nodes, 'route-1-provider')?.props.value, 'provider-b');
  assert.equal(findByAction(nodes, 'route-1-enable')?.props.checked, true);

  assert.equal(findByAction(nodes, 'route-0-up')?.props.disabled, true);
  assert.equal(findByAction(nodes, 'route-1-down')?.props.disabled, true);

  findButton(nodes, env.t('save'))?.props.onClick();
  await env.flush();
  assert.equal(env.writes.length, 1);
  assert.deepEqual(env.writes[0].nextSettings, {
    primaryEnabled: true,
    provider: '',
    model: '',
    reasoningEffort: '',
    routes: [
      { mode: 'route', enabled: false, weight: 0, provider: 'provider-a', model: 'model-a1', reasoningEffort: 'inherit' },
      { mode: 'route', enabled: true, weight: 0, provider: 'provider-b', model: 'model-b1', reasoningEffort: 'inherit' },
    ],
  });
});

test('removing the first of two rows leaves the second as the only route', async () => {
  const env = await setupComponent({
    savedSettings: {
      primaryEnabled: true,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'high',
      fallbacks: [
        { mode: 'route', enabled: true, provider: 'provider-b', model: 'model-b1', reasoningEffort: '' },
      ],
    },
    catalogGroups: ROUTE_CATALOG,
  });
  env.render();
  let nodes = flattenNodes(await env.flush());
  findByAction(nodes, 'route-0-remove')?.props.onClick();
  nodes = flattenNodes(await env.flush());
  assert.equal(findByTestId(nodes, 'route-0-provider')?.props.value, 'provider-b');
  findButton(nodes, env.t('save'))?.props.onClick();
  await env.flush();
  assert.deepEqual(env.writes[0].nextSettings, {
    primaryEnabled: true,
    provider: '',
    model: '',
    reasoningEffort: '',
    routes: [
      { mode: 'route', enabled: true, weight: 0, provider: 'provider-b', model: 'model-b1', reasoningEffort: '' },
    ],
  });
});

test('the route list is capped at ten rows', async () => {
  const env = await setupComponent({
    savedSettings: {
      primaryEnabled: true,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: '',
      fallbacks: Array.from({ length: 9 }, () => ({
        mode: 'route' as const,
        enabled: true,
        provider: 'provider-a',
        model: 'model-a1',
        reasoningEffort: '',
      })),
    },
    catalogGroups: ROUTE_CATALOG,
  });
  env.render();
  const nodes = flattenNodes(await env.flush());
  assert.equal(routeRows(nodes).length, 10);
  assert.equal(findByAction(nodes, 'route-add')?.props.disabled, true);
  assert.ok(nodes.some((node) => node.props?.children === env.t('routeCapHint')));
});

test('a legacy section whose live value carries an empty routes list still shows its rows', async () => {
  // `settings.describe()` projects the live config, where schemastery has already
  // turned an absent volatile array into `[]`. The table must not read that as
  // "all routes were deleted" and go blank.
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE, routes: [] },
    catalogGroups: ROUTE_CATALOG,
  });
  env.render();
  const nodes = flattenNodes(await env.flush());
  assert.equal(routeRows(nodes).length, 1, 'the migrated legacy row must still be listed');
  assert.equal(findByTestId(nodes, 'route-0-provider')?.props.value, 'provider-a');
  assert.equal(findByTestId(nodes, 'route-0-model')?.props.value, 'model-a1');
  assert.equal(findByTestId(nodes, 'route-0-effort')?.props.value, 'high');
  assert.equal(findByAction(nodes, 'route-0-weight')?.props.value, '0');

  // A weight edit is a normal dirty edit and is saved as a declared weight.
  findByAction(nodes, 'route-0-weight')?.props.onChange({ target: { value: '5' } });
  const edited = flattenNodes(await env.flush());
  assert.ok(findNodeByClass(edited, 'dsh_arm_unsaved'), 'a weight edit must mark the form dirty');
  findButton(edited, env.t('save'))?.props.onClick();
  await env.flush();
  assert.equal(env.writes[0].nextSettings.routes[0].weight, 5);
});

test('legacy { mode: session } rows are ignored and dropped on the next save', async () => {
  const env = await setupComponent({
    savedSettings: {
      primaryEnabled: true,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: '',
      fallbacks: [
        { mode: 'route', enabled: true, provider: 'provider-b', model: 'model-b1', reasoningEffort: '' },
        { mode: 'session', provider: 'stale-provider', model: 'stale-model', reasoningEffort: '' },
      ],
    },
    catalogGroups: ROUTE_CATALOG,
  });
  env.render();
  let nodes = flattenNodes(await env.flush());
  assert.equal(routeRows(nodes).length, 2);
  assert.equal(findByTestId(nodes, 'route-1-provider')?.props.value, 'provider-b');
  assert.equal(findByTestId(nodes, 'route-2-provider'), undefined);
  assert.equal(findNodeByClass(nodes, 'dsh_arm_unsaved'), undefined);

  toggleRow(nodes, 0, false);
  nodes = flattenNodes(await env.flush());
  findButton(nodes, env.t('save'))?.props.onClick();
  await env.flush();
  assert.equal(env.writes.length, 1);
  assert.deepEqual(env.writes[0].nextSettings.routes, [
    { mode: 'route', enabled: false, weight: 0, provider: 'provider-a', model: 'model-a1', reasoningEffort: '' },
    { mode: 'route', enabled: true, weight: 0, provider: 'provider-b', model: 'model-b1', reasoningEffort: '' },
  ]);
  assert.ok(!JSON.stringify(env.writes[0].nextSettings).includes('session'));
});

/* ============================================================
 * Per-row test action
 * ============================================================ */

test('each row has its own test button that probes that row\'s current values', async () => {
  const env = await setupComponent({
    savedSettings: {
      primaryEnabled: true,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'high',
      fallbacks: [
        { mode: 'route', enabled: false, provider: 'provider-b', model: 'model-b1', reasoningEffort: 'inherit' },
      ],
    },
    catalogGroups: ROUTE_CATALOG,
    testResponse: { ok: true, value: testResult() },
  });
  env.render();
  let nodes = flattenNodes(await env.flush());
  assert.equal(findByAction(nodes, 'route-0-test')?.props.children, env.t('test'));
  assert.equal(findByAction(nodes, 'route-1-test')?.props.children, env.t('test'));

  // A dirty, disabled row is still testable with its CURRENT draft values.
  findByTestId(nodes, 'route-1-model')?.props.onChange('model-b1');
  nodes = flattenNodes(await env.flush());
  findByAction(nodes, 'route-1-test')?.props.onClick();
  nodes = flattenNodes(await env.flush());

  assert.equal(env.endpoint.calls.length, 1);
  assert.deepEqual(env.endpoint.inputs[0], {
    mode: 'full',
    provider: 'provider-b',
    model: 'model-b1',
    reasoningEffort: 'inherit',
  });
  const status = findNodeByClass(nodes, 'dsh_arm_routeTestStatus');
  assert.ok(status, 'the tested row must render its inline result');
  assert.equal(status.props.children, env.t('testResultPrefix') + ': ' + env.t('testOkMessage'));
  assert.equal(
    routeRows(nodes)[0].props['data-route-index'],
    0,
    'the other row is unaffected by the probe',
  );

  // The result is a full-width row directly under its own route row, not a
  // cell that could stretch the provider/model/effort columns.
  const resultRow = nodes.find((node) => node.props?.['data-route-result'] === 1);
  assert.ok(resultRow, 'the tested row gets a dedicated result row');
  assert.equal(resultRow.type, 'tr');
  const resultCell = resultRow.props.children;
  assert.equal(resultCell.type, 'td');
  assert.equal(resultCell.props.colSpan, 6, 'the result spans every table column');
  assert.match(String(resultCell.props.className), /dsh_arm_routeResultCell/);
  const tbody = nodes.find((node) => node.type === 'tbody');
  const bodyRows = (Array.isArray(tbody?.props?.children) ? tbody.props.children : [])
    .flat(Infinity)
    .filter((node: unknown) => node !== null && typeof node === 'object' && (node as ReactElementLike).type === 'tr');
  const testedIndex = bodyRows.findIndex((row: ReactElementLike) => row.props['data-route-index'] === 1);
  const afterTested = bodyRows.slice(testedIndex + 1);
  const resultOffset = afterTested.findIndex((row: ReactElementLike) => row.props['data-route-result'] === 1);
  assert.ok(resultOffset >= 0, 'the tested row must own a result row');
  assert.ok(
    afterTested.slice(0, resultOffset).every((row: ReactElementLike) => row.props['data-route-health'] !== undefined),
    'only the measured-health row may sit between a route row and its result row',
  );
  assert.equal(
    nodes.some((node) => node.props?.['data-route-result'] === 0),
    false,
    'no result row is rendered for an untested row',
  );
});

test('per-row probe busy state is independent and results are replaced on edit', async () => {
  let resolvePending!: (value: { ok: boolean; value?: unknown }) => void;
  const pending = new Promise<{ ok: boolean; value?: unknown }>((resolve) => { resolvePending = resolve; });
  const env = await setupComponent({
    savedSettings: {
      ...SAVED_ROUTE,
      fallbacks: [
        { mode: 'route', enabled: true, provider: 'provider-b', model: 'model-b1', reasoningEffort: '' },
      ],
    },
    catalogGroups: ROUTE_CATALOG,
    testPending: pending,
  });
  env.render();
  let nodes = flattenNodes(await env.flush());
  findByAction(nodes, 'route-0-test')?.props.onClick();
  nodes = flattenNodes(await env.flush());

  assert.equal(findByAction(nodes, 'route-0-test')?.props.children, env.t('testing'));
  assert.equal(findByAction(nodes, 'route-0-test')?.props.disabled, true);
  assert.equal(findByAction(nodes, 'route-1-test')?.props.children, env.t('test'));
  assert.equal(findByAction(nodes, 'route-1-test')?.props.disabled, false, 'other rows stay idle and clickable');

  // Editing any row clears every stale result and aborts the in-flight probe.
  findByTestId(nodes, 'route-1-model')?.props.onChange('model-b1');
  nodes = flattenNodes(await env.flush());
  assert.equal(findByAction(nodes, 'route-0-test')?.props.children, env.t('test'));
  resolvePending({ ok: true, value: testResult() });
  nodes = flattenNodes(await env.flush());
  assert.equal(findNodeByClass(nodes, 'dsh_arm_routeTestStatus'), undefined, 'an abandoned probe result is dropped');
});

test('the nested route result is localized with an actionable inline hint', async () => {
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE },
    testResponse: {
      ok: true,
      value: testResult({
        status: 'error',
        code: 'ACCOUNT_SIGN_IN_REQUIRED',
        authKind: 'account',
        providerName: 'DeepSeek Account',
        credentialEnv: [],
      }),
    },
  });
  env.render();
  const nodes = flattenNodes(await env.flush());
  findByAction(nodes, 'route-0-test')?.props.onClick();
  const after = flattenNodes(await env.flush());
  const status = findNodeByClass(after, 'dsh_arm_routeTestStatus');
  assert.ok(status);
  assert.equal(
    status.props.children,
    env.t('testResultPrefix') + ': ' + env.t('testAccountSignInMessage'),
  );
  assert.ok(
    after.some((node) => typeof node.props?.children === 'string'
      && node.props.children.includes(env.t('testAccountSignInHint').split('{')[0])),
    'the inline result must carry the actionable hint',
  );
  assert.equal(
    after.some((node) => typeof node.props?.children === 'string' && node.props.children.includes('the model wrote')),
    false,
    'no model prose may be rendered',
  );
});

test('a transport failure is localized inline instead of showing raw prose', async () => {
  const env = await setupComponent({ savedSettings: { ...SAVED_ROUTE }, testRejects: true });
  env.render();
  const nodes = flattenNodes(await env.flush());
  findByAction(nodes, 'route-0-test')?.props.onClick();
  const after = flattenNodes(await env.flush());
  const status = findNodeByClass(after, 'dsh_arm_routeTestStatus');
  assert.ok(status);
  assert.equal(status.props.children, env.t('testResultPrefix') + ': ' + env.t('testTransportFailed'));
  assert.ok(after.some((node) => node.props?.children === env.t('testTransportHint')));
  assert.equal(
    after.some((node) => typeof node.props?.children === 'string' && node.props.children.includes('remote call failed')),
    false,
  );
});

test('the page reads measured health once and shows it under its route', async () => {
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE },
    catalogGroups: ROUTE_CATALOG,
  });
  env.render();
  const nodes = flattenNodes(await env.flush());
  assert.equal(env.endpoint.healthCalls, 1, 'health must be read exactly once per page');
  assert.equal(env.endpoint.calls.length, 0, 'reading health must not probe a provider');
  const healthCell = nodes.find((node) => node.props?.className?.includes('dsh_arm_routeHealthCell'));
  assert.ok(healthCell, 'each route row must render its measured health line');
  assert.match(String(healthCell?.props?.children ?? ''), /8 .*7 .*2100ms|8 attempts .*7 answered .*2100ms/, 'health must show measured counts');
  assert.match(String(healthCell?.props?.children ?? ''), /QUOTA/, 'the newest failure code must be shown');
});

test('the single test action runs the probe and both scripted cases in one call', async () => {
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE },
    catalogGroups: ROUTE_CATALOG,
    testResponse: {
      ok: true,
      value: testResult({
        status: 'warning',
        code: 'REVIEW_MISMATCH',
        cases: [
          { case: 'allow', expected: 'allow', actual: 'allow', risk: 'low', ok: true, failureCode: '', latencyMs: 1200, detail: '' },
          { case: 'deny', expected: 'deny', actual: 'allow', risk: 'low', ok: false, failureCode: '', latencyMs: 1300, detail: '' },
        ],
      }),
    },
  });
  env.render();
  let nodes = flattenNodes(await env.flush());
  assert.equal(findByAction(nodes, 'route-0-review'), undefined, 'there is no second button anymore');
  findByAction(nodes, 'route-0-test')?.props.onClick();
  nodes = flattenNodes(await env.flush());

  assert.equal(env.endpoint.calls.length, 1, 'one button is one Remote call');
  assert.equal(env.endpoint.inputs[0]?.mode, 'full', 'the single action asks for the full run');
  assert.equal(env.endpoint.inputs[0]?.provider, 'provider-a');
  const badges = nodes.filter((node) => node.props?.className?.includes('dsh_arm_reviewBadge'));
  assert.equal(badges.length, 2, 'both scripted cases must be shown');
  assert.ok(badges.some((node) => String(node.props?.className).includes('dsh_arm_reviewPass')));
  assert.ok(badges.some((node) => String(node.props?.className).includes('dsh_arm_reviewFail')));
  assert.ok(
    nodes.some((node) => node.props?.className?.includes('dsh_arm_routeTestStatus') && node.props?.className?.includes('dsh_arm_testWarn')),
    'a mismatch must render as a warning',
  );
  assert.equal(env.endpoint.healthCalls, 2, 'the measured line is refreshed after a test');
});

test('the test action is unavailable without a mounted endpoint', async () => {
  const env = await setupComponent({ savedSettings: { ...SAVED_ROUTE }, endpointUnavailable: true });
  env.render();
  const nodes = flattenNodes(await env.flush());
  assert.equal(findByAction(nodes, 'route-0-test')?.props.disabled, true);
  const note = nodes.filter((node) => node.props?.children === env.t('testUnavailableHint'));
  assert.equal(note.length, 1, 'exactly one unavailable note is rendered for the whole section');
});

test('unmounting the page aborts in-flight row probes', async () => {
  let resolvePending!: (value: { ok: boolean; value?: unknown }) => void;
  const pending = new Promise<{ ok: boolean; value?: unknown }>((resolve) => { resolvePending = resolve; });
  const env = await setupComponent({ savedSettings: { ...SAVED_ROUTE }, testPending: pending });
  env.render();
  let nodes = flattenNodes(await env.flush());
  findByAction(nodes, 'route-0-test')?.props.onClick();
  nodes = flattenNodes(await env.flush());
  const signal = env.endpoint.calls[0]?.signal;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);

  env.unmount();
  assert.equal(signal.aborted, true, 'unmount must abort the row probe');
  resolvePending({ ok: true, value: testResult() });
  await new Promise((resolve) => setImmediate(resolve));
});
