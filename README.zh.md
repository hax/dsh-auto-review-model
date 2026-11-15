# @aghost-prj/dsh-auto-review-model

为 DSH 的 **自动授权审查（Auto review）** 单独选择 provider / model / reasoningEffort，而不改变主对话使用的模型。

> 实验功能。本插件只改写 Auto review 发出的审查请求，不改变审查策略、风险分级或审批行为。

## 用途

DSH 的 Auto review 在每次受支持的工具调用执行前，用当前会话的 provider 与 model 审查该调用，再决定放行、拒绝或转人工审批。默认情况下，审查使用与主对话相同的模型。

本插件在 LLM 请求层识别 Auto review 的审查请求，并把其中的 provider、model 与 reasoningEffort 替换为你在设置页配置的值。典型用途：

- 用更快、更便宜的模型做常规审查，降低延迟与 token 成本；
- 用更强的模型做审查，同时让主对话继续使用轻量模型；
- 为审查固定一个模型，避免会话切换模型时审查行为随之波动。

普通对话、subagent、标题生成、上下文压缩等其它 LLM 请求不受影响。

## 工作原理

- **请求识别**：宿主侧插件监听 `llm/stream`，只精准匹配 `system` 提示词以 `REVIEW_POLICY\n` 开头且包含固定 reviewer marker 句子（`You are the final authorization reviewer for exactly one pending tool call.`）的自动审查请求。
- **路由改写**：当开启 `enabled` 且 `provider` 与 `model` 成对非空时，复制冻结的请求对象并改写其 `provider`、`model` 与 `reasoningEffort`；审查提示词、风险分级与判定策略保持原样不变。
- **思考等级能力查询**：在传递配置的 `reasoningEffort` 前，插件通过 `resolveModelInfo` 查询该路由的能力，并将审查请求的 `AbortSignal` 与 300000ms（5 分钟）超时组合后传入。只有当目标模型声明支持该等级时才传递；若查询成功但未声明该等级，则不显式传递并回退到 provider 默认值。若查询失败或超时，审查会以包含实际 route、超时时间和修复建议的可操作错误直接失败（fail-closed），不会把失败当成“不支持”，也不会静默降级。
- **缓存失效**：仅缓存成功的能力查询结果，按路由进行内存缓存，并采用 generation / epoch 计数机制，防止在缓存失效前在途的查询结果以过时数据错误写回。失败或超时的查询不会被缓存，下一次审查会重新查询。宿主侧监听 `loader/volatile-update` 时使用 `global: true`，以确保能够可靠接收到 provider 的局部配置变更通知；当收到 `llm/adapters-updated` 或 `loader/volatile-update` 事件时，缓存会及时失效。
- **Fail-closed 安全机制**：若配置的模型不存在、网络不可达或审查执行失败，工具调用按审查失败处理，不会执行（fail-closed）。
- **已保存路由测试端点**：同一宿主插件还提供一个小的 Typert Remote 方法 `autoReviewModel/testReviewRoute`，由手写的 generated-style `./typert` manifest 声明，浏览器侧从本包 `./remote` contribution 挂载。设置页提供「测试审查路由」操作，用固定无害 prompt 探测已保存的 provider/model/推理等级。宿主自己读取已保存设置，因此页面不传 route、不传凭证、不传 session id、不传 purpose、不传 tools、不传对话历史。探测有界（16 输出 token、20 秒总超时、每分钟 5 次、同一时刻 1 次），不写设置、不改主模型、不执行工具、不返回模型输出。

## 安装

```sh
# 从 npm 官方仓库安装（发布后）：
dsh plugin --profile web add @aghost-prj/dsh-auto-review-model

# 或在本地开发调试阶段从本地路径安装：
dsh plugin --profile web add /home/aghost/workspace/dsh-auto-approval-model-fix
```

该命令把包作为依赖与 bundle 层加入 `web` profile。DSH loader 通过包内的 `dsh.bundle.patch` 读取 `cordis.patch.yml`，把插件插入为 `auto-review-model` 层。

安装插件或重新构建客户端后，需要按 DSH 常规方式重新加载 Web profile 并刷新页面，配置页才会出现。保存设置本身对下一次审查生效，不需要重启会话。

宿主侧接口由 Typert Loader 从包的 `./typert` export 自动发现；因此请在启动 DSH 前完成安装或升级，或在包文件变化后重启 DSH，以便注册新的 export。设置页加载时浏览器侧会自动挂载 `./remote` contribution。

## 配置

配置入口：**设置 → 插件 → 自动授权审查**。

“**自动审查模型**”配置区渲染在该 bundle 详情页的“**描述**”与“**包含的组件**”之间。它由客户端（浏览器侧）代码通过 `plugins.bundle.config` 槽位注册，注册 key 为 `@deepseek-ai/dsh-experimental-auto-review`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 插件总开关。关闭后自动审查沿用当前会话的模型与推理等级。 |
| `provider` | string | 空 | 审查请求使用的 provider ID。留空表示继承当前会话模型。必须与 `model` 同时填写才会启用覆盖。 |
| `model` | string | 空 | 审查请求使用的 model ID。必须与 `provider` 同时填写才会启用覆盖。 |
| `reasoningEffort` | string | 空 | 审查请求的思考等级，仅在覆盖生效时应用；留空表示不显式传递，回退到 provider 默认值。 |

