import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { AnchorService } from '../src/anchorService.js';
import type { Config } from '../src/config.js';
import { SqliteStore } from '../src/db/store.js';
import {
  httpError,
  MockHorizonClient,
  resultCodeError,
  transportError,
} from '../src/stellar/horizonMock.js';
import { AnchorStatus, ErrorClass } from '../src/types.js';

const config: Config = {
  horizonUrl: 'http://mock',
  networkPassphrase: Networks.TESTNET,
  anchorTtlSeconds: 180,
  baseFee: '100',
  dbPath: ':memory:',
};

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function setup(now: () => number) {
  const store = new SqliteStore(':memory:');
  const horizon = new MockHorizonClient();
  const keypair = Keypair.random();
  store.initAccount(keypair.publicKey(), '100');
  const service = new AnchorService({ store, horizon, keypair, config, now });
  return { store, horizon, keypair, service };
}

describe('AnchorService', () => {
  it('1. is idempotent: a repeat anchor returns the same row and issues no second tx', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 5, successful: true });
    const proofHash = hash('p1');

    const a = await service.anchor({ proofId: 'p1', proofHash });
    const b = await service.anchor({ proofId: 'p1', proofHash });

    expect(b.anchorId).toBe(a.anchorId);
    expect(a.status).toBe(AnchorStatus.Confirmed);
    expect(horizon.submitCalls).toBe(1);
    expect(store.listLineage(proofHash)).toHaveLength(1);
  });

  it('2. happy path: build → submit → confirmed with ledger, receipt, and persisted XDR', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 42, successful: true });
    const proofHash = hash('p2');

    const a = await service.anchor({ proofId: 'p2', proofHash });

    expect(a.status).toBe(AnchorStatus.Confirmed);
    expect(a.ledgerSeq).toBe(42);
    expect(a.receiptJson).toBeTruthy();
    const attempt = store.getAttempt(a.activeAttemptId!)!;
    expect(attempt.txXdr).toBeTruthy(); // signed envelope persisted before submit
    expect(attempt.txHash).toBeTruthy();
  });

  it('3. timeout then reconcile: confirms via lookup WITHOUT resubmitting', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async () => {
      throw transportError('ETIMEDOUT');
    };
    const proofHash = hash('p3');

    let a = await service.anchor({ proofId: 'p3', proofHash });
    expect(a.status).toBe(AnchorStatus.Submitted);
    expect(a.errorClass).toBe(ErrorClass.HorizonUnavailable);
    expect(horizon.submitCalls).toBe(1);

    // The tx actually landed; Horizon now returns it with a matching memo.
    const txHash = store.getAttempt(a.activeAttemptId!)!.txHash!;
    horizon.getTransactionHandler = async (h) =>
      h === txHash
        ? {
            hash: txHash,
            ledger: 777,
            successful: true,
            memoType: 'hash',
            memoHashHex: proofHash,
            createdAt: 'now',
          }
        : null;

    a = await service.retry(a.anchorId);
    expect(a.status).toBe(AnchorStatus.Confirmed);
    expect(a.ledgerSeq).toBe(777);
    expect(horizon.submitCalls).toBe(1); // reconciled, not resubmitted
  });

  it('4. proof_mismatch: found on-chain but memo differs → terminal, never retried', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async () => {
      throw transportError('ETIMEDOUT');
    };
    const proofHash = hash('p4');

    let a = await service.anchor({ proofId: 'p4', proofHash });
    const txHash = store.getAttempt(a.activeAttemptId!)!.txHash!;
    horizon.getTransactionHandler = async () => ({
      hash: txHash,
      ledger: 9,
      successful: true,
      memoType: 'hash',
      memoHashHex: hash('SOMETHING-ELSE'),
      createdAt: 'now',
    });

    a = await service.retry(a.anchorId);
    expect(a.errorClass).toBe(ErrorClass.ProofMismatch);
    expect(a.status).not.toBe(AnchorStatus.Confirmed);

    const submitsBefore = horizon.submitCalls;
    a = await service.retry(a.anchorId); // a further retry must do nothing
    expect(horizon.submitCalls).toBe(submitsBefore);
    expect(a.errorClass).toBe(ErrorClass.ProofMismatch);
  });

  it('5. tx_too_late: expired envelope is rebuilt from on-chain sequence, same logical anchor', async () => {
    let clock = 1000;
    const { service, horizon, store, keypair } = setup(() => clock);
    horizon.submitHandler = async () => {
      throw transportError('ETIMEDOUT'); // stays in-flight with a maxTime
    };
    const proofHash = hash('p5');

    let a = await service.anchor({ proofId: 'p5', proofHash });
    const first = store.getAttempt(a.activeAttemptId!)!;

    // Advance past the timebounds window.
    clock = first.maxTime + 10;
    horizon.getTransactionHandler = async () => null; // never landed
    // The tx never applied, so the account's on-chain sequence is unchanged: it is
    // still one BELOW the sequence the (now-expired) envelope used. The rebuild must
    // re-read this and reuse that sequence — handing out a higher one is tx_bad_seq.
    horizon.getAccountHandler = async () => ({
      accountId: keypair.publicKey(),
      sequence: (BigInt(first.sequenceNumber) - 1n).toString(),
    });
    horizon.submitHandler = async (xdr) => {
      if (xdr === first.txXdr) throw resultCodeError('tx_too_late'); // old envelope expired
      return { hash: hash(xdr), ledger: 555, successful: true }; // rebuilt envelope works
    };

    a = await service.retry(a.anchorId);
    expect(a.status).toBe(AnchorStatus.Confirmed);
    expect(a.ledgerSeq).toBe(555);

    const rebuilt = store.getAttempt(a.activeAttemptId!)!;
    expect(rebuilt.attemptId).not.toBe(first.attemptId);
    expect(rebuilt.txHash).not.toBe(first.txHash); // fresh timebounds → new envelope
    expect(rebuilt.sequenceNumber).toBe(first.sequenceNumber); // unapplied seq is REUSED
    expect(a.anchorGeneration).toBe(0); // SAME logical anchor
    expect(store.getAttempt(first.attemptId)!.status).toBe('expired'); // audit preserved
  });

  it('6. testnet_reset_suspected: confirmed tx vanishes AND sequence regressed', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 300, successful: true });
    const proofHash = hash('p6');

    let a = await service.anchor({ proofId: 'p6', proofHash });
    expect(a.status).toBe(AnchorStatus.Confirmed);
    const attempt = store.getAttempt(a.activeAttemptId!)!;

    // Post-reset: tx gone AND account sequence regressed below what we consumed.
    horizon.getTransactionHandler = async () => null;
    horizon.getAccountHandler = async () => ({ accountId: attempt.sourceAccount, sequence: '0' });

    a = await service.reconcile(a.anchorId);
    expect(a.errorClass).toBe(ErrorClass.TestnetResetSuspected);
    expect(a.status).not.toBe(AnchorStatus.Failed);
  });

  it('6b. a bare 404 on a fresh submission is NOT a reset — stays non-terminal', async () => {
    const { service, horizon } = setup(() => 1000);
    horizon.submitHandler = async () => {
      throw transportError('ETIMEDOUT');
    };
    const proofHash = hash('p6b');

    let a = await service.anchor({ proofId: 'p6b', proofHash });
    expect(a.status).toBe(AnchorStatus.Submitted);
    horizon.getTransactionHandler = async () => null; // not found, freshly submitted

    a = await service.reconcile(a.anchorId);
    expect(a.errorClass).toBe(ErrorClass.TxNotFound);
    expect(a.status).not.toBe(AnchorStatus.Failed);
    expect(horizon.getAccountCalls).toBe(0); // no reset probe for a fresh 404
  });

  it('7. horizon_unavailable never marks the anchor failed', async () => {
    const { service, horizon } = setup(() => 1000);
    horizon.submitHandler = async () => {
      throw httpError(503);
    };
    const proofHash = hash('p7');

    let a = await service.anchor({ proofId: 'p7', proofHash });
    expect(a.errorClass).toBe(ErrorClass.HorizonUnavailable);
    expect(a.status).toBe(AnchorStatus.Submitted);

    horizon.getTransactionHandler = async () => null;
    a = await service.retry(a.anchorId); // still unavailable
    expect(a.status).not.toBe(AnchorStatus.Failed);
  });

  it('8. re-anchor preserves the prior receipt and links lineage', async () => {
    const { service, horizon, store } = setup(() => 1000);
    let ledger = 100;
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: ++ledger, successful: true });
    const proofHash = hash('p8');

    const v0 = await service.anchor({ proofId: 'p8', proofHash });
    expect(v0.status).toBe(AnchorStatus.Confirmed);
    const v0Receipt = store.getAnchor(v0.anchorId)!.receiptJson;
    const v0Ledger = v0.ledgerSeq;

    const v1 = await service.reanchor(v0.anchorId, 'testnet_reset');
    expect(v1.anchorGeneration).toBe(1);
    expect(v1.parentAnchorId).toBe(v0.anchorId);
    expect(v1.status).toBe(AnchorStatus.Confirmed);

    // Prior anchor: superseded, but receipt + ledger untouched.
    const v0After = store.getAnchor(v0.anchorId)!;
    expect(v0After.status).toBe(AnchorStatus.Superseded);
    expect(v0After.receiptJson).toBe(v0Receipt);
    expect(v0After.ledgerSeq).toBe(v0Ledger);

    // Lineage + public projection.
    const lineage = service.lineage(proofHash);
    expect(lineage.map((r) => r.anchorGeneration)).toEqual([0, 1]);
    expect(lineage[0]!.status).toBe('superseded');
    expect(lineage[1]!.status).toBe('anchored');
    expect(lineage[1]!.supersedes).toBe(v0.anchorId);
    expect(service.publicReceipt(v1.anchorId).verificationUrl).toContain('/testnet/tx/');
  });

  it('9. concurrent anchor() calls for the same proof submit exactly once', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async (xdr) => {
      await Promise.resolve(); // force a microtask yield, as a real network would
      return { hash: hash(xdr), ledger: 7, successful: true };
    };
    const proofHash = hash('p9');

    const [a, b] = await Promise.all([
      service.anchor({ proofId: 'p9', proofHash }),
      service.anchor({ proofId: 'p9', proofHash }),
    ]);

    expect(a.anchorId).toBe(b.anchorId);
    expect(horizon.submitCalls).toBe(1); // activeAttemptId is set before the first await
    expect(store.listLineage(proofHash)).toHaveLength(1);
    expect(store.getAnchor(a.anchorId)!.status).toBe(AnchorStatus.Confirmed);
  });

  it('10. a submit that resolves with successful=false is NOT confirmed', async () => {
    const { service, horizon } = setup(() => 1000);
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 1, successful: false });
    const proofHash = hash('p10');

    const a = await service.anchor({ proofId: 'p10', proofHash });
    expect(a.status).not.toBe(AnchorStatus.Confirmed);
    expect(a.status).toBe(AnchorStatus.Submitted);
    expect(a.ledgerSeq).toBeNull();
  });

  it('11. anchoring an already-confirmed proof returns immediately, no new submit', async () => {
    const { service, horizon } = setup(() => 1000);
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 3, successful: true });
    const proofHash = hash('p11');

    const first = await service.anchor({ proofId: 'p11', proofHash });
    expect(first.status).toBe(AnchorStatus.Confirmed);
    const callsAfterFirst = horizon.submitCalls;

    const second = await service.anchor({ proofId: 'p11', proofHash });
    expect(second.anchorId).toBe(first.anchorId);
    expect(horizon.submitCalls).toBe(callsAfterFirst); // no extra submission
  });

  it('12. reconcile is a no-op when there is no attempt yet', async () => {
    const { service, store } = setup(() => 1000);
    const proofHash = hash('p12');
    // Insert a pending anchor with no attempt (simulate a build that never ran).
    const inserted = store.insertAnchorIfAbsent({
      anchorId: 'anchor-12',
      proofId: 'p12',
      proofHash,
      anchorGeneration: 0,
      parentAnchorId: null,
      clientTxId: 'client-12',
      status: AnchorStatus.Pending,
      errorClass: null,
      reason: null,
      activeAttemptId: null,
      ledgerSeq: null,
      receiptJson: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: null,
    });
    const after = await service.reconcile(inserted.anchorId);
    expect(after.status).toBe(AnchorStatus.Pending);
    expect(after.errorClass).toBeNull();
  });

  it('13. retrying an unknown anchor id throws', async () => {
    const { service } = setup(() => 1000);
    await expect(service.retry('does-not-exist')).rejects.toThrow(/Unknown anchor/);
  });

  it('14. rejects an invalid proof hash up front', async () => {
    const { service } = setup(() => 1000);
    await expect(service.anchor({ proofId: 'bad', proofHash: 'not-a-hash' })).rejects.toThrow(
      /Invalid proof hash/,
    );
  });

  it('15. tx_bad_seq: stale-sequence envelope is rebuilt from current on-chain sequence', async () => {
    const { service, horizon, store, keypair } = setup(() => 1000);
    horizon.submitHandler = async () => {
      throw transportError('ETIMEDOUT'); // first submit times out → in-flight
    };
    const proofHash = hash('p15');

    let a = await service.anchor({ proofId: 'p15', proofHash });
    const first = store.getAttempt(a.activeAttemptId!)!;

    horizon.getTransactionHandler = async () => null; // not on-chain
    // On-chain sequence has moved on (e.g. other jobs), so the stored envelope's
    // sequence is now stale → tx_bad_seq. The rebuild must adopt the on-chain value.
    horizon.getAccountHandler = async () => ({ accountId: keypair.publicKey(), sequence: '205' });
    horizon.submitHandler = async (xdr) => {
      if (xdr === first.txXdr) throw resultCodeError('tx_bad_seq'); // stale envelope
      return { hash: hash(xdr), ledger: 606, successful: true }; // rebuilt envelope works
    };

    a = await service.retry(a.anchorId);
    expect(a.status).toBe(AnchorStatus.Confirmed);
    expect(a.ledgerSeq).toBe(606);

    const rebuilt = store.getAttempt(a.activeAttemptId!)!;
    expect(rebuilt.sequenceNumber).toBe('206'); // on-chain sequence + 1
    expect(rebuilt.attemptId).not.toBe(first.attemptId);
    expect(a.anchorGeneration).toBe(0); // SAME logical anchor
  });

  it('16. reconcile: tx found with a matching memo but successful=false is NOT confirmed', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async () => {
      throw transportError('ETIMEDOUT');
    };
    const proofHash = hash('p16');

    let a = await service.anchor({ proofId: 'p16', proofHash });
    const txHash = store.getAttempt(a.activeAttemptId!)!.txHash!;
    // Found on-chain, memo matches, but the tx FAILED at apply.
    horizon.getTransactionHandler = async () => ({
      hash: txHash,
      ledger: 9,
      successful: false,
      memoType: 'hash',
      memoHashHex: proofHash,
      createdAt: 'now',
    });

    a = await service.reconcile(a.anchorId);
    expect(a.status).not.toBe(AnchorStatus.Confirmed);
    expect(a.ledgerSeq).toBeNull();
    expect(store.getAttempt(a.activeAttemptId!)!.status).toBe('failed');
  });

  it('17. atomic claim: two workers racing the same anchor, exactly one wins', () => {
    const { store } = setup(() => 1000);
    const inserted = store.insertAnchorIfAbsent({
      anchorId: 'anchor-17',
      proofId: 'p17',
      proofHash: hash('p17'),
      anchorGeneration: 0,
      parentAnchorId: null,
      clientTxId: 'client-17',
      status: AnchorStatus.Pending,
      errorClass: null,
      reason: null,
      activeAttemptId: null,
      ledgerSeq: null,
      receiptJson: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: null,
    });
    const w1 = store.claimAnchor(inserted.anchorId, 'attempt-A', null);
    const w2 = store.claimAnchor(inserted.anchorId, 'attempt-B', null); // loses: already claimed
    expect(w1).toBe(true);
    expect(w2).toBe(false);
    expect(store.getAnchor(inserted.anchorId)!.activeAttemptId).toBe('attempt-A');
    // A rebuild compare-and-swaps from the current attempt; a swap from a wrong
    // "expected" value must fail.
    expect(store.claimAnchor(inserted.anchorId, 'attempt-C', 'attempt-WRONG')).toBe(false);
    expect(store.claimAnchor(inserted.anchorId, 'attempt-C', 'attempt-A')).toBe(true);
  });

  it('18. rebuild when the account vanished is non-terminal and flags a suspected reset', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async () => {
      throw transportError('ETIMEDOUT');
    };
    const proofHash = hash('p18');

    let a = await service.anchor({ proofId: 'p18', proofHash });
    const first = store.getAttempt(a.activeAttemptId!)!;

    // The stored envelope is now expired, forcing a rebuild — but the account is gone.
    horizon.getTransactionHandler = async () => null;
    horizon.getAccountHandler = async () => null; // vanished
    horizon.submitHandler = async (xdr) =>
      xdr === first.txXdr
        ? Promise.reject(resultCodeError('tx_too_late'))
        : { hash: hash(xdr), ledger: 1, successful: true };

    a = await service.retry(a.anchorId);
    expect(a.status).not.toBe(AnchorStatus.Failed);
    expect(a.errorClass).toBe(ErrorClass.TestnetResetSuspected);
    // The claim was never taken (resync failed before claiming), so the anchor still
    // points at the original attempt.
    expect(a.activeAttemptId).toBe(first.attemptId);
  });

  it('19. re-anchor does NOT supersede the parent when the child fails to confirm', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 10, successful: true });
    const proofHash = hash('p19');

    const v0 = await service.anchor({ proofId: 'p19', proofHash });
    expect(v0.status).toBe(AnchorStatus.Confirmed);

    // The re-anchor's submission times out (stays in-flight, never confirmed).
    horizon.submitHandler = async () => {
      throw transportError('ETIMEDOUT');
    };
    const child = await service.reanchor(v0.anchorId, 'reset?');
    expect(child.status).not.toBe(AnchorStatus.Confirmed);

    // Parent must remain the live receipt — never retired for an unconfirmed child.
    expect(store.getAnchor(v0.anchorId)!.status).toBe(AnchorStatus.Confirmed);
  });

  it('20. re-anchor rejects a parent that was never confirmed', async () => {
    const { service, horizon } = setup(() => 1000);
    horizon.submitHandler = async () => {
      throw transportError('ETIMEDOUT'); // never confirms
    };
    const a = await service.anchor({ proofId: 'p20', proofHash: hash('p20') });
    expect(a.status).not.toBe(AnchorStatus.Confirmed);
    await expect(service.reanchor(a.anchorId, 'x')).rejects.toThrow(/expected confirmed/);
  });

  it('21. reconcile reset-probe transport failure is non-terminal (horizon_unavailable)', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 50, successful: true });
    const proofHash = hash('p21');

    let a = await service.anchor({ proofId: 'p21', proofHash });
    expect(a.status).toBe(AnchorStatus.Confirmed);

    // Confirmed tx now missing, and the corroborating account probe itself fails transport.
    horizon.getTransactionHandler = async () => null;
    horizon.getAccountHandler = async () => {
      throw httpError(503);
    };
    a = await service.reconcile(a.anchorId);
    expect(a.errorClass).toBe(ErrorClass.HorizonUnavailable); // not reset, not failed
    expect(a.status).not.toBe(AnchorStatus.Failed);
  });

  it('22. successful=false self-heals: a later retry rebuilds and confirms', async () => {
    const { service, horizon, store, keypair } = setup(() => 1000);
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 1, successful: false });
    const proofHash = hash('p22');

    let a = await service.anchor({ proofId: 'p22', proofHash });
    expect(a.status).not.toBe(AnchorStatus.Confirmed);
    const first = store.getAttempt(a.activeAttemptId!)!;
    expect(first.status).toBe('failed'); // included but failed at apply

    // The failed tx consumed its sequence; chain has moved on. Retry rebuilds + confirms.
    horizon.getTransactionHandler = async () => null;
    horizon.getAccountHandler = async () => ({
      accountId: keypair.publicKey(),
      sequence: first.sequenceNumber, // applied seq → next is +1
    });
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 99, successful: true });

    a = await service.retry(a.anchorId);
    expect(a.status).toBe(AnchorStatus.Confirmed);
    expect(a.ledgerSeq).toBe(99);
    expect(store.getAttempt(a.activeAttemptId!)!.sequenceNumber).toBe(
      (BigInt(first.sequenceNumber) + 1n).toString(),
    );
  });

  it('23. three-generation lineage stays append-only with correct supersedes links', async () => {
    const { service, horizon } = setup(() => 1000);
    let ledger = 100;
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: ++ledger, successful: true });
    const proofHash = hash('p23');

    const v0 = await service.anchor({ proofId: 'p23', proofHash });
    const v1 = await service.reanchor(v0.anchorId, 'reset-1');
    const v2 = await service.reanchor(v1.anchorId, 'reset-2');

    const lineage = service.lineage(proofHash);
    expect(lineage.map((r) => r.anchorGeneration)).toEqual([0, 1, 2]);
    expect(lineage.map((r) => r.status)).toEqual(['superseded', 'superseded', 'anchored']);
    expect(lineage[1]!.supersedes).toBe(v0.anchorId);
    expect(lineage[2]!.supersedes).toBe(v1.anchorId);
    expect(v2.anchorGeneration).toBe(2);
  });

  it('24. confirmed receipt is immutable: status cannot be downgraded, receipt cannot be overwritten', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 7, successful: true });
    const a = await service.anchor({ proofId: 'p24', proofHash: hash('p24') });
    const receipt = store.getAnchor(a.anchorId)!.receiptJson;

    // Attempt to vandalise a confirmed anchor directly through the store.
    store.updateAnchor(a.anchorId, {
      status: AnchorStatus.Submitted,
      receiptJson: 'TAMPERED',
      ledgerSeq: 0,
      confirmedAt: 'nope',
    });
    const after = store.getAnchor(a.anchorId)!;
    expect(after.status).toBe(AnchorStatus.Confirmed); // downgrade blocked
    expect(after.receiptJson).toBe(receipt); // receipt preserved
    expect(after.ledgerSeq).toBe(7);
    // …but superseding (re-anchor) is still allowed.
    store.updateAnchor(a.anchorId, { status: AnchorStatus.Superseded });
    expect(store.getAnchor(a.anchorId)!.status).toBe(AnchorStatus.Superseded);
  });

  it('25. self-seeds the allocator from chain when the account was never initialised', async () => {
    // NOTE: no store.initAccount() here — the service must seed itself.
    const store = new SqliteStore(':memory:');
    const horizon = new MockHorizonClient();
    const keypair = Keypair.random();
    horizon.getAccountHandler = async () => ({ accountId: keypair.publicKey(), sequence: '500' });
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 12, successful: true });
    const service = new AnchorService({ store, horizon, keypair, config, now: () => 1000 });

    const a = await service.anchor({ proofId: 'p25', proofHash: hash('p25') });
    expect(a.status).toBe(AnchorStatus.Confirmed);
    expect(store.getAttempt(a.activeAttemptId!)!.sequenceNumber).toBe('501'); // on-chain seq + 1
    expect(horizon.getAccountCalls).toBe(1); // seeded exactly once
  });

  it('26. claimAndInsertAttempt is atomic: a losing CAS inserts no attempt row', () => {
    const { store } = setup(() => 1000);
    const base = {
      anchorId: 'anchor-26',
      proofId: 'p26',
      proofHash: hash('p26'),
      anchorGeneration: 0,
      parentAnchorId: null,
      clientTxId: 'client-26',
      status: AnchorStatus.Pending,
      errorClass: null,
      reason: null,
      activeAttemptId: null,
      ledgerSeq: null,
      receiptJson: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: null,
    };
    store.insertAnchorIfAbsent(base);
    const mk = (id: string) => ({
      attemptId: id,
      anchorId: 'anchor-26',
      txHash: id,
      txXdr: 'xdr',
      sourceAccount: 'G...',
      sequenceNumber: '1',
      minTime: 0,
      maxTime: 9,
      status: 'pending' as const,
      errorClass: null,
      lastError: null,
      submittedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(store.claimAndInsertAttempt('anchor-26', null, mk('att-A'))).toBe(true);
    expect(store.claimAndInsertAttempt('anchor-26', null, mk('att-B'))).toBe(false); // loses CAS
    expect(store.getAnchor('anchor-26')!.activeAttemptId).toBe('att-A');
    expect(store.getAttempt('att-A')).not.toBeNull();
    expect(store.getAttempt('att-B')).toBeNull(); // loser inserted nothing
  });

  it('27. the sequence allocator is strictly monotonic and gap-free under repeated reserve', () => {
    const { store, keypair } = setup(() => 1000);
    const seqs: bigint[] = [];
    for (let i = 0; i < 50; i++) seqs.push(BigInt(store.reserveSequence(keypair.publicKey())));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]! - seqs[i - 1]!).toBe(1n); // each exactly one greater
    }
  });

  it('28. re-anchor that times out then confirms via retry supersedes the parent LATE', async () => {
    const { service, horizon, store } = setup(() => 1000);
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: 10, successful: true });
    const proofHash = hash('p28');

    // gen 0 is confirmed and live.
    const v0 = await service.anchor({ proofId: 'p28', proofHash });
    expect(v0.status).toBe(AnchorStatus.Confirmed);

    // Re-anchor, but the child's submission TIMES OUT — it stays in-flight, NOT confirmed.
    horizon.submitHandler = async () => {
      throw transportError('ETIMEDOUT');
    };
    const child = await service.reanchor(v0.anchorId, 'manual re-anchor via run.ts');
    expect(child.anchorGeneration).toBe(1);
    expect(child.status).not.toBe(AnchorStatus.Confirmed);
    // Parent is still the live receipt — never retired for a child that hasn't landed.
    expect(store.getAnchor(v0.anchorId)!.status).toBe(AnchorStatus.Confirmed);

    // The child's tx actually landed; a later retry reconciles it WITHOUT resubmitting.
    const childTxHash = store.getAttempt(child.activeAttemptId!)!.txHash!;
    const submitsBefore = horizon.submitCalls;
    horizon.getTransactionHandler = async (h) =>
      h === childTxHash
        ? {
            hash: childTxHash,
            ledger: 888,
            successful: true,
            memoType: 'hash',
            memoHashHex: proofHash,
            createdAt: 'now',
          }
        : null;

    const confirmedChild = await service.retry(child.anchorId);
    expect(confirmedChild.status).toBe(AnchorStatus.Confirmed);
    expect(confirmedChild.ledgerSeq).toBe(888);
    expect(horizon.submitCalls).toBe(submitsBefore); // reconciled, not resubmitted

    // THE POINT: the parent must now be superseded, even though the child confirmed LATE.
    const v0After = store.getAnchor(v0.anchorId)!;
    expect(v0After.status).toBe(AnchorStatus.Superseded);
    expect(v0After.receiptJson).toBeTruthy(); // receipt preserved (append-only)
    expect(v0After.ledgerSeq).toBe(10); // …only the status flipped
    expect(service.lineage(proofHash).map((r) => r.status)).toEqual(['superseded', 'anchored']);
  });

  it('29. resync never reissues a sequence still held by a LIVE in-flight attempt', async () => {
    let clock = 1000;
    const { service, horizon, store, keypair } = setup(() => clock);
    horizon.submitHandler = async () => {
      throw transportError('ETIMEDOUT'); // everything stays in-flight ('submitted')
    };

    // B anchors at the first sequence and stays live (in-flight, never settled).
    const b = await service.anchor({ proofId: 'p29b', proofHash: hash('p29b') });
    const bAttempt = store.getAttempt(b.activeAttemptId!)!;
    expect(bAttempt.status).toBe('submitted');

    // A anchors at the next sequence, also in-flight.
    const a = await service.anchor({ proofId: 'p29a', proofHash: hash('p29a') });
    const aFirst = store.getAttempt(a.activeAttemptId!)!;
    expect(BigInt(aFirst.sequenceNumber)).toBe(BigInt(bAttempt.sequenceNumber) + 1n);

    // A expires and is retried → it REBUILDS, which resyncs from chain. The chain still
    // reports a sequence BELOW B's (nothing has applied yet). A naïve reset to
    // account.sequence+1 would hand A the SAME sequence B is still holding → collision.
    clock = aFirst.maxTime + 10;
    horizon.getTransactionHandler = async () => null;
    horizon.getAccountHandler = async () => ({
      accountId: keypair.publicKey(),
      sequence: (BigInt(bAttempt.sequenceNumber) - 1n).toString(),
    });
    horizon.submitHandler = async (xdr) =>
      xdr === aFirst.txXdr
        ? Promise.reject(resultCodeError('tx_too_late')) // old envelope expired
        : { hash: hash(xdr), ledger: 700, successful: true }; // rebuilt one works

    const aRetried = await service.retry(a.anchorId);
    const aRebuilt = store.getAttempt(aRetried.activeAttemptId!)!;

    // The rebuilt sequence must skip PAST B's live, in-flight sequence — not reissue it.
    expect(aRebuilt.sequenceNumber).not.toBe(bAttempt.sequenceNumber);
    expect(BigInt(aRebuilt.sequenceNumber)).toBe(BigInt(bAttempt.sequenceNumber) + 1n);
    expect(store.getAttempt(b.activeAttemptId!)!.status).toBe('submitted'); // B untouched
  });

  it('30. reconcile does NOT resurrect a superseded anchor', async () => {
    const { service, horizon, store } = setup(() => 1000);
    let ledger = 10;
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: ++ledger, successful: true });
    const proofHash = hash('p30');

    const v0 = await service.anchor({ proofId: 'p30', proofHash });
    const v1 = await service.reanchor(v0.anchorId, 'reset');
    expect(store.getAnchor(v0.anchorId)!.status).toBe(AnchorStatus.Superseded);

    // v0's tx is still perfectly valid on-chain (same memo — a re-anchor reuses the hash).
    const v0Tx = store.getAttempt(v0.activeAttemptId!)!.txHash!;
    horizon.getTransactionHandler = async (h) =>
      h === v0Tx
        ? { hash: v0Tx, ledger: 11, successful: true, memoType: 'hash', memoHashHex: proofHash, createdAt: 'now' }
        : null;

    const after = await service.reconcile(v0.anchorId);
    expect(after.status).toBe(AnchorStatus.Superseded); // NOT flipped back to confirmed
    expect(store.getAnchor(v1.anchorId)!.status).toBe(AnchorStatus.Confirmed); // latest stays live
  });

  it('31. retry on a superseded anchor is a no-op (no resubmit, stays superseded)', async () => {
    const { service, horizon, store } = setup(() => 1000);
    let ledger = 20;
    horizon.submitHandler = async (xdr) => ({ hash: hash(xdr), ledger: ++ledger, successful: true });
    const proofHash = hash('p31');

    const v0 = await service.anchor({ proofId: 'p31', proofHash });
    await service.reanchor(v0.anchorId, 'reset');
    expect(store.getAnchor(v0.anchorId)!.status).toBe(AnchorStatus.Superseded);

    const submitsBefore = horizon.submitCalls;
    const after = await service.retry(v0.anchorId);
    expect(after.status).toBe(AnchorStatus.Superseded);
    expect(horizon.submitCalls).toBe(submitsBefore); // never resubmitted the retired envelope
  });

  it('32. direct submit catches proof_mismatch when the submit response memo differs', async () => {
    const { service, horizon } = setup(() => 1000);
    const proofHash = hash('p32');
    horizon.submitHandler = async (xdr) => ({
      hash: hash(xdr),
      ledger: 5,
      successful: true,
      memoType: 'hash',
      memoHashHex: hash('SOMETHING-ELSE'), // chain memo ≠ our proof hash
      createdAt: 'now',
    });

    const a = await service.anchor({ proofId: 'p32', proofHash });
    expect(a.status).not.toBe(AnchorStatus.Confirmed);
    expect(a.errorClass).toBe(ErrorClass.ProofMismatch); // caught on the direct path, not only via reconcile
  });

  it('33. direct submit records chain ledger-time + read-back memo and confirms the attempt atomically', async () => {
    const { service, store, horizon } = setup(() => 1000);
    const proofHash = hash('p33');
    horizon.submitHandler = async (xdr) => ({
      hash: hash(xdr),
      ledger: 9,
      successful: true,
      memoType: 'hash',
      memoHashHex: proofHash,
      createdAt: '2030-01-02T03:04:05Z',
    });

    const a = await service.anchor({ proofId: 'p33', proofHash });
    expect(a.status).toBe(AnchorStatus.Confirmed);
    const receipt = JSON.parse(store.getAnchor(a.anchorId)!.receiptJson!);
    expect(receipt.confirmedAt).toBe('2030-01-02T03:04:05Z'); // chain time, not the local clock
    expect(receipt.memoHashHex).toBe(proofHash);
    expect(store.getAttempt(a.activeAttemptId!)!.status).toBe('confirmed'); // confirmed in the same txn
  });
});
