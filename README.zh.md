# @aghost-prj/dsh-auto-review-model

为 DSH 的 **自动授权审查（Auto review）** 单独选择 provider / model / reasoningEffort，而不改变主对话使用的模型。

> 实验功能。本插件只改写 Auto review 发出的审查请求，不改变审查策略、风险分级或审批行为。

## 用途

DSH 的 Auto review 在每次受支持的工具调用执行前，用当前会话的 provider 与 model 审查该调用，再决定放行、拒绝或转人工审批。默认情况下，审查使用与主对话相同的模型。

本插件在 LLM 请求层识别 Auto review 的审查请求，并把其中的 provider、model 与 reasoningEffort 替换为你在设置页配置的值。典型用途：

- 用更快、更便宜的模型做常规审查，降低延迟与 token 成本；
- 用更强的模型做审查，同时让主对话继续使用轻量模型；
- 为审查固定一个模型，避免会话切换模型时审查行为随之波动；
- 某个账号余额不足时审查仍可完成：按顺序配置多个审查模型，当前会话模型始终作为隐式最终兜底。

普通对话、subagent、标题生成、上下文压缩等其它 LLM 请求不受影响。

## 工作原理

- **请求识别**：宿主侧插件监听 `llm/stream`，只精准匹配 `system` 提示词以 `REVIEW_POLICY\n` 开头且包含固定 reviewer marker 句子（`You are the final authorization reviewer for exactly one pending tool call.`）的自动审查请求。
- **路由改写**：插件始终生效，没有总开关。按一份有序列表构造确定性的尝试计划——`provider`/`model` 成对非空且 `primaryEnabled` 为真时作为第 1 行，随后按顺序尝试 `fallbacks` 数组中每一项已启用的路由（第 2..N 行），最后总是追加被拦截审查请求自带的 provider/model 作为隐式兜底。每次尝试都复制冻结的请求对象并改写其 `provider`、`model` 与 `reasoningEffort`；审查提示词、风险分级与判定策略保持原样不变。
- **逐行启用**：每行都有启用标记（第 1 行是 `primaryEnabled`，每个备选是 `enabled`）。禁用的行仍会保存、仍可编辑，但在构造尝试计划时被跳过；若所有行都被禁用或为空，计划为空，插件完全不改写请求。
- **思考等级能力查询**：在传递配置的 `reasoningEffort` 前，插件通过 `resolveModelInfo` 查询该路由的能力，并将审查请求的 `AbortSignal` 与 300000ms（5 分钟）超时组合后传入。只有当目标模型声明支持该等级时才传递；若查询成功但未声明该等级，则不显式传递并回退到 provider 默认值。若查询失败或超时，该路由按“路由失败”处理：记录包含实际 route、超时时间和修复建议的可操作错误，然后尝试下一条已启用路由（最后是隐式会话路由）；只有全部路由失败时，该错误才会出现在聚合错误里。它不会被当成“不支持”，也不会静默降级到默认等级。
- **缓存失效**：仅缓存成功的能力查询结果，按路由进行内存缓存，并采用 generation / epoch 计数机制，防止在缓存失效前在途的查询结果以过时数据错误写回。失败或超时的查询不会被缓存，下一次审查会重新查询。宿主侧监听 `loader/volatile-update` 时使用 `global: true`，以确保能够可靠接收到 provider 的局部配置变更通知；当收到 `llm/adapters-updated` 或 `loader/volatile-update` 事件时，缓存会及时失效。
- **有序路由与隐式会话兜底**：只有“路由不可用”类失败才会切换到下一条：能力查询失败/超时、provider 流抛错，或终止 `finish` 的官方失败码属于配额、认证、凭据、限流、服务端、超时、传输、适配器或模型路由类失败。调用方 abort 原样传播；内容/协议失败直接失败、不重试。当前会话模型（即被拦截请求自带的 provider/model）始终是最后一次尝试：它不可配置、不可调整顺序、不会被保存，也不强制推理等级；请求没有可用路由时不会追加，若已有显式路由使用相同 provider+model 则不会重复追加。没有可用显式路由（列表为空）时插件完全不改写审查请求，直接由会话模型完成审查。旧配置中的 `{ mode: 'session' }` 项会被忽略，因为该兜底已改为隐式。chunk 会立即转发给调用方；fallback 以“首个已发出的 chunk”为提交点：在此之前失败会尝试下一条路由，一旦已有输出，后续失败会直接报错而不再重试，从而避免调用方的“单决策”流混入两条路由的输出。全部路由（含隐式会话兜底）在产生任何输出前都失败时，以一个聚合错误列出每条尝试过的路由、失败码与原始 provider 消息（逐字保留）。
- **Fail-closed 安全机制**：当所有已配置路由与隐式会话路由都失败（含重试/回退之后）时，审查失败，工具调用不会执行（fail-closed）。
- **思考等级：继承与适配**：每行的思考等级可选 provider 默认（空）、适配器声明的显式等级，或“继承主会话”（存储哨兵 `inherit`）。审查时，`inherit` 通过 `session.requestHeader()?.config.reasoningEffort` 读取被拦截请求所属会话的当前等级；没有会话或没有等级时回退到 provider 默认。继承到的具体等级会适配目标路由声明的等级（按规范 rank 取最近，距离相同偏向更高 rank；目标没有可排名等级则回退 provider 默认）。显式等级不做适配：只有目标声明支持时才发送，否则不发送。最后的隐式会话尝试始终不携带思考等级。
- **逐行测试端点**：同一宿主插件还提供一个小的 Typert Remote 方法 `autoReviewModel/testReviewRoute`，由手写的 generated-style `./typert` manifest 声明，浏览器侧从本包 `./remote` contribution 挂载。每个路由行都有独立的「测试」按钮，通过可选显式路由入参探测该行**当前**的值（包括未保存修改）；省略入参或 provider+model 为空时仍探测已保存的第 1 行。对显式路由，宿主要求 provider 与 model 均非空、provider 存在于实时 configurable-provider 目录，并用 `resolveModelInfo` 证明模型可用后才发起流式请求。页面无法传入 URL、凭证、session id、purpose、tools 或对话历史。探测有界（16 输出 token、20 秒总超时、每分钟 5 次、同一时刻 1 次），不写设置、不改主模型、不执行工具、不返回模型输出。若流结束但没有任何真实模型内容（只有结构块，包括空 text block），结果为 `EMPTY_RESPONSE`，不会报告成功。

