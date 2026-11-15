/**
 * Component-level tests for ReviewerModelConfig and ARMSelect in `@aghost-prj/dsh-auto-review-model`.
 *
 * Exercises the actual React component functions and event handlers using a minimal
 * deterministic React hook driver. Verifies:
 * 1. Saved unknown reasoning effort display and preservation when catalog fails or model lacks effort
 * 2. Explicit clearing of unknown reasoning effort to default
 * 3. Non-blocking UX notice when provider is set but model is empty (in both zh and en)
 * 4. Summary line correction for incomplete routes (inheriting session model instead of provider default)
 * 5. Ordinary save, discard, reload, and revision conflict handling
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

interface SetupTestEnvOptions {
  savedSettings?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  };
  revision?: number;
  catalogAvailable?: boolean;
  catalogGroups?: any[];
  lang?: 'zh' | 'en';
  /** Response returned by the mounted saved-route test endpoint. */
  testResponse?: { ok: boolean; value?: unknown; error?: unknown };
  /** Simulate the Remote endpoint failing to mount (optional action unavailable). */
  endpointUnavailable?: boolean;
  /** Simulate the Remote call itself rejecting. */
  testRejects?: boolean;
  /** Hold the Remote call open until this promise settles (independent testing state). */
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

/**
 * Reject with the caller's signal as soon as it aborts, like a real Remote call.
 * The pending promise still settles later, but its result is ignored.
 */
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
    enabled: true,
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
    calls: [] as Array<{ signal?: AbortSignal }>,
    /** Signals passed by the component, one per probe call. */
    signals: [] as Array<AbortSignal | undefined>,
    /** Reasons collected from abort events, proving the probe was cancelled. */
    aborts: [] as unknown[],
    async testReviewRoute(signal?: AbortSignal) {
      endpoint.calls.push({ signal });
      endpoint.signals.push(signal);
      if (signal !== undefined) {
        signal.addEventListener('abort', () => {
          endpoint.aborts.push(signal.reason);
        }, { once: true });
      }
      if (options.testPending !== undefined) return await raceAbort(options.testPending, signal);
      if (options.testRejects === true) throw new Error('remote call failed');
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
            groups: options.catalogGroups ?? [
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
                    },
                  },
                ],
              },
            ],
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
    /** Run the component's effect cleanups, as an actual unmount would. */
    unmount: () => resetDriver(),
  };
}

test('unknown saved effort is displayed and preserved when model catalog fails', async () => {
  const env = await setupComponent({
    savedSettings: {
      enabled: true,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'high',
    },
    catalogAvailable: false, // Catalog fails
  });

  // Initial render and effect flush
  env.render();
  const tree = await env.flush();

  const allNodes = flattenNodes(tree);
  const effortControl = allNodes.find((n) => n.props?.label === env.t('effort'));
  assert.ok(effortControl, 'reasoning effort control must exist');

  // Should display the saved effort 'high', NOT reset to empty ''
  assert.equal(
    effortControl.props.value,
    'high',
    'effort control value must be "high" when catalog is offline, not empty default',
  );

  // Options must include the unknown/unavailable effort
  const effortOptions = effortControl.props.options as Array<{ value: string; label: string }>;
  const highOption = effortOptions.find((o) => o.value === 'high');
  assert.ok(highOption, 'options must include an entry for the saved unknown effort');
  assert.match(
    highOption.label,
    /high.*未验证|high.*unverified/i,
    'saved unknown effort label must indicate it is unverified when catalog failed',
  );

  // The control MUST NOT be disabled so the user can explicitly clear it
  assert.equal(
    effortControl.props.disabled,
    false,
    'effort control must remain enabled so user can clear an unknown effort',
  );

  // If user modifies another field (e.g. toggles enabled), high must not be lost on save
  const checkbox = allNodes.find((n) => n.type === 'input' && n.props?.type === 'checkbox');
  assert.ok(checkbox, 'enabled checkbox must exist');
  checkbox.props.onChange({ target: { checked: false } });
  env.render();

  // Allow catalog to recover on save re-read, but return a catalog where model-a1 does NOT advertise 'high'
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
              reasoning: {
                efforts: [{ id: 'low', name: 'Low' }],
              },
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
  assert.equal(
    env.writes[0].nextSettings.reasoningEffort,
    'high',
    'saving after changing enabled must preserve unverified reasoningEffort="high"',
  );

  // Transition verification: once catalog recovered upon successful save re-read,
  // catalogError should be cleared snapshot-wise so unadvertised effort label switches from '未验证' to '未声明'
  const postSaveNodes = flattenNodes(postSaveTree);
  const postSaveEffort = postSaveNodes.find((n) => n.props?.label === env.t('effort'));
  assert.ok(postSaveEffort);
  const postSaveOptions = postSaveEffort.props.options as Array<{ value: string; label: string }>;
  const postSaveHighOption = postSaveOptions.find((o) => o.value === 'high');
  assert.ok(postSaveHighOption, 'options must still include the unadvertised effort high');
  assert.match(
    postSaveHighOption.label,
    /high.*未声明|high.*not advertised/i,
    'label must switch from unverified to not advertised once catalog recovers upon save re-read',
  );
});

