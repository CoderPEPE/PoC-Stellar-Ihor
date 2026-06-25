# Proof Anchoring on Stellar TESTNET — POC

Anchor a content hash (a *proof*) onto Stellar TESTNET so anyone can later verify, on
their own, that it existed and was committed to the public ledger — while the flow stays
**idempotent**, survives **timeouts and testnet resets**, and keeps an **append-only
receipt lineage**.

The one design rule everything follows: **the local DB is the system of record; the chain
is for independent verification.** Submission and confirmation are separate phases, so an
uncertain submission is always *reconciled from on-chain evidence*, never guessed.

> Public-level only — no private repo, no real secrets. Live tests fund a throwaway
> keypair via Friendbot and write real TESTNET ledger entries.

```bash
pnpm install && pnpm test     # 53 tests, in-memory + mocked, ~0.5s, no network
pnpm demo                     # offline walk-through: anchor → idempotent repeat → re-anchor → lineage
```

`tsc --strict` clean · 53 mocked tests · 8 gated live-TESTNET tests · zero runtime deps beyond `@stellar/stellar-sdk` + `better-sqlite3`.

---

## Contents

1. [The brief, mapped to the code](#the-brief-mapped-to-the-code)
2. [How it works](#how-it-works)
   - [The minimal carrier operation](#the-minimal-carrier-operation)
   - [Data model](#data-model)
   - [Lifecycle](#lifecycle)
   - [Failure classification](#failure-classification)
   - [Idempotency & concurrency](#idempotency--concurrency)
   - [Sequence management & safe rebuild](#sequence-management--safe-rebuild)
   - [Receipt lineage](#receipt-lineage)
   - [Public vs internal](#public-vs-internal)
3. [Verifying a proof independently](#verifying-a-proof-independently)
4. [Running it](#running-it)
5. [Configuration](#configuration)
6. [Testing](#testing)
7. [Known limitations](#known-limitations-deliberate-poc-scope)
8. [Project layout](#project-layout)

---

## The brief, mapped to the code

Every question from the design brief, and exactly where it's answered:

| Question | Short answer | Code |
|---|---|---|
| **What to store locally?** | Two tables: one **logical anchor** per `(proof, generation)`, plus N **physical attempts** holding the signed XDR. | [`schema.sql`](src/db/schema.sql), [`store.ts`](src/db/store.ts) |
| **How to make retries idempotent?** | Deterministic `client_tx_id = sha256(proofHash\|network\|generation)` + a UNIQUE constraint + an atomic claim CAS. | [`idempotency.ts`](src/idempotency.ts), [`anchorService.ts`](src/anchorService.ts) |
| **Distinguish `proof_mismatch` vs `horizon_unavailable` vs `testnet_reset_suspected`?** | Decide from **on-chain evidence in `reconcile()`**, never from an exception. | [`classify.ts`](src/classify.ts), `reconcile()` |
| **Preserve receipt lineage?** | Re-anchor = a **new generation** linked by `parent_anchor_id`; the prior receipt is never overwritten. | `reanchor()` |
| **What to expose publicly?** | A verification-only projection; operational mechanics stay internal. | [`verify.ts`](src/verify.ts) |
| **Which anchoring method (memo / manageData / Soroban)?** | `MemoHash` on a minimal tx — native, cheap, no contract, no reserve. | [`txBuilder.ts`](src/stellar/txBuilder.ts) |
| **Sequence numbers under parallel jobs?** | A DB-locked central allocator; one account per worker (pool) for throughput. | [`sequence.ts`](src/stellar/sequence.ts) |
| **Exact statuses to store?** | Business `status` separated from `error_class` (see [Lifecycle](#lifecycle)). | [`types.ts`](src/types.ts) |
| **DB constraints against duplicate anchors?** | `UNIQUE(client_tx_id)`, `UNIQUE(tx_hash)`, `UNIQUE(proof_hash, generation)`. | [`schema.sql`](src/db/schema.sql) |

---

## How it works

### The minimal carrier operation

A Stellar transaction needs **at least one operation**, and a memo is *not* an operation —
so `MemoHash(proof_hash)` can't ride alone. This POC pairs it with a **1-stroop payment to
self** (`source == destination`, `0.0000001 XLM`):

| Property | Why it matters |
|---|---|
| **Net-zero state change** | the account pays itself; only the base fee (100 stroops) is consumed |
| **No extra reserve** | unlike `manageData` / `createAccount`, it locks up no base reserve and leaves no ledger entry to clean up |
| **Orthogonal to sequence mgmt** | unlike `bumpSequence`, it doesn't touch the sequence semantics we allocate centrally |
| **Universally valid + verifiable** | Horizon returns it like any payment; verification only ever reads the memo |

*Alternatives considered:* `bumpSequence` (entangles sequence management), `manageData`
(stores the hash but costs a base reserve and is a *different* anchoring method),
`createAccount` (valid once, wasteful), Soroban (only worth it if you later need on-chain
metadata or custom validation logic). See [`txBuilder.ts`](src/stellar/txBuilder.ts).

### Data model

Splitting **logical anchor** from **physical attempt** is what lets us resubmit the *exact*
envelope after a timeout, *and* rebuild after expiry — without ever creating a second
logical anchor.

```
anchors                              anchor_attempts
─────────────────────────────       ─────────────────────────────────
anchor_id          (PK)             attempt_id        (PK)
proof_id                            anchor_id         → anchors
proof_hash         immutable, 64hex tx_hash           UNIQUE (nullable)
anchor_generation  0,1,2,…          tx_xdr            signed envelope ← persisted BEFORE submit
parent_anchor_id   → anchors        source_account
client_tx_id       idempotency key  sequence_number   pinned at build time (i64 string)
status                              min_time / max_time  timebounds
error_class                         status            pending|submitted|confirmed|failed|expired
active_attempt_id  → attempts       error_class / last_error
ledger_seq · receipt_json           submitted_at · created_at
confirmed_at · created_at

UNIQUE (client_tx_id)                     -- same request never processed twice
UNIQUE (proof_hash, anchor_generation)    -- no duplicate anchor within a generation
UNIQUE (tx_hash)                          -- same on-chain tx never stored twice
CHECK  (status / error_class domains, length(proof_hash)=64)
```

Full DDL: [`schema.sql`](src/db/schema.sql).

### Lifecycle

```
anchor(proof)
  │  client_tx_id = sha256(proofHash | network | generation)
  │  INSERT anchor  ── ON CONFLICT DO NOTHING ──▶ idempotent (returns existing row)
  │  build + sign envelope, PERSIST XDR, then atomic claim+insert (CAS)
  ▼
[pending] ──submit──▶ ✅ [confirmed]  receipt stored, immutable
   │
   └─ timeout / 5xx / 404 ─▶ stays [submitted] + error_class   (NON-terminal, never "failed")
                                  │
                          retry() │  reconcile FIRST (cheap, safe), then act
                                  ▼
        ┌───────────────── reconcile(): classify from ON-CHAIN evidence ─────────────────┐
        │  memo==hash & successful   → ✅ confirmed                                       │
        │  memo != expected hash     → ❌ proof_mismatch          (terminal, alert)        │
        │  not found (fresh submit)  → ⏳ tx_not_found            (propagation, wait)       │
        │  was-confirmed, now gone   → 🔁 testnet_reset_suspected (+ corroborating signal) │
        │     + seq regressed / acct vanished                                             │
        │  transport error           → 🌐 horizon_unavailable     (backoff)                │
        └─────────────────────────────────────────────────────────────────────────────────┘
                                  │
          not settled → resubmit the EXACT stored XDR (network dedupes by tx hash)
          envelope provably dead (tx_too_late / tx_bad_seq) → rebuild, re-syncing the
              sequence from chain first (see below)

reanchor(parent) → new generation, parent → [superseded]  (only AFTER the child confirms)
```

### Failure classification

A transport hiccup must never be recorded as a permanent business state. Business `status`
and `error_class` are stored **separately**, and every class drives a specific action:

| Symptom (from submit or lookup) | `error_class` | Terminal? | Recovery |
|---|---|:--:|---|
| conn refused / DNS / timeout / 5xx / 429 | `horizon_unavailable` | no | backoff, resubmit the **exact** envelope |
| reachable, tx not found right after submit | `tx_not_found` | no | propagation delay → wait & reconcile |
| signed envelope past its timebounds | `tx_too_late` | no | provably **unapplied** → rebuild (resync seq) |
| sequence no longer valid on resubmit | `tx_bad_seq` | no | **re-reconcile first** (may have applied), else rebuild |
| fee below current surge price | `tx_insufficient_fee` | no | needs higher fee / fee-bump (operator) |
| account under base reserve | `insufficient_balance` | no¹ | fund the account; not auto-retried |
| tx found, memo ≠ expected hash | `proof_mismatch` | **yes** | stop, alert — a data-integrity fault, never auto-retry |
| confirmed tx vanished **+** seq regressed / account gone | `testnet_reset_suspected` | **yes**² | open a new generation, preserve lineage |

¹ non-terminal but not auto-retryable — a retry can't help until the account is funded.
² terminal *for that generation*; recovery is a deliberate re-anchor. A single 404 is
**never** enough on its own — a corroborating signal is required.

The split is enforced in code: `classify.ts` only ever produces *transport* and *result-code*
classes from an exception; `proof_mismatch` and `testnet_reset_suspected` are decided **only**
in `reconcile()` from on-chain evidence. ([test](test/classify.test.ts) pins that invariant.)

### Idempotency & concurrency

Three independent layers stop a proof from being anchored twice:

1. **Deterministic key** — `client_tx_id = sha256(proofHash | network | generation)`. The
   same proof always derives the same key; bumping `generation` is the *only* way to get a
   new one (that's exactly a deliberate re-anchor).
2. **`INSERT … ON CONFLICT DO NOTHING`** on `UNIQUE(client_tx_id)` — concurrent requests
   converge on one row across workers and restarts.
3. **Atomic claim+insert** — `buildAndSubmit` compare-and-swaps `active_attempt_id` *and*
   inserts the attempt row in **one transaction**. A worker that loses the CAS stops; it
   never submits. This closes the window where `active_attempt_id` could briefly point at a
   not-yet-inserted attempt, which a concurrent rebuild could otherwise exploit to
   double-anchor a generation.

On the network side, resubmitting the *byte-identical* signed envelope is safe because
Stellar dedupes by transaction hash — the same applied result comes back, never a second tx.

### Sequence management & safe rebuild

Stellar requires `tx.seq == account.seq + 1` exactly, so parallel jobs can't pick sequences
independently. A **central allocator** ([`sequence.ts`](src/stellar/sequence.ts)) hands out
the next sequence under a `BEGIN IMMEDIATE` row lock.

The subtle part is **rebuild after a non-applied tx**. If an envelope expires (`tx_too_late`)
without ever applying, the allocator is now *ahead* of the on-chain account. Rebuilding
naïvely would reuse a sequence the chain isn't ready for and bounce with `tx_bad_seq`. So
**every rebuild re-reads `getAccount` and resets the allocator to `account.sequence + 1`**
first — the unapplied sequence is reused, not skipped, so no gap is created. Because
`tx_too_late` is consensus-enforced it *proves* non-application; `tx_bad_seq` is ambiguous
(the original may have applied), so the rebuild path **re-reconciles before rebuilding** to
avoid a duplicate.

### Receipt lineage

Receipts are append-only. A re-anchor never overwrites history — it's a new immutable
generation linked to its parent:

```
Proof P
 ├─ gen 0   tx AAA…   ledger 3266391   status superseded
 ├─ gen 1   tx BBB…   ledger 3266394   supersedes gen 0   reason "testnet_reset"
 └─ gen 2   tx CCC…   ledger 3266654   supersedes gen 1   reason "re-anchor"   ← active
```

The parent flips to `superseded` **only after the child confirms** on-chain — a live receipt
is never retired in favour of one that doesn't exist yet. The active receipt is *derived*
from the lineage, not stored by mutation, so you can always show that gen 0 existed, when,
and why it was superseded.

### Public vs internal

Expose only what's needed for independent verification; keep operational mechanics private,
so the implementation stays free to change. ([`verify.ts`](src/verify.ts) is the allow-list.)

| Public (`PublicReceipt`) | Internal (never exposed) |
|---|---|
| `proof_hash`, `tx_hash`, `network` | signed `tx_xdr`, source account / secret seed |
| `ledger_seq`, `confirmed_at` | `sequence_number`, allocator state |
| `anchor_generation`, `supersedes` | retry counters, attempt rows, worker/job ids |
| coarse `status` (`anchored`/`pending`/`superseded`) | Horizon diagnostics, raw `last_error` |
| `verification_url` | `proof_id` ↔ customer mapping, mismatch notes |

---

## Verifying a proof independently

The whole point: a third party who holds the original document can confirm it was anchored,
using **only public data and a public Horizon endpoint** — no trust in this service required.

```bash
PROOF=$(shasum -a 256 contract-v1.pdf | cut -d' ' -f1)   # the hash you commit to
TX=cab65ef08741937ebc7cbb1b2df2b740d5dbb4f24cd911d9332c57736b96ff5a   # from the public receipt

# Pull the tx straight from Horizon and decode its memo to hex:
ONCHAIN=$(curl -s "https://horizon-testnet.stellar.org/transactions/$TX" \
  | python3 -c 'import sys,json,base64; m=json.load(sys.stdin); print(base64.b64decode(m["memo"]).hex() if m["memo_type"]=="hash" else "")')

[ "$PROOF" = "$ONCHAIN" ] && echo "✅ anchored & verified" || echo "❌ mismatch"
```

Or just open the receipt's `verification_url` (e.g. `https://stellar.expert/explorer/testnet/tx/<TX>`)
and read the MemoHash. The live runner and integration tests do exactly this check in code
(`horizon.getTransaction(tx).memoHashHex === proofHash`).

---

## Running it

```bash
pnpm install          # compiles the better-sqlite3 native binding
pnpm test             # 53 mocked tests (flow + unit + property), in-memory, no network
pnpm build            # typecheck (tsc --noEmit, strict)
pnpm demo             # offline walk-through (mocked Horizon): anchor → idempotent repeat → re-anchor
pnpm start            # the whole gamut: typecheck → mocked → live suite → persistent run

# Live TESTNET suite (network + Friendbot), gated — runs against an on-disk SQLite file:
RUN_TESTNET=1 pnpm test:testnet

# Full end-to-end run against live TESTNET, persisted to a real SQLite file:
pnpm run:testnet "contract-v1.pdf"              # anchor + prove idempotency + verify on-chain
pnpm run:testnet "contract-v1.pdf" --reanchor   # also append the next generation
```

**`pnpm run:testnet`** is the headline end-to-end: it funds an account, anchors through the
**real** service path, proves idempotency, optionally re-anchors, then independently reads
**every** generation's transaction back from Horizon and asserts the memo — exiting non-zero
on any mismatch. State persists in `DB_PATH` (default `./data/anchors.db`), so re-running the
same subject is idempotent (returns the existing anchor, no new tx). The first run prints a
`STELLAR_SECRET` to export so later runs reuse the same account + DB. See [`run.ts`](src/run.ts).

> Live runs write real TESTNET ledger entries and lean on Friendbot (rate-limited) — they're
> manual/demo tools, not something to loop in fast CI.

## Configuration

All optional; sensible TESTNET defaults. `tsx` auto-loads a `.env` file. See [`.env.example`](.env.example).

| Env var | Default | Purpose |
|---|---|---|
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | Horizon endpoint |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | network — also scopes the idempotency key |
| `ANCHOR_TTL_SECONDS` | `180` | tx validity window → timebounds `maxTime` (validated > 0) |
| `BASE_FEE` | `100` | base fee in stroops (validated positive integer) |
| `DB_PATH` | `:memory:` | SQLite path; `run:testnet` falls back to `./data/anchors.db` |
| `STELLAR_SECRET` | *(generated)* | throwaway TESTNET seed for the runner; printed if unset |
| `RUN_TESTNET` | *(unset)* | set to `1` to un-gate the live integration suite |

## Testing

**53 mocked tests** (deterministic, no network — **signing is always real crypto**; only
network I/O is faked via a programmable `HorizonClient` mock + an injectable clock) cover the
full matrix: idempotent repeats, timeout→reconcile, `proof_mismatch`, `testnet_reset_suspected`
(and a bare 404 that is *not* a reset), `tx_too_late` rebuild, `tx_bad_seq` re-reconcile,
`successful=false` healing, in-process concurrency, the atomic claim CAS, receipt immutability,
3-generation lineage, self-seeding, sequence monotonicity, config validation, and input guards.

**8 gated live-TESTNET tests** (`RUN_TESTNET=1`) run the same service path against real Horizon
on an **on-disk SQLite file**: fund → anchor → read-back memo, idempotency, re-anchor lineage,
a real consensus `tx_too_late` recovered by re-syncing from chain, real 404 / transport
classification, and a reopen-from-disk persistence check.

## Known limitations (deliberate POC scope)

The anchoring core is hardened (atomic claim+insert; immutable confirmed receipts; on-chain
sequence re-sync on rebuild; fee/balance/sequence result codes classified; DB `CHECK`
constraints). What a real deployment still needs — intentionally **out of scope** here:

- **No retry scheduler / worker loop.** `retry()` is driven by the caller; `isRetryable`
  documents which classes a backoff worker *should* pick up, but none runs — stuck
  `submitted` anchors don't self-heal on their own.
- **Single anchoring account = throughput ceiling + SPOF.** The allocator is built for an
  account **pool** (one sequence line per account); the POC injects one keypair, so concurrent
  *rebuilds sharing that account* can still contend on the sequence line.
- **No fee-bump.** `BASE_FEE` is fixed and baked into the signed envelope; under surge pricing
  a tx can hit `tx_insufficient_fee`. It's classified (non-terminal) but not auto-re-fee'd.
- **No transport-layer 429/Retry-After backoff, metrics, tracing, or structured logs.**
- **`anchor_attempts` grows unbounded** (one row per build) — production wants retention.

## Project layout

```
src/
  config.ts          env → typed, validated config (testnet defaults)
  types.ts           AnchorStatus / ErrorClass enums; record types
  idempotency.ts     clientTxId = sha256(proofHash | network | generation) + hash validation
  classify.ts        exception → ErrorClass (transport vs Stellar result-code)
  db/
    schema.sql       tables, UNIQUE + CHECK constraints
    store.ts         Store interface + SqliteStore (better-sqlite3); atomic claim+insert
  stellar/
    horizon.ts       HorizonClient interface — the mockable seam
    horizonReal.ts   real impl over @stellar/stellar-sdk Horizon.Server
    horizonMock.ts   programmable in-memory Horizon for tests + demo
    sequence.ts      SequenceAllocator (DB-locked reserve / on-chain resync)
    txBuilder.ts     build + sign: 1-stroop self-payment + MemoHash + timebounds
  verify.ts          buildPublicReceipt(): the public-safe projection
  anchorService.ts   anchor / retry / reconcile / reanchor orchestration
  index.ts           offline demo CLI (in-memory, mocked Horizon)
  run.ts             live TESTNET runner (persistent SQLite + real Horizon)
test/
  idempotency.test.ts          deterministic key + uniqueness property
  classify.test.ts             exception → class mapping; transport vs integrity split
  config.test.ts               config validation
  anchorService.test.ts        28 flow cases, mocked Horizon
  testnet.integration.test.ts  8 gated live-TESTNET cases, on-disk SQLite
```

**Requirements:** Node ≥ 20, pnpm, `@stellar/stellar-sdk` v13 (`Horizon.Server`), `better-sqlite3`.
