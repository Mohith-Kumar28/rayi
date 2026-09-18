import { describe, expect, it } from 'vitest';

import {
  ConditionType,
  evaluateCondition,
  isSatisfiableAtStart,
  type DealFacts,
  type MilestoneCondition,
} from './conditions.js';

/**
 * The condition catalogue.
 *
 * The two properties under test are the ones that are registry-level
 * requirements rather than features: **monotonicity** and **cumulative
 * counting**. Both are tested as properties over generated inputs, not as
 * examples, because an example test passes for the six conditions that exist
 * today and says nothing about the seventh.
 */

const NOW = new Date('2026-06-01T12:00:00Z');

function facts(overrides: Partial<DealFacts> = {}): DealFacts {
  return {
    approvedDeliverableIds: new Set(),
    totalDeliverables: 0,
    manuallyApprovedMilestoneIds: new Set(),
    now: NOW,
    ...overrides,
  };
}

/** Every condition type, with parameters that make each reachable. */
const ALL_CONDITIONS: MilestoneCondition[] = [
  { type: ConditionType.Advance },
  { type: ConditionType.DeliverablesApprovedCount, count: 3 },
  { type: ConditionType.SpecificDeliverablesApproved, deliverableIds: ['d1', 'd2'] },
  { type: ConditionType.AllDeliverablesApproved },
  { type: ConditionType.DateReached, at: '2026-06-15T00:00:00Z' },
  { type: ConditionType.ManualBrandApproval },
];

describe('EVERY condition is monotonic', () => {
  /**
   * Once true, true forever.
   *
   * Payout is final, so a milestone that becomes satisfied, releases, and then
   * becomes unsatisfied is an unrecoverable state: the money is gone and the
   * ledger says it should not have been. The engine must be unable to reach it.
   *
   * This is also what makes concurrent re-evaluation trivially safe — if truth
   * can only move one way, a stale evaluation can only ever be BEHIND, never
   * wrong.
   */
  it.each(ALL_CONDITIONS.map((condition) => [condition.type, condition] as const))(
    '%s stays satisfied as facts only ever grow',
    (_type, condition) => {
      // A monotonically increasing world: deliverables get approved, the
      // milestone gets manually approved, time moves forward. Nothing is ever
      // removed, because nothing in the real system removes an approval — a
      // review is VOIDED, which is a different deliverable state, not a
      // subtraction from this set.
      const timeline: DealFacts[] = [];
      const approved = new Set<string>();
      const manual = new Set<string>();

      for (let step = 0; step <= 6; step += 1) {
        if (step > 0) approved.add(`d${step}`);
        if (step === 4) manual.add('m1');

        timeline.push(
          facts({
            approvedDeliverableIds: new Set(approved),
            totalDeliverables: 5,
            manuallyApprovedMilestoneIds: new Set(manual),
            now: new Date(NOW.getTime() + step * 7 * 24 * 60 * 60 * 1000),
          }),
        );
      }

      let hasBeenSatisfied = false;
      for (const snapshot of timeline) {
        const verdict = evaluateCondition(condition, 'm1', snapshot);
        if (hasBeenSatisfied) {
          expect(
            verdict.satisfied,
            `${condition.type} went from satisfied back to unsatisfied`,
          ).toBe(true);
        }
        hasBeenSatisfied ||= verdict.satisfied;
      }
    },
  );

  it('is monotonic in the DELIVERABLE COUNT specifically', () => {
    const condition: MilestoneCondition = {
      type: ConditionType.DeliverablesApprovedCount,
      count: 3,
    };
    const approved = new Set<string>();
    let seen = false;

    for (let i = 1; i <= 10; i += 1) {
      approved.add(`d${i}`);
      const { satisfied } = evaluateCondition(
        condition,
        'm1',
        facts({ approvedDeliverableIds: new Set(approved) }),
      );
      if (seen) expect(satisfied).toBe(true);
      seen ||= satisfied;
    }
    expect(seen).toBe(true);
  });
});