test('unknown saved effort is displayed and preserved when model has no reasoning metadata or lacks effort', async () => {
  const env = await setupComponent({
    savedSettings: {
      enabled: true,
      provider: 'provider-a',
      model: 'model-no-reasoning',
      reasoningEffort: 'high',
    },
    catalogAvailable: true,
    catalogGroups: [
      {
        id: 'provider-a',
        name: 'Provider A',
        models: [
          {
            id: 'model-no-reasoning',
            name: 'Model Without Reasoning',
            // No reasoning metadata
          },
        ],
      },
    ],
  });

  env.render();
  const tree = await env.flush();

  const effortControl = flattenNodes(tree).find((n) => n.props?.label === env.t('effort'));
  assert.ok(effortControl);

  assert.equal(
    effortControl.props.value,
    'high',
    'effort control value must be "high" when model lacks reasoning metadata',
  );
  assert.equal(
    effortControl.props.disabled,
    false,
    'effort control must remain enabled so user can clear it',
  );

  const effortOptions = effortControl.props.options as Array<{ value: string; label: string }>;
  const highOption = effortOptions.find((o) => o.value === 'high');
  assert.ok(highOption, 'options must include the unadvertised effort');
  assert.match(highOption.label, /high.*未声明|high.*not advertised/i);
});

test('user can explicitly clear an unknown effort to default when catalog fails', async () => {
  const env = await setupComponent({
    savedSettings: {
      enabled: true,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'high',
    },
    catalogAvailable: false,
  });

  env.render();
  let tree = await env.flush();

  const effortControl = flattenNodes(tree).find((n) => n.props?.label === env.t('effort'));
  assert.ok(effortControl);

  // Clear effort by selecting ''
  effortControl.props.onChange('');
  tree = env.render();

  const updatedEffort = flattenNodes(tree).find((n) => n.props?.label === env.t('effort'));
  assert.ok(updatedEffort);
  assert.equal(updatedEffort.props.value, '');

  const saveButton = findButton(flattenNodes(tree), env.t('save'));
  assert.ok(saveButton);
  saveButton.props.onClick();
  await env.flush();

  assert.equal(env.writes.length, 1);
  assert.equal(
    env.writes[0].nextSettings.reasoningEffort,
    '',
    'explicitly clearing effort must persist empty effort',
  );
});

