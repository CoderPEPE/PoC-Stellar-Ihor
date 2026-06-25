-- Proof-anchoring system of record.
--
-- Two tables separate the LOGICAL anchor (one per proof generation) from the
-- PHYSICAL transaction attempts. The unique constraints below are what make
-- duplicate logical anchors impossible even under concurrent retries.

-- One row per LOGICAL anchor (proof + generation).
CREATE TABLE IF NOT EXISTS anchors (
  anchor_id         TEXT PRIMARY KEY,
  proof_id          TEXT NOT NULL,
  proof_hash        TEXT NOT NULL CHECK (length(proof_hash) = 64),  -- hex, 32 bytes, immutable
  anchor_generation INTEGER NOT NULL DEFAULT 0 CHECK (anchor_generation >= 0),
  parent_anchor_id  TEXT REFERENCES anchors(anchor_id),  -- supersedes link (lineage)
  client_tx_id      TEXT NOT NULL,                       -- deterministic idempotency key
  status            TEXT NOT NULL
                      CHECK (status IN ('pending','submitted','confirmed','superseded','failed')),
  error_class       TEXT CHECK (error_class IS NULL OR error_class IN (
                      'horizon_unavailable','tx_not_found','tx_too_late','tx_bad_seq',
                      'tx_insufficient_fee','insufficient_balance','proof_mismatch',
                      'testnet_reset_suspected','unknown')),
  reason            TEXT,                                -- re-anchor reason
  active_attempt_id TEXT,                                -- current physical attempt
  ledger_seq        INTEGER,
  receipt_json      TEXT,                                -- Horizon tx response on success
  created_at        TEXT NOT NULL,
  confirmed_at      TEXT,

  -- Same request can never be processed twice into two rows.
  UNIQUE (client_tx_id),
  -- A proof cannot accidentally receive two anchors within the same generation.
  UNIQUE (proof_hash, anchor_generation)
);

-- One row per PHYSICAL build/submit attempt.
CREATE TABLE IF NOT EXISTS anchor_attempts (
  attempt_id      TEXT PRIMARY KEY,
  anchor_id       TEXT NOT NULL REFERENCES anchors(anchor_id),
  tx_hash         TEXT,                  -- nullable until built
  tx_xdr          TEXT NOT NULL,         -- signed envelope; source of exact-envelope resubmit
  source_account  TEXT NOT NULL,
  sequence_number TEXT NOT NULL,         -- i64 as string, pinned at build time
  min_time        INTEGER NOT NULL,
  max_time        INTEGER NOT NULL,      -- timebound expiry → tx_too_late after this
  status          TEXT NOT NULL
                    CHECK (status IN ('pending','submitted','confirmed','failed','expired')),
  error_class     TEXT,
  last_error      TEXT,
  submitted_at    TEXT,
  created_at      TEXT NOT NULL,

  -- The same on-chain transaction can never be stored twice.
  UNIQUE (tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_anchors_proof_hash ON anchors (proof_hash);
CREATE INDEX IF NOT EXISTS idx_attempts_anchor ON anchor_attempts (anchor_id);

-- Centralized sequence allocator state, one row per anchoring (source) account.
CREATE TABLE IF NOT EXISTS source_accounts (
  account_id    TEXT PRIMARY KEY,
  next_sequence TEXT NOT NULL            -- next tx sequence number to hand out
);
