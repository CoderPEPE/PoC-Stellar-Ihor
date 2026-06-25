/**
 * The minimal Horizon surface the anchoring flow needs. Everything else depends
 * on THIS interface, not on the Stellar SDK, which is what lets tests inject a
 * mock that deterministically reproduces timeouts, 404s, memo mismatches and
 * sequence regressions. Only network I/O is faked — signing is always real.
 */

export interface SubmitResult {
  hash: string;
  ledger: number;
  successful: boolean;
}

export interface TxRecord {
  hash: string;
  ledger: number;
  successful: boolean;
  /** 'hash' | 'text' | 'none' | … */
  memoType: string;
  /** The memo decoded to hex when memoType === 'hash', else null. */
  memoHashHex: string | null;
  createdAt: string;
}

export interface AccountRecord {
  accountId: string;
  /** Current account sequence as reported by Horizon (i64 string). */
  sequence: string;
}

export interface HorizonClient {
  /** Submit a signed envelope. Throws on transport error or a failing result code. */
  submit(signedXdr: string): Promise<SubmitResult>;
  /** Look up a transaction by hash. Returns null on a clean 404 (not found). */
  getTransaction(hash: string): Promise<TxRecord | null>;
  /** Look up an account. Returns null on a clean 404 (account missing). */
  getAccount(accountId: string): Promise<AccountRecord | null>;
}
