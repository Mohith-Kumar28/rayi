# Roadmap

Each step ends in something demonstrable. Money moves as late as possible, and only in test mode
until step 16.

**Status: 1 ✅ · 2 ✅ · 3 🟡 · 4 ✅ · 5 ✅ · 6 🟡 · 7 ✅ · 8–16 ⬜**

Steps 3 and 6 are one item short each: RLS with a `withTenant()` helper, and Nest replacements for the
Better Auth account endpoints that are currently blocked rather than replaced.

Current test count: **751 passing**.

| Suite | Tests | Needs a database |
| --- | --- | --- |
| `@rayi/domain` — Money, **milestone conditions, deal evaluation** | 88 | no |
| `@rayi/contracts` — manifest invariants, OpenAPI shape | 68 | no |
| `@rayi/api-client` — generated client, **problem guard ↔ schema agreement** | 32 | no |
| `@rayi/console` — minor-unit conversion, idempotency key | 30 | no |
| `@rayi/backend` unit — config, guards, auth allowlist, mail, **two webhook signature schemes**, TOTP (RFC 6238 vectors), architecture boundaries | 274 | no |
| `@rayi/backend` integration — ledger, integrity, audit, authorization, treasury, account, step-up, members, RLS, webhooks, **review queue**, HTTP, queue | **259** | **yes** |

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

## ✅ 3. Database foundation and the privilege boundary

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
- [x] **RLS on org-scoped tables** with `TenantScope.withTenant()` / `.crossTenant()`, plus a
      dedicated `rayi_app` role that the policies actually apply to

### RLS, and an honest account of what it buys

Every tenant query already carries its predicate in the WHERE clause, and the composite foreign keys
make a cross-org row unrepresentable. This is the third layer, for the case the other two cannot
cover: a query someone writes LATER that forgets the predicate. Not a malicious developer —
`findMany({ where: { state: 'live' } })` in a reporting endpoint six months from now, correct-looking
and reviewed.

RLS does not make that impossible, because it is only a control if the connection carries the tenant,
and Postgres cannot know which organization a pooled connection is acting for. What changes is the
**failure mode**: a forgotten `withTenant()` returns ZERO rows rather than everyone's — a visibly
broken feature instead of a silent leak.

`SET LOCAL` via `set_config`, never a plain `SET`: a plain one outlives the transaction and, on a
pooled connection, leaks the tenant into whatever runs next. That would be *worse* than no RLS,
because the next request reads someone else's data while every check passes. Tested, including the
throwing case.

