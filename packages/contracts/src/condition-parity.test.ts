import { ConditionType, evaluateCondition, isSatisfiableAtStart } from '@rayi/domain';
import { describe, expect, it } from 'vitest';

import { MilestoneConditionSchema } from './operations/deals.js';

/**
 * The contract's condition union and the domain's must agree exactly.
 *
 * They drifted once, and the failure was silent in the worst way: the contract
 * called the date field `date` while `evaluateCondition` read `at`, so a dated
 * milestone evaluated `undefined` — it would never satisfy, and a milestone
 * dated in the past would have slipped past the advance disclosure entirely.
 * Nothing caught it, because each side was internally consistent.
 *
 * So the check is not "do the type names match" — that would have passed. Every
 * shape the contract accepts is fed to the function that actually decides
 * whether money moves.
 */

const FIXTURES: Array<{ label: string; value: unknown }> = [
  { label: 'ADVANCE', value: { type: 'ADVANCE' } },
  { label: 'DELIVERABLES_APPROVED_COUNT', value: { type: 'DELIVERABLES_APPROVED_COUNT', count: 3 } },
  {
    label: 'SPECIFIC_DELIVERABLES_APPROVED',
    value: {
      type: 'SPECIFIC_DELIVERABLES_APPROVED',
      deliverableIds: ['11111111-1111-4111-8111-111111111111'],
    },
  },
  { label: 'ALL_DELIVERABLES_APPROVED', value: { type: 'ALL_DELIVERABLES_APPROVED' } },
  { label: 'DATE_REACHED', value: { type: 'DATE_REACHED', at: '2026-01-01T00:00:00.000Z' } },
  { label: 'MANUAL_BRAND_APPROVAL', value: { type: 'MANUAL_BRAND_APPROVAL' } },
];

describe('condition parity between the contract and the engine', () => {
  it('covers every type in the domain catalogue', () => {
    const contractTypes = new Set(FIXTURES.map((fixture) => (fixture.value as { type: string }).type));
    for (const type of Object.values(ConditionType)) {
      expect(contractTypes.has(type), `no fixture for ${type}`).toBe(true);
    }
  });

  it.each(FIXTURES)('accepts $label and the engine evaluates it', ({ value }) => {
    const parsed = MilestoneConditionSchema.parse(value);

    // The real function, not a name comparison. A field the engine cannot read
    // produces a verdict that is wrong rather than an error, which is why this
    // asserts on the verdict.
    const verdict = evaluateCondition(parsed as never, 'm1', {
      approvedDeliverableIds: new Set(),
      totalDeliverables: 5,
      manuallyApprovedMilestoneIds: new Set(),
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(typeof verdict.satisfied).toBe('boolean');
    expect(verdict.reason.length).toBeGreaterThan(0);
  });

  /**
   * The specific bug, pinned.
   *
   * A date in the past means the milestone is already satisfied, which makes it
   * an advance. If the field name drifts again this is the assertion that goes
   * red.
   */
  it('reads the date field the engine reads', () => {
    const past = MilestoneConditionSchema.parse({
      type: 'DATE_REACHED',
      at: '2020-01-01T00:00:00.000Z',
    });
    expect(isSatisfiableAtStart(past as never, new Date('2026-06-01T00:00:00.000Z'))).toBe(true);

    const future = MilestoneConditionSchema.parse({
      type: 'DATE_REACHED',
      at: '2030-01-01T00:00:00.000Z',
    });
    expect(isSatisfiableAtStart(future as never, new Date('2026-06-01T00:00:00.000Z'))).toBe(false);
  });

  it('rejects a condition type the engine does not know', () => {
    expect(() => MilestoneConditionSchema.parse({ type: 'WHENEVER_I_FEEL_LIKE_IT' })).toThrow();
  });
});