## 安装

```sh
# 从 npm 官方仓库安装（发布后）：
dsh plugin --profile web add @aghost-prj/dsh-auto-review-model

# 或在本地开发调试阶段从本地路径安装：
dsh plugin --profile web add /path/to/dsh-auto-review-model
```

该命令把包作为依赖与 bundle 层加入 `web` profile。DSH loader 通过包内的 `dsh.bundle.patch` 读取 `cordis.patch.yml`，把插件插入为 `auto-review-model` 层。

安装插件或重新构建客户端后，需要按 DSH 常规方式重新加载 Web profile 并刷新页面，配置页才会出现。保存设置本身对下一次审查生效，不需要重启会话。

宿主侧接口由 Typert Loader 从包的 `./typert` export 自动发现；因此请在启动 DSH 前完成安装或升级，或在包文件变化后重启 DSH，以便注册新的 export。设置页加载时浏览器侧会自动挂载 `./remote` contribution。

## 配置

配置入口：**设置 → 插件 → 自动授权审查**。

“**自动审查模型**”配置区渲染在该 bundle 详情页的“**描述**”与“**包含的组件**”之间。它由客户端（浏览器侧）代码通过 `plugins.bundle.config` 槽位注册，注册 key 为 `@deepseek-ai/dsh-experimental-auto-review`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | **已弃用且被忽略。** 插件始终生效；该字段仅为让旧版本写出的配置继续通过校验而保留。 |
| `primaryEnabled` | boolean | `true` | 第 1 行（顶层路由）是否参与审查。禁用的行仍保存、仍可编辑，但会被跳过。 |
| `provider` | string | 空 | 审查请求使用的 provider ID（设置列表第 1 行）。留空表示该行被跳过，审查继续使用后续行并最终回落到当前会话模型。必须与 `model` 同时填写才是可用路由。 |
| `model` | string | 空 | 审查请求使用的 model ID。必须与 `provider` 同时填写该行才可用。 |
| `reasoningEffort` | string | 空 | 第 1 行的思考等级。留空表示 provider 默认；`inherit` 表示继承主会话当前等级并适配到目标路由。 |
| `fallbacks` | array | `[]` | 第 1 行之后按顺序尝试的显式路由。每项是 `{ enabled?, provider, model, reasoningEffort? }`；禁用项被跳过，`mode` 字段仅用于让旧配置中的 `{ mode: 'session' }` 项被忽略而不是被误当成显式路由。被拦截请求自带的模型始终是隐式最后一次尝试，不保存在这里。volatile 字段，保存后对下一次审查立即生效；缺省值表示没有额外路由（旧行为）。 |