test('saved non-empty effort with empty model can be explicitly cleared in UI', async () => {
  const env = await setupComponent({
    savedSettings: {
      enabled: true,
      provider: 'provider-a',
      model: '',
      reasoningEffort: 'high',
    },
    catalogAvailable: true,
  });

  env.render();
  let tree = await env.flush();

  const allNodes = flattenNodes(tree);
  const effortControl = allNodes.find((n) => n.props?.label === env.t('effort'));
  assert.ok(effortControl, 'effort control must exist');

  // Value displays 'high' as-is
  assert.equal(effortControl.props.value, 'high');

  // Control must NOT be disabled, allowing user to clear legacy effort even when model is empty
  assert.equal(
    effortControl.props.disabled,
    false,
    'effort control must remain enabled when draft has non-empty reasoningEffort even if model is empty',
  );

  // User clears effort
  effortControl.props.onChange('');
  tree = env.render();

  const updatedEffort = flattenNodes(tree).find((n) => n.props?.label === env.t('effort'));
  assert.ok(updatedEffort);
  assert.equal(updatedEffort.props.value, '');

  // Once cleared, with model still empty, the effort control should now be disabled
  assert.equal(
    updatedEffort.props.disabled,
    true,
    'effort control should become disabled once effort is cleared and model is empty',
  );

  const saveButton = findButton(flattenNodes(tree), env.t('save'));
  assert.ok(saveButton);
  assert.equal(saveButton.props.disabled, false);

  saveButton.props.onClick();
  await env.flush();

  assert.equal(env.writes.length, 1);
  assert.equal(
    env.writes[0].nextSettings.reasoningEffort,
    '',
    'persisted settings must have empty reasoningEffort',
  );
  assert.equal(
    env.writes[0].nextSettings.model,
    '',
    'persisted settings must preserve empty model',
  );
});

test('re-selecting current provider or model dropdown item is a no-op and preserves dirty state', async () => {
  const env = await setupComponent({
    savedSettings: {
      enabled: true,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'high',
    },
    catalogAvailable: true,
  });

  env.render();
  let tree = await env.flush();

  let allNodes = flattenNodes(tree);
  const providerControl = allNodes.find((n) => n.props?.label === env.t('provider'));
  const modelControl = allNodes.find((n) => n.props?.label === env.t('model'));
  const effortControl = allNodes.find((n) => n.props?.label === env.t('effort'));

  assert.ok(providerControl && modelControl && effortControl);

  // Initially not dirty
  assert.equal(findNodeByClass(allNodes, 'dsh_arm_unsaved'), undefined);

  // Re-selecting current model 'model-a1'
  modelControl.props.onChange('model-a1');
  tree = env.render();
  allNodes = flattenNodes(tree);
  assert.equal(
    findNodeByClass(allNodes, 'dsh_arm_unsaved'),
    undefined,
    're-selecting current model must not produce dirty state',
  );
  assert.equal(
    allNodes.find((n) => n.props?.label === env.t('effort'))?.props.value,
    'high',
    'effort must not be cleared when re-selecting current model',
  );

  // Re-selecting current provider 'provider-a'
  providerControl.props.onChange('provider-a');
  tree = env.render();
  allNodes = flattenNodes(tree);
  assert.equal(
    findNodeByClass(allNodes, 'dsh_arm_unsaved'),
    undefined,
    're-selecting current provider must not produce dirty state',
  );
  assert.equal(
    allNodes.find((n) => n.props?.label === env.t('model'))?.props.value,
    'model-a1',
    'model must not be cleared when re-selecting current provider',
  );
  assert.equal(
    allNodes.find((n) => n.props?.label === env.t('effort'))?.props.value,
    'high',
    'effort must not be cleared when re-selecting current provider',
  );
});

test('non-blocking notice is displayed when provider is non-empty but model is empty', async () => {
  const env = await setupComponent({
    savedSettings: {
      enabled: true,
      provider: 'provider-a',
      model: '',
    },
    catalogAvailable: true,
    lang: 'zh',
  });

  env.render();
  let tree = await env.flush('page');

  const allNodes = flattenNodes(tree);
  const hintNode = allNodes.find((n) => n.props?.className?.includes('dsh_arm_hint'));
  assert.ok(hintNode, 'a visible hint element must appear when provider is set but model is empty');
  assert.match(
    String(hintNode.props?.children ?? ''),
    /模型未选择.*覆盖未生效.*会话模型/,
    'hint text must clearly explain that route override is inactive and session model is used',
  );

  // It is non-blocking: save is still permitted.
  // Test 4 strengthening: edit enabled to make form dirty, then assert save button becomes enabled,
  // clicks save, and remote.settings.replace receives model as empty string.
  const checkbox = allNodes.find((n) => n.type === 'input' && n.props?.type === 'checkbox');
  assert.ok(checkbox, 'checkbox must exist');
  checkbox.props.onChange({ target: { checked: false } });
  tree = env.render();

  const saveButton = findButton(flattenNodes(tree), env.t('save'));
  assert.ok(saveButton);
  assert.equal(saveButton.props.disabled, false, 'save button must be enabled when dirty even if route is incomplete');

  saveButton.props.onClick();
  await env.flush();

  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].nextSettings.model, '', 'saving incomplete route must preserve model as empty string');
  assert.equal(env.writes[0].nextSettings.enabled, false);
  assert.equal(env.writes[0].nextSettings.provider, 'provider-a');
});

