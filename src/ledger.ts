/**
 * Measured review ledger: one append-only JSON line per intercepted review.
 *
 * Review routing fails silently by design: a failing route is replaced before the
 * caller sees anything, so without a trace there is no way to tell a healthy
 * review from one that fell back. The host writes one line per review, and the
 * settings page reads the same file back to show per-route health; both halves
 * live here so the record shape, the ISO-week rotation and the bounds exist in
 * exactly one place.
 *
 * Writing can never fail a review, and reading can never fail a page: every
 * filesystem error degrades to "no data" instead of throwing.
 *
 * @module @aghost-prj/dsh-auto-review-model/ledger
 */
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import type { ReviewRouteHealth, ReviewRouteHealthEntry } from './typert.contract.js';

/** Directory holding the captured review ledger. */
export const REVIEW_LEDGER_DIR = join(homedir(), '.dsh');

/** Largest ledger slice the health reader will load, in bytes. */
const HEALTH_MAX_BYTES = 16 * 1024 * 1024;

/** Largest number of per-route rows the health reader returns. */
export const HEALTH_MAX_ROUTES = 20;

/**
 * ISO-8601 week of one date, used to rotate the ledger once per week.
 *
 * Weekly rotation keeps one file small enough to read and one week of reviews in
 * a single place, which is the granularity the cost study compares at.
 *
 * @param date - moment whose ISO week is wanted.
 * @returns the ISO week-numbering year and the week number inside it.
 */
export function isoWeekOf(date: Date): { year: number; week: number } {
  const shifted = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = shifted.getUTCDay() || 7;
  shifted.setUTCDate(shifted.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(shifted.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((shifted.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: shifted.getUTCFullYear(), week };
}

/** Stable `YYYY-Www` identifier of one ISO week. */
export function isoWeekId(date: Date): string {
  const { year, week } = isoWeekOf(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Absolute ledger path for one moment, rotated by ISO week. */
export function reviewLedgerPath(now: Date = new Date()): string {
  return join(REVIEW_LEDGER_DIR, `auto-review-ledger-${isoWeekId(now)}.jsonl`);
}

/** Whether ledger capture is enabled (`DSH_AUTO_REVIEW_LEDGER=0` disables it). */
export function ledgerEnabled(): boolean {
  return process.env['DSH_AUTO_REVIEW_LEDGER'] !== '0';
}

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

/** Week whose sealed predecessor has already been checked, to avoid restatting per write. */
let sealedWeek: string | undefined;

/**
 * Compress the previous ISO week's ledger once it is no longer being appended to.
 *
 * The current week stays a plain append-only `.jsonl` so it can be tailed while a
 * review is happening. Once a new week starts, the finished file is immutable, so
 * a single whole-file Zstandard frame is both cheaper and denser than the
 * concatenated frames the session backend needs for live appends.
 *
 * @param now - current clock value.
 */
function sealPreviousWeek(now: Date): void {
  const currentId = isoWeekId(now);
  if (sealedWeek === currentId) return;
  sealedWeek = currentId;
  try {
    const previous = new Date(now.getTime());
    previous.setUTCDate(previous.getUTCDate() - 7);
    const plain = join(REVIEW_LEDGER_DIR, `auto-review-ledger-${isoWeekId(previous)}.jsonl`);
    if (!existsSync(plain)) return;
    const compressed = zstdCompressSync(readFileSync(plain));
    writeFileSync(`${plain}.zst`, compressed);
    rmSync(plain);
  } catch {
    // Sealing is housekeeping: a failure keeps the plain file for the next attempt.
  }
}

/**
 * Append one review record to this week's ledger.
 *
 * @param record - measured review record.
 */
export function writeLedger(record: ReviewLedgerRecord): void {
  if (!ledgerEnabled()) return;
  try {
    const now = new Date();
    sealPreviousWeek(now);
    appendFileSync(reviewLedgerPath(now), `${JSON.stringify(record)}\n`);
  } catch {
    // Ledger capture must never affect a review.
  }
}

/** Mutable accumulation of one route's measured attempts. */
interface RouteAccumulator {
  provider: string;
  model: string;
  attempts: number;
  answered: number;
  failed: number;
  totalMs: number;
  lastAt: number;
  lastFailureCode: string;
}

/** Parsed record shape guard: only objects with a numeric `t` count. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Split one `provider/model` attempt label without assuming either half. */
function splitRoute(label: string): { provider: string; model: string } {
  const slash = label.indexOf('/');
  if (slash <= 0) return { provider: label, model: '' };
  return { provider: label.slice(0, slash), model: label.slice(slash + 1) };
}

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
export function readReviewHealth(now: Date = new Date()): ReviewRouteHealth {
  const week = isoWeekId(now);
  const path = reviewLedgerPath(now);
  const empty: ReviewRouteHealth = { ledger: basename(path), week, records: 0, routes: [] };
  let text: string;
  let size = 0;
  try {
    const stats = statSync(path);
    size = stats.size;
    // Only the tail matters when the week grew past the read bound: the newest
    // records are the ones a settings page should summarize.
    const start = Math.max(0, size - HEALTH_MAX_BYTES);
    const buffer = readFileSync(path);
    text = buffer.subarray(start).toString('utf8');
    if (start > 0) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak < 0 ? '' : text.slice(firstBreak + 1);
    }
  } catch {
    return empty;
  }

  const routes = new Map<string, RouteAccumulator>();
  let records = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record === undefined || typeof record['t'] !== 'number' || !Array.isArray(record['attempts'])) continue;
    const at = record['t'];
    const attempts = record['attempts'] as unknown[];
    let counted = false;
    for (const raw of attempts) {
      const attempt = asRecord(raw);
      if (attempt === undefined || typeof attempt['route'] !== 'string') continue;
      const { provider, model } = splitRoute(attempt['route']);
      const key = `${provider}\u0000${model}`;
      let row = routes.get(key);
      if (row === undefined) {
        row = { provider, model, attempts: 0, answered: 0, failed: 0, totalMs: 0, lastAt: 0, lastFailureCode: '' };
        routes.set(key, row);
      }
      counted = true;
      row.attempts += 1;
      const ms = attempt['ms'];
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) row.totalMs += ms;
      if (attempt['ok'] === true) {
        row.answered += 1;
      } else {
        row.failed += 1;
        const code = attempt['code'];
        if (typeof code === 'string' && code !== '') row.lastFailureCode = code;
      }
      if (at > row.lastAt) row.lastAt = at;
    }
    if (counted) records += 1;
  }

  const rows: ReviewRouteHealthEntry[] = [...routes.values()]
    .sort((left, right) => right.attempts - left.attempts || left.provider.localeCompare(right.provider))
    .slice(0, HEALTH_MAX_ROUTES)
    .map(row => ({
      provider: row.provider,
      model: row.model,
      attempts: row.attempts,
      answered: row.answered,
      failed: row.failed,
      avgMs: row.attempts === 0 ? 0 : Math.round(row.totalMs / row.attempts),
      lastAt: row.lastAt,
      lastFailureCode: row.lastFailureCode,
    }));
  return { ledger: basename(path), week, records, routes: rows };
}
