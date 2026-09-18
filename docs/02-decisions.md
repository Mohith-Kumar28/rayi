# Decisions

Every decision taken, with the reasoning. **Check here before proposing a change** — most of these
were argued through and several reversed an earlier position for a specific reason.

Status key: **Locked** — settled, build within it. **Open** — needs a call.

---

## Stack

| Decision | Status | Why |
| --- | --- | --- |
| NestJS on long-lived containers, **not serverless** | Locked | Ledger needs real transactions; RDS Proxy *pins* connections the moment you open one, so you lose multiplexing exactly on the money path. Long timers (7–14 day approval windows, 75-day horizon) fit a worker, not a 15-min Lambda ceiling. Cost is a wash (~$85–220/mo either way). Every payments company with public engineering disclosure — Stripe, Adyen, Wise, Monzo, Nubank, Gusto, Mercury, Modern Treasury — runs core ledger logic on persistent compute; none on FaaS |
| **Prisma** as ORM | Locked (founder call) | Founder chose it over Drizzle knowingly. Work within it: raw SQL for `FOR UPDATE`, explicit isolation levels, and the constraints Prisma cannot express live in hand-written migrations |
| **Better Auth** | Locked (founder call) | Chosen knowingly despite the advisory history. See `05-security.md` for the hardening that makes it safe |
| **PostgreSQL on AWS RDS** | Locked | Not Neon or serverless-HTTP Postgres for the ledger — the ledger's whole point is long transactions with explicit isolation levels, which HTTP drivers don't do |
| **Turborepo + pnpm** | Locked | `turbo prune --docker` solves the monorepo Docker build-context problem |
| **TanStack Router** (SPA) for the money path | Locked | Backend is a separate API, so RSC/server functions add an authorization surface for nothing. TanStack **Start** is still RC — confine it to public pages if used at all |
| **Fastify** (from the boilerplate) | Locked | Came with the boilerplate; verified `@nestjs/platform-fastify` 11.2.5 is above the CVE-2026-33011 fix line |
| **NestJS 11.2.5**, not 12 | Locked | v12 shipped 2026-08-27 — three weeks old, ecosystem lagging. Above all four 2026 CVE floors. Revisit as a deliberate upgrade |
| **Zod** for contracts, class-validator retained in inherited code | Locked | Zod drives the manifest and OpenAPI. The boilerplate's class-validator DTOs stay where they are; new money contracts use Zod |
| **OpenAPI-first**, not tRPC | Locked | tRPC produces no OpenAPI artifact; its bridge was archived Nov 2024. An external partner or auditor needs a real spec |
| **OpenFGA** | Deferred | Rayi's shape is org-scoped RBAC, not a Zanzibar sharing graph. A second datastore with eventual consistency gating money movement is the wrong trade. Build behind a `PermissionService` interface so it can be swapped later |

### The boilerplate

Replaced our hand-built backend with `superbug/nestjs-prisma-boilerplate` (shallow clone, no history;
upstream `niraj-khatiwada/ultimate-nestjs-boilerplate`, 432★, MIT). Founder's call: *replace
wholesale, then re-apply our work*.

What it brought: Better Auth↔Nest wiring, worker server, BullMQ + Bull Board, Redis rate limiting,
helmet, graceful shutdown, Pino, Prometheus/Grafana, i18n, S3 uploads, Docker dev/prod, i18n, CI.

---

## Tenancy and money model

```
Organization  (a company — owns the funding balance and the Stripe relationship)
  └─ Workspace  (sub-brand / product line / market — groups campaigns and people, holds NO money)
       └─ Campaign  (allocated a budget directly from the org balance)
            └─ Deal  (one per creator: agreed total, agreed deliverable count)
                 ├─ Milestone  (brand-authored: an amount + a release condition)
                 └─ Deliverable  (one asset — video, reel, image, carousel)
                      └─ Submission  (a versioned attempt; revisions create new versions)
```

| Decision | Status | Why |
| --- | --- | --- |
| Campaigns allocate **directly from the org balance** — no workspace budget layer | Locked | Keeps the ledger tree two levels and halves the over-allocation invariants |
| Workspace budget is an **authorization cap**, not a ledger account | Locked | Reconciles "each workspace has its own budget" with "workspaces hold no money" — a `BudgetEnvelope` ceiling drawn down at allocation time, enforced by `CHECK (committed <= ceiling)` |
| Workspace ceiling **hard-blocks new allocations, leaves committed deals running** | Locked | Finance keeps control without stranding live creator work mid-campaign |
| **Each client brand is its own organization**, funding from its own bank account | Locked | Founder call. Brand owns the money and can leave with its data |
| Agency access = **a real `Member` row in the client's org**, via ordinary invitation | Locked | Three cross-org *delegation* designs were each demolished in review. Better Auth already supports one user in many orgs, so there is no delegation mechanism, no intersection logic, no second guard branch. `AgencyRelationship` is a **label** with no authorization weight |
| Money authority **does not travel** to agency members | Locked | `MoneyAuthority` is a separate row the brand simply never mints for them |
| **$10,000/day ceiling** for an org with no second approver | Locked | Applied on org risk signals, **not** self-declared headcount — otherwise the design punishes honesty: a founder who declares solo mode gets a ceiling while an attacker with two mailboxes gets none |
| **Finance approves the envelope; marketing spends within it** | Locked | Makes the strategy doc's core insight real in software |