test('non-blocking notice localized in English', async () => {
  const env = await setupComponent({
    savedSettings: {
      enabled: true,
      provider: 'provider-a',
      model: '',
    },
    catalogAvailable: true,
    lang: 'en',
  });

  env.render();
  const tree = await env.flush('page');

  const allNodes = flattenNodes(tree);
  const hintNode = allNodes.find((n) => n.props?.className?.includes('dsh_arm_hint'));
  assert.ok(hintNode, 'hint element must appear in English');
  assert.match(
    String(hintNode.props?.children ?? ''),
    /model not selected.*inactive.*session model/i,
    'English hint text must match Chinese meaning',
  );
});

test('summaryLine correctly reports session model inherit when provider is set but model is empty', async () => {
  const env = await setupComponent({
    savedSettings: {
      enabled: true,
      provider: 'provider-a',
      model: '',
    },
    catalogAvailable: true,
  });

  env.render();
  const tree = await env.flush('summary');

  const summaryNode = flattenNodes(tree).find((n) => n.props?.className?.includes('dsh_arm_summary'));
  assert.ok(summaryNode, 'summary element must exist');
  const summaryText = String(summaryNode.props?.children ?? '');

  // Must NOT display "provider-a / 默认模型"
  assert.doesNotMatch(
    summaryText,
    /provider-a\s*\/\s*默认模型/,
    'summary must not claim provider default model is used when model is empty',
  );
  assert.match(
    summaryText,
    /继承当前会话模型/,
    'summary must indicate current session model is inherited',
  );
});

test('handles save, reload, discard and revision conflicts correctly', async () => {
  let conflictOnSave = true;
  const env = await setupComponent({
    savedSettings: {
      enabled: true,
      provider: 'provider-a',
      model: 'model-a1',
      reasoningEffort: 'low',
    },
    catalogAvailable: true,
  });

  // Override replace to simulate conflict on first try
  const originalReplace = env.remote.settings.replace;
  env.remote.settings.replace = async (ns: string, settings: any, expectedRevision?: number) => {
    if (conflictOnSave) {
      conflictOnSave = false;
      return {
        ok: false,
        error: { code: 'settings/conflict', message: 'revision mismatch' },
      };
    }
    return originalReplace(ns, settings, expectedRevision);
  };

  env.render();
  let tree = await env.flush();

  // Modify model
  const modelControl = flattenNodes(tree).find((n) => n.props?.label === env.t('model'));
  assert.ok(modelControl);
  modelControl.props.onChange('model-a1');

  // Modify enabled
  const checkbox = flattenNodes(tree).find((n) => n.type === 'input' && n.props?.type === 'checkbox');
  assert.ok(checkbox);
  checkbox.props.onChange({ target: { checked: false } });
  tree = env.render();

  // Try saving -> should encounter conflict
  const saveButton = findButton(flattenNodes(tree), env.t('save'));
  assert.ok(saveButton);
  saveButton.props.onClick();
  tree = await env.flush();

  let statusNode = flattenNodes(tree).find((n) => n.props?.className?.includes('dsh_arm_statusError'));
  assert.ok(statusNode, 'status error element should appear on conflict');
  assert.match(String(statusNode.props?.children ?? ''), /设置已被其他窗口修改/);

  // Click reload
  const reloadButton = findButton(flattenNodes(tree), env.t('reload'));
  assert.ok(reloadButton);
  reloadButton.props.onClick();
  tree = await env.flush();

  // Status error cleared after reload
  statusNode = flattenNodes(tree).find((n) => n.props?.className?.includes('dsh_arm_statusError'));
  assert.equal(statusNode, undefined);

  // Modify again and save
  const checkboxAgain = flattenNodes(tree).find((n) => n.type === 'input' && n.props?.type === 'checkbox');
  assert.ok(checkboxAgain);
  checkboxAgain.props.onChange({ target: { checked: false } });
  tree = env.render();

  const saveButtonAgain = findButton(flattenNodes(tree), env.t('save'));
  assert.ok(saveButtonAgain);
  saveButtonAgain.props.onClick();
  tree = await env.flush();

  const statusOk = flattenNodes(tree).find((n) => n.props?.className?.includes('dsh_arm_statusOk'));
  assert.ok(statusOk, 'status ok element should appear on successful save');
  assert.equal(statusOk.props?.children, env.t('saved'));

  // Now test discard: modify enabled
  checkboxAgain.props.onChange({ target: { checked: true } });
  tree = env.render();
  assert.ok(findNodeByClass(flattenNodes(tree), 'dsh_arm_unsaved'));

  const discardButton = findButton(flattenNodes(tree), env.t('discard'));
  assert.ok(discardButton);
  discardButton.props.onClick();
  tree = env.render();

  assert.equal(findNodeByClass(flattenNodes(tree), 'dsh_arm_unsaved'), undefined);
});

