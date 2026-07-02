import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { AnchorStatus, type AnchorRecord, type AttemptRecord } from '../types.js';

/**
 * Persistence boundary. The service depends on this interface, not on SQLite,
 * so the backend is swappable (e.g. Postgres in production) without touching
 * the anchoring logic.
 */
export interface Store {
  /** Insert if the client_tx_id is new; otherwise return the existing row. Idempotent. */
  insertAnchorIfAbsent(a: AnchorRecord): AnchorRecord;
  getAnchor(anchorId: string): AnchorRecord | null;
  getAnchorByClientTxId(clientTxId: string): AnchorRecord | null;
  getAnchorByProofGeneration(proofHash: string, generation: number): AnchorRecord | null;
  updateAnchor(anchorId: string, patch: Partial<AnchorRecord>): void;
  /**
   * Atomically point an anchor at a new active attempt, but ONLY if its current
   * active attempt is exactly `expected` (compare-and-swap). Returns true if THIS
   * caller won. This is the cross-process guard that makes "anchor exactly once"
   * hold between separate worker processes, not just within one event loop.
   */
  claimAnchor(anchorId: string, next: string | null, expected: string | null): boolean;
  /**
   * Atomically (one transaction) compare-and-swap active_attempt_id from `expected`
   * to the new attempt AND insert that attempt row. Returns true only if the CAS won.
   * This closes the window where active_attempt_id could point at an attempt row that
   * does not exist yet — which let a concurrent rebuild steal the claim and double-anchor.
   */
  claimAndInsertAttempt(anchorId: string, expected: string | null, a: AttemptRecord): boolean;
  /** All anchors for a proof, ordered by generation (the receipt lineage). */
  listLineage(proofHash: string): AnchorRecord[];

  insertAttempt(a: AttemptRecord): void;
  getAttempt(attemptId: string): AttemptRecord | null;
  updateAttempt(attemptId: string, patch: Partial<AttemptRecord>): void;

  /** Register an anchoring account with the next tx sequence number to hand out. */
  initAccount(accountId: string, nextSequence: string): void;
  /** True if the account is already registered with the sequence allocator. */
  hasAccount(accountId: string): boolean;
  /** Force the next tx sequence (used to re-sync the allocator from on-chain state). */
  setSequence(accountId: string, nextSequence: string): void;
  /** Atomically reserve and return the next tx sequence number for an account. */
  reserveSequence(accountId: string): string;
  /**
   * Highest sequence number still held by a LIVE (pending/submitted) attempt on this
   * account, or null if none. An on-chain resync must never reset BELOW this, or it
   * would reissue a sequence a concurrent in-flight tx already reserved.
   */
  maxInFlightSequence(accountId: string): string | null;

  /**
   * Atomically confirm the active ATTEMPT, confirm the child anchor, AND supersede
   * its parent (if any) — all in one SQLite transaction. If the process crashes
   * after COMMIT, all three effects are durable; if it crashes before COMMIT, none
   * is visible (closing the attempt-confirmed-but-anchor-still-submitted window).
   * The child UPDATE uses `WHERE status IN ('pending','submitted')` and the parent
   * UPDATE uses `WHERE status='confirmed'`, so a replay (e.g. reconcile re-running)
   * can never regress a terminal anchor or double-supersede.
   */
  confirmAndSupersede(
    childId: string,
    attemptId: string,
    parentId: string | null,
    ledgerSeq: number,
    receiptJson: string,
    confirmedAt: string,
  ): void;

  /**
   * Atomically re-sync the sequence allocator and reserve the next sequence number,
   * all inside one BEGIN IMMEDIATE transaction. The reserved value is
   * max(onChainNext, maxInFlight+1) — the chain's next sequence, lifted above any
   * sequence a LIVE (pending/submitted) attempt still holds, so a dead (expired/failed)
   * slot is reclaimed (Stellar needs a gap-free line) but a live one is never reissued.
   * The durable counter only moves FORWARD: a resync may reserve below it to reclaim a
   * dead slot, but never rolls it back, so a concurrent reserve()'s increment is not lost.
   */
  syncThenReserve(accountId: string, onChainNext: bigint): string;

