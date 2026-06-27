# Design Review Answers

Addressing the 5 correctness questions from commit 3bc262d.

---

## 1. Atomic Child Confirmation + Parent Superseding

### Problem

```
child confirmed ──[crash]──→ parent superseded (NOT YET WRITTEN)
      ✓                                      ✗
```

`submitAttempt()` and `reconcile()` both call `supersedeParentOf()` as a **separate** database update after the child's confirm update. If the process crashes in between, both parent and child remain `confirmed`. On retry, `retry()` at line 120 checks `anchor.status === AnchorStatus.Confirmed` and returns immediately — the parent is never repaired.

### Design

**Primary — atomic transaction.** Add a single `confirmAndSupersede()` method to the `Store` interface that wraps both writes in one `better-sqlite3` transaction:

```typescript
confirmAndSupersede(
  childId: string,
  parentId: string | null,
  patch: { ledgerSeq: number; receiptJson: string; confirmedAt: string },
): void
```

Inside the transaction:
```sql
UPDATE anchors SET status='confirmed', ledger_seq=@ls, receipt_json=@rj, confirmed_at=@ca
  WHERE anchor_id=@child_id;
UPDATE anchors SET status='superseded'
  WHERE anchor_id=@parent_id AND status='confirmed';
```

WAL-mode commits are atomic and `better-sqlite3` transactions are serialized per connection, so a crash after the transaction begins cannot leave the parent un-superseded after the child confirms.

**Repair fallback (defense-in-depth).** Even with an atomic write, add an idempotent repair step at the top of `retry()`:

```typescript
// Idempotent repair: if this anchor confirmed but its parent did not get superseded,
// fix it now. Handles data from before the atomic transaction was introduced.
if (anchor.status === AnchorStatus.Confirmed && anchor.parentAnchorId) {
  const parent = this.store.getAnchor(anchor.parentAnchorId);
  if (parent && parent.status === AnchorStatus.Confirmed) {
    this.store.updateAnchor(parent.anchorId, { status: AnchorStatus.Superseded });
  }
}
```

This makes the system self-healing across upgrades: any leftover confirmed parent from a prior crash window is cleaned up on the next retry call.

---

## 2. Protecting the Sequence Line Across Multiple Workers

### Problem

Two separate gaps exist:

1. **Inside `resetToChain()`**: `maxInFlightSequence` (SELECT) and `setSequence` (UPDATE) are separate operations. Concurrent workers can interleave:
   - Worker A reads `maxLive = 5`, computes `next = 6`
   - Worker B reads chain, reads `maxLive = null`, sets `next = chainSeq`
   - Worker A writes `next = 6` (possibly below what B set, or vice versa)

2. **Inside `buildAndSubmit()`**: `syncSequenceFromChain()` (which calls `resetToChain()`) runs *before* `reserve()`. Between those calls, another worker can reserve the same sequence number that `resetToChain` just established as the floor.

### Design

**Consolidate sync + reserve into one atomic operation.** Add a single `syncThenReserve()` method to the `Store`:

```typescript
/** Atomically sync the allocator to max(onChainNext, maxInFlight+1),
 *  then reserve and return the next sequence number. All inside one
 *  SQLite transaction — no gap for a concurrent worker to interleave. */
syncThenReserve(accountId: string, onChainNext: bigint): string;
```

Implementation:

```sql
BEGIN IMMEDIATE;
  -- Read the in-flight high-water mark under the same transaction
  SELECT COALESCE(MAX(CAST(sequence_number AS INTEGER)), 0)
  FROM anchor_attempts
  WHERE source_account = @id AND status IN ('pending', 'submitted');

  -- Compute next = MAX(maxInFlight + 1, onChainNext)
  -- Update the allocator
  UPDATE source_accounts SET next_sequence = @next_after_reserve
  WHERE account_id = @id;

  SELECT @reserved;  -- return the reserved number
COMMIT;
```

Because the SELECT runs inside the same transaction as the UPDATE, another worker's `maxInFlightSequence` query will see this worker's pending attempts (or will be blocked behind the commit). The racing worker's `syncThenReserve` runs sequentially.

**In `buildAndSubmit()`**, replace the sequence of:
```typescript
await this.syncSequenceFromChain();          // await gap here
const txSequence = this.sequences.reserve(...);
```
with:
```typescript
const account = await this.horizon.getAccount(accountId);
// now synchronous, inside the claim+insert transaction:
const txSequence = this.store.syncThenReserve(accountId, BigInt(account.sequence) + 1n);
```

The Horizon network call still happens before any lock is held (no contention), but the allocator read/write and the CAS+insert all share one transaction. A concurrent worker's `syncThenReserve` will either see the previous `syncThenReserve`'s `next_sequence` update (serialized by SQLite) or will be blocked until the current transaction commits.

---

## 3. Explicit Hash Mode ProofId Fallback

### Problem

In `run.ts`:

```typescript
const subject = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : DEFAULT_SUBJECT;
```

