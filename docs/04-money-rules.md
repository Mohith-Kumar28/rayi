# Money rules

**Read this before touching anything on the money path.**

Everything marked ✅ was verified directly against Stripe's documentation, not inferred. Several of
these contradict what seems obvious, and two of them correct the original strategy doc.

---

## The spine

**The balance is never a stored number that code can assign to.** There is no
`UPDATE ... SET balance = X` anywhere in the system.

- An **account IS the state of money.** No `status` column on a dollar, no mutable balance field. A
  dollar's state is the account it sits in, and legal transitions are a declared table validated by a
  constraint trigger.
- This collapses every *"X cannot exceed Y"* invariant into one rule: **account Y's balance cannot go
  negative.** Over-allocation, over-reservation, over-release and the workspace cap all become the
  same constraint.
- Allocating budget to a campaign is a **ledger entry**, not a field update.

## Solvency as a storage-engine error

```sql
CHECK (allow_negative OR balance_minor >= 0)
```

on a one-row-per-account balance table that every entry line must
`UPDATE ... SET balance_minor = balance_minor + :delta` inside the posting transaction.

The `UPDATE` takes the row lock implicitly, so concurrent writers to the same account serialize.
Under plain `READ COMMITTED`, Postgres re-evaluates the delta against the post-commit value
(EvalPlanQual), so the second writer computes the true balance and the CHECK aborts it.

**This removes the need for `SERIALIZABLE` and its 40001 retry storms.** Only the PSP clearing and
fraud-reserve accounts carry `allow_negative`.

## Mutable row vs append-only snapshot — resolved, not chosen

`UPDATE balance` and `INSERT snapshot` are **one SQL statement** — a CTE whose `RETURNING` feeds the
snapshot insert. They are the same number with two access patterns, and because `seq` and
`balance_after` come from the locked row's post-update values inside one statement, they agree by
construction. If the CHECK fires, the whole statement aborts: no snapshot, no line, no drift.

## Application code never writes a sign

Amounts are always **positive** `bigint` minor units; direction carries the sign. Two **generated**
columns derive it:

- `signed_minor` (debit +, credit −) — used *only* for the `SUM = 0` balanced-entry assertion
- `natural_minor` (movement in the account's own normal direction) — used *only* for balances

Every account then has a plain non-negative balance in its own terms, so the constraint is uniformly
`>= 0` and no reporting code ever negates anything. Sign confusion is the classic financial bug; this
makes it unrepresentable.

## Per-deposit lot accounts — a regulatory requirement

`org_funds_available` is **not one account**. It is a set of per-deposit **lot** accounts consumed
FIFO.

A single pooled account would make *"unallocated funds are refundable to the originating bank
account"* unenforceable — you would be refunding fungible pooled value to a destination, which is the
definition of the hosted wallet the strategy forbids. **That is a regulatory defect, not a
convenience trade-off.**

Lots also let an ACH return be attributed to the exact deposit returned, give Stripe's 2-year hold
limit a per-lot clock, and split what would otherwise be one hot contended row.

## Pending ACH lives in a separate memo account class

Never in a lot account. Allocation transitions are *declared* to debit `org_lot_available` only, so a
bug in allocation code **cannot reach** pending money — it would have to debit an account role no
allocation transition permits. Structural, not conditional, and far stronger than a
`deposits.status` column that one forgotten check bypasses.

---

## Verified Stripe behaviour

### ✅ Charge type: Separate Charges and Transfers

The only type supporting "collect once, split later to parties not yet known". It also gets the
statement descriptor right for free — for this type it comes from the **platform**, so brand bank
statements read `RAYI`.

**Do not use `on_behalf_of`** — it flips the descriptor to the connected account.

### ✅ Do NOT use `source_transaction`

The obvious design is to tie each transfer to its funding charge so it queues until funds clear.
Stripe explicitly warns against this for ACH:

> "Asynchronous payment methods, such as ACH, can fail after a subsequent transfer request is made.
> For these payments, avoid using `source_transaction`. Instead, wait until a `charge.succeeded`
> event is triggered before transferring the funds."

If used and the debit later returned, **Stripe would cover the transfer out of Rayi's own balance**.
Rule: **no transfer until `charge.succeeded`**, then transfer from available balance. Associate via
`transfer_group`, which is a label with no functional effect.

This also forces the platform payout schedule to **manual** — not only for the custody argument, but
because Stripe warns automatic payouts interfere with transfers lacking a `source_transaction`.

### ✅ An ACH return arrives as a DISPUTE, not a failure

The single most important correction. A post-settlement ACH failure arrives as
**`charge.dispute.created`** with reason `insufficient_funds` / `incorrect_account_details` /
`bank_cannot_process` — **not `charge.failed`**. Guards written against `charge.failed` are aimed at
an event that never fires.

- Make the ACH return a **first-class state** with its own handler, distinct from a customer dispute.
- Freeze the wave **outbound only** — never freeze ingestion. Freezing the clearing account would
  kill webhook processing during an incident and burn Stripe's 3-day retry window.
- Attempt `transferReversal` immediately while the destination still holds balance; fall through to
  the fraud reserve when it does not.

### ✅ Dispute windows differ by account type — but the field is attacker-controlled

**2 business days for a business account, 60 calendar days for a personal one** — a 30× difference.

⚠️ **Do not size the hold window from `account_holder_type`.** It is a value the payer selects in a
form. An attacker funds $250k from a personal account, picks "Company", and Stripe records `company`.
Require Financial Connections instant verification and derive the window from Stripe-observed
ownership data. **Default every lot to 61 calendar days**, shorten only on independent verification.

### ✅ Stripe does NOT support partial ACH refunds

Capability matrix: **`Refunds: ✗ Partial refunds · ✓ Full refunds · Submission window: 180 days`**.

Refund-to-origin is the load-bearing fact in the non-transmitter argument *and* in the withdrawal
policy promise that "unallocated funds are refundable anytime, self-serve, one click".

Concretely: a brand deposits $250,000 as one lot and allocates $50,000. **They cannot get $200,000
back.** Only a full $250,000 refund — which the allocated money makes impossible — or nothing.

Consequences:
1. **The lot model is the mitigation.** Fund in $10k increments and a partial refund becomes "refund
   these N whole lots".
2. **It constrains deposit UX** — nudge toward several smaller lots, trading against per-debit ACH cost.
3. **Confirm with Stripe in writing.** A Stripe support article contradicts the capability matrix, and
   two Stripe sources disagreeing is itself the risk. Ship a contract test calling
   `refunds.create({payment_intent, amount})` against a `us_bank_account` charge in test mode on every
   deploy.

### ✅ Other verified facts

- ACH settles **T+4** business days, **T+2** with faster settlement (opt-in, eligibility-gated). The
  UI must never claim "secured" on submit.
- **Two webhook endpoints, two signing secrets** — platform and Connect, with `Stripe-Account`
  routing. Otherwise `account.updated`, `payout.paid`, `payout.failed` and `transfer.reversed` have
  no reception path.
- Dispatch on the **refetched live object's** type and status, not the delivered event's. Order
  same-second events by `(created, event.id)`.
- US platform fund-holding limit is **2 years** — not the 90 days in the strategy doc.
- Use **hosted mandate collection** (Checkout / Payment Element) so Stripe auto-responds to bank
  proof-of-authorisation enquiries rather than Rayi answering each as a dispute.
- Stripe's own guidance blesses this pattern: *"platforms hold funds only when there's a clear purpose
  and a commitment to transfer them… when an event occurs or a precondition is satisfied."* Quote this
  to counsel.

---

## Never double-pay a creator

Four independent mechanisms failed in the same direction during review:

- an idempotency key in a React `useRef` is destroyed by a page refresh — the most common human
  response to a hung money action;
- Stripe prunes idempotency keys after ~24h, so the header cannot protect a DLQ replay or post-deploy
  retry;
- the idempotency interceptor released its claim on 5xx *after* the handler's transaction committed.

Payouts are final — this money is gone. The controls:

- **Deterministic keys derived from the intent** (`release:{deliverableId}:{version}`), carried in
  the typed request body, not a header and not client state. Identical across refreshes, tabs, devices.
- A `stripe_transfer(release_id UNIQUE, stripe_transfer_id, state)` row written in the same
  transaction as the release intent. The worker refuses to call Stripe when `stripe_transfer_id IS
  NOT NULL`, and writes the returned id before acknowledging.
- `release_id` in the Transfer's metadata; replays older than 24h reconcile against
  `transfers.list({destination, created})` matching on metadata, never on the key.
- A partial unique index on `(deliverable_id, 'RELEASED')` as the database backstop.
- **Bulk approve is a fan-out of N independently-keyed calls** — never one key for N movements.

## A transaction-purity guard

An `AsyncLocalStorage` guard that throws if any Stripe or notification call happens inside an open
ledger transaction. Roughly twenty lines, and it prevents the failure that actually costs money.

## Reconciliation is a product feature

Stripe's [Payout Reconciliation report](https://docs.stripe.com/reports/payout-reconciliation) is
itemised one row per `balance_transaction_id` with `gross`, `fee`, `net`, `available_on`,
`automatic_payout_id` and a `trace_id` matching the bank-side ACH trace number, ~12h SLA after UTC day
close.

- Model a `psp:stripe:clearing` account; every webhook posts an entry keyed on
  `balance_transaction_id`.
- Split it into `psp:stripe:pending` and `psp:stripe:available` keyed on `available_on` — without it
  the solvency invariant passes while `transfers.create` returns `balance_insufficient`, a failure
  with no modelled state.
- Weekly batched payouts are a **many-to-one** reconciliation: many creator postings summing to one
  Stripe payout.
- Drift pages a human and blocks releases against the affected deposit.

## Webhooks: store first, process later, don't trust the payload

Stripe does not guarantee order, retries for 3 days, and documents *irrecoverable* events where no
Event object is ever generated.

- The receiver does three things: verify the signature **against the raw body**, insert the raw event
  (unique on `event.id`), return 200.
- **Treat a webhook as a wake-up signal, not the update.** For anything money-moving, refetch
  authoritative state from the API.
- **Guard transitions against current state.** A `charge.succeeded` after `charge.failed` for the same
  charge is *parked and alerted*, never applied.
- DLQ with the original payload and headers, attempt count, final error, and a status. Alert on depth
  and oldest-event age. Replay at a controlled pace.

## Invariants to monitor continuously

Borrowed from Increase's automated invariant monitoring. Their principle: *"a flappy Check is worse
than no Check."* Six that are genuinely maintained beats sixteen that aren't.

- No released payment without an approved milestone-verification record
- No transfer without a settled deposit
- Every journal entry's lines sum to zero
- Every account's cached balance equals the sum of its entries
- The clearing account nets to zero after each settlement batch
- No wave holding unallocated funds past its horizon

**Every invariant ships with a test that deliberately breaks it** and asserts the alarm fires. EMF
metrics must go to a **Standard-class** log group (Infrequent Access produces no metric at all), and
every alarm needs `treat_missing_data = "breaching"` — a metric that *stops* being emitted is the
incident.