### 配置规则

- `provider` 与 `model` 必须成对填写且均非空，同时 `enabled` 为开启状态，才会覆盖审查模型。
- `provider` 留空表示继承当前会话模型。
- 只填写其中一个字段不会半生效，而是整体回退为原生行为（沿用当前会话的 provider 与 model）。特别地，当 `provider` 非空而 `model` 为空时，宿主路由按既有规则整体 fallback 到会话模型，同时客户端 UI 会明确提示未启用覆盖。
- `reasoningEffort` 为可选字段。留空表示不显式传递；只有目标模型声明支持该等级时才会传递，查询成功但未声明该等级时回退到 provider 默认值。能力查询失败或超时时，审查会以可操作错误直接失败（包含实际 route、300000ms（5 分钟）超时与修复建议），不会静默回退到默认等级。
- 在配置界面中，若既有配置包含未知或当前模型未声明的 `reasoningEffort`，客户端会如实保留并明确显示，不伪装成默认值，并允许用户显式清除。
- **生效时机：保存设置后立即对下一次审查生效。** 已经在进行中的审查不会被改写；不需要重启会话或重新加载 profile。

### 测试已保存的审查路由

配置面板提供「测试审查路由」（Test saved route）。它始终测试当前**已保存**的路由——提示文本会写明该路由——因此表单里未保存的修改不会被测试，有 dirty 草稿时也不会被误认为探测所用的路由。探测有独立的进行中/结果状态，不复用「保存中」的 busy 状态。

探测固定发送一次无害请求（一条固定 user 消息、固定单词级 system 指令、`temperature: 0`、`maxTokens: 16`），总超时 20 秒，并在宿主侧限流（同一时刻最多 1 次、每 60 秒最多 5 次、最小间隔 3 秒）。请求不携带 `sessionId`、不携带 `purpose`（尤其不是 `auto-review`）、不携带 tools、不携带对话历史；不读取浏览器凭证、不保存设置、不修改主模型、不执行工具、不上传 Session log。

