# @aghost-prj/dsh-auto-review-model

Pick a dedicated provider / model / reasoning effort for DSH **Auto review** without changing the model used by the main conversation.

> Experimental. This plugin only rewrites the review request emitted by Auto review. It does not change the review policy, risk classification, or approval behavior.

## Purpose

Before each supported tool call, DSH Auto review asks the current session's provider and model to review the pending call and then allow, deny, or escalate it to the user. By default the review uses the same model as the main conversation.

This plugin recognizes Auto-review requests at the LLM request layer and substitutes the provider, model, and reasoning effort configured on the settings page. Typical uses:

- use a faster, cheaper model for routine reviews to cut latency and token cost;
- use a stronger model for reviews while keeping a lightweight model for the main conversation;
- pin reviews to one model so review behavior does not drift when the session model changes;
- keep reviews working when one account runs out of balance: configure an ordered list of reviewer models. The current session model is always the implicit final fallback, so reviews still complete when every configured account is unavailable.

When every configured route fails, the review fails closed and the pending tool call is **not** executed.

Regular chat, subagents, title generation, compaction, and other LLM requests are untouched.

## How it works

- **Request interception**: The host-side plugin listens on `llm/stream` and specifically matches Auto-review requests where the `system` prompt starts with `REVIEW_POLICY\n` and contains the fixed reviewer marker sentence (`You are the final authorization reviewer for exactly one pending tool call.`).
- **Route rewriting**: The plugin is always active — there is no master switch. It builds a deterministic route plan from one ordered list — the legacy primary `provider`/`model` pair (row 1, gated by `primaryEnabled`) first, then each enabled entry of the ordered `fallbacks` array (rows 2..N) — and appends the intercepted request's own provider/model as the implicit final attempt. It clones the frozen request object for each attempt, replacing `provider`, `model`, and `reasoningEffort`. The original review prompt, risk criteria, instructions, session id, and purpose remain unchanged.
- **Per-row enable**: each row has an `enabled` flag (`primaryEnabled` for row 1, `enabled` for each fallback entry). Disabled rows stay saved and editable but are skipped when the plan is built; if every row is disabled or empty, the plan is empty and the request is not rewritten at all.
- **Ordered routes with an implicit session fallback**: Only route-level failures advance to the next route: a failed/timed-out capability lookup, a thrown provider stream, or a terminal `finish` whose official failure code is a quota, auth, credential, rate-limit, server, timeout, transport, adapter or model-routing failure. A caller abort is propagated untouched and content/protocol failures are surfaced instead of retried. The current session model — exactly the provider/model carried by the intercepted review request — is ALWAYS the final attempt. It cannot be configured, reordered or stored, and it never forces a reasoning effort. It is skipped when the request has no usable route, and it is not appended twice when an explicit route already uses the same provider+model. Incomplete explicit entries are skipped. With no usable explicit route (an empty list) the plugin does not rewrite the review at all and the native session model serves it. Legacy `{ mode: 'session' }` entries are ignored, because that fallback is implicit now. Chunks are forwarded to the caller immediately; failover stops at the first emitted chunk (the commit point): before it, a route failure advances to the next route, while after it the failure is surfaced instead of retried so the caller's single-decision stream never mixes two routes. When every route fails before any output, one aggregate error lists each attempted `provider/model` with its failure code and raw provider message, verbatim.
- **Reasoning capability lookup**: Before forwarding a configured reasoning effort, the plugin queries the route's capabilities via `resolveModelInfo`, combining the review request's `AbortSignal` with a 300000 ms (5 min) timeout. If the target model advertises support for that effort tier, it is applied; if the successful lookup advertises other or no efforts, the effort is omitted so the provider default applies. A failed or timed-out lookup is a ROUTE failure: the actionable error (exact route, the 300000 ms / 5 min timeout, and repair steps) is recorded and the next enabled route — finally the implicit session route — is tried. It only surfaces, inside the aggregate error, when every route fails. A lookup failure is never treated as "unsupported" and never silently degrades to the default effort.
- **Cache invalidation**: Only successful capability lookups are cached per route, using a generation/epoch counter to prevent in-flight lookup completions from writing back stale data across invalidations. Failed or timed-out lookups are never cached, so the next review retries them. The cache is invalidated whenever `llm/adapters-updated` or `loader/volatile-update` (listened globally with `global: true` to reliably receive local provider configuration updates) fires.
- **Fail-closed security**: If every configured route and the implicit session route fail (including after any retries/fallbacks), the review fails and the pending tool call is not executed (fail-closed).
- **Reasoning effort: inherit and adaptation**: a row's effort selector offers the provider default (empty), an explicit adapter-owned effort, or **Inherit session** (stored as the sentinel `inherit`). On a review, `inherit` reads the intercepted request's session through `session.requestHeader()?.config.reasoningEffort`; with no session/effort it falls back to the provider default. A concrete inherited effort is adapted to the target route's advertised efforts (nearest canonical rank, ties toward the higher rank, no advertised rank → provider default). Explicit efforts are never adapted: they are sent only when the target advertises them, otherwise omitted. The implicit final session attempt never forwards an effort.
- **Per-row test endpoint**: the same Host plugin contributes one small Typert Remote method, `autoReviewModel/testReviewRoute`, declared by the hand-written generated-style `./typert` manifest and mounted by the browser half from the package's `./remote` contribution. Every route row has its own **Test** button that probes that row's CURRENT values (including unsaved edits) through an optional explicit-route input; an omitted or empty input still probes the saved row 1. For an explicit route the Host requires both ids, checks the provider against the live configurable-provider directory, and proves the model with `resolveModelInfo` before streaming. The Host never accepts a URL, credential, session id, purpose, tools, or conversation history from the page. Probes are bounded (16 output tokens, 20 s deadline, 5 per minute, one in flight), never write settings, never change the main model, never execute tools and never return model output. A stream that ends without any real model content (only structural chunks, including an empty text block) is reported as `EMPTY_RESPONSE`, not as success.

