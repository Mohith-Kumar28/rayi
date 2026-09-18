# Roadmap

Each step ends in something demonstrable. Money moves as late as possible, and only in test mode
until step 16.

**Status: 1 ✅ · 2 ✅ · 3 🟡 · 4 ✅ · 5 ✅ · 6 🟡 · 7 ✅ · 8–16 ⬜**

Steps 3 and 6 are one item short each: RLS with a `withTenant()` helper, and Nest replacements for the
Better Auth account endpoints that are currently blocked rather than replaced.

Current test count: **358 passing**.

| Suite | Tests | Needs a database |
| --- | --- | --- |
| `@rayi/domain` — Money, pure ledger logic | 36 | no |
| `@rayi/contracts` — manifest invariants, OpenAPI shape | 26 | no |
| `@rayi/api-client` — generated client + error envelope | 10 | no |
| `@rayi/console` — minor-unit conversion, idempotency key | 30 | no |
| `@rayi/backend` unit — config, guards, **auth allowlist**, **architecture boundaries** | 142 | no |
| `@rayi/backend` integration — ledger, integrity, **audit**, authorization, treasury, **account**, HTTP, queue | **114** | **yes** |

Two gates run outside the test suites, both of which fail CI on drift:
`pnpm verify:openapi` (the spec matches the manifest) and `pnpm verify:auth-surface`
(the set of internet-reachable Better Auth endpoints is the one that was reviewed).

---

## ✅ 1. Monorepo, contract pipeline, mock server

`pnpm dev` runs the TanStack SPA against generated MSW mocks with a fully typed client — **zero
backend, zero AWS**. That is the concrete form of "frontend and backend in parallel".

- [x] Turborepo + pnpm workspaces, strict `tsconfig.base.json`
- [x] `packages/domain` — `Money` value object. **36 tests**, including 500 property runs asserting
      `allocate` sums to exactly the whole and 300 asserting equal-weight parts differ by ≤1 minor unit
- [x] `packages/contracts` — Zod operation manifest, pure `openapi.json` emitter (no Nest boot). **15 tests**
- [x] `packages/api-client` — orval-generated client + TanStack Query hooks. **10 tests** proving
      manifest → openapi → client → MSW connects
- [x] Hand-written MSW fixtures (stable amounts, not Faker) for 5 scenarios
- [x] `apps/console` — funds screen, `<Money>` primitive, scenario switcher
- [x] **Drift gate**: CI fails if `openapi.json` or the generated client is stale. *Verified firing.*
- [x] GitHub Actions CI

## ✅ 2. Backend foundation

- [x] Replaced the hand-built backend with the boilerplate (shallow clone, no history)
- [x] Made it compile — it did not, as inherited (23 errors)
- [x] **Strict mode ON** — 131 errors fixed. Only `strictPropertyInitialization` off (class-validator DTOs)
- [x] `stripe.config.ts` — full `sk_` key refused on any process but the worker. **6 tests**
- [x] `@Operation()` manifest-driven route decorator
- [x] `PermissionGuard` — deny-by-default authorization, separate from `AuthGuard`'s authentication
- [x] `AuthGuard` registered **globally** (was per-controller, i.e. opt-in)
- [x] dependency-cruiser module boundaries. *Verified firing on a treasury import.*
- [x] Postgres 17 container for local work

Bugs found and fixed while doing this — see `05-security.md` for detail:
rate-limiter bypassable via `X-Forwarded-For`; `DATABASE_URL` effectively optional; config error
reporting threw while reporting errors; pagination never advertised a next page.

## 🟡 3. Database foundation and the privilege boundary

`prisma/migrations/20260918120000_ledger_core/migration.sql` — hand-written, because Prisma cannot
express deferred constraint triggers, generated columns, `REVOKE`, composite FKs or SECURITY DEFINER
functions, and every one of those is load-bearing.

- [x] `ledger` schema: `account`, `entry`, `entry_line`, `account_balance`, `balance_snapshot`
- [x] Generated columns `signed_minor` (for the SUM=0 assertion) and `natural_minor` (for balances) —
      application code never writes a sign