结果会被分类，并渲染为本地化消息与可操作修复建议。DeepSeek Account 的登录 / 授权 / 连接问题与 API-key 的 `MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`AUTH` 分开；`NO_ADAPTER`、超时、provider 速率限制、配额、路由不完整/已关闭、并发探测、空补全与未知失败各有独立结果。界面只展示分类元数据与一段简短脱敏诊断，模型的回答文本不会返回浏览器。

### 示例

假设你的 DSH 环境（如 `cordis.patch.yml`）中配置了以下 provider，可以直接在配置下拉框中选择：

- `glm-coding` / `glm-5.3-flashx`：延迟较低的审查模型；
- `codex-proxy` / `gemini-3.8-flash-high`：能力更强的审查模型。

以上仅为环境示例，实际可选列表取决于你的 DSH 配置。`reasoningEffort` 的合法值由目标模型决定（例如 `low`、`medium`、`high`、`xhigh`）；如果能力查询成功但所选模型未声明该等级，插件会忽略它并使用 provider 默认值，而不是把不受支持的值发给模型。能力查询失败或超时则不同：审查会以可操作错误直接失败（fail-closed），不会回退到 provider 默认值。

## 限制

- **只重写 Auto review 的审查请求。** 不改写主对话、subagent、标题生成、上下文压缩等其它请求，也不改变主会话模型。
- **需要启用本插件。** `enabled` 必须为开启状态，且插件层已被 DSH profile 正确加载。
- **需要 Auto review 权限模式。** 只有会话处于自动授权审查模式时才会产生审查请求；本插件不能替代 Auto review 本身。
- **provider / model 必须已在 DSH 配置中存在。** 填错或模型不可用时，审查请求会失败；工具调用按审查失败处理，不会执行（fail-closed）。
- **思考等级由目标模型决定。** 只有在目标模型明确声明了该等级时才会传递；查询成功但未声明时回退到 provider 默认值。若能力查询失败或超过 300000ms（5 分钟）超时，审查会以可操作错误直接失败（fail-closed），而不是静默降级到默认等级。
- **客户端代码变化后需要刷新页面。** 配置界面由 `client/client.js` 提供；安装插件或修改客户端代码后必须重新加载 Web profile 并刷新 Web 页面，保存设置本身则直接对下一次审查生效。
- **实验功能。** 自动审查可能误放行不安全操作或误拒绝正常操作，也会消耗额外 token。选择审查模型不能消除 Auto review 本身的安全风险，请仍然谨慎使用。
- **不改变审查策略。** 固定的审查提示词、风险分级和放行/拒绝/转人工的判定逻辑仍完全由 DSH Auto review 决定。

## 验证状态

截至 2026-11-16，已保存路由测试功能通过以下自动化证据验证：
- **自动化命令**：`npm run typecheck`、`npm test`、`npm run check` 与 `npm run verify` 退出码均为 0。
- **测试**：129 项单元测试全部通过（0 失败）：host 33、route-test 36、client 25、client-component 19、Typert contract/产物 9、packaging 7。
- **静态校验**：`npm run verify` 25/25 项通过，覆盖 exports、Loader 可接受的 `./typert` manifest、Host/Client descriptor 一致性、`./remote` 内嵌与 `$mount` 接线、手写 Typert 产物零运行时依赖，以及所有入口的语法。Desktop 环境下，已安装 experimental-auto-review 策略检查通过 `DSH_NODE_EXECUTABLE` 读取运行中的 `app.asar`；若存在 `DSH_INSTALL_DIR` 但无法读取官方源码，检查会失败而不是静默跳过。只有没有已安装 DSH 包树的源码检出环境才允许报告 SKIP。
- **已断言的安全不变量**：探测请求只包含 provider/model/[reasoningEffort]/固定 prompt/maxTokens/temperature/signal（绝不含 `sessionId`、`purpose`、`tools`、`toolHistory` 或对话历史）；不写设置；不返回模型输出、凭证材料或任意传输错误文本；Account 与 API-key 故障分类可区分；限流、single-flight、有界超时、有界输出，以及已保存路由变化后的过期结果失效均有覆盖。

**验证边界与未验证事项**：
- **未调用真实模型**：自动化测试均采用内存 fake adapter，未调用真实 LLM API 或网络，也未对真实已保存路由（例如 `deepseek-account/deepseek-flash`）发起探测。
- **未做浏览器视觉验证**：本环境没有浏览器控制能力，因此按钮的实际渲染位置、可发现性、明暗主题外观与实时结果渲染尚未经过视觉验证。已执行一次只读 UI/UX 源码审查；其中证据充分的问题（过期结果失效、仅数据诊断、live region 范围、限流文案）已修复并复测，但浏览器验证仍然不可用。
- **真实 Gateway 分发未验证**：单元测试只在本地验证已发布端点，未覆盖「已安装 Typert Loader + Gateway RPC」链路；该端到端链路需要在运行中的 DSH 会话里完成安装验证（task-4）。

## 开发

本项目源码、单元测试与校验脚本全部采用 TypeScript：

- `src/`：宿主与客户端 TypeScript 源码；
- `lib/` 与 `client/client.js`：`tsc` 构建产物（禁止手动修改）；
- `tests/`：TypeScript 单元测试（编译至 `.build/tests/`）；
- `scripts/verify.ts`：TypeScript 静态校验脚本（编译至 `.build/scripts/verify.js`）。

本机 Node 环境不直接运行 TypeScript 文件，测试与校验均由 `tsc` 编译后通过 `node --test` 或 `node` 执行。`node_modules/` 与 `.npm-cache/` 已加入 `.gitignore`。

### 依赖与符号链接

开发依赖包含 `typescript`（5.7.3）与 `@types/node`。在离线或本地测试环境下，依赖项（如 `@deepseek-ai/schemastery` 和 `@types/node`）可通过软链接关联至宿主 DSH 安装路径（请根据实际机器环境调整路径）：

```sh
mkdir -p node_modules/@deepseek-ai node_modules/@types
ln -sfn /path/to/dsh/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
ln -sfn /path/to/dsh/node_modules/@types/node node_modules/@types/node
npm install
```

### 常用命令

```sh
npm run build        # 构建宿主 (src/ -> lib/)、客户端 (src/client/ -> client/)，并把共享 Typert contract 内嵌进 client/client.js (scripts/build-client.cjs)
npm run build:tests  # 编译测试与脚本 (tests/*.test.ts, scripts/verify.ts -> .build/)
npm run typecheck    # 对源码、客户端及测试执行全量 TypeScript 类型检查
npm run check        # 对构建出的 JS 产物执行 node --check 语法校验
npm test             # 编译并运行单元测试 (node --test .build/tests/*.test.js)
npm run verify       # 编译并运行静态校验脚本 (node .build/scripts/verify.js)
```

### 目录结构

- `src/index.ts`、`src/policy.ts`：宿主插件、配置 schema 与审查请求拦截；
- `src/route-test.ts`：宿主「已保存路由测试」端点（限流、错误分类、结果构造）；
- `src/typert.contract.ts`：两个 generated-style 面共享的零依赖 Typert 契约；
- `src/typert.host.ts`、`src/typert.remote-client.ts`：`./typert` 与 `./remote` 产物入口；
- `scripts/build-client.cjs`：把契约内嵌进浏览器 bundle 并注册 `./remote` chunk；
- `src/client/client.ts`：Web 配置面板客户端源码，含已保存路由测试操作；
- `tests/*.test.ts`：单元测试源码；
- `scripts/verify.ts`：静态与冒烟校验脚本源码；
- `lib/`、`client/client.js`：编译分发产物（请勿手改）；
- `.build/`：测试与校验脚本的编译输出目录；
- `cordis.patch.yml`：bundle 层插入声明；
- `tsconfig*.json`：TypeScript 编译配置文件。
