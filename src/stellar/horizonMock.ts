import type {
  AccountRecord,
  HorizonClient,
  SubmitResult,
  TxRecord,
} from './horizon.js';

/**
 * Programmable in-memory Horizon for tests and the offline demo.
 *
 * Each method delegates to a handler the test can swap at any point, so a single
 * flow can move from "submit times out" to "tx now visible on-chain" without any
 * real network. Call counters let tests assert e.g. that reconcile confirmed an
 * anchor WITHOUT issuing a second submission.
 */
export class MockHorizonClient implements HorizonClient {
  submitCalls = 0;
  getTransactionCalls = 0;
  getAccountCalls = 0;

  submitHandler: (xdr: string) => Promise<SubmitResult> = async () => {
    throw new Error('submitHandler not configured');
  };
  getTransactionHandler: (hash: string) => Promise<TxRecord | null> = async () => null;
  getAccountHandler: (accountId: string) => Promise<AccountRecord | null> = async () => null;

  async submit(signedXdr: string): Promise<SubmitResult> {
    this.submitCalls++;
    return this.submitHandler(signedXdr);
  }

  async getTransaction(hash: string): Promise<TxRecord | null> {
    this.getTransactionCalls++;
    return this.getTransactionHandler(hash);
  }

  async getAccount(accountId: string): Promise<AccountRecord | null> {
    this.getAccountCalls++;
    return this.getAccountHandler(accountId);
  }
}

/** Build a synthetic Horizon-style error with an HTTP status (transport failures). */
export function httpError(status: number, message = `HTTP ${status}`): Error {
  const err = new Error(message) as Error & { response: { status: number } };
  err.response = { status };
  return err;
}

/** Build a synthetic submit error carrying a Stellar transaction result code. */
export function resultCodeError(code: string): Error {
  const err = new Error(`tx failed: ${code}`) as Error & {
    response: { status: number; data: { extras: { result_codes: { transaction: string } } } };
  };
  err.response = {
    status: 400,
    data: { extras: { result_codes: { transaction: code } } },
  };
  return err;
}

/** Build a synthetic transport error (e.g. connection refused / timeout). */
export function transportError(code = 'ETIMEDOUT'): Error {
  const err = new Error(`network ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}
