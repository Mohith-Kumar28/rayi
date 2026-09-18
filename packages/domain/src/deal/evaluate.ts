import { Money } from '../money/money.js';
import {
  evaluateCondition,
  type DealFacts,
  type MilestoneCondition,
  type Verdict,
} from './conditions.js';

/**
 * Milestone evaluation.
 *
 * **Evaluation and release are separate, and that separation is what makes this
 * testable.** `evaluateDeal` is pure, total and side-effect-free: it answers
 * "which milestones are now satisfied" and nothing else. Releasing is a
 * different, transactional, idempotent step.
 *
 * The consequence worth stating: a bug in this function produces a wrong LIST,
 * not a wrong transfer. The release step re-checks under a row lock and inserts
 * a `milestone_release` row whose `UNIQUE(milestone_id)` is the at-most-once
 * guarantee, so even a badly wrong list cannot pay twice.
 *
 * The clock is INJECTED. `new Date()` inside an engine that decides when money
 * moves makes every test about timing flaky and makes replaying a past decision
 * impossible — and replaying a past decision is exactly what a dispute requires.
 */

export interface MilestoneInput {
  readonly id: string;
  readonly condition: MilestoneCondition;
  /**
   * Resolved minor units, frozen at acceptance.
   *
   * A percentage is AUTHORING INPUT, never the authoritative value. If
   * percentages were re-evaluated at release time, amending a deal total would
   * silently change the amount of an ALREADY-RELEASED milestone — a retroactive
   * rewrite of money that has left.
   */
  readonly amountMinor: bigint;
  /** Set once released. A released milestone is never re-evaluated. */
  readonly releasedAt?: Date | null;
  /** Display order, and the order money is released in. */
  readonly sequence: number;
}

export interface MilestoneVerdict extends Verdict {
  readonly milestoneId: string;
  readonly amountMinor: bigint;
  /** True when satisfied AND not already released — i.e. money should move. */
  readonly shouldRelease: boolean;
  readonly alreadyReleased: boolean;
}

export interface DealEvaluation {
  readonly verdicts: readonly MilestoneVerdict[];
  /** The ones a release step should act on, in sequence order. */
  readonly toRelease: readonly MilestoneVerdict[];
  readonly totalToReleaseMinor: bigint;
  /** What the creator sees next. The first unsatisfied milestone, if any. */
  readonly nextUnlock: MilestoneVerdict | null;
}

/**
 * Evaluates every milestone on a deal.
 *
 * Returns verdicts for ALL of them, including released ones, because the same
 * result drives the creator's "what unlocks my next payment" view, the brand's
 * preview, and the evidence stored on a release. One function, one set of
 * sentences — so the UI cannot promise what the engine will not do.
 */
export function evaluateDeal(
  milestones: readonly MilestoneInput[],
  facts: DealFacts,
): DealEvaluation {
  const ordered = [...milestones].sort((a, b) => a.sequence - b.sequence);

  const verdicts: MilestoneVerdict[] = ordered.map((milestone) => {
    const alreadyReleased = milestone.releasedAt != null;

    if (alreadyReleased) {
      // A released milestone is never re-evaluated. Its condition may no longer
      // read as satisfied — a deliverable could be cancelled afterwards — and
      // re-deriving `satisfied: false` for money that has already left would be
      // the engine contradicting the ledger.
      return {
        milestoneId: milestone.id,
        amountMinor: milestone.amountMinor,
        satisfied: true,
        reason: 'Already paid.',
        shouldRelease: false,
        alreadyReleased: true,
      };
    }

    const verdict = evaluateCondition(milestone.condition, milestone.id, facts);

    return {
      milestoneId: milestone.id,
      amountMinor: milestone.amountMinor,
      satisfied: verdict.satisfied,
      reason: verdict.reason,
      shouldRelease: verdict.satisfied,
      alreadyReleased: false,
    };
  });

  const toRelease = verdicts.filter((verdict) => verdict.shouldRelease);

  return {
    verdicts,
    toRelease,
    totalToReleaseMinor: toRelease.reduce((total, verdict) => total + verdict.amountMinor, 0n),
    // The first thing still outstanding. Not "the next in sequence" — a later
    // milestone can be satisfied while an earlier one is not (a date-based one
    // passing before the videos are in), and the creator wants to know what is
    // actually blocking them.
    nextUnlock: verdicts.find((verdict) => !verdict.satisfied) ?? null,
  };
}

