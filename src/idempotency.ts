import { createHash } from 'node:crypto';

/**
 * Deterministic idempotency key for a logical anchor.
 *
 *   clientTxId = sha256(proofHash | networkPassphrase | generation)
 *
 * The same (proof, network, generation) always yields the same key, so retries
 * across workers and restarts converge on one row (enforced by UNIQUE(client_tx_id)).
 * Bumping `generation` (a deliberate re-anchor) yields a NEW key, which is exactly
 * what we want: a new logical anchor that does not collide with the original.
 */
export function deriveClientTxId(
  proofHash: string,
  networkPassphrase: string,
  generation: number,
): string {
  return createHash('sha256')
    .update(`${proofHash}|${networkPassphrase}|${generation}`)
    .digest('hex');
}

/** A proof hash must be a 32-byte value, hex-encoded (64 lowercase hex chars). */
export function assertValidProofHash(proofHash: string): void {
  if (!/^[0-9a-f]{64}$/.test(proofHash)) {
    throw new Error(
      `Invalid proof hash: expected 64 lowercase hex chars (32 bytes), got "${proofHash}"`,
    );
  }
}
