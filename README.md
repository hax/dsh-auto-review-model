# @aghost-prj/dsh-auto-review-model

Pick a dedicated provider / model / reasoning effort for DSH **Auto review** without changing the model used by the main conversation.

> Experimental. This plugin only rewrites the review request emitted by Auto review. It does not change the review policy, risk classification, or approval behavior.

## Purpose

Before each supported tool call, DSH Auto review asks the current session's provider and model to review the pending call and then allow, deny, or escalate it to the user. By default the review uses the same model as the main conversation.

This plugin recognizes Auto-review requests at the LLM request layer and substitutes the provider, model, and reasoning effort configured on the settings page. Typical uses:

- use a faster, cheaper model for routine reviews to cut latency and token cost;
- use a stronger model for reviews while keeping a lightweight model for the main conversation;
- pin reviews to one model so review behavior does not drift when the session model changes.

Regular chat, subagents, title generation, compaction, and other LLM requests are untouched.

## How it works

- **Request interception**: The host-side plugin listens on `llm/stream` and specifically matches Auto-review requests where the `system` prompt starts with `REVIEW_POLICY\n` and contains the fixed reviewer marker sentence (`You are the final authorization reviewer for exactly one pending tool call.`).
- **Route rewriting**: When enabled and configured with a complete provider/model pair, it clones the frozen request object and replaces `provider`, `model`, and `reasoningEffort`. The original review prompt, risk criteria, and instructions remain unchanged.
- **Reasoning capability lookup**: Before forwarding a configured reasoning effort, the plugin queries the route's capabilities via `resolveModelInfo`, combining the review request's `AbortSignal` with a 300000 ms (5 min) timeout. If the target model advertises support for that effort tier, it is applied; if the successful lookup advertises other or no efforts, the effort is omitted so the provider default applies. A failed or timed-out lookup fails the review closed with an actionable error that names the exact route, the 300000 ms (5 min) timeout, and repair steps; a lookup failure is never treated as "unsupported" and never silently degrades to the default effort.
- **Cache invalidation**: Only successful capability lookups are cached per route, using a generation/epoch counter to prevent in-flight lookup completions from writing back stale data across invalidations. Failed or timed-out lookups are never cached, so the next review retries them. The cache is invalidated whenever `llm/adapters-updated` or `loader/volatile-update` (listened globally with `global: true` to reliably receive local provider configuration updates) fires.
- **Fail-closed security**: If the specified review route is misconfigured, unavailable, or encounters an error during the review, the review fails and the pending tool call is not executed (fail-closed).
- **Saved-route test endpoint**: the same Host plugin contributes one small Typert Remote method, `autoReviewModel/testReviewRoute`, declared by the hand-written generated-style `./typert` manifest and mounted by the browser half from the package's `./remote` contribution. The settings page exposes it as a **Test saved route** action that probes the saved provider/model/effort with one fixed harmless prompt. The Host reads the saved settings itself, so the page sends no route, no credential, no session id, no purpose, no tools and no conversation history. Probes are bounded (16 output tokens, 20 s deadline, 5 per minute, one in flight), never write settings, never change the main model, never execute tools and never return model output. A stream that ends without any real model content (only structural chunks, including an empty text block) is reported as `EMPTY_RESPONSE`, not as success.

## Install

```sh
# Install from npm registry (after published):
dsh plugin --profile web add @aghost-prj/dsh-auto-review-model

# Or install from local path for development:
dsh plugin --profile web add /home/aghost/workspace/dsh-auto-approval-model-fix
```

The command adds the package as a dependency and bundle layer for the `web` profile. The DSH loader reads `cordis.patch.yml` through the package's `dsh.bundle.patch` and inserts the plugin as the `auto-review-model` layer.

After installing or rebuilding the client, reload the Web profile in the usual DSH way and refresh the page for the configuration panel to appear. Saving settings takes effect on the next review without requiring a session restart.

Because the Host face is discovered by the Typert Loader from the package's `./typert` export, install or upgrade the package before starting DSH, or restart DSH after the package files change, so the new export is registered. The browser half then mounts the `./remote` contribution automatically when the settings page loads.

