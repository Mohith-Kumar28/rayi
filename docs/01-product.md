# Rayi — the product

> Name: **Rayi** (Sanskrit for wealth, pronounced *ray-ee*). Supersedes the CreatorPay doc (v1).
> Source of this document: the founder's master strategy doc, August 2026.

**One-liner:** trusted payment and transaction infrastructure for the creator economy, starting with
high-volume TikTok Shop creator transactions.

**The thesis:** every creator collab is a two-sided trust problem — brands fear paying before
delivery, creators fear delivering before payment — wrapped inside a finance bottleneck, because
every payment is a procurement event. Rayi solves both with a conditional-payment rail: the brand
deposits once, milestones get verified, funds auto-release, the creator is paid in minutes. Rayi is
the software, the ledger and the trust layer. **Stripe holds and moves the money.** Rayi never
custodies funds, never touches keys, and never uses the word *escrow*.

---

## The problem

**Brands** pay before seeing work or fight over delivery; track hundreds or thousands of videos in
spreadsheets; route every payment through finance approval while creators go cold; and carry vendor
sprawl — each creator is a vendor record plus a tax form plus a payment run.

**Creators** work first then chase invoices for weeks with zero leverage; face endless revision abuse
with no defined endpoint; and lose a large share of small cross-border payments to fees.

Industry data for external use: 87% of creators have been paid late or hit a payment issue
(Campaign 2025, citing Tipalti and Lumanu); 48% were paid late this year (Lumanu, 500+ creators);
delays now routinely reach 120 days (Gigapay 2026); 85% say the payment experience decides whether
they work with a brand again.

Structural context: US TikTok Shop GMV was $15.1B in 2025 (up 68%) and $11.8B in H1 2026 (up 103%);
video content drove 40.4% of US TikTok Shop GMV in H1 2026; ~1.35M US TikTok Shop stores, of which
5,700 cleared $1M and 506 cleared $10M.

## The Delta-4 test

| Side | Old way | New way |
| --- | --- | --- |
| Creator | Do the work, invoice, chase, hope | Money locked before filming, paid in minutes after the milestone |
| Brand (marketing) | Wait days for finance approval; the trend dies | Finance approves one budget once; marketing spends at the speed of DMs |
| Brand (finance) | 200 creators = 200 vendor records, transfers, tax forms | One vendor, one invoice, one ACH debit, one ERP line |

> **The honest asymmetry:** the creator delta is automatic; the brand delta must be *manufactured*
> through finance-ops relief. If the brand delta is only "the creator is safer", they will not adopt.
> The product lives or dies on **"200 vendors become 1."**

## Two motions, one rail

| Motion | Ticket | Fee | Purpose |
| --- | --- | --- | --- |
| **Creator payment link** — creator sends a protected link, brand deposits, no account needed | ~$300+ collabs | 5%, min $5 | The viral unit. Acquisition |
| **Brand campaign dashboard** — brand funds a wave, runs 100–1,000 videos | $5–50 per video | 3%, charged on top | Monetisation. Retention |

Rule: no creator makes a brand jump through hoops over a $15 video. Small tickets flow brand-led;
creator links win at $300+ collabs.

## Product principles

These are the soul of the product. Designs must honour them.

- **Nobody signs up. The transaction creates the account.** Both sides arrive because money is
  moving; the account is the residue. Each side's first screen shows the *other* side's money, never
  a product pitch.
- **The signature moment:** the creator posts, and before she closes TikTok her phone buzzes —
  *"$150 released, verified live."* She did not invoice, did not ask, did not wait. Engineering
  priority is shrinking the gap between *posted* and *buzz*.
- **For creators, the notification layer IS the product.** A creator who never opens the app but gets
  a text saying money moved is fully satisfied. Design notifications first.
- **For brands, the review queue IS the product.** Three seconds per row: thumbnail, automated checks
  already computed and shown as passed, one countdown, one primary button, keyboard shortcuts, bulk
  approve. The goal state is an **empty queue**, and the product should celebrate reaching it.
- **Handles are the growth surface.** `rayi.com/@maya` in a TikTok bio; every brand who visits is
  passive acquisition.
- **Reputation is visible both ways.** "On time 47/47" for creators, "pays in 3 days" for brands.
- Status over interface (the amount is always the largest thing on screen) · exceptions over lists ·
  timers visible to both parties · **trust language, never finance language** · zero states show
  money, never emptiness · earning is instant, banking is scheduled.
- **Do not rebuild what Stripe gives you.** Express hosted onboarding covers identity, documents and
  bank collection. Every hour not spent rebuilding KYC goes into the verification engine — the only
  genuinely proprietary part.

## Pricing and unit economics

**The fee is charged to the brand, on top of the creator budget.** A 100-video campaign at $50 is a
$5,000 creator budget plus a $150 platform fee: the brand deposits $5,150 and every creator receives
their full $50.

Why the brand: a creator's status quo is free (invoice, bank transfer), so any deduction reads as a
tax. A brand's status quo is expensive (Insense 7–20%, agencies 15–20%), so 3% reads as cheap.
Charging creators also taxes the growth engine — they simply raise rates, so the brand pays anyway
and Rayi takes the reputational cost for nothing.

