/**
 * Domain types for the proof-anchoring flow.
 *
 * Two concepts are deliberately separated:
 *  - business STATUS (the lifecycle of a logical anchor), and
 *  - ERROR CLASS (why an attempt did not confirm).
 * A transient infrastructure problem must never be recorded as a permanent
 * business-state change, so the two never collapse into a single "error".
 */

/** Lifecycle of a logical anchor (one per proof + generation). */
export enum AnchorStatus {
  /** Created, no transaction built/submitted yet. */
  Pending = 'pending',
  /** A signed envelope was sent; outcome not yet confirmed (must be reconciled). */
  Submitted = 'submitted',
  /** Found on-chain with a matching memo. Terminal-good. */
  Confirmed = 'confirmed',
  /** Replaced by a later generation (re-anchor). Receipt is preserved, not deleted. */
  Superseded = 'superseded',
  /** Conclusively unrecoverable (reserved; transport errors must NOT land here). */
  Failed = 'failed',
}

/**
 * Why an attempt did not (yet) confirm. Drives the recovery action.
 * These are exactly the classes the design separates; `Unknown` is a defensive
 * fallback so an unrecognized error is never silently treated as success.
 */
export enum ErrorClass {
  /** Connection refused / DNS / timeout / 5xx / rate-limited. State UNKNOWN → backoff + retry. */
  HorizonUnavailable = 'horizon_unavailable',
  /** Horizon reachable, tx not found yet. Could be propagation delay → not a failure. */
  TxNotFound = 'tx_not_found',
  /** Signed envelope expired (past timebounds). Provably NOT applied → safe to rebuild. */
  TxTooLate = 'tx_too_late',
  /** Envelope's sequence no longer matches on-chain state. NOT applied → rebuild from chain. */
  TxBadSeq = 'tx_bad_seq',
  /** Fee too low for current surge pricing. NOT applied → needs a higher fee (operator). */
  TxInsufficientFee = 'tx_insufficient_fee',
  /** Anchoring account lacks the balance/base-reserve to apply. NOT applied → fund the account. */
  InsufficientBalance = 'insufficient_balance',
  /** Horizon reachable, tx found, but anchored hash != expected. Integrity fault → terminal, alert. */
  ProofMismatch = 'proof_mismatch',
  /** Previously-confirmed tx gone + corroborating signal (seq regressed / account vanished). */
  TestnetResetSuspected = 'testnet_reset_suspected',
  /** Unrecognized error. Treated conservatively (non-terminal, needs investigation). */
  Unknown = 'unknown',
}

/** One row per LOGICAL anchor (proof + generation). The system of record. */
export interface AnchorRecord {
  anchorId: string;
  proofId: string;
  /** Immutable 32-byte content hash, hex-encoded (64 chars). Never modified. */
  proofHash: string;
  /** 0 for the original anchor; 1, 2, … for deliberate re-anchors. */
  anchorGeneration: number;
  /** Previous anchor in the lineage, if this is a re-anchor. */
  parentAnchorId: string | null;
  /** Deterministic idempotency key: sha256(proofHash | network | generation). */
  clientTxId: string;
  status: AnchorStatus;
  errorClass: ErrorClass | null;
  /** Human reason for a re-anchor, e.g. "testnet_reset". */
  reason: string | null;
  /** The physical attempt currently representing this anchor on-chain. */
  activeAttemptId: string | null;
  ledgerSeq: number | null;
  /** Full Horizon response captured on success (audit + offline verification). */
  receiptJson: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

/**
 * One row per PHYSICAL build/submit attempt. Separating this from the logical
 * anchor is what lets us (a) resubmit the EXACT same signed envelope safely and
 * (b) rebuild with a fresh sequence/timebounds after tx_too_late — both without
 * creating a second logical anchor.
 */
export interface AttemptRecord {
  attemptId: string;
  anchorId: string;
  txHash: string | null;
  /** Signed transaction envelope (base64 XDR). Stored BEFORE submission. */
  txXdr: string;
  sourceAccount: string;
  /** The tx sequence number, pinned at build time (i64 as string). */
  sequenceNumber: string;
  minTime: number;
  /** Timebound expiry (unix seconds). Past this, a resubmit yields tx_too_late. */
  maxTime: number;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed' | 'expired';
  errorClass: ErrorClass | null;
  lastError: string | null;
  submittedAt: string | null;
  createdAt: string;
}

/**
 * Normalized confirmation receipt stored in receipt_json regardless of
 * whether the anchor confirmed via direct submit or reconcile. Consumers
 * always get the same shape.
 */
export interface ConfirmationReceipt {
  txHash: string;
  ledgerSeq: number;
  confirmedAt: string;
  memoHashHex: string;
}

/** Input to anchor()/reanchor(). */
export interface AnchorInput {
  proofId: string;
  proofHash: string;
  generation?: number;
  parentAnchorId?: string | null;
  reason?: string | null;
}
