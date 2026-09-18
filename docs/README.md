# Rayi documentation

Everything decided, why it was decided, and what is left. Written so a new session — human or agent —
can pick up without re-deriving anything.

## Start here

| # | Doc | What's in it |
| --- | --- | --- |
| 1 | [Product](01-product.md) | What Rayi is, the business model, pricing, market, regulatory position, product principles |
| 2 | [Decisions](02-decisions.md) | **Every decision and its reasoning.** Check before proposing a change |
| 3 | [Architecture](03-architecture.md) | Repo layout, the three processes, request flow, contract pipeline |
| 4 | [Money rules](04-money-rules.md) | Ledger invariants and verified Stripe behaviour. **Read before touching money** |
| 5 | [Security](05-security.md) | Threat model, controls, Better Auth hardening, CVE floors, bugs found |
| 6 | [Roadmap](06-roadmap.md) | 16-step build order with status |

`../CLAUDE.md` is the short version, auto-loaded into every session.

## The shortest possible summary

Rayi is a conditional-payment rail for brand↔creator collaborations. A brand funds via ACH, money
sits **in Stripe**, milestones get verified, funds release automatically, creators are paid in
minutes. **Rayi never custodies funds** — that is the whole regulatory strategy.

The backend is NestJS + Prisma + Better Auth on Fastify, deployed as three processes from one image
(`api`, `webhooks`, `worker`) where only the worker can move money. The frontend is a TanStack SPA.
A Zod manifest generates the OpenAPI document, which generates the typed client — so the frontend can
be built before the backend exists.

## Things that are easy to get wrong

Each of these cost real investigation. They are written up in full in the docs above.

- **An ACH return arrives as `charge.dispute.created`, not `charge.failed`.** Guards written against
  the obvious event never fire.
- **Stripe does not support partial ACH refunds.** Refund-to-origin is load-bearing in the
  non-transmitter argument. The per-deposit lot model is the mitigation.
- **`source_transaction` must not be used with ACH** — Stripe would cover a returned debit out of
  Rayi's own balance.
- **`account_holder_type` is attacker-controlled.** The 2-day vs 60-day dispute window cannot be sized
  from a field the payer types into a form.
- **Better Auth routes never reach the Nest guard chain**, and its roles are comma-separated, so money
  capability cannot live in `member.role`.
- **The US fund-holding limit is 2 years**, not the 90 days in the original strategy doc.

## Conventions

Skills in `.claude/skills/` load automatically: `rayi-nestjs`, `rayi-prisma-ledger`,
`rayi-better-auth`, plus the third-party `nestjs-best-practices`.

## Keeping this current

When a decision is made, add it to [Decisions](02-decisions.md) with the reasoning — the reasoning is
the valuable part, because it is what stops the decision being silently reversed later. When a
roadmap step completes, tick it and note what it produced.