export class MilestoneAmountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MilestoneAmountsError';
  }
}

/**
 * Resolves authored milestone amounts into frozen minor units.
 *
 * Run ONCE, at deal acceptance. After this the percentages are kept for display
 * and for authoring the next version only — never re-evaluated, because
 * re-evaluating them means an amendment can rewrite the amount of a milestone
 * that has already been paid.
 *
 * The remainder rule is largest-remainder with ties to the EARLIEST milestone,
 * matching `Money.allocate`. Every odd cent is distributed; nothing is dropped
 * and nothing is invented, so the frozen amounts sum to the deal total exactly.
 */
export function resolveMilestoneAmounts(
  authored: ReadonlyArray<
    | { readonly sequence: number; readonly kind: 'fixed'; readonly amountMinor: bigint }
    | { readonly sequence: number; readonly kind: 'percentage'; readonly basisPoints: number }
  >,
  total: Money,
): Map<number, bigint> {
  if (authored.length === 0) {
    throw new MilestoneAmountsError('A deal needs at least one milestone.');
  }

  const fixedTotal = authored.reduce(
    (sum, entry) => (entry.kind === 'fixed' ? sum + entry.amountMinor : sum),
    0n,
  );

  if (fixedTotal > total.amountMinor) {
    throw new MilestoneAmountsError(
      `Fixed milestone amounts total ${fixedTotal}, which is more than the deal total ${total.amountMinor}.`,
    );
  }

  const percentageEntries = authored.filter(
    (entry): entry is Extract<(typeof authored)[number], { kind: 'percentage' }> =>
      entry.kind === 'percentage',
  );

  const resolved = new Map<number, bigint>();

  if (percentageEntries.length === 0) {
    if (fixedTotal !== total.amountMinor) {
      throw new MilestoneAmountsError(
        `Milestone amounts total ${fixedTotal} but the deal is ${total.amountMinor}. ` +
          `They must be equal — an unallocated remainder is money nobody has decided about.`,
      );
    }
    for (const entry of authored) {
      if (entry.kind === 'fixed') resolved.set(entry.sequence, entry.amountMinor);
    }
    return resolved;
  }

  const basisPointsTotal = percentageEntries.reduce((sum, entry) => sum + entry.basisPoints, 0);
  if (basisPointsTotal !== 10_000) {
    throw new MilestoneAmountsError(
      `Percentage milestones total ${basisPointsTotal / 100}%, not 100%. ` +
        `A deal with an unallocated share is a deal where the remainder belongs to nobody.`,
    );
  }

  // Percentages apply to what is LEFT after the fixed amounts, so a deal can mix
  // "$500 advance, then 100% of the rest split three ways" without the
  // percentages silently meaning something other than what was written.
  const remainder = Money.of(total.amountMinor - fixedTotal, total.currency);

  // `allocate` is the largest-remainder split that loses no cent. Doing this by
  // multiplying and rounding each share independently is how a total ends up a
  // cent short, and the deal-total constraint then rejects an otherwise valid
  // agreement for a reason nobody can find.
  const shares = remainder.allocate(
    percentageEntries.map((entry) => BigInt(entry.basisPoints)),
  );

  for (const entry of authored) {
    if (entry.kind === 'fixed') resolved.set(entry.sequence, entry.amountMinor);
  }
  percentageEntries.forEach((entry, index) => {
    resolved.set(entry.sequence, shares[index]!.amountMinor);
  });

  const resolvedTotal = [...resolved.values()].reduce((sum, amount) => sum + amount, 0n);
  if (resolvedTotal !== total.amountMinor) {
    // Unreachable if `allocate` is correct. Asserted anyway, because the thing
    // it guards is "the milestones sum to the deal" and a silent failure there
    // is money that is promised twice or not at all.
    throw new MilestoneAmountsError(
      `Resolved milestone amounts total ${resolvedTotal}, expected ${total.amountMinor}.`,
    );
  }

  return resolved;
}
