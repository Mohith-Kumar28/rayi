/**
 * The milestone condition catalogue.
 *
 * A CLOSED, parameterized set — not a rule engine. "Brand-authored milestones"
 * sounds like it needs user-supplied logic, and it does not: a general engine
 * here would be a security and auditability hazard, because the thing it decides
 * is when money leaves.
 *
 * `MANUAL_BRAND_APPROVAL` is the escape hatch that removes the pressure to build
 * one. A brand with an uncatalogued condition can always express it as "I will
 * approve this myself", which keeps the catalogue small without making the
 * product rigid.
 *
 * ---
 *
 * **Two properties every condition MUST have.** They are registry-level
 * requirements for anything added later, not coincidences of the current six.
 *
 * **1. MONOTONIC — once true, true forever.**
 *
 * Payout is final. A milestone that becomes satisfied, releases, and then
 * becomes unsatisfied is an unrecoverable state: the money is gone and the
 * ledger says it should not have been. The engine must be unable to reach it.
 *
 * This is also what makes concurrent re-evaluation trivially safe. If truth can
 * only move one way, two evaluators racing cannot disagree about the direction,
 * and a stale evaluation can only ever be *behind*, never wrong.
 *
 * **2. COUNTING IS CUMULATIVE, never incremental.**
 *
 * `DELIVERABLES_APPROVED_COUNT` means "total approved across the deal >= N", so
 * a tranche schedule is M1(5), M2(12), M3(20) — not M1(5), M2(7), M3(8).
 *
 * Incremental counting would require remembering WHICH approvals were consumed
 * by which milestone, which makes evaluation order-dependent and non-idempotent:
 * re-running it would consume the same approvals again, or differently. Under
 * at-least-once job delivery that is a double payment.
 */

export const ConditionType = {
  /**
   * Satisfied immediately. An advance.
   *
   * Deliberately NOT a separate entity or a flag on the milestone. An advance is
   * a milestone whose condition is trivially true, so there is no parallel code
   * path and no second release mechanism to keep correct.
   *
   * What stays is the DISCLOSURE, not the type: the UI evaluates every condition
   * against an empty deal at authoring time, and anything satisfiable at t=0 is
   * money that leaves before work exists. That property is DERIVED, so a brand
   * cannot sidestep the warning by expressing the same thing a different way —
   * `DELIVERABLES_APPROVED_COUNT` with `count: 0` is an advance and is caught by
   * exactly the same check.
   */
  Advance: 'ADVANCE',

  /** Total deliverables approved across the deal reaches `count`. Cumulative. */
  DeliverablesApprovedCount: 'DELIVERABLES_APPROVED_COUNT',

  /** These specific deliverables are all approved. */
  SpecificDeliverablesApproved: 'SPECIFIC_DELIVERABLES_APPROVED',

  /** Every deliverable on the deal is approved. */
  AllDeliverablesApproved: 'ALL_DELIVERABLES_APPROVED',

  /** A date passes. Monotonic because time is. */
  DateReached: 'DATE_REACHED',

  /**
   * The brand says so. The escape hatch that removes the pressure to build a
   * DSL — and monotonic because the approval, once given, is recorded.
   */
  ManualBrandApproval: 'MANUAL_BRAND_APPROVAL',
} as const;

export type ConditionType = (typeof ConditionType)[keyof typeof ConditionType];

export type MilestoneCondition =
  | { readonly type: typeof ConditionType.Advance }
  | { readonly type: typeof ConditionType.DeliverablesApprovedCount; readonly count: number }
  | {
      readonly type: typeof ConditionType.SpecificDeliverablesApproved;
      readonly deliverableIds: readonly string[];
    }
  | { readonly type: typeof ConditionType.AllDeliverablesApproved }
  | { readonly type: typeof ConditionType.DateReached; readonly at: string }
  | { readonly type: typeof ConditionType.ManualBrandApproval };

/**
 * Everything the engine is allowed to know about a deal.
 *
 * Deliberately narrow. A condition that could see the whole deal could depend on
 * something that moves backwards — an unapproved submission, a cancelled
 * deliverable — and monotonicity would stop being a property of the catalogue
 * and start being a property of whoever wrote the last condition.
 */
export interface DealFacts {
  /**
   * Deliverables in state APPROVED.
   *
   * **Deliverables, never submissions.** THE load-bearing constraint on this
   * whole surface: a deliverable with two approved versions would count twice,
   * and "N videos approved" would fire early — a silent overpay. The database
   * enforces at most one live approved review per deliverable; this type is the
   * reminder of why.
   */
  readonly approvedDeliverableIds: ReadonlySet<string>;

  /** Every deliverable on the deal, approved or not. */
  readonly totalDeliverables: number;

  /** Milestone ids the brand has manually approved. */
  readonly manuallyApprovedMilestoneIds: ReadonlySet<string>;