test('handles save re-read failure with fallback to response snapshot and revision', async () => {
  for (const variant of ['viewRevision', 'responseRevision'] as const) {
    let reReadFails = false;
    const env = await setupComponent({
      savedSettings: {
        enabled: true,
        provider: 'provider-a',
        model: 'model-a1',
        reasoningEffort: 'low',
      },
      catalogAvailable: true,
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

    // Replace implementation returning namespace view or direct revision
    env.remote.settings.replace = async (ns: string, nextSettings: any, expectedRevision?: number) => {
      env.writes.push({ ns, nextSettings, expectedRevision });
      if (variant === 'viewRevision') {
        return {
          ok: true,
          revision: 999, // Intentional different top-level revision to verify view.revision takes priority
          value: {
            ns,
            value: nextSettings,
            revision: 15,
          },
        };
      }
      // variant === 'responseRevision' (response.revision top-level, value has no revision)
      return {
        ok: true,
        revision: 15,
        value: {
          ns,
          value: nextSettings,
        },
      };
    };

    env.render();
    let tree = await env.flush();

    // Modify enabled to make dirty
    const checkbox = flattenNodes(tree).find((n) => n.type === 'input' && n.props?.type === 'checkbox');
    assert.ok(checkbox);
    checkbox.props.onChange({ target: { checked: false } });
    tree = env.render();

    // Trigger save and ensure re-read fails
    reReadFails = true;
    const saveButton = findButton(flattenNodes(tree), env.t('save'));
    assert.ok(saveButton);
    saveButton.props.onClick();
    tree = await env.flush();

    // Must report reloadFailed
    const statusError = flattenNodes(tree).find((n) => n.props?.className?.includes('dsh_arm_statusError'));
    assert.ok(statusError, `[${variant}] status error element should appear on re-read failure`);
    assert.match(
      String(statusError.props?.children ?? ''),
      /已保存.*重新读取.*失败|saved.*reloading.*failed/i,
      `[${variant}] error message must indicate reload failed after save`,
    );

    // Form must NOT revert to unsaved dirty state
    assert.equal(
      findNodeByClass(flattenNodes(tree), 'dsh_arm_unsaved'),
      undefined,
      `[${variant}] form should not show unsaved changes after successful save with re-read failure`,
    );

    // A subsequent save should carry the new revision 15 from response snapshot
    reReadFails = false; // allow re-read on second save
    checkbox.props.onChange({ target: { checked: true } });
    tree = env.render();

    const saveButton2 = findButton(flattenNodes(tree), env.t('save'));
    assert.ok(saveButton2);
    saveButton2.props.onClick();
    await env.flush();

    assert.equal(env.writes.length, 2);
    assert.equal(
      env.writes[1].expectedRevision,
      15,
      `[${variant}] next save must carry revision recovered from response fallback (15)`,
    );
  }
});

/* ============================================================
 * Saved review-route test action
 * ============================================================ */

/** Deferred promise helper for independent-state tests. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A saved route the default fake catalog can represent. */
const SAVED_ROUTE = {
  enabled: true,
  provider: 'provider-a',
  model: 'model-a1',
  reasoningEffort: 'high',
} as const;

/** Find one rendered string child that contains `fragment`. */
function findTextNode(
  nodes: Array<{ type: unknown; props: Record<string, any> }>,
  fragment: string,
): { type: unknown; props: Record<string, any> } | undefined {
  return nodes.find((node) => {
    const children = node.props?.children;
    return typeof children === 'string' && children.includes(fragment);
  });
}

test('saved-route test action is discoverable and always names the saved route', async () => {
  const env = await setupComponent({ savedSettings: { ...SAVED_ROUTE } });
  env.render();
  let nodes = flattenNodes(await env.flush());

  const section = findNodeByClass(nodes, 'dsh_arm_test');
  assert.ok(section, 'the saved-route test section must be rendered on the settings page');

  const testButton = findButton(nodes, env.t('test'));
  assert.ok(testButton, 'the test button must be discoverable by its localized label');
  assert.equal(testButton.type, 'button');
  assert.equal(testButton.props.disabled, false, 'the test action must be available for a complete saved route');
  assert.ok(
    findTextNode(nodes, `${SAVED_ROUTE.provider} / ${SAVED_ROUTE.model} · ${SAVED_ROUTE.reasoningEffort}`),
    'the hint must name the saved route',
  );
  assert.ok(
    findTextNode(nodes, env.t('testHint').split('{')[0] ?? env.t('testHint')),
    'the hint must explain that only the saved route is tested',
  );

  // Make the draft dirty: the hint must say the draft is not tested while the
  // saved-route description stays the same.
  const effortControl = nodes.find((node) => node.props?.label === env.t('effort'));
  assert.ok(effortControl, 'effort control must exist');
  effortControl.props.onChange('low');
  env.render();
  nodes = flattenNodes(await env.flush());

  assert.ok(findTextNode(nodes, env.t('testHintDirty')), 'a dirty draft must be called out as not tested');
  assert.ok(
    findTextNode(nodes, `${SAVED_ROUTE.provider} / ${SAVED_ROUTE.model} · ${SAVED_ROUTE.reasoningEffort}`),
    'the saved-route description must not follow the dirty draft',
  );
  assert.equal(
    findButton(nodes, env.t('test'))?.props.disabled,
    false,
    'a dirty draft must still allow testing the saved route',
  );
});

test('the saved-route test renders classified outcomes instead of model output', async () => {
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
  let nodes = flattenNodes(await env.flush());
  const testButton = findButton(nodes, env.t('test'));
  assert.ok(testButton);
  testButton.props.onClick();
  nodes = flattenNodes(await env.flush());

  assert.equal(env.endpoint.calls.length, 1, 'one click must issue one probe');
  assert.ok(
    env.endpoint.calls[0].signal instanceof AbortSignal,
    'the component must pass its own cancellation signal to the Remote call',
  );
  assert.equal(env.endpoint.signals[0]?.aborted, false, 'the signal stays live while the probe runs');

  const resultNode = findNodeByClass(nodes, 'dsh_arm_testError');
  assert.ok(resultNode, 'a failed probe must render in the error tone');
  assert.equal(
    resultNode.props.children,
    env.t('testResultPrefix') + ': ' + env.t('testAccountSignInMessage'),
  );
  assert.ok(
    findTextNode(nodes, env.t('testAccountSignInHint').split('{')[0]),
    'the account sign-in failure must render an actionable hint',
  );
  assert.equal(
    nodes.some((node) => typeof node.props?.children === 'string' && node.props.children.includes('the model wrote')),
    false,
    'no model prose may be rendered',
  );
});

test('credential failures render the provider and environment hint', async () => {
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE },
    testResponse: {
      ok: true,
      value: testResult({
        status: 'error',
        code: 'MISSING_CREDENTIAL',
        authKind: 'api-key',
        providerName: 'Provider A',
        credentialEnv: ['PROVIDER_A_API_KEY'],
        failureCode: 'HTTP_401',
        detail: 'Host advisory sentence that must not be duplicated',
      }),
    },
  });
  env.render();
  const nodes = flattenNodes(await env.flush());
  const testButton = findButton(nodes, env.t('test'));
  testButton?.props.onClick();
  const after = flattenNodes(await env.flush());
  assert.ok(findTextNode(after, 'Provider A'), 'the hint must name the provider');
  assert.ok(findTextNode(after, 'PROVIDER_A_API_KEY'), 'the hint must name the credential environment variable');
  assert.ok(
    findTextNode(after, env.t('testFailureCode') + ': HTTP_401'),
    'the machine-shaped failure code must be shown as data',
  );
  assert.equal(
    findTextNode(after, 'Host advisory sentence that must not be duplicated'),
    undefined,
    'classified outcomes must not duplicate untranslated host advice',
  );
});