| Fee | Amount | Paid by |
| --- | --- | --- |
| Campaign transaction fee | 3% standard; 5% on links and campaigns under $2,000 | Brand |
| Small-payment floor | max(fee, $5) on standalone links | Brand |
| Instant payout | 1%, min $0.50 | Creator, optional |
| Weekly sweep | Free | — |
| Brand SaaS | $99–499/mo | Brand |

Break-even is ~$110 per payment at 3% batched, ~$50 at 5%. With the $5 floor, no payment anywhere on
the curve loses money. **Batching is what makes small payments possible:** twenty $25 releases paid
individually cost ~$5.26 in payout fees; swept weekly as one $500 payout they cost ~$1.50.

## Market

Bottom-up from creator tiers: 30K top creators at $150K, 200K mid at $25K, 1M micro at $2.5K, 3M nano
at $200 → **~$12.6B** of US brand→creator payments, reconciling within 3% of eMarketer's independent
$10.52B for 2025. Adding UGC production and creator services takes US addressable flow to ~$15–16B.
Globally ~$33–38B, reaching $60–70B by 2030.

**Deliberately excluded as captive:** TikTok Shop affiliate commissions, Amazon/LTK commissions,
YouTube ad share. These are paid natively by the platforms and no third-party rail can intercept
them. Volunteering this exclusion in a pitch is the strongest credibility signal available.

**A credible year one is $30–80M GMV.** $1B in 12 months is not achievable through TikTok Shop — the
entire US TikTok Shop brand→creator content market is $2–4B.

## Competition and the gap

| Category | Players | Their model | What we exploit |
| --- | --- | --- | --- |
| UGC marketplaces | Billo, Insense, Influee, JoinBrands | Discovery + workflow, escrow as a feature, 7–20% | Brands with existing creator relationships need the payment layer alone, cheaper |
| Freelance marketplaces | Fiverr, Upwork | 10–25% take | Not built for 1,000-video campaigns at $5 each |
| Payout infrastructure | Trolley, Tipalti, Hyperwallet | Mass payouts + tax | No hold/verify/dispute layer. Vendors, not competitors |

**The unsolved gap:** a purpose-built, milestone-verified, TikTok-native conditional-payment rail for
high-volume low-ticket campaigns — the transaction trust layer, unbundled from discovery.

## Regulatory position

- **Money transmission:** holding brand money in Rayi's own accounts would presumptively make Rayi a
  money transmitter — FinCEN registration plus up to 49 state licences. Fatal.
- **Escrow:** holding funds as a neutral third party pending a condition triggers state escrow
  licensing. *Calling* the product escrow can itself trigger classification.
- **The structure that works:** at no point do customer funds sit in anything Rayi controls, so the
  money-transmission analysis has nothing to attach to. Agent-of-payee language stays in creator
  contracts as belt and braces, not as the load-bearing argument.

**Language rules.** Use: campaign funds, secured, payment protection, milestone-based payments,
release. **Never:** escrow, customer-facing wallet, "we hold your money", crypto jargon.

**Corporate structure:** a US entity (likely Delaware C-Corp) owns all payment flows, contracts and
the Stripe relationship. The India entity is a subsidiary employing the team on a transfer-pricing
basis. Running payments through India would require RBI authorisation as a Payment Aggregator
Cross-Border (₹15cr net worth rising to ₹25cr), route dollars through India and back for two US
parties, and buy nothing — US money transmission law applies based on where the customers are.

## Roadmap phases (business)

- **Phase 1, months 0–6:** fiat-only, all-Stripe MVP. ACH and wire. Creator links + brand dashboard.
  Milestone engine, dispute console, double-entry ledger, weekly sweeps. Not built: crypto, Trolley,
  custody, cards, international payouts.
- **Phase 2, ~$10M GMV:** Trolley for international payouts and W-8/1042-S. Abstracted USDC via
  Bridge. Instagram and YouTube UGC. Formal AML programme.
- **Phase 3, ~$100M GMV:** second acquiring provider, dedicated fraud tooling, creator trust scores
  (the data moat and pre-marketplace asset).
- **Phase 4, $1B+ GMV:** direct bank partnerships, selective licences, negotiated FX, treasury on
  float. The strategic fork: become the marketplace, or remain the rail every marketplace runs on.

## Known blind spots

- **Payout equals finality.** No clawing money back from a creator's bank. Verify before release,
  hold fraud reserves, never design around post-payout recovery.
- **Provider concentration.** All-Stripe means a Stripe risk review pauses the entire company. Add a
  second acquiring rail before $100M GMV, not after an outage.
- **Link conversion risk.** Removing cards costs some first payments from unfamiliar brands. Watch
  link funding conversion in the pilot; the fix is cards with the fee surcharged, not abandoning the
  policy.
- **CFO resistance to prepaid balances.** Fallback is a post-pay invoicing tier for enterprise.
- **Launch discipline.** 20–30 trusted creators first. Payments products do not get a second first
  impression.
- **Name conflict.** `rayi.co.in` is a live Indian fintech using the same Sanskrit wealth story. US
  Class 36 clearance first.
