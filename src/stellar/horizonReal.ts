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
    // The synchronous submit response is the included tx resource — pull the
    // authoritative memo and ledger-close time off it defensively (the SDK type
    // doesn't always declare them) so the receipt matches the reconcile provenance.
    const r = res as unknown as Record<string, unknown>;
    let memoHashHex: string | null = null;
    if (r.memo_type === 'hash' && typeof r.memo === 'string') {
      memoHashHex = Buffer.from(r.memo, 'base64').toString('hex');
    }
    return {
      hash: res.hash,
      ledger: Number.isFinite(ledger) ? ledger : 0,
      // submitTransaction resolves only on inclusion; treat as successful unless the
      // SDK explicitly says otherwise (never silently coerce a false into a true).
      successful: (res as { successful?: boolean }).successful !== false,
      createdAt: typeof r.created_at === 'string' ? r.created_at : undefined,
      memoType: typeof r.memo_type === 'string' ? r.memo_type : undefined,
      memoHashHex,
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
