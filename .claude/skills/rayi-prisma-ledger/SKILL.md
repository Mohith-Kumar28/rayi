---
name: rayi-prisma-ledger
description: Rules for writing Prisma and SQL in the Rayi codebase. Use whenever touching prisma/schema.prisma, a migration, any $transaction, any ledger or money-path query, or when adding a database constraint. Covers the Prisma 7-vs-8 trap, row locking, retry-on-serialization-failure, and the constraints Prisma cannot express.
---

# Prisma rules for Rayi

Rayi is a payments platform. A silent money bug is the worst outcome in this codebase. These rules
exist because each one has already been verified against a real failure mode.

## 1. Version is pinned at exactly 7.10.x — never widen it

`npm view prisma dist-tags` returns `latest: 8.0.0-rc.15`. **The `latest` tag points at a release
candidate.** A plain `pnpm add prisma` pulls an RC into the money path.

Prisma 8 removes `isolationLevel`, the `P####` error codes, and `timeout`/`maxWait`. Prisma 7 code
does **not** fail to compile on 8 — it silently runs at the connection default, the retry loop stops
matching, and a lost release is indistinguishable from an ordinary failure. A wedged transaction then
holds its locks and its pool connection indefinitely, blocking every other release on that account.

- `"prisma": "7.10.x"` and `"@prisma/client": "7.10.x"`. No caret, no tilde.
- Never run `pnpm update prisma` casually. A major bump is a deliberate, tested project.

## 2. Do not depend on version-specific transaction APIs on the money path

Write the money path so a future major cannot silently change its semantics:

```ts
await prisma.$transaction(async (tx) => {
  await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'")
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'")
  // ... ledger work
})
```

Also set `idle_in_transaction_session_timeout` on the database role — the client offers no equivalent.

Assert isolation at boot and refuse to serve on mismatch. That check survives any upgrade:

```ts
const [{ transaction_isolation }] = await prisma.$queryRaw<{transaction_isolation: string}[]>`
  SELECT current_setting('transaction_isolation') AS transaction_isolation`
```

## 3. Prisma has no row locking — use raw SQL

```ts
const rows = await tx.$queryRaw<AccountRow[]>`
  SELECT id, balance_minor FROM ledger.account
  WHERE id = ANY(${accountIds}::uuid[])
  ORDER BY id
  FOR UPDATE`
```

**Always `ORDER BY id`.** A canonical lock order is what prevents deadlocks when one operation touches
the org balance, a campaign allocation and a deliverable reservation.

## 4. Retry on serialization failure — and know what must never be retried

Detect retryability by walking `.cause` for **SQLSTATE** `40001` (serialization failure) and `40P01`
(deadlock), *and* matching `P2034`/`P2010`. Keep all error-code knowledge in **one file** so the
eventual v8 move is a one-file change.

Two rules that matter more than the retry itself:

- **Never retry a transaction that performed an external side effect.** No Stripe call, no
  notification, no HTTP request may happen inside a retryable transaction. This is enforced at
  runtime by the AsyncLocalStorage transaction-purity guard — do not work around it.
- **Distinguish a serialization failure from a deferred-constraint violation.** They surface the same
  way. An unbalanced ledger entry must fail loudly, not retry five times into a DLQ.

## 5. Constraints Prisma cannot express — they go in hand-written SQL

Prisma cannot model deferred constraint triggers, `REVOKE`, trigger functions, or partial indexes with
complex predicates. These are appended to the generated migration as reviewed SQL blocks:

- **Balanced entries** — a `DEFERRABLE INITIALLY DEFERRED` constraint trigger asserting each journal
  entry's lines sum to zero at COMMIT.
- **Append-only** — `REVOKE UPDATE, DELETE` from the app role plus a `BEFORE UPDATE OR DELETE` trigger
  that raises. Corrections are reversing entries, never edits.
- **Solvency** — `allows_negative` on `ledger.account` with unique `(id, allows_negative)`, the same
  column on `balance_snapshot` with a composite FK, and `CHECK (allows_negative OR balance_minor >= 0)`.
  Only the PSP clearing and fraud-reserve accounts get `allows_negative`. An overdraft then becomes
  **SQLSTATE 23514 from the storage engine**, un-bypassable by any code path that forgets a guard.
- **Tenant integrity** — `@@unique([id, organizationId])` on `Workspace` and `Member`, then composite
  FKs `(workspaceId, organizationId)` and `(memberId, organizationId)`.
- **Idempotency** — unique `(source_type, source_id)` on ledger postings; partial unique indexes on
  irreversible target states, e.g. `WHERE to_state IN ('RELEASED','REFUNDED')`. A naive
  `UNIQUE(id, to_state)` would break legitimate resubmission after rejection.
- `CHECK` constraints **cannot contain subqueries** in PostgreSQL. Write them subquery-free or use a
  trigger.

Add a boot assertion that queries `pg_constraint` / `pg_trigger` and refuses to start if a required
control is missing. Apply every migration against a real Postgres in CI before calling it done — that
single gate catches missing CHECKs, triggers and grants.

## 6. Money types

`BigInt` minor units, always. Never `Float`, never `Decimal` for arithmetic, never a JSON number over
the wire (the 2^53 boundary is real). Across the API money is
`{ amountMinor: "15000", currency: "USD", exponent: 2 }` — a **string** of minor units with a
server-supplied exponent.

## 7. Banned outright

- `prisma db push` and `prisma migrate reset` anywhere near real data.
- `Promise.all` inside a transaction.
- Editing or deleting a ledger or audit row.
- Any raw balance-adjustment write. Corrections are reversing entries with a reason code.
- Trusting a CLI exit code as proof a migration applied — verify the schema.
