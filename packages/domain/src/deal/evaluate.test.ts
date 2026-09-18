import { describe, expect, it } from 'vitest';

import { Money } from '../money/money.js';
import { ConditionType, type DealFacts } from './conditions.js';
import {
  evaluateDeal,
  MilestoneAmountsError,
  resolveMilestoneAmounts,
  type MilestoneInput,
} from './evaluate.js';

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

/** "$100 for 20 videos", as a brand would actually author it. */
function typicalDeal(): MilestoneInput[] {
  return [
    {
      id: 'm-advance',
      sequence: 1,
      amountMinor: 2_000n,
      condition: { type: ConditionType.Advance },
    },
    {
      id: 'm-half',
      sequence: 2,
      amountMinor: 4_000n,
      condition: { type: ConditionType.DeliverablesApprovedCount, count: 10 },
    },
    {
      id: 'm-final',
      sequence: 3,
      amountMinor: 4_000n,
      condition: { type: ConditionType.DeliverablesApprovedCount, count: 20 },
    },
  ];
}

function approvedSet(count: number): Set<string> {
  return new Set(Array.from({ length: count }, (_, i) => `d${i}`));
}

describe('a typical deal, as it progresses', () => {
  it('unlocks only the advance at the start', () => {
    const result = evaluateDeal(typicalDeal(), facts({ totalDeliverables: 20 }));

    expect(result.toRelease.map((verdict) => verdict.milestoneId)).toEqual(['m-advance']);
    expect(result.totalToReleaseMinor).toBe(2_000n);
    expect(result.nextUnlock?.milestoneId).toBe('m-half');
  });

  it('unlocks the halfway milestone at ten approvals', () => {
    const result = evaluateDeal(
      typicalDeal(),
      facts({ totalDeliverables: 20, approvedDeliverableIds: approvedSet(10) }),
    );
    expect(result.toRelease.map((verdict) => verdict.milestoneId)).toEqual([
      'm-advance',
      'm-half',
    ]);
  });

  it('unlocks everything at twenty', () => {
    const result = evaluateDeal(
      typicalDeal(),
      facts({ totalDeliverables: 20, approvedDeliverableIds: approvedSet(20) }),
    );
    expect(result.toRelease).toHaveLength(3);
    expect(result.totalToReleaseMinor).toBe(10_000n);
    expect(result.nextUnlock).toBeNull();
  });

  it('returns them in SEQUENCE order regardless of input order', () => {
    const shuffled = [...typicalDeal()].reverse();
    const result = evaluateDeal(shuffled, facts({ totalDeliverables: 20 }));
    expect(result.verdicts.map((verdict) => verdict.milestoneId)).toEqual([
      'm-advance',
      'm-half',
      'm-final',
    ]);
  });
});

describe('a released milestone is never re-evaluated', () => {
  it('reports it as paid without consulting its condition', () => {
    // Its condition may no longer read as satisfied — a deliverable could be
    // cancelled afterwards — and re-deriving `satisfied: false` for money that
    // has already left would be the engine contradicting the ledger.
    const milestones: MilestoneInput[] = [
      {
        id: 'm1',
        sequence: 1,
        amountMinor: 5_000n,
        releasedAt: new Date('2026-05-01T00:00:00Z'),
        condition: { type: ConditionType.DeliverablesApprovedCount, count: 99 },
      },
    ];

    const [verdict] = evaluateDeal(milestones, facts()).verdicts;
    expect(verdict?.satisfied).toBe(true);
    expect(verdict?.alreadyReleased).toBe(true);
    expect(verdict?.shouldRelease).toBe(false);
  });

  it('excludes it from the release list, so a replay pays nothing', () => {
    // The engine's half of at-most-once. The database half is
    // `UNIQUE(milestone_id)` on the release row.
    const milestones = typicalDeal().map((milestone) =>
      milestone.id === 'm-advance' ? { ...milestone, releasedAt: NOW } : milestone,
    );

    const result = evaluateDeal(milestones, facts({ totalDeliverables: 20 }));
    expect(result.toRelease).toHaveLength(0);
    expect(result.totalToReleaseMinor).toBe(0n);
  });
});