## Install

```sh
# Install from npm registry (after published):
dsh plugin --profile web add @aghost-prj/dsh-auto-review-model

# Or install from local path for development:
dsh plugin --profile web add /path/to/dsh-auto-review-model
```

The command adds the package as a dependency and bundle layer for the `web` profile. The DSH loader reads `cordis.patch.yml` through the package's `dsh.bundle.patch` and inserts the plugin as the `auto-review-model` layer.

After installing or rebuilding the client, reload the Web profile in the usual DSH way and refresh the page for the configuration panel to appear. Saving settings takes effect on the next review without requiring a session restart.

Because the Host face is discovered by the Typert Loader from the package's `./typert` export, install or upgrade the package before starting DSH, or restart DSH after the package files change, so the new export is registered. The browser half then mounts the `./remote` contribution automatically when the settings page loads.

## Configuration

Open **Settings → Plugins → Auto review** (设置 → 插件 → 自动授权审查).

The **Auto review model** (自动审查模型) configuration section renders directly on that bundle's details page, positioned between **Description** and **Included Components**. It is registered into the `plugins.bundle.config` slot under the key `@deepseek-ai/dsh-experimental-auto-review`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | **Deprecated and ignored.** The plugin is always active; the field stays in the schema only so configurations written by older versions still validate. |
| `primaryEnabled` | boolean | `true` | Whether settings-list row 1 (the top-level route) is eligible. A disabled row stays saved and editable but is skipped. |
| `provider` | string | empty | Provider ID for review requests (settings-list row 1). Leaving it empty makes row 1 skipped; reviews then use the remaining rows and finally the current session model. Must be set together with `model` to be a usable route. |
| `model` | string | empty | Model ID for review requests. Must be set together with `provider` to activate the row. |
| `reasoningEffort` | string | empty | Reasoning effort for row 1. Empty means the provider default; `inherit` means the main session's current effort, adapted to the target route. |
| `fallbacks` | array | `[]` | Ordered explicit routes tried after row 1. Each entry is `{ enabled?, provider, model, reasoningEffort? }`; disabled entries are skipped, and the `mode` field is retained only so legacy `{ mode: 'session' }` rows are ignored rather than mistaken for routes. The intercepted request's own model is always the implicit final attempt and is not stored here. Volatile: saving takes effect on the next review. A missing value means no additional routes (legacy behavior). |

