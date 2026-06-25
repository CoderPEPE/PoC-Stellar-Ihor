import { AnchorStatus, type AnchorRecord } from './types.js';

/**
 * The public, verification-only projection of an anchor.
 *
 * It carries exactly what a third party needs to independently verify a proof
 * was anchored and to follow its lineage — and nothing about how we operate.
 * Internal mechanics (signed XDR, source account/secret, sequence numbers, retry
 * counters, worker ids, Horizon diagnostics, proof↔customer mappings, mismatch
 * investigation notes) are deliberately absent so the implementation stays free
 * to change without breaking consumers.
 */
export interface PublicReceipt {
  proofHash: string;
  network: string;
  txHash: string | null;
  ledgerSeq: number | null;
  confirmedAt: string | null;
  anchorGeneration: number;
  /** Coarse, non-operational status. */
  status: 'anchored' | 'pending' | 'superseded' | 'unavailable';
  /** Lineage reference: the anchor this one supersedes (parent), if any. */
  supersedes: string | null;
  verificationUrl: string | null;
}

function coarseStatus(status: AnchorStatus): PublicReceipt['status'] {
  switch (status) {
    case AnchorStatus.Confirmed:
      return 'anchored';
    case AnchorStatus.Superseded:
      return 'superseded';
    case AnchorStatus.Pending:
    case AnchorStatus.Submitted:
      return 'pending';
    default:
      // failed is operational; never surface the internal reason publicly.
      return 'unavailable';
  }
}

function verificationUrl(networkPassphrase: string, txHash: string | null): string | null {
  if (!txHash) return null;
  const isTestnet = networkPassphrase.includes('Test SDF Network');
  const net = isTestnet ? 'testnet' : 'public';
  return `https://stellar.expert/explorer/${net}/tx/${txHash}`;
}

export function buildPublicReceipt(
  anchor: AnchorRecord,
  txHash: string | null,
  networkPassphrase: string,
): PublicReceipt {
  return {
    proofHash: anchor.proofHash,
    network: networkPassphrase,
    txHash,
    ledgerSeq: anchor.ledgerSeq,
    confirmedAt: anchor.confirmedAt,
    anchorGeneration: anchor.anchorGeneration,
    status: coarseStatus(anchor.status),
    supersedes: anchor.parentAnchorId,
    verificationUrl: verificationUrl(networkPassphrase, txHash),
  };
}