- [x] `CHECK (allow_negative OR balance_minor >= 0)` — solvency as a storage-engine error
- [x] Deferred constraint trigger asserting every entry balances and has ≥2 lines
- [x] Append-only triggers on `entry`, `entry_line`, `balance_snapshot`
- [x] Composite FK `(account_id, currency, normal_balance)` — a mixed-currency line is unrepresentable
- [x] `post_entry()` — idempotent on `(source_type, source_id)` **sequentially and concurrently**;
      balance UPDATE and snapshot INSERT in ONE statement via CTE; accounts locked in sorted order to
      prevent deadlock
- [x] Account **derivation** (`account_for_campaign`, `org_lot_to_spend`) — a caller names the campaign
      it is acting on and the database decides which account that is, so "post to someone else's
      account" is not expressible
- [x] Composite FK `(campaign_id, org_id) → campaign(id, organizationId)` plus
      `CHECK (campaign_id IS NULL OR org_id IS NOT NULL)` — a campaign account in the wrong
      organization is unrepresentable, and the NULL escape hatch that a MATCH SIMPLE composite FK
      would leave open is closed
- [x] Three roles with grants; `rayi_api` has **no ledger access at all**
- [x] **Boot assertion** querying `pg_constraint`, `pg_trigger`, `pg_proc`, `pg_index` and
      `information_schema.columns` — `LedgerIntegrityService` refuses to let the process start if the
      database it actually connected to is missing any control. Ten tests DROP a real constraint and
      assert it fires
- [x] **Migrations gated on an advisory lock** — Prisma's schema engine already takes
      `pg_advisory_lock(72707369)`, verified by reading the engine binary. What was missing was a
      guard on the two ways that lock is silently lost; `scripts/migrate.ts` refuses both
- [ ] RLS on org-scoped tables with a `withTenant()` helper

### The boot assertion, and why it is not paranoia

The whole design says *"over-allocation is impossible because a CHECK constraint prevents it."* That
sentence is true of the schema in the migrations, not of whatever database `DATABASE_URL` points at.
Between those two sit: a migration that was rolled back, a restore from before a control existed, a
`DROP CONSTRAINT` in a hotfix nobody re-added, a staging URL pasted into a production secret, and a
compromised migrator role. Every one produces a system that looks completely normal and has quietly
stopped enforcing solvency.

Five catalog queries at startup, and it fails **closed** — for a process that moves money, not
running is the correct behaviour when its guarantees cannot be verified. It collects *every* failure
rather than stopping at the first, because "three controls missing" points at a restore and "one
missing" points at a bad migration, and a check that stops early cannot tell them apart.

It also checks two things presence alone would miss: that `entry_line_balanced` is still
`DEFERRABLE INITIALLY DEFERRED` (recreated immediate, it rejects every legitimate multi-line entry),
and that `post_entry` still has `SECURITY DEFINER` (without it the one-door privilege boundary is
gone). Plus `transaction_isolation = read committed`, since the no-`SERIALIZABLE` concurrency
argument only holds there.

### Migrations: Prisma already locks, so we guard the lock

`SELECT pg_advisory_lock(72707369)` is in the schema engine, with a documented timeout. Writing a
second lock on top would be worse than writing none — two schemes each believing they are the
authority is how a deploy hangs holding both. `scripts/migrate.ts` instead refuses to run when
`PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` is set, or when `DATABASE_URL` looks like a transaction-mode
pooler, because a pooler does not hold session state and a session-level lock then protects nothing.

**Verified against real Postgres 17** — all ten invariants:

| # | Invariant | Result |
| --- | --- | --- |
| 1 | Funding posts and balances update | ✅ |
| 2 | Replaying a `source_id` posts nothing new | ✅ one entry, balance unchanged |
| 3 | Allocation moves value correctly | ✅ lot 300000 / campaign 200000 |
| 4 | **Cannot overdraw** | ✅ `account_balance_non_negative` |
| 5 | Cannot post unbalanced | ✅ "debits minus credits = 1" |
| 6 | Cannot post a single line | ✅ |
| 7 | Cannot post a negative amount | ✅ `entry_line_amount_positive` |
| 8 | Cannot UPDATE or DELETE ledger rows | ✅ both refused |
| 9 | Snapshot == balance == sum of lines | ✅ all three 300000 |
| 10 | Every entry sums to zero, globally | ✅ 0 unbalanced |
| 11 | Ten **concurrent** replays of one key | ✅ one entry, one snapshot, every caller told the same |
| 12 | Campaign account in the wrong org | ✅ `account_campaign_belongs_to_org` |
| 13 | Campaign-tagged account with no org | ✅ `account_campaign_requires_org` |

