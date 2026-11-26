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

/** One explicit reviewer route stored in the volatile `fallbacks` array. */
interface FallbackEntry {
  /**
   * Retained for backward compatibility with the old settings shape. This client
   * only ever writes `route`; the Host ignores legacy `session` values because
   * the intercepted request's own route is the implicit final fallback.
   */
  mode: 'route';
  /** Whether this row is eligible for review routing. */
  enabled: boolean;
  /** Relative share of new sessions this route starts on, 0-9 (0 = in-order fallback only). */
  weight: number;
  provider: string;
  model: string;
  reasoningEffort: string;
}

/** One editable explicit reviewer route (one row of the ordered settings list). */
interface ReviewRoute {
  /** Whether this row is eligible; a disabled row stays editable and testable. */
  enabled: boolean;
  /** Relative share of new sessions this route starts on, 0-9. */
  weight: number;
  provider: string;
  model: string;
  reasoningEffort: string;
}

interface ReviewerSettings {
  /**
   * Ordered reviewer routes in the current shape. When present the legacy row-1
   * fields and `fallbacks` are ignored, and every route is an ordinary list row.
   */
  routes?: FallbackEntry[];
  /** @deprecated Legacy row-1 flag, read only when `routes` is absent. */
  primaryEnabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
  /**
   * Ordered explicit routes after row 1 (the legacy primary fields above).
   * Optional so a legacy section (which never had this key) is loaded, edited
   * and saved without gaining one when the list has no second row. Legacy
   * `{ mode: 'session' }` entries are ignored and dropped on load. The
   * deprecated top-level `enabled` knob is never read or written.
   */
  fallbacks?: FallbackEntry[];
}

/** Optional explicit route input of one per-row test. */
interface ReviewRouteTestInput {
  /** `probe` (default), `review` (cases only), `full` (probe then cases) or `health`. */
  mode?: 'probe' | 'review' | 'full' | 'health';
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

/** Independent test state of one editable row. */
interface RowTestState {
  /** Whether that row's test is currently in flight. */
  busy: boolean;
  /** Localized outcome of the last completed test, or null. */
  outcome: TestOutcome | null;
  /** Scripted review-case results of the last review test, or null. */
  cases: ReviewRouteTestCase[] | null;
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
  /** Scripted review-case results; present only for a `review` run. */
  cases?: ReviewRouteTestCase[];
  /** Measured ledger health; present only for a `health` run. */
  health?: ReviewHealth;
}

/** One scripted review case result. */
interface ReviewRouteTestCase {
  case: 'allow' | 'deny';
  expected: 'allow' | 'deny';
  actual: '' | 'allow' | 'deny';
  risk: '' | 'low' | 'medium' | 'high';
  ok: boolean;
  failureCode: string;
  latencyMs: number;
  detail: string;
}

/** One route's measured health inside the current ledger week. */
interface ReviewHealthEntry {
  provider: string;
  model: string;
  attempts: number;
  answered: number;
  failed: number;
  avgMs: number;
  lastAt: number;
  lastFailureCode: string;
}

/** Ledger health snapshot served for the settings page. */
interface ReviewHealth {
  ledger: string;
  week: string;
  records: number;
  routes: ReviewHealthEntry[];
}

/** One call of the mounted `remote.autoReviewModel.testReviewRoute` endpoint. */
interface TestRouteEndpoint {
  testReviewRoute(
    input?: ReviewRouteTestInput,
    signal?: AbortSignal,
  ): Promise<RemoteResponse<ReviewRouteTestResult>>;
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
  /** Stable test hook rendered as `data-arm-select` (no behavior attached). */
  testId?: string;
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
  /**
   * Largest number of explicit routes the settings page will add or keep. Row 1
   * maps to the top-level `provider`/`model`/`reasoningEffort` fields and rows
   * 2..N map to `fallbacks`, so the whole list shares one cap. The implicit
   * session row is fixed, read-only and not counted.
   */
  const MAX_ROUTES = 10;
  /** Effort sentinel the UI stores for "inherit the main session's effort". */
  const INHERIT_EFFORT = 'inherit';
  /** Values shown before the first successful read; never mutated. */
  const DEFAULT_SETTINGS: ReviewerSettings = Object.freeze({
    primaryEnabled: true,
    provider: '',
    model: '',
    reasoningEffort: '',
    fallbacks: Object.freeze([]) as unknown as FallbackEntry[],
  });

  const zh = {
    title: '自动审查模型',
    subtitle: '按顺序配置自动审查使用的提供商与模型；全部启用路由失败后自动回退到主会话模型。',
    provider: '提供商',
    effortDefault: '默认（不指定）',
    effortInherit: '继承主会话',
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
    summaryLabel: '自动审查模型',
    summaryLoading: '正在读取…',
    summarySession: '主会话模型（自动兜底）',
    summaryFallbacks: '+{count} 条后续路由',
    reviewRoutesTitle: '审查路由（按顺序尝试）',
    reviewRoutesHint: '路由按顺序尝试；全部启用路由失败后自动回退到主会话模型，若仍失败则审查失败、工具调用不会执行。测试使用该行当前值；“继承主会话”的推理等级在测试时按该路由默认等级发送。',
    reviewRoutesEmpty: '尚未配置路由。审查将直接使用主会话模型。',
    routeAdd: '添加路由',
    routeCapHint: '最多 10 条路由。',
    routeEnabled: '启用',
    routeRowLabel: '审查路由 {index}',
    routeTableLabel: '审查路由表',
    routeActions: '操作',
    routeProvider: '提供商',
    routeProviderPlaceholder: '选择提供商',
    routeModel: '模型',
    routeModelPlaceholder: '选择模型（先选提供商）',
    routeEffort: '推理等级',
    routeWeight: '权重',
    routeIncompleteHint: '提供商或模型未选择完整；启用后此路由会在审查时被跳过。',
    routeMoveUp: '上移',
    routeMoveDown: '下移',
    routeRemove: '删除',
    summaryError: '读取失败',
    unavailable: '（不可用）',
    unverified: '（未验证）',
    notAdvertised: '（未声明）',
    // Saved-route test action. Every string here is what the settings page
    // renders; provider output is never displayed as prose, only classified
    // outcomes plus a short technical detail.
    test: '测试',
    testing: '测试中…',
    reviewCaseAllow: '放行用例',
    reviewCaseDeny: '拒绝用例',
    reviewPassed: '符合',
    reviewFailed: '不符',
    reviewNoAnswer: '无有效回答',
    routeHealthLine: '本周 {attempts} 次 · 成功 {answered} · 均 {avg}ms',
    routeHealthEmpty: '本周尚无真实审查记录',
    routeHealthFailed: '最近失败 {code}',
    testUnavailableHint: '路由测试当前不可用：Remote 端点未能挂载。请刷新页面或重启 DSH 后重试。',
    testResultPrefix: '测试结果',
    testTransportFailed: '测试未能运行',
    testUnknownResult: '审查路由测试返回了无法识别的结果。',
    testDetail: '详情',
    testEffortNote: '已保存的推理等级“{effort}”未被该路由声明；自动审查会回退到提供商默认值。',
    testSeconds: '{seconds} 秒',
    testNoEnvVar: '提供商凭证设置',
    testFailureCode: '失败代码',
    testTransportHint: '请重试测试；若持续失败，请刷新页面或重启 DSH。',
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
    testNoReviewPromptMessage: '还没有可供测试的真实审查提示词。',
    testReviewMismatchMessage: '路由给出了决定，但与用例期望不符。',
    testReviewSkippedMessage: '连接正常，但本进程还没有真实审查提示词，判定用例未运行。',
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
    testNoReviewPromptHint: '先让一次工具调用触发真实审查（本进程内），再运行审查测试。',
    testReviewMismatchHint: '对照两个用例：放行用例被拒绝是误杀，拒绝用例被放行是绕过，都需要换模型或检查策略路由。',
    testReviewSkippedHint: '先让一次工具调用触发真实审查（本进程内），再测试一次。',
    testEmptyResponseHint: '连接可用，但模型返回了空补全；可重新测试或更换模型/推理等级。',
    testUnknownHint: '查看详情并核对提供商设置后重试；若持续出现，请更换提供商或模型。',
  };