  close(): void;
}

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

type AnchorRow = {
  anchor_id: string;
  proof_id: string;
  proof_hash: string;
  anchor_generation: number;
  parent_anchor_id: string | null;
  client_tx_id: string;
  status: string;
  error_class: string | null;
  reason: string | null;
  active_attempt_id: string | null;
  ledger_seq: number | null;
  receipt_json: string | null;
  created_at: string;
  confirmed_at: string | null;
};

type AttemptRow = {
  attempt_id: string;
  anchor_id: string;
  tx_hash: string | null;
  tx_xdr: string;
  source_account: string;
  sequence_number: string;
  min_time: number;
  max_time: number;
  status: string;
  error_class: string | null;
  last_error: string | null;
  submitted_at: string | null;
  created_at: string;
};

function rowToAnchor(r: AnchorRow): AnchorRecord {
  return {
    anchorId: r.anchor_id,
    proofId: r.proof_id,
    proofHash: r.proof_hash,
    anchorGeneration: r.anchor_generation,
    parentAnchorId: r.parent_anchor_id,
    clientTxId: r.client_tx_id,
    status: r.status as AnchorRecord['status'],
    errorClass: r.error_class as AnchorRecord['errorClass'],
    reason: r.reason,
    activeAttemptId: r.active_attempt_id,
    ledgerSeq: r.ledger_seq,
    receiptJson: r.receipt_json,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
  };
}

function rowToAttempt(r: AttemptRow): AttemptRecord {
  return {
    attemptId: r.attempt_id,
    anchorId: r.anchor_id,
    txHash: r.tx_hash,
    txXdr: r.tx_xdr,
    sourceAccount: r.source_account,
    sequenceNumber: r.sequence_number,
    minTime: r.min_time,
    maxTime: r.max_time,
    status: r.status as AttemptRecord['status'],
    errorClass: r.error_class as AttemptRecord['errorClass'],
    lastError: r.last_error,
    submittedAt: r.submitted_at,
    createdAt: r.created_at,
  };
}

/** Map camelCase record fields to snake_case columns for UPDATE statements. */
const ANCHOR_COLS: Record<string, string> = {
  proofId: 'proof_id',
  proofHash: 'proof_hash',
  anchorGeneration: 'anchor_generation',
  parentAnchorId: 'parent_anchor_id',
  clientTxId: 'client_tx_id',
  status: 'status',
  errorClass: 'error_class',
  reason: 'reason',
  activeAttemptId: 'active_attempt_id',
  ledgerSeq: 'ledger_seq',
  receiptJson: 'receipt_json',
  createdAt: 'created_at',
  confirmedAt: 'confirmed_at',
};

const ATTEMPT_COLS: Record<string, string> = {
  txHash: 'tx_hash',
  txXdr: 'tx_xdr',
  sourceAccount: 'source_account',
  sequenceNumber: 'sequence_number',
  minTime: 'min_time',
  maxTime: 'max_time',
  status: 'status',
  errorClass: 'error_class',
  lastError: 'last_error',
  submittedAt: 'submitted_at',
  createdAt: 'created_at',
};

export class SqliteStore implements Store {
  private readonly db: Database.Database;

  constructor(filename = ':memory:') {
    if (filename !== ':memory:' && filename !== '') {
      mkdirSync(dirname(filename), { recursive: true }); // ensure the parent dir exists
    }
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  }