### Configuration rules

- **There is no master switch.** `enabled` is deprecated and ignored; an old config with `enabled: false` becomes active on upgrade. Use the per-row checkboxes to stop one row from being reviewed.
- `provider` and `model` must be set as a non-empty pair and the row must be enabled to be attempted.
- Leaving `provider` empty makes row 1 unusable; the enabled fallbacks are still tried and the implicit session fallback always remains last.
- Setting only one field does not partially apply. If `provider` is non-empty while `model` is empty, that row is skipped instead of mixing two routes; the settings page marks it as skipped and the review continues with the remaining rows and the session fallback.
- `reasoningEffort` is optional. Empty means no explicit effort. `inherit` reads the main session's current effort and adapts it to this route. A concrete explicit value is forwarded only when the target model advertises it; a successful lookup that does not advertise it falls back to the provider default. A failed or timed-out capability lookup is a route failure: its actionable error (exact route, 300000 ms / 5 min timeout, and repair steps) is recorded, the next enabled route — finally the implicit session route — is tried, and it only surfaces in the aggregate error when every route fails. It never silently uses the default effort.
- In the configuration UI, if an existing configuration contains an unrecognized or unadvertised `reasoningEffort`, the client preserves and explicitly displays it without disguising it as the provider default, allowing the user to inspect it or explicitly clear it.
- `fallbacks` is optional and defaults to `[]`. The settings page shows ONE ordered reviewer-model list: row 1 is bound to `primaryEnabled`/`provider`/`model`/`reasoningEffort`, and rows 2..N to this array with a per-row `enabled` flag, so no new route array was introduced. Order is significant: row 1 is tried first, then each enabled fallback in array order, then the implicit session route. At most 10 explicit routes are edited on the settings page; the Host schedules at most 10 fallback entries.
- The **current session model is always the implicit final fallback**. It is not a row, cannot be added/removed/reordered and is never saved. At runtime it is the intercepted review request's own `provider`/`model` — not a saved "current model" — and it never imposes a reasoning effort. It is skipped when the request has no usable route, and no duplicate attempt is appended when an explicit route already uses the same provider+model.
- **An empty list means native behavior**: with no usable explicit route the plugin does not rewrite the review, so the session model handles it exactly as it would without this plugin.
- A **legacy `{ mode: 'session' }` entry is ignored**. Old configs may still contain it; the session fallback is implicit now, so such an entry is never scheduled as a configured route and is dropped the next time the settings page saves.
- An **incomplete explicit entry** (missing `provider` or `model`) is skipped instead of half-applied; the settings page marks it as skipped.
- **Takes effect immediately on the next review after saving.** In-flight reviews are not rewritten, and no session restart or profile reload is required.

### Review routes and failure classification

The configuration panel has ONE ordered **Review routes** (审查路由) table, one section-level stream-capture select and no master enable checkbox. It is a real table inside a horizontally scrollable wrapper, with fixed columns — **Enabled**, **Provider**, **Model**, **Reasoning effort**, **Test**, **Actions** — so long provider/model names can never push the following rows out of alignment. Each `tr[data-route-index]` is one route: a centered enable checkbox, the three selects, a compact Test button, and ↑ / ↓ / ✕ actions. A test result (and an incomplete-row hint) is a separate full-width `colSpan` row directly beneath its route, so a long status or hint never changes the columns above. Rows have no visible `#n` ordinal — vertical order is the fallback order and up/down handle reordering; each row carries a position-based accessible name (`Review route 1`, …) and a stable `data-route-index` test hook. A disabled row is visually de-emphasised but stays editable and testable. On narrow viewports the wrapper scrolls horizontally while the table keeps a sensible minimum width. The implicit session fallback is not a row and has no UI control: the section description states that if every enabled route fails the review falls back to the session model automatically, and if that also fails the review fails and the tool call is not executed.

