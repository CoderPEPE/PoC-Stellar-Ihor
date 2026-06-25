/**
 * Live Stellar TESTNET round-trips. Gated: only run with RUN_TESTNET=1, since these
 * need network access and fund throwaway accounts via Friendbot.
 *
 *   RUN_TESTNET=1 pnpm test:testnet
 *
 * Everything except the network is identical to the mocked suite — real signing, real
 * submission, real Horizon. These tests cover what mocks cannot vouch for: that a real
 * MemoHash lands and decodes, that real 404 / transport errors classify correctly, and
 * that a real consensus `tx_too_late` is recovered by re-syncing the sequence from chain.
 */
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { AnchorService } from '../src/anchorService.js';
import { loadConfig, type Config } from '../src/config.js';
import { SqliteStore, type Store } from '../src/db/store.js';
import { classifyError } from '../src/classify.js';
import { RealHorizonClient } from '../src/stellar/horizonReal.js';
import { AnchorStatus, ErrorClass } from '../src/types.js';

const RUN = process.env.RUN_TESTNET === '1';
const config = loadConfig();

// The live suite runs against a REAL on-disk SQLite file (not :memory:), so you can
// inspect the system-of-record after a run. Started fresh each run.
const IT_DB = process.env.DB_PATH && process.env.DB_PATH !== ':memory:' ? process.env.DB_PATH : 'data/testnet-it.db';
function freshDbFile(): void {
  for (const f of [IT_DB, `${IT_DB}-wal`, `${IT_DB}-shm`]) rmSync(f, { force: true });
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Friendbot is rate-limited and flaky; retry a few times before giving up. */
async function fundWithFriendbot(publicKey: string): Promise<void> {
  const url = `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      // 400 can mean "already funded" on reruns; that's fine. Other non-2xx → retry.
      if (res.ok || res.status === 400) return;
      lastErr = new Error(`Friendbot ${res.status}: ${await res.text()}`);
    } catch (err) {
      lastErr = err; // transient transport failure (ECONNRESET etc.) → retry
    }
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  throw new Error(`Friendbot funding failed after retries: ${String(lastErr)}`);
}

/** Fund a fresh keypair and seed the sequence allocator from its on-chain state. */
async function fundedAccount(
  cfg: Config = config,
): Promise<{ keypair: Keypair; horizon: RealHorizonClient; store: Store }> {
  const keypair = Keypair.random();
  await fundWithFriendbot(keypair.publicKey());
  const horizon = new RealHorizonClient(cfg.horizonUrl, cfg.networkPassphrase);
  const account = await horizon.getAccount(keypair.publicKey());
  expect(account).not.toBeNull();
  const store = new SqliteStore(IT_DB); // real on-disk SQLite, shared across this run
  store.initAccount(keypair.publicKey(), (BigInt(account!.sequence) + 1n).toString());
  return { keypair, horizon, store };
}

describe.skipIf(!RUN)('live TESTNET anchoring', () => {
  let store: Store;
  let horizon: RealHorizonClient;
  let service: AnchorService;
  let keypair: Keypair;

  // One funded account, shared by the read/idempotency/lineage tests below. Each test
  // uses a distinct proof hash; submitted txs advance the chain and allocator together.
  beforeAll(async () => {
    freshDbFile(); // start the on-disk DB clean
    const funded = await fundedAccount();
    ({ store, horizon, keypair } = funded);
    service = new AnchorService({ store, horizon, keypair, config });
  }, 60_000);

  it(
    'anchors a MemoHash tx and reads back a memo that equals the proof hash',
    async () => {
      const proofHash = sha256(`real-${keypair.publicKey()}-1`);
      const anchor = await service.anchor({ proofId: 'live-1', proofHash });
      expect(anchor.status).toBe(AnchorStatus.Confirmed);
      expect(anchor.ledgerSeq).toBeGreaterThan(0);

      const txHash = store.getAttempt(anchor.activeAttemptId!)!.txHash!;
      const tx = await horizon.getTransaction(txHash);
      expect(tx).not.toBeNull();
      expect(tx!.memoType).toBe('hash');
      expect(tx!.memoHashHex).toBe(proofHash); // the real base64→hex decode round-trips
      expect(tx!.memoHashHex).not.toBe(sha256('something-else')); // and is specific

      const receipt = service.publicReceipt(anchor.anchorId);
      // eslint-disable-next-line no-console
      console.log(`\n  anchored tx ${txHash} @ ledger ${anchor.ledgerSeq}\n  verify: ${receipt.verificationUrl}`);
    },
    60_000,
  );

  it(
    'is idempotent on a real account: a repeat anchor issues no second transaction',
    async () => {
      const proofHash = sha256(`real-${keypair.publicKey()}-idem`);
      const first = await service.anchor({ proofId: 'live-idem', proofHash });
      expect(first.status).toBe(AnchorStatus.Confirmed);

      const again = await service.anchor({ proofId: 'live-idem', proofHash });
      expect(again.anchorId).toBe(first.anchorId);
      expect(again.activeAttemptId).toBe(first.activeAttemptId); // same tx, never resubmitted
      expect(store.listLineage(proofHash)).toHaveLength(1);
    },
    60_000,
  );

  it(
    're-anchors as a new generation: two real txs, prior receipt preserved',
    async () => {
      const proofHash = sha256(`real-${keypair.publicKey()}-lineage`);
      const v0 = await service.anchor({ proofId: 'live-lineage', proofHash });
      expect(v0.status).toBe(AnchorStatus.Confirmed);
      const v0Tx = store.getAttempt(v0.activeAttemptId!)!.txHash!;

      const v1 = await service.reanchor(v0.anchorId, 'testnet_reset');
      expect(v1.status).toBe(AnchorStatus.Confirmed);
      expect(v1.anchorGeneration).toBe(1);
      const v1Tx = store.getAttempt(v1.activeAttemptId!)!.txHash!;
      expect(v1Tx).not.toBe(v0Tx);

      // Both transactions are independently verifiable on-chain, with the same memo.
      const [t0, t1] = await Promise.all([horizon.getTransaction(v0Tx), horizon.getTransaction(v1Tx)]);
      expect(t0!.memoHashHex).toBe(proofHash);
      expect(t1!.memoHashHex).toBe(proofHash);

      // Lineage: v0 superseded but its receipt untouched; v1 supersedes v0.
      const lineage = service.lineage(proofHash);
      expect(lineage.map((r) => r.anchorGeneration)).toEqual([0, 1]);
      expect(lineage[0]!.status).toBe('superseded');
      expect(lineage[1]!.supersedes).toBe(v0.anchorId);
    },
    90_000,
  );

  it(
    'recovers a real consensus tx_too_late by re-syncing the sequence from chain',
    async () => {
      // Dedicated account: this test deliberately gets a transaction rejected.
      const funded = await fundedAccount();
      // Clock starts ~1h in the past, so the first envelope's timebounds are already
      // expired when it reaches consensus → a REAL tx_too_late, not a simulated one.
      let clock = Math.floor(Date.now() / 1000) - 3600;
      const svc = new AnchorService({
        store: funded.store,
        horizon: funded.horizon,
        keypair: funded.keypair,
        config,
        now: () => clock,
      });
      const proofHash = sha256(`real-${funded.keypair.publicKey()}-late`);

      const a = await svc.anchor({ proofId: 'live-late', proofHash });
      // The first submit was rejected by consensus on timebounds.
      expect(a.status).not.toBe(AnchorStatus.Confirmed);
      expect(a.errorClass).toBe(ErrorClass.TxTooLate);
      const expired = funded.store.getAttempt(a.activeAttemptId!)!;
      expect(expired.status).toBe('expired');

      // Move to real time and retry: reconcile (404, never landed) → rebuild, which
      // re-reads the on-chain sequence (still un-advanced) and confirms.
      clock = Math.floor(Date.now() / 1000);
      const after = await svc.retry(a.anchorId);
      expect(after.status).toBe(AnchorStatus.Confirmed);
      expect(after.anchorGeneration).toBe(0); // same logical anchor

      const rebuilt = funded.store.getAttempt(after.activeAttemptId!)!;
      expect(rebuilt.attemptId).not.toBe(expired.attemptId);
      // The expired tx never applied, so its sequence is reused — no gap.
      expect(rebuilt.sequenceNumber).toBe(expired.sequenceNumber);
      const tx = await funded.horizon.getTransaction(rebuilt.txHash!);
      expect(tx!.memoHashHex).toBe(proofHash);
    },
    90_000,
  );

  it('persisted the system-of-record to the on-disk SQLite file (reopen and verify)', () => {
    // Re-open the file with a SEPARATE connection — proves the data is on disk, not RAM.
    const reopened = new SqliteStore(IT_DB);
    const lineageHash = sha256(`real-${keypair.publicKey()}-lineage`);
    const rows = reopened.listLineage(lineageHash);
    expect(rows.length).toBeGreaterThanOrEqual(2); // gen 0 + gen 1 from the re-anchor test
    expect(rows.every((r) => r.proofHash === lineageHash)).toBe(true);
    expect(rows.some((r) => r.receiptJson)).toBe(true); // Horizon receipts persisted to disk
    reopened.close();
  });
});

describe.skipIf(!RUN)('live Horizon client classification', () => {
  it(
    'returns null (not an error) for a transaction that is not on-chain — a real 404',
    async () => {
      const horizon = new RealHorizonClient(config.horizonUrl, config.networkPassphrase);
      const missing = sha256('never-submitted-' + config.networkPassphrase).slice(0, 64);
      expect(await horizon.getTransaction(missing)).toBeNull();
    },
    30_000,
  );

  it(
    'returns null for an account that was never funded — a real 404',
    async () => {
      const horizon = new RealHorizonClient(config.horizonUrl, config.networkPassphrase);
      expect(await horizon.getAccount(Keypair.random().publicKey())).toBeNull();
    },
    30_000,
  );

  it(
    'classifies an unreachable Horizon as horizon_unavailable, never as a failure',
    async () => {
      // A guaranteed-unresolvable https host (the SDK rejects plain http at construction).
      // The DNS failure surfaces on the request, which is the transport path we classify.
      const dead = new RealHorizonClient(
        'https://horizon-does-not-exist.stellar.invalid',
        config.networkPassphrase,
      );
      let thrown: unknown;
      try {
        await dead.getTransaction(sha256('x'));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined(); // a clean 404 returns null; a transport failure throws
      expect(classifyError(thrown)).toBe(ErrorClass.HorizonUnavailable);
    },
    30_000,
  );
});
