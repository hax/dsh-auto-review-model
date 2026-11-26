# Changelog

All notable changes to `@aghost-prj/dsh-auto-review-model`. The package is pre-1.0, so behavior changes ship as minor entries.

## Unreleased

### Added

- **Scripted review test** (`mode: 'review'` on `autoReviewModel/testReviewRoute`). The Host caches the real reviewer prompt it sees on the wire — the fixed system policy plus the first `ENVIRONMENT` message only; no session history, tool arguments or paths are retained, and nothing is persisted. The test replays that prompt twice, each time appending one synthetic `bash` pending call: `echo hello` (a correct reviewer allows it) and a credential-exfiltration command (it must deny it). Both decisions come back as `cases`; a mismatch reports `REVIEW_MISMATCH` and shows the actual decision, so a false block and a bypass are distinguishable. Without a captured prompt the endpoint refuses with `NO_REVIEW_PROMPT` instead of shipping a policy copy that could drift. Each row's **Review** button runs it.
- **Measured route health** (`mode: 'health'`). The settings page reads the current week's ledger once on mount — no provider contact, no probe quota — and shows one line per route: attempts, successes, mean latency and the newest failure code, or an explicit "no real reviews this week yet".
- **Weighted start route** (`weight` `0`–`9` per route). A fresh session draws its first route in proportion to the positive weights; the remaining positive routes follow in configured order, then every weight-`0` route, then the implicit session route. With zero or one positive weight the configured order is unchanged, so all-zero weights (the upgraded default) behave exactly as before.
- **Sticky session route**. Once a route answers a review, later reviews from the same session start there and skip routes known to fail for it. The map is in-memory and keyed by session id; a failing sticky route clears its entry and the configured order is retried from the top.
- **Measured ledger**. One JSON line per review in `~/.dsh/auto-review-ledger-<year>-W<week>.jsonl` (`DSH_AUTO_REVIEW_LEDGER=0` disables it): total duration, fallback flag, sticky route, every attempt with route/effort/mode/ms/ok/failure code/detail/usage, and the winning route with its decision. The current week stays plain JSONL; the previous week is sealed to `.jsonl.zst` on rotation.
- `src/ledger.ts` owns the record shape, ISO-week rotation, writer and the health aggregation in one place.

### Changed

- **One unified `routes` list.** The primary + `fallbacks` split is gone; a configuration written before the list existed is migrated on read (row 1 first, then `fallbacks`) and rewritten into `routes` on the next save. A schema-filled empty `routes` array also migrates, so a legacy section never reads as "all routes deleted".
- **Failover on any failure, with buffered validation.** One attempt's chunks are buffered until its terminal `finish` arrives and the answer parses as a risk/decision object, so a failing route can never leak partial text. Any failure now advances to the next route — thrown streams, any error finish code, adapter-side aborts, missing finishes, and empty/oversized/unparseable answers. Only a caller abort is propagated untouched.
- The settings table is one flat route table with a weight column; the two per-row actions are **Test** (liveness) and **Review** (decision correctness), and each carries its own busy/result state.

### Fixed

- **The review test no longer fails on a normal reasoning-heavy answer.** The bounded stream walker carried the liveness probe's 64-character / 32-chunk ceiling as a hard per-field limit, so the first review case (512 tokens, reasoning at `max` effort) tripped it immediately and reported "unknown failure" with the probe's oversize text. The walker now takes the active bound, review cases get 2,048 tokens and a 32 KiB / 8,192-chunk buffer, and a review case that never settles is recorded as a failed case rather than aborting the run.
- **A probe that already saw model content before its reading bound reports the route as healthy.** Truncating a verbose route is not a route failure; only a bound hit with no content remains an oversize diagnostic.

- **The route table no longer blanks out for a legacy section.** Schemastery fills a missing volatile array with `[]`, so `settings.describe()` projects `routes: []` for every configuration written before the list existed. The client treated any array as authoritative and rendered zero rows, which made a perfectly saved review configuration look deleted; only a non-empty list wins now and an empty one falls through to the legacy migration, matching the Host.
- **The test suite compiles and runs again.** It still described the pre-`routes` API (`buildReviewPlan(row1, fallbacks, request)`, attempts with `source`/`index`, rows without a weight) and the old "only fail over before the first emitted chunk" policy; it is updated to the unified list, the weighted draw, the buffered stream and the two new modes (200 tests).

## 0.1.0

- Initial release: pick provider/model/reasoning effort for Auto review, ordered fallbacks with an implicit session route, per-row enable flags, inherit-effort adaptation, and a per-row liveness probe.
