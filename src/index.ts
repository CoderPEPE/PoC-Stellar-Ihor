/**
 * Offline demo. Uses the mock Horizon so it runs with no network and no funded
 * account, while exercising the real service code path: anchor → confirm →
 * deliberate re-anchor → preserved lineage. Failure paths are covered by the
 * test suite. Run with: pnpm demo
 */
import { createHash } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { AnchorService } from './anchorService.js';
import { loadConfig } from './config.js';
import { SqliteStore } from './db/store.js';
import { MockHorizonClient } from './stellar/horizonMock.js';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new SqliteStore(':memory:');
  const keypair = Keypair.random();

  // Mock Horizon that confirms every submission and assigns increasing ledgers.
  const horizon = new MockHorizonClient();
  let ledger = 1_000_000;
  horizon.submitHandler = async (xdr) => ({
    hash: sha256Hex(xdr),
    ledger: ++ledger,
    successful: true,
  });

  store.initAccount(keypair.publicKey(), '1');
  const service = new AnchorService({ store, horizon, keypair, config });

  const proofHash = sha256Hex('contract-v1.pdf');
  console.log('Proof hash:', proofHash);
  console.log('Anchoring account:', keypair.publicKey(), '\n');

  // 1. Original anchor.
  const v0 = await service.anchor({ proofId: 'proof-001', proofHash });
  console.log('v0 anchored:', service.publicReceipt(v0.anchorId));

  // 2. Idempotent repeat — same logical anchor, no second transaction.
  const again = await service.anchor({ proofId: 'proof-001', proofHash });
  console.log(
    `\nIdempotent repeat → same anchor_id: ${again.anchorId === v0.anchorId}, submit calls: ${horizon.submitCalls}`,
  );

  // 3. Deliberate re-anchor (e.g. after a suspected testnet reset).
  const v1 = await service.reanchor(v0.anchorId, 'testnet_reset');
  console.log('\nv1 re-anchored:', service.publicReceipt(v1.anchorId));

  // 4. Lineage is append-only: v0 is preserved (superseded), v1 supersedes it.
  console.log('\nReceipt lineage for the proof:');
  for (const receipt of service.lineage(proofHash)) {
    console.log(
      `  gen ${receipt.anchorGeneration}: ${receipt.status.padEnd(10)} ledger=${receipt.ledgerSeq} supersedes=${receipt.supersedes ?? '—'}`,
    );
  }

  store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
