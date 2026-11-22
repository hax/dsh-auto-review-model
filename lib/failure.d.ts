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
export declare function isRecord(value: unknown): value is Readonly<Record<string, unknown>>;
/**
 * Provider-neutral failure codes shipped by the installed `@deepseek-ai/dsh-llm`
 * (0.2.2-rc.3 `src/error.ts` `LLM_FAILURE_CODES`).
 *
 * A wire code is only carried into a result when it is one of these exact
 * official tokens, so an arbitrary provider string — which is what a leaked
 * credential or an unbounded provider message looks like — is dropped instead
 * of being forwarded to the settings page or the review failure reason.
 */
export declare const KNOWN_FAILURE_CODES: ReadonlySet<string>;
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
export declare function normalizeFailureCode(value: unknown): string;
/**
 * Extract the valid HTTP status carried by failure facts or an `HTTP_<status>` code.
 *
 * @param code - normalized failure code.
 * @param status - reported HTTP status, if any.
 * @returns a valid HTTP status, or `undefined`.
 */
export declare function httpStatusOf(code: string, status: number | undefined): number | undefined;
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
export declare function readThrownFailure(error: unknown): FailureFacts;
/**
 * Extract provider-neutral facts from a terminal `finish` reason.
 *
 * @param reason - finish reason carried by the terminal stream chunk.
 * @returns failure facts for `error`/`aborted` finishes, else `undefined`.
 */
export declare function readFinishFailure(reason: unknown): FailureFacts | undefined;
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
export declare function readFinishFailureMessage(reason: unknown): string;
