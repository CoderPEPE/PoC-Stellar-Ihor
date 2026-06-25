import type { Store } from '../db/store.js';

/**
 * Centralized sequence allocator.
 *
 * Stellar rejects a transaction whose sequence is not exactly account.sequence+1,
 * so parallel anchor jobs sharing one account must not pick sequences independently.
 * We make the database the single allocator: each build reserves the next number
 * under a row lock (see Store.reserveSequence). For higher throughput, register a
 * POOL of anchoring accounts and spread jobs across them to cut contention — each
 * account has its own independent sequence line.
 */
export class SequenceAllocator {
  constructor(private readonly store: Store) {}

  /**
   * Re-sync the allocator to a known on-chain sequence. A transaction that never
   * applied (e.g. tx_too_late) leaves the allocator ahead of the account, so before
   * rebuilding we reset to account.sequence + 1 — otherwise the next tx is tx_bad_seq.
   */
  reset(accountId: string, nextSequence: string): void {
    this.store.setSequence(accountId, nextSequence);
  }

  /** Reserve the next sequence number for this account (atomic). */
  reserve(accountId: string): string {
    return this.store.reserveSequence(accountId);
  }
}
