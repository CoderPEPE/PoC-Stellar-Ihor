import {
  Account,
  Asset,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { assertValidProofHash } from '../idempotency.js';

export interface BuildParams {
  keypair: Keypair;
  /** 32-byte content hash, hex-encoded (64 chars). */
  proofHashHex: string;
  /** The sequence number for THIS transaction (i64 string). */
  txSequence: string;
  /** Timebounds lower bound (unix seconds); 0 = no lower bound. */
  minTime: number;
  /** Timebounds upper bound (unix seconds); after this a resubmit is tx_too_late. */
  maxTime: number;
  networkPassphrase: string;
  baseFee: string;
}

export interface BuiltTx {
  txHash: string;
  /** Signed envelope, base64 XDR — persist this BEFORE submitting. */
  txXdr: string;
  sequenceNumber: string;
  minTime: number;
  maxTime: number;
  sourceAccount: string;
}

/**
 * Build and sign the anchoring transaction.
 *
 * The proof hash rides in a MemoHash. A memo is not itself an operation, and a
 * valid transaction needs at least one, so we attach a single 1-stroop payment
 * to self (source == destination) as the carrier:
 *   - net-zero state change (only the base fee is consumed),
 *   - no extra base reserve (unlike manageData/createAccount),
 *   - orthogonal to our sequence allocator (unlike bumpSequence),
 *   - universally valid and trivially verifiable (verification reads only the memo).
 *
 * The sequence and timebounds are pinned here so the resulting signed envelope is
 * fixed and can be resubmitted byte-for-byte (idempotent on the network, which
 * dedupes by transaction hash).
 */
export function buildAnchorTx(params: BuildParams): BuiltTx {
  assertValidProofHash(params.proofHashHex);

  const source = params.keypair.publicKey();
  // TransactionBuilder uses account.sequence + 1 for the tx; we want the tx itself
  // to carry params.txSequence, so seed the account with txSequence - 1.
  const accountSeq = (BigInt(params.txSequence) - 1n).toString();
  const account = new Account(source, accountSeq);

  const tx = new TransactionBuilder(account, {
    fee: params.baseFee,
    networkPassphrase: params.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: source,
        asset: Asset.native(),
        amount: '0.0000001', // 1 stroop
      }),
    )
    .addMemo(Memo.hash(Buffer.from(params.proofHashHex, 'hex')))
    .setTimebounds(params.minTime, params.maxTime)
    .build();

  tx.sign(params.keypair);

  return {
    txHash: tx.hash().toString('hex'),
    txXdr: tx.toXDR(),
    sequenceNumber: params.txSequence,
    minTime: params.minTime,
    maxTime: params.maxTime,
    sourceAccount: source,
  };
}