Only route-availability failures advance to the next route:

| Observed failure | Falls back? |
| --- | --- |
| `resolveModelInfo` capability lookup fails or exceeds its 300000 ms (5 min) deadline | Yes (the route cannot serve the review) |
| `ctx.llm.stream` throws synchronously or during iteration | Yes for an unclassified throw or a retryable official code; a non-retryable official code is surfaced instead |
| Terminal `finish` with `reason.kind === 'error'` and an official code from: `ACCOUNT_QUOTA`, `QUOTA`, `AUTH`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `NO_CREDENTIAL_STORE`, `ACCOUNT_SIGN_IN_REQUIRED`, `ACCOUNT_TOKEN_INVALID`, `RATE_LIMIT`, `SERVER`, `TRANSPORT`, `STREAM_CLOSED`, `TIMEOUT`, `DISCOVERY_FAILED`, `DISCOVERY_UNSUPPORTED`, `NO_DISCOVERY`, `NO_ADAPTER`, `INVALID_ADAPTER`, `DUPLICATE_ADAPTER`, `UNKNOWN_MODEL`, `MODEL_UNSUPPORTED`, `INVALID_CONFIG`, `INVALID_CATALOG`, `INVALID_MODEL_INFO` — or HTTP 401/402/403/404/408/429/5xx | Yes |
| Stream ends before its terminal `finish` | Yes (transport failure, `STREAM_CLOSED`) |
| Caller abort (`options.signal.aborted`) | **No** — propagated unchanged, never retried |
| Content / protocol failure (`INVALID_REQUEST`, `MALFORMED_RESPONSE`, `CONTEXT_WINDOW_EXCEEDED`, `UNSUPPORTED_*`, `EMPTY_RESPONSE`, `UNKNOWN`, or an adapter-side `aborted` finish) | **No** — surfaced, never hidden behind another route |

Chunks are forwarded to the caller as they arrive, so a reasoning-heavy reviewer streams as long as the provider allows. The failover rule is a commit point: a route may only be replaced before its first chunk is emitted; once any output has reached the caller, a later failure is surfaced as an actionable error instead of retried, because switching routes would duplicate or mix output. This stream is the caller's single-decision stream, so the winning route's chunks are yielded exactly once. When every configured route and the implicit session route fail before any output, the review rejects with one aggregate error that lists each attempted `provider/model` (with `(session)` marking the implicit final session attempt), its failure code and the raw provider message, verbatim — for example `deepseek-account/deepseek-flash: QUOTA: <provider message>` — matching official Auto review's own behavior. The plugin never adds credentials or request bodies to the message itself; it only surfaces the provider text it received. Auto review wraps it as `Auto review of tool "<name>" failed; its body was not executed: <reason>`, so no allow/deny decision is ever fabricated.

### Test a review route

Every route row has its own **Test** (测试) button. It probes THAT row's current values, including unsaved edits (a dirty row is testable), through the endpoint's optional explicit-route input; the result is rendered inline in that row with its own progress state, so one row's probe never overwrites another row's result and never reuses the Save busy state. Rows that are disabled or incomplete can still be tested, so the user can validate a route before enabling it.

The probe input contains only `provider`, `model`, and `reasoningEffort`. The Host validates an explicit route: both ids must be non-empty, the provider must exist in the live configurable-provider directory, and `resolveModelInfo(provider, model)` must succeed; otherwise it returns `ROUTE_INCOMPLETE`, `NO_ADAPTER`, or `UNKNOWN_MODEL` without forwarding a request. The browser cannot send a URL, credential, session id, purpose, tools, or conversation history. An omitted input (or an empty provider+model) keeps the original behavior and probes the saved settings-list row 1. Because the browser cannot resolve the session effort, a row whose effort is **Inherit session** is probed with that route's provider default; the result reports `effortUsed: ""` and the copy says so. **The implicit session fallback itself is never probed.**

