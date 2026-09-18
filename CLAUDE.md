# Rayi

Conditional-payment rail for brand↔creator collaborations, wedging in on TikTok Shop.

A brand funds money via ACH → funds sit inside **Stripe** → milestones are verified → funds release
to the creator's Stripe connected account automatically → weekly batched payouts.

**Rayi never custodies funds.** That is the entire regulatory strategy: no money transmitter
licences, no escrow licensing, no customer-facing wallet. Stripe holds and moves the money; Rayi is
the ledger, the verification engine and the trust layer.

Solo founder-engineer working with AI agents. No hard deadline — **correctness over speed**.

---

## Read these before doing anything substantial

| Doc | When you need it |
| --- | --- |
| [`docs/01-product.md`](docs/01-product.md) | What Rayi is, the business model, the product principles |
| [`docs/02-decisions.md`](docs/02-decisions.md) | **Every decision and why.** Check here before proposing a change |
| [`docs/03-architecture.md`](docs/03-architecture.md) | Repo layout, services, request flow |
| [`docs/04-money-rules.md`](docs/04-money-rules.md) | Ledger invariants + verified Stripe behaviour. **Read before touching money** |
| [`docs/05-security.md`](docs/05-security.md) | Threat model, the controls, CVE floors |
| [`docs/06-roadmap.md`](docs/06-roadmap.md) | Build order with what is done and what is next |

Project skills in `.claude/skills/` load automatically when relevant:
`rayi-nestjs`, `rayi-prisma-ledger`, `rayi-better-auth`, `nestjs-best-practices`.

---

## The rules that matter most

1. **Money is integer minor units as `bigint`, always.** Never a float, never a JS `number`, never a
   decimal string parsed with `parseFloat`. On the wire it is
   `{ amountMinor: "15000", currency: "USD", exponent: 2 }` — a **string**, with a server-supplied
   exponent. There is no `?? 2` fallback anywhere.

2. **The balance is never a stored number code can assign to.** There is no
   `UPDATE ... SET balance = X`. Allocation is a ledger entry. Over-allocation is prevented by a
   **database constraint**, not application logic.

3. **The api process can never move money.** It holds no full Stripe key (refused at boot), has no
   import path to `src/ledger/` or `src/treasury/processors/` (dependency-cruiser, direct *and*
   transitive), no DI binding for them (`TreasuryWorkerModule` is bound only in `WorkerModule`), and
   its database role has no access to the ledger schema. It writes an intent + enqueues a job in one
   transaction and returns 202. The **worker** performs every ledger post and every Stripe call.

   Importing a treasury *use case* from a controller is fine — that is the intended path. What must
   not exist is a synchronous route from a request thread to a ledger posting.

4. **No external call inside a database transaction.** No Stripe, no HTTP, no notification.

5. **Deny by default.** Authentication is a global guard; authorization is a second global guard that
   refuses any `@Operation()` route not declaring a permission. Tenant scope comes from the **URL**,
   never from `session.activeOrganizationId`. A non-member gets **404, not 403** — a 403 confirms the
   organization exists.

   Authorization is **two layers**: the guard enforces a ceiling it can derive from the URL, the use
   case enforces the resource-scoped check with the scope read from the database. Neither is
   redundant and neither is sufficient alone.

   Money capability is **never a role**. It is a `MoneyAuthority` row, checked separately from
   `can()`, and the per-transaction limit is checked where the amount is visible.

6. **An account is derived, never named.** A caller says which campaign it is acting on;
   `ledger.account_for_campaign` decides which account that is and reads the owning org from the
   campaign row. Never pass an account id in from outside the ledger.

7. **A test that guards money may not swallow a rejection.** `.catch(() => null)` in a concurrency
   test is how a real double-write defect stayed hidden through a green suite.

8. **A control that has never been seen to fail is a control nobody knows still works.** Every
   boundary rule, every ledger constraint and every allowlist entry has a test that deliberately
   breaks it and asserts the alarm fires. Adding a control without that test is adding decoration.

9. **Better Auth serves before Nest's guards run.** Its mount is deny-by-default
   (`src/auth/auth-route-allowlist.ts`): 10 endpoints open, the other 32 return 404, and
   `pnpm verify:auth-surface` fails CI if an upgrade changes the set. Never widen it without
   deciding, in `BLOCKED_AUTH_ROUTES`, why the endpoint was closed.

---

## Commands

```bash
pnpm check                              # OpenAPI drift gate + typecheck + all tests + module boundaries
pnpm check:db                           # migrations + the 84 integration tests (needs DATABASE_URL)
pnpm contracts                          # regenerate openapi.json and the typed client
pnpm --filter @rayi/backend depcruise   # module boundary enforcement
pnpm --filter @rayi/console dev         # the SPA against MSW mocks, no backend needed

# Integration tests need a real Postgres 17 — they are deliberately NOT skipped when it is absent,
# because a silently skipped test that guards money reports green while asserting nothing.
docker run -d --name rayi-pg -e POSTGRES_PASSWORD=rayi -e POSTGRES_USER=rayi \
  -e POSTGRES_DB=rayi -p 55432:5432 postgres:17-alpine
export DATABASE_URL=postgresql://rayi:rayi@localhost:55432/rayi
pnpm --filter @rayi/backend migrate:deploy   # guarded: refuses a disabled advisory lock or a pooler
pnpm --filter @rayi/backend test:it
```

## Layout

```
apps/backend    NestJS + Prisma + Better Auth (Fastify). Three entrypoints, one image.
apps/console    React SPA — TanStack Router + shadcn/ui, runs against mocks
packages/domain      Money value object + pure ledger logic. No I/O. Heaviest test coverage.
packages/contracts   Zod operation manifest → openapi.json. Single source of API truth.
packages/api-client  Generated from openapi.json. Never hand-edited.
```

## Working style

Talk architecture through before scaffolding. Lead with reasoning, keep it plain, show the trade-off
rather than declaring a verdict. Once a decision is made it is locked — build within it. Reserve
pushback for real money, legal or security consequences: state the concern once, then build what was
asked.
