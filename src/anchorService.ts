import { randomUUID } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import type { Config } from './config.js';
import { classifyError, errorToString } from './classify.js';
import type { Store } from './db/store.js';
import { assertValidProofHash, deriveClientTxId } from './idempotency.js';
import { SequenceAllocator } from './stellar/sequence.js';
import { buildAnchorTx } from './stellar/txBuilder.js';
import type { HorizonClient } from './stellar/horizon.js';
import {
  AnchorStatus,
  ErrorClass,
  type AnchorInput,
  type AnchorRecord,
  type AttemptRecord,
} from './types.js';
import { buildPublicReceipt, type PublicReceipt } from './verify.js';

export interface AnchorServiceOptions {
  store: Store;
  horizon: HorizonClient;
  /** Single anchoring account for the POC. Production would inject an account pool. */
  keypair: Keypair;
  config: Config;
  /** Injectable clock (unix seconds) for deterministic tests. */
  now?: () => number;
}

/** The anchoring account is not on-chain (vanished after a reset). */
class AccountVanished extends Error {
  constructor(accountId: string) {
    super(`anchoring account not found on-chain: ${accountId}`);
  }
}

/**
 * Orchestrates anchoring. Guiding rule: the local DB is the system of record and
 * the chain is used for independent verification. Submission and confirmation are
 * separate phases, so an uncertain submission can always be reconciled later
 * rather than guessed at.
 */
export class AnchorService {
  private readonly store: Store;
  private readonly horizon: HorizonClient;
  private readonly keypair: Keypair;
  private readonly config: Config;
  private readonly sequences: SequenceAllocator;
  private readonly now: () => number;

