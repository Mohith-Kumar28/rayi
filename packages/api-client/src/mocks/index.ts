/**
 * Hand-written mock scenarios, composed from one file per surface.
 *
 * Deliberately NOT orval's generated Faker mocks. Random money is actively
 * harmful in a money UI: it hides alignment bugs, makes a screenshot
 * unreviewable, and means nobody ever sees the same number twice. These
 * fixtures are stable and chosen to exercise the cases that break layouts and
 * the states the screens exist for — a failed treasury command, a creator who
 * cannot be paid, an exhausted budget envelope, a broken hash chain.
 *
 * Switch scenario at runtime from the browser console:
 *   window.__rayiScenario = 'insufficient-funds'
 */

import { adminOpsHandlers } from './admin-ops.js';
import { brandHandlers, CREATOR_ID, WORKSPACE_ID } from './brand.js';
import { CAMPAIGN_ID, coreHandlers, DEAL_ID, ORG_ID } from './core.js';
import { creatorMoneyHandlers } from './creator-money.js';

export type { MockScenario } from './core.js';

/**
 * Order matters: MSW takes the FIRST matching handler.
 *
 * The per-surface files come before `core` so that a narrow path always wins
 * over a broader one. Nothing currently collides, but a pattern added later
 * would, and discovering that through a screen quietly rendering the wrong
 * fixture is an afternoon lost.
 */
export const handlers = [
  ...brandHandlers,
  ...creatorMoneyHandlers,
  ...adminOpsHandlers,
  ...coreHandlers,
];

export const MOCK_IDS = {
  ORG_ID,
  CAMPAIGN_ID,
  WORKSPACE_ID,
  DEAL_ID,
  CREATOR_ID,
};

export const MOCK_SCENARIOS = [
  'default',
  'insufficient-funds',
  'step-up-required',
  'idempotency-conflict',
  'ledger-drift',
  'empty',
] as const;
