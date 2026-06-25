import { describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { assertValidProofHash, deriveClientTxId } from '../src/idempotency.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('deriveClientTxId', () => {
  it('is deterministic for the same inputs', () => {
    expect(deriveClientTxId(HASH_A, Networks.TESTNET, 0)).toBe(
      deriveClientTxId(HASH_A, Networks.TESTNET, 0),
    );
  });

  it('returns a 64-char hex digest', () => {
    expect(deriveClientTxId(HASH_A, Networks.TESTNET, 0)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the generation changes (so a re-anchor is a new logical anchor)', () => {
    expect(deriveClientTxId(HASH_A, Networks.TESTNET, 0)).not.toBe(
      deriveClientTxId(HASH_A, Networks.TESTNET, 1),
    );
  });

  it('changes when the network changes (anchors are network-scoped)', () => {
    expect(deriveClientTxId(HASH_A, Networks.TESTNET, 0)).not.toBe(
      deriveClientTxId(HASH_A, Networks.PUBLIC, 0),
    );
  });

  it('changes when the proof hash changes', () => {
    expect(deriveClientTxId(HASH_A, Networks.TESTNET, 0)).not.toBe(
      deriveClientTxId(HASH_B, Networks.TESTNET, 0),
    );
  });

  it('property: distinct (hash, network, generation) triples never collide', () => {
    const hashes = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(64, '0'));
    const networks = [Networks.TESTNET, Networks.PUBLIC];
    const keys = new Map<string, string>();
    for (const h of hashes) {
      for (const net of networks) {
        for (let gen = 0; gen < 4; gen++) {
          const id = deriveClientTxId(h, net, gen);
          const tag = `${h}|${net}|${gen}`;
          // Same input → same key (idempotent); different input → never seen before.
          expect(keys.has(id)).toBe(false);
          keys.set(id, tag);
        }
      }
    }
    expect(keys.size).toBe(hashes.length * networks.length * 4);
  });
});

describe('assertValidProofHash', () => {
  it('accepts 64 lowercase hex chars', () => {
    expect(() => assertValidProofHash(HASH_A)).not.toThrow();
  });

  it('rejects wrong length / non-hex', () => {
    expect(() => assertValidProofHash('abc')).toThrow();
    expect(() => assertValidProofHash('Z'.repeat(64))).toThrow();
  });
});
