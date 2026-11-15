declare module 'undici-types' {
  export class WebSocket {}
  export class CloseEvent {}
  export class MessageEvent {}
  export interface CloseEventInit {}
  export class ErrorEvent {}
  export interface ErrorEventInit {}
  export class EventSource {}
  export interface EventSourceInit {}
  export class FormData {}
  export class Headers {}
  export interface MessageEventInit {}
  export class Request {}
  export interface RequestInit {}
  export class Response {}
  export interface ResponseInit {}
  export interface WebSocketInit {}
}

/**
 * Minimal, dependency-free types for the browser bundle.
 *
 * The real shell supplies React and the module-loader facade; this file only
 * declares the small surface it uses so the bundle can be type-checked without
 * installing React or the client packages. `document` comes from the DOM lib.
 */

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
  useCallback<T extends (...args: any[]) => any>(callback: T, dependencies?: readonly unknown[]): T;
  useRef<T>(initial: T): { current: T };
}

interface ModuleLoaderEntry {
  id: string;
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>;
}

interface Window {
  __ModuleLoader__: { load(entry: ModuleLoaderEntry): void };
}

interface BundleModule {
  exports: Record<string, unknown>;
}

interface ReviewerSettings {
  enabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
}

interface SelectOption {
  value: string;
  label: string;
}

