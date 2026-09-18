# Migrations

## A trap that is live in this directory

Several migrations here were **hand-named with timestamps in the future** —
`20260918140000_ledger_account_derivation` onwards — while the wall clock was
around `20260918122300`. Prisma names generated migrations with the current
time, so **a newly generated migration sorts BEFORE the hand-named ones**.

That is not hypothetical. `20260918115934_campaign_domain` was written after
`20260918200000_row_level_security` and called `public.current_tenant()`, which
that later file creates. Applied in creation order it worked. Replayed in
filename order — which is what a fresh deploy does — it failed with
`function public.current_tenant() does not exist`.

## What catches it

Two things, and both already run:

- **`prisma migrate dev`** replays every migration into a shadow database from
  scratch. This is what found the bug above.
- **CI** starts an empty Postgres and runs `pnpm migrate:deploy`, so the whole
  chain is replayed on every push.

## The rule

A migration must be correct **replayed in filename order from an empty
database**, not just applied in the order it happened to be written. If a
migration depends on an object from another, either put them in one file or name
the dependent one so it genuinely sorts later.