When using `pnpm run:testnet --hash <64hex>` without a positional subject argument, `subject` defaults to `'samples/demo-document.txt'`. This value becomes the `proofId` stored in the database — a filename pointing at demo content, even though the actual proof is whatever the explicit hash represents.

### Design

Separate the `proofId` resolution from the `proofHash` resolution. Add a `--proof-id` / `--pid` CLI flag:

```typescript
function resolveProofId(argv: string[], subject: string): string {
  const i = argv.indexOf('--proof-id');
  const flag = argv.find(a => a.startsWith('--proof-id='))?.slice(11)
    ?? (i >= 0 ? argv[i + 1] : undefined);
  if (flag) return flag;
  // In file mode, the subject itself is the proof identity.
  return subject;
}

function resolveProofHash(argv: string[]): string {
  const hashFlag = /* existing --hash logic */;
  if (hashFlag) return hashFlag;
  // File mode: hash the bytes.
  const subject = positionalSubject(argv);
  if (existsSync(subject) && statSync(subject).isFile()) {
    return sha256Hex(readFileSync(subject));
  }
  throw new Error('...');
}
```

The caller must supply:
- File mode: `pnpm run:testnet path/to/contract.pdf` → `proofId = "path/to/contract.pdf"`, `proofHash = sha256(bytes)`
- Hash mode: `pnpm run:testnet --hash abc123... --proof-id "contract-v2.pdf"` → `proofId = "contract-v2.pdf"`, `proofHash = "abc123..."`
- Hash mode without `--proof-id`: **throws a clear error** telling the user to supply one. No silent fallback to a demo file.

This keeps the database semantically correct: when someone reads back the lineage, `proofId` always reflects the caller's intent, not whatever default the `DEFAULT_SUBJECT` constant happened to be.

---

## 4. Normalized Receipt Schema

### Problem

Currently two different JSON shapes are stored in `anchor.receipt_json` depending on which path confirmed:

| Path | Shape stored | Fields |
|---|---|---|
| Direct submit (`submitAttempt` line 447) | `SubmitResult` | `hash`, `ledger`, `successful` |
| Reconcile (`reconcile` line 222) | `TxRecord` | `hash`, `ledger`, `successful`, `memoType`, `memoHashHex`, `createdAt` |

A consumer reading `receiptJson` must know which path was taken.

### Design

Define a single canonical `ConfirmationReceipt` type and normalize both paths to it:

```typescript
interface ConfirmationReceipt {
  txHash: string;
  ledgerSeq: number;
  confirmedAt: string;       // ISO-8601 timestamp
  memoHashHex: string;       // the anchored proof hash (always set for our anchors)
  envelopeHash?: string;     // the submit hash (may differ from tx hash in edge cases)
}
```

Both confirmation paths produce the same shape:

- **Direct submit success** (`submitAttempt`):
  ```typescript
  const receipt: ConfirmationReceipt = {
    txHash: res.hash,
    ledgerSeq: res.ledger,
    confirmedAt: this.nowIso(),
    memoHashHex: anchor.proofHash,
    envelopeHash: res.hash,    // submit hash is the tx hash for our flow
  };
  ```

- **Reconcile success** (`reconcile`):
  ```typescript
  const receipt: ConfirmationReceipt = {
    txHash: txRecord.hash,
    ledgerSeq: txRecord.ledger,
    confirmedAt: txRecord.createdAt,  // use Horizon's timestamp
    memoHashHex: txRecord.memoHashHex ?? anchor.proofHash,
  };
  ```

**Storing raw Horizon data for debugging** (optional): If debug trace is needed, add a separate `raw_response_json` column (or a sidecar `audit_log` table) that stores the unprocessed Horizon response. The canonical `receipt_json` stays normalized, clean, and predictable.

---

## 5. Cross-Platform Testnet Script

### Problem

```json
"test:testnet": "RUN_TESTNET=1 vitest run test/testnet.integration.test.ts"
```

`VAR=VALUE command` is Bourne shell syntax. On Windows (cmd.exe or PowerShell), this fails with `'RUN_TESTNET' is not recognized as an internal or external command`.

### Design

Use `cross-env` — a zero-runtime-dependency npm package that normalizes environment variable assignment across platforms:

```json
"test:testnet": "cross-env RUN_TESTNET=1 vitest run test/testnet.integration.test.ts"
```

Install: `pnpm add --save-dev cross-env`

`cross-env` works on:
- Unix (Linux, macOS): behaves identically to `VAR=VALUE` prefix
- Windows cmd.exe: sets the var with `SET VAR=VALUE &&`
- Windows PowerShell: uses `$env:VAR=VALUE;`

**Alternative (Node 20.12+):** Use `--env-file`:
```json
"test:testnet": "vitest run --env-file .env.testnet test/testnet.integration.test.ts"
```
Where `.env.testnet` contains `RUN_TESTNET=1`. This avoids any dependency but requires Node >= 20.12. `cross-env` is preferred for broader compatibility and because the POC already has `.env.example` — no second config file needed.

No behavioral change: the flag still gates the integration tests, and `process.env.RUN_TESTNET` in the test file works identically on every platform.