### 配置规则

- **没有总开关。** `enabled` 已弃用并被忽略；旧配置中的 `enabled: false` 在升级后直接生效。如需排除某条路由，请使用该行的启用复选框。
- `provider` 与 `model` 必须成对填写且均非空，同时该行处于启用状态，才会被尝试。
- `provider` 留空表示第 1 行不可用，仍会尝试已启用的后续路由，并且隐式会话兜底始终在最后。
- 只填写其中一个字段不会半生效。特别地，当 `provider` 非空而 `model` 为空时，该行会被跳过（不会混用两条路由），设置页会把该行标记为“会被跳过”，审查继续使用后续行与隐式会话兜底。
- `reasoningEffort` 为可选字段。留空表示不显式传递；`inherit` 读取主会话当前等级并适配到该路由；具体的显式值只有在目标模型声明支持时才传递，查询成功但未声明时回退到 provider 默认值。能力查询失败或超时时，该路由会被跳过并记录可操作错误（实际 route、300000ms / 5 分钟超时与修复建议），审查继续尝试下一条已启用路由（最后是隐式会话路由）；只有全部路由失败时才会暴露该错误，绝不静默回退到默认等级。
- 在配置界面中，若既有配置包含未知或当前模型未声明的 `reasoningEffort`，客户端会如实保留并明确显示，不伪装成默认值，并允许用户显式清除。
- `fallbacks` 可选，默认 `[]`。设置页只显示**一个有序列表**：第 1 行绑定 `primaryEnabled`/`provider`/`model`/`reasoningEffort`，第 2..N 行绑定该数组并带逐行 `enabled`，因此没有引入新的路由数组。顺序有语义：先尝试第 1 行，再按数组顺序逐条尝试已启用项，最后是隐式会话路由。设置页最多编辑 10 条显式路由；宿主最多调度 10 条 `fallbacks`。
- **当前会话模型始终是隐式最终兜底**：它不是列表中的一行，不能新增/删除/排序，也不会被保存。运行时它取**被拦截审查请求自带**的 `provider`/`model`（会话当时的模型），不是插件侧“当前模型”的快照，也不强加推理等级；请求本身没有可用路由时不会追加，若显式路由已使用相同 provider+model 也不会重复追加。
- **空列表即原生行为**：没有任何可用显式路由时插件不改写审查请求，完全由会话模型处理。
- **旧 `{ mode: 'session' }` 项会被忽略**：旧配置可能仍保留该项，但会话兜底已改为隐式，因此它不会被当作已配置路由；设置页下次保存时会把它去掉。
- 不完整的显式路由项（缺 `provider` 或 `model`）会被安全跳过，不会半生效；设置页会提示该项将被跳过。
- **生效时机：保存设置后立即对下一次审查生效。** 已经在进行中的审查不会被改写；不需要重启会话或重新加载 profile。

### 审查路由与失败分类