test('a transport failure is localized instead of showing raw prose', async () => {
  const env = await setupComponent({ savedSettings: { ...SAVED_ROUTE }, testRejects: true });
  env.render();
  const nodes = flattenNodes(await env.flush());
  findButton(nodes, env.t('test'))?.props.onClick();
  const after = flattenNodes(await env.flush());
  const failed = findNodeByClass(after, 'dsh_arm_testError');
  assert.ok(failed);
  assert.equal(failed.props.children, env.t('testResultPrefix') + ': ' + env.t('testTransportFailed'));
  assert.ok(findTextNode(after, env.t('testTransportHint')), 'a transport failure must offer retry guidance');
  assert.equal(
    nodes.some((node) => typeof node.props?.children === 'string' && node.props.children.includes('remote call failed')),
    false,
    'arbitrary error messages must not be rendered',
  );
});

test('the testing state is independent from save state and blocks duplicate probes', async () => {
  const deferred = createDeferred<{ ok: boolean; value?: unknown }>();
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE },
    testPending: deferred.promise,
  });
  env.render();
  let nodes = flattenNodes(await env.flush());

  // Dirty the draft so Save is enabled, then start a probe.
  const effortControl = nodes.find((node) => node.props?.label === env.t('effort'));
  assert.ok(effortControl);
  effortControl.props.onChange('low');
  env.render();
  nodes = flattenNodes(await env.flush());
  findButton(nodes, env.t('test'))?.props.onClick();
  nodes = flattenNodes(await env.flush());

  const busyButton = findButton(nodes, env.t('testing'));
  assert.ok(busyButton, 'the probe button must show its own testing label');
  assert.equal(busyButton?.props.disabled, true, 'the probe button must be disabled while testing');
  const saveButton = findButton(nodes, env.t('save'));
  assert.ok(saveButton, 'the save button must remain rendered');
  assert.equal(
    saveButton?.props.disabled,
    false,
    'the independent test state must not disable (or reuse) the save busy state',
  );
  const section = findNodeByClass(nodes, 'dsh_arm_section');
  assert.ok(section);
  assert.equal(
    section.props['aria-busy'],
    false,
    'a saved-route probe must not mark the whole settings section busy',
  );
  const testRow = findNodeByClass(nodes, 'dsh_arm_test');
  assert.ok(testRow);
  assert.equal(testRow.props['aria-busy'], true, 'the probe row itself is busy while testing');
  busyButton?.props.onClick();
  busyButton?.props.onClick();
  assert.equal(env.endpoint.calls.length, 1, 'repeated taps while testing must not issue more probes');

  deferred.resolve({ ok: true, value: testResult() });
  nodes = flattenNodes(await env.flush());
  assert.ok(findButton(nodes, env.t('test')), 'the button must return to its idle label after the probe');
  const okNode = findNodeByClass(nodes, 'dsh_arm_testOk');
  assert.ok(okNode, 'a healthy probe must render in the success tone');
});

