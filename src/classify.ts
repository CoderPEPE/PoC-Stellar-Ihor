import { ErrorClass } from './types.js';

/**
 * Map a thrown error (from submit or a Horizon lookup) to an ErrorClass.
 *
 * This only distinguishes TRANSPORT failures and Stellar submit RESULT CODES.
 * The two semantic classifications — proof_mismatch and testnet_reset_suspected —
 * are decided by the reconcile logic (comparing on-chain memo / probing account
 * state), never by an exception, and so are not produced here.
 */
export function classifyError(err: unknown): ErrorClass {
  const e = err as Record<string, any> | null | undefined;

  // 1. Explicit Stellar transaction result code (from a failed submit response).
  const resultCode: unknown =
    e?.response?.data?.extras?.result_codes?.transaction ??
    e?.response?.data?.extras?.result_codes?.transaction_code;
  if (resultCode === 'tx_too_late') return ErrorClass.TxTooLate;
  if (resultCode === 'tx_bad_seq') return ErrorClass.TxBadSeq;
  if (resultCode === 'tx_insufficient_fee') return ErrorClass.TxInsufficientFee;
  if (resultCode === 'tx_insufficient_balance') return ErrorClass.InsufficientBalance;

  // 1b. Operation-level result codes (the tx was valid but an operation failed at apply).
  const opCodes: unknown = e?.response?.data?.extras?.result_codes?.operations;
  if (Array.isArray(opCodes) && opCodes.some((c) => c === 'op_underfunded')) {
    return ErrorClass.InsufficientBalance;
  }

  // 2. HTTP status (Horizon reachable but returned an error).
  const status: unknown = e?.response?.status ?? e?.status;
  if (typeof status === 'number') {
    if (status === 404) return ErrorClass.TxNotFound;
    if (status === 429 || status >= 500) return ErrorClass.HorizonUnavailable;
  }

  // 3. Transport-level failures (never reached Horizon, or connection dropped).
  // The stellar-sdk surfaces these as a plain Error whose `.code` is stripped and whose
  // message carries the OS reason (e.g. "getaddrinfo ENOTFOUND horizon..."), so we match
  // BOTH the structured code and the message text.
  const TRANSPORT_CODES = [
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ECONNRESET',
    'EAI_AGAIN',
    'EPIPE',
    'ERR_NETWORK',
    'ERR_CANCELED',
  ];
  const code = typeof e?.code === 'string' ? e.code : '';
  if (TRANSPORT_CODES.includes(code)) return ErrorClass.HorizonUnavailable;

  const msg = String(e?.message ?? '').toLowerCase();
  if (
    TRANSPORT_CODES.some((c) => msg.includes(c.toLowerCase())) ||
    msg.includes('getaddrinfo') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('socket hang up') ||
    msg.includes('network error')
  ) {
    return ErrorClass.HorizonUnavailable;
  }

  // 4. Anything else: do not guess success. Investigate.
  return ErrorClass.Unknown;
}

/**
 * Error classes from which the anchor is NOT terminal and a later retry is allowed.
 * `tx_insufficient_fee` is retryable (a fee surge may pass, or an operator re-fees);
 * `insufficient_balance` is NOT — the account must be funded before any retry helps.
 */
export function isRetryable(klass: ErrorClass): boolean {
  return (
    klass === ErrorClass.HorizonUnavailable ||
    klass === ErrorClass.TxNotFound ||
    klass === ErrorClass.TxTooLate ||
    klass === ErrorClass.TxBadSeq ||
    klass === ErrorClass.TxInsufficientFee ||
    klass === ErrorClass.Unknown
  );
}

export function errorToString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