  constructor(opts: AnchorServiceOptions) {
    this.store = opts.store;
    this.horizon = opts.horizon;
    this.keypair = opts.keypair;
    this.config = opts.config;
    this.sequences = new SequenceAllocator(opts.store);
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private nowIso(): string {
    return new Date(this.now() * 1000).toISOString();
  }

  /**
   * Anchor a proof (or return the existing record). Idempotent: a repeat call for
   * the same (proof, network, generation) converges on one row via the
   * deterministic client_tx_id and the UNIQUE constraint behind it.
   */
  async anchor(input: AnchorInput): Promise<AnchorRecord> {
    assertValidProofHash(input.proofHash);
    // Validate the rest of the untrusted input at the boundary.
    if (typeof input.proofId !== 'string' || input.proofId.length === 0) {
      throw new Error('proofId is required (non-empty string)');
    }
    if (input.proofId.length > 256) throw new Error('proofId too long (max 256 chars)');
    if (input.reason != null && input.reason.length > 1024) {
      throw new Error('reason too long (max 1024 chars)');
    }
    const generation = input.generation ?? 0;
    if (!Number.isInteger(generation) || generation < 0) {
      throw new Error(`generation must be a non-negative integer, got ${generation}`);
    }
    const clientTxId = deriveClientTxId(input.proofHash, this.config.networkPassphrase, generation);

    const candidate: AnchorRecord = {
      anchorId: randomUUID(),
      proofId: input.proofId,
      proofHash: input.proofHash,
      anchorGeneration: generation,
      parentAnchorId: input.parentAnchorId ?? null,
      clientTxId,
      status: AnchorStatus.Pending,
      errorClass: null,
      reason: input.reason ?? null,
      activeAttemptId: null,
      ledgerSeq: null,
      receiptJson: null,
      createdAt: this.nowIso(),
      confirmedAt: null,
    };

    const anchor = this.store.insertAnchorIfAbsent(candidate);

    // Already settled or in-flight → never build a second distinct transaction.
    if (anchor.status === AnchorStatus.Confirmed) return anchor;
    if (anchor.activeAttemptId) return anchor;

    await this.buildAndSubmit(anchor);
    return this.store.getAnchor(anchor.anchorId)!;
  }

  /**
   * Retry an unsettled anchor. Always reconcile first; only resubmit the EXACT
   * stored envelope; rebuild a new transaction only when the prior one is
   * conclusively unusable (expired → tx_too_late).
   */
  async retry(anchorId: string): Promise<AnchorRecord> {
    let anchor = this.store.getAnchor(anchorId);
    if (!anchor) throw new Error(`Unknown anchor: ${anchorId}`);

    if (anchor.status === AnchorStatus.Confirmed) return anchor;
    // Integrity faults and reset events are terminal here: do not auto-retry.
    if (anchor.errorClass === ErrorClass.ProofMismatch) return anchor;
    if (anchor.errorClass === ErrorClass.TestnetResetSuspected) return anchor;

    // 1. Reconcile against Horizon — the cheap, safe way to settle an uncertain state.
    anchor = await this.reconcile(anchorId);
    if (anchor.status === AnchorStatus.Confirmed) return anchor;
    if (anchor.errorClass === ErrorClass.ProofMismatch) return anchor;
    if (anchor.errorClass === ErrorClass.TestnetResetSuspected) return anchor;

    const attempt = anchor.activeAttemptId ? this.store.getAttempt(anchor.activeAttemptId) : null;

    // No attempt yet, or the active envelope is provably dead — expired (tx_too_late),
    // wrong-sequence (tx_bad_seq), or failed at apply. Build a fresh envelope, and
    // re-derive the sequence from on-chain state so a gap left by an unapplied tx
    // doesn't make the rebuild itself fail with tx_bad_seq.
    if (!attempt || attempt.status === 'expired' || attempt.status === 'failed') {
      await this.buildAndSubmit(anchor, { resync: true });
      return this.store.getAnchor(anchorId)!;
    }

    // 2. Resubmit the exact same signed envelope. The network dedupes by tx hash,
    //    so this can never double-anchor.
    const submit = await this.submitAttempt(anchor, attempt);
    if (submit.ok) return this.store.getAnchor(anchorId)!;

    // 3a. tx_too_late proves non-application (timebounds are consensus-enforced), so
    //     rebuild directly under the SAME client_tx_id / generation from on-chain state.
    if (submit.errorClass === ErrorClass.TxTooLate) {
      await this.buildAndSubmit(this.store.getAnchor(anchorId)!, { resync: true });
      return this.store.getAnchor(anchorId)!;
    }

    // 3b. tx_bad_seq is ambiguous: the sequence may have moved on (other txs) OR our
    //     original may have APPLIED already (consuming its sequence). Re-reconcile first
    //     so an applied tx confirms instead of being rebuilt into a SECOND anchor.
    if (submit.errorClass === ErrorClass.TxBadSeq) {
      const rechecked = await this.reconcile(anchorId);
      if (
        rechecked.status === AnchorStatus.Confirmed ||
        rechecked.errorClass === ErrorClass.ProofMismatch ||
        rechecked.errorClass === ErrorClass.TestnetResetSuspected
      ) {
        return rechecked;
      }
      await this.buildAndSubmit(this.store.getAnchor(anchorId)!, { resync: true });
    }
    // Other classes (transport, not-found, insufficient fee/balance) wait for backoff.
    return this.store.getAnchor(anchorId)!;
  }

  /**
   * Reconcile an anchor against Horizon and classify the outcome. This is where
   * proof_mismatch and testnet_reset_suspected are decided — from on-chain
   * evidence, never from an exception.
   */
  async reconcile(anchorId: string): Promise<AnchorRecord> {
    const anchor = this.store.getAnchor(anchorId);
    if (!anchor) throw new Error(`Unknown anchor: ${anchorId}`);
    const attempt = anchor.activeAttemptId ? this.store.getAttempt(anchor.activeAttemptId) : null;
    if (!attempt || !attempt.txHash) return anchor;

    let txRecord;
    try {
      txRecord = await this.horizon.getTransaction(attempt.txHash);
    } catch (err) {
      // Transport problem: state is UNKNOWN. Never mark failed.
      this.store.updateAnchor(anchorId, { errorClass: classifyError(err) });
      return this.store.getAnchor(anchorId)!;
    }

    if (txRecord) {
      const memoMatches = txRecord.memoType === 'hash' && txRecord.memoHashHex === anchor.proofHash;
      if (!memoMatches) {
        // Reachable + found, but the anchored hash is wrong: data-integrity fault.
        // Terminal — stop, alert, do not auto-retry. Status is NOT flipped to
        // confirmed; the prior business status is left intact for investigation.
        this.store.updateAnchor(anchorId, { errorClass: ErrorClass.ProofMismatch });
        return this.store.getAnchor(anchorId)!;
      }
      if (txRecord.successful !== true) {
        // Found with a matching memo, but the tx FAILED at apply: it consumed its
        // sequence on-chain without anchoring. Not an integrity fault and not
        // transport — same verdict as a failed submit. Mark the active attempt dead
        // so retry() rebuilds from current on-chain state (next valid sequence).
        this.store.updateAttempt(attempt.attemptId, {
          status: 'failed',
          errorClass: ErrorClass.Unknown,
          lastError: 'tx found on-chain but successful=false',
        });
        this.store.updateAnchor(anchorId, {
          status: AnchorStatus.Submitted,
          errorClass: ErrorClass.Unknown,
        });
        return this.store.getAnchor(anchorId)!;
      }
      this.store.updateAttempt(attempt.attemptId, { status: 'confirmed' });
      this.store.updateAnchor(anchorId, {
        status: AnchorStatus.Confirmed,
        ledgerSeq: txRecord.ledger,
        confirmedAt: this.nowIso(),
        receiptJson: JSON.stringify(txRecord),
        errorClass: null,
      });
      return this.store.getAnchor(anchorId)!;
    }

    // Not found (clean 404). Disambiguate by context.
    const wasConfirmed = anchor.status === AnchorStatus.Confirmed || anchor.ledgerSeq !== null;
    if (wasConfirmed) {
      // A previously-confirmed tx going missing is only meaningful WITH a
      // corroborating signal — a single 404 is never enough on its own.
      let resetSignal = false;
      try {
        const account = await this.horizon.getAccount(attempt.sourceAccount);
        if (account === null) {
          resetSignal = true; // account vanished
        } else if (BigInt(account.sequence) < BigInt(attempt.sequenceNumber)) {
          resetSignal = true; // sequence regressed below what we already used
        }
      } catch (err) {
        this.store.updateAnchor(anchorId, { errorClass: classifyError(err) });
        return this.store.getAnchor(anchorId)!;
      }
      this.store.updateAnchor(anchorId, {
        errorClass: resetSignal ? ErrorClass.TestnetResetSuspected : ErrorClass.TxNotFound,
      });
      return this.store.getAnchor(anchorId)!;
    }

    // Fresh submission, not yet visible: propagation delay, not a failure.
    this.store.updateAnchor(anchorId, { errorClass: ErrorClass.TxNotFound });
    return this.store.getAnchor(anchorId)!;
  }

  /**
   * Deliberately re-anchor a proof as a NEW generation, preserving the previous
   * receipt. The prior anchor is marked superseded (its receipt_json is left
   * untouched); the new anchor links back via parent_anchor_id. Receipts are
   * append-only — we never overwrite history.
   */
  async reanchor(parentAnchorId: string, reason: string): Promise<AnchorRecord> {
    const parent = this.store.getAnchor(parentAnchorId);
    if (!parent) throw new Error(`Unknown anchor: ${parentAnchorId}`);
    // Re-anchoring only makes sense over an anchor that actually reached the chain.
    if (
      parent.status !== AnchorStatus.Confirmed &&
      parent.status !== AnchorStatus.Superseded
    ) {
      throw new Error(
        `Cannot re-anchor ${parentAnchorId}: parent status is "${parent.status}", expected confirmed`,
      );
    }

    const child = await this.anchor({
      proofId: parent.proofId,
      proofHash: parent.proofHash,
      generation: parent.anchorGeneration + 1,
      parentAnchorId: parent.anchorId,
      reason,
    });

    // Supersede the parent ONLY once the new generation is itself confirmed on-chain.
    // If the child did not confirm, leave the parent active — never retire a live
    // receipt in favour of one that does not exist yet. (The prior receipt is never
    // overwritten regardless; only its status flips.)
    if (child.status === AnchorStatus.Confirmed) {
      this.store.updateAnchor(parent.anchorId, { status: AnchorStatus.Superseded });
    }
    return child;
  }

  /** The public verification view for a single anchor. */
  publicReceipt(anchorId: string): PublicReceipt {
    const anchor = this.store.getAnchor(anchorId);
    if (!anchor) throw new Error(`Unknown anchor: ${anchorId}`);
    const txHash = this.activeTxHash(anchor);
    return buildPublicReceipt(anchor, txHash, this.config.networkPassphrase);
  }

  /** The full receipt lineage for a proof, oldest generation first. */
  lineage(proofHash: string): PublicReceipt[] {
    return this.store.listLineage(proofHash).map((anchor) => {
      const txHash = this.activeTxHash(anchor);
      return buildPublicReceipt(anchor, txHash, this.config.networkPassphrase);
    });
  }

  // --- internals -----------------------------------------------------------

  private activeTxHash(anchor: AnchorRecord): string | null {
    if (!anchor.activeAttemptId) return null;
    return this.store.getAttempt(anchor.activeAttemptId)?.txHash ?? null;
  }

  /**
   * Build a fresh signed envelope, persist it BEFORE submitting, then submit.
   *
   * Ordering is deliberate. Any network round-trip (self-seed / on-chain re-sync)
   * happens FIRST, before we hold any claim. Then reserve → build → claim+insert run
   * with NO await between them, so (a) in one event loop nothing interleaves, and
   * (b) the active_attempt_id CAS and the attempt-row insert commit in ONE transaction
   * — there is never a window where active_attempt_id points at a missing attempt,
   * which is what previously let a concurrent rebuild steal the claim and double-anchor.
   * A worker that loses the CAS stops (it burned one sequence number, which the next
   * rebuild's re-sync reclaims). `resync` is set on every rebuild.
   */
  private async buildAndSubmit(
    anchor: AnchorRecord,
    opts: { resync?: boolean } = {},
  ): Promise<void> {
    // --- network phase (no claim held) -------------------------------------
    const needSeed = !this.store.hasAccount(this.keypair.publicKey());
    if (needSeed || opts.resync) {
      try {
        await this.syncSequenceFromChain();
      } catch (err) {
        if (err instanceof AccountVanished) {
          this.store.updateAnchor(anchor.anchorId, {
            errorClass: ErrorClass.TestnetResetSuspected,
          });
          return;
        }
        const klass = classifyError(err);
        if (klass === ErrorClass.HorizonUnavailable) {
          this.store.updateAnchor(anchor.anchorId, { errorClass: klass });
          return;
        }
        throw err; // genuinely unexpected — surface it loudly.
      }
    }

    // --- synchronous phase: reserve → build → atomically claim + insert -----
    const txSequence = this.sequences.reserve(this.keypair.publicKey());
    const minTime = 0;
    const maxTime = this.now() + this.config.anchorTtlSeconds;

    const built = buildAnchorTx({
      keypair: this.keypair,
      proofHashHex: anchor.proofHash,
      txSequence,
      minTime,
      maxTime,
      networkPassphrase: this.config.networkPassphrase,
      baseFee: this.config.baseFee,
    });

    const attempt: AttemptRecord = {
      attemptId: randomUUID(),
      anchorId: anchor.anchorId,
      txHash: built.txHash,
      txXdr: built.txXdr, // persisted before submission → safe timeout recovery
      sourceAccount: built.sourceAccount,
      sequenceNumber: built.sequenceNumber,
      minTime,
      maxTime,
      status: 'pending',
      errorClass: null,
      lastError: null,
      submittedAt: null,
      createdAt: this.nowIso(),
    };

    // Atomic CAS (expected = current active attempt) + insert. Loser bails: no submit,
    // no dangling pointer. Winner's attempt row is committed with the claim.
    if (!this.store.claimAndInsertAttempt(anchor.anchorId, anchor.activeAttemptId, attempt)) {
      return;
    }

    await this.submitAttempt(this.store.getAnchor(anchor.anchorId)!, attempt);
  }

  /**
   * Re-sync the sequence allocator to the account's current on-chain sequence. A
   * prior envelope that never applied (tx_too_late / tx_bad_seq) left the allocator
   * ahead of the account; rebuilding without this would itself fail with tx_bad_seq.
   */
  private async syncSequenceFromChain(): Promise<void> {
    const accountId = this.keypair.publicKey();
    const account = await this.horizon.getAccount(accountId);
    if (account === null) throw new AccountVanished(accountId);
    this.sequences.reset(accountId, (BigInt(account.sequence) + 1n).toString());
  }

  private async submitAttempt(
    anchor: AnchorRecord,
    attempt: AttemptRecord,
  ): Promise<{ ok: boolean; errorClass: ErrorClass | null }> {
    this.store.updateAttempt(attempt.attemptId, {
      status: 'submitted',
      submittedAt: this.nowIso(),
    });
    this.store.updateAnchor(anchor.anchorId, { status: AnchorStatus.Submitted, errorClass: null });

    try {
      const res = await this.horizon.submit(attempt.txXdr);
      if (res.successful === false) {
        // Included but failed at apply. Do NOT confirm — leave in-flight for
        // reconcile to settle from on-chain evidence. (The SDK normally throws
        // for failed result codes; this is a defensive guard.)
        this.store.updateAttempt(attempt.attemptId, {
          status: 'failed',
          errorClass: ErrorClass.Unknown,
          lastError: 'submit resolved with successful=false',
        });
        this.store.updateAnchor(anchor.anchorId, {
          status: AnchorStatus.Submitted,
          errorClass: ErrorClass.Unknown,
        });
        return { ok: false, errorClass: ErrorClass.Unknown };
      }
      this.store.updateAttempt(attempt.attemptId, { status: 'confirmed' });
      this.store.updateAnchor(anchor.anchorId, {
        status: AnchorStatus.Confirmed,
        ledgerSeq: res.ledger,
        confirmedAt: this.nowIso(),
        receiptJson: JSON.stringify(res),
        errorClass: null,
      });
      return { ok: true, errorClass: null };
    } catch (err) {
      const klass = classifyError(err);
      // The envelope is DEAD only when consensus says so: expired (tx_too_late) or
      // wrong-sequence (tx_bad_seq). Transport / not-found / unknown leave it IN-FLIGHT
      // ('submitted') so the exact same envelope can be resubmitted — it may yet land.
      const attemptStatus =
        klass === ErrorClass.TxTooLate
          ? 'expired'
          : klass === ErrorClass.TxBadSeq
            ? 'failed'
            : 'submitted';
      this.store.updateAttempt(attempt.attemptId, {
        status: attemptStatus,
        errorClass: klass,
        lastError: errorToString(err),
      });
      // The anchor stays "submitted" (uncertain, to be reconciled). Transport / not-found
      // / too-late / bad-seq are NON-terminal — never mark the anchor failed here.
      this.store.updateAnchor(anchor.anchorId, {
        status: AnchorStatus.Submitted,
        errorClass: klass,
      });
      return { ok: false, errorClass: klass };
    }
  }
}