test('the test action is visibly unavailable when its endpoint did not mount', async () => {
  const env = await setupComponent({ savedSettings: { ...SAVED_ROUTE }, endpointUnavailable: true });
  env.render();
  const nodes = flattenNodes(await env.flush());
  const testButton = findButton(nodes, env.t('test'));
  assert.ok(testButton);
  assert.equal(testButton?.props.disabled, true, 'the test action must be disabled without a mounted endpoint');
  assert.ok(findTextNode(nodes, env.t('testUnavailableHint')), 'the page must explain why the test is unavailable');
});

test('a pending probe result is dropped when the saved route changes', async () => {
  const deferred = createDeferred<{ ok: boolean; value?: unknown }>();
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE },
    testPending: deferred.promise,
  });
  env.render();
  let nodes = flattenNodes(await env.flush());
  findButton(nodes, env.t('test'))?.props.onClick();
  nodes = flattenNodes(await env.flush());
  assert.ok(findButton(nodes, env.t('testing')), 'the probe must still be in flight');

  // Save a different reasoning effort for the SAME save cycle while the probe
  // is pending; the saved route displayed by the form changes.
  const effortControl = nodes.find((node) => node.props?.label === env.t('effort'));
  assert.ok(effortControl);
  effortControl.props.onChange('low');
  env.render();
  nodes = flattenNodes(await env.flush());
  const saveButton = findButton(nodes, env.t('save'));
  assert.ok(saveButton);
  saveButton.props.onClick();
  nodes = flattenNodes(await env.flush());
  assert.ok(findNodeByClass(nodes, 'dsh_arm_testOk') === undefined);
  // Saving a different saved route aborts the probe for the previous route.
  assert.equal(env.endpoint.signals[0]?.aborted, true, 'a saved-route change must abort the pending probe');
  assert.equal(env.endpoint.aborts.length, 1, 'the abort must reach the Remote call exactly once');
  assert.ok(findButton(nodes, env.t('test')), 'the probe button must be idle again after the aborted probe');

  // Route A's late answer must not be presented beside saved route B.
  deferred.resolve({ ok: true, value: testResult() });
  nodes = flattenNodes(await env.flush());
  assert.equal(env.endpoint.calls.length, 1);
  assert.equal(
    findNodeByClass(nodes, 'dsh_arm_testOk'),
    undefined,
    'a stale success must not be rendered after the saved route moved',
  );
  assert.equal(
    nodes.some((node) => typeof node.props?.children === 'string' && node.props.children.includes(env.t('testOkMessage'))),
    false,
    'no stale outcome text may remain visible',
  );
  assert.ok(findButton(nodes, env.t('test')), 'the probe button must return to idle after the late answer');
});