Privilege boundary, verified:

```
rayi_api      SELECT ledger.account    →  permission denied for schema ledger
rayi_api      ledger.post_entry(...)   →  permission denied for schema ledger
rayi_worker   SELECT ledger.account    →  4 rows
rayi_worker   UPDATE ledger.entry      →  permission denied for table entry
rayi_webhooks SELECT ledger.entry      →  permission denied for schema ledger
```

## ✅ 4. Ledger core

`src/ledger/` — domain types (pure), repository, retry wrapper, transaction-purity guard.

- [x] `LedgerRepository` — the only door into the ledger, all writes via `post_entry`
- [x] **Retry wrapper** walking `.cause` for SQLSTATE, with full jitter so a burst on one hot account
      does not retry in lockstep. All error-code knowledge in ONE file, so the eventual Prisma major
      upgrade is a one-file change
- [x] Retryable (`40001`, `40P01`, `55P03`) strictly separated from terminal (`23514`, `23505`,
      `23503`, `0A000`) — an overdraft is the database being *right*, and retrying it turns a clear
      error into five attempts and a dead letter
- [x] **Transaction-purity guard** (AsyncLocalStorage) — any Stripe or notification call reached from
      inside an open ledger transaction throws. Catches it many frames down, through interfaces no
      lint rule can follow
- [x] `verifyBalance()` — materialised vs computed vs latest snapshot, for continuous drift detection
- [x] 26 unit tests + **12 integration tests against real Postgres**
- [x] CI starts Postgres 17, applies the migration and runs them

**The concurrency proof:** twenty concurrent allocations, each for the entire balance, against an
account that can fund exactly one → **exactly one succeeds**, lot ends at 0, campaign at the full
amount. Ten concurrent replays of one idempotency key → **one entry, money moved once**.

Integration tests are **deliberately not auto-skipped** when the database is absent: a silently
skipped test that guards money reports green while asserting nothing. An unreachable database fails
loudly with the `docker run` command in the message.

## ✅ 5. Brand console against mocks *(parallel with 2–4)*

`orgId` in the URL, campaign list, allocation form, per-deposit lot list, `<Money>` primitive, MSW
handlers from the generated client.

- [x] Allocation form driven by generated hooks against MSW — no backend, no AWS
- [x] `<Money>` renders from string minor units with a server-supplied exponent
- [x] `toMinorUnits` / `allocationIdempotencyKey` extracted with 30 unit tests

Still open: review queue, `<StatusPill>`, `<Countdown>`, org switcher. **Nobody has visually reviewed
the UI** — see technical debt.

## 🟡 6. Identity and authorization

- [x] `PermissionService` over a `role_permission` table, 48-row matrix
- [x] Money capability as a `MoneyAuthority` **row**, never a role string
- [x] Org / workspace / member model with composite FKs making a cross-org pairing unrepresentable
- [x] `PermissionGuard` enforcing deny-by-default, scope from the URL, 404 rather than 403
- [x] **Better Auth deny-by-default path allowlist** at the mount — 10 routes open, all 32 others
      404. `emailAndPassword` disabled, and the password endpoints independently excluded
- [x] **Committed surface snapshot** (`auth-surface.snapshot.json`, 42 endpoints) with
      `pnpm verify:auth-surface` failing CI when a version bump changes it
- [x] **Hash-chained, append-only audit log** (`audit` schema) with `audit.record` as the only writer
      and `audit.verify_chain` for tamper detection
- [x] **Session management reimplemented as Nest routes** — list, revoke one, revoke others — each
      scoped by the session's user id in the WHERE clause and each writing an audit row
- [x] **Profile update reimplemented** with an explicit field allowlist
- [x] `access: { kind: 'self' }` added to the manifest, so an account route declares its access
      without inventing a tenant scope it does not have
- [ ] Reimplement invite / role-change / member-removal as Nest controllers with audit + step-up
- [ ] Email change with step-up and notification to the OLD address
- [ ] Two-factor enrolment and removal behind step-up
- [ ] Generate Better Auth's `ac` object from `role_permission` at boot with an equality assertion

### The mount was the hole, and it is closed

Better Auth is mounted as `fastify.all('/api/auth/*')` and its handler **serves and returns before
Nest's guard chain runs**. `AuthGuard` and `PermissionGuard` never see those requests, and neither
does any route-coverage test, because these are not Nest routes.