  /** Injected, never `new Date()` inside the engine. See `evaluateDeal`. */
  readonly now: Date;
}

/** Why a condition is or is not satisfied, in words a creator can act on. */
export interface Verdict {
  readonly satisfied: boolean;
  /**
   * A complete sentence, written for the CREATOR.
   *
   * The same string is shown to the creator ("what unlocks my next payment"),
   * shown to the brand as a preview, and stored as evidence on the release. One
   * source, so the UI can never promise what the engine will not do.
   */
  readonly reason: string;
}

/**
 * Evaluates one condition. Pure, total, and side-effect-free.
 *
 * `milestoneId` is needed only by `MANUAL_BRAND_APPROVAL`; it is passed to every
 * condition so the signature does not vary by type, which is what lets the
 * registry stay a plain lookup.
 */
export function evaluateCondition(
  condition: MilestoneCondition,
  milestoneId: string,
  facts: DealFacts,
): Verdict {
  switch (condition.type) {
    case ConditionType.Advance:
      return { satisfied: true, reason: 'Paid up front, before any work is delivered.' };

    case ConditionType.DeliverablesApprovedCount: {
      // CUMULATIVE: total approved across the whole deal, not "since the last
      // milestone". See the note at the top of this file.
      const approved = facts.approvedDeliverableIds.size;
      const remaining = Math.max(0, condition.count - approved);
      return {
        satisfied: approved >= condition.count,
        reason:
          remaining === 0
            ? `${condition.count} approved — this is unlocked.`
            : `${remaining} more ${remaining === 1 ? 'video needs' : 'videos need'} to be approved (${approved} of ${condition.count} so far).`,
      };
    }

    case ConditionType.SpecificDeliverablesApproved: {
      const outstanding = condition.deliverableIds.filter(
        (id) => !facts.approvedDeliverableIds.has(id),
      );
      return {
        satisfied: outstanding.length === 0,
        reason:
          outstanding.length === 0
            ? 'Every video for this milestone is approved.'
            : `${outstanding.length} specific ${outstanding.length === 1 ? 'video is' : 'videos are'} still waiting for approval.`,
      };
    }

    case ConditionType.AllDeliverablesApproved: {
      // A deal with NO deliverables is not "all approved" — it is a deal where
      // no work was ever agreed. Treating the empty case as satisfied would make
      // this an advance in disguise, and one the authoring-time disclosure would
      // not catch because the condition does not look like one.
      if (facts.totalDeliverables === 0) {
        return { satisfied: false, reason: 'No videos have been agreed for this deal yet.' };
      }
      const remaining = facts.totalDeliverables - facts.approvedDeliverableIds.size;
      return {
        satisfied: remaining <= 0,
        reason:
          remaining <= 0
            ? 'Every video on this deal is approved.'
            : `${remaining} of ${facts.totalDeliverables} ${remaining === 1 ? 'video is' : 'videos are'} still waiting for approval.`,
      };
    }

    case ConditionType.DateReached: {
      const at = new Date(condition.at);
      if (Number.isNaN(at.getTime())) {
        // An unparseable date is NOT satisfied. Failing the other way would
        // release money on a typo.
        return { satisfied: false, reason: 'This milestone has an invalid date and cannot unlock.' };
      }
      const reached = facts.now.getTime() >= at.getTime();
      return {
        satisfied: reached,
        reason: reached
          ? 'The agreed date has passed.'
          : `Unlocks on ${at.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}.`,
      };
    }

    case ConditionType.ManualBrandApproval: {
      const approved = facts.manuallyApprovedMilestoneIds.has(milestoneId);
      return {
        satisfied: approved,
        reason: approved
          ? 'The brand approved this milestone directly.'
          : 'Waiting for the brand to approve this milestone directly.',
      };
    }

    default: {
      // A new condition type that nobody taught the engine about must NOT
      // silently evaluate as satisfied. The `never` makes it a compile error
      // first; this is the runtime backstop.
      const exhaustive: never = condition;
      throw new Error(`Unhandled milestone condition: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Whether a condition is satisfiable against an EMPTY deal.
 *
 * This is the advance disclosure, and it is derived rather than declared. A
 * brand cannot sidestep the warning by expressing an advance a different way:
 * `{ type: 'DELIVERABLES_APPROVED_COUNT', count: 0 }` is an advance, and so is a
 * `DATE_REACHED` in the past, and both are caught here.
 *
 * Money that can leave before work exists cannot be recovered, so the UI shows
 * the warning and takes explicit consent. There is deliberately no CAP — the
 * amount is the brand's call.
 */
export function isSatisfiableAtStart(condition: MilestoneCondition, now: Date): boolean {
  return evaluateCondition(condition, '__disclosure__', {
    approvedDeliverableIds: new Set(),
    totalDeliverables: 0,
    manuallyApprovedMilestoneIds: new Set(),
    now,
  }).satisfied;
}