---

## Deals and milestones

| Decision | Status | Why |
| --- | --- | --- |
| **Deal is a first-class entity**; milestones attach to Deal, never Campaign | Locked | Terms differ per creator; the payout bound needs a per-creator ceiling; the Stripe connected account and 1099 identity are per-creator; amendments need bilateral consent |
| Milestone conditions are a **closed, parameterized catalogue** | Locked | v1: `ADVANCE`, `DELIVERABLES_APPROVED_COUNT`, `SPECIFIC_DELIVERABLES_APPROVED`, `ALL_DELIVERABLES_APPROVED`, `DATE_REACHED`, `MANUAL_BRAND_APPROVAL`. A DSL is premature; arbitrary user logic is unauditable — you could not tell a creator *why* they were not paid |
| `MANUAL_BRAND_APPROVAL` is the escape hatch | Locked | Removes the pressure to build a rule engine |
| Every condition must be **MONOTONIC** — once true, true forever | Locked | Payout is final. A milestone that becomes satisfied, releases, then becomes unsatisfied is an unrecoverable state the engine must be unable to reach |
| Counting is **cumulative, never incremental** | Locked | "Total approved across the deal ≥ N". Incremental counting requires remembering which approvals were consumed, making evaluation order-dependent and non-idempotent |
| **An advance is not a special type** — it's a milestone with a trivially satisfiable condition | Locked (founder call) | Founder's framing, and better than the special-casing originally proposed. What survives is the *disclosure*: the UI evaluates each condition against an empty deal, and anything satisfiable at t=0 surfaces the warning. Derived, so a brand cannot sidestep it by rephrasing |
| **No cap on advance amount** | Locked (founder call) | Founder's call. ⚠️ The design pass argued for a hard 30% cap on *fraud* grounds — an advance is the shortest path from a stolen ACH debit to a cashed-out payout by a colluding fake creator. Mitigations that don't cap: no advance release until `charge.succeeded` **and** settled ≥2 business days; relationship gating (creator has ≥1 completed deal, or brand has prior history with this creator) |
| Milestone amounts may be **fixed or a percentage** | Locked (founder call) | Percentage is *authoring input*, never authoritative. At acceptance each milestone resolves to integer minor units, odd cents go to the earliest milestone, and amounts **freeze on the row**. Re-evaluating at release would retroactively rewrite an already-paid milestone |
| `SUM(milestone.amount) == deal.total`, enforced by a **database constraint** | Locked | The founder's "no amount mismatch" requirement made structural |
| **Evaluation is pure; release is transactional** | Locked | `evaluateDeal()` is side-effect-free and returns per-milestone verdicts *with human sentences* — the same function powers the creator's "what unlocks my next payment", the brand's preview and the stored evidence, so the UI can never promise what the engine won't do |
| Milestone conditions count **deliverables approved, never submissions** | Locked | If they counted submissions, a deliverable with two approved versions counts twice and "N videos approved" fires early — a silent overpay |

---

## Queues

| Decision | Status | Why |
| --- | --- | --- |
| **BullMQ (Redis)** for everything that can afford at-least-once | Locked (founder call) | Emails, notifications, media processing, TikTok polling, reports. Keeps the boilerplate's whole queue investment |
| **Postgres-backed queue for the money path only** | Locked (founder call) | The job must commit **inside the same transaction as the ledger write**. BullMQ lives in Redis and cannot join a Postgres transaction, so it would reintroduce the dual-write bug and require an outbox |

---

## Frontend