test('unmounting the page aborts an in-flight probe and discards its late result', async () => {
  const deferred = createDeferred<{ ok: boolean; value?: unknown }>();
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE },
    testPending: deferred.promise,
  });
  env.render();
  let nodes = flattenNodes(await env.flush());
  findButton(nodes, env.t('test'))?.props.onClick();
  nodes = flattenNodes(await env.flush());
  assert.ok(findButton(nodes, env.t('testing')), 'the probe must be in flight before unmount');
  const signal = env.endpoint.signals[0];
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);

  env.unmount();
  assert.equal(signal.aborted, true, 'unmount must abort the in-flight probe');
  assert.equal(env.endpoint.aborts.length, 1, 'the abort must reach the Remote call');

  // A late answer after unmount must be ignored and must not throw.
  deferred.resolve({ ok: true, value: testResult() });
  await new Promise((resolve) => setImmediate(resolve));
});

test('starting a probe keeps exactly one cancellation signal live', async () => {
  const deferred = createDeferred<{ ok: boolean; value?: unknown }>();
  const env = await setupComponent({
    savedSettings: { ...SAVED_ROUTE },
    testPending: deferred.promise,
  });
  env.render();
  const nodes = flattenNodes(await env.flush());
  findButton(nodes, env.t('test'))?.props.onClick();
  await env.flush();
  assert.equal(env.endpoint.signals.length, 1);
  assert.equal(env.endpoint.signals[0]?.aborted, false);
  deferred.resolve({ ok: true, value: testResult() });
  await env.flush();
  assert.equal(env.endpoint.signals[0]?.aborted, false, 'a completed probe is not aborted');
});