The probe sends one fixed harmless prompt (one user message, a fixed one-word system instruction, `temperature: 0`, `maxTokens: 16`), has a 20 s overall deadline, and is throttled Host-wide (at most one probe in flight, 5 probes per 60 s, 3 s minimum gap). It carries no `sessionId`, no `purpose` (in particular not `auto-review`), no tools and no conversation history; it does not read browser credentials, save settings, change the main model, execute tools or upload Session logs.

Results are classified and rendered as a localised message plus an actionable hint. DeepSeek Account sign-in / authorization / connection problems are distinguished from API-key `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL` and `AUTH`; `NO_ADAPTER`, provider timeout, provider rate limit, quota, route incomplete/disabled, concurrent probe, empty completion and unknown failures each have their own outcome. Only classification metadata and a short classified diagnostic are displayed: the model's answer text is never returned to the browser.

### Inherited effort adaptation

When a row stores `inherit`, the Host reads the main session's current effort and maps it onto the target route's advertised efforts by canonical rank (`off`/`none`/`minimal` = 0, `low` = 1, `medium` = 2, `high` = 3, `xhigh` = 4, `max` = 5). The nearest rank wins; a tie is broken toward the **higher** rank. An exact advertised match is used verbatim. A target that advertises no ranked effort falls back to the provider default, as does an absent/unresolvable session or an inherited value with no canonical rank.

| Inherited session effort | Target route advertises | Effort sent |
| --- | --- | --- |
| `high` | `low`, `high` | `high` (exact match) |
| `xhigh` | `max` | `max` (nearest higher) |
| `off` | `low`, `high` | `low` (nearest low end) |
| `max` | `low`, `high` | `high` (nearest high end) |
| `medium` | `low`, `high` | `high` (equal distance, tie → higher) |
| any | no ranked effort | provider default (omit) |
| none / no session | — | provider default (omit) |

Explicit (non-`inherit`) efforts keep the strict behavior: they are sent only when advertised, otherwise omitted — never adapted. The implicit final session attempt always uses the provider default.

### Examples

Assuming the following providers are configured in your DSH environment (e.g., in `cordis.patch.yml`), they can be selected on the configuration page:

- `glm-coding` / `glm-5.3-flashx`: a low-latency reviewer;
- `codex-proxy` / `gemini-3.8-flash-high`: a stronger reviewer.

A route-list example (the exact ids depend on your setup):

```yaml
# Row 1 of the settings list (there is no master switch):
primaryEnabled: true
provider: deepseek-account
model: deepseek-flash
reasoningEffort: inherit
# Rows 2..N (disabled rows stay saved but are skipped):
fallbacks:
  - enabled: true
    provider: lithosai
    model: DeepSeek-V4.1-Flash
    reasoningEffort: inherit
  - enabled: false
    provider: flux-anthropic
    model: deepseek-v4.1-flash
```

