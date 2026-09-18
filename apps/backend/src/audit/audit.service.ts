import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '@/database/prisma.service';

import type {
  AuditEvent,
  AuditEventInput,
  AuditHead,
  ChainBreak,
} from './audit.types';

/**
 * The audit log.
 *
 * Writes go through `audit.record`, a SECURITY DEFINER function that computes
 * the hash itself. This service therefore CANNOT choose what the chain says —
 * which is the point. A service that could supply a hash could write an event
 * whose hash matched a different payload, and the chain would verify while
 * saying something false.
 *
 * `record` deliberately does NOT throw on failure. An audit write that fails
 * must not roll back the action it was recording: refusing to revoke a session
 * because the log was unavailable would turn an observability outage into a
 * security one, at exactly the moment someone is trying to evict an attacker.
 * The failure is logged loudly instead, and the nightly chain check is what
 * notices a gap.
 *
 * The one exception is `recordInTransaction`, for events that must be atomic
 * with the thing they describe — granting money capability, for instance, where
 * an unrecorded grant is worse than no grant.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an event. Never throws.
   *
   * Returns the event id, or `null` when the write failed — callers that care
   * can check, and callers that do not are not forced to.
   */
  async record(input: AuditEventInput): Promise<string | null> {
    try {
      return await this.write(this.prisma, input);
    } catch (error) {
      // Loud, because a silent audit failure is indistinguishable from nothing
      // having happened — and the whole value of this log is that it is complete.
      this.logger.error(
        `AUDIT WRITE FAILED for ${input.action}: ${
          error instanceof Error ? error.message : String(error)
        }. The action itself was NOT rolled back.`,
      );
      return null;
    }
  }

  /**
   * Records an event inside a caller's transaction, and DOES throw.
   *
   * For the small set of actions where an unrecorded change is worse than no
   * change: granting or revoking money capability, changing a member's role,
   * anything an auditor would expect to reconcile exactly.
   */
  async recordInTransaction(
    tx: Pick<PrismaService, '$queryRaw'>,
    input: AuditEventInput,
  ): Promise<string> {
    return this.write(tx, input);
  }

  private async write(
    client: Pick<PrismaService, '$queryRaw'>,
    input: AuditEventInput,
  ): Promise<string> {
    const rows = await client.$queryRaw<Array<{ record: string }>>`
      SELECT audit.record(
        ${input.action},
        ${input.actorUserId ?? null},
        ${input.actorMemberId ?? null},
        ${input.organizationId ?? null},
        ${input.subjectType ?? null},
        ${input.subjectId ?? null},
        ${input.requestId ?? null},
        ${input.ipAddress ?? null},
        ${input.userAgent ?? null},
        ${JSON.stringify(input.data ?? {})}::jsonb
      ) AS record
    `;

    const id = rows[0]?.record;
    if (!id) throw new Error('audit.record returned no id.');
    return id;
  }

  /**
   * The events a user is entitled to see about themselves.
   *
   * Scoped by `actorUserId` in the WHERE clause rather than filtered after the
   * fact, so there is no code path that loads someone else's history and then
   * decides not to show it.
   */
  async forUser(userId: string, limit = 50): Promise<AuditEvent[]> {
    return this.prisma.$queryRaw<AuditEvent[]>`
      SELECT id::text AS id,
             seq,
             occurred_at AS "occurredAt",
             action,
             actor_user_id AS "actorUserId",
             subject_type  AS "subjectType",
             subject_id    AS "subjectId",
             -- host() rather than ::text: the inet type renders a host address
             -- with its /32 (or /128) prefix, which is noise in a UI and — more
             -- importantly — is the exact discrepancy that broke the hash chain
             -- when one side used ::text and the other did not. Both sides now
             -- use host().
             host(ip_address) AS "ipAddress",
             data
        FROM audit.event
       WHERE actor_user_id = ${userId}
       ORDER BY seq DESC
       LIMIT ${limit}
    `;
  }

  /**
   * Verifies the whole chain. Run nightly, alarmed on any result.
   *
   * An empty array means the history is intact **as far as it can see**. A row
   * altered or removed from the middle breaks the link to the next one and is
   * reported here.
   *
   * What it cannot see is a deleted SUFFIX: remove the newest N rows and the
   * remaining prefix verifies perfectly. No log can prove from inside itself
   * that it has not been truncated. `head()` exists for that — anchoring the tip
   * somewhere the database role cannot reach is what makes truncation visible.
   *
   * An audit log nobody verifies is a log that says whatever the last person
   * with database access wanted it to say.
   */
  async verifyChain(from = 0n): Promise<ChainBreak[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ bad_seq: bigint; reason: string }>
    >`
      SELECT bad_seq, reason FROM audit.verify_chain(${from}::bigint)
    `;
    return rows.map((row) => ({ seq: row.bad_seq, reason: row.reason }));
  }

  /**
   * The current tip of the chain, for external anchoring.
   *
   * Published on a schedule to storage the database role cannot write — S3 with
   * Object Lock, in a different account — this closes the one gap
   * `verifyChain` structurally cannot: a log that has lost its newest rows can
   * no longer produce the head that was published an hour ago.
   *
   * Returns `null` for an empty log, which is a real state and not an error.
   */
  async head(): Promise<AuditHead | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ seq: bigint; hash: string; occurred_at: Date }>
    >`
      SELECT seq, encode(hash, 'hex') AS hash, occurred_at FROM audit.head()
    `;
    const row = rows[0];
    if (!row) return null;
    return { seq: row.seq, hash: row.hash, occurredAt: row.occurred_at };
  }
}