  insertAnchorIfAbsent(a: AnchorRecord): AnchorRecord {
    this.db
      .prepare(
        `INSERT INTO anchors (
           anchor_id, proof_id, proof_hash, anchor_generation, parent_anchor_id,
           client_tx_id, status, error_class, reason, active_attempt_id,
           ledger_seq, receipt_json, created_at, confirmed_at
         ) VALUES (
           @anchor_id, @proof_id, @proof_hash, @anchor_generation, @parent_anchor_id,
           @client_tx_id, @status, @error_class, @reason, @active_attempt_id,
           @ledger_seq, @receipt_json, @created_at, @confirmed_at
         )
         ON CONFLICT DO NOTHING`, // absorbs a conflict on EITHER unique (client_tx_id or proof+gen)
      )
      .run({
        anchor_id: a.anchorId,
        proof_id: a.proofId,
        proof_hash: a.proofHash,
        anchor_generation: a.anchorGeneration,
        parent_anchor_id: a.parentAnchorId,
        client_tx_id: a.clientTxId,
        status: a.status,
        error_class: a.errorClass,
        reason: a.reason,
        active_attempt_id: a.activeAttemptId,
        ledger_seq: a.ledgerSeq,
        receipt_json: a.receiptJson,
        created_at: a.createdAt,
        confirmed_at: a.confirmedAt,
      });
    // Return the surviving row by whichever unique it collided on (idempotent either way).
    return (
      this.getAnchorByClientTxId(a.clientTxId) ??
      this.getAnchorByProofGeneration(a.proofHash, a.anchorGeneration)!
    );
  }

  getAnchor(anchorId: string): AnchorRecord | null {
    const row = this.db
      .prepare('SELECT * FROM anchors WHERE anchor_id = ?')
      .get(anchorId) as AnchorRow | undefined;
    return row ? rowToAnchor(row) : null;
  }

  getAnchorByClientTxId(clientTxId: string): AnchorRecord | null {
    const row = this.db
      .prepare('SELECT * FROM anchors WHERE client_tx_id = ?')
      .get(clientTxId) as AnchorRow | undefined;
    return row ? rowToAnchor(row) : null;
  }

  getAnchorByProofGeneration(proofHash: string, generation: number): AnchorRecord | null {
    const row = this.db
      .prepare('SELECT * FROM anchors WHERE proof_hash = ? AND anchor_generation = ?')
      .get(proofHash, generation) as AnchorRow | undefined;
    return row ? rowToAnchor(row) : null;
  }

  updateAnchor(anchorId: string, patch: Partial<AnchorRecord>): void {
    // Immutability guard (defense in depth): once an anchor reaches a terminal state
    // (confirmed OR superseded) its RECEIPT is frozen. The only status move allowed out
    // of a terminal state is confirmed→superseded (re-anchor); a downgrade, or
    // superseded→confirmed (which would resurrect a retired generation), is dropped.
    // The error class is intentionally NOT frozen — a confirmed anchor whose tx later
    // vanishes is flagged testnet_reset_suspected.
    let effective = patch;
    const current = this.getAnchor(anchorId);
    const terminal =
      current &&
      (current.status === AnchorStatus.Confirmed || current.status === AnchorStatus.Superseded);
    if (terminal) {
      effective = { ...patch };
      if ('status' in effective) {
        const to = effective.status;
        const ok =
          to === current.status ||
          (current.status === AnchorStatus.Confirmed && to === AnchorStatus.Superseded);
        if (!ok) delete effective.status;
      }
      delete effective.receiptJson;
      delete effective.ledgerSeq;
      delete effective.confirmedAt;
    }

    const sets: string[] = [];
    const params: Record<string, unknown> = { anchor_id: anchorId };
    for (const [key, value] of Object.entries(effective)) {
      const col = ANCHOR_COLS[key];
      if (!col) continue;
      sets.push(`${col} = @${col}`);
      params[col] = value ?? null;
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE anchors SET ${sets.join(', ')} WHERE anchor_id = @anchor_id`)
      .run(params);
  }

  claimAnchor(anchorId: string, next: string | null, expected: string | null): boolean {
    // `IS @expected` matches NULL when expected is null and the exact id otherwise,
    // so one statement serves both first-claim (expected=null) and rebuild swaps.
    const res = this.db
      .prepare(
        `UPDATE anchors SET active_attempt_id = @next
           WHERE anchor_id = @anchor_id AND active_attempt_id IS @expected`,
      )
      .run({ next, anchor_id: anchorId, expected });
    return res.changes === 1;
  }

  claimAndInsertAttempt(anchorId: string, expected: string | null, a: AttemptRecord): boolean {
    const txn = this.db.transaction((): boolean => {
      const res = this.db
        .prepare(
          `UPDATE anchors SET active_attempt_id = @next
             WHERE anchor_id = @anchor_id AND active_attempt_id IS @expected`,
        )
        .run({ next: a.attemptId, anchor_id: anchorId, expected });
      if (res.changes !== 1) return false; // lost the CAS — do NOT insert the attempt
      this.insertAttempt(a); // same transaction → active_attempt_id never points at a missing row
      return true;
    });
    return txn();
  }

  listLineage(proofHash: string): AnchorRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM anchors WHERE proof_hash = ? ORDER BY anchor_generation ASC')
      .all(proofHash) as AnchorRow[];
    return rows.map(rowToAnchor);
  }

  insertAttempt(a: AttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO anchor_attempts (
           attempt_id, anchor_id, tx_hash, tx_xdr, source_account, sequence_number,
           min_time, max_time, status, error_class, last_error, submitted_at, created_at
         ) VALUES (
           @attempt_id, @anchor_id, @tx_hash, @tx_xdr, @source_account, @sequence_number,
           @min_time, @max_time, @status, @error_class, @last_error, @submitted_at, @created_at
         )`,
      )
      .run({
        attempt_id: a.attemptId,
        anchor_id: a.anchorId,
        tx_hash: a.txHash,
        tx_xdr: a.txXdr,
        source_account: a.sourceAccount,
        sequence_number: a.sequenceNumber,
        min_time: a.minTime,
        max_time: a.maxTime,
        status: a.status,
        error_class: a.errorClass,
        last_error: a.lastError,
        submitted_at: a.submittedAt,
        created_at: a.createdAt,
      });
  }

