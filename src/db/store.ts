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
    // Immutability guard (defense in depth): once an anchor is confirmed its RECEIPT is
    // terminal. Allow only confirmed→superseded (re-anchor); never downgrade the status
    // or overwrite the receipt/ledger/confirmed_at. The error class is intentionally NOT
    // frozen — a confirmed anchor whose tx later vanishes is flagged testnet_reset_suspected.
    let effective = patch;
    const current = this.getAnchor(anchorId);
    if (current && current.status === AnchorStatus.Confirmed) {
      effective = { ...patch };
      if (
        'status' in effective &&
        effective.status !== AnchorStatus.Superseded &&
        effective.status !== AnchorStatus.Confirmed
      ) {
        delete effective.status;
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
   * Reserve the next sequence number atomically. better-sqlite3 is synchronous,
   * and wrapping the read-then-write in a transaction (BEGIN IMMEDIATE) makes the
   * allocation safe across concurrent workers/processes sharing the database.
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
    return txn(accountId);
  }

  close(): void {
    this.db.close();
  }
}
