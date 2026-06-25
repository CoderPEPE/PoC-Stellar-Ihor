import { Horizon, TransactionBuilder } from '@stellar/stellar-sdk';
import type {
  AccountRecord,
  HorizonClient,
  SubmitResult,
  TxRecord,
} from './horizon.js';

function isNotFound(err: unknown): boolean {
  const e = err as Record<string, any> | null | undefined;
  const status = e?.response?.status ?? e?.status;
  return status === 404;
}

/** Real Horizon client over @stellar/stellar-sdk. Used by the live TESTNET test. */
export class RealHorizonClient implements HorizonClient {
  private readonly server: Horizon.Server;

  constructor(
    horizonUrl: string,
    private readonly networkPassphrase: string,
  ) {
    this.server = new Horizon.Server(horizonUrl);
  }

  async submit(signedXdr: string): Promise<SubmitResult> {
    const tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const res = await this.server.submitTransaction(tx);
    const ledger = Number((res as { ledger?: number | string }).ledger);
    return {
      hash: res.hash,
      ledger: Number.isFinite(ledger) ? ledger : 0,
      // submitTransaction resolves only on inclusion; treat as successful unless the
      // SDK explicitly says otherwise (never silently coerce a false into a true).
      successful: (res as { successful?: boolean }).successful !== false,
    };
  }

  async getTransaction(hash: string): Promise<TxRecord | null> {
    try {
      const r = await this.server.transactions().transaction(hash).call();
      let memoHashHex: string | null = null;
      if (r.memo_type === 'hash' && r.memo) {
        memoHashHex = Buffer.from(r.memo, 'base64').toString('hex');
      }
      return {
        hash: r.hash,
        ledger: Number(r.ledger_attr), // numeric ledger seq (r.ledger is a fetch method)
        successful: r.successful,
        memoType: r.memo_type,
        memoHashHex,
        createdAt: r.created_at,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getAccount(accountId: string): Promise<AccountRecord | null> {
    try {
      const a = await this.server.accounts().accountId(accountId).call();
      return { accountId: a.account_id, sequence: a.sequence };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}