## Configuration

Open **Settings → Plugins → Auto review** (设置 → 插件 → 自动授权审查).

The **Auto review model** (自动审查模型) configuration section renders directly on that bundle's details page, positioned between **Description** and **Included Components**. It is registered into the `plugins.bundle.config` slot under the key `@deepseek-ai/dsh-experimental-auto-review`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch. When disabled, reviews fall back to the current session model. |
| `provider` | string | empty | Provider ID for review requests. Leaving it empty inherits the current session model. Must be set together with `model` to activate the override. |
| `model` | string | empty | Model ID for review requests. Must be set together with `provider` to activate the override. |
| `reasoningEffort` | string | empty | Reasoning effort for review requests, applied only when the override is active. Leaving it empty uses the provider default. |

### Configuration rules

- `provider` and `model` must be set as a non-empty pair and `enabled` must be true to activate the route override.
- Leaving `provider` empty indicates inheriting the current session model.
- Setting only one field does not partially apply; the plugin falls back completely to native behavior (using the current session's provider and model). Specifically, if `provider` is non-empty while `model` is empty, host routing falls back to the session model under existing host rules, and the UI explicitly alerts that the override is not activated.
- `reasoningEffort` is optional. If left empty, no explicit effort is passed. It is forwarded only when the target model advertises support for that tier; a successful lookup that does not advertise it falls back to the provider default. A failed or timed-out capability lookup fails the review closed with an actionable error (exact route, 300000 ms / 5 min timeout, and repair steps) instead of silently using the default effort.
- In the configuration UI, if an existing configuration contains an unrecognized or unadvertised `reasoningEffort`, the client preserves and explicitly displays it without disguising it as the provider default, allowing the user to inspect it or explicitly clear it.
- **Takes effect immediately on the next review after saving.** In-flight reviews are not rewritten, and no session restart or profile reload is required.

### Test the saved review route

The configuration panel includes **Test saved route** (测试审查路由). It always tests the route currently **saved** — the hint names that route — so unsaved edits in the form are never exercised, and a dirty draft cannot be mistaken for what the probe used. The probe has its own progress/result state; it does not reuse the Save busy state.

The probe sends one fixed harmless prompt (one user message, a fixed one-word system instruction, `temperature: 0`, `maxTokens: 16`), has a 20 s overall deadline, and is throttled Host-wide (at most one probe in flight, 5 probes per 60 s, 3 s minimum gap). It carries no `sessionId`, no `purpose` (in particular not `auto-review`), no tools and no conversation history; it does not read browser credentials, save settings, change the main model, execute tools or upload Session logs.

Results are classified and rendered as a localised message plus an actionable hint. DeepSeek Account sign-in / authorization / connection problems are distinguished from API-key `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL` and `AUTH`; `NO_ADAPTER`, provider timeout, provider rate limit, quota, route incomplete/disabled, concurrent probe, empty completion and unknown failures each have their own outcome. Only classification metadata and a short sanitized diagnostic are displayed: the model's answer text is never returned to the browser.

### Examples

Assuming the following providers are configured in your DSH environment (e.g., in `cordis.patch.yml`), they can be selected on the configuration page:

- `glm-coding` / `glm-5.3-flashx`: a low-latency reviewer;
- `codex-proxy` / `gemini-3.8-flash-high`: a stronger reviewer.

These are machine-specific examples; available options depend on your DSH setup. Valid `reasoningEffort` values are model-specific (e.g. `low`, `medium`, `high`, `xhigh`). If a successful capability lookup shows that the selected model does not advertise the specified effort, the plugin omits it and uses the provider default instead of passing an unsupported parameter. A failed or timed-out capability lookup is different: it fails the review closed with an actionable error and never falls back to the provider default.

## Limitations

- **Only Auto-review requests are rewritten.** Main conversation, subagents, title generation, compaction, and other LLM calls are untouched, and the main session model never changes.
- **The plugin must be enabled.** `enabled` must be `true` and the plugin layer must be loaded by the DSH profile.
- **The Auto review permission mode is required.** Review requests only exist while the session runs under the Auto review permission mode; this plugin cannot replace or bypass Auto review.
- **The provider / model must already exist in DSH configuration.** An invalid ID or unreachable model causes the review request to fail. In accordance with fail-closed behavior, the pending tool call is blocked and will not execute.
- **Reasoning effort is model-owned.** Effort tiers are only forwarded if the target model explicitly declares support; a successful lookup without support falls back to the provider default. If the capability lookup fails or exceeds its 300000 ms (5 min) deadline, the review fails closed with an actionable error rather than silently degrading to a default effort.
- **Reload profile and refresh page after client changes.** The configuration interface is provided by `client/client.js`. After installing or modifying client code, reload the Web profile and refresh the browser page. Saving configuration settings applies immediately to the next review.
- **Experimental nature.** Auto review may incorrectly approve unsafe operations or deny benign ones, and consumes extra tokens. Choosing a dedicated reviewer model does not eliminate these inherent risks; Auto review should still be used with care.
- **The review policy is unchanged.** The prompt templates, risk classifications, and allow/deny/escalate decision logic remain governed entirely by DSH Auto review.

## Verification status

As of 2026-11-16, the saved-route test feature was verified with the following automated evidence:
- **Automated commands**: `npm run typecheck`, `npm test`, `npm run check`, and `npm run verify` all exited with code 0.
- **Tests**: 130 unit tests passed (0 failures): host 33, route-test 37, client 25, client component 19, Typert contract/artifacts 9, packaging 7.
- **Static verification**: 25 of 25 checks passed (`npm run verify`), covering exports, the Loader-valid `./typert` manifest, Host/Client descriptor alignment, `./remote` embedding and `$mount` wiring, dependency-free hand-written Typert artifacts, and syntax of every entry. On Desktop, the installed experimental-auto-review policy check reads the running `app.asar` through `DSH_NODE_EXECUTABLE`; a missing `DSH_INSTALL_DIR` combined with an unreadable source fails the check instead of silently skipping it. SKIP is reserved for source checkouts with no installed DSH package tree.
- **Safety invariants asserted**: the probe request carries only provider/model/[reasoningEffort]/fixed prompt/maxTokens/temperature/signal (never `sessionId`, `purpose`, `tools`, `toolHistory` or conversation history); settings are never written; no model output, credential material or arbitrary transport error text is returned or rendered; Account versus API-key failures classify distinctly; throttle, single-flight, bounded timeout, bounded output, and stale-result invalidation after a saved-route change are covered.

**Validation boundaries and unverified items**:
- **No live model calls**: Automated tests use in-memory fake adapters; neither real LLM APIs nor network calls were executed, and the real saved route (for example `deepseek-account/deepseek-flash`) was not probed by this suite.
- **No browser verification**: no browser control was available, so the action's rendered placement, discoverability, light/dark appearance and live result rendering have not been visually verified. A read-only UI/UX source review was performed; its substantiated findings (stale-result invalidation, data-only diagnostics, live-region scope, retry copy) were fixed and re-tested, but browser verification remains unavailable.
- **Live Gateway dispatch remains unverified**: unit tests exercise the published endpoint locally, not the installed Typert Loader + Gateway RPC path. That end-to-end path requires installation verification in a running DSH session (task-4).

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
- `src/route-test.ts`: Host saved-route probe endpoint (limits, error classification, result builder);
- `src/typert.contract.ts`: dependency-free Typert contract shared by both generated-style faces;
- `src/typert.host.ts`, `src/typert.remote-client.ts`: `./typert` and `./remote` artifact entry modules;
- `scripts/build-client.cjs`: embeds the contract into the browser bundle and registers the `./remote` chunk;
- `src/client/client.ts`: Web configuration UI client source, including the saved-route test action;
- `tests/*.test.ts`: Unit tests;
- `scripts/verify.ts`: Static and smoke verification script;
- `lib/`, `client/client.js`: Compiled distribution artifacts (do not edit);
- `.build/`: Compiled artifacts for tests and scripts;
- `cordis.patch.yml`: Bundle layer insert declaration;
- `tsconfig*.json`: TypeScript compiler configurations.