| Decision | Status | Why |
| --- | --- | --- |
| **One origin for everything authenticated** | Locked | `app.rayi.com` with the API same-origin via a CloudFront `/api/*` behaviour → host-only `__Host-` cookie, no CORS, no preflight, no `SameSite=None`, and `connect-src 'self'` is literally true |
| **Delete SSE from v1** | Locked | Two designs spent their largest complexity budget on a channel that only fires when the creator already has the page open — but the signature moment is her phone buzzing while inside TikTok. In-app liveness is TanStack Query `refetchInterval`; SMS/push are built first |
| **Truthful pending state, not optimism** | Locked | On approve, rows move to a `Releasing in 0:58 · Undo (u)` lane. Felt speed identical to optimistic rendering, but the UI never asserts money moved — which matters because notifications may already have told the creator |
| Client-supplied amounts are **assertions, never instructions** | Locked | Request carries `expectedAmountMinor`; the server compares against its own value, **pays its own value**, and skips-and-reports any mismatch |
| **Bulk approve needs three server-side ceilings** | Locked | Per row, per batch total, per actor rolling 24h. The per-action limit was enforced *per row*, so a reviewer capped at $200 could select 1,000 cleared rows at $150 and move **$150,000 with one keystroke** |

---

## Settled while building the vertical slice (step 7)

| Decision | Status | Why |
| --- | --- | --- |
| **`Campaign` is a real table now**, not deferred to step 12 | Locked | Without one, `{campaignId}` is an unvalidated UUID and the worker derives a ledger account for a campaign in another organization — a perfectly balanced posting against the wrong tenant. It carries only what allocation needs; the state machine, deals and milestones still land in step 12 |
| **Accounts are derived, never passed in** | Locked | A caller that can name an account id can name someone else's. `ledger.account_for_campaign` reads the owning org from the campaign row, so "post to a different account" is not expressible — closes the attack the money-integrity review found ("control account ids are caller-supplied") |
| **Authorization is two layers: guard ceiling + use-case scope** | Locked | The guard sees only the URL, so a workspace-scoped permission is not derivable from a path naming a campaign. It enforces "could you ever, anywhere in this org" — sound because a superset. The use case reads the workspace **off the campaign** and enforces "may you here". Neither is redundant, neither is sufficient alone |
| **`movesMoney` routes require a `MoneyAuthority` row at the guard**, amount checked at the handler | Locked | The guard cannot see the amount. Pretending otherwise is exactly how a per-row limit ends up not applying to a batch |
| **404 rather than 403 for a non-member** | Locked | A 403 confirms the organization exists, turning every tenant route into an enumeration oracle. Applied to the permission check too; the money-authority denial stays 403, because by then the caller can already see the campaign and "ask someone with authority" is the only actionable message |
| **Idempotency key reuse with different terms is a refusal, not a replay** | Locked | Returning 202 would tell the caller their new amount was accepted while the original one posts |
| **`expectedAvailableMinor` is checked in the WORKER** | Locked | The promise is "the server compares it against its own figure". The api literally cannot — its role has no grants on the ledger schema — so the assertion travels on the command and is checked where the truth is. It **fails** the command rather than adjusting the amount: guessing what the user would have wanted is how a system pays a number nobody chose |
| **`org_lot_to_spend` raises on multiple lots rather than picking one** | Locked until step 11 | FIFO consumption is deposit-lifecycle work. A `LIMIT 1` would spend from an arbitrary lot and report a wrong balance while every constraint still passes — constraints satisfied and number wrong is the outcome the whole design exists to prevent |
| **`stepUp: false` on allocate** | Locked for now | Allocation moves money between two accounts Rayi controls; nothing leaves the platform. Release is the step-up moment |
| **The money queue is LISTEN/NOTIFY + a durable poll** | Locked | NOTIFY is fire-and-forget: raised while no worker is connected, it is gone, and Postgres drops them under load. The `pending` rows are the queue. Deleting the LISTEN makes it slower; deleting the poll makes it lose money |
| **`TreasuryModule` (api) and `TreasuryWorkerModule` (worker) are separate modules** | Locked | A Nest module is a DI boundary, not an import boundary. Splitting them means the api graph has no processor to resolve — asserted by test — and dependency-cruiser polices the import graph separately |

---

## Email

