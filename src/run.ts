/**
 * Full end-to-end run against LIVE Stellar TESTNET, backed by a real on-disk SQLite
 * database (unlike `pnpm demo`, which is in-memory + mocked). It funds an account,
 * anchors a proof, proves idempotency, optionally re-anchors a new generation, then
 * independently reads every transaction back from Horizon and asserts the on-chain
 * memo equals the proof hash — exiting non-zero if any check fails.
 *
 *   pnpm run:testnet                      # anchor + verify "demo-document.pdf"
 *   pnpm run:testnet "contract-v2.pdf"    # anchor a specific subject
 *   pnpm run:testnet "contract-v2.pdf" --reanchor   # also add the next generation
 *
 * State persists in DB_PATH (default ./data/anchors.db). Re-running with the same
 * STELLAR_SECRET + subject is idempotent: it returns the existing anchor, no new tx.
 * The first run prints a STELLAR_SECRET to set so subsequent runs reuse the account.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Keypair } from '@stellar/stellar-sdk';
import { AnchorService } from './anchorService.js';
import { loadConfig } from './config.js';
import { SqliteStore } from './db/store.js';
import { assertValidProofHash, deriveClientTxId } from './idempotency.js';
import { SequenceAllocator } from './stellar/sequence.js';
import { RealHorizonClient } from './stellar/horizonReal.js';
import { AnchorStatus } from './types.js';
import type { PublicReceipt } from './verify.js';

const FRIENDBOT = 'https://friendbot.stellar.org';
const DEFAULT_SUBJECT = 'samples/demo-document.txt'; // a real file that ships with the repo

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * The proof hash to anchor. A proof hash must be the sha256 of real CONTENT — never of
 * a filename. Precedence:
 *   1. `--hash <64-hex>`  — an explicit, precomputed content hash
 *   2. `<subject>` is a file on disk — sha256 of its actual bytes
 *   3. otherwise — error (refuse to anchor a hash of the filename string)
 */
function resolveProofHash(subject: string, argv: string[]): string {
  const i = argv.indexOf('--hash');
  const flag = argv.find((a) => a.startsWith('--hash='))?.slice(7) ?? (i >= 0 ? argv[i + 1] : undefined);
  if (flag) {
    const hex = flag.toLowerCase();
    assertValidProofHash(hex); // throws on anything but 64 hex chars
    return hex;
  }
  if (existsSync(subject) && statSync(subject).isFile()) {
    return sha256Hex(readFileSync(subject)); // hash the real file bytes
  }
  throw new Error(
    `"${subject}" is not a file on disk. Pass a real file path, or an explicit ` +
      `precomputed hash via --hash <64-hex>. (We never hash the filename itself.)`,
  );
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`CHECK FAILED: ${message}`);
}

/** Friendbot is rate-limited and flaky; retry a few times. */
async function friendbotFund(publicKey: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(publicKey)}`);
      if (res.ok || res.status === 400) return; // 400 ≈ already funded
      lastErr = new Error(`Friendbot ${res.status}: ${await res.text()}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(attempt * 1500);
  }
  throw new Error(`Friendbot funding failed after retries: ${String(lastErr)}`);
}

/** Return the account, funding + polling for visibility if it isn't on-chain yet. */
async function ensureFunded(
  horizon: RealHorizonClient,
  publicKey: string,
): Promise<{ sequence: string }> {
  let account = await horizon.getAccount(publicKey);
  if (account) return account;

  console.log(`Funding ${publicKey} via Friendbot…`);
  await friendbotFund(publicKey);
  for (let i = 0; i < 10 && !account; i++) {
    await sleep(1000);
    account = await horizon.getAccount(publicKey);
  }
  assert(account, `account ${publicKey} did not become visible after funding`);
  return account;
}

