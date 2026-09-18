import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';

import { handlers, MOCK_IDS } from './mocks.js';
import { getOrgFunds, allocateBudget } from './generated/funding/funding.js';
import { listCampaigns } from './generated/campaigns/campaigns.js';
import { ApiError } from './fetcher.js';

/**
 * Proves the whole contract pipeline actually connects:
 *
 *   Zod manifest -> openapi.json -> generated client -> MSW handlers
 *
 * If any link breaks — a renamed operation, a changed path, a money field that
 * stopped being a string — this fails. That is what makes it safe to build UI
 * against mocks before a backend exists: the mock and the future server are
 * generated from the same document.
 */

const server = setupServer(...handlers);

beforeAll(() => {
  // jsdom is not involved; give the fetcher an origin to resolve relative URLs against.
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'http://localhost' },
    writable: true,
    configurable: true,
  });
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  globalThis.__rayiScenario = undefined;
  server.resetHandlers();
});
afterAll(() => server.close());

describe('generated client against the mock server', () => {
  it('reads org funds with money as strings, never numbers', async () => {
    const funds = await getOrgFunds(MOCK_IDS.ORG_ID);

    expect(typeof funds.available.amountMinor).toBe('string');
    expect(funds.available.amountMinor).toBe('41250000');
    expect(funds.available.exponent).toBe(2);
    expect(funds.available.currency).toBe('USD');
  });

  it('models pending funds separately from available, so they can never be allocated', async () => {
    const funds = await getOrgFunds(MOCK_IDS.ORG_ID);

    const unsettled = funds.lots.filter((lot) => lot.settledAt === null);
    expect(unsettled).toHaveLength(1);
    // The unsettled lot's value is reported as `pending` and is excluded from `available`.
    expect(funds.pending.amountMinor).toBe(unsettled[0]!.available.amountMinor);
    expect(funds.available.amountMinor).not.toBe('0');
  });

  it('distinguishes a lot inside its ACH return window from one that has matured', async () => {
    const funds = await getOrgFunds(MOCK_IDS.ORG_ID);
    const settled = funds.lots.filter((lot) => lot.settledAt !== null);
    const stillClearing = settled.filter(
      (lot) => lot.maturesAt !== null && new Date(lot.maturesAt) > new Date('2026-09-18T00:00:00Z'),
    );

    expect(stillClearing).toHaveLength(1);
    expect(funds.clearing.amountMinor).toBe(stillClearing[0]!.available.amountMinor);
  });

  it('lists campaigns', async () => {
    const result = await listCampaigns(MOCK_IDS.ORG_ID);
    expect(result.campaigns.length).toBeGreaterThan(0);
    expect(result.campaigns[0]!.allocated.currency).toBe('USD');
  });

  it('accepts an allocation with 202 and returns a command id', async () => {
    const result = await allocateBudget(MOCK_IDS.ORG_ID, MOCK_IDS.CAMPAIGN_ID, {
      amount: { amountMinor: '2500000', currency: 'USD' },
      idempotencyKey: `allocate:${MOCK_IDS.CAMPAIGN_ID}:2500000`,
    });

    expect(result.status).toBe('accepted');
    expect(result.campaignId).toBe(MOCK_IDS.CAMPAIGN_ID);
  });
});

describe('error scenarios surface as typed problems, not strings', () => {
  it.each([
    ['insufficient-funds', 'insufficient_unallocated_funds', 409],
    ['idempotency-conflict', 'idempotency_key_reused', 409],
    ['step-up-required', 'step_up_required', 403],
  ] as const)('%s -> %s', async (scenarioName, expectedCode, expectedStatus) => {
    globalThis.__rayiScenario = scenarioName;

    const call = allocateBudget(MOCK_IDS.ORG_ID, MOCK_IDS.CAMPAIGN_ID, {
      amount: { amountMinor: '99900000', currency: 'USD' },
      idempotencyKey: `allocate:${MOCK_IDS.CAMPAIGN_ID}:99900000`,
    });

    await expect(call).rejects.toBeInstanceOf(ApiError);
    await call.catch((error: unknown) => {
      const apiError = error as ApiError;
      expect(apiError.code).toBe(expectedCode);
      expect(apiError.status).toBe(expectedStatus);
    });
  });

  it('carries the step-up challenge on the problem, so the dialog never reads an amount from cache', async () => {
    globalThis.__rayiScenario = 'step-up-required';

    await allocateBudget(MOCK_IDS.ORG_ID, MOCK_IDS.CAMPAIGN_ID, {
      amount: { amountMinor: '50000000', currency: 'USD' },
      idempotencyKey: 'allocate:x:50000000',
    }).catch((error: unknown) => {
      const apiError = error as ApiError;
      expect(apiError.challenge?.challengeId).toBe('chal_mock_01');
      expect(apiError.challenge?.reason).toBe('amount_above_threshold');
    });
  });
});

describe('the empty scenario renders a real zero rather than a missing value', () => {
  it('returns zeroes, not nulls', async () => {
    globalThis.__rayiScenario = 'empty';
    const funds = await getOrgFunds(MOCK_IDS.ORG_ID);

    expect(funds.available.amountMinor).toBe('0');
    expect(funds.lots).toHaveLength(0);
  });
});