The installed version exposes **42 endpoints** that way. Among them `/update-user`, `/change-email`,
`/delete-user`, `/two-factor/disable`, `/revoke-sessions`, `/link-social`, `/unlink-account` — every
one a security-relevant mutation reachable with nothing but a session cookie, with no MFA, no
step-up, no audit row and no authorization of ours.

Now the mount serves only what `ALLOWED_AUTH_ROUTES` lists and **404s** everything else. 404 rather
than 403: a 403 confirms the endpoint exists and is merely blocked, which discloses the version and
plugin set.

`BLOCKED_AUTH_ROUTES` records why each closed endpoint is closed, and a test asserts every endpoint
in the snapshot appears in one list or the other — an endpoint nobody decided about is one nobody
read.

**Replaced so far:** session management (`GET /v1/me/sessions`, `DELETE /v1/me/sessions/{id}`,
`POST /v1/me/sessions/revoke-others`), profile update (`PATCH /v1/me/profile`) and
`GET /v1/me/activity`. Each is `access: { kind: 'self' }`, each scopes by the session's user id in
the WHERE clause, and each writes an audit row — which is the entire justification for
reimplementing rather than re-exposing.

The scoping is the part under test. `self` means the guard only checks that you are signed in; it
cannot answer *is this row yours*, because that is a question about a row it has not loaded. So
`account-http.integration-spec.ts` asserts that another user's session id returns **404** and is not
revoked — a session id is not a secret, it appears in its owner's own list, so revoking by id alone
would let any signed-in user sign out any other.

The profile allowlist matters for the same reason Better Auth's version was blocked: `/update-user`
takes a partial user object, which is how `role`, `twoFactorEnabled` or `isEmailVerified` become
writable by anyone holding a session. A test posts exactly that body and asserts nothing moved.

**Still blocked, not replaced:** email change, two-factor enrolment and removal. Users cannot
currently change their email address or manage their second factor. Both need step-up, which does
not exist yet.

### The audit log

Append-only by `REVOKE` and triggers; **tamper-evident** by a SHA-256 chain. Those protect against
different attackers — the triggers stop the application, the chain stops whoever gets past the
triggers — so both are tested, and the chain is tested by disabling the trigger and editing a row.

`audit.record` is SECURITY DEFINER and computes the hash itself, so no caller can choose what the
chain says. `pg_advisory_xact_lock` serializes writers, because two inserts reading the same
`prev_hash` fork the chain, and a forked chain verifies as broken forever after.

`record()` deliberately **never throws**: an audit write that failed must not roll back the action it
was recording. Refusing to revoke a session because the log was unavailable would turn an
observability outage into a security one, at exactly the moment someone is evicting an attacker.
`recordInTransaction()` is the opposite, for the small set of actions where an unrecorded change is
worse than no change — granting money capability, changing a role.

#### Two false-positive bugs found while building it

Both were the same shape, and the dangerous one: **a tamper alarm that fires on honest data is one
people learn to ignore, and they learn it long before the day it matters.**

1. **`record` hashed its text arguments while `verify_chain` hashed the columns.** For every text
   field those are identical. For `ip_address`, typed `inet`, they are not: `203.0.113.10` stores and
   renders back as `203.0.113.10/32`. So every event carrying an IP — every security-relevant event —
   verified as tampered. Fixed structurally: `record` materialises each value at its column's type
   and hashes those, and both sides now call one shared `audit.event_hash`, because two copies of a
   hash definition is exactly how this happened.
2. **A gap in `seq` was treated as a deleted row.** `GENERATED ALWAYS AS IDENTITY` is *not* gapless —
   a rolled-back transaction consumes a value and never returns it, because sequences are
   deliberately non-transactional. So the alarm fired every time an ordinary request failed. Removed:
   the chain already catches an interior deletion through the broken `prev_hash` link, with no false
   positives at all.

And one limitation stated rather than papered over: **a deleted suffix still verifies.** No log can
prove from inside itself that it has not been truncated. `audit.head()` returns the current tip for
publishing to storage the database role cannot write (S3 Object Lock, different account) — that is
the only thing that makes truncation visible, and it is operational work for step 16.

