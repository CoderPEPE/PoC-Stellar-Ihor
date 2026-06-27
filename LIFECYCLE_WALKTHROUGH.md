# POC Lifecycle Walkthrough

Five lifecycle phases with the key design decisions for each.

---

## 1. Bootstrapping (`run.ts`)

```
resolveProofHash() → sha256(file bytes) or --hash
ensureFunded()     → Friendbot + poll for visibility
store.initAccount() + SequenceAllocator.resetToChain()
```

### Key decisions

**Hash the bytes, not the filename.**
Prevents identity confusion between `contract-v1.pdf` and a symlink or rename. The proof hash is always `sha256(readFileSync(path))` — never `sha256(path)`.

**Friendbot retries with backoff.**
TESTNET is flaky: 4 attempts with 1.5s multipliers. HTTP 400 (already funded) is treated as success. Poll up to 10s for account visibility after funding.

**resetToChain runs after initAccount.**
`initAccount` seeds with `account.sequence + 1`, then `resetToChain` immediately clamps it above `maxInFlightSequence` so prior-run pending attempts aren't reissued. Two calls because `initAccount` is a no-op (`ON CONFLICT DO NOTHING`) if the account is already registered from a prior run — the entry must exist before `resetToChain` can write to it.

---

## 2. Anchor (idempotent anchor)

```
deriveClientTxId(proofHash, network, generation)
insertAnchorIfAbsent() → UNIQUE(client_tx_id) absorbs duplicates
  ├── Confirmed → return (idempotent)
  ├── Has activeAttemptId → return (in-flight)
  └── buildAndSubmit()
```

### Key decisions

**Deterministic client_tx_id.**
`clientTxId = sha256(proofHash | networkPassphrase | generation)`. Same inputs always produce the same key. Cross-network safety: TESTNET and PUBLIC produce different keys for the same proof.

**Three-layer idempotency.**
1. Deterministic key (same proof + network + generation = same `clientTxId`)
2. DB UNIQUE constraint on `client_tx_id` (concurrent INSERTs converge on one row)
3. Atomic CAS on `active_attempt_id` (only one worker wins the right to submit)

Three layers because each individually could fail: hash collisions (impossible for SHA256 but defense-in-depth), race window between INSERT and SELECT, or network-level double-submit.

**ON CONFLICT DO NOTHING returns existing row.**
`insertAnchorIfAbsent` uses `INSERT ... ON CONFLICT DO NOTHING` followed by a SELECT. Works regardless of which unique constraint fired (`client_tx_id` OR `proof_hash + anchor_generation`).

---

## 3. buildAndSubmit (the critical path)

```
needSeed/resync → horizon.getAccount() → syncSequenceFromChain()
    ↓
reserve() → buildAnchorTx() → claimAndInsertAttempt(CAS) → submitAttempt()
    ↓                                                       ↓
  sync (no await)                                     await (network I/O)
```

### Key decisions

**Network phase first, claim last.**
`getAccount()` (a network round-trip) runs before any lock is held. Then the synchronous reserve → build → CAS chain runs with NO `await` between calls, all in one event-loop tick. No window for concurrent interleaving.

**ClaimAndInsertAttempt is atomic CAS + row insert.**
`UPDATE anchors SET active_attempt_id = @next WHERE active_attempt_id IS @expected` and `INSERT INTO anchor_attempts ...` are wrapped in one SQLite transaction. A worker that loses the CAS stops — it never inserts an attempt row, so there is never a dangling `active_attempt_id` pointer.

**Storing txXdr BEFORE submission.**
The signed envelope is persisted before the `submit()` call. If the process crashes after submit but before the response is processed, the exact same envelope can be resubmitted on restart. The network dedupes by transaction hash, so this never double-anchors.

**Expired attempts reclaim sequences.**
`resetToChain` reads `maxInFlightSequence` which only considers `pending`/`submitted` attempts. An `expired` attempt's sequence falls below the new floor and is reclaimed. No gaps accumulate in the sequence line.

---

## 4. Confirmation (two paths, one reconciliation)

### Direct submit success

```
res.successful === true → attempt→confirmed, anchor→confirmed, supersedeParentOf
```

### Reconcile (called via retry)

```
horizon.getTransaction(txHash)
  ├── Found + memo matches + successful → CONFIRMED
  ├── Found + memo mismatch             → ProofMismatch (terminal, data-integrity fault)
  ├── Found + memo matches + !successful → attempt→failed (sequence consumed, no proof anchored)
  └── Not found (404)
        ├── Was confirmed before → probe account
        │     ├── account vanished or seq regressed → TestnetResetSuspected
        │     └── no corroboration                  → TxNotFound
        └── Fresh submission      → TxNotFound (propagation delay)
```

### Key decisions

**Transport errors never produce a terminal business state.**
An anchor is never marked `failed` for a timeout, DNS error, or 503. Only on-chain evidence (found with mismatched memo, or found but unsuccessful) produces terminal errors. The anchor stays `submitted` — uncertain — until reconciled.

**TestnetResetSuspected requires corroboration.**
A single 404 is never enough to declare a testnet reset. Must also see the account vanish (ledger entry deleted) or sequence regress below the attempt's reserved number. Prevents false positives from transient Horizon unavailability or load balancer quirks.

**Superseding happens at confirm transition, not at reanchor().**
`reanchor()` creates a new generation row but never touches the parent's status. Only when the child confirms (via submit OR reconcile) does the parent flip to `superseded`. A re-anchor that times out and confirms later via retry/reconcile still correctly retires its parent. The parent is never retired for a generation that doesn't exist yet.

---

## 5. Retry (the repair loop)

```
reconcile() first (cheap, safe)
  ├── Confirmed/terminal → done
  ├── No attempt or expired/failed → buildAndSubmit({ resync: true })
  ├── Has live attempt → resubmit exact XDR
  │     ├── tx_too_late → rebuild with resync
  │     ├── tx_bad_seq  → re-reconcile first (maybe it applied!), then rebuild
  │     └── transport   → wait for backoff (attempt stays 'submitted')
```

### Key decisions

**Reconcile before every retry.**
The cheapest operation (one `getTransaction` call). If the tx landed while we weren't watching, we confirm immediately. No rebuild cost, no second submission.

**tx_bad_seq re-reconciles before rebuilding.**
`tx_bad_seq` is ambiguous: the sequence moved on because (a) OUR tx applied (success — we just need to confirm), or (b) a different tx consumed the sequence. Case (a) would confirm via reconcile, avoiding a duplicate anchor. Case (b) demands a rebuild from current chain state.

**resync: true on every rebuild.**
Always re-read the on-chain sequence before building a replacement envelope. The dead envelope that caused the retry left a gap in the allocator (its sequence was reserved but never applied). Rebuilding without resync would itself fail with `tx_bad_seq`.

---

## Architecture Mantra

**The local DB is the system of record; the chain is for independent verification.**

- Submission and confirmation are separate phases
- An uncertain submission is always reconciled rather than guessed at
- Transport errors never produce terminal business state
- Only on-chain evidence decides terminal outcomes (ProofMismatch, TestnetResetSuspected)
- This makes the POC resilient to crashes, timeouts, and testnet resets