  const en = {
    title: 'Auto-review model',
    subtitle: 'Choose the provider and model routes auto review tries, in order; if every enabled route fails, the session model is used automatically.',
    provider: 'Provider',
    effortDefault: 'Default (unset)',
    effortInherit: 'Inherit session',
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
    summaryLabel: 'Auto-review model',
    summaryLoading: 'Loading…',
    summarySession: 'Main session model (automatic fallback)',
    summaryFallbacks: '+{count} more routes',
    reviewRoutesTitle: 'Review routes (tried in order)',
    reviewRoutesHint: 'Routes are tried in order; if every enabled route fails, the review falls back to the session model automatically, and if that also fails the review fails and the tool call is not executed. Testing uses the row\'s current values; an "Inherit session" effort is sent as that route\'s provider default for the test.',
    reviewRoutesEmpty: 'No routes configured. Reviews use the current session model directly.',
    routeAdd: 'Add route',
    routeCapHint: 'At most 10 routes.',
    routeEnabled: 'Enabled',
    routeRowLabel: 'Review route {index}',
    routeTableLabel: 'Review routes table',
    routeActions: 'Actions',
    routeProvider: 'Provider',
    routeProviderPlaceholder: 'Select a provider',
    routeModel: 'Model',
    routeModelPlaceholder: 'Select a model (provider first)',
    routeEffort: 'Reasoning effort',
    routeWeight: 'Weight',
    routeIncompleteHint: 'Provider or model is incomplete; once enabled, this route is skipped during review.',
    routeMoveUp: 'Move up',
    routeMoveDown: 'Move down',
    routeRemove: 'Remove',
    summaryError: 'Failed to load',
    unavailable: '(unavailable)',
    unverified: '(unverified)',
    notAdvertised: '(not advertised)',
    // Saved-route test action. Only classified outcomes and a short technical
    // detail are rendered; the provider's response text never reaches the page.
    test: 'Test',
    testing: 'Testing…',
    reviewCaseAllow: 'Allow case',
    reviewCaseDeny: 'Deny case',
    reviewPassed: 'passed',
    reviewFailed: 'failed',
    reviewNoAnswer: 'no usable answer',
    routeHealthLine: '{attempts} attempts this week · {answered} answered · {avg}ms avg',
    routeHealthEmpty: 'No real reviews this week yet',
    routeHealthFailed: 'last failure {code}',
    testUnavailableHint: 'Route testing is unavailable because its Remote endpoint did not mount. Refresh the page or restart DSH and try again.',
    testResultPrefix: 'Test result',
    testTransportFailed: 'The test could not run',
    testUnknownResult: 'The route test returned an unrecognized result.',
    testDetail: 'Detail',
    testEffortNote: 'The saved reasoning effort "{effort}" is not advertised by this route; auto review falls back to the provider default.',
    testSeconds: '{seconds}s',
    testNoEnvVar: 'the provider credential setting',
    testFailureCode: 'Failure code',
    testTransportHint: 'Retry the test. If it keeps failing, reload the page or restart DSH.',
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
    testNoReviewPromptMessage: 'No real reviewer prompt is available yet',
    testNoReviewPromptHint: 'Trigger one reviewed tool call in this Host process, then run the review test again.',
    testReviewMismatchMessage: 'The route decided, but not what the scripted case expects',
    testReviewSkippedMessage: 'The route answered, but this Host has no real reviewer prompt yet, so the scripted cases did not run.',
    testReviewMismatchHint: 'Read both case results: rejecting the allow case is a false block, allowing the deny case is a bypass; either way pick another model or check how the policy reaches this route.',
    testReviewSkippedHint: 'Trigger one reviewed tool call in this Host process, then test again.',
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
.dsh_arm_testStatus{margin:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dsh_arm_testOk{color:var(--dsw-alias-label-secondary)}
.dsh_arm_testWarn{color:var(--dsw-alias-state-warn-label)}
.dsh_arm_testError{color:var(--dsw-alias-state-error-primary)}
.dsh_arm_testBlocked{color:var(--dsw-alias-label-tertiary)}
.dsh_arm_testDetail{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh_arm_routeHealthRow{background:transparent}
.dsh_arm_routeHealthCell{padding-top:0!important;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh_arm_reviewBadge{box-sizing:border-box;padding:1px 8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;white-space:nowrap}
.dsh_arm_reviewPass{color:var(--dsw-alias-label-secondary)}
.dsh_arm_reviewFail{color:var(--dsw-alias-state-warn-label)}
.dsh_arm_routes{display:flex;flex-direction:column;gap:8px;min-width:0;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh_arm_routeHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0}
.dsh_arm_tableWrap{width:100%;min-width:0;overflow:visible;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsh_arm_table{box-sizing:border-box;width:100%;border-collapse:collapse;table-layout:fixed}
.dsh_arm_table th{box-sizing:border-box;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-weight:600;text-align:left;white-space:nowrap}
.dsh_arm_table td{box-sizing:border-box;min-width:0;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:middle;text-align:left}
.dsh_arm_table tbody tr:last-child td{border-bottom:none}
.dsh_arm_colEnable{width:44px}
.dsh_arm_colProvider{width:20%}
.dsh_arm_colModel{width:34%}
.dsh_arm_colEffort{width:14%}
.dsh_arm_colWeight{width:64px}
.dsh_arm_colActions{width:176px}
.dsh_arm_cellEnable{text-align:center}
.dsh_arm_tableCheckbox{width:16px;height:16px;margin:0;vertical-align:middle;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh_arm_tableCheckbox[data-arm-unavailable="true"]{accent-color:var(--dsw-alias-label-tertiary);opacity:.5}
.dsh_arm_tableCheckbox:disabled{cursor:default}
.dsh_arm_cellSelect .dsh_arm_select{width:100%;min-width:0}
.dsh_arm_cellTest{white-space:nowrap}
.dsh_arm_testButton{height:28px;padding:0 10px;font-size:12px;line-height:18px}
.dsh_arm_cellWeight{white-space:nowrap;text-align:center}
.dsh_arm_weightInput{box-sizing:border-box;width:44px;height:32px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;text-align:center}
.dsh_arm_cellActions{white-space:nowrap}
.dsh_arm_cellActions .dsh_arm_iconButton{width:28px;height:28px;margin:0 2px 0 0}
.dsh_arm_rowDisabled{background:transparent}
.dsh_arm_rowDisabled td{opacity:.62}
.dsh_arm_routeResultRow td,.dsh_arm_routeHintRow td{border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh_arm_routeResultCell{padding-top:2px!important;padding-bottom:8px!important}
.dsh_arm_routeHintCell{padding-top:0!important;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh_arm_routeTestStatus{margin:0;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh_arm_routeResultHint{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh_arm_tableEmptyRow td{padding:14px 10px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center}
.dsh_arm_iconButton{box-sizing:border-box;width:30px;height:30px;font:inherit;font-size:13px;line-height:18px;cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;padding:0}
.dsh_arm_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh_arm_iconButton:disabled{opacity:.45;cursor:default}
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
   * Coerce whatever the settings namespace holds into the stored settings shape.
   *
   * Row 1 of the settings list is the legacy primary route (`provider`, `model`,
   * `reasoningEffort`) plus `primaryEnabled`; rows 2..N are the ordered
   * `fallbacks` array with a per-row `enabled` flag. The deprecated top-level
   * `enabled` knob is never read or written. Legacy `{ mode: 'session' }`
   * fallback rows are dropped: the session model is the implicit final fallback
   * now and must never be a configurable row.
   *
   * The unified `routes` list wins only when it is non-empty: the schema fills a
   * missing volatile array with `[]`, so a legacy section must still be read
   * through the row-1/fallbacks path instead of rendering as "no routes".
   * @param {unknown} raw - the namespace value, possibly absent or malformed.
   * @returns {ReviewerSettings} the normalized route rows' storage shape.
   */
  function normalizeSettings(raw: unknown): ReviewerSettings {
    const source = raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {};
    // An empty list is not proof that the user deleted every route: schemastery
    // fills a missing volatile array with `[]`, so every section written before
    // `routes` existed reads back as "present but empty". Only a non-empty list
    // wins; anything else falls through to the legacy row-1/fallbacks migration,
    // which is exactly what the Host's readRoutes() does. A section the page
    // itself saved with no rows carries empty legacy fields too, so it still
    // resolves to an empty list.
    if (Array.isArray(source.routes) && source.routes.length > 0) {
      return {
        primaryEnabled: true,
        provider: '',
        model: '',
        reasoningEffort: '',
        routes: normalizeRoutes(source.routes).map(storedFallback),
      };
    }
    const settings: ReviewerSettings = {
      primaryEnabled: source.primaryEnabled !== false,
      provider: trimString(source.provider),
      model: trimString(source.model),
      reasoningEffort: trimString(source.reasoningEffort),
    };
    // Only materialize the key when the section actually carries a fallback
    // list, so a legacy section round-trips unchanged until the user saves.
    if (Array.isArray(source.fallbacks)) {
      settings.fallbacks = normalizeRoutes(source.fallbacks).map(storedFallback);
    }
    return settings;
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
   * Reconcile a loaded value: normalizes the stored fields without clearing any
   * persisted setting even when the catalog/groups are empty or missing.
   * @param value - namespace section value.
   * @param _groups - unused catalog snapshot (kept for call-site symmetry).
   * @returns the normalized settings.
   */
  function reconcileDraft(value: unknown, _groups?: unknown): ReviewerSettings {
    return normalizeSettings(value);
  }

  /** Whether one raw saved fallback entry is the removed `{ mode: 'session' }` row type. */
  function isLegacySessionEntry(raw: unknown): boolean {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    return trimString(source.mode).toLowerCase() === 'session';
  }

  /**
   * Normalize one editable explicit route (one row of the settings list).
   * Dirty values degrade to empty strings instead of throwing.
   * @param raw - one row or saved entry, possibly malformed.
   * @returns a normalized explicit route.
   */
  /**
   * Clamp one weight input to 0-9.
   *
   * An unset or malformed weight is 0, which starts no session: the row is only
   * reached after every positive-weight route has failed. That keeps an unchecked
   * weight indistinguishable from a legacy row, so an upgraded page changes
   * nothing until someone types a weight.
   */
  function normalizeRouteWeight(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    const clamped = Math.trunc(numeric);
    return clamped >= 0 && clamped <= 9 ? clamped : 0;
  }

  function normalizeRoute(raw: unknown): ReviewRoute {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    return {
      enabled: source.enabled !== false,
      weight: normalizeRouteWeight(source.weight),
      provider: trimString(source.provider),
      model: trimString(source.model),
      reasoningEffort: trimString(source.reasoningEffort),
    };
  }

  /**
   * Normalize a saved/edited explicit route list.
   *
   * A non-array degrades to an empty list. Legacy `{ mode: 'session' }` entries
   * are dropped (the session model is implicit and not a row), while every
   * other element becomes one row even when incomplete so the page can show it
   * instead of silently rewriting the saved list.
   * @param raw - raw `fallbacks` value or an editable row list.
   * @returns normalized explicit routes in saved order (not capped).
   */
  function normalizeRoutes(raw: unknown): ReviewRoute[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry) => !isLegacySessionEntry(entry))
      .map((entry) => normalizeRoute(entry));
  }

  /** Convert one editable row into the stored `fallbacks` entry shape. */
  function storedFallback(route: ReviewRoute): FallbackEntry {
    return {
      mode: 'route',
      enabled: route.enabled,
      weight: route.weight,
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
    };
  }

  /**
   * Build the full ordered explicit list from the saved namespace value.
   *
   * Row 1 is the legacy primary route, materialized whenever any of its fields
   * is non-empty (or it was explicitly disabled) so an incomplete or disabled
   * saved primary stays visible instead of being silently dropped. Fallback
   * entries follow as rows 2..N. Legacy session entries never appear.
   * @param raw - saved namespace value or draft settings.
   * @returns the ordered explicit routes (the implicit session route is not a row).
   */
  function rowsFromSettings(raw: unknown): ReviewRoute[] {
    const settings = normalizeSettings(raw);
    if (settings.routes !== undefined) return normalizeRoutes(settings.routes);
    const rows: ReviewRoute[] = [];
    if (
      settings.provider !== ''
      || settings.model !== ''
      || settings.reasoningEffort !== ''
      || !settings.primaryEnabled
    ) {
      rows.push({
        enabled: settings.primaryEnabled,
        weight: 0,
        provider: settings.provider,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
      });
    }
    for (const entry of settings.fallbacks ?? []) {
      rows.push({
        enabled: entry.enabled,
        weight: entry.weight,
        provider: entry.provider,
        model: entry.model,
        reasoningEffort: entry.reasoningEffort,
      });
    }
    return rows;
  }

  /**
   * Split the ordered explicit list back into the stored namespace shape.
   *
   * Row 1 becomes the top-level `primaryEnabled`/`provider`/`model`/
   * `reasoningEffort` fields and rows 2..N become `fallbacks`. The key is
   * omitted when there is no second row so a one-route (or empty) section keeps
   * its legacy shape. The deprecated top-level `enabled` key is never written.
   * @param rows - editable explicit routes in display order.
   * @returns the settings value to persist.
   */
  function settingsFromRows(rows: unknown): ReviewerSettings {
    // Every route is written as one entry of the unified list; the legacy row-1
    // fields are written empty so an older reader sees no contradictory route.
    return {
      primaryEnabled: true,
      provider: '',
      model: '',
      reasoningEffort: '',
      routes: normalizeRoutes(rows).map(storedFallback),
    };
  }

  /** Structural equality for two ordered explicit lists, used for dirty detection. */
  function routesEqual(left: unknown, right: unknown): boolean {
    const a = normalizeRoutes(left);
    const b = normalizeRoutes(right);
    if (a.length !== b.length) return false;
    return a.every((route, index) => (
      route.enabled === b[index].enabled
      && route.weight === b[index].weight
      && route.provider === b[index].provider
      && route.model === b[index].model
      && route.reasoningEffort === b[index].reasoningEffort
    ));
  }

  /**
   * Selecting a provider for one row clears its model and effort. Re-selecting
   * the same provider is a no-op so it never marks the form dirty.
   * @param route - current row.
   * @param provider - newly selected provider id.
   * @returns the updated row.
   */
  function routeAfterProvider(route: unknown, provider: unknown): ReviewRoute {
    const base = normalizeRoute(route);
    const nextProvider = trimString(provider);
    if (nextProvider === base.provider) return base;
    // Keep the inherit sentinel: it is route-independent, while an explicit
    // effort belongs to the previous provider/model and must not leak.
    return {
      ...base,
      provider: nextProvider,
      model: '',
      reasoningEffort: base.reasoningEffort === INHERIT_EFFORT ? INHERIT_EFFORT : '',
    };
  }

  /**
   * Selecting a model for one row keeps its reasoning effort only when that
   * model advertises it; re-selecting the same model is a no-op.
   * @param route - current row.
   * @param modelId - newly selected model id.
   * @param groups - provider groups from the model catalog.
   * @returns the updated row.
   */
  function routeAfterModel(route: unknown, modelId: unknown, groups: unknown): ReviewRoute {
    const base = normalizeRoute(route);
    const model = trimString(modelId);
    if (model === base.model) return base;
    if (base.reasoningEffort === INHERIT_EFFORT) return { ...base, model };
    const supported = effortsFor(
      modelsFor(groups, base.provider).find((item) => item.id === model),
    ).map((effort) => effort.id);
    const reasoningEffort = base.reasoningEffort !== '' && !supported.includes(base.reasoningEffort)
      ? ''
      : base.reasoningEffort;
    return { ...base, model, reasoningEffort };
  }

  /** Build a fresh, enabled explicit-route row that inherits the session effort. */
  function emptyRoute(): ReviewRoute {
    return { enabled: true, weight: 0, provider: '', model: '', reasoningEffort: INHERIT_EFFORT };
  }

  /**
   * Append one empty explicit-route row.
   * @param list - current explicit list.
   * @returns the new list; unchanged at {@link MAX_ROUTES}.
   */
  function addRoute(list: unknown): ReviewRoute[] {
    const rows = normalizeRoutes(list);
    if (rows.length >= MAX_ROUTES) return rows;
    return [...rows, emptyRoute()];
  }

  /** Replace one explicit-route row without mutating the current list. */
  function replaceRoute(list: unknown, index: number, next: unknown): ReviewRoute[] {
    const rows = normalizeRoutes(list);
    if (index < 0 || index >= rows.length) return rows;
    rows[index] = normalizeRoute(next);
    return rows;
  }

  /** Remove one explicit-route row without mutating the current list. */
  function removeRoute(list: unknown, index: number): ReviewRoute[] {
    const rows = normalizeRoutes(list);
    if (index < 0 || index >= rows.length) return rows;
    return rows.filter((_route, current) => current !== index);
  }

  /**
   * Move one explicit-route row up (`-1`) or down (`+1`).
   * @param list - current explicit list.
   * @param index - row to move.
   * @param delta - direction.
   * @returns the reordered list; unchanged when the move leaves the list.
   */
  function moveRoute(list: unknown, index: number, delta: number): ReviewRoute[] {
    const rows = normalizeRoutes(list);
    const target = index + delta;
    if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return rows;
    const reordered = [...rows];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    return reordered;
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
   * Replace the namespace's user section with the normalized settings value
   * (row 1 in the top-level fields, rows 2..N in `fallbacks`), asking the Host
   * to refuse the write if the revision moved since it was read. Resolves to
   * the `remote.settings.replace` response unchanged.
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

    return React.createElement('div', {
      className: 'dsh_arm_select',
      ref: rootRef,
      onKeyDown,
      ...(props.testId === undefined ? {} : { 'data-arm-select': props.testId }),
    },
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
    NO_REVIEW_PROMPT: 'testNoReviewPromptMessage',
    REVIEW_MISMATCH: 'testReviewMismatchMessage',
    REVIEW_SKIPPED: 'testReviewSkippedMessage',
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
    NO_REVIEW_PROMPT: 'testNoReviewPromptHint',
    REVIEW_MISMATCH: 'testReviewMismatchHint',
    REVIEW_SKIPPED: 'testReviewSkippedHint',
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
    // unclassified failure shows the Host's classified diagnostic, so the page
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
    const rows = rowsFromSettings(draft).filter((route) => route.enabled);
    if (rows.length === 0) return t('summaryLabel') + ': ' + t('summarySession');
    // Summarize the first enabled route and count the remaining enabled routes;
    // the implicit session fallback is not a row and is never counted.
    const first = rows[0];
    const remaining = rows.length - 1;
    const suffix = remaining === 0
      ? ''
      : ' · ' + formatText(t('summaryFallbacks'), { count: String(remaining) });
    if (first.provider === '' || first.model === '') {
      return t('summaryLabel') + ': ' + t('summarySession') + suffix;
    }
    let line = t('summaryLabel') + ': ' + first.provider + ' / ' + first.model;
    const effort = first.reasoningEffort === INHERIT_EFFORT ? 'inherit' : first.reasoningEffort;
    if (effort !== '') line += ' · ' + effort;
    return line + suffix;
  }

  function ReviewerModelConfig(props: ConfigProps): ReactElementLike {
    const view = props.view;
    const remote = props.remote;
    const t = props.t;
    const testRoute = props.testRoute;

    // `saved` is the last accepted Host value. The editable list is kept as its
    // own state (rather than derived from a settings draft) so an empty row,
    // which the split storage shape cannot represent on its own, stays visible
    // while the user fills it in. Nothing is written until Save, and Save
    // re-reads the namespace so the next write carries the revision produced by
    // this one.
    const [saved, setSaved] = React.useState<ReviewerSettings>(DEFAULT_SETTINGS);
    const [rows, setRows] = React.useState<ReviewRoute[]>(() => rowsFromSettings(DEFAULT_SETTINGS));
    const [groups, setGroups] = React.useState<ProviderGroup[]>([]);
    const [revision, setRevision] = React.useState<number | undefined>(undefined);
    const [catalogError, setCatalogError] = React.useState<string>('');
    const [loading, setLoading] = React.useState(true);
    const [loaded, setLoaded] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState<StatusLine | null>(null);
    // Per-row probe state is independent for every row and from Save: each row
    // has its own in-flight flag and result line, so a test never reuses the
    // save `busy` state or overwrites another row's result.
    const [rowTests, setRowTests] = React.useState<Record<number, RowTestState>>({});
    // Measured per-route health for the current ledger week. It is read once per
    // page and again after every test (both are local ledger reads), so it can
    // never spend review quota or contact a provider.
    const [health, setHealth] = React.useState<ReviewHealth | null>(null);
    const refreshHealth = React.useCallback(async (): Promise<void> => {
      if (testRoute === undefined) return;
      try {
        const response = await testRoute.testReviewRoute({ mode: 'health' });
        const value = response !== null && response !== undefined && response.ok === true
          ? response.value
          : undefined;
        const snapshot = value !== null && value !== undefined && typeof value === 'object'
          ? value.health
          : undefined;
        if (snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.routes)) {
          setHealth(snapshot);
        }
      } catch {
        // Health is decorative: a failed read leaves the rows without a summary.
      }
    }, [testRoute]);
    React.useEffect(() => {
      void refreshHealth();
    }, [refreshHealth]);
    const aliveRef = React.useRef(true);
    // Every started probe gets a sequence number per row; editing the list, or
    // starting another probe for the same row, advances it so a late response
    // can never be shown beside different values. The controller map lets an
    // edit or unmount abort every in-flight row probe promptly.
    const probeSeqRef = React.useRef(0);
    const probesRef = React.useRef(new Map<number, { seq: number; controller: AbortController }>());
    React.useEffect(() => {
      // Re-arm on setup so a StrictMode effect replay cannot ignore responses.
      aliveRef.current = true;
      return () => {
        aliveRef.current = false;
        for (const probe of probesRef.current.values()) probe.controller.abort();
        probesRef.current.clear();
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
        setRows(rowsFromSettings(next));
        setGroups(result.groups);
        setRevision(result.revision);
        setCatalogError(result.catalogError);
        setLoaded(true);
        setLoading(false);
        // Reloaded values invalidate every earlier probe result.
        resetRowTests();
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
        setRows(rowsFromSettings(next));
        setGroups(result.groups);
        setRevision(result.revision);
        setCatalogError(result.catalogError);
        setLoaded(true);
        setLoading(false);
        // Reloaded values invalidate every earlier probe result.
        resetRowTests();
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

    // The settings list is the single source of truth: row 1 plus its
    // primaryEnabled flag is stored in the top-level fields, rows 2..N plus
    // their enabled flags in `fallbacks`. The implicit session fallback is not
    // a row, so it can never be reordered, removed or persisted.
    const draft = settingsFromRows(rows);
    const dirty = !routesEqual(rows, rowsFromSettings(saved));

    const formBusy = busy || loading;
    const controlsDisabled = formBusy || !loaded;

    const clearOk = () => {
      setStatus((prev) => (prev !== null && prev.kind === 'ok' ? null : prev));
    };

    /**
     * Drop every row probe's authority, abort its request, and clear its state.
     *
     * Called whenever the saved/list values change: a result must never appear
     * beside different route values than the ones the Host actually probed.
     */
    const resetRowTests = (): void => {
      probeSeqRef.current += 1;
      for (const probe of probesRef.current.values()) probe.controller.abort();
      probesRef.current.clear();
      setRowTests({});
    };

    /** Replace the ordered explicit list, clearing stale probe results. */
    const updateRoutes = (makeNext: (previous: ReviewRoute[]) => ReviewRoute[]): void => {
      setRows((previous) => makeNext(previous));
      resetRowTests();
      clearOk();
    };

    const changeRouteProvider = (index: number, provider: string): void => {
      updateRoutes((list) => replaceRoute(list, index, routeAfterProvider(list[index], provider)));
    };

    const changeRouteModel = (index: number, modelId: string): void => {
      updateRoutes((list) => replaceRoute(list, index, routeAfterModel(list[index], modelId, groups)));
    };

    const changeRouteEffort = (index: number, effort: string): void => {
      updateRoutes((list) => replaceRoute(list, index, {
        ...normalizeRoute(list[index]),
        reasoningEffort: effort,
      }));
    };

    const changeRouteEnabled = (index: number, enabled: boolean): void => {
      updateRoutes((list) => replaceRoute(list, index, {
        ...normalizeRoute(list[index]),
        enabled,
      }));
    };

    const discard = () => {
      setRows(rowsFromSettings(saved));
      resetRowTests();
      setStatus(null);
    };

    /**
     * Probe ONE row's current draft values through the mounted Remote endpoint.
     *
     * The row's provider/model/effort are sent as the optional explicit route,
     * so unsaved edits are tested and the Host never falls back to the saved
     * row 1. Each row keeps its own busy/result state and abort controller;
     * editing the list, saving, reloading or unmounting aborts and clears it.
     * The `inherit` effort is sent verbatim: the Host probes it with the
     * route's provider default because the browser cannot know the session's
     * effort. Results are classified text; provider prose is never requested.
     *
     * @param index - row position in the current explicit list.
     */
    /**
     * Run one row's whole test: the liveness probe and the two scripted reviews.
     *
     * Every row owns an independent sequence number, so an edit or a second test
     * retires the previous result instead of letting it appear beside different
     * route values.
     */
    const runRowTest = async (index: number): Promise<void> => {
      const row = rows[index];
      if (row === undefined) return;
      if (formBusy || !loaded || testRoute === undefined) return;
      if (rowTests[index]?.busy === true) return;
      // Defensive: a stale controller for this row belongs to a retired test.
      probesRef.current.get(index)?.controller.abort();
      const sequence = probeSeqRef.current + 1;
      probeSeqRef.current = sequence;
      const controller = new AbortController();
      probesRef.current.set(index, { seq: sequence, controller });
      setRowTests((previous) => ({
        ...previous,
        [index]: {
          busy: true,
          outcome: previous[index]?.outcome ?? null,
          cases: previous[index]?.cases ?? null,
        },
      }));
      const current = (): boolean => (
        aliveRef.current && probesRef.current.get(index)?.seq === sequence
      );
      try {
        const response = await testRoute.testReviewRoute({
          mode: 'full',
          provider: row.provider,
          model: row.model,
          reasoningEffort: row.reasoningEffort,
        }, controller.signal);
        if (!current()) return;
        let outcome: TestOutcome;
        let cases: ReviewRouteTestCase[] | null = null;
        if (response === null || response === undefined || response.ok !== true) {
          outcome = mapTestTransportFailure(
            response === null || response === undefined ? undefined : response.error,
            t,
          );
        } else {
          const value = response.value;
          if (value === null || value === undefined
            || typeof value !== 'object' || typeof value.code !== 'string') {
            outcome = mapTestUnknownResult(t);
          } else {
            outcome = mapTestResult(value, t);
            cases = Array.isArray(value.cases) ? value.cases : null;
          }
        }
        setRowTests((previous) => ({ ...previous, [index]: { busy: false, outcome, cases } }));
        // The test itself is not a review, but re-reading the ledger keeps the
        // measured line in step with whatever happened while the page was open.
        void refreshHealth();
      } catch (error) {
        if (current()) {
          setRowTests((previous) => ({
            ...previous,
            [index]: { busy: false, outcome: mapTestTransportFailure(error, t), cases: null },
          }));
        }
      } finally {
        if (probesRef.current.get(index)?.seq === sequence) {
          probesRef.current.delete(index);
          if (aliveRef.current) {
            setRowTests((previous) => ({
              ...previous,
              [index]: {
                busy: false,
                outcome: previous[index]?.outcome ?? null,
                cases: previous[index]?.cases ?? null,
              },
            }));
          }
        }
      }
    };

    const handleSave = async () => {
      if (busy || loading || !loaded || !dirty) return;
      setBusy(true);
      setStatus(null);
      try {
        const response = await saveReviewerSettings(
          remote,
          NS,
          settingsFromRows(rows),
          revision,
        );
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
          setRows(rowsFromSettings(next));
          setGroups(refreshed.groups);
          setRevision(refreshed.revision);
          setCatalogError(refreshed.catalogError);
          // Saved values changed: every earlier probe result is stale.
          resetRowTests();
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
        setRows(rowsFromSettings(fallback));
        // The saved values moved even though the re-read failed: drop every
        // result that belongs to the previous values.
        resetRowTests();
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

    /**
     * 审查路由表 / ordered review-route table.
     *
     * One real <table> so every provider/model/effort row is aligned: a narrow
     * enable column, flexible provider/model/effort columns, and narrow test and
     * action columns. A row is a single <tr data-route-index>; its test result
     * (and any incomplete hint) is a separate full-width colSpan row, so a long
     * provider name or a result line can never change the columns above.
     */
    const iconButton = (
      label: string,
      text: string,
      disabled: boolean,
      action: string,
      onClick: () => void,
    ): ReactElementLike => React.createElement('button', {
      type: 'button',
      className: 'dsh_arm_iconButton',
      'aria-label': label,
      title: label,
      disabled,
      'data-arm-action': action,
      onClick,
    }, text);

    const renderRoute = (route: ReviewRoute, index: number): ReactElementLike[] => {
      const entryProviderOptions: SelectOption[] = [
        { value: '', label: t('routeProviderPlaceholder') },
      ];
      const entryProviderUnavailable = route.provider !== '' && !groups.some((group) => group.id === route.provider);
      if (entryProviderUnavailable) {
        entryProviderOptions.push({ value: route.provider, label: route.provider + ' ' + t('unavailable') });
      }
      for (const group of groups) entryProviderOptions.push({ value: group.id, label: group.name || group.id });

      const entryModels = modelsFor(groups, route.provider);
      const entrySelectedModel = entryModels.find((model) => model.id === route.model);
      const entryModelOptions = entryModels.map((model) => ({ value: model.id, label: model.name || model.id }));
      if (route.model !== '' && entrySelectedModel === undefined) {
        entryModelOptions.unshift({ value: route.model, label: route.model + ' ' + t('unavailable') });
      }

      const entryEfforts = effortsFor(entrySelectedModel);
      const entryEffortOptions: SelectOption[] = [
        { value: '', label: t('effortDefault') },
        { value: INHERIT_EFFORT, label: t('effortInherit') },
      ];
      for (const effort of entryEfforts) entryEffortOptions.push({ value: effort.id, label: effort.name || effort.id });
      if (
        route.reasoningEffort !== ''
        && route.reasoningEffort !== INHERIT_EFFORT
        && !entryEfforts.some((effort) => effort.id === route.reasoningEffort)
      ) {
        const suffix = catalogError !== ''
          ? t('unverified')
          : (entrySelectedModel !== undefined ? t('notAdvertised') : t('unverified'));
        entryEffortOptions.push({
          value: route.reasoningEffort,
          label: route.reasoningEffort + ' ' + suffix,
        });
      }

      const rowDisabled = controlsDisabled;
      const rowLabel = formatText(t('routeRowLabel'), { index: String(index + 1) });
      const rowTest = rowTests[index];
      const testBusy = rowTest?.busy === true;
      const outcome = rowTest?.outcome ?? null;
      const incomplete = route.provider === '' || route.model === '';

      const mainRow = React.createElement('tr', {
        className: 'dsh_arm_tableRow' + (route.enabled ? '' : ' dsh_arm_rowDisabled'),
        key: 'route:' + String(index),
        'data-route-index': index,
        'aria-label': rowLabel,
      },
        React.createElement('td', { className: 'dsh_arm_cellEnable' },
          React.createElement('input', {
            type: 'checkbox',
            className: 'dsh_arm_tableCheckbox',
            'data-arm-unavailable': entryProviderUnavailable ? 'true' : 'false',
            checked: route.enabled,
            disabled: rowDisabled,
            'aria-label': t('routeEnabled') + ' ' + rowLabel,
            'data-arm-action': 'route-' + String(index) + '-enable',
            onChange: (event: { target: { checked: boolean } }) => {
              changeRouteEnabled(index, event.target.checked);
            },
          }),
        ),
        React.createElement('td', { className: 'dsh_arm_cellSelect' },
          React.createElement(ARMSelect, {
            value: route.provider,
            onChange: (value: string) => changeRouteProvider(index, value),
            placeholder: t('routeProviderPlaceholder'),
            label: t('routeProvider') + ' ' + String(index + 1),
            options: entryProviderOptions,
            disabled: rowDisabled,
            testId: 'route-' + String(index) + '-provider',
          }),
        ),
        React.createElement('td', { className: 'dsh_arm_cellSelect' },
          React.createElement(ARMSelect, {
            value: route.model,
            onChange: (value: string) => changeRouteModel(index, value),
            placeholder: t('routeModelPlaceholder'),
            label: t('routeModel') + ' ' + String(index + 1),
            options: entryModelOptions,
            disabled: rowDisabled || route.provider === '' || entryModels.length === 0,
            testId: 'route-' + String(index) + '-model',
          }),
        ),
        React.createElement('td', { className: 'dsh_arm_cellSelect' },
          React.createElement(ARMSelect, {
            value: route.reasoningEffort,
            onChange: (value: string) => changeRouteEffort(index, value),
            placeholder: t('effortDefault'),
            label: t('routeEffort') + ' ' + String(index + 1),
            options: entryEffortOptions,
            disabled: rowDisabled
              || (route.reasoningEffort === '' && (route.model === '' || entryEfforts.length === 0)),
            testId: 'route-' + String(index) + '-effort',
          }),
        ),
        React.createElement('td', { className: 'dsh_arm_cellWeight' },
          React.createElement('input', {
            type: 'number',
            className: 'dsh_arm_weightInput',
            min: 0,
            max: 9,
            step: 1,
            value: String(route.weight),
            disabled: rowDisabled,
            'aria-label': t('routeWeight') + ' ' + rowLabel,
            'data-arm-action': 'route-' + String(index) + '-weight',
            onChange: (event: { target: { value: string } }) => {
              const parsed = normalizeRouteWeight(event.target.value);
              updateRoutes((list) => list.map((entry, at) => (
                at === index ? { ...entry, weight: parsed } : entry
              )));
            },
          }),
        ),
        React.createElement('td', { className: 'dsh_arm_cellActions' },
          React.createElement('button', {
            type: 'button',
            className: 'dsh_arm_button dsh_arm_buttonSecondary dsh_arm_testButton',
            'data-arm-action': 'route-' + String(index) + '-test',
            disabled: rowDisabled || testRoute === undefined || testBusy,
            'aria-label': t('test') + ' ' + rowLabel,
            onClick: () => {
              void runRowTest(index);
            },
          }, testBusy ? t('testing') : t('test')),
          iconButton(t('routeMoveUp'), '↑', rowDisabled || index === 0, 'route-' + String(index) + '-up', () => {
            updateRoutes((list) => moveRoute(list, index, -1));
          }),
          iconButton(
            t('routeMoveDown'),
            '↓',
            rowDisabled || index >= rows.length - 1,
            'route-' + String(index) + '-down',
            () => updateRoutes((list) => moveRoute(list, index, 1)),
          ),
          iconButton(t('routeRemove'), '✕', rowDisabled, 'route-' + String(index) + '-remove', () => {
            updateRoutes((list) => removeRoute(list, index));
          }),
        ),
      );

      const children: ReactElementLike[] = [mainRow];

      // Measured health is a full-width row under its route row: attempts,
      // successes and mean latency for this week, or an explicit "no reviews
      // yet" instead of a fake 0%.
      if (health !== null) {
        const measured = health.routes.find((entry) => (
          entry.provider === route.provider && entry.model === route.model
        ));
        const healthText = measured === undefined
          ? t('routeHealthEmpty')
          : formatText(t('routeHealthLine'), {
            attempts: String(measured.attempts),
            answered: String(measured.answered),
            avg: String(measured.avgMs),
          }) + (measured.failed > 0 && measured.lastFailureCode !== ''
            ? ' · ' + formatText(t('routeHealthFailed'), { code: measured.lastFailureCode })
            : '');
        children.push(React.createElement('tr', {
          className: 'dsh_arm_routeHealthRow',
          key: 'route-health:' + String(index),
          'data-route-health': index,
        },
          React.createElement('td', {
            className: 'dsh_arm_routeHealthCell',
            colSpan: 6,
          }, healthText),
        ));
      }

      // The result is a full-width row directly under its route row, so a long
      // status/hint never widens or shifts the columns above.
      if (outcome !== null) {
        const feedback: ReactElementLike[] = [
          React.createElement('span', {
            className: 'dsh_arm_routeTestStatus ' + testStatusClass(outcome.tone),
            role: 'status',
            key: 'status',
          }, t('testResultPrefix') + ': ' + outcome.message),
        ];
        if (outcome.hint !== '') {
          feedback.push(React.createElement('span', { className: 'dsh_arm_routeResultHint', key: 'hint' }, outcome.hint));
        }
        if (outcome.note !== '') {
          feedback.push(React.createElement('span', { className: 'dsh_arm_routeResultHint', key: 'note' }, outcome.note));
        }
        if (outcome.detail !== '') {
          feedback.push(React.createElement('span', { className: 'dsh_arm_testDetail', key: 'detail' }, outcome.detail));
        }
        for (const entry of rowTest?.cases ?? []) {
          const label = entry.case === 'allow' ? t('reviewCaseAllow') : t('reviewCaseDeny');
          const verdict = entry.ok ? t('reviewPassed') : t('reviewFailed');
          const actual = entry.actual === '' ? t('reviewNoAnswer') : entry.actual;
          feedback.push(React.createElement('span', {
            className: 'dsh_arm_reviewBadge ' + (entry.ok ? 'dsh_arm_reviewPass' : 'dsh_arm_reviewFail'),
            key: 'case:' + entry.case,
          }, label + ': ' + verdict + ' · ' + actual));
        }
        children.push(React.createElement('tr', {
          className: 'dsh_arm_routeResultRow',
          key: 'route-result:' + String(index),
          'data-route-result': index,
        },
          React.createElement('td', {
            className: 'dsh_arm_routeResultCell',
            colSpan: 6,
          }, feedback),
        ));
      }

      if (incomplete) {
        children.push(React.createElement('tr', {
          className: 'dsh_arm_routeHintRow',
          key: 'route-hint:' + String(index),
        },
          React.createElement('td', {
            className: 'dsh_arm_routeHintCell',
            colSpan: 6,
          }, t('routeIncompleteHint')),
        ));
      }

      return children;
    };

    const routeSection = React.createElement('div', {
      className: 'dsh_arm_routes',
      'data-arm-routes': 'true',
    },
      React.createElement('div', { className: 'dsh_arm_routeHeader' },
        React.createElement('span', { className: 'dsh_arm_label' }, t('reviewRoutesTitle')),
      ),
      React.createElement('p', { className: 'dsh_arm_hint' }, t('reviewRoutesHint')),
      testRoute === undefined
        ? React.createElement('p', { className: 'dsh_arm_hint' }, t('testUnavailableHint'))
        : null,
      React.createElement('div', { className: 'dsh_arm_tableWrap' },
        React.createElement('table', {
          className: 'dsh_arm_table',
          'data-arm-table': 'true',
          'aria-label': t('routeTableLabel'),
        },
          React.createElement('colgroup', null,
            React.createElement('col', { className: 'dsh_arm_colEnable', key: 'enable' }),
            React.createElement('col', { className: 'dsh_arm_colProvider', key: 'provider' }),
            React.createElement('col', { className: 'dsh_arm_colModel', key: 'model' }),
            React.createElement('col', { className: 'dsh_arm_colEffort', key: 'effort' }),
            React.createElement('col', { className: 'dsh_arm_colWeight', key: 'weight' }),
            React.createElement('col', { className: 'dsh_arm_colActions', key: 'actions' }),
          ),
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', { scope: 'col', className: 'dsh_arm_thEnable' }, t('routeEnabled')),
              React.createElement('th', { scope: 'col' }, t('routeProvider')),
              React.createElement('th', { scope: 'col' }, t('routeModel')),
              React.createElement('th', { scope: 'col' }, t('routeEffort')),
              React.createElement('th', { scope: 'col', className: 'dsh_arm_thWeight' }, t('routeWeight')),
              React.createElement('th', { scope: 'col' }, t('routeActions')),
            ),
          ),
          React.createElement('tbody', null,
            rows.length === 0
              ? React.createElement('tr', { className: 'dsh_arm_tableEmptyRow', key: 'empty' },
                React.createElement('td', { colSpan: 6 }, t('reviewRoutesEmpty')),
              )
              : null,
            rows.flatMap((route, index) => renderRoute(route, index)),
          ),
        ),
      ),
      React.createElement('div', { className: 'dsh_arm_actions' },
        React.createElement('button', {
          type: 'button',
          className: 'dsh_arm_button dsh_arm_buttonSecondary',
          'data-arm-action': 'route-add',
          disabled: controlsDisabled || rows.length >= MAX_ROUTES,
          onClick: () => updateRoutes((list) => addRoute(list)),
        }, t('routeAdd')),
      ),
      rows.length >= MAX_ROUTES
        ? React.createElement('p', { className: 'dsh_arm_hint' }, t('routeCapHint'))
        : null,
    );

    return React.createElement('section', {
      className: 'dsh_arm_section',
      'aria-busy': formBusy,
      'data-auto-review-model': 'true',
    },
      React.createElement('h2', { className: 'dsh_arm_title' }, t('title')),
      React.createElement('p', { className: 'dsh_arm_subtitle' }, t('subtitle')),
      routeSection,

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
    isLegacySessionEntry,
    normalizeRoute,
    normalizeRoutes,
    storedFallback,
    rowsFromSettings,
    settingsFromRows,
    routesEqual,
    routeAfterProvider,
    routeAfterModel,
    replaceRoute,
    addRoute,
    removeRoute,
    moveRoute,
    reconcileDraft,
    MAX_ROUTES,
    summaryLine,
    loadReviewerSettings,
    saveReviewerSettings,
    INHERIT_EFFORT,
    // Per-row probe result helpers (localized text composition only; no prose path).
    formatText,
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
