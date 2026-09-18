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

## The five rules that matter most

1. **Money is integer minor units as `bigint`, always.** Never a float, never a JS `number`, never a
   decimal string parsed with `parseFloat`. On the wire it is
   `{ amountMinor: "15000", currency: "USD", exponent: 2 }` — a **string**, with a server-supplied
   exponent. There is no `?? 2` fallback anywhere.

2. **The balance is never a stored number code can assign to.** There is no
   `UPDATE ... SET balance = X`. Allocation is a ledger entry. Over-allocation is prevented by a
   **database constraint**, not application logic.

3. **The api process can never move money.** It holds no full Stripe key (refused at boot), has no
   import path to the treasury module (enforced by dependency-cruiser), and its database role has no
   write access to the ledger schema. It writes an intent + enqueues a job in one transaction and
   returns 202. The **worker** performs every Stripe call.

4. **No external call inside a database transaction.** No Stripe, no HTTP, no notification.

5. **Deny by default.** Authentication is a global guard; authorization is a second global guard that
   refuses any `@Operation()` route not declaring a permission. Tenant scope comes from the **URL**,
   never from `session.activeOrganizationId`.

---

## Commands

```bash
pnpm check                              # typecheck + test everything + verify the OpenAPI drift gate
pnpm contracts                          # regenerate openapi.json and the typed client
pnpm --filter @rayi/backend depcruise   # module boundary enforcement
pnpm --filter @rayi/console dev         # the SPA against MSW mocks, no backend needed
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