describe('counting is CUMULATIVE, never incremental', () => {
  /**
   * `DELIVERABLES_APPROVED_COUNT` means "total approved across the deal >= N".
   *
   * Incremental counting would require remembering WHICH approvals were consumed
   * by which milestone, making evaluation order-dependent and non-idempotent —
   * re-running it would consume the same approvals again, or differently. Under
   * at-least-once job delivery that is a double payment.
   */
  it('a tranche schedule is 5 / 12 / 20, not 5 / 7 / 8', () => {
    const tranches = [5, 12, 20].map((count) => ({
      type: ConditionType.DeliverablesApprovedCount as const,
      count,
    }));

    const approved = new Set(Array.from({ length: 12 }, (_, i) => `d${i}`));
    const state = facts({ approvedDeliverableIds: approved });

    // 12 approved satisfies the 5 and the 12, not the 20.
    expect(tranches.map((c) => evaluateCondition(c, 'm', state).satisfied)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('is IDEMPOTENT — evaluating twice gives the same answer', () => {
    // The property that incremental counting would break.
    const condition = { type: ConditionType.DeliverablesApprovedCount as const, count: 2 };
    const state = facts({ approvedDeliverableIds: new Set(['a', 'b', 'c']) });

    const first = evaluateCondition(condition, 'm', state);
    const second = evaluateCondition(condition, 'm', state);
    expect(second).toEqual(first);
  });

  it('is ORDER-INDEPENDENT across milestones', () => {
    // Evaluating M3 before M1 must not change what M1 says.
    const state = facts({ approvedDeliverableIds: new Set(['a', 'b', 'c', 'd', 'e']) });
    const m1 = { type: ConditionType.DeliverablesApprovedCount as const, count: 2 };
    const m3 = { type: ConditionType.DeliverablesApprovedCount as const, count: 5 };

    const forwards = [
      evaluateCondition(m1, 'm1', state).satisfied,
      evaluateCondition(m3, 'm3', state).satisfied,
    ];
    const backwards = [
      evaluateCondition(m3, 'm3', state).satisfied,
      evaluateCondition(m1, 'm1', state).satisfied,
    ].reverse();

    expect(forwards).toEqual(backwards);
  });
});

describe('deliverables, never submissions', () => {
  it('counts a deliverable ONCE however many times it was approved', () => {
    // THE load-bearing constraint. A deliverable with two approved versions
    // would count twice and "N videos approved" would fire early — a silent
    // overpay. The type is a Set, so this is unrepresentable rather than merely
    // avoided, and the database enforces one live approved review per
    // deliverable.
    const approved = new Set(['d1']);
    approved.add('d1'); // a second approved submission on the same deliverable

    expect(
      evaluateCondition(
        { type: ConditionType.DeliverablesApprovedCount, count: 2 },
        'm',
        facts({ approvedDeliverableIds: approved }),
      ).satisfied,
    ).toBe(false);
  });
});

describe('each condition, specifically', () => {
  it('ADVANCE is satisfied against an empty deal', () => {
    expect(evaluateCondition({ type: ConditionType.Advance }, 'm', facts()).satisfied).toBe(true);
  });

  it('SPECIFIC_DELIVERABLES_APPROVED needs all of them', () => {
    const condition: MilestoneCondition = {
      type: ConditionType.SpecificDeliverablesApproved,
      deliverableIds: ['a', 'b'],
    };
    expect(
      evaluateCondition(condition, 'm', facts({ approvedDeliverableIds: new Set(['a']) }))
        .satisfied,
    ).toBe(false);
    expect(
      evaluateCondition(condition, 'm', facts({ approvedDeliverableIds: new Set(['a', 'b']) }))
        .satisfied,
    ).toBe(true);
  });

  it('SPECIFIC_DELIVERABLES_APPROVED is not satisfied by OTHER deliverables', () => {
    // Approving five unrelated videos must not unlock a milestone tied to two
    // named ones.
    expect(
      evaluateCondition(
        { type: ConditionType.SpecificDeliverablesApproved, deliverableIds: ['a', 'b'] },
        'm',
        facts({ approvedDeliverableIds: new Set(['x', 'y', 'z', 'p', 'q']) }),
      ).satisfied,
    ).toBe(false);
  });

  it('ALL_DELIVERABLES_APPROVED is NOT satisfied by an empty deal', () => {
    // Treating the empty case as satisfied would make this an advance in
    // disguise — and one the authoring-time disclosure would not catch, because
    // the condition does not look like one.
    expect(
      evaluateCondition({ type: ConditionType.AllDeliverablesApproved }, 'm', facts()).satisfied,
    ).toBe(false);
  });

  it('ALL_DELIVERABLES_APPROVED needs every one', () => {
    const condition: MilestoneCondition = { type: ConditionType.AllDeliverablesApproved };
    expect(
      evaluateCondition(
        condition,
        'm',
        facts({ totalDeliverables: 3, approvedDeliverableIds: new Set(['a', 'b']) }),
      ).satisfied,
    ).toBe(false);
    expect(
      evaluateCondition(
        condition,
        'm',
        facts({ totalDeliverables: 3, approvedDeliverableIds: new Set(['a', 'b', 'c']) }),
      ).satisfied,
    ).toBe(true);
  });

  it('DATE_REACHED honours the injected clock', () => {
    const condition: MilestoneCondition = {
      type: ConditionType.DateReached,
      at: '2026-06-15T00:00:00Z',
    };
    expect(evaluateCondition(condition, 'm', facts()).satisfied).toBe(false);
    expect(
      evaluateCondition(condition, 'm', facts({ now: new Date('2026-06-15T00:00:00Z') })).satisfied,
    ).toBe(true);
  });

  it('DATE_REACHED with an unparseable date is NOT satisfied', () => {
    // Failing the other way would release money on a typo.
    expect(
      evaluateCondition({ type: ConditionType.DateReached, at: 'soon' }, 'm', facts()).satisfied,
    ).toBe(false);
  });

  it('MANUAL_BRAND_APPROVAL is per MILESTONE, not per deal', () => {
    const state = facts({ manuallyApprovedMilestoneIds: new Set(['m1']) });
    expect(
      evaluateCondition({ type: ConditionType.ManualBrandApproval }, 'm1', state).satisfied,
    ).toBe(true);
    // Approving one milestone must not unlock another.
    expect(
      evaluateCondition({ type: ConditionType.ManualBrandApproval }, 'm2', state).satisfied,
    ).toBe(false);
  });

  it('throws on an unknown condition rather than evaluating it as satisfied', () => {
    // A new type nobody taught the engine about must not silently release money.
    expect(() =>
      evaluateCondition({ type: 'SOMETHING_NEW' } as never, 'm', facts()),
    ).toThrow(/Unhandled milestone condition/);
  });
});

describe('every verdict explains itself in a sentence a creator can act on', () => {
  it.each(ALL_CONDITIONS.map((condition) => [condition.type, condition] as const))(
    '%s gives a usable reason both ways',
    (_type, condition) => {
      // The same string is shown to the creator, shown to the brand as a
      // preview, and stored as evidence on the release. One source, so the UI
      // cannot promise what the engine will not do.
      for (const state of [
        facts(),
        facts({
          approvedDeliverableIds: new Set(['d1', 'd2', 'd3', 'd4', 'd5']),
          totalDeliverables: 5,
          manuallyApprovedMilestoneIds: new Set(['m1']),
          now: new Date('2027-01-01T00:00:00Z'),
        }),
      ]) {
        const { reason } = evaluateCondition(condition, 'm1', state);
        expect(reason.length).toBeGreaterThan(10);
        expect(reason.endsWith('.')).toBe(true);
        // No identifiers leaking into copy a human reads.
        expect(reason).not.toMatch(/\b(d\d|m\d|undefined|null|NaN)\b/);
      }
    },
  );
});

describe('the advance disclosure is DERIVED, not declared', () => {
  it('flags an explicit ADVANCE', () => {
    expect(isSatisfiableAtStart({ type: ConditionType.Advance }, NOW)).toBe(true);
  });

  it('flags a zero COUNT, which is an advance wearing a different hat', () => {
    // A brand cannot sidestep the warning by expressing the same thing another
    // way. This is the whole reason the check is derived.
    expect(
      isSatisfiableAtStart({ type: ConditionType.DeliverablesApprovedCount, count: 0 }, NOW),
    ).toBe(true);
  });

  it('flags a DATE in the past', () => {
    expect(
      isSatisfiableAtStart({ type: ConditionType.DateReached, at: '2020-01-01T00:00:00Z' }, NOW),
    ).toBe(true);
  });

  it('flags an EMPTY specific-deliverables list', () => {
    // "All of nothing" is vacuously true, and would pay immediately.
    expect(
      isSatisfiableAtStart(
        { type: ConditionType.SpecificDeliverablesApproved, deliverableIds: [] },
        NOW,
      ),
    ).toBe(true);
  });

  it('does NOT flag conditions that need real work', () => {
    expect(
      isSatisfiableAtStart({ type: ConditionType.DeliverablesApprovedCount, count: 1 }, NOW),
    ).toBe(false);
    expect(isSatisfiableAtStart({ type: ConditionType.AllDeliverablesApproved }, NOW)).toBe(false);
    expect(isSatisfiableAtStart({ type: ConditionType.ManualBrandApproval }, NOW)).toBe(false);
    expect(
      isSatisfiableAtStart({ type: ConditionType.DateReached, at: '2030-01-01T00:00:00Z' }, NOW),
    ).toBe(false);
  });
});