| Decision | Status | Why |
| --- | --- | --- |
| **Resend**, not SMTP | Locked (founder call) | An HTTPS API with an API key has no TLS negotiation to get subtly wrong, no long-lived connection to leak, and no `ignoreTLS` flag that silently downgrades a production sender to plaintext because it was convenient once in development. `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_REQUIRE_TLS` and `MAIL_IGNORE_TLS` are all gone |
| **`RESEND_API_KEY` is worker-only**, like the Stripe secret key | Locked | The api is internet-reachable. A compromise there able to send from our verified domain is a phishing capability aimed at the population whose accounts receive money — and a magic link is a credential, so "send email as Rayi" is close to "sign in as anyone". The api enqueues; the worker sends. Boot fails if the key is anywhere else |
| **React Email rendered at send time**, no handlebars | Locked | The old pipeline compiled `.tsx` → `.hbs` at build time and interpolated `{{email}}` at runtime: two representations of one template, a build step between them, and `strict: true` as the only thing between a renamed prop and an email reading `{{url}}` to a user. Template props are now required, so a missing one is a type error |
| **Idempotency key derived from the intent** | Locked | BullMQ is at-least-once by design. A worker killed mid-send, a stalled job or a post-deploy redelivery all re-run the job — and for a magic link that is several live credentials in one mailbox. The key is `sha256(template, recipient, url)`, so retries collapse to one send while two genuinely different links still both go |
| The key **hashes** the URL rather than containing it | Locked | An idempotency key travels in a request header and is echoed in Resend's dashboard and API responses. A magic link there is a credential in a third party's UI |
| **Nothing logs a template context** | Locked | A magic link in a log line is a credential in a log line, readable by anyone with log access for as long as the log is retained. The send log carries the Resend id and nothing else |
| `MAIL_REDIRECT_ALL_TO` for staging | Locked | Sending a live magic link to a real brand's mailbox from staging is not a mistake anyone gets to make twice. Every outbound email redirects, with the real recipient in `X-Rayi-Intended-Recipient` so the mailbox stays readable |

---

## Identity and authorization, settled while building step 6

| Decision | Status | Why |
| --- | --- | --- |
| **TOTP implemented, not depended on** | Locked | Better Auth's `verifyTOTP` is a sign-in endpoint — it establishes a session, which is the wrong effect for "confirm you are still you" and makes a step-up indistinguishable from a login in the audit trail. Writing it is defensible because RFC 6238 publishes test vectors: it is checked against Appendix B for SHA-1, SHA-256 and SHA-512 |
| **A step-up grant is bound to a PURPOSE and a RESOURCE** | Locked | A grant that says only "this user confirmed something" is a bearer capability — confirm a harmless action, spend it on a dangerous one. That is the bulk-approve hole, generalised |
| **Consumed with ONE conditional `updateMany`** | Locked | Check-then-spend leaves a window between the check and the spend, and that window is the whole vulnerability. A test races three consumes and asserts exactly one wins |
| **Enrolment writes to a separate table until confirmed** | Locked | Writing straight to the live table means a mis-scanned QR or a wrong phone clock locks a user out of the account they were trying to secure, with no way back |
| **Better Auth's `ac` is left UNSET, not generated** | Locked (changed from the plan) | The plan said generate it from `role_permission`. Having blocked `/organization/*` at the mount, that model governs nothing — and a synchronised second evaluator still answers questions independently. Two authorities drift, and the drift surfaces when one allows what the other refuses |
| **A role ceiling on invitations and role changes** | Locked | Better Auth's docs: "there's no built-in restriction preventing an admin from inviting someone as owner." Self-promotion is refused outright even for owners |
| **A downgrade revokes sessions and money authority** | Locked | A role taken away that leaves a live session is a role still held, for as long as that session lasts |
| **`rayi_app` connects without SUPERUSER or BYPASSRLS** | Locked | Both bypass every RLS policy unconditionally, and `FORCE ROW LEVEL SECURITY` does not help — it subjects the table owner, not a superuser. Without this the policies are decorative |
| **Cross-tenant access is an explicit named call**, not `BYPASSRLS` | Locked | Granting the role a bypass would make every policy decorative. `crossTenant(reason)` is greppable, appears in the code using it, and logs every call |

---

## Open questions

- **Does deliverable approval require `MoneyAuthority`?** Approving a deliverable deterministically
  causes a Stripe Transfer 30 seconds later, so a "reviewer" role is functionally a money-moving
  role. Either approval requires `MoneyAuthority` + the ceilings, or the action splits into
  recommend-then-confirm (which preserves the finance/marketing split but adds a step to the
  three-second review queue).
- **Prisma 6 → 7 upgrade.** The boilerplate is on 6.19.3; our own guidance said pin 7.10.x. Prisma 6
  *does* have `isolationLevel`, so it is functionally fine, but it is two majors behind. Deliberate
  upgrade, not an incidental one.
- **Should AWS config be required rather than optional?** Currently optional because the boilerplate
  supports local *or* S3 uploads.
- **Does `expectedAvailableMinor` mean the org's available or the lot's?** The UI sends the org
  figure; the worker compares it against the single spendable lot. Identical today by construction,
  because `org_lot_to_spend` raises with more than one lot. Must be resolved when FIFO lands.
- **Claiming a treasury command.** The listener sweeps `status = 'pending'` with no `FOR UPDATE SKIP
  LOCKED`. Safe today because `post_entry` is idempotent and the command update is guarded on
  `status = 'pending'`, so a race wastes work rather than corrupting state — but it needs a real
  claim before a second worker runs.