配置面板只提供**一个有序的“审查路由”表格**、一个区域级流式捕获下拉框，没有总开关。它是放在横向滚动容器里的真实 `<table>`，列宽固定：**启用**、**提供商**、**模型**、**推理等级**、**测试**、**操作**，因此很长的 provider/model 名称也不会把后续行挤得错位。每个 `tr[data-route-index]` 就是一条路由：居中的启用复选框、三个选择器、紧凑的测试按钮，以及 ↑ / ↓ / ✕ 操作。测试结果（以及不完整行提示）是紧贴该行下方的独立整行 `colSpan` 行，因此再长的状态或提示也不会改变上方列宽。行前面不显示 `#n` 序号——垂直顺序就是 fallback 顺序，上移/下移负责排序；每行带有基于位置的辅助名称（“审查路由 1”……）和稳定的 `data-route-index` 测试标记。禁用的行会弱化显示，但仍可编辑、可测试。窄视口下容器横向滚动，表格保持合理的最小宽度。隐式会话兜底不是一行、也没有任何 UI 控件：区域说明会写明全部启用路由失败后自动回退到主会话模型，若仍失败则审查失败、工具调用不会执行。

只有“路由不可用”类失败才会切换到下一条路由：

| 观察到的失败 | 是否 fallback |
| --- | --- |
| `resolveModelInfo` 能力查询失败或超过 300000ms（5 分钟）超时 | 是（该路由无法提供审查） |
| `ctx.llm.stream` 同步抛出或迭代中抛出 | 无分类信息的抛错、或可重试的官方错误码：是；带不可重试官方错误码：直接失败 |
| 终止 `finish` 的 `reason.kind === 'error'`，且官方错误码属于：`ACCOUNT_QUOTA`、`QUOTA`、`AUTH`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`NO_CREDENTIAL_STORE`、`ACCOUNT_SIGN_IN_REQUIRED`、`ACCOUNT_TOKEN_INVALID`、`RATE_LIMIT`、`SERVER`、`TRANSPORT`、`STREAM_CLOSED`、`TIMEOUT`、`DISCOVERY_FAILED`、`DISCOVERY_UNSUPPORTED`、`NO_DISCOVERY`、`NO_ADAPTER`、`INVALID_ADAPTER`、`DUPLICATE_ADAPTER`、`UNKNOWN_MODEL`、`MODEL_UNSUPPORTED`、`INVALID_CONFIG`、`INVALID_CATALOG`、`INVALID_MODEL_INFO`，或 HTTP 401/402/403/404/408/429/5xx | 是 |
| 流在终止 `finish` 之前结束 | 是（传输失败，`STREAM_CLOSED`） |
| 调用方 abort（`options.signal.aborted`） | **否**——原样传播，绝不重试 |
| 内容/协议失败（`INVALID_REQUEST`、`MALFORMED_RESPONSE`、`CONTEXT_WINDOW_EXCEEDED`、`UNSUPPORTED_*`、`EMPTY_RESPONSE`、`UNKNOWN`，或适配器侧 `aborted` finish） | **否**——直接失败，不被下一条路由掩盖 |

chunk 会在到达时立即转发给调用方，因此 reasoning 较重的审查可以一直流式输出到 provider 允许的范围。fallback 规则是一个提交点：只有在首个 chunk 发出之前才能替换路由；一旦调用方已经收到任何输出，后续失败会以可操作错误直接暴露，而不是重试，因为切换路由会重复或混合输出。该流就是调用方的“单决策”流，因此成功路由的 chunk 恰好 yield 一次。当所有已配置路由与隐式会话路由都在产生任何输出前失败时，审查以一个聚合错误失败，按顺序列出每条尝试过的 `provider/model`（最后的隐式会话尝试带 `(session)` 标记）、失败码与原始 provider 消息（逐字保留，例如 `deepseek-account/deepseek-flash: QUOTA: <provider message>`），与 official Auto review 自身的行为一致。插件自身不会向消息中添加凭证或请求正文，只呈现它收到的 provider 文本。official 插件会把它包成 `Auto review of tool "<name>" failed; its body was not executed: <reason>`，因此不会伪造 allow/deny。

### 测试某条审查路由

