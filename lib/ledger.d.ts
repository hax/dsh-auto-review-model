import type { ReviewRouteHealth } from './typert.contract.js';
/** Directory holding the captured review ledger. */
export declare const REVIEW_LEDGER_DIR: string;
/** Largest number of per-route rows the health reader returns. */
export declare const HEALTH_MAX_ROUTES = 20;
/**
 * ISO-8601 week of one date, used to rotate the ledger once per week.
 *
 * Weekly rotation keeps one file small enough to read and one week of reviews in
 * a single place, which is the granularity the cost study compares at.
 *
 * @param date - moment whose ISO week is wanted.
 * @returns the ISO week-numbering year and the week number inside it.
 */
export declare function isoWeekOf(date: Date): {
    year: number;
    week: number;
};
/** Stable `YYYY-Www` identifier of one ISO week. */
export declare function isoWeekId(date: Date): string;
/** Absolute ledger path for one moment, rotated by ISO week. */
export declare function reviewLedgerPath(now?: Date): string;
/** Whether ledger capture is enabled (`DSH_AUTO_REVIEW_LEDGER=0` disables it). */
export declare function ledgerEnabled(): boolean;
/** One measured attempt inside a review record. */
export interface ReviewLedgerAttempt {
    /** `provider/model` of the attempted route. */
    route?: unknown;
    /** Reasoning effort sent with the attempt. */
    effort?: unknown;
    /** `route` for an explicit attempt, `session` for the implicit final one. */
    mode?: unknown;
    /** Wall-clock duration of the attempt. */
    ms?: unknown;
    /** Whether the attempt produced the review decision. */
    ok?: unknown;
    /** Provider-neutral failure code, present on a failed attempt. */
    code?: unknown;
    /** Short failure detail, present on a failed attempt. */
    detail?: unknown;
    /** A structural event row (`sticky-failed-restart-from-top`) carries only `event`. */
    event?: unknown;
}
/** One ledger line; every numeric field is measured, never reconstructed. */
export interface ReviewLedgerRecord {
    /** Record schema version. */
    v: 1;
    /** Epoch milliseconds when the review started. */
    t: number;
    /** ISO timestamp of {@link t}. */
    local: string;
    /** Session id that issued the review. */
    sid?: string;
    /** Total review duration. */
    totalMs: number;
    /** Whether more than one attempt ran. */
    fallback: boolean;
    /** Sticky route the session started from, when one was remembered. */
    stickyUsed?: string;
    /** Ordered attempts, including failure rows. */
    attempts: ReviewLedgerAttempt[];
    /** Route that produced the decision. */
    winner?: string;
}
/**
 * Append one review record to this week's ledger.
 *
 * @param record - measured review record.
 */
export declare function writeLedger(record: ReviewLedgerRecord): void;
/**
 * Aggregate one week of ledger lines into per-route health.
 *
 * The numbers are exactly what the host measured: attempts, successes, failures,
 * mean duration and the last failure code. A route that was never tried has no
 * row, so the caller can show "no reviews yet" instead of a fake 0%.
 *
 * @param now - moment whose ISO week should be read.
 * @returns the health snapshot; empty when the file is absent or unreadable.
 */
export declare function readReviewHealth(now?: Date): ReviewRouteHealth;