  getAttempt(attemptId: string): AttemptRecord | null {
    const row = this.db
      .prepare('SELECT * FROM anchor_attempts WHERE attempt_id = ?')
      .get(attemptId) as AttemptRow | undefined;
    return row ? rowToAttempt(row) : null;
  }

  updateAttempt(attemptId: string, patch: Partial<AttemptRecord>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { attempt_id: attemptId };
    for (const [key, value] of Object.entries(patch)) {
      const col = ATTEMPT_COLS[key];
      if (!col) continue;
      sets.push(`${col} = @${col}`);
      params[col] = value ?? null;
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE anchor_attempts SET ${sets.join(', ')} WHERE attempt_id = @attempt_id`)
      .run(params);
  }

  initAccount(accountId: string, nextSequence: string): void {
    this.db
      .prepare(
        `INSERT INTO source_accounts (account_id, next_sequence) VALUES (?, ?)
         ON CONFLICT (account_id) DO NOTHING`,
      )
      .run(accountId, nextSequence);
  }

  hasAccount(accountId: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM source_accounts WHERE account_id = ?').get(accountId) !==
      undefined
    );
  }

  setSequence(accountId: string, nextSequence: string): void {
    this.db
      .prepare(
        `INSERT INTO source_accounts (account_id, next_sequence) VALUES (?, ?)
         ON CONFLICT (account_id) DO UPDATE SET next_sequence = excluded.next_sequence`,
      )
      .run(accountId, nextSequence);
  }

  /**
   * Reserve the next sequence number atomically. better-sqlite3 is synchronous, and
   * this is a read-then-write transaction — it MUST run as BEGIN IMMEDIATE (.immediate),
   * not the default deferred mode. A deferred transaction takes its write lock late, so
   * two concurrent reservers can both read the same snapshot and the loser fails with a
   * non-retryable SQLITE_BUSY_SNAPSHOT instead of being serialized by busy_timeout.
   */
  reserveSequence(accountId: string): string {
    const txn = this.db.transaction((id: string): string => {
      const row = this.db
        .prepare('SELECT next_sequence FROM source_accounts WHERE account_id = ?')
        .get(id) as { next_sequence: string } | undefined;
      if (!row) {
        throw new Error(`Unknown anchoring account: ${id}. Call initAccount() first.`);
      }
      const reserved = BigInt(row.next_sequence);
      const next = (reserved + 1n).toString();
      this.db
        .prepare('UPDATE source_accounts SET next_sequence = ? WHERE account_id = ?')
        .run(next, id);
      return reserved.toString();
    });
    return txn.immediate(accountId);
  }

  maxInFlightSequence(accountId: string): string | null {
    // i64 sequence numbers are stored as text; compare with BigInt, not SQLite MAX.
    const rows = this.db
      .prepare(
        `SELECT sequence_number FROM anchor_attempts
           WHERE source_account = ? AND status IN ('pending', 'submitted')`,
      )
      .all(accountId) as { sequence_number: string }[];
    let max: bigint | null = null;
    for (const { sequence_number } of rows) {
      const s = BigInt(sequence_number);
      if (max === null || s > max) max = s;
    }
    return max === null ? null : max.toString();
  }

  confirmAndSupersede(
    childId: string,
    attemptId: string,
    parentId: string | null,
    ledgerSeq: number,
    receiptJson: string,
    confirmedAt: string,
  ): void {
    const txn = this.db.transaction(
      (cId: string, aId: string, pId: string | null, ls: number, rj: string, ca: string): void => {
        this.db
          .prepare(`UPDATE anchor_attempts SET status='confirmed' WHERE attempt_id=?`)
          .run(aId);
        // `status IN ('pending','submitted')` makes the child confirm non-regressing:
        // a replayed confirm on an already-terminal (confirmed/superseded) anchor is a
        // no-op, so reconcile re-running can never resurrect a superseded generation.
        this.db
          .prepare(
            `UPDATE anchors SET status='confirmed', ledger_seq=?, receipt_json=?,
                confirmed_at=?, error_class=NULL
                WHERE anchor_id=? AND status IN ('pending','submitted')`,
          )
          .run(ls, rj, ca, cId);
        if (pId !== null) {
          this.db
            .prepare(
              `UPDATE anchors SET status='superseded'
                 WHERE anchor_id=? AND status='confirmed'`,
            )
            .run(pId);
        }
      },
    );
    txn(childId, attemptId, parentId, ledgerSeq, receiptJson, confirmedAt);
  }

  syncThenReserve(accountId: string, onChainNext: bigint): string {
    const txn = this.db.transaction((id: string, chainNext: string): string => {
      const acct = this.db
        .prepare('SELECT next_sequence FROM source_accounts WHERE account_id = ?')
        .get(id) as { next_sequence: string } | undefined;
      const stored = acct ? BigInt(acct.next_sequence) : 0n;
      const rows = this.db
        .prepare(
          `SELECT sequence_number FROM anchor_attempts
             WHERE source_account = ? AND status IN ('pending', 'submitted')`,
        )
        .all(id) as { sequence_number: string }[];
      let maxLive: bigint | null = null;
      for (const { sequence_number } of rows) {
        const s = BigInt(sequence_number);
        if (maxLive === null || s > maxLive) maxLive = s;
      }
      const chain = BigInt(chainNext);
      // Reclaim floor: the chain's next sequence, lifted above any LIVE in-flight one.
      const reserved = maxLive !== null && maxLive + 1n > chain ? maxLive + 1n : chain;
      // The durable counter never regresses: a reclaim may reserve below `stored`, but
      // we keep `stored` if it is already ahead so a concurrent reserve() is not clobbered.
      const next = reserved + 1n > stored ? reserved + 1n : stored;
      this.db
        .prepare(
          `INSERT INTO source_accounts (account_id, next_sequence) VALUES (?, ?)
           ON CONFLICT (account_id) DO UPDATE SET next_sequence = ?`,
        )
        .run(id, next.toString(), next.toString());
      return reserved.toString();
    });
    return txn.immediate(accountId, onChainNext.toString());
  }

  close(): void {
    this.db.close();
  }
}
