/**
 * Pure policy helpers for `@aghost-prj/dsh-auto-review-model`.
 *
 * This module deliberately imports nothing: request classification and config
 * reading are synchronous, side-effect-free operations that the host entry can
 * compose with Cordis and schemastery. Keeping them separate also lets the host
 * tests exercise the policy without a live loader or LLM service.
 */

/** Fixed first line of the auto-review reviewer request's system prompt. */
export const REVIEW_POLICY_PREFIX = 'REVIEW_POLICY\n';

/** Sentence that identifies the one pending-call reviewer request. */
export const REVIEW_POLICY_MARKER =
  'You are the final authorization reviewer for exactly one pending tool call.';

/** Separator used in the model-capability cache key (`provider\0model`). */
export const EFFORT_CACHE_SEPARATOR = '\u0000';

/** Value that means "no explicit reasoning effort was configured" (provider default). */
const EFFORT_DEFAULT = '';

/**
 * Sentinel stored by the settings UI for "inherit the main session's effort".
 *
 * The Host resolves it per intercepted review request and adapts the inherited
 * effort to the target route's advertised efforts (see
 * {@link adaptEffortToAdvertised}); an empty value still means "omit, use the
 * provider default" for backward compatibility.
 */
export const INHERIT_EFFORT = 'inherit';

/**
 * Canonical reasoning-effort ranks used to adapt an inherited effort.
 *
 * The ranks are deliberately a small fixed vocabulary rather than an
 * adapter-owned table: inherited values come from the main session (a
 * different model/route), so only their approximate position matters.
 * `default`/`inherit` are not ranks and are treated as absent by
 * {@link effortRank}.
 */
export const EFFORT_RANKS: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

/** A Cordis volatile config field: the live value is read through `get()`. */
export interface ConfigRef<T> {
  get(): T;
}

/** A config field can be a live ref (Host) or a plain value (tests/direct callers). */
export type ConfigValue<T> = T | ConfigRef<T> | undefined;

/**
 * The reviewer settings accepted by the host entry.
 *
 * `enabled` is accepted only so old configurations still validate; it is
 * deprecated and ignored (the plugin is always active). `fallbacks` is the
 * ordered optional fallback list; it is kept untyped here because
 * `./fallback.ts` owns its normalization. Everything is optional so tests and
 * direct callers may supply plain values while the Loader supplies volatile
 * refs.
 */
export interface ReviewerConfig {
  /** @deprecated Ignored; the plugin is always active. Kept for old configs. */
  enabled?: ConfigValue<boolean>;
  /**
   * Ordered reviewer routes. Every entry has the same shape and is tried in
   * order until one answers, so there is no separate "primary" route.
   */
  routes?: ConfigValue<unknown>;
  /** @deprecated Read only to migrate old configs into {@link routes}. */
  primaryEnabled?: ConfigValue<boolean>;
  /** @deprecated Read only to migrate old configs into {@link routes}. */
  provider?: ConfigValue<string>;
  /** @deprecated Read only to migrate old configs into {@link routes}. */
  model?: ConfigValue<string>;
  /** @deprecated Read only to migrate old configs into {@link routes}. */
  reasoningEffort?: ConfigValue<string>;
  /** @deprecated Read only to migrate old configs into {@link routes}. */
  fallbacks?: ConfigValue<unknown>;
}

/** Normalized reviewer settings read from one live config snapshot. */
export interface ReviewerSettings {
  /** @deprecated Ignored; retained so old configs keep validating. */
  enabled: boolean;
  /** Whether settings-list row 1 (the top-level route) is enabled. */
  primaryEnabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
}

/**
 * Whether one `llm/stream` request is the experimental auto-review call.
 *
 * Only the reviewer prompt is rewritten. Every other request, including other
 * hand-built one-shot calls that happen to start with the same first line, must
 * reach `next()` untouched.
 *
 * @param {unknown} options - candidate `GenerateOptions` value.
 * @returns {boolean} true when the fixed policy prefix and marker are present.
 */
export function isAutoReviewRequest(options: unknown): boolean {
  if (options === null || typeof options !== 'object') return false;
  const system = (options as { system?: unknown }).system;
  return (
    (options as { purpose?: unknown }).purpose === 'auto-review' &&
    typeof system === 'string' &&
    system.startsWith(REVIEW_POLICY_PREFIX) &&
    system.includes(REVIEW_POLICY_MARKER)
  );
}

/**
 * Normalize one configured reasoning effort.
 *
 * An empty value and the legacy `default` sentinel mean "omit the effort and
 * let the provider decide". The `inherit` sentinel is preserved so the Host can
 * resolve it against the intercepted review request's session (the settings UI
 * stores it for "inherit from the main session"). Every other trimmed token is
 * kept verbatim; the caller still has to prove that the target model advertises
 * it, because effort ids are adapter-owned rather than a fixed harness
 * vocabulary.
 *
 * @param {unknown} value - raw configured value.
 * @returns {string} a trimmed effort id, `''` for the provider default, or
 *   {@link INHERIT_EFFORT} for the inherit sentinel.
 */
export function normalizeEffort(value: unknown): string {
  if (value === undefined || value === null) return EFFORT_DEFAULT;
  const effort = String(value).trim();
  if (effort === EFFORT_DEFAULT || effort.toLowerCase() === 'default') return EFFORT_DEFAULT;
  if (effort.toLowerCase() === INHERIT_EFFORT) return INHERIT_EFFORT;
  return effort;
}

