export * from './money.js';
export * from './errors.js';
export * from './operation.js';
export * from './openapi.js';
export * from './operations/funding.js';
export * from './operations/account.js';
export * from './operations/members.js';
export * from './operations/review.js';
export * from './operations/creator.js';
export * from './operations/admin.js';
export * from './operations/campaigns.js';
export * from './operations/deals.js';
export * from './operations/organization.js';
export * from './operations/payouts.js';
export * from './operations/roster.js';
export * from './operations/workspaces.js';

import { ACCOUNT_OPERATIONS } from './operations/account.js';
import { MEMBER_OPERATIONS } from './operations/members.js';
import { ADMIN_OPERATIONS } from './operations/admin.js';
import { CREATOR_OPERATIONS } from './operations/creator.js';
import { REVIEW_OPERATIONS } from './operations/review.js';
import { FUNDING_OPERATIONS } from './operations/funding.js';
import { CAMPAIGN_OPERATIONS } from './operations/campaigns.js';
import { DEAL_OPERATIONS } from './operations/deals.js';
import { ORGANIZATION_OPERATIONS } from './operations/organization.js';
import { PAYOUT_OPERATIONS } from './operations/payouts.js';
import { ROSTER_OPERATIONS } from './operations/roster.js';
import { WORKSPACE_OPERATIONS } from './operations/workspaces.js';
import type { OperationDefinition } from './operation.js';

/** Every operation in the system. The route-coverage test iterates this. */
export const ALL_OPERATIONS: readonly OperationDefinition[] = [
  ...FUNDING_OPERATIONS,
  ...ACCOUNT_OPERATIONS,
  ...MEMBER_OPERATIONS,
  ...REVIEW_OPERATIONS,
  ...CREATOR_OPERATIONS,
  ...ADMIN_OPERATIONS,
  ...ORGANIZATION_OPERATIONS,
  ...WORKSPACE_OPERATIONS,
  ...CAMPAIGN_OPERATIONS,
  ...DEAL_OPERATIONS,
  ...ROSTER_OPERATIONS,
  ...PAYOUT_OPERATIONS,
] as readonly OperationDefinition[];