Cross-tenant work (reconciliation, the super-admin surface, the worker's sweep) goes through an
explicitly-named `crossTenant(reason)` that logs every call — rather than granting the application
role `BYPASSRLS`, which would make the policies decorative.

#### The first version was completely inert

The policies were written, enabled and **forced** — and every one of them did nothing, because the
development connection uses a role with `rolsuper` and `rolbypassrls`. Both bypass RLS
unconditionally; `FORCE ROW LEVEL SECURITY` subjects the table *owner* to policies but cannot touch a
superuser.

So the tests would have passed by seeing every row, and the first environment where the control
mattered would have been the first one where it had never run. Exactly the class of failure this
project keeps finding: a control that is present, reviewed, and doing nothing.

Fixed three ways: a `rayi_app` role created `NOSUPERUSER NOBYPASSRLS`, the RLS tests connecting **as
that role** and asserting the premise before relying on it, and the boot assertion refusing to start
on any connection that bypasses RLS.

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

## ✅ 2b. Email — Resend *(swapped in after step 7)*

SMTP, nodemailer, handlebars and the `.tsx → .hbs` build step are gone. React Email
components render at send time; `MailService` is the only caller of Resend.

- [x] `RESEND_API_KEY` is **worker-only**, enforced at boot exactly like the Stripe secret key
- [x] Deterministic idempotency keys — `sha256(template, recipient, url)` — so BullMQ's
      at-least-once delivery cannot put several live magic links in one mailbox
- [x] The URL is **hashed** into the key, never included: the key is echoed in Resend's dashboard
- [x] Nothing logs a template context. A magic link in a log is a credential in a log
- [x] `MAIL_REDIRECT_ALL_TO` for staging, with the real recipient in a header
- [x] 36 tests across the service and config

### Two traps this closed

**Resend does not throw on failure.** `emails.send()` resolves to `{ data, error }`. A direct port
from nodemailer — which throws — would `await`, see no exception, mark the BullMQ job complete and
silently drop every email while every log line said success. Handled once, in `MailService`, and
tested by stubbing an error response and asserting it throws.

**`nest build` does not compile `.tsx`.** Its swc builder hardcodes `extensions ?? ['.ts']` and
exposes no flag. The templates were absent from `dist` while typecheck, tests and the build all
reported success — the first symptom would have been a worker crashing on its first outbound email,
in production, on the sign-in path. A `build:templates` step fixes it and `verify:build` proves it,
by rendering a template **out of `dist`** and asserting the props interpolated. Verified by removing
the step and watching the check fail.

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

## 🟡 5. The frontend — brand, creator and admin

`orgId` in the URL, campaign list, allocation form, per-deposit lot list, `<Money>` primitive, MSW
handlers from the generated client.

- [x] Allocation form driven by generated hooks against MSW — no backend, no AWS
- [x] `<Money>` renders from string minor units with a server-supplied exponent
- [x] `toMinorUnits` / `allocationIdempotencyKey` extracted with 30 unit tests

- [x] **Security screen** (`/me/security`) — sessions with the current one marked, email change,
      authenticator removal, and the audit trail the user can read about themselves
- [x] **People screen** (`/o/$orgId/members`) — roles, invitations, and a **"Can move funds" flag**,
      because capability granted separately from any role is also invisible unless a surface shows it
- [x] **Review queue** (`/o/$orgId/review`) — the brand index route, and the signature screen
- [x] **Campaigns** (`/o/$orgId/campaigns`, `/campaigns/$campaignId`) — create, and the four money
      figures kept separate: allocated, committed, released, uncommitted
- [x] **Deals** (`/o/$orgId/deals`, `/deals/$dealId`) — the list with committed-vs-released totals,
      the detail with frozen milestone amounts, offering under step-up, terminating
- [x] **Deal authoring** (`/o/$orgId/deals/new`) — milestone builder where **every amount comes from
      `previewDeal`**, so the client computes no money and the advance disclosure is derived rather
      than declared. Verified in a browser: a milestone typed as "after 0 videos" still fires it
- [x] **Creator roster** (`/o/$orgId/creators`, `/creators/$creatorId`) — derived from deals, scoped
      to this organization, and organised around whether the creator can actually *be paid*
- [x] **Workspaces** (`/o/$orgId/workspaces`, `/workspaces/$workspaceId`) — the budget envelope as an
      authorization ceiling, with the exhausted case saying what stops and what keeps running
- [x] **Settings** (`/o/$orgId/settings`) — name, daily release limit, funding account, and pending
      invitations as what they are: unclaimed routes into the organization
- [x] **Creator surface** (`/me`, `/me/deals/$dealId`, `/me/payouts`, `/me/profile`) — lazily loaded.
      Payouts never promise a weekday; rebinding a destination is treated as a money action
- [x] **Super admin** (`/admin`, `/admin/brands/$brandId`, `/creators`, `/ops`, `/audit`) — platform
      figures, brand drill-down, the treasury command inbox, webhook deliveries, and the hash-chained
      audit log with per-row chain validity
- [x] `<StatusPill>` — one status vocabulary, where `secured` green means settled and nothing else
- [x] **Every screen has been opened in a browser and looked at.** 24 routes swept for render errors,
      empty renders and `undefined`/`NaN` leaking into text; each defect below was found that way
- [ ] Origin isolation for `/admin` — it now has its own chrome and nav, but still shares an origin.
      That is a deployment change, not a code one
- [ ] `<Countdown>` extraction, org switcher, public `/@handle` pages
- [x] ~~No backend for the 31 new operations~~ — **built**. Services, controllers and migrations for
      workspaces, budget envelopes, campaigns, deals, the roster, the organization, invitations,
      creator payouts and the four admin operational surfaces. 26 new integration tests

### The budget envelope is a ceiling, enforced by the storage engine

`CHECK (committedMinor <= ceilingMinor)` plus a conditional UPDATE, which is the same shape as the
ledger's `balance_minor >= 0`: an over-commit is a **storage-engine error**, not a race somebody has
to remember to guard. Two concurrent offers against a ceiling that funds one — exactly one succeeds,
asserted rather than swallowed.

Hitting the ceiling hard-blocks NEW commitments and leaves accepted deals running. An expired
envelope behaves identically. A ceiling set below what is already committed is **refused**, because
lowering one claws nothing back and accepting the write would only make the stored numbers disagree
with the deals that are running.

### Four drifts the new work surfaced, each now a failing test rather than a silence

- **`DATE_REACHED` carried `date` in the contract and `at` in the engine.** A dated milestone
  evaluated `undefined`: it would never satisfy, and a past-dated advance would have slipped the
  disclosure. `condition-parity.test.ts` feeds every shape the contract accepts to the real
  `evaluateCondition` rather than comparing type names — which would have passed.
- **A route could declare a permission no role held.** It fails closed, which is why it is
  dangerous: it 403s for everyone including the owner, nothing alarms, and the first report is a
  customer saying a button does nothing. `permission-coverage.integration-spec.ts`, with a negative
  case.
- **`sqlStateOf` could not see a SQLSTATE on `PrismaClientUnknownRequestError`** — no `code`, no
  `meta`, the connector error stringified into the message. Every constraint refusal on a Prisma
  `updateMany` arrives that way, so a correct database refusal read as an unknown failure.
- **The api-client barrel is hand-written and orval emits one directory per tag.** A new tag
  compiled, typechecked and was simply not exported.

### `signatureValid` was removed from the webhook contract

A delivery whose signature does not verify is refused at the edge and never becomes a row, so the
field could only ever read `true` — and a badge that is always the same teaches an operator to stop
seeing it. The burst-of-failures signal belongs in a rate alarm on the rejecting handler.

### The review queue is exceptions plus one bar

Three seconds a row is a claim about SHAPE, not speed. The server returns rows that need a
decision — a failed or unverifiable check, or an approval that would release funds — and **one
collapsed summary** of everything that cleared. A queue that shows everything is a queue people
abandon.

- **Keyboard first.** `j`/`k` move, `a` approves, `c` requests changes, `u` undoes. Reaching for a
  mouse per row is most of the three seconds.
- **`ERROR` is not `FAIL`.** A check that could not run reads "could not verify", in a neutral
  colour, and never blocks — a creator must not be punished for our infrastructure.
- **A truthful pending lane.** On approve the row moves to `Releasing in 0:58 · Undo`. Felt speed is
  identical to optimistic rendering, but the UI never asserts money moved, because it has not.
- **No client-side copy of the undo window.** The countdown is driven entirely by the server's
  `releasesAt`. A duplicated constant would drift into an Undo button offered after the release job
  had already run.

### The creator surface is a different product

A phone, opened between takes, answering one question: *when do I get paid, and what do I have to do
to get paid?* It shows three money figures that are deliberately never collapsed into one — paid out,
on its way, and not unlocked yet. `agreedNotYetUnlocked` is not called "earned", because a creator
will plan around whatever number they are shown.

The "what unlocks my next payment" sentence is produced by `evaluateDeal` — the same function that
decides whether money moves — so this screen structurally cannot promise what the engine will not do.

**Lazily loaded, and that is not an optimisation.** Shipping the brand review queue and members table
to a creator on mobile data is a cost paid by the population that can least afford it.

### The admin surface, and the number that must never be added

**Funds under management is not revenue.** One is brands' money sitting at Stripe; the other is what
Rayi has earned. They are rendered in different sections, with different weight, and the copy says
"never add this to the figure on the left" — because the mistake gets repeated in every deck built
from the dashboard.

**Ledger health is rendered first, and loudly.** Every list must be empty; a non-empty one means the
books disagree with themselves and no other number can be trusted. "Never checked" renders as its own
state and never as a green tick.

### What the boundary rules caught while building this

The first admin service read the ledger directly. dependency-cruiser refused it — and the rule was
right for a reason deeper than the rule: **`rayi_api` has no grants on the `ledger` schema at all**,
so those queries would have failed in production while passing in development as a superuser.

Rewritten as a worker-computed `platform_snapshot`. That is also the better design: the health check
verifies every account's balance against the sum of its lines, which does not belong in a request
path. Every figure carries the timestamp it was computed at, and a missing snapshot returns 503
rather than zeros — zeros on a revenue dashboard are indistinguishable from a business that has
earned nothing, and somebody will screenshot them.

### And a migration-ordering bug, caught by the shadow database

`campaign_domain` was written after the RLS migration and called
`public.current_tenant()` — which that later file creates. Applied in creation order it worked;
**replayed in filename order, which is what a fresh deploy does, it failed outright.**

The cause is systemic and is now written down in `prisma/migrations/README.md`: several migrations
were hand-named with timestamps in the FUTURE, so newly generated ones sort before them. The RLS
policies moved to their own correctly-ordered file, and CI already replays the whole chain from an
empty database on every push.

## ✅ 6. Identity and authorization

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
- [x] **Step-up authentication** — RFC 6238 TOTP, verified against the spec's own Appendix B
      vectors, plus short-lived grants bound to a purpose AND a resource, single-use and consumed
      atomically
- [x] **Email change** with step-up, a confirmation at the NEW address and a cancel link to the OLD
      one
- [x] **Two-factor removal** behind a code from the factor being removed
- [x] **Invite / role-change / member-removal** as Nest controllers with a role ceiling, step-up,
      audit rows and session + money-authority revocation on downgrade
- [x] **Two-factor enrolment**, written to a SEPARATE table until a code from it verifies — so a
      mis-scanned QR or a wrong phone clock cannot lock a user out of the account they were securing.
      Backup codes are hashed and shown once
- [x] **One authorization authority.** Better Auth's `ac` model is left unset rather than generated
      from `role_permission`: its `/organization/*` endpoints are 404'd, so it governs nothing, and a
      synchronised second evaluator still answers questions independently.
      `AccessControlAssertion` refuses to boot if one is ever added — including inside a plugin,
      which is where it would actually appear

### Step-up: what makes it more than a second prompt

A session cannot prove who is at the keyboard — it was established once, possibly days ago, possibly
on a device that is no longer in the user's hands. So sensitive actions take a fresh factor, and the
grant it mints has three properties that each exist because their absence has been a real
vulnerability:

| Property | Without it |
| --- | --- |
| Bound to a **purpose** | A grant minted to change an email removes a second factor |
| Bound to a **resource** | Confirming "$10 to campaign A" authorises "$10,000 to campaign B" — literally the bulk-approve hole the money review found |
| **Single use, consumed atomically** | Two concurrent requests both spend the same confirmation |

The consume is one conditional `updateMany` carrying every condition. Check-then-spend would leave a
window between the two, and that window is the whole vulnerability — there is a test that races three
consumes and asserts exactly one wins.

Rate limited at five failures per fifteen minutes. Six digits with a one-step drift window is three
valid values in a million at any moment, so unlimited guessing finds one in minutes at HTTP speeds.
That limit is not hardening; it is the difference between a second factor and a delay.

**TOTP is implemented rather than depended on**, because Better Auth's `verifyTOTP` is a sign-in
endpoint — it establishes a session, which is the wrong effect for "confirm you are still you" and
would make a step-up indistinguishable from a fresh login in the audit trail. Writing it is
defensible because RFC 6238 publishes **test vectors**: the implementation is checked against
Appendix B for SHA-1, SHA-256 and SHA-512, so correctness is verified against the specification
rather than against a reading of it.

### Email change is two-sided, and both sides matter

The **step-up** proves the person asking holds the factor. The **confirmation at the new address**
proves they can receive mail there — without it a typo locks someone out permanently, and the failure
is invisible until they next try to sign in.

The **old address is notified first**, before the confirmation is sent. If only one of the two can be
delivered, the one that lets the real owner stop an attack is worth more than the one that completes
it. That notification carries a cancel link needing no sign-in, because the person receiving it may
already be locked out — requiring authentication would make the escape hatch useless exactly when it
matters.

Tokens are stored as SHA-256 hashes only. A database read must not hand over a working
account-takeover link.

### Membership: the escalation that is now unreachable

Better Auth's docs say plainly that *"there's no built-in restriction preventing an admin from
inviting someone as owner"*. That makes self-promotion a two-step move for any admin with a second
mailbox — and because its endpoints bypass the Nest guard chain, nothing in the control design ever
saw it.

- **Nobody may grant a role above their own.** Comma-separated roles are split and read by their
  HIGHEST value, because `role === 'owner'` is false for `'member,owner'` while
  `role.includes('owner')` is true for `'not-owner'`. Both are tested.
- **Self-promotion is refused outright**, even for an owner, so there is always a second person in
  the record.
- **A downgrade kills the sessions and the money authority.** A role taken away that leaves a live
  session is a role still held, for as long as that session lasts.
- **An invitation can only ever produce a ROLE.** Money capability is a separate row nothing in the
  membership path can create — which deletes the escalation class rather than guarding its uses.
- The members list **flags who holds money authority**, because capability invisible in that list is
  capability nobody audits.
- An organization cannot be left with **no owner** — an unrecoverable state reachable by an ordinary
  mistake.

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

## 🟡 9. Webhook ingestion

The **pattern** is built and proven against Resend. Stripe reuses it unchanged,
which is the point of having done the lower-stakes provider first.

- [x] `webhook_event` — every delivery stored RAW, idempotent on `(source, externalId)`, with the
      payload, headers and provider id **immutable** after receipt
- [x] Svix signature verification with replay protection and secret rotation (29 tests)
- [x] Verify → store → 200, and nothing else in the request
- [x] Interpretation split into the **worker**, enforced by dependency-cruiser with a test that
      breaks the rule and asserts it fires
- [x] Resend bounce and complaint handling, with an email suppression list
- [x] **Stripe platform + Connect endpoints**, two signing secrets, `Stripe-Account` recorded at
      the edge

### Two endpoints, two secrets, and why that is not optional

Connect events — `account.updated`, `payout.paid`, `payout.failed`,
`transfer.reversed` — arrive on a **separate endpoint with its own signing secret**. Without the
second endpoint they have no reception path at all: a creator's payout failing, or their payout bank
details changing, simply never reaches us. Silent, with a three-day fuse, because Stripe retries for
three days and then stops.

Tested in both directions: a Connect delivery signed with the platform secret is refused, and vice
versa. Idempotency is on `(source, externalId)` using **Stripe's own event id**, because that is what
its retries reuse — a generated id would make every retry a new row.

### Stripe's signature scheme is NOT Svix's

Having implemented both, the asymmetry is exactly the kind of thing a well-meaning refactor unifies:

| | Svix (Resend) | Stripe |
| --- | --- | --- |
| Key | `whsec_` stripped, remainder **base64-decoded** | the secret **as-is**, prefix included |
| Signed string | `{id}.{timestamp}.{body}` | `{timestamp}.{body}` |
| Encoding | base64 | hex |

Three tests assert the schemes do not accept each other's signatures, in both directions. Unifying
them would fail closed — every delivery rejected, looking like an attack rather than a bug.

`stripe.webhooks.constructEvent` is deliberately not used: it lives on a `Stripe` client built with
an API key, which the webhook surface does not hold and must not hold. Verification needs only the
endpoint secret.

**Found while wiring this:** `stripe` was registered in `app.module.ts` from the start but was never
added to `GlobalConfig`, so `config.get('stripe.…')` was a compile error and nothing could read it. A
config namespace nothing can read is a config namespace that is not doing anything.
- [ ] Eight adversarial orderings converging to the same golden ledger fingerprint
- [ ] WAF managed rules in Count mode for two weeks with a Stripe-IP allow rule ahead of them

### Why the handler is three lines of work

A webhook endpoint that also does the work has the **provider's retry policy wired to our processing
time**. A slow handler becomes a timeout, a timeout becomes a retry, and a bug becomes a lost
delivery once the provider gives up. For Stripe that is a three-day fuse on a silent money bug.

So: verify the signature, insert the raw row, return 200. `ResendWebhookPoller` in the worker reads
it back 30 seconds later, where being slow costs nothing.

### The raw body is the evidence

The signature covers the exact bytes the provider sent. `request.body` has been parsed, and
re-serialising it changes whitespace, number formatting, duplicate keys and key order — so the
signature never matches. That failure **fails closed and looks like an attack**: every delivery
rejected as unauthenticated, logs full of signature mismatches, nothing pointing at the parser.

Four test cases cover exactly that, and the stored payload is `TEXT` rather than `jsonb` for the same
reason — the row has to still verify years later.

A first attempt registered a custom Fastify content-type parser and collided with the one Nest
registers during `init()`. Nest's own `rawBody: true` is the supported answer, and the test sets it
the same way `main.ts` does, so the option is under test rather than being test scaffolding.

### Suppression is a control pointed at our own users

A hard bounce means the mailbox does not exist. Continuing to send damages the sending domain's
reputation, which degrades delivery for **every other user** — one dead address quietly makes
everyone else's sign-in links less likely to arrive. It also makes a real failure visible: without
it, a creator whose address is dead looks exactly like one who has not read their email, and the
first symptom is an unexplained missing payout.

Getting it wrong in the aggressive direction is worse than getting it wrong permissively, so:

- **only a `Permanent` bounce suppresses.** A transient one is a full mailbox or a greylist, and
  suppressing on those locks a creator out over a mail server that was busy for an hour
- an **unknown** bounce type does not suppress — one more email to a dead address costs
  deliverability; a wrongly suppressed address costs a user their account, and they cannot tell us,
  because the way they tell us is email
- the **first** suppression is kept rather than overwritten, because it is the one that explains why
  mail stopped
- every suppression writes an audit row, so support can answer "why did mail stop"
- it is **reversible** (`liftedAt`), because a bounce can be a temporary misconfiguration

`MailService` checks the list before rendering anything, and throws `MailSuppressedError` — distinct
from `MailSendError` because the remedies differ: a send failure should be retried and a suppression
never should.



Two endpoints, two signing secrets, `Stripe-Account` routing. Store raw, return 200, process in the
worker. WAF managed rules in **Count mode for two weeks** first — a blocked webhook is a silent money
bug with a 3-day fuse.

**Done when:** eight adversarial orderings converge to the same golden ledger fingerprint.

## ⬜ 10. Stripe onboarding + deposit intent (test mode)

Express onboarding, brand deposit via Checkout + Financial Connections + hosted mandate. Record
`account_holder_type` but **never size the hold window from it**.

## ⬜ 11. Deposit lifecycle + reconciliation from day one

## 🟡 12. Domain state machines

Deal, agreement versions, milestones, deliverables, submissions and the review
queue — **with no money movement anywhere in them**.

- [x] `Deal` first-class and per-creator, with `AgreementVersion` (SCD-2) between it and its
      milestones, so an accepted agreement is immutable and an amendment is a new version needing
      both signatures
- [x] **The condition catalogue** — closed, parameterized, JSONB with a generated `condition_type`
      column under CHECK. An unknown type is refused by the storage engine, not by whichever code
      path parses it first
- [x] **`evaluateDeal()` — pure, total, clock-injected**, returning verdicts with human sentences
- [x] Three machines kept apart: Deliverable (the slot), Submission (immutable versioned attempt),
      Review (a decision on one version)
- [x] Approve / request-changes / **undo**, with optimistic concurrency on every transition
- [ ] Deliverable hard-deadline worker on a one-minute cron tick
- [ ] The `scheduled_wake` table (a 75-day horizon outlives BullMQ's 14-day job retention)
- [ ] Milestone release job — that is step 13, and the first money movement

### Two properties that are registry-level requirements, not features

**MONOTONIC — once true, true forever.** Payout is final, so a milestone that becomes satisfied,
releases, and then becomes unsatisfied is an unrecoverable state: the money is gone and the ledger
says it should not have been. It is also what makes concurrent re-evaluation trivially safe — if
truth moves one way, a stale evaluation can only be *behind*, never wrong. Tested as a property over
every condition type, against a world that only ever grows.

**COUNTING IS CUMULATIVE.** `DELIVERABLES_APPROVED_COUNT` means "total approved across the deal >=
N", so a tranche schedule is M1(5), M2(12), M3(20). Incremental counting would need to remember which
approvals were consumed by which milestone, making evaluation order-dependent and non-idempotent —
and under at-least-once delivery, that is a double payment. Tested for idempotence and order
independence directly.

### The four ways this would have released money wrongly

Each is now a test:

1. **Counting submissions instead of deliverables.** A deliverable with two approved versions counts
   twice and "20 videos approved" fires at 19 — a silent overpay with every constraint passing.
   Closed by a partial unique index: at most one live `APPROVED` review per deliverable.
2. **Undo that deletes the review.** Impossible under append-only, and it erases the fact a decision
   was made. Undo now **voids** — `voidedAt IS NULL` is in the index, so voiding frees the
   deliverable and both rows survive.
3. **A second release path.** The hard-deadline worker force-approved the deliverable without
   inserting a Review, bypassing the one index that prevents double-pay. It goes through the
   identical `approve()` with `actorKind = SYSTEM_AUTO`.
4. **Approval gated only on a reviewer permission.** Approving deterministically releases funds, so
   an approve button is a way to move money without holding money authority. The check asks *would
   this approval satisfy a milestone* **before** writing, and requires `MoneyAuthority` plus the
   per-transaction limit only when the answer is yes — so an ordinary review still needs no money
   grant and the three-second queue is unaffected.

### Undo is not a deleted job

Deleting the queued release job is **not** an interlock: the worker can claim it between the click
and the delete, which is a TOCTOU race with money on the other side. The job re-derives from the
database at run time and aborts on any voided approval, so the void alone is sufficient and the job's
existence is irrelevant.

### An advance is not a special type

It is a milestone whose condition is trivially satisfiable — no separate entity, no parallel code
path, no second release mechanism to keep correct. What stays is the **disclosure**, and it is
DERIVED: `isSatisfiableAtStart()` evaluates a condition against an empty deal, so
`DELIVERABLES_APPROVED_COUNT` with `count: 0`, a `DATE_REACHED` in the past, and an empty
`SPECIFIC_DELIVERABLES_APPROVED` list are all caught as advances. A brand cannot sidestep the warning
by expressing one a different way.

### Immutability, enforced by the database

A released milestone's amount and condition cannot change (the ledger entry would become
unexplainable). A submission cannot be edited (a revision is a new version, or a dispute cannot show
attempt 1 and attempt 2 side by side). A review's decision cannot change (changing your mind is a new
review after voiding the old one). All three are triggers, and all three have tests that try.

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
- [x] ~~Console bundle is 640 KB (Zod client-side)~~ — 672 KB → **580 KB** (216 → 190 KB gzipped) by
      replacing `ProblemSchema.parse` with a narrow hand-written guard. Importing one schema from
      `@rayi/contracts` pulled the entire operation manifest AND Zod into the browser. The guard is
      tested for agreement with the schema on every input, so the contract stays the authority
      without being shipped
- [ ] 580 KB is still large — the rest is React, TanStack Router and Query. The creator path needs
      its own entry point, not just a lazy route, to avoid the shared shell
- [x] ~~Nobody has visually reviewed the console UI~~ — every route has now been opened
- [ ] `org_lot_to_spend` raises on multiple lots — replace with FIFO consumption in step 11
- [ ] `expectedAvailableMinor` is compared against the single spendable lot, which equals the org
      available only while there is one lot. Revisit with FIFO.
- [x] ~~`TreasuryCommandListener` needs `FOR UPDATE SKIP LOCKED` before a second worker runs~~ — done:
      claims are atomic, leases expire after 5 minutes so a dead worker's command is reclaimed, and
      `attempts` is capped at 5 so a poison command stops being retried instead of becoming a hot loop
- [ ] The seed script creates an admin with a password, which no longer signs anyone in

- [ ] The console bundle is now 624 KB shared + per-screen chunks of 1–9 KB. Every new screen is
      lazily loaded, but the creator path still downloads the shared brand bundle on 4G and
      needs its own Vite entry point