每个路由行都有独立的「测试」按钮。，通过端点的可选显式路由入参探测**该行当前**的值（包括未保存修改；dirty 行也可测试），结果以行内状态展示。每行有独立的进行中状态，因此一行探测不会覆盖另一行的结果，也不复用「保存中」的 busy 状态。禁用或不完整的行同样可以测试，便于在启用前验证路由。

探测入参只包含 `provider`、`model` 与 `reasoningEffort`。对显式路由，宿主会校验：两个 id 均非空、provider 存在于实时 configurable-provider 目录、`resolveModelInfo(provider, model)` 成功；否则直接返回 `ROUTE_INCOMPLETE`、`NO_ADAPTER` 或 `UNKNOWN_MODEL`，不发起任何 provider 请求。浏览器不能传入 URL、凭证、session id、purpose、tools 或对话历史。省略入参（或 provider+model 为空）保持原有行为，探测已保存的第 1 行。由于浏览器无法解析会话等级，思考等级为“继承主会话”的行在测试时按该路由的 provider 默认等级发送，结果中的 `effortUsed` 为 `""`，界面文案也会说明。**隐式会话兜底本身不会被探测。**

探测固定发送一次无害请求（一条固定 user 消息、固定单词级 system 指令、`temperature: 0`、`maxTokens: 16`），总超时 20 秒，并在宿主侧限流（同一时刻最多 1 次、每 60 秒最多 5 次、最小间隔 3 秒）。请求不携带 `sessionId`、不携带 `purpose`（尤其不是 `auto-review`）、不携带 tools、不携带对话历史；不读取浏览器凭证、不保存设置、不修改主模型、不执行工具、不上传 Session log。

结果会被分类，并渲染为本地化消息与可操作修复建议。DeepSeek Account 的登录 / 授权 / 连接问题与 API-key 的 `MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`AUTH` 分开；`NO_ADAPTER`、超时、provider 速率限制、配额、路由不完整/已关闭、并发探测、空补全与未知失败各有独立结果。界面只展示分类元数据与一段简短分类诊断，模型的回答文本不会返回浏览器。

### 继承等级的适配规则

某行保存 `inherit` 时，宿主读取主会话当前等级，并按规范 rank 映射到目标路由已声明的等级（`off`/`none`/`minimal` = 0，`low` = 1，`medium` = 2，`high` = 3，`xhigh` = 4，`max` = 5）。距离最近者胜出；距离相同时**偏向更高的 rank**；恰好公告同一等级时原样使用。目标没有任何可排名等级、会话不存在/无等级、或继承值没有规范 rank 时，都回退到 provider 默认（不发送）。

| 会话继承等级 | 目标路由公告等级 | 实际发送 |
| --- | --- | --- |
| `high` | `low`、`high` | `high`（精确匹配） |
| `xhigh` | `max` | `max`（最近的高一档） |
| `off` | `low`、`high` | `low`（最近的低端） |
| `max` | `low`、`high` | `high`（最近的高端） |
| `medium` | `low`、`high` | `high`（距离相同，偏向更高） |
| 任意 | 无可排名等级 | provider 默认（不发送） |
| 无 / 会话缺失 | — | provider 默认（不发送） |

显式（非 `inherit`）等级保持严格行为：只有目标公告支持时才发送，否则不发送——绝不改编。最后的隐式会话尝试始终使用 provider 默认等级。

### 示例

假设你的 DSH 环境（如 `cordis.patch.yml`）中配置了以下 provider，可以直接在配置下拉框中选择：

- `glm-coding` / `glm-5.3-flashx`：延迟较低的审查模型；
- `codex-proxy` / `gemini-3.8-flash-high`：能力更强的审查模型。

一个路由列表示例（实际 id 取决于你的环境）：

```yaml
# 设置列表第 1 行（没有总开关）：
primaryEnabled: true
provider: deepseek-account
model: deepseek-flash
reasoningEffort: inherit
# 第 2..N 行（禁用项仍保存但会被跳过）：
fallbacks:
  - enabled: true
    provider: lithosai
    model: DeepSeek-V4.1-Flash
    reasoningEffort: inherit
  - enabled: false
    provider: flux-anthropic
    model: deepseek-v4.1-flash
