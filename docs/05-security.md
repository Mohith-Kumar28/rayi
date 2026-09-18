# Security

## Threat model

The threat is not "someone DDoSes us". It is:

1. An endpoint that forgot its authorization check
2. A race that double-pays a creator
3. A compromised admin action
4. A fraudulent brand funding a wave with a stolen bank account
5. **A hijacked creator account redirecting a payout** — stolen wages, and the population with the
   weakest auth is the one that *receives* the money

## Controls

- **Deny by default, twice.** `AuthGuard` (authentication) and `PermissionGuard` (authorization) are
  both global. A route declaring `@Operation()` without a permission is refused.
- **Tenant scope comes from the URL**, never `session.activeOrganizationId` — that field is shared
  mutable state across tabs, and an agency operator with two clients open would act against the wrong
  brand. Resources are loaded **with the tenant predicate in the WHERE clause**, returning 404 not 403
  so the endpoint is not an existence oracle.
- **Least-privilege database roles.** `rayi_api` cannot write ledger tables at all. That single split
  turns "SQL injection in a brand-facing endpoint" from catastrophic into merely bad.
- **Append-only ledger and audit log**, enforced by `REVOKE` + triggers, hash-chained so tampering is
  detectable.
- **Field-level encryption on top of disk encryption** for tax IDs and bank identifiers — what
  Increase actually does.
- **Maker-checker** on manual releases, refunds and dispute rulings. But see the caveat below.
- **No PII or secrets in logs.** Redact by allowlist, not denylist.
- **PCI scope stays SAQ-A** — card data never touches us, and Phase 1 has no cards at all.

## Maker-checker cannot prove humans

`approver_user_id <> initiator_user_id` distinguishes **rows, not people**. A second mailbox and a
second TOTP seed satisfy every eligibility test.

Worse, a graduated design *punishes honesty*: a founder who declares solo mode gets a ceiling, while a
sock-puppet silently removes it. So the controls that need **no second human** are primary and
always-on:

- **$10,000/day per-organization ceiling**, applied on org risk signals, not self-declared headcount
- **72-hour hold** on every newly linked or changed payout destination
- **Out-of-band confirmation** with a no-login cancel link, where the stop action requires the code
  from that message
- **Velocity checks** on brand–creator pairs created and released within a short window

## Better Auth — the hardening that makes it safe