**Passwords are off.** `emailAndPassword: { enabled: false }` removes the precondition for
GHSA-qq9h-g4jm-xgf3 globally. Sign-in is magic link plus TOTP. Note the seed script
(`src/database/seeds/seed.ts`) still creates an admin with a password through its own Better Auth
instance — the user is created correctly but that password will not sign them in.

## ✅ 7. The vertical slice — allocate campaign budget

**One command, zero Stripe, zero real money**, exercising every structural claim: a genuine ledger
movement, real UI, gated by a real permission, no external money rail.

The completion criterion, met: **click a button → `treasury_command` row → worker posts a ledger
entry → balance updates**, with the worker discovering the work for itself.

### What was built

- [x] `Campaign` — minimal, but real. Without it `{campaignId}` is an unvalidated UUID and the worker
      derives an account for a campaign in another organization. Carries `@@unique([id, organizationId])`
      so the ledger can key onto it.
- [x] `AllocateBudgetUseCase` (api) — resolves the campaign **with the tenant predicate in the WHERE
      clause**, derives the workspace from it, checks `can()` and then **separately**
      `hasMoneyAuthority()`, writes the command and `pg_notify` in ONE `$transaction`, returns 202.
      Performs no money work and has no import path to the ledger.
- [x] `AllocateBudgetProcessor` (worker) — re-authorises from current state, re-derives both accounts
      from the database, verifies the requester's balance assertion, posts. The command is a pointer,
      never an instruction.
- [x] `TreasuryCommandListener` — LISTEN/NOTIFY for latency, a 5s durable sweep for correctness.
      Deleting the LISTEN makes it slower; deleting the sweep makes it lose money.
- [x] `FundingController` — route, method, **status code** and permission all wired from the one
      manifest entry. `@ValidatedBody()` recovers the operation id from the handler's own metadata, so
      the id is written once and server validation cannot diverge from the published spec.
- [x] `PermissionGuard` now actually enforces, deny-by-default, with scope from the URL.
- [x] `ledger.account_for_campaign` / `ledger.org_lot_to_spend` — account **derivation**, so a caller
      cannot name an account at all.
- [x] Console: `toMinorUnits` and `allocationIdempotencyKey` extracted and tested; the form sends the
      balance it rendered as an assertion.

### Three real defects this step found and fixed

1. **`post_entry` was not idempotent under concurrency.** Two workers handed the same job both found
   no existing entry, both inserted, and the loser got `23505` — classified terminal, correctly — so
   it reported failure for an allocation that had in fact posted. The command row was then marked
   `failed` while a real ledger entry existed for it. The ledger was right and the command record was
   wrong, which is the worst way to be wrong. `post_entry` now catches `unique_violation` and returns
   the winner's entry. The existing concurrency test had been **swallowing rejections**, which is how
   it stayed hidden; it no longer does.
2. **The console's idempotency key was derived from the amount**, so a legitimate second allocation of
   the same size was silently swallowed as a replay — the UI reported "Accepted" and nothing happened.
   The key now includes the campaign's allocated balance, so the same request before the first lands
   is a replay and after it lands is a new intent.
3. **`expectedAvailableMinor` was in the contract and inert.** A security-shaped field that does
   nothing is worse than no field. It is now carried on the command and checked **in the worker**,
   because the api cannot see the ledger — its role holds no grants on that schema.

### Two authorization checks, deliberately

The guard sees only the URL, so it can answer *could this caller hold this permission anywhere in this
organization* — a ceiling, sound because it is a superset. The handler answers *may you here*, scoped
to the workspace it reads off the campaign. Neither is redundant and neither is sufficient alone, and
the HTTP tests assert each rejection happens at its own layer.

### How "the payment service is never publicly exposed" is now proven

Four independent layers, each tested:

| Layer | Mechanism | Test |
| --- | --- | --- |
| Import graph | `dependency-cruiser`, direct **and** transitive | `src/architecture/boundaries.spec.ts` — each rule is deliberately broken and asserted to fire |
| DI graph | `TreasuryWorkerModule` bound only in `WorkerModule` | `funding-http.integration-spec.ts` — `app.get(AllocateBudgetProcessor)` throws |
| Routing | `TreasuryWorkerModule` declares no controller | there is no path to expose |
| Database | `rayi_api` has no grants on `ledger` | negative-privilege tests (step 3) |

