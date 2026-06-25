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
   * Re-sync the allocator to the chain's next sequence (`account.sequence + 1`). A
   * transaction that never applied (e.g. tx_too_late) leaves the allocator ahead of the
   * account, so before rebuilding we re-read the chain — otherwise the next tx is tx_bad_seq.
   *
   * But we must NOT reset below a sequence still held by a LIVE (pending/submitted)
   * attempt on this account: that would reissue a number a concurrent in-flight tx
   * already reserved. The dead envelope being rebuilt is already expired/failed, so it
   * is excluded here — its sequence is still reclaimed when nothing live sits above it.
   */
  resetToChain(accountId: string, onChainNext: bigint): void {
    const maxLive = this.store.maxInFlightSequence(accountId);
    const next =
      maxLive !== null && BigInt(maxLive) + 1n > onChainNext ? BigInt(maxLive) + 1n : onChainNext;
    this.store.setSequence(accountId, next.toString());
  }

  /** Reserve the next sequence number for this account (atomic). */
  reserve(accountId: string): string {
    return this.store.reserveSequence(accountId);
  }
}