Chosen knowingly. It has published **10 security advisories in 2026** (1 Critical, 7 High, 2
Moderate), verified directly at
[github.com/better-auth/better-auth/security/advisories](https://github.com/better-auth/better-auth/security/advisories).

Most sit in optional plugins we don't install. The one that matters:
**"Account takeover via pre-account hijacking on magic-link and email-OTP sign-in"**
(GHSA-qq9h-g4jm-xgf3, High) — exactly the flow creators use when arriving from a payment link.

Required configuration:

| Rule | Why |
| --- | --- |
| `emailAndPassword: { enabled: false }` **globally** | Removes the precondition for GHSA-qq9h-g4jm-xgf3 in one line, for everyone. Operators use passkey + magic link + mandatory TOTP |
| `dynamicAccessControl` **disabled** | Its `cacheAllRoles` is a module-level `Map` written on every call with no TTL and no invalidation — across Fargate tasks a revoked permission can stay honored indefinitely |
| **Do not install** `@better-auth/sso`, `@better-auth/scim`, `@better-auth/stripe` | Four of the ten advisories live in those plugins, including the only Critical one |
| Pin ≥ **1.7.5** | Above all three advisory floors (≥1.4.17, ≥1.6.14, ≥1.6.22). Currently installed: 1.7.5 ✅ |
| **Deny-by-default path allowlist at the mount**; block `/organization/*` | Better Auth's middleware serves and returns *before* the Nest guard chain runs, so `/organization/update-member-role` has no MFA, no audit, and no coverage from a route test that enumerates Nest routes |
| **Money capability cannot live in `member.role`** | Roles are stored **comma-separated**, and the docs confirm there is no restriction preventing an admin inviting someone as *owner*. `MONEY_ROLES.has(role)` is false for `'member,finance'`. Money capability is a Rayi-owned `MoneyAuthority` row, mintable only through a Rayi controller under step-up + dual control |
| Workspaces are **Rayi tables, not Better Auth teams** | `teamMember` is `(id, teamId, userId, createdAt)` with **no role column**; issue #2955 requesting team-scoped roles was closed as not planned |

### Creator protection

Every brand-side control protects brands only. Creators are passwordless with no MFA and their entire
permission set is "be paid" — and a hijacked creator session can mint a Stripe Express login link and
change the payout bank account. Email-OTP step-up is **circular** when the attacker holds the mailbox.

- Treat minting a Connect login link or AccountLink as a **money-moving action**: fresh
  re-authentication, hard rate limit, notify **old and new** channels.
- **Payout-destination freeze**: on `account.updated` where `external_accounts` changed, hold payouts
  72h. That webhook is the only signal Rayi gets.
- Reframe the sensitive action as **binding a `connected_account_id` to a creator** — first bind is
  one-way; rebinds route through Stripe's own onboarding so Stripe's identity checks are the second
  factor.
- **Bind magic-link redemption to the originating browser.** Otherwise a victim clicking an attacker's
  link is silently signed into the attacker's account and may attach their own bank details to it.
- **SIM swap**: US carriers reassign numbers in ~45 days, so this is a passive leak for every dormant
  creator.

## Version floors

| Package | Floor | Installed | Reason |
| --- | --- | --- | --- |
| `@nestjs/core` | ≥ 11.1.19 | **11.2.5** ✅ | CVE-2026-2293 authz bypass (CVSS 9.8); CVE-2026-40879 DoS; CVE-2026-35515 SSE XSS |
| `@nestjs/platform-fastify` | > 11.1.15 | **11.2.5** ✅ | CVE-2026-33011 — Fastify auto-routes HEAD→GET, so middleware on a GET route is **bypassed by a HEAD request**. On a guard-protected money surface that is the worst possible failure mode |
| `better-auth` | ≥ 1.6.22 | **1.7.5** ✅ | See above |

Re-check all of these before launch.

## Bugs found in the inherited boilerplate

All fixed. Recorded because they show the class of thing to look for.

**The rate limiter was bypassable.**
```ts
return (proxyIp ?? req?.ips?.length) ? req?.ips[0] : req?.ip;
```
`??` short-circuits on a *defined* value, so whenever a forwarded header existed the branch returned
`ips[0]` and **discarded the `proxyIp` it had just computed** — the header parsing was dead code.
Worse, `ips[0]` is the **leftmost** `X-Forwarded-For` entry, which the client supplies: rotate the
header, get a fresh rate-limit bucket every request. Now uses `req.ip`, which Fastify derives
according to `trustProxy`.

**`DATABASE_URL` was effectively optional.** `@ValidateIf((env) => env.DATABASE_URL)` only validates
*if present*, so a missing URL passed validation and the app booted without a database, failing at
first query.

**Config error reporting threw while reporting errors.** `Object.entries(error.constraints)` —
`constraints` is `undefined` for nested validation errors, so a nested config problem crashed with a
`TypeError` instead of saying what was wrong. Same bug in `validate-dto.decorator.ts`.

**Authentication was opt-in.** `AuthGuard` was applied per-controller, so a new controller that
forgot `@UseGuards(AuthGuard)` was silently public. Compounded by a trap: health used `@Public()`
(sets `IS_PUBLIC`) while the guard reads `IS_PUBLIC_AUTH` from `@PublicAuth()` — two decorators, two
keys, one of which does nothing for auth.

**Strict mode was off** — `strictNullChecks: false`, `noImplicitAny: false`. For a payments backend
that is the mechanism by which a missing amount becomes a silent zero. Now on; 131 errors fixed.

**Types lied about their validators.** AWS config declared `region: string` while every field was
`@IsOptional()`. Fixed by making types honest, not by asserting past them.

## Known residual risk

- **Better Auth `increment`** (rate limiter) is a non-atomic read-modify-write, so racing requests
  undercount. Tolerable *only* because the authoritative limit is at the edge and via
  `@nestjs/throttler` — Better Auth's own limiter has a documented bypass (CVE-2026-45364) and is
  never the control.
- **Agent-reported CVE identifiers must be verified.** A research pass once cited three GHSA ids for
  Better Auth that **do not exist**. Treat any agent-reported CVE or API name as a claim to check.
- `role.authorize()` as a pure exported server-side evaluator is **undocumented** — verify by test
  before depending on it.

## Infrastructure controls

- Prod SCP denying `rds:DeleteDBInstance`, `kms:ScheduleKeyDeletion`, `cloudtrail:StopLogging`,
  `backup:DeleteBackupVault` — the cheapest high-value control available, turning the worst
  solo-founder failure mode into an error message.
- **Terraform owns task definitions**; CI only passes an image digest. Otherwise `ecs:RunTask` +
  `iam:PassRole` with a container command override means whoever triggers the production workflow can
  run arbitrary commands with database reach.
- `pgaudit` with **write** scoped to the ledger schema, shipped to a **different AWS account** with S3
  Object Lock.
- **Kill switch:** one row the worker reads *inside* the release transaction, flippable without a
  deploy, failing closed if unreadable, settable with `psql` if the API is down.