```

该配置下，审查先尝试 `deepseek-account/deepseek-flash`；该账号余额不足时依次尝试 `lithosai/DeepSeek-V4.1-Flash`、`flux-anthropic/deepseek-v4.1-flash`，最后自动改用发起本次审查的主会话模型（不强制推理等级）。全部失败则审查 fail-closed，工具调用不会执行。会话兜底是隐式的，不会出现在 YAML 中；旧的 `mode: session` 项会被忽略。

以上仅为环境示例，实际可选列表取决于你的 DSH 配置。`reasoningEffort` 的合法值由目标模型决定（例如 `low`、`medium`、`high`、`xhigh`）；如果能力查询成功但所选模型未声明该等级，插件会忽略它并使用 provider 默认值，而不是把不受支持的值发给模型。能力查询失败或超时则不同：该路由按路由失败处理，审查继续尝试下一条已启用路由（最后是隐式会话路由），不会回退到 provider 默认值；只有全部路由失败时才会在聚合错误中暴露。

## 限制

- **只重写 Auto review 的审查请求。** 不改写主对话、subagent、标题生成、上下文压缩等其它请求，也不改变主会话模型。
- **需要加载插件层。** 没有总开关；已弃用的 `enabled` 字段会被忽略。请用逐行启用复选框排除某条路由。
- **需要 Auto review 权限模式。** 只有会话处于自动授权审查模式时才会产生审查请求；本插件不能替代 Auto review 本身。
- **provider / model 必须已在 DSH 配置中存在。** 配置的路由无效或不可达时按“路由失败”处理：继续尝试下一条显式路由，最后尝试隐式会话路由；全部无法应答时审查 fail-closed，工具调用不会执行。
- **Fallback 不是同一条路由的自动重试。** 每一行配置就是一次尝试；重复的显式路由会按列出次数重复尝试（只有隐式会话路由会与相同的显式路由去重）。只有路由类失败才会 fallback；调用方取消与内容/协议错误会立即终止审查。
- **思考等级由目标模型决定。** 只有在目标模型明确声明了该等级时才会传递；查询成功但未声明时回退到 provider 默认值。若能力查询失败或超过 300000ms（5 分钟）超时，该路由会被跳过并记录可操作错误（继续尝试下一条已启用路由，最后是隐式会话路由），而不是静默降级到默认等级；只有全部路由失败时审查才 fail-closed。
- **客户端代码变化后需要刷新页面。** 配置界面由 `client/client.js` 提供；安装插件或修改客户端代码后必须重新加载 Web profile 并刷新 Web 页面，保存设置本身则直接对下一次审查生效。
- **实验功能。** 自动审查可能误放行不安全操作或误拒绝正常操作，也会消耗额外 token。选择审查模型不能消除 Auto review 本身的安全风险，请仍然谨慎使用。
- **不改变审查策略。** 固定的审查提示词、风险分级和放行/拒绝/转人工的判定逻辑仍完全由 DSH Auto review 决定。

## 验证状态

截至 2026-11-22，始终生效的有序路由列表（逐行启用、继承等级适配、隐式会话兜底）与逐行路由测试功能通过以下证据验证（自动化测试 + 重启后的真实链路检查）：
- **自动化命令**：`npm run typecheck`、`npm test`、`npm run check` 与 `npm run verify` 退出码均为 0。
- **测试**：191 项单元测试全部通过（0 失败）：host 39、fallback 36、route-test 43、client 33、client-component 23、Typert contract/产物 10、packaging 7。
- **静态校验**：`npm run verify` 25/25 项通过，覆盖 exports、Loader 可接受的 `./typert` manifest、Host/Client descriptor 一致性、`./remote` 内嵌与 `$mount` 接线、手写 Typert 产物零运行时依赖，以及所有入口的语法。Desktop 环境下，已安装 experimental-auto-review 策略检查通过 `DSH_NODE_EXECUTABLE` 读取运行中的 `app.asar`；若存在 `DSH_INSTALL_DIR` 但无法读取官方源码，检查会失败而不是静默跳过。只有没有已安装 DSH 包树的源码检出环境才允许报告 SKIP。
- **已断言的安全不变量**：探测请求只包含 provider/model/[reasoningEffort]/固定 prompt/maxTokens/temperature/signal（绝不含 `sessionId`、`purpose`、`tools`、`toolHistory` 或对话历史）；显式探测路由会先经实时 provider 目录与 `resolveModelInfo` 校验；不写设置；不返回模型输出、凭证材料或任意传输错误文本；Account 与 API-key 故障分类可区分；限流、single-flight、有界超时、有界输出，以及列表修改后的过期结果失效均有覆盖。
- **已断言的路由列表不变量**：确定性的尝试顺序（第 1 行 → 数组顺序 → 隐式会话路由最后）、会话路由使用被拦截请求自带路由且不强制推理等级、显式路由与请求路由相同时不重复追加会话尝试、旧 `{ mode: 'session' }` 项被忽略、旧 primary+fallbacks 配置按列表顺序迁移、空列表/全部禁用保持原生直通、禁用项与不完整项被跳过、配额/认证/限流/服务端/传输类 finish 与抛错的流会 fallback、恰好 yield 一个终止 finish、调用方 abort 不 fallback、能力查询失败会 fallback、不可重试的内容/协议错误与适配器 abort 直接失败、chunk 在终止 finish 前即转发、首个 chunk 前可 fallback、发出输出后的失败直接报错不重试、成功路由恰好 yield 一次且不重复、超过 5,000 chunk 的 reasoning 重负载尝试成功、单个聚合错误按顺序列出所有尝试路由（会话尝试在最后）且逐字保留原始 provider 消息与失败码（按尝试顺序）、`enabled:false` 被忽略、非审查请求不受影响、volatile 路由列表在下次审查立即生效、单列表客户端的逐行启用/增删/上移下移/保存行为（无可见序号、无固定会话行）、整行测试结果不改变列宽、逐行探测相互独立，以及可选 `input` 入参与旧式无参调用经 Gateway 解码路径的回归钉，以及继承等级的精确保留/最近适配/平手偏高/off→low/xhigh→max/无可排名等级→默认，显式等级不被改编与逐行探测的校验/安全约束。

**验证边界**：
- **自动化测试使用内存 fake adapter**：单元测试不会调用真实 LLM API 或网络；真实行为在重启 DSH web host 后另行验证（见下）。
- **浏览器行为为人工检查，非自动化**：表格布局、逐行测试按钮、行内结果与明暗外观已在运行中的设置页检查；自动化测试使用确定性的 hook driver，不使用真实浏览器，也不包含视觉回归测试。
- **真实 Gateway 分发已在重启后验证**：此前所有「测试」按钮失败，是因为 DSH web host 进程早于可选 `input` 参数存在；重启该 host 后，重建客户端的逐行「测试」按钮通过已安装的 Typert Loader + Gateway RPC 链路返回了真实分类结果，同时已保存第 1 行的探测路径也正常。修改 `./typert` 契约后，请重新安装/升级包或重启 DSH。

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
- `src/route-test.ts`：宿主逐行探测端点（可选显式路由入参并以已保存第 1 行为兜底、provider/model 校验、限流、错误分类、结果构造）；
- `src/typert.contract.ts`：两个 generated-style 面共享的零依赖 Typert 契约；
- `src/typert.host.ts`、`src/typert.remote-client.ts`：`./typert` 与 `./remote` 产物入口；
- `scripts/build-client.cjs`：把契约内嵌进浏览器 bundle 并注册 `./remote` chunk；
- `src/client/client.ts`：Web 配置面板客户端源码，含有序路由表格、逐行启用/测试按钮与行内结果；
- `tests/*.test.ts`：单元测试源码；
- `scripts/verify.ts`：静态与冒烟校验脚本源码；
- `lib/`、`client/client.js`：编译分发产物（请勿手改）；
- `.build/`：测试与校验脚本的编译输出目录；
- `cordis.patch.yml`：bundle 层插入声明；
- `tsconfig*.json`：TypeScript 编译配置文件。
