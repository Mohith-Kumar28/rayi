---
name: rayi-better-auth
description: Rules for Better Auth, tenancy and authorization in the Rayi codebase. Use whenever touching auth config, the Better Auth mount, organizations, workspaces, members, roles, permissions, session handling, or any guard that decides who may move money.
---

# Better Auth and authorization rules for Rayi

Better Auth is the chosen auth library. These rules are the hardening that makes it safe for a
product that moves money. Each was verified against Better Auth 1.7.5 docs or source.

## 1. Better Auth's routes never reach the NestJS guard chain

Its middleware serves and returns **before** Nest guards run. That includes
`/organization/invite-member`, `/organization/update-member-role`, `/two-factor/disable`,
`/change-email` and `/revoke-sessions`. A route-authz test that enumerates Nest routes will pass
green while these are wide open.

- Mount behind a **deny-by-default path allowlist** — roughly twelve read-only paths exposed,
  everything else 404s. Block `/organization/*` outright via `disabledPaths`.
- Reimplement invite, role-change and member-removal as **Nest controllers** with
  `@RequirePermission` + step-up + in-transaction audit + session revocation on downgrade, calling
  `auth.api.*` internally.
- **Commit a snapshot of the allowlist.** A version bump that adds an endpoint must fail CI.

## 2. Money capability cannot live in `member.role`

Verified in the docs: roles are **stored comma-separated**, and *"there's no built-in restriction
preventing an admin from inviting someone as owner."* So `MONEY_ROLES.has(role)` is false for
`'member,finance'`, and `beforeAddMember` never fires on the accept path.

- `member.role` is one value:
  `CHECK (string_to_array(role,',') <@ ARRAY['owner','admin','member'])` — subquery-free, because
  PostgreSQL rejects subqueries in CHECK.
- **Money capability is the existence of a Rayi-owned `MoneyAuthority` row**, mintable only through a
  Rayi controller under step-up and dual control — a path Better Auth's route surface cannot reach.

This deletes the escalation class rather than patching hooks.

## 3. Scope comes from the URL, never from the session

`hasPermission` silently falls back to `session.activeOrganizationId` when `organizationId` is
omitted. That is the GHSA-h3rm-78g3-j7cp bug class.

- Every tenant route carries `:orgSlug`; money routes also carry `:workspaceId`.
- Both are resolved **with the tenant predicate in the WHERE clause**, returning 404 not 403, so there
  is no comparison for anyone to forget.
- `session.activeOrganizationId` is a UI redirect default only. Record it on money routes purely to
  alarm on divergence.

This is not optional polish: an agency user is legitimately a member of several client organizations
within one session, and two open tabs would otherwise book an allocation against the wrong brand.

## 4. Configuration that is fixed

- `emailAndPassword: { enabled: false }` **globally**. This removes the precondition for
  GHSA-qq9h-g4jm-xgf3 (pre-account hijacking on magic-link / email-OTP) in one line, for everyone.
  Operators use passkey + magic link + mandatory TOTP.
- `dynamicAccessControl` **disabled**. Its `cacheAllRoles` is a module-level `Map` written on every
  call with no TTL and no invalidation, so across Fargate tasks a revoked permission can stay honored
  indefinitely. Disqualifying for anything gating money.
- **Do not install** `@better-auth/sso`, `@better-auth/scim` or `@better-auth/stripe`. Four of the ten
  published 2026 advisories live in those plugins, including the only Critical one.
- Pin exact versions with floors at `>=1.4.17`, `>=1.6.14`, `>=1.6.22`. Treat the GHSA feed as a
  release-blocking signal.
- Generate Better Auth's `ac` object from the `role_permission` table at boot, with a startup equality
  assertion — one authority over "who can move money", not two that drift.

## 5. Workspaces are Rayi tables, not Better Auth teams

`teamMember` is `(id, teamId, userId, createdAt)` with **no role column**, and issue #2955 requesting
team-scoped roles was **closed as not planned**. Teams stay disabled.

`Workspace` + `WorkspaceMember`, with `WorkspaceMember.memberId` referencing `member.id` so "must be
an org member" is a foreign key and org removal cascades. Then the composite FKs in
[rayi-prisma-ledger](../rayi-prisma-ledger/SKILL.md) make same-org-on-both-sides a database invariant.

## 6. Authorization must survive the async hop

Money moves on a worker, possibly days after the request (a weekly sweep, a 7–14 day approval timer).
The approver may have been demoted or removed in between.

- **There is no forwarded user token and no signed assertion.** The `treasury_command` intent row *is*
  the assertion: durable, state-machined so it cannot be replayed, idempotency-keyed, audited.
- **The worker re-derives authorization from the database before any Stripe call** — re-reads
  membership and `MoneyAuthority`, asserts the approval count, re-derives the payload digest from
  current row state, and fails closed on any change.
- Enforce at the grant level too: `rayi_api` gets no INSERT on money job kinds and no UPDATE on
  approval state.

## 7. Creators are not organization members

Creators are a separate population — passwordless, consumer scale, and the party that **receives the
money**. Every brand-side control (step-up, maker-checker, role splits) protects brands only.

- A third principal branch in the guard, with no `:orgSlug`. Authorization by resource ownership in
  the loader's WHERE clause plus a permissive RLS policy. Exactly one of the org/creator GUCs is set
  per transaction.
- Creator reads go through a **column-restricted projection** — RLS filters rows, not columns, and the
  wave budget, internal review notes and other creators' rates must not be reachable.
- **Binding or changing a payout destination is a money-moving action.** Fresh re-authentication, hard
  rate limit, notification to the old *and* new channels, and a 72-hour payout hold afterwards. A
  hijacked creator session that redirects a bank account is stolen wages, and email OTP step-up is
  circular when the attacker holds the mailbox.
- Bind magic-link redemption to the originating browser. Otherwise a victim clicking an attacker's
  link is silently signed into the attacker's account.

## 8. Claims to verify before depending on them

- `role.authorize()` as a pure, exported, server-side evaluator is **undocumented**. Verify by test.
- A research pass once cited `GHSA-xg6x-h9c9-2m83`, `GHSA-fmh4-wcc4-5jm3` and `GHSA-99h5-pjcv-gr6v` —
  **none exist**. Treat any agent-reported CVE id or API name as a claim to check, not a fact.
