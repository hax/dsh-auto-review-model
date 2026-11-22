/**
 * Provider-neutral failure facts for `@aghost-prj/dsh-auto-review-model`.
 *
 * The installed `@deepseek-ai/dsh-llm` classifies every adapter failure with a
 * stable `LLM_FAILURE_CODES` token (plus a `HTTP_<status>` token for
 * unclassified HTTP rejections). This module keeps that taxonomy as a static,
 * dependency-free copy — the package deliberately imports no Harness runtime —
 * and reduces arbitrary thrown values / terminal `finish` reasons to just the
 * stable `code` and a valid `status`.
 *
 * Messages, causes, request ids, and every other provider payload are dropped
 * here on purpose: callers use these facts for classification. The fallback
 * aggregator reads provider messages separately and surfaces them verbatim,
 * like official Auto review; the saved-route probe never returns provider prose.
 *
 * Shared by `./route-test.ts` (saved-route probe) and `./fallback.ts`
 * (multi-level fallback policy) so both faces agree on one taxonomy.
 *
 * @module @aghost-prj/dsh-auto-review-model/failure
 */

/** A JSON object, not an array or `null`. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Provider-neutral failure codes shipped by the installed `@deepseek-ai/dsh-llm`
 * (0.2.2-rc.3 `src/error.ts` `LLM_FAILURE_CODES`).
 *
 * A wire code is only carried into a result when it is one of these exact
 * official tokens, so an arbitrary provider string — which is what a leaked
 * credential or an unbounded provider message looks like — is dropped instead
 * of being forwarded to the settings page or the review failure reason.
 */
export const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ABORTED',
  'ACCOUNT_QUOTA',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
  'AUTH',
  'CLIENT_UPGRADE_REQUIRED',
  'CONTEXT_WINDOW_EXCEEDED',
  'DISCOVERY_FAILED',
  'DISCOVERY_UNSUPPORTED',
  'DUPLICATE_ADAPTER',
  'DUPLICATE_DIRECTORY',
  'DUPLICATE_DISCOVERY',
  'EMPTY_RESPONSE',
  'FILES_API',
  'IMAGE_OFFLOAD_REQUIRED',
  'INVALID_ADAPTER',
  'INVALID_CATALOG',
  'INVALID_CONFIG',
  'INVALID_CREDENTIAL',
  'INVALID_DIRECTORY',
  'INVALID_DISCOVERY',
  'INVALID_MODEL_CONTEXT',
  'INVALID_MODEL_INFO',
  'INVALID_MODEL_MAX_TOKENS',
  'INVALID_MODEL_REASONING',
  'INVALID_PREPARED_CALL',
  'INVALID_REPLAY_STATE',
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'MALFORMED_RESPONSE',
  'MISSING_CREDENTIAL',
  'MODEL_SWITCH_COMPACTION_FAILED',
  'MODEL_UNSUPPORTED',
  'NO_ADAPTER',
  'NO_CREDENTIAL_STORE',
  'NO_DISCOVERY',
  'PI_AI_ERROR',
  'QUOTA',
  'RATE_LIMIT',
  'REGISTRATION_DISPOSED',
  'REQUEST_EXTENSION',
  'REQUEST_HEADERS',
  'SERVER',
  'STREAM_CLOSED',
  'TIMEOUT',
  'TRANSPORT',
  'UNKNOWN',
  'UNKNOWN_MODEL',
  'UNSTORABLE_PROVIDER_ID',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OPTION',
  'UNSUPPORTED_REASONING_EFFORT',
]);

/** Official shape for an unclassified provider HTTP status (`HTTP_<100..599>`). */
const HTTP_FAILURE_CODE_PATTERN = /^HTTP_[1-5]\d{2}$/;

