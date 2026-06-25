import { describe, expect, it } from 'vitest';
import { classifyError, isRetryable } from '../src/classify.js';
import { ErrorClass } from '../src/types.js';
import { httpError, resultCodeError, transportError } from '../src/stellar/horizonMock.js';

describe('classifyError', () => {
  it('maps connection refused / timeouts to horizon_unavailable', () => {
    expect(classifyError(transportError('ECONNREFUSED'))).toBe(ErrorClass.HorizonUnavailable);
    expect(classifyError(transportError('ETIMEDOUT'))).toBe(ErrorClass.HorizonUnavailable);
    expect(classifyError(new Error('timeout of 30000ms exceeded'))).toBe(
      ErrorClass.HorizonUnavailable,
    );
  });

  it('classifies a code-less transport error by its message (as the stellar-sdk throws)', () => {
    // The SDK strips `.code` and leaves the OS reason in the message.
    expect(classifyError(new Error('getaddrinfo ENOTFOUND horizon-testnet.stellar.org'))).toBe(
      ErrorClass.HorizonUnavailable,
    );
    expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(
      ErrorClass.HorizonUnavailable,
    );
  });

  it('maps 5xx and 429 to horizon_unavailable', () => {
    expect(classifyError(httpError(503))).toBe(ErrorClass.HorizonUnavailable);
    expect(classifyError(httpError(500))).toBe(ErrorClass.HorizonUnavailable);
    expect(classifyError(httpError(429))).toBe(ErrorClass.HorizonUnavailable);
  });

  it('maps a 404 to tx_not_found', () => {
    expect(classifyError(httpError(404))).toBe(ErrorClass.TxNotFound);
  });

  it('maps the tx_too_late result code', () => {
    expect(classifyError(resultCodeError('tx_too_late'))).toBe(ErrorClass.TxTooLate);
  });

  it('maps the tx_bad_seq result code', () => {
    expect(classifyError(resultCodeError('tx_bad_seq'))).toBe(ErrorClass.TxBadSeq);
  });

  it('maps fee and balance result codes', () => {
    expect(classifyError(resultCodeError('tx_insufficient_fee'))).toBe(ErrorClass.TxInsufficientFee);
    expect(classifyError(resultCodeError('tx_insufficient_balance'))).toBe(
      ErrorClass.InsufficientBalance,
    );
  });

  it('maps an op_underfunded operation result code to insufficient_balance', () => {
    const err = new Error('op failed') as Error & {
      response: { status: number; data: { extras: { result_codes: { operations: string[] } } } };
    };
    err.response = {
      status: 400,
      data: { extras: { result_codes: { operations: ['op_underfunded'] } } },
    };
    expect(classifyError(err)).toBe(ErrorClass.InsufficientBalance);
  });

  it('falls back to unknown for unrecognized errors', () => {
    expect(classifyError(new Error('something weird'))).toBe(ErrorClass.Unknown);
  });

  it('never auto-derives proof_mismatch or testnet_reset from an exception', () => {
    // These two are decided by reconcile from on-chain evidence, not by classify.
    const classes = [
      classifyError(httpError(503)),
      classifyError(httpError(404)),
      classifyError(resultCodeError('tx_too_late')),
      classifyError(new Error('x')),
    ];
    expect(classes).not.toContain(ErrorClass.ProofMismatch);
    expect(classes).not.toContain(ErrorClass.TestnetResetSuspected);
  });
});

describe('isRetryable', () => {
  it('treats transport / not-found / too-late / unknown as retryable', () => {
    expect(isRetryable(ErrorClass.HorizonUnavailable)).toBe(true);
    expect(isRetryable(ErrorClass.TxNotFound)).toBe(true);
    expect(isRetryable(ErrorClass.TxTooLate)).toBe(true);
    expect(isRetryable(ErrorClass.TxBadSeq)).toBe(true);
    expect(isRetryable(ErrorClass.Unknown)).toBe(true);
  });

  it('treats insufficient fee as retryable but insufficient balance as not', () => {
    expect(isRetryable(ErrorClass.TxInsufficientFee)).toBe(true);
    expect(isRetryable(ErrorClass.InsufficientBalance)).toBe(false);
  });

  it('treats integrity / reset faults as not auto-retryable', () => {
    expect(isRetryable(ErrorClass.ProofMismatch)).toBe(false);
    expect(isRetryable(ErrorClass.TestnetResetSuspected)).toBe(false);
  });
});
