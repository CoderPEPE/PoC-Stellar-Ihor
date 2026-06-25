import { Networks, BASE_FEE } from '@stellar/stellar-sdk';

export interface Config {
  horizonUrl: string;
  /** Network passphrase — part of the idempotency key so anchors are network-scoped. */
  networkPassphrase: string;
  /** Transaction validity window in seconds (becomes the timebounds maxTime). */
  anchorTtlSeconds: number;
  baseFee: string;
  /** SQLite file path, or ':memory:' for an ephemeral DB (tests/demo). */
  dbPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const anchorTtlSeconds = Number(env.ANCHOR_TTL_SECONDS ?? 180);
  if (!Number.isFinite(anchorTtlSeconds) || anchorTtlSeconds <= 0) {
    throw new Error(`ANCHOR_TTL_SECONDS must be a positive number, got "${env.ANCHOR_TTL_SECONDS}"`);
  }
  const baseFee = env.BASE_FEE ?? BASE_FEE;
  if (!/^\d+$/.test(baseFee) || BigInt(baseFee) <= 0n) {
    throw new Error(`BASE_FEE must be a positive integer (stroops), got "${baseFee}"`);
  }
  const networkPassphrase = env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
  if (!networkPassphrase) throw new Error('NETWORK_PASSPHRASE must not be empty');
  return {
    horizonUrl: env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    networkPassphrase,
    anchorTtlSeconds,
    baseFee,
    dbPath: env.DB_PATH ?? ':memory:',
  };
}