With this configuration the review first tries `deepseek-account/deepseek-flash`; when that account has no balance it tries `lithosai/DeepSeek-V4.1-Flash`, then `flux-anthropic/deepseek-v4.1-flash`, and finally the model that issued the review (the main conversation's model), automatically and with no forced reasoning effort. If all fail, the review fails closed and the tool call is not executed. The session fallback is implicit, so it never appears in the YAML and old `mode: session` entries are ignored.

These are machine-specific examples; available options depend on your DSH setup. Valid `reasoningEffort` values are model-specific (e.g. `low`, `medium`, `high`, `xhigh`). If a successful capability lookup shows that the selected model does not advertise the specified effort, the plugin omits it and uses the provider default instead of passing an unsupported parameter. A failed or timed-out capability lookup is different: it is a route failure that advances to the next enabled route (finally the session route) and never falls back to the provider default; it only surfaces in the aggregate error when every route fails.

## Limitations

- **Only Auto-review requests are rewritten.** Main conversation, subagents, title generation, compaction, and other LLM calls are untouched, and the main session model never changes.
- **The plugin layer must be loaded.** There is no master switch; the deprecated `enabled` field is ignored. Use per-row checkboxes to exclude a route.
- **The Auto review permission mode is required.** Review requests only exist while the session runs under the Auto review permission mode; this plugin cannot replace or bypass Auto review.
- **The provider / model must already exist in DSH configuration.** A configured route that is invalid or unreachable is treated as a route failure: the next configured fallback is tried, and if none can answer the review fails closed and the pending tool call is blocked.
- **Fallback is not a retry of the same route.** Each configured row is one attempt; duplicate explicit routes are attempted as many times as they are listed (only the implicit session route is de-duplicated against an identical explicit route). Only route-level failures fall back; caller cancellation and content/protocol errors stop the review immediately.
- **Reasoning effort is model-owned.** Effort tiers are only forwarded if the target model explicitly declares support; a successful lookup without support falls back to the provider default. If the capability lookup fails or exceeds its 300000 ms (5 min) deadline, that route is skipped with a recorded actionable error (the review moves to the next enabled route, then the session route) rather than silently degrading to a default effort; the review only fails closed when every route fails.
- **Reload profile and refresh page after client changes.** The configuration interface is provided by `client/client.js`. After installing or modifying client code, reload the Web profile and refresh the browser page. Saving configuration settings applies immediately to the next review.
- **Experimental nature.** Auto review may incorrectly approve unsafe operations or deny benign ones, and consumes extra tokens. Choosing a dedicated reviewer model does not eliminate these inherent risks; Auto review should still be used with care.
- **The review policy is unchanged.** The prompt templates, risk classifications, and allow/deny/escalate decision logic remain governed entirely by DSH Auto review.

## Verification status

As of 2026-11-22, the always-active ordered route list (per-row enable, inherit adaptation, implicit session fallback) and the per-row route test were verified with the following evidence (automated suite plus a live post-restart check):
- **Automated commands**: `npm run typecheck`, `npm test`, `npm run check`, and `npm run verify` all exited with code 0.
- **Tests**: 191 unit tests passed (0 failures): host 39, fallback 36, route-test 43, client 33, client component 23, Typert contract/artifacts 10, packaging 7.
- **Static verification**: 25 of 25 checks passed (`npm run verify`), covering exports, the Loader-valid `./typert` manifest, Host/Client descriptor alignment, `./remote` embedding and `$mount` wiring, dependency-free hand-written Typert artifacts, and syntax of every entry. On Desktop, the installed experimental-auto-review policy check reads the running `app.asar` through `DSH_NODE_EXECUTABLE`; a missing `DSH_INSTALL_DIR` combined with an unreadable source fails the check instead of silently skipping it. SKIP is reserved for source checkouts with no installed DSH package tree.
- **Safety invariants asserted**: the probe request carries only provider/model/[reasoningEffort]/fixed prompt/maxTokens/temperature/signal (never `sessionId`, `purpose`, `tools`, `toolHistory` or conversation history); an explicit probe route is validated against the live provider directory and `resolveModelInfo`; settings are never written; no model output, credential material or arbitrary transport error text is returned or rendered; Account versus API-key failures classify distinctly; throttle, single-flight, bounded timeout, bounded output, and stale-result invalidation after a list edit are covered.
- **Route-list invariants asserted**: deterministic attempt order (row 1, then the fallback array, then the implicit session route last), the session route using the intercepted request's route with no forced effort, de-duplication when an explicit route equals the request route, legacy `{ mode: 'session' }` entries ignored, legacy primary+fallbacks migration into list order, an empty/all-disabled list keeping native passthrough, disabled and incomplete rows skipped, quota/auth/rate-limit/server/transport finishes and thrown streams falling back, a failure after the first emitted chunk surfaced without retry, exactly one terminal finish yielded, caller abort never falling back, capability-lookup failures falling back, non-retryable content/protocol failures and adapter aborts surfaced, chunks forwarded before the terminal finish, failover before the first emitted chunk, the winning route yielded exactly once with no duplication, a reasoning-heavy 5,000-chunk attempt succeeding, a single aggregate error listing every attempted route (session attempt last) with raw provider messages verbatim and codes in attempt order, `enabled:false` ignored, non-review requests untouched, volatile route edits applied on the next review, the one-list client table's per-row enable/add/remove/move/save behavior without a visible ordinal or session row, full-width test-result rows that cannot shift columns, per-row probe independence, and a Gateway-decode regression pin for the optional `input` argument plus legacy no-argument calls, and the inherit exact/nearest/tie/off→low/xhigh→max/no-effort→default cases plus unadapted explicit efforts and per-row probe validation/safety.

**Validation boundaries**:
- **The automated suite uses in-memory fake adapters**: unit tests execute no real LLM API or network call. The live behavior was verified separately after restarting the DSH web host (see below).
- **Browser behavior was reviewed manually, not automated**: the table layout, per-row test buttons, inline results and light/dark appearance were inspected on the running settings page; automated tests use a deterministic hook driver rather than a real browser, and visual regression coverage is not part of `npm test`.
- **Live Gateway dispatch was verified after a host restart**: the earlier `gateway/arguments-invalid` failures came from a DSH web host process started before the optional `input` parameter existed. After restarting that host, the rebuilt client's per-row **Test** button returned real classified results through the installed Typert Loader + Gateway RPC path, and the saved row-1 path still works. Install/upgrade the package (or restart DSH) after changing the `./typert` contract.

## Development

All source files, unit tests, and verification scripts are written in TypeScript:

- `src/`: Host and client TypeScript source files;
- `lib/` and `client/client.js`: `tsc` compilation outputs (do not edit manually);
- `tests/`: TypeScript unit tests (compiled to `.build/tests/`);
- `scripts/verify.ts`: TypeScript verification script (compiled to `.build/scripts/verify.js`).

Node does not execute TypeScript directly on this machine; tests and scripts are compiled via `tsc` and executed with `node --test` or `node`. `node_modules/` and `.npm-cache/` are ignored in `.gitignore`.

### Dependencies and linking

Development dependencies include `typescript` (5.7.3) and `@types/node`. In an offline or harness environment, dependencies such as `@deepseek-ai/schemastery` and `@types/node` can be linked from the host DSH installation (adjust the path to match your environment):

```sh
mkdir -p node_modules/@deepseek-ai node_modules/@types
ln -sfn /path/to/dsh/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
ln -sfn /path/to/dsh/node_modules/@types/node node_modules/@types/node
npm install
```

### Commands

```sh
npm run build        # Build host (src/ -> lib/), client (src/client/ -> client/), and embed the shared Typert contract into client/client.js (scripts/build-client.cjs)
npm run build:tests  # Compile tests and scripts (tests/*.test.ts, scripts/verify.ts -> .build/)
npm run typecheck    # Run TypeScript type check across host, client, and tests
npm run check        # Syntax check compiled JS files with node --check
npm test             # Compile and run unit tests with node --test (.build/tests/*.test.js)
npm run verify       # Compile and run static verification (.build/scripts/verify.js)
```

### Layout

- `src/index.ts`, `src/policy.ts`: Host plugin, config schema, and review-request interception;
- `src/route-test.ts`: Host per-row probe endpoint (optional explicit-route input with saved-row-1 fallback, provider/model validation, limits, error classification, result builder);
- `src/typert.contract.ts`: dependency-free Typert contract shared by both generated-style faces;
- `src/typert.host.ts`, `src/typert.remote-client.ts`: `./typert` and `./remote` artifact entry modules;
- `scripts/build-client.cjs`: embeds the contract into the browser bundle and registers the `./remote` chunk;
- `src/client/client.ts`: Web configuration UI client source: the ordered route table, per-row enable/test buttons and inline results;
- `tests/*.test.ts`: Unit tests;
- `scripts/verify.ts`: Static and smoke verification script;
- `lib/`, `client/client.js`: Compiled distribution artifacts (do not edit);
- `.build/`: Compiled artifacts for tests and scripts;
- `cordis.patch.yml`: Bundle layer insert declaration;
- `tsconfig*.json`: TypeScript compiler configurations.