interface StatusLine {
  kind: 'ok' | 'error';
  text: string;
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

interface RemoteResponse<T> {
  ok?: boolean;
  value?: T;
  error?: unknown;
  revision?: number;
}

/**
 * Wire result of one saved review-route probe.
 *
 * Mirrors the strict `ReviewRouteTestResult` codec in `src/typert.contract.ts`.
 * It carries classification metadata only: the Host never returns model output,
 * so no result field can hold provider prose.
 */
interface ReviewRouteTestResult {
  status: 'ok' | 'warning' | 'error' | 'blocked';
  code: string;
  route: { provider: string; model: string; reasoningEffort: string };
  authKind: 'account' | 'api-key' | 'unknown';
  providerName: string;
  settingsNs: string;
  credentialEnv: string[];
  effortUsed: string;
  effortNotAdvertised: boolean;
  latencyMs: number;
  retryAfterMs: number;
  failureCode: string;
  detail: string;
}

/** One call of the mounted `remote.autoReviewModel.testReviewRoute` endpoint. */
interface TestRouteEndpoint {
  testReviewRoute(signal?: AbortSignal): Promise<RemoteResponse<ReviewRouteTestResult>>;
}

/** Mountable Host-for-Client contribution this package's `./remote` export carries. */
interface RemoteContributionLike {
  package: string;
  descriptors: readonly unknown[];
}

/** Localized presentation of one saved-route test outcome. */
interface TestOutcome {
  tone: 'ok' | 'warning' | 'error' | 'blocked';
  /** Localized outcome message. */
  message: string;
  /** Localized description of the route the Host actually probed. */
  route: string;
  /** Localized actionable repair hint. */
  hint: string;
  /** Data-only diagnostic: the tested route and/or a safe failure code. */
  detail: string;
  /** Extra note, such as the saved-effort fallback explanation. */
  note: string;
}

interface SettingsNamespace {
  ns?: string;
  value?: unknown;
  revision?: number;
}

interface RemoteFacade {
  settings: {
    describe(): Promise<RemoteResponse<{ namespaces?: SettingsNamespace[] }>>;
    replace(
      ns: string,
      section: ReviewerSettings,
      revision?: number,
    ): Promise<RemoteResponse<unknown>>;
  };
  session: {
    modelCatalog(): Promise<RemoteResponse<{ groups?: unknown }>>;
  };
  /**
   * Mount this package's `./remote` contribution. The server registers the
   * `remote.autoReviewModel` namespace service, which the settings body reads
   * through `ctx.get`.
   */
  $mount(contribution: RemoteContributionLike): Promise<() => Promise<void>>;
}

interface ClientContext {
  get(service: string): any;
  effect(effect: () => (() => void) | void, label?: string): void;
  inject?(
    services: readonly string[],
    callback: (child: ClientContext) => (() => void) | void,
  ): { dispose(): void | Promise<void> };
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  options: SelectOption[];
  disabled?: boolean;
}

interface ConfigProps {
  view: 'summary' | 'page';
  remote: RemoteFacade;
  t: (key: string) => string;
  /** Mounted saved-route probe endpoint; absent when its contribution failed to mount. */
  testRoute?: TestRouteEndpoint;
}

type LoadResult =
  | {
      ok: true;
      value: ReviewerSettings;
      revision: number | undefined;
      groups: ProviderGroup[];
      catalogError: string;
    }
  | { ok: false; error: unknown };

window.__ModuleLoader__.load({ id: '@aghost-prj/dsh-auto-review-model', factory: (require: (specifier: string) => unknown): Record<string, unknown> => {
  const module: BundleModule = { exports: {} };
  const exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

  const React = require('react') as ReactLike;

  /* ============================================================
   * auto-review model — client half
   *
   * Contributes the configuration body of
   * `@deepseek-ai/dsh-experimental-auto-review` to the Plugins page.
   * The form reads and writes the `auto-review-model` settings
   * namespace through the official Remote API:
   *   remote.settings.describe()  -> namespaces, each with value/revision
   *   remote.settings.replace()   -> replace the user section with a revision
   *   remote.session.modelCatalog() -> provider groups, models, efforts
   *
   * Only `react` is required; every node is built with
   * React.createElement, and every style is injected once as plain CSS.
   * ============================================================ */

  const NS = 'auto-review-model';
  const BUNDLE = '@deepseek-ai/dsh-experimental-auto-review';
  /**
   * Module id the generated client prelude registers this package's `./remote`
   * contribution under. The prelude and this require are emitted from the same
   * contract source by `scripts/build-client.cjs`.
   */
  const REMOTE_CONTRIBUTION_SPECIFIER = '@aghost-prj/dsh-auto-review-model/client.remote.js';
  const STYLE_ID = 'dsh_arm_styles';
  const FIELDS: readonly (keyof ReviewerSettings)[] = [
    'enabled',
    'provider',
    'model',
    'reasoningEffort',
  ];

  /** Values shown before the first successful read; never mutated. */
  const DEFAULT_SETTINGS: ReviewerSettings = Object.freeze({
    enabled: true,
    provider: '',
    model: '',
    reasoningEffort: '',
  });

  const zh = {
    title: '自动审查模型',
    subtitle: '为自动审查指定提供商、模型与推理等级。提供商留空时继承当前会话模型。',
    enabled: '启用自动审查模型配置',
    enabledDesc: '关闭后自动审查沿用当前会话的模型与推理等级。',
    provider: '提供商',
    providerEmpty: '继承当前会话模型',
    model: '模型',
    modelPlaceholder: '选择模型',
    inheritModel: '继承当前会话模型',
    effort: '推理等级',
    effortDefault: '默认（不指定）',
    save: '保存',
    discard: '放弃更改',
    reload: '重新读取',
    saving: '保存中…',
    saved: '已保存',
    savedCatalogFailed: '已保存，但模型目录加载失败',
    unsaved: '有未保存的更改',
    loading: '正在读取设置…',
    loadFailed: '设置加载失败',
    saveFailed: '保存失败',
    reloadFailed: '已保存，但重新读取设置失败',
    catalogFailed: '模型目录加载失败，但可继续编辑已保存设置',
    conflict: '设置已被其他窗口修改，请点击“重新读取”或刷新页面后重新编辑',
    incompleteRouteHint: '模型未选择，覆盖未生效，继续使用会话模型',
    summaryLabel: '自动审查模型',
    summaryLoading: '正在读取…',
    summaryOff: '已关闭',
    summaryInherit: '继承当前会话模型',
    summaryError: '读取失败',
    unavailable: '（不可用）',
    unverified: '（未验证）',
    notAdvertised: '（未声明）',
    // Saved-route test action. Every string here is what the settings page
    // renders; provider output is never displayed as prose, only classified
    // outcomes plus a short technical detail.
    test: '测试审查路由',
    testing: '正在测试审查路由…',
    testLabel: '审查路由测试',
    testHint: '仅测试已保存的路由：{route}。未保存的更改不会被测试。',
    testHintDirty: '你有未保存的更改；测试不会使用它们。',
    testRouteDisabled: '覆盖已关闭',
    testRouteIncomplete: '提供商或模型尚未保存',
    testUnavailableHint: '审查路由测试不可用：Remote 端点未能挂载。请刷新页面或重启 DSH 后重试。',
    testResultPrefix: '测试结果',
    testTransportFailed: '测试未能运行',
    testUnknownResult: '审查路由测试返回了无法识别的结果。',
    testDetail: '详情',
    testEffortNote: '已保存的推理等级“{effort}”未被该路由声明；自动审查会回退到提供商默认值。',
    testSeconds: '{seconds} 秒',
    testNoEnvVar: '提供商凭证设置',
    testResultRoute: '测试路由',
    testFailureCode: '失败代码',
    testTransportHint: '请重试测试；若持续失败，请刷新页面或重启 DSH。',
    testLoadingHint: '设置尚未加载完成；请刷新页面后再测试。',
    testOkMessage: '路由可用。',
    testRouteDisabledMessage: '已保存的设置中，自动审查覆盖处于关闭状态。',
    testRouteIncompleteMessage: '已保存的审查路由不完整。',
    testBusyMessage: '已有一个路由测试在运行。',
    testRateLimitedMessage: '路由测试启动过于频繁。',
    testCancelledMessage: '路由测试已取消。',
    testTimeoutMessage: '已保存的路由未能及时响应。',
    testNoAdapterMessage: '已保存的提供商没有注册的适配器。',
    testUnknownModelMessage: '该路由不提供已保存的模型。',
    testMissingCredentialMessage: '该提供商未配置凭证。',
    testInvalidCredentialMessage: '该提供商保存的凭证格式无效。',
    testNoCredentialStoreMessage: '凭证存储不可用。',
    testAuthMessage: '提供商拒绝了该凭证。',
    testAccountSignInMessage: 'DeepSeek 账号路由需要登录。',
    testAccountAuthFailedMessage: 'DeepSeek 账号的授权被拒绝。',
    testAccountConnectionMessage: '无法连接 DeepSeek 账号服务。',
    testConnectionMessage: '无法连接该提供商。',
    testRateLimitMessage: '提供商对测试请求做了速率限制。',
    testQuotaMessage: '提供商账号的配额或余额已用尽。',
    testContextWindowMessage: '测试请求超出了模型上下文窗口。',
    testUnsupportedEffortMessage: '该模型不支持已保存的推理等级。',
    testEmptyResponseMessage: '路由有响应，但返回了空内容。',
    testUnknownMessage: '路由测试因未知原因失败。',
    testOkHint: '',
    testRouteDisabledHint: '开启覆盖并保存提供商与模型，然后重新测试。',
    testRouteIncompleteHint: '先在设置中保存提供商和模型，然后重新测试。',
    testBusyHint: '等待当前测试完成后再试。',
    testRateLimitedHint: '请等待 {seconds} 后再测试。',
    testCancelledHint: '重新运行测试。',
    testTimeoutHint: '检查网络与提供商状态后重试；若持续出现，请更换提供商或模型。',
    testNoAdapterHint: '在“设置 → 提供商”中配置 {provider}，或改选一个已有适配器的提供商；必要时重启 DSH 后重试。',
    testUnknownModelHint: '为 {provider} 选择另一个模型并保存，然后重新测试。',
    testMissingCredentialHint: '在“设置 → 提供商”中为 {provider} 添加凭证（环境变量：{env}），然后重新测试。',
    testInvalidCredentialHint: '在“设置 → 提供商”中修正 {provider} 的凭证，然后重新测试。',
    testNoCredentialStoreHint: '重启 DSH 或先配置凭证存储，然后重新测试。',
    testAuthHint: '在“设置 → 提供商”中检查 {provider} 的 API key，然后重新测试。',
    testAccountSignInHint: '打开“设置 → DeepSeek 账号”重新登录，然后重新测试。',
    testAccountAuthFailedHint: '打开“设置 → DeepSeek 账号”重新登录；若仍失败，请确认该账号可使用 {provider}。',
    testAccountConnectionHint: '检查网络后重试；若账号服务不可用，请改选其他提供商路由。',
    testConnectionHint: '检查网络与提供商的端点/Base URL，然后重试。',
    testRateLimitHint: '等待提供商速率限制重置后重试，或降低测试频率。',
    testQuotaHint: '为 {provider} 充值账户余额，或改选其他路由。',
    testContextWindowHint: '固定最小提示不应触发此问题；请更换模型，若仍出现请报告。',
    testUnsupportedEffortHint: '为 {provider} / {model} 选择其他推理等级（或默认值）并保存，然后重新测试。',
    testEmptyResponseHint: '连接可用，但模型返回了空补全；可重新测试或更换模型/推理等级。',
    testUnknownHint: '查看详情并核对提供商设置后重试；若持续出现，请更换提供商或模型。',
  };

  const en = {
    title: 'Auto-review model',
    subtitle: 'Choose the provider, model and reasoning effort used for auto review. An empty provider inherits the current session model.',
    enabled: 'Enable auto-review model configuration',
    enabledDesc: 'When off, auto review keeps the current session model and reasoning effort.',
    provider: 'Provider',
    providerEmpty: 'Inherit current session model',
    model: 'Model',
    modelPlaceholder: 'Select a model',
    inheritModel: 'Inherit current session model',
    effort: 'Reasoning effort',
    effortDefault: 'Default (unset)',
    save: 'Save',
    discard: 'Discard changes',
    reload: 'Reload',
    saving: 'Saving…',
    saved: 'Saved',
    savedCatalogFailed: 'Saved, but the model catalog could not be loaded',
    unsaved: 'You have unsaved changes',
    loading: 'Loading settings…',
    loadFailed: 'Failed to load settings',
    saveFailed: 'Failed to save',
    reloadFailed: 'Saved, but reloading the settings failed',
    catalogFailed: 'Failed to load model catalog; existing settings remain editable',
    conflict: 'These settings changed elsewhere. Click "Reload" or refresh the page and try again.',
    incompleteRouteHint: 'Model not selected; override is inactive, continuing with session model',
    summaryLabel: 'Auto-review model',
    summaryLoading: 'Loading…',
    summaryOff: 'Off',
    summaryInherit: 'Inherits the current session model',
    summaryError: 'Failed to load',
    unavailable: '(unavailable)',
    unverified: '(unverified)',
    notAdvertised: '(not advertised)',
    // Saved-route test action. Only classified outcomes and a short technical
    // detail are rendered; the provider's response text never reaches the page.
    test: 'Test saved route',
    testing: 'Testing saved route…',
    testLabel: 'Review route test',
    testHint: 'Tests the saved route only: {route}. Unsaved changes are not tested.',
    testHintDirty: 'You have unsaved changes; they are not tested.',
    testRouteDisabled: 'override disabled',
    testRouteIncomplete: 'provider or model not saved',
    testUnavailableHint: 'The route test is unavailable because its Remote endpoint did not mount. Refresh the page or restart DSH and try again.',
    testResultPrefix: 'Test result',
    testTransportFailed: 'The test could not run',
    testUnknownResult: 'The route test returned an unrecognized result.',
    testDetail: 'Detail',
    testEffortNote: 'The saved reasoning effort "{effort}" is not advertised by this route; auto review falls back to the provider default.',
    testSeconds: '{seconds}s',
    testNoEnvVar: 'the provider credential setting',
    testResultRoute: 'Tested route',
    testFailureCode: 'Failure code',
    testTransportHint: 'Retry the test. If it keeps failing, reload the page or restart DSH.',
    testLoadingHint: 'Settings are not loaded yet; reload the page before testing.',
    testOkMessage: 'The route works.',
    testRouteDisabledMessage: 'The auto-review override is disabled in the saved settings.',
    testRouteIncompleteMessage: 'The saved review route is incomplete.',
    testBusyMessage: 'A route test is already running.',
    testRateLimitedMessage: 'Route tests were started too frequently.',
    testCancelledMessage: 'The route test was cancelled.',
    testTimeoutMessage: 'The saved route did not respond in time.',
    testNoAdapterMessage: 'The saved provider has no registered adapter.',
    testUnknownModelMessage: 'The saved model is not available on this route.',
    testMissingCredentialMessage: 'No credential is configured for this provider.',
    testInvalidCredentialMessage: 'The stored credential for this provider is malformed.',
    testNoCredentialStoreMessage: 'The credential store is not available.',
    testAuthMessage: 'The provider rejected the credential.',
    testAccountSignInMessage: 'The DeepSeek Account route requires a sign-in.',
    testAccountAuthFailedMessage: 'The DeepSeek Account authorization was rejected.',
    testAccountConnectionMessage: 'The DeepSeek Account service could not be reached.',
    testConnectionMessage: 'The provider could not be reached.',
    testRateLimitMessage: 'The provider rate-limited the test request.',
    testQuotaMessage: 'The provider account has no remaining quota or balance.',
    testContextWindowMessage: 'The test request exceeded the model context window.',
    testUnsupportedEffortMessage: 'The saved reasoning effort is not supported by this model.',
    testEmptyResponseMessage: 'The route answered but returned no content.',
    testUnknownMessage: 'The route test failed for an unexpected reason.',
    testOkHint: '',
    testRouteDisabledHint: 'Enable the override and save a provider and model, then test again.',
    testRouteIncompleteHint: 'Save both a provider and a model in Settings, then test again.',
    testBusyHint: 'Wait for the current test to finish, then try again.',
    testRateLimitedHint: 'Wait {seconds} before testing again.',
    testCancelledHint: 'Run the test again.',
    testTimeoutHint: 'Check the network and provider status, then retry. If it repeats, choose another provider or model.',
    testNoAdapterHint: 'Configure {provider} in Settings → Providers, or choose a provider that has an adapter; restart DSH if needed, then test again.',
    testUnknownModelHint: 'Choose another model for {provider}, save the settings, then test again.',
    testMissingCredentialHint: 'Add a credential for {provider} in Settings → Providers (environment variable: {env}), then test again.',
    testInvalidCredentialHint: 'Correct the credential for {provider} in Settings → Providers, then test again.',
    testNoCredentialStoreHint: 'Restart DSH or configure the credential store, then test again.',
    testAuthHint: 'Check the API key for {provider} in Settings → Providers, then test again.',
    testAccountSignInHint: 'Open Settings → DeepSeek Account, sign in again, then test again.',
    testAccountAuthFailedHint: 'Open Settings → DeepSeek Account and sign in again; if it still fails, confirm that {provider} is available for this account.',
    testAccountConnectionHint: 'Check the network and retry. If the account service is unavailable, choose another provider route.',
    testConnectionHint: 'Check the network and the provider endpoint/base URL, then retry.',
    testRateLimitHint: 'Wait for the provider rate limit to reset, then test again, or reduce test frequency.',
    testQuotaHint: 'Replenish the balance for {provider} or choose another route.',
    testContextWindowHint: 'A fixed minimal prompt should not trigger this; choose another model and report it if it repeats.',
    testUnsupportedEffortHint: 'Choose another reasoning effort (or the default) for {provider} / {model}, save, then test again.',
    testEmptyResponseHint: 'The connection works but the model returned an empty completion. Test again or pick another model/effort.',
    testUnknownHint: 'Review the detail and the provider settings, then retry. If it repeats, choose another provider or model.',
  };

  const cssText = `
.dsh_arm_section{display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--dsw-alias-label-primary)}
.dsh_arm_title{margin:0;color:var(--dsw-alias-label-primary);font-size:18px;line-height:26px;font-weight:600}
.dsh_arm_subtitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dsh_arm_toggle{display:flex;align-items:flex-start;gap:12px;min-width:0;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.dsh_arm_checkbox{flex:none;width:18px;height:18px;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh_arm_checkbox:disabled{cursor:default}
.dsh_arm_toggleText{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh_arm_toggleTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsh_arm_toggleDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dsh_arm_fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;min-width:0}
.dsh_arm_field{display:flex;flex-direction:column;gap:6px;min-width:0;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsh_arm_label{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:600}
.dsh_arm_select{position:relative;min-width:0}
.dsh_arm_trigger{box-sizing:border-box;width:100%;height:32px;padding:0 28px 0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.dsh_arm_trigger:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.dsh_arm_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dsh_arm_triggerOpen{border-color:var(--dsw-alias-brand-primary)}
.dsh_arm_chevron{position:absolute;top:0;right:8px;height:32px;display:flex;align-items:center;pointer-events:none;color:var(--dsw-alias-label-caption);font-size:10px}
.dsh_arm_menu{box-sizing:border-box;position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:20;max-height:220px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv3);padding:4px}
.dsh_arm_option{box-sizing:border-box;width:100%;border:none;border-radius:6px;background:none;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;text-align:left;padding:6px 8px;cursor:pointer;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.dsh_arm_option:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh_arm_optionActive{background:var(--dsw-alias-interactive-bg-hover)}
.dsh_arm_actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;min-width:0}
.dsh_arm_unsaved{margin-right:auto;color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}
.dsh_arm_button{box-sizing:border-box;height:32px;font:inherit;cursor:pointer;border-radius:16px;justify-content:center;align-items:center;gap:4px;padding:0 16px;font-size:13px;line-height:20px;display:inline-flex}
.dsh_arm_button:disabled{opacity:.55;cursor:default}
.dsh_arm_buttonPrimary{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh_arm_buttonPrimary:hover:not(:disabled){filter:brightness(1.06)}
.dsh_arm_buttonSecondary{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.dsh_arm_buttonSecondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh_arm_buttonDirty{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}
.dsh_arm_status{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dsh_arm_statusOk{color:var(--dsw-alias-label-secondary)}
.dsh_arm_statusError{color:var(--dsw-alias-state-error-primary)}
.dsh_arm_summary{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsh_arm_hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh_arm_test{display:flex;flex-direction:column;gap:6px;min-width:0;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh_arm_testHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0}
.dsh_arm_testTitle{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-weight:600}
.dsh_arm_testStatus{margin:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dsh_arm_testOk{color:var(--dsw-alias-label-secondary)}
.dsh_arm_testWarn{color:var(--dsw-alias-state-warn-label)}
.dsh_arm_testError{color:var(--dsw-alias-state-error-primary)}
.dsh_arm_testBlocked{color:var(--dsw-alias-label-tertiary)}
.dsh_arm_testFeedback{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh_arm_testDetail{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
`;

  /** Inject the component stylesheet once; a no-op without a document. */
  function adoptStyles(): void {
    if (typeof document === 'undefined' || document === null) return;
    const existing = typeof document.getElementById === 'function'
      ? document.getElementById(STYLE_ID)
      : null;
    if (existing !== null && existing !== undefined) return;
    const head = document.head;
    if (head === undefined || head === null) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = cssText;
    head.appendChild(style);
  }

  function trimString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * Extract the namespace section value from a response or raw object.
   * If value has a namespace view shape ({ ns, value, revision }), extracts its inner value;
   * otherwise returns the input as-is.
   * @param {unknown} value - namespace view or direct section object.
   * @returns {unknown}
   */
  function namespaceSection(value: unknown): unknown {
    if (value !== null && typeof value === 'object' && 'ns' in value && 'value' in value) {
      return (value as { value: unknown }).value;
    }
    return value;
  }

  /**
   * Coerce whatever the settings namespace holds into the four form fields.
   * Dirty values degrade to safe defaults, and strings are trimmed.
   * @param {unknown} raw - the namespace value, possibly absent or malformed.
   * @returns {{ enabled: boolean, provider: string, model: string, reasoningEffort: string }}
   */
  function normalizeSettings(raw: unknown): ReviewerSettings {
    const source = raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {};
    return {
      enabled: source.enabled !== false,
      provider: trimString(source.provider),
      model: trimString(source.model),
      reasoningEffort: trimString(source.reasoningEffort),
    };
  }

  /**
   * Read the provider groups out of a model catalog (or a raw groups array).
   * Groups without a usable id are dropped; a missing display name falls back
   * to the id so a custom dropdown always has a label.
   * @param {unknown} catalog - ModelCatalog, a RemoteResult wrapping one, or a groups array.
   * @returns {Array<{ id: string, name: string, models: Array<{ id: string, name: string, reasoning?: object }> }>}
   */
  function providerGroups(catalog: unknown): ProviderGroup[] {
    let groups: unknown[] = [];
    if (Array.isArray(catalog)) {
      groups = catalog;
    } else if (catalog !== null && typeof catalog === 'object') {
      const record = catalog as Record<string, unknown>;
      if (Array.isArray(record.groups)) groups = record.groups;
      else if (
        record.value !== null
        && typeof record.value === 'object'
        && Array.isArray((record.value as Record<string, unknown>).groups)
      ) {
        groups = (record.value as { groups: unknown[] }).groups;
      }
    }
    const result: ProviderGroup[] = [];
    for (const group of groups) {
      if (group === null || typeof group !== 'object') continue;
      const record = group as Record<string, unknown>;
      const id = trimString(record.id);
      if (id === '') continue;
      const models = Array.isArray(record.models)
        ? record.models.filter(
            (model): model is ModelInfo =>
              model !== null
              && typeof model === 'object'
              && trimString((model as Record<string, unknown>).id) !== '',
          )
        : [];
      result.push({
        ...record,
        id,
        name: trimString(record.name) || id,
        models,
      });
    }
    return result;
  }

  /**
   * Models of one provider; an empty or unknown provider yields no models.
   * @param {unknown} groups - provider groups from the model catalog.
   * @param {unknown} provider - provider id.
   * @returns {Array<object>} the provider's models.
   */
  function modelsFor(groups: unknown, provider: unknown): ModelInfo[] {
    const id = trimString(provider);
    if (id === '') return [];
    const group = providerGroups(groups).find((item) => item.id === id);
    return group === undefined ? [] : group.models;
  }

  /**
   * Reasoning efforts a model supports, normalized to `{ id, name }` even when
   * the catalog carries ids only. A model without reasoning metadata yields [].
   * @param {unknown} model - one model catalog entry.
   * @returns {Array<{ id: string, name: string }>}
   */
  function effortsFor(model: unknown): EffortInfo[] {
    if (model === null || typeof model !== 'object') return [];
    const record = model as Record<string, unknown>;
    const reasoning = record.reasoning;
    if (
      reasoning === null
      || typeof reasoning !== 'object'
      || !Array.isArray((reasoning as Record<string, unknown>).efforts)
    ) {
      return [];
    }
    const efforts: EffortInfo[] = [];
    for (const effort of (reasoning as { efforts: unknown[] }).efforts) {
      if (typeof effort === 'string') {
        const id = effort.trim();
        if (id !== '') efforts.push({ id, name: id });
        continue;
      }
      if (effort === null || typeof effort !== 'object') continue;
      const item = effort as Record<string, unknown>;
      const id = trimString(item.id);
      if (id === '') continue;
      efforts.push({ ...item, id, name: trimString(item.name) || id });
    }
    return efforts;
  }

  /**
   * Selecting a provider drops the model and effort if the provider actually
   * changed. Re-selecting the same provider is a no-op that preserves existing
   * model/effort and avoids unnecessary dirty state.
   */
  function draftAfterProvider(draft: unknown, provider: unknown): ReviewerSettings {
    const base = normalizeSettings(draft);
    const nextProvider = trimString(provider);
    if (nextProvider === base.provider) {
      return base;
    }
    return {
      ...base,
      provider: nextProvider,
      model: '',
      reasoningEffort: '',
    };
  }

  /**
   * Selecting a model keeps the current reasoning effort only when that model
   * supports it; a stale effort is cleared rather than silently persisted.
   * Re-selecting the same model is a no-op that preserves existing reasoningEffort
   * (including unadvertised/unverified values) and avoids unnecessary dirty state.
   */
  function draftAfterModel(draft: unknown, modelId: unknown, groups: unknown): ReviewerSettings {
    const base = normalizeSettings(draft);
    const model = trimString(modelId);
    if (model === base.model) {
      return base;
    }
    const supported = effortsFor(
      modelsFor(groups, base.provider).find((item) => item.id === model),
    ).map((effort) => effort.id);
    const reasoningEffort = base.reasoningEffort !== '' && !supported.includes(base.reasoningEffort)
      ? ''
      : base.reasoningEffort;
    return {
      ...base,
      model,
      reasoningEffort,
    };
  }

  /**
   * Reconcile a loaded value: normalizes the fields without clearing any
   * persisted settings even if catalog/groups is empty or missing.
   */
  function reconcileDraft(value: unknown, _groups?: unknown): ReviewerSettings {
    return normalizeSettings(value);
  }

  function errorText(error: unknown): string {
    if (error === null || error === undefined) return '';
    if (typeof error === 'string') return error.trim();
    if (typeof error !== 'object') return '';
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim() !== '') {
      return record.message.trim();
    }
    if (typeof record.code === 'string') return record.code;
    return '';
  }

  function withDetail(base: string, error: unknown): string {
    const detail = errorText(error);
    return detail === '' ? base : base + ': ' + detail;
  }

  /**
   * Read the settings namespace and the model catalog in parallel.
   * If settings succeeds but modelCatalog fails, settings are still returned
   * with catalogError and empty groups so the form remains interactive.
   * @param {object} remote - the client Remote facade.
   * @param {string} ns - settings namespace, `auto-review-model`.
   * @returns {Promise<{ ok: true, value: ReviewerSettings, revision: number|undefined, groups: ProviderGroup[], catalogError: string }
   *   | { ok: false, error: unknown }>}
   */
  async function loadReviewerSettings(remote: RemoteFacade, ns: string): Promise<LoadResult> {
    try {
      const [describedResult, catalogResult] = await Promise.allSettled([
        remote.settings.describe(),
        remote.session.modelCatalog(),
      ]);

      if (describedResult.status === 'rejected') {
        return { ok: false, error: describedResult.reason };
      }
      const described = describedResult.value;
      if (described === null || described === undefined || described.ok !== true) {
        return {
          ok: false,
          error: described !== null && described !== undefined && described.error !== undefined
            ? described.error
            : new Error('settings/describe failed'),
        };
      }

      let groups: ProviderGroup[] = [];
      let catalogError = '';
      if (catalogResult.status === 'rejected') {
        catalogError = errorText(catalogResult.reason) || 'model catalog request failed';
      } else {
        const catalog = catalogResult.value;
        if (catalog === null || catalog === undefined || catalog.ok !== true) {
          const err = catalog !== null && catalog !== undefined ? catalog.error : undefined;
          catalogError = errorText(err) || 'model catalog unavailable';
        } else {
          groups = providerGroups(catalog.value);
        }
      }

      const namespaces = described.value !== null && described.value !== undefined && Array.isArray(described.value.namespaces)
        ? described.value.namespaces
        : [];
      const entry = namespaces.find((item) => item !== null && typeof item === 'object' && item.ns === ns);
      const rawSection = entry === undefined ? undefined : namespaceSection(entry.value);

      return {
        ok: true,
        value: normalizeSettings(rawSection),
        revision: entry !== undefined && typeof entry.revision === 'number' ? entry.revision : undefined,
        groups,
        catalogError,
      };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * Replace the namespace's user section with the form's four fields, asking
   * the Host to refuse the write if the revision moved since it was read.
   * Resolves to the `remote.settings.replace` response unchanged.
   */
  function saveReviewerSettings(
    remote: RemoteFacade,
    ns: string,
    draft: unknown,
    revision: number | undefined,
  ): Promise<RemoteResponse<unknown>> {
    const expectedRevision = typeof revision === 'number' && Number.isFinite(revision) ? revision : undefined;
    return remote.settings.replace(ns, normalizeSettings(draft), expectedRevision);
  }

  function saveFailureText(response: RemoteResponse<unknown>, t: (key: string) => string): string {
    const error = response !== null && response !== undefined ? response.error : undefined;
    const code = error !== null && error !== undefined && typeof error === 'object'
      && typeof (error as Record<string, unknown>).code === 'string'
      ? (error as { code: string }).code
      : '';
    if (code === 'settings/conflict' || /conflict/i.test(errorText(error))) {
      return t('conflict');
    }
    return withDetail(t('saveFailed'), error);
  }

  /**
   * Fully controlled dropdown: a trigger button plus an absolutely positioned
   * list. A document-level capture listener closes it on outside mousedown,
   * and Escape closes it as well; no native <select> is used.
   */
  function ARMSelect(props: SelectProps): ReactElementLike {
    const [open, setOpen] = React.useState(false);
    const [activeIndex, setActiveIndex] = React.useState(0);
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);
    const optionRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

    const options = props.options;
    const selectedIndex = options.findIndex((option) => option.value === props.value);
    const selected = selectedIndex < 0 ? undefined : options[selectedIndex];
    const label = selected === undefined ? props.placeholder : selected.label;

    const closeMenu = (restoreFocus: boolean): void => {
      setOpen(false);
      if (restoreFocus) triggerRef.current?.focus();
    };
    const openMenu = (index: number): void => {
      if (options.length === 0) return;
      setActiveIndex(Math.max(0, Math.min(index, options.length - 1)));
      setOpen(true);
    };
    const moveActive = (index: number): void => {
      if (options.length === 0) return;
      setActiveIndex((index + options.length) % options.length);
    };

    React.useEffect(() => {
      if (!open) return undefined;
      optionRefs.current[activeIndex]?.focus();
      return undefined;
    }, [open, activeIndex]);

    React.useEffect(() => {
      if (!open) return undefined;
      if (typeof document === 'undefined' || document === null) return undefined;
      const onMouseDown = (event: MouseEvent): void => {
        const root = rootRef.current;
        if (root !== null && !root.contains(event.target as Node)) closeMenu(false);
      };
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeMenu(true);
        }
      };
      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      return () => {
        document.removeEventListener('mousedown', onMouseDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
      };
    }, [open]);

    React.useEffect(() => {
      if (props.disabled && open) closeMenu(true);
    }, [props.disabled, open]);

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        if (open) closeMenu(false);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!open) {
          openMenu(event.key === 'ArrowDown'
            ? (selectedIndex < 0 ? 0 : selectedIndex)
            : (selectedIndex < 0 ? options.length - 1 : selectedIndex));
        } else {
          moveActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
        }
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        if (open) moveActive(event.key === 'Home' ? 0 : options.length - 1);
        else openMenu(event.key === 'Home' ? 0 : options.length - 1);
      }
    };

