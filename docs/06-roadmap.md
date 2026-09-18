# Roadmap

Each step ends in something demonstrable. Money moves as late as possible, and only in test mode
until step 16.

**Status: 1 ✅ · 2 ✅ · 3 🔨 in progress · 4–16 ⬜**

Current test count: **142 passing** across 4 packages.

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

## 🔨 3. Database foundation and the privilege boundary

- [ ] Ledger Prisma schema — accounts, entries, lines, balances, snapshots, idempotency keys
- [ ] Raw-SQL migration for what Prisma cannot express: deferred `SUM=0` constraint trigger,
      append-only triggers, `REVOKE UPDATE/DELETE`, `allow_negative` CHECK, partial unique indexes
- [ ] Four Postgres roles (`rayi_migrator`, `rayi_api`, `rayi_worker`, `rayi_webhooks`) with the grant
      matrix as checked-in data generating both the SQL and its conformance test
- [ ] Boot assertion querying `pg_constraint` / `pg_trigger` — refuse to start if a control is missing
- [ ] RLS on org-scoped tables with a `withTenant()` helper
- [ ] Migrations as a one-off task gated on an advisory lock

**Done when:** `rayi_api` gets `permission denied for schema ledger`; a cross-tenant read returns zero
rows.

## ⬜ 4. Ledger core

- [ ] `ledger.post_entry(jsonb)` — advisory locks over sorted account ids, ≥2-line assertion,
      deferred `SUM=0`, append-only triggers, entry dedupe, balance snapshot via CTE
- [ ] Retry wrapper walking `.cause` for SQLSTATE `40001`/`40P01`
- [ ] AsyncLocalStorage transaction-purity guard
- [ ] Two-session concurrency harness

**Done when:** cannot overdraw, double-post, UPDATE, DELETE, or post unbalanced — and a forced 40001
actually triggers a retry.

## ⬜ 5. Brand console against mocks *(parallel with 2–4)*

Org switcher with `orgId` in the URL, campaign list, allocation form, review queue, `<Money>` /
`<StatusPill>` / `<Countdown>` primitives.

## ⬜ 6. Identity and authorization

Better Auth behind a deny-by-default path allowlist; `/organization/*` blocked and reimplemented as
Nest controllers with audit + step-up; `PermissionService` over a `role_permission` table; committed
allowlist snapshot failing CI on a version bump.

## ⬜ 7. The vertical slice — allocate campaign budget

**One command, zero Stripe, zero real money**, exercising every structural claim: a genuine ledger
movement, real UI, gated by a real permission, no external money rail.

Click a button → `treasury_command` row → worker posts a ledger entry → balance updates.

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