/**
 * Keep one wire failure code only when it is an official provider-neutral code.
 *
 * Codes are opaque provider values, so only the exact `LLM_FAILURE_CODES`
 * vocabulary shipped by the installed Harness, or a valid `HTTP_<status>`
 * token, is accepted. Every other token — including an uppercase
 * `SECRET_TOKEN_12345`-shaped string — becomes `''` so it can never reach a
 * wire result, a settings page, or a review failure reason.
 *
 * @param value - raw provider-neutral failure code.
 * @returns the accepted official token, or `''`.
 */
export function normalizeFailureCode(value: unknown): string {
  if (typeof value !== 'string') return '';
  const code = value.trim().toUpperCase();
  if (KNOWN_FAILURE_CODES.has(code)) return code;
  if (HTTP_FAILURE_CODE_PATTERN.test(code)) {
    const status = Number(code.slice('HTTP_'.length));
    if (status >= 100 && status <= 599) return code;
  }
  return '';
}

/**
 * Extract the valid HTTP status carried by failure facts or an `HTTP_<status>` code.
 *
 * @param code - normalized failure code.
 * @param status - reported HTTP status, if any.
 * @returns a valid HTTP status, or `undefined`.
 */
export function httpStatusOf(code: string, status: number | undefined): number | undefined {
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    return status;
  }
  const match = /^HTTP_(\d{3})$/.exec(code);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

/** Provider-neutral failure facts observed on the wire; prose is never kept. */
export interface FailureFacts {
  /** Official provider-neutral failure code (or `HTTP_<status>`), `''` when none was recognized. */
  code: string;
  /** HTTP status accompanying the failure, when valid. */
  status?: number;
}

/**
 * Extract provider-neutral facts from an arbitrary thrown value.
 *
 * Only the stable `code` and a valid HTTP status are retained; messages, causes,
 * request ids, and any other provider payload are deliberately dropped so they
 * cannot reach a result.
 *
 * @param error - caught rejection reason.
 * @returns classified failure facts; `code: ''` when nothing stable was carried.
 */
export function readThrownFailure(error: unknown): FailureFacts {
  if (isRecord(error)) {
    const failure = isRecord(error.failure) ? error.failure : undefined;
    const rawCode = typeof error.code === 'string'
      ? error.code
      : failure !== undefined && typeof failure.code === 'string'
        ? failure.code
        : '';
    const rawStatus = typeof error.status === 'number'
      ? error.status
      : failure !== undefined && typeof failure.status === 'number'
        ? failure.status
        : undefined;
    const code = normalizeFailureCode(rawCode);
    const status = httpStatusOf(code, rawStatus);
    if (code !== '' || status !== undefined) {
      return status === undefined ? { code } : { code, status };
    }
    if (error.name === 'AbortError') return { code: 'ABORTED' };
  }
  return { code: '' };
}

/**
 * Extract provider-neutral facts from a terminal `finish` reason.
 *
 * @param reason - finish reason carried by the terminal stream chunk.
 * @returns failure facts for `error`/`aborted` finishes, else `undefined`.
 */
export function readFinishFailure(reason: unknown): FailureFacts | undefined {
  if (!isRecord(reason)) return undefined;
  if (reason.kind !== 'error' && reason.kind !== 'aborted') return undefined;
  const failure = isRecord(reason.failure) ? readThrownFailure(reason.failure) : { code: '' };
  if (reason.kind === 'aborted' && failure.code === '') return { code: 'ABORTED' };
  return failure;
}

/**
 * Read the human-readable message carried by a terminal `finish` failure.
 *
 * The value is raw provider prose. The fallback aggregator surfaces it verbatim
 * in the review failure reason, matching official Auto review; the saved-route
 * probe never forwards it to the browser.
 *
 * @param reason - terminal `finish` reason.
 * @returns the raw message, or `''`.
 */
export function readFinishFailureMessage(reason: unknown): string {
  if (!isRecord(reason) || !isRecord(reason.failure)) return '';
  const message = reason.failure.message;
  return typeof message === 'string' ? message : '';
}