function printReceipt(label: string, r: PublicReceipt): void {
  console.log(
    `  ${label}: gen ${r.anchorGeneration} · ${r.status} · ledger ${r.ledgerSeq ?? '—'}\n` +
      `         tx ${r.txHash ?? '—'}\n` +
      `         ${r.verificationUrl ?? '(no tx yet)'}`,
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  // The runner always uses a real file (the service defaults to :memory: for tests).
  const dbPath = config.dbPath === ':memory:' ? 'data/anchors.db' : config.dbPath;

  const subject = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : DEFAULT_SUBJECT;
  const doReanchor = process.argv.includes('--reanchor');
  const proofHash = resolveProofHash(subject, process.argv.slice(2));

  const horizon = new RealHorizonClient(config.horizonUrl, config.networkPassphrase);

  // Account: reuse STELLAR_SECRET if provided, else generate a throwaway and print it.
  const secret = process.env.STELLAR_SECRET;
  const keypair = secret ? Keypair.fromSecret(secret) : Keypair.random();
  if (!secret) {
    console.log('No STELLAR_SECRET set — generated a throwaway account.');
    console.log(`To reuse this DB on future runs, export:\n  STELLAR_SECRET=${keypair.secret()}\n`);
  }

  const account = await ensureFunded(horizon, keypair.publicKey());

  const store = new SqliteStore(dbPath);
  const onChainNext = BigInt(account.sequence) + 1n;
  // Register the account, then sync the allocator to the on-chain sequence — the chain is
  // the truth across restarts — but never below a sequence a prior run left in flight
  // (resetToChain guards that, so we don't reissue an unsettled tx's reserved sequence).
  store.initAccount(keypair.publicKey(), onChainNext.toString());
  new SequenceAllocator(store).resetToChain(keypair.publicKey(), onChainNext);

  const service = new AnchorService({ store, horizon, keypair, config });

  console.log('━'.repeat(72));
  console.log(`DB:       ${dbPath}`);
  console.log(`Account:  ${keypair.publicKey()}`);
  console.log(`Subject:  "${subject}"`);
  console.log(`Proof:    ${proofHash}`);
  console.log('━'.repeat(72));

  // Was this proof already anchored in a previous run? (determines idempotency expectation)
  const clientTxId = deriveClientTxId(proofHash, config.networkPassphrase, 0);
  const preexisting = store.getAnchorByClientTxId(clientTxId);

  // 1. Anchor (or return the existing record).
  console.log(preexisting ? '\n[1] Proof already anchored in this DB — expecting idempotent return:' : '\n[1] Anchoring proof:');
  const v0 = await service.anchor({ proofId: subject, proofHash });
  assert(v0.status === AnchorStatus.Confirmed, `expected confirmed, got ${v0.status} (${v0.errorClass})`);
  printReceipt('v0', service.publicReceipt(v0.anchorId));

  // 2. Idempotency: a second call must return the SAME anchor and issue no new tx.
  console.log('\n[2] Idempotent repeat (same call again):');
  const v0TxBefore = store.getAttempt(v0.activeAttemptId!)!.txHash;
  const again = await service.anchor({ proofId: subject, proofHash });
  assert(again.anchorId === v0.anchorId, 'repeat returned a different anchor id');
  assert(again.activeAttemptId === v0.activeAttemptId, 'repeat created a new attempt');
  assert(store.getAttempt(again.activeAttemptId!)!.txHash === v0TxBefore, 'repeat changed the tx');
  console.log(`  ✓ same anchor ${again.anchorId} — no new transaction submitted`);

  // 3. Optional deliberate re-anchor → a new generation, prior receipt preserved.
  if (doReanchor) {
    console.log('\n[3] Re-anchoring (new generation):');
    const latest = service.lineage(proofHash).at(-1)!;
    const parentId = store
      .listLineage(proofHash)
      .find((a) => a.anchorGeneration === latest.anchorGeneration)!.anchorId;
    const child = await service.reanchor(parentId, 'manual re-anchor via run.ts');
    assert(child.status === AnchorStatus.Confirmed, `re-anchor not confirmed: ${child.status}`);
    printReceipt('vN', service.publicReceipt(child.anchorId));
  }

  // 4. Independent on-chain verification of EVERY generation in the lineage.
  console.log('\n[4] Verifying every anchor against Horizon:');
  const lineage = service.lineage(proofHash);
  for (const r of lineage) {
    assert(r.txHash, `generation ${r.anchorGeneration} has no tx hash`);
    const tx = await horizon.getTransaction(r.txHash);
    assert(tx, `tx ${r.txHash} not found on-chain`);
    assert(tx.memoType === 'hash', `gen ${r.anchorGeneration}: memo type ${tx.memoType}, expected hash`);
    assert(tx.memoHashHex === proofHash, `gen ${r.anchorGeneration}: on-chain memo ≠ proof hash`);
    console.log(`  ✓ gen ${r.anchorGeneration} memo matches on-chain (ledger ${tx.ledger})`);
  }

  // 5. Lineage summary (what a persisted DB now holds).
  console.log('\n[5] Receipt lineage (append-only):');
  for (const r of lineage) {
    console.log(`  gen ${r.anchorGeneration}: ${r.status.padEnd(10)} supersedes=${r.supersedes ?? '—'}`);
  }

  store.close();
  console.log('\n✅ All on-chain checks passed. State persisted to', dbPath);
}

main().catch((err) => {
  console.error('\n❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
