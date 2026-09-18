import { z } from 'zod';

/**
 * RFC 9457 problem details, plus a stable machine-readable `code`.
 *
 * `code` is the contract; `title` and `detail` are for humans and may be
 * reworded freely. Clients branch on `code` and never on a message string.
 */

export const ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'step_up_required',
  'not_found',
  'idempotency_key_reused',
  'insufficient_unallocated_funds',
  'budget_envelope_exceeded',
  'daily_limit_exceeded',
  'deposit_not_settled',
  'organization_frozen',
  'conflict',
  'rate_limited',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ProblemSchema = z
  .object({
    type: z.string().describe('A URI reference identifying the problem type.'),
    title: z.string().describe('Short, human-readable summary. Safe to reword — do not branch on it.'),
    status: z.int().describe('HTTP status code.'),
    detail: z.string().optional().describe('Human-readable explanation specific to this occurrence.'),
    instance: z.string().optional().describe('URI reference identifying this specific occurrence.'),
    code: z.enum(ERROR_CODES).describe('Stable machine-readable code. THIS is the contract.'),
    requestId: z.string().describe('Correlates to server logs. Always show this in support surfaces.'),
    /**
     * Populated only for `step_up_required`. The amount and counterparty shown in a
     * confirmation dialog MUST come from here, never from client cache — otherwise a
     * compromised dependency could display one amount while a different one is paid.
     */
    challenge: z
      .object({
        challengeId: z.string(),
        reason: z.string(),
        expiresAt: z.iso.datetime(),
      })
      .optional(),
  })
  .describe('RFC 9457 problem details.');

export type Problem = z.infer<typeof ProblemSchema>;