/**
 * Canonical rank of one effort id, or `undefined` when it has none.
 *
 * Matching is case-insensitive and trims whitespace. `default`/`inherit` are
 * sentinels, not ranks, so they return `undefined` (treated as absent).
 *
 * @param {string} effort - effort id to rank.
 * @returns the canonical rank, or `undefined` for an unknown/sentinel value.
 */
export function effortRank(effort: string): number | undefined {
  if (typeof effort !== 'string') return undefined;
  const key = effort.trim().toLowerCase();
  return Object.hasOwn(EFFORT_RANKS, key) ? EFFORT_RANKS[key] : undefined;
}

/**
 * Adapt an inherited session effort to the efforts a target route advertises.
 *
 * The inherited value was chosen for a different model, so it is mapped to the
 * nearest advertised rank: the smallest absolute rank distance wins, and a tie
 * is broken toward the HIGHER rank (a stronger reviewer rather than a weaker
 * one). An exact advertised match is used verbatim. A target that advertises
 * no ranked efforts falls back to the provider default (`''`) — the final
 * "Default" fallback — as does an inherited value with no canonical rank.
 *
 * @param {string} inherited - inherited session effort (may be the inherit
 *   sentinel, which resolves to no explicit effort).
 * @param {Iterable<string>} advertised - effort ids the target route advertises.
 * @returns the effort to send, or `''` for the provider default.
 */
export function adaptEffortToAdvertised(inherited: string, advertised: Iterable<string>): string {
  const inheritedEffort = normalizeEffort(inherited);
  if (inheritedEffort === EFFORT_DEFAULT || inheritedEffort === INHERIT_EFFORT) return EFFORT_DEFAULT;

  const candidates: string[] = [];
  for (const value of advertised) {
    const effort = typeof value === 'string' ? value.trim() : '';
    if (effort === '' || effort === INHERIT_EFFORT || effort.toLowerCase() === 'default') continue;
    if (effort === inheritedEffort) return inheritedEffort;
    candidates.push(effort);
  }

  const inheritedRank = effortRank(inheritedEffort);
  if (inheritedRank === undefined) return EFFORT_DEFAULT;

  let best = EFFORT_DEFAULT;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestRank = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const rank = effortRank(candidate);
    if (rank === undefined) continue;
    const distance = Math.abs(rank - inheritedRank);
    if (distance < bestDistance || (distance === bestDistance && rank > bestRank)) {
      best = candidate;
      bestDistance = distance;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Read one config entry. Loader config entries are volatile refs, but accepting
 * a plain value keeps this helper usable in tests and from direct callers.
 *
 * @param {unknown} entry - a ref-like value or a plain config value.
 * @returns {unknown} the current value.
 */
function readConfigValue<T>(entry: ConfigValue<T>): T | undefined {
  if (entry !== null && typeof entry === 'object' && typeof (entry as ConfigRef<T>).get === 'function') {
    return (entry as ConfigRef<T>).get();
  }
  return entry as T | undefined;
}

/**
 * Read the live reviewer settings (row 1 of the ordered route list).
 *
 * The host calls this once per intercepted request rather than caching a
 * snapshot, so a `loader/volatile-update` change takes effect on the very next
 * reviewer call without restarting the plugin. `enabled` is read only so old
 * shapes stay comparable in tests and diagnostics; the plugin never gates on
 * it.
 *
 * @param {object | undefined} config - injected config object of refs or values.
 * @returns the normalized row 1 settings plus the deprecated enabled flag.
 */
export function readReviewerSettings(config: ReviewerConfig | undefined): ReviewerSettings {
  const source = config ?? {};
  const provider = readConfigValue(source.provider);
  const model = readConfigValue(source.model);
  return {
    enabled: readConfigValue(source.enabled) !== false,
    primaryEnabled: readConfigValue(source.primaryEnabled) !== false,
    provider: provider === undefined || provider === null ? '' : String(provider).trim(),
    model: model === undefined || model === null ? '' : String(model).trim(),
    reasoningEffort: normalizeEffort(readConfigValue(source.reasoningEffort)),
  };
}

/**
 * Whether the complete primary route (settings-list row 1) should replace the
 * reviewer route.
 *
 * The deprecated `enabled` knob is intentionally ignored: the plugin is always
 * active. A disabled row 1 and an incomplete route are both not applied —
 * replacing only the provider or only the model would mix two unrelated routes.
 *
 * @param {{ primaryEnabled?: boolean, provider: string, model: string }} settings - live settings.
 * @returns {boolean} true when row 1 is enabled and complete.
 */
export function shouldOverrideRoute(
  settings: Pick<ReviewerSettings, 'provider' | 'model'> & { primaryEnabled?: boolean },
): boolean {
  return settings.primaryEnabled !== false && settings.provider !== '' && settings.model !== '';
}

/**
 * Build the model-capability cache key for one exact route.
 *
 * @param {string} provider - provider id.
 * @param {string} model - model id.
 * @returns {string} `provider\u0000model`.
 */
export function effortCacheKey(provider: string, model: string): string {
  return `${provider}${EFFORT_CACHE_SEPARATOR}${model}`;
}