A boundary rule that has never been seen to fail is a boundary rule nobody knows still works — a typo
in a regex silences it permanently and silently. So the rules are checked, and the checks are checked.

### Deferred, deliberately

- **FIFO lot consumption.** `org_lot_to_spend` **raises** when an org holds more than one open lot
  rather than picking one. A `LIMIT 1` would spend from an arbitrary lot and report a balance that is
  wrong while every constraint still passes. Lands with the deposit lifecycle (step 11).
- **Step-up on allocate.** `stepUp: false` in the manifest today. Allocation moves money between two
  accounts Rayi controls and nothing leaves the platform; release is the step-up moment.
- **`BudgetEnvelope`.** The workspace ceiling from the architecture doc is not built. Allocation is
  gated by `MoneyAuthority` and the non-negative constraint only.

## ⬜ 8. Staging AWS

Two accounts, prod SCP denying `rds:DeleteDBInstance` / `kms:ScheduleKeyDeletion` /
`cloudtrail:StopLogging` / `backup:DeleteBackupVault`. GitHub OIDC, Terraform owning task definitions.
One alarm deliberately tripped to prove the SNS-to-phone path works.

## ⬜ 9. Webhook ingestion

Two endpoints, two signing secrets, `Stripe-Account` routing. Store raw, return 200, process in the
worker. WAF managed rules in **Count mode for two weeks** first — a blocked webhook is a silent money
bug with a 3-day fuse.

**Done when:** eight adversarial orderings converge to the same golden ledger fingerprint.

## ⬜ 10. Stripe onboarding + deposit intent (test mode)

Express onboarding, brand deposit via Checkout + Financial Connections + hosted mandate. Record
`account_holder_type` but **never size the hold window from it**.

## ⬜ 11. Deposit lifecycle + reconciliation from day one

## ⬜ 12. Domain state machines

Deal / milestone / deliverable / submission. `scheduled_wake` driven by a one-minute cron tick — not
deferred queue jobs, whose 14-day retention would delete a 75-day horizon job before it fires.

## ⬜ 13. Release engine — **first money movement**, test mode

Guards re-run at the top of **every** phase, not once at start — a retry can be days later.

## ⬜ 14. The failure paths

ACH return as a first-class state. Kill switch: one row the worker reads inside the release
transaction, flippable without a deploy, settable with `psql` if the API is down.

## ⬜ 15. Payout schedule, creator surface, notifications

## ⬜ 16. Production hardening and go-live gate

Rehearsed PITR restore including the hard part — re-driving Stripe events after the restore point
while Stripe has moved on.

---

## Not blocked by engineering — start these now

- [ ] **A2P 10DLC registration.** 10–15 days, up to **4–6 weeks** with AT&T manual review, and it
      gates the signature moment entirely. Start in week one.
- [ ] **Stripe in writing:** hold-and-release confirmation, max hold duration, `controller.losses.payments`
      (decides whether the fraud reserve is sized for real or theoretical exposure), **Funds Segregation**
      private preview, and the partial-ACH-refund contradiction.
- [ ] **Fintech counsel:** agent-of-payee under milestone holds by state, escrow language review, TPSO
      classification, escheatment.
- [ ] US Class 36 trademark clearance for "Rayi".
- [ ] 20–30 creator pilot from the WhatsApp community.

## Technical debt

- [ ] Prisma 6.19.3 → 7.10.x (deliberate upgrade, not incidental)
- [ ] Better Auth `increment` for the rate limiter is a non-atomic read-modify-write
- [ ] Console bundle is 640 KB (Zod client-side) — matters for the creator path on 4G, not the console
- [ ] Nobody has visually reviewed the console UI
- [ ] `org_lot_to_spend` raises on multiple lots — replace with FIFO consumption in step 11
- [ ] `expectedAvailableMinor` is compared against the single spendable lot, which equals the org
      available only while there is one lot. Revisit with FIFO.
- [x] ~~`TreasuryCommandListener` needs `FOR UPDATE SKIP LOCKED` before a second worker runs~~ — done:
      claims are atomic, leases expire after 5 minutes so a dead worker's command is reclaimed, and
      `attempts` is capped at 5 so a poison command stops being retried instead of becoming a hot loop
- [ ] Users cannot change their email or manage sessions: those Better Auth endpoints are blocked and
      their Nest replacements are not built yet
- [ ] The seed script creates an admin with a password, which no longer signs anyone in