describe('nextUnlock is what is actually blocking the creator', () => {
  it('is the first UNSATISFIED milestone, not the next in sequence', () => {
    // A later date-based milestone can pass before the videos are in. The
    // creator wants to know what is blocking them, not what comes next on paper.
    const milestones: MilestoneInput[] = [
      {
        id: 'm-videos',
        sequence: 1,
        amountMinor: 5_000n,
        condition: { type: ConditionType.DeliverablesApprovedCount, count: 5 },
      },
      {
        id: 'm-date',
        sequence: 2,
        amountMinor: 5_000n,
        condition: { type: ConditionType.DateReached, at: '2020-01-01T00:00:00Z' },
      },
    ];

    const result = evaluateDeal(milestones, facts());
    expect(result.nextUnlock?.milestoneId).toBe('m-videos');
    // And the later one still releases — being out of order is not an error.
    expect(result.toRelease.map((verdict) => verdict.milestoneId)).toEqual(['m-date']);
  });

  it('is null once everything is satisfied', () => {
    expect(
      evaluateDeal(typicalDeal(), facts({ totalDeliverables: 20, approvedDeliverableIds: approvedSet(20) }))
        .nextUnlock,
    ).toBeNull();
  });
});

describe('evaluation is pure', () => {
  it('does not mutate its inputs', () => {
    const milestones = typicalDeal();
    const snapshot = JSON.stringify(milestones, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );

    evaluateDeal(milestones, facts({ totalDeliverables: 20 }));

    expect(
      JSON.stringify(milestones, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    ).toBe(snapshot);
  });

  it('gives the same answer every time for the same inputs', () => {
    const milestones = typicalDeal();
    const state = facts({ totalDeliverables: 20, approvedDeliverableIds: approvedSet(12) });

    const a = evaluateDeal(milestones, state);
    const b = evaluateDeal(milestones, state);
    expect(b.toRelease.map((v) => v.milestoneId)).toEqual(a.toRelease.map((v) => v.milestoneId));
  });

  it('handles a deal with no milestones without throwing', () => {
    const result = evaluateDeal([], facts());
    expect(result.toRelease).toEqual([]);
    expect(result.totalToReleaseMinor).toBe(0n);
    expect(result.nextUnlock).toBeNull();
  });
});

describe('resolving authored amounts', () => {
  const USD = 'USD' as const;

  it('passes fixed amounts straight through', () => {
    const resolved = resolveMilestoneAmounts(
      [
        { sequence: 1, kind: 'fixed', amountMinor: 2_000n },
        { sequence: 2, kind: 'fixed', amountMinor: 8_000n },
      ],
      Money.of(10_000n, USD),
    );
    expect(resolved.get(1)).toBe(2_000n);
    expect(resolved.get(2)).toBe(8_000n);
  });

  it('REFUSES fixed amounts that do not sum to the deal', () => {
    // An unallocated remainder is money nobody has decided about.
    expect(() =>
      resolveMilestoneAmounts(
        [
          { sequence: 1, kind: 'fixed', amountMinor: 2_000n },
          { sequence: 2, kind: 'fixed', amountMinor: 7_000n },
        ],
        Money.of(10_000n, USD),
      ),
    ).toThrow(MilestoneAmountsError);
  });

  it('refuses fixed amounts that exceed the deal', () => {
    expect(() =>
      resolveMilestoneAmounts(
        [{ sequence: 1, kind: 'fixed', amountMinor: 20_000n }],
        Money.of(10_000n, USD),
      ),
    ).toThrow(/more than the deal total/);
  });

  it('splits percentages over what is LEFT after the fixed amounts', () => {
    // "$20 advance, then the rest split three ways" must mean that, not "20% of
    // the whole plus three thirds of the whole".
    const resolved = resolveMilestoneAmounts(
      [
        { sequence: 1, kind: 'fixed', amountMinor: 2_000n },
        { sequence: 2, kind: 'percentage', basisPoints: 5_000 },
        { sequence: 3, kind: 'percentage', basisPoints: 5_000 },
      ],
      Money.of(10_000n, USD),
    );

    expect(resolved.get(1)).toBe(2_000n);
    expect(resolved.get(2)).toBe(4_000n);
    expect(resolved.get(3)).toBe(4_000n);
  });

  it('LOSES NO CENT on an indivisible split', () => {
    // Multiplying and rounding each share independently is how a total ends up a
    // cent short — and the deal-total constraint then rejects an otherwise valid
    // agreement for a reason nobody can find.
    const resolved = resolveMilestoneAmounts(
      [
        { sequence: 1, kind: 'percentage', basisPoints: 3_334 },
        { sequence: 2, kind: 'percentage', basisPoints: 3_333 },
        { sequence: 3, kind: 'percentage', basisPoints: 3_333 },
      ],
      Money.of(10_000n, USD),
    );

    const total = [...resolved.values()].reduce((sum, amount) => sum + amount, 0n);
    expect(total).toBe(10_000n);
  });

  it('loses no cent across many awkward totals', () => {
    for (const amount of [1n, 7n, 99n, 101n, 12_345n, 999_999n, 1_000_003n]) {
      const resolved = resolveMilestoneAmounts(
        [
          { sequence: 1, kind: 'percentage', basisPoints: 3_333 },
          { sequence: 2, kind: 'percentage', basisPoints: 3_333 },
          { sequence: 3, kind: 'percentage', basisPoints: 3_334 },
        ],
        Money.of(amount, USD),
      );
      const total = [...resolved.values()].reduce((sum, value) => sum + value, 0n);
      expect(total, `total ${amount} did not round-trip`).toBe(amount);
    }
  });

  it('REFUSES percentages that do not total 100%', () => {
    // A deal with an unallocated share is a deal where the remainder belongs to
    // nobody.
    expect(() =>
      resolveMilestoneAmounts(
        [
          { sequence: 1, kind: 'percentage', basisPoints: 5_000 },
          { sequence: 2, kind: 'percentage', basisPoints: 4_000 },
        ],
        Money.of(10_000n, USD),
      ),
    ).toThrow(/not 100%/);
  });

  it('refuses percentages that total MORE than 100%', () => {
    expect(() =>
      resolveMilestoneAmounts(
        [
          { sequence: 1, kind: 'percentage', basisPoints: 6_000 },
          { sequence: 2, kind: 'percentage', basisPoints: 6_000 },
        ],
        Money.of(10_000n, USD),
      ),
    ).toThrow(/not 100%/);
  });

  it('refuses a deal with no milestones', () => {
    expect(() => resolveMilestoneAmounts([], Money.of(10_000n, USD))).toThrow(
      /at least one milestone/,
    );
  });

  it('always produces amounts that sum to the deal total', () => {
    // The invariant the database constraint checks. If this can be violated, the
    // constraint rejects agreements that were authored correctly.
    const cases = [
      [{ sequence: 1, kind: 'fixed' as const, amountMinor: 10_000n }],
      [
        { sequence: 1, kind: 'fixed' as const, amountMinor: 1n },
        { sequence: 2, kind: 'percentage' as const, basisPoints: 10_000 },
      ],
      [
        { sequence: 1, kind: 'percentage' as const, basisPoints: 1 },
        { sequence: 2, kind: 'percentage' as const, basisPoints: 9_999 },
      ],
    ];

    for (const authored of cases) {
      const resolved = resolveMilestoneAmounts(authored, Money.of(10_000n, USD));
      const total = [...resolved.values()].reduce((sum, value) => sum + value, 0n);
      expect(total).toBe(10_000n);
    }
  });
});