    return React.createElement('div', { className: 'dsh_arm_select', ref: rootRef, onKeyDown },
      React.createElement('button', {
        type: 'button',
        className: 'dsh_arm_trigger' + (open ? ' dsh_arm_triggerOpen' : ''),
        disabled: props.disabled === true,
        'aria-label': props.label,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        title: label,
        ref: triggerRef,
        onClick: () => {
          if (open) closeMenu(true);
          else openMenu(selectedIndex < 0 ? 0 : selectedIndex);
        },
      }, label),
      React.createElement('span', { className: 'dsh_arm_chevron', 'aria-hidden': 'true' }, open ? '▲' : '▼'),
      open
        ? React.createElement('div', { className: 'dsh_arm_menu', role: 'listbox', 'aria-label': props.label },
          options.map((option, index) => React.createElement('button', {
            key: String(index) + ':' + option.value,
            type: 'button',
            role: 'option',
            tabIndex: index === activeIndex ? 0 : -1,
            'aria-selected': option.value === props.value,
            className: 'dsh_arm_option' + (index === activeIndex ? ' dsh_arm_optionActive' : ''),
            ref: (element: HTMLButtonElement | null) => {
              optionRefs.current[index] = element;
            },
            onMouseEnter: () => setActiveIndex(index),
            onMouseDown: (event: { stopPropagation(): void }) => {
              // Keep the document-level capture listener from closing the menu
              // before this option's click is delivered.
              event.stopPropagation();
            },
            onClick: () => {
              props.onChange(option.value);
              closeMenu(true);
            },
          }, option.label)),
        )
        : null,
    );
  }

  function armField(label: string, select: unknown): ReactElementLike {
    return React.createElement('div', { className: 'dsh_arm_field' },
      React.createElement('span', { className: 'dsh_arm_label' }, label),
      select,
    );
  }

  /* ============================================================
   * Saved-route test presentation
   *
   * The Host returns a classified outcome and a short diagnostic only; the
   * model's response text never reaches this half. Every user-visible string is
   * composed from the locale table below, interpolating route facts (provider,
   * model, effort, credential environment variables) as data.
   * ============================================================ */

  /** Outcome code → locale key for the result message. */
  const TEST_MESSAGE_KEYS: Readonly<Record<string, string>> = {
    OK: 'testOkMessage',
    ROUTE_DISABLED: 'testRouteDisabledMessage',
    ROUTE_INCOMPLETE: 'testRouteIncompleteMessage',
    BUSY: 'testBusyMessage',
    RATE_LIMITED: 'testRateLimitedMessage',
    CANCELLED: 'testCancelledMessage',
    TIMEOUT: 'testTimeoutMessage',
    NO_ADAPTER: 'testNoAdapterMessage',
    UNKNOWN_MODEL: 'testUnknownModelMessage',
    MODEL_UNSUPPORTED: 'testUnknownModelMessage',
    MISSING_CREDENTIAL: 'testMissingCredentialMessage',
    INVALID_CREDENTIAL: 'testInvalidCredentialMessage',
    NO_CREDENTIAL_STORE: 'testNoCredentialStoreMessage',
    AUTH: 'testAuthMessage',
    ACCOUNT_SIGN_IN_REQUIRED: 'testAccountSignInMessage',
    ACCOUNT_AUTH_FAILED: 'testAccountAuthFailedMessage',
    ACCOUNT_CONNECTION: 'testAccountConnectionMessage',
    CONNECTION: 'testConnectionMessage',
    RATE_LIMIT: 'testRateLimitMessage',
    QUOTA: 'testQuotaMessage',
    CONTEXT_WINDOW_EXCEEDED: 'testContextWindowMessage',
    UNSUPPORTED_REASONING_EFFORT: 'testUnsupportedEffortMessage',
    EMPTY_RESPONSE: 'testEmptyResponseMessage',
    UNKNOWN: 'testUnknownMessage',
  };

  /** Outcome code → locale key for the actionable repair hint. */
  const TEST_HINT_KEYS: Readonly<Record<string, string>> = {
    OK: 'testOkHint',
    ROUTE_DISABLED: 'testRouteDisabledHint',
    ROUTE_INCOMPLETE: 'testRouteIncompleteHint',
    BUSY: 'testBusyHint',
    RATE_LIMITED: 'testRateLimitedHint',
    CANCELLED: 'testCancelledHint',
    TIMEOUT: 'testTimeoutHint',
    NO_ADAPTER: 'testNoAdapterHint',
    UNKNOWN_MODEL: 'testUnknownModelHint',
    MODEL_UNSUPPORTED: 'testUnknownModelHint',
    MISSING_CREDENTIAL: 'testMissingCredentialHint',
    INVALID_CREDENTIAL: 'testInvalidCredentialHint',
    NO_CREDENTIAL_STORE: 'testNoCredentialStoreHint',
    AUTH: 'testAuthHint',
    ACCOUNT_SIGN_IN_REQUIRED: 'testAccountSignInHint',
    ACCOUNT_AUTH_FAILED: 'testAccountAuthFailedHint',
    ACCOUNT_CONNECTION: 'testAccountConnectionHint',
    CONNECTION: 'testConnectionHint',
    RATE_LIMIT: 'testRateLimitHint',
    QUOTA: 'testQuotaHint',
    CONTEXT_WINDOW_EXCEEDED: 'testContextWindowHint',
    UNSUPPORTED_REASONING_EFFORT: 'testUnsupportedEffortHint',
    EMPTY_RESPONSE: 'testEmptyResponseHint',
    UNKNOWN: 'testUnknownHint',
  };

  /**
   * Fill `{name}` placeholders in one locale template with route facts.
   * @param template - localized template from the dictionary.
   * @param values - placeholder values; unknown placeholders are left alone.
   * @returns the localized text.
   */
  function formatText(template: string, values: Readonly<Record<string, string>>): string {
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => (
      Object.hasOwn(values, name) ? values[name] : match
    ));
  }

  /**
   * Describe the route the test actually probes: the SAVED settings, never the
   * draft. An incomplete or disabled saved route is named explicitly so the
   * page never implies a draft is being tested.
   * @param saved - last accepted Host settings.
   * @param t - locale bind function.
   * @returns localized saved-route description.
   */
  function savedRouteText(saved: ReviewerSettings, t: (key: string) => string): string {
    if (!saved.enabled) return t('testRouteDisabled');
    if (saved.provider === '' || saved.model === '') return t('testRouteIncomplete');
    let route = saved.provider + ' / ' + saved.model;
    if (saved.reasoningEffort !== '') route += ' · ' + saved.reasoningEffort;
    return route;
  }

  /**
   * Explain which route the test button probes and whether unsaved edits exist.
   * @param saved - last accepted Host settings.
   * @param dirty - whether the draft differs from the saved settings.
   * @param available - whether the Remote endpoint mounted.
   * @param loaded - whether the saved settings were read successfully.
   * @param t - locale bind function.
   * @returns localized hint text.
   */
  function savedRouteHintText(
    saved: ReviewerSettings,
    dirty: boolean,
    available: boolean,
    loaded: boolean,
    t: (key: string) => string,
  ): string {
    if (!available) return t('testUnavailableHint');
    if (!loaded) return t('testLoadingHint');
    let hint = formatText(t('testHint'), { route: savedRouteText(saved, t) });
    if (dirty) hint += ' ' + t('testHintDirty');
    return hint;
  }

  /**
   * Render a throttle delay with locale-appropriate units.
   * @param milliseconds - delay reported by the Host, or 0.
   * @param fallbackSeconds - locale-rendered fallback when the Host reported none.
   * @param t - locale bind function.
   * @returns localized duration text.
   */
  function delayText(
    milliseconds: number,
    fallbackSeconds: number,
    t: (key: string) => string,
  ): string {
    const seconds = typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0
      ? Math.max(1, Math.ceil(milliseconds / 1000))
      : fallbackSeconds;
    return formatText(t('testSeconds'), { seconds: String(seconds) });
  }

  /**
   * Keep only a machine-shaped failure code from a Remote/Gateway error.
   *
   * A Remote rejection may carry arbitrary message text, which could include
   * provider or credential detail; the page therefore never renders
   * `error.message`. Only a bounded identifier-shaped `code` (for example
   * `gateway/cancelled`) is treated as data.
   * @param error - thrown or returned Remote error.
   * @returns the safe code, or `''`.
   */
  function safeErrorCode(error: unknown): string {
    if (error === null || error === undefined || typeof error !== 'object') return '';
    const code = (error as Record<string, unknown>).code;
    return typeof code === 'string' && /^[A-Za-z0-9_./-]{1,80}$/.test(code) ? code : '';
  }

  /**
   * Describe one probed route for display beside its outcome.
   * @param result - strict Host outcome.
   * @returns `provider / model` plus an explicit effort when one was used.
   */
  function testedRouteText(result: ReviewRouteTestResult): string {
    const route = result.route !== null && typeof result.route === 'object' ? result.route : undefined;
    const provider = trimString(result.providerName) || (route === undefined ? '' : trimString(route.provider));
    const model = route === undefined ? '' : trimString(route.model);
    const effort = route === undefined ? '' : trimString(route.reasoningEffort);
    if (provider === '' && model === '') return '';
    let text = (provider === '' ? trimString(route?.provider ?? '') : provider) + ' / ' + model;
    if (effort !== '') text += ' · ' + effort;
    return text;
  }

  /**
   * Map one Host outcome to localized presentation text.
   *
   * Never displays a model response: the message and hint come from the locale
   * dictionary keyed by the stable outcome code, route facts are interpolated as
   * data, and the diagnostic line carries only the tested route plus a
   * machine-shaped failure code (the Host's English advisory table is not
   * rendered, because the localized hint already owns the repair advice).
   * @param result - strict Host outcome.
   * @param t - locale bind function.
   * @returns localized outcome.
   */
  function mapTestResult(
    result: ReviewRouteTestResult,
    t: (key: string) => string,
  ): TestOutcome {
    const code = typeof result.code === 'string' && result.code !== '' ? result.code : 'UNKNOWN';
    const tone: TestOutcome['tone'] = result.status === 'ok'
      ? 'ok'
      : result.status === 'warning'
        ? 'warning'
        : result.status === 'blocked'
          ? 'blocked'
          : 'error';
    const route = result.route !== null && typeof result.route === 'object' ? result.route : undefined;
    const provider = trimString(result.providerName) || (route === undefined ? '' : trimString(route.provider));
    const model = route === undefined ? '' : trimString(route.model);
    const effort = route === undefined ? '' : trimString(route.reasoningEffort);
    const credentialEnv = Array.isArray(result.credentialEnv)
      ? result.credentialEnv.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const values: Record<string, string> = {
      provider: provider === '' ? t('provider') : provider,
      model,
      effort,
      env: credentialEnv.length > 0 ? credentialEnv.join(' / ') : t('testNoEnvVar'),
      seconds: delayText(result.retryAfterMs, 30, t),
    };
    const messageKey = TEST_MESSAGE_KEYS[code] ?? 'testUnknownMessage';
    const hintKey = TEST_HINT_KEYS[code] ?? 'testUnknownHint';
    const hintTemplate = t(hintKey);
    const failureCode = trimString(result.failureCode);
    const hostDetail = trimString(result.detail);
    // Classified outcomes already have localized repair advice; only an
    // unclassified failure shows the Host's sanitized diagnostic, so the page
    // never repeats English advisory prose on the localized UI.
    const diagnostics = code === 'UNKNOWN'
      ? [hostDetail === '' ? '' : t('testDetail') + ': ' + hostDetail]
      : [failureCode === '' ? '' : t('testFailureCode') + ': ' + failureCode];
    return {
      tone,
      message: t(messageKey),
      route: testedRouteText(result),
      hint: hintTemplate === '' ? '' : formatText(hintTemplate, values),
      detail: diagnostics.filter((entry) => entry !== '').join(' · '),
      note: result.effortNotAdvertised === true && tone === 'ok'
        ? formatText(t('testEffortNote'), { effort })
        : '',
    };
  }

  /**
   * Map a transport failure (the call itself did not produce a Host outcome) to
   * localized presentation text. Only a machine-shaped error code crosses into
   * the page; arbitrary error messages are never rendered.
   * @param error - thrown or returned Remote error.
   * @param t - locale bind function.
   * @returns localized outcome.
   */
  function mapTestTransportFailure(error: unknown, t: (key: string) => string): TestOutcome {
    const code = safeErrorCode(error);
    return {
      tone: 'error',
      message: t('testTransportFailed'),
      route: '',
      hint: t('testTransportHint'),
      detail: code === '' ? '' : t('testFailureCode') + ': ' + code,
      note: '',
    };
  }

  /**
   * Localize the "unrecognized result" case when the Host value is malformed.
   * @param t - locale bind function.
   * @returns localized outcome.
   */
  function mapTestUnknownResult(t: (key: string) => string): TestOutcome {
    return {
      tone: 'error',
      message: t('testUnknownResult'),
      route: '',
      hint: '',
      detail: '',
      note: '',
    };
  }

  /**
   * Theme-token class for one outcome tone.
   * @param tone - presentation tone.
   * @returns the status element class list.
   */
  function testStatusClass(tone: TestOutcome['tone']): string {
    const modifier = tone === 'ok'
      ? 'dsh_arm_testOk'
      : tone === 'warning'
        ? 'dsh_arm_testWarn'
        : tone === 'blocked'
          ? 'dsh_arm_testBlocked'
          : 'dsh_arm_testError';
    return 'dsh_arm_testStatus ' + modifier;
  }

  function summaryLine(
    draft: ReviewerSettings,
    loading: boolean,
    t: (key: string) => string,
  ): string {
    if (loading) return t('summaryLabel') + ': ' + t('summaryLoading');
    if (!draft.enabled) return t('summaryLabel') + ': ' + t('summaryOff');
    if (draft.provider === '' || draft.model === '') return t('summaryLabel') + ': ' + t('summaryInherit');
    let line = t('summaryLabel') + ': ' + draft.provider + ' / ' + draft.model;
    if (draft.reasoningEffort !== '') line += ' · ' + draft.reasoningEffort;
    return line;
  }

  function ReviewerModelConfig(props: ConfigProps): ReactElementLike {
    const view = props.view;
    const remote = props.remote;
    const t = props.t;
    const testRoute = props.testRoute;

    // `saved` is the last accepted Host value; `draft` is the edited form.
    // Nothing is written until Save, and Save re-reads the namespace so the
    // next write carries the revision produced by this one.
    const [saved, setSaved] = React.useState<ReviewerSettings>(DEFAULT_SETTINGS);
    const [draft, setDraft] = React.useState<ReviewerSettings>(DEFAULT_SETTINGS);
    const [groups, setGroups] = React.useState<ProviderGroup[]>([]);
    const [revision, setRevision] = React.useState<number | undefined>(undefined);
    const [catalogError, setCatalogError] = React.useState<string>('');
    const [loading, setLoading] = React.useState(true);
    const [loaded, setLoaded] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState<StatusLine | null>(null);
    // The saved-route test is independent from Save: it has its own in-flight
    // flag and its own result line, so it never reuses the save `busy` state or
    // overwrites the save status text.
    const [testing, setTesting] = React.useState(false);
    const [testStatus, setTestStatus] = React.useState<TestOutcome | null>(null);
    const aliveRef = React.useRef(true);
    // Every started probe gets a sequence number; changing the saved route, or
    // starting another probe, advances it so a late response can never be shown
    // beside a different saved route. A synchronous ref also prevents two
    // handler invocations in the same render from issuing two Remote calls.
    const probeSeqRef = React.useRef(0);
    const activeProbeRef = React.useRef<number | null>(null);
    // Cancellation for the one in-flight probe: the Host applies its own
    // deadline, but unmounting this page or changing the saved route must stop
    // the probe (and its provider request) promptly instead of letting it run
    // up to the 20 s deadline.
    const probeAbortRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
      // Re-arm on setup so a StrictMode effect replay cannot ignore responses.
      aliveRef.current = true;
      return () => {
        aliveRef.current = false;
        const controller = probeAbortRef.current;
        probeAbortRef.current = null;
        controller?.abort();
      };
    }, []);

    const reloadSettings = React.useCallback(async () => {
      setLoading(true);
      try {
        const result = await loadReviewerSettings(remote, NS);
        if (!result.ok) {
          setStatus({ kind: 'error', text: withDetail(t('loadFailed'), result.error) });
          setLoading(false);
          return;
        }
        const next = reconcileDraft(result.value, result.groups);
        setSaved(next);
        setDraft(next);
        setGroups(result.groups);
        setRevision(result.revision);
        setCatalogError(result.catalogError);
        setLoaded(true);
        setLoading(false);
        // A reloaded saved route invalidates any earlier probe result.
        invalidateProbe();
        if (result.catalogError !== '') {
          setStatus({
            kind: 'error',
            text: withDetail(t('catalogFailed'), result.catalogError),
          });
        } else {
          setStatus(null);
        }
      } catch (error) {
        setStatus({ kind: 'error', text: withDetail(t('loadFailed'), error) });
        setLoading(false);
      }
    }, [remote, t]);

    React.useEffect(() => {
      let cancelled = false;
      setLoading(true);
      setLoaded(false);
      loadReviewerSettings(remote, NS).then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setStatus({ kind: 'error', text: withDetail(t('loadFailed'), result.error) });
          setLoading(false);
          return;
        }
        const next = reconcileDraft(result.value, result.groups);
        setSaved(next);
        setDraft(next);
        setGroups(result.groups);
        setRevision(result.revision);
        setCatalogError(result.catalogError);
        setLoaded(true);
        setLoading(false);
        // A reloaded saved route invalidates any earlier probe result.
        invalidateProbe();
        if (result.catalogError !== '') {
          setStatus({
            kind: 'error',
            text: withDetail(t('catalogFailed'), result.catalogError),
          });
        } else {
          setStatus(null);
        }
      }).catch((error) => {
        if (cancelled) return;
        setStatus({ kind: 'error', text: withDetail(t('loadFailed'), error) });
        setLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }, [remote, t]);

    const dirty = FIELDS.some((key) => draft[key] !== saved[key]);

    const availableModels = modelsFor(groups, draft.provider);
    const selectedModel = availableModels.find((model) => model.id === draft.model);
    const availableEfforts = effortsFor(selectedModel);

    const providerOptions = [{ value: '', label: t('providerEmpty') }];
    if (draft.provider !== '' && !groups.some((group) => group.id === draft.provider)) {
      providerOptions.push({ value: draft.provider, label: draft.provider + ' ' + t('unavailable') });
    }
    for (const group of groups) providerOptions.push({ value: group.id, label: group.name || group.id });

    const modelOptions = availableModels.map((model) => ({ value: model.id, label: model.name || model.id }));
    if (draft.model !== '' && selectedModel === undefined) {
      modelOptions.unshift({ value: draft.model, label: draft.model + ' ' + t('unavailable') });
    }

    const effortOptions = [{ value: '', label: t('effortDefault') }];
    for (const effort of availableEfforts) {
      effortOptions.push({ value: effort.id, label: effort.name || effort.id });
    }
    if (draft.reasoningEffort !== '' && !availableEfforts.some((e) => e.id === draft.reasoningEffort)) {
      const effortSuffix = catalogError !== ''
        ? t('unverified')
        : (selectedModel !== undefined ? t('notAdvertised') : t('unverified'));
      effortOptions.push({
        value: draft.reasoningEffort,
        label: draft.reasoningEffort + ' ' + effortSuffix,
      });
    }

    const formBusy = busy || loading;
    const controlsDisabled = formBusy || !loaded;

    const clearOk = () => {
      setStatus((prev) => (prev !== null && prev.kind === 'ok' ? null : prev));
    };

    const edit = (patch: Partial<ReviewerSettings>): void => {
      setDraft((prev) => ({ ...prev, ...patch }));
      clearOk();
    };

    const applyNext = (makeNext: (previous: ReviewerSettings) => ReviewerSettings): void => {
      setDraft((prev) => makeNext(prev));
      clearOk();
    };

    const discard = () => {
      setDraft(saved);
      setStatus(null);
    };

    /**
     * Drop any in-flight probe's authority and its displayed outcome.
     *
     * Called whenever the saved route changes: a result must never appear beside
     * a different route than the one the Host actually probed.
     */
    const invalidateProbe = (): void => {
      probeSeqRef.current += 1;
      const controller = probeAbortRef.current;
      probeAbortRef.current = null;
      // Saved-route change: cancel the probe for the previous route so no work
      // (or provider request) continues for a route the page no longer shows.
      controller?.abort();
      setTestStatus(null);
    };

    /**
     * Probe the SAVED review route through the mounted Remote endpoint.
     *
     * The endpoint takes no arguments: the Host reads the saved settings itself,
     * so a draft is never transmitted, no browser credential is read, and no
     * route can be injected from the page. An independent `testing` flag (not
     * the save `busy` flag) plus a synchronous sequence/lock guard duplicate
     * taps, and a response is accepted only while its sequence is still current.
     * The call receives a component-owned AbortSignal; unmounting the page or
     * changing the saved route aborts it, so the Host stops the provider probe
     * early. Results are classified text; provider prose is never requested or
     * shown.
     */
    const runRouteTest = async () => {
      if (testing || formBusy || !loaded || testRoute === undefined) return;
      if (activeProbeRef.current !== null) return;
      // Defensive: a probe may never share the page with a second one, so a
      // controller still present here belongs to a retired probe.
      probeAbortRef.current?.abort();
      const controller = new AbortController();
      probeAbortRef.current = controller;
      const sequence = probeSeqRef.current + 1;
      probeSeqRef.current = sequence;
      activeProbeRef.current = sequence;
      setTesting(true);
      setTestStatus(null);
      try {
        const response = await testRoute.testReviewRoute(controller.signal);
        if (!aliveRef.current || activeProbeRef.current !== sequence) return;
        if (sequence !== probeSeqRef.current) return;
        if (response === null || response === undefined || response.ok !== true) {
          setTestStatus(mapTestTransportFailure(
            response === null || response === undefined ? undefined : response.error,
            t,
          ));
          return;
        }
        const value = response.value;
        if (value === null || value === undefined || typeof value !== 'object' || typeof value.code !== 'string') {
          setTestStatus(mapTestUnknownResult(t));
          return;
        }
        setTestStatus(mapTestResult(value, t));
      } catch (error) {
        if (aliveRef.current && activeProbeRef.current === sequence && sequence === probeSeqRef.current) {
          setTestStatus(mapTestTransportFailure(error, t));
        }
      } finally {
        if (probeAbortRef.current === controller) probeAbortRef.current = null;
        if (activeProbeRef.current === sequence) {
          activeProbeRef.current = null;
          if (aliveRef.current) setTesting(false);
        }
      }
    };

    const handleSave = async () => {
      if (busy || loading || !loaded || !dirty) return;
      setBusy(true);
      setStatus(null);
      try {
        const response = await saveReviewerSettings(remote, NS, draft, revision);
        if (response === null || response === undefined || response.ok !== true) {
          setStatus({ kind: 'error', text: saveFailureText(response, t) });
          return;
        }
        // The write response may carry a new revision, but the form reloads
        // the namespace explicitly so `value`, `revision` and `groups` all
        // come from the same post-write snapshot.
        const refreshed = await loadReviewerSettings(remote, NS);
        if (refreshed.ok) {
          const next = reconcileDraft(refreshed.value, refreshed.groups);
          setSaved(next);
          setDraft(next);
          setGroups(refreshed.groups);
          setRevision(refreshed.revision);
          setCatalogError(refreshed.catalogError);
          // A saved route change invalidates any earlier probe result.
          invalidateProbe();
          if (refreshed.catalogError !== '') {
            setStatus({ kind: 'ok', text: withDetail(t('savedCatalogFailed'), refreshed.catalogError) });
          } else {
            setStatus({ kind: 'ok', text: t('saved') });
          }
          return;
        }
        // The save itself succeeded; keep the response's own snapshot so the
        // form does not immediately look unsaved, but say the re-read failed.
        // Keep existing catalogError intact as re-read failure brings no new catalog information.
        const view = response.value;
        const rawSection = namespaceSection(view);
        const fallback = reconcileDraft(normalizeSettings(rawSection), groups);
        setSaved(fallback);
        setDraft(fallback);
        // The saved route moved even though the re-read failed: drop a result
        // that belongs to the previous route.
        invalidateProbe();
        let fallbackRevision: number | undefined = undefined;
        if (
          view !== null
          && view !== undefined
          && typeof view === 'object'
          && typeof (view as { revision?: unknown }).revision === 'number'
        ) {
          fallbackRevision = (view as { revision: number }).revision;
        } else if (typeof response.revision === 'number') {
          fallbackRevision = response.revision;
        }
        if (fallbackRevision !== undefined) {
          setRevision(fallbackRevision);
        }
        setStatus({ kind: 'error', text: withDetail(t('reloadFailed'), refreshed.error) });
      } catch (error) {
        setStatus({ kind: 'error', text: withDetail(t('saveFailed'), error) });
      } finally {
        setBusy(false);
      }
    };

    if (view === 'summary') {
      const line = status !== null && status.kind === 'error' && !loaded
        ? t('summaryLabel') + ': ' + t('summaryError')
        : summaryLine(draft, loading, t);
      return React.createElement('span', { className: 'dsh_arm_summary' }, line);
    }

    const statusClass = 'dsh_arm_status'
      + (status !== null && status.kind === 'error' ? ' dsh_arm_statusError' : '')
      + (status !== null && status.kind === 'ok' ? ' dsh_arm_statusOk' : '');

    return React.createElement('section', {
      className: 'dsh_arm_section',
      'aria-busy': formBusy,
      'data-auto-review-model': 'true',
    },
      React.createElement('h2', { className: 'dsh_arm_title' }, t('title')),
      React.createElement('p', { className: 'dsh_arm_subtitle' }, t('subtitle')),

      React.createElement('label', { className: 'dsh_arm_toggle' },
        React.createElement('input', {
          type: 'checkbox',
          className: 'dsh_arm_checkbox',
          checked: draft.enabled,
          disabled: controlsDisabled,
          onChange: (event: { target: { checked: boolean } }) => edit({ enabled: event.target.checked }),
        }),
        React.createElement('span', { className: 'dsh_arm_toggleText' },
          React.createElement('span', { className: 'dsh_arm_toggleTitle' }, t('enabled')),
          React.createElement('span', { className: 'dsh_arm_toggleDesc' }, t('enabledDesc')),
        ),
      ),

      React.createElement('div', { className: 'dsh_arm_fields' },
        armField(t('provider'), React.createElement(ARMSelect, {
          value: draft.provider,
          onChange: (value: string) => applyNext((prev) => draftAfterProvider(prev, value)),
          placeholder: t('providerEmpty'),
          label: t('provider'),
          options: providerOptions,
          disabled: controlsDisabled || !draft.enabled,
        })),
        armField(t('model'), React.createElement(ARMSelect, {
          value: draft.model,
          onChange: (value: string) => applyNext((prev) => draftAfterModel(prev, value, groups)),
          placeholder: draft.provider === '' ? t('inheritModel') : t('modelPlaceholder'),
          label: t('model'),
          options: modelOptions,
          disabled: controlsDisabled || !draft.enabled || draft.provider === '' || availableModels.length === 0,
        })),
        armField(t('effort'), React.createElement(ARMSelect, {
          value: draft.reasoningEffort,
          onChange: (value: string) => edit({ reasoningEffort: value }),
          placeholder: t('effortDefault'),
          label: t('effort'),
          options: effortOptions,
          disabled: controlsDisabled || !draft.enabled || (draft.reasoningEffort === '' && (draft.model === '' || availableEfforts.length === 0)),
        })),
      ),

      draft.enabled && draft.provider !== '' && draft.model === ''
        ? React.createElement('p', { className: 'dsh_arm_hint' }, t('incompleteRouteHint'))
        : null,

      React.createElement('div', { className: 'dsh_arm_actions' },
        dirty && !loading
          ? React.createElement('span', { className: 'dsh_arm_unsaved' }, t('unsaved'))
          : null,
        React.createElement('button', {
          type: 'button',
          className: 'dsh_arm_button dsh_arm_buttonSecondary',
          disabled: formBusy,
          onClick: () => {
            void reloadSettings();
          },
        }, t('reload')),
        React.createElement('button', {
          type: 'button',
          className: 'dsh_arm_button dsh_arm_buttonSecondary',
          disabled: formBusy || !dirty,
          onClick: discard,
        }, t('discard')),
        React.createElement('button', {
          type: 'button',
          className: 'dsh_arm_button dsh_arm_buttonPrimary' + (dirty ? ' dsh_arm_buttonDirty' : ''),
          disabled: formBusy || !loaded || !dirty,
          onClick: () => {
            void handleSave();
          },
        }, busy ? t('saving') : t('save')),
      ),

      // Saved-route probe: an independent action with its own state and result
      // text. It always names the saved route, so a dirty draft is never mistaken
      // for what the test exercises.
      React.createElement('div', {
        className: 'dsh_arm_test',
        'data-arm-test': 'true',
        'aria-busy': testing,
      },
        React.createElement('div', { className: 'dsh_arm_testHeader' },
          React.createElement('span', { className: 'dsh_arm_testTitle' }, t('testLabel')),
          React.createElement('button', {
            type: 'button',
            className: 'dsh_arm_button dsh_arm_buttonSecondary',
            disabled: formBusy || !loaded || testing || testRoute === undefined,
            onClick: () => {
              void runRouteTest();
            },
          }, testing ? t('testing') : t('test')),
        ),
        React.createElement(
          'p',
          { className: 'dsh_arm_hint' },
          savedRouteHintText(saved, dirty, testRoute !== undefined, loaded, t),
        ),
        // One persistent polite live region announces progress, the outcome,
        // its tested route, and the actionable hint together.
        React.createElement('div', {
          className: 'dsh_arm_testFeedback',
          role: 'status',
          'aria-live': 'polite',
          'aria-atomic': 'true',
        },
          testing
            ? React.createElement('p', { className: 'dsh_arm_testStatus dsh_arm_testBlocked' }, t('testing'))
            : null,
          testStatus !== null
            ? React.createElement(
                'p',
                { className: testStatusClass(testStatus.tone) },
                t('testResultPrefix') + ': ' + testStatus.message,
              )
            : null,
          testStatus !== null && testStatus.route !== ''
            ? React.createElement(
                'p',
                { className: 'dsh_arm_hint' },
                t('testResultRoute') + ': ' + testStatus.route,
              )
            : null,
          testStatus !== null && testStatus.hint !== ''
            ? React.createElement('p', { className: 'dsh_arm_hint' }, testStatus.hint)
            : null,
          testStatus !== null && testStatus.note !== ''
            ? React.createElement('p', { className: 'dsh_arm_hint' }, testStatus.note)
            : null,
          testStatus !== null && testStatus.detail !== ''
            ? React.createElement('p', { className: 'dsh_arm_testDetail' }, testStatus.detail)
            : null,
        ),
      ),

      loading
        ? React.createElement('p', { className: 'dsh_arm_status', role: 'status' }, t('loading'))
        : null,
      status !== null
        ? React.createElement('p', { className: statusClass, role: 'status' }, status.text)
        : null,
    );
  }

  /**
   * Mount this package's `./remote` contribution, then register the settings
   * body and its independent saved-route test endpoint.
   *
   * The browser bundle requires the contribution's package-local module (the
   * generated prelude registers it from the same contract source), mounts it
   * through `ctx.remote.$mount()`, and reads the namespaced endpoint back by its
   * Cordis service key. The settings body stays usable if the optional endpoint
   * cannot mount: the page then states that the test is unavailable instead of
   * losing the form.
   *
   * @param ctx - browser plugin context.
   * @returns disposer withdrawing the UI before the Remote namespace.
   */
  async function apply(ctx: ClientContext): Promise<(() => Promise<void>) | void> {
    adoptStyles();
    const slots = ctx.get('slots');
    const locale = ctx.get('locale');
    const remote = ctx.get('remote');
    if (!slots || !locale || !remote) return;

    ctx.effect(() => locale.register(NS, { zh, en }), 'auto-review-model: dictionaries');
    const t = locale.bind(NS);

    const contributionModule = require(REMOTE_CONTRIBUTION_SPECIFIER) as {
      TYPERT_REMOTE?: RemoteContributionLike;
    };
    const contribution = contributionModule === null || contributionModule === undefined
      ? undefined
      : contributionModule.TYPERT_REMOTE;
    let unmountRemote: (() => Promise<void>) | undefined;
    let testRoute: TestRouteEndpoint | undefined;
    if (
      contribution !== null
      && contribution !== undefined
      && typeof contribution === 'object'
      && typeof remote.$mount === 'function'
    ) {
      try {
        unmountRemote = await remote.$mount(contribution);
        testRoute = ctx.get('remote.autoReviewModel') as TestRouteEndpoint | undefined;
      } catch {
        // Graceful degradation: keep the settings form and say the test is
        // unavailable rather than failing the whole configuration body.
        unmountRemote = undefined;
        testRoute = undefined;
      }
    }

    const registerBody = (child: ClientContext): (() => void) | void => {
      const childSlots = child.get('slots');
      if (!childSlots) return;
      childSlots.inject('plugins.bundle.config', () => childSlots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE,
        locale: NS,
        inject: () => ({ t, remote, testRoute }),
      }, ReviewerModelConfig));
    };
    const fiber = typeof ctx.inject === 'function'
      ? ctx.inject(['slots', 'locale'], registerBody)
      : undefined;
    if (fiber === undefined) registerBody(ctx);
    return async () => {
      if (fiber !== undefined) await fiber.dispose();
      if (unmountRemote !== undefined) await unmountRemote();
    };
  }

  const inject = ['slots', 'locale', 'remote', 'remote.settings', 'remote.session'];
  const name = 'dsh-auto-review-model';

  const __testing = {
    NS,
    BUNDLE,
    REMOTE_CONTRIBUTION_SPECIFIER,
    DEFAULT_SETTINGS,
    normalizeSettings,
    namespaceSection,
    providerGroups,
    modelsFor,
    effortsFor,
    draftAfterProvider,
    draftAfterModel,
    reconcileDraft,
    summaryLine,
    loadReviewerSettings,
    saveReviewerSettings,
    // Saved-route test helpers (localized text composition only; no prose path).
    formatText,
    savedRouteText,
    savedRouteHintText,
    delayText,
    mapTestResult,
    mapTestTransportFailure,
    mapTestUnknownResult,
    safeErrorCode,
    testedRouteText,
    testStatusClass,
    TEST_MESSAGE_KEYS,
    TEST_HINT_KEYS,
  };

  exports.apply = apply;
  exports.inject = inject;
  exports.name = name;
  exports.__testing = __testing;
  return module.exports;
} });
