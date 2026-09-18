import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';

import { PrismaService } from '@/database/prisma.service';

import { AllocateBudgetProcessor } from './processors/allocate-budget.processor';

/**
 * The money queue.
 *
 * Postgres-backed rather than BullMQ, and only here. BullMQ handles everything
 * that can afford at-least-once delivery — email, notifications, media — but it
 * lives in Redis and therefore cannot join the transaction that writes the
 * intent. That gap is the dual-write bug: a crash between "row committed" and
 * "job enqueued" leaves an allocation nobody will ever process, or a job whose
 * command was rolled back.
 *
 * Two mechanisms, and it matters which one is load-bearing:
 *
 *   LISTEN/NOTIFY is a LATENCY optimisation. It is fire-and-forget: a
 *   notification raised while no worker is connected is gone, and Postgres will
 *   drop notifications entirely if its queue overflows. Nothing may depend on it.
 *
 *   The POLL is the correctness mechanism. `treasury_command` rows in `pending`
 *   are the durable work queue — they survive a crash, a deploy, a failover and
 *   a restore, because they are ordinary committed rows.
 *
 * Deleting the LISTEN would make the system slower. Deleting the poll would make
 * it lose money.
 */

/** How often the durable sweep runs, regardless of notifications. */
const POLL_INTERVAL_MS = 5_000;

/** Rows per sweep. Bounded so one backlog cannot monopolise the process. */
const POLL_BATCH_SIZE = 50;

/**
 * How long a claim is good for.
 *
 * A worker that is killed mid-command leaves its row in `processing` with
 * nobody coming back for it. After the lease expires another worker reclaims it.
 *
 * Reclaiming is only safe because `ledger.post_entry` is idempotent on the
 * command id: if the original worker had in fact posted before dying, the
 * reclaim converges on that same entry instead of posting a second one. Without
 * that property this timeout would be a double-payment schedule.
 *
 * Five minutes is far longer than any command takes and far shorter than anyone
 * will wait for a stuck allocation.
 */
const LEASE_MS = 5 * 60 * 1000;

/**
 * How many times one command may be attempted before it stops being retried.
 *
 * An unbounded retry on the money path is how a single poison command becomes a
 * hot loop against Stripe. Terminal failures already mark themselves `failed`;
 * this catches the case where the worker dies before it can record why.
 */
const MAX_ATTEMPTS = 5;

@Injectable()
export class TreasuryCommandListener
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(TreasuryCommandListener.name);

  private client?: Client;
  private timer?: NodeJS.Timeout;
  private sweeping = false;
  private stopped = false;

  /**
   * Who holds a claim. Recorded so an abandoned lease names the process that
   * abandoned it — otherwise "which task died" is unanswerable from the data.
   */
  private readonly workerId = `${process.env['HOSTNAME'] ?? 'local'}:${process.pid}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly allocateBudget: AllocateBudgetProcessor,
  ) {}

  async onModuleInit(): Promise<void> {
    // The sweep starts first and unconditionally. If LISTEN cannot be
    // established the worker still drains the queue — degraded in latency, never
    // in correctness.
    this.timer = setInterval(() => void this.sweep(), POLL_INTERVAL_MS);
    this.timer.unref();

    try {
      await this.listen();
    } catch (error) {
      this.logger.warn(
        `LISTEN unavailable (${error instanceof Error ? error.message : String(error)}); ` +
          `falling back to polling every ${POLL_INTERVAL_MS}ms.`,
      );
    }

    await this.sweep();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.client?.end().catch(() => undefined);
  }

  private async listen(): Promise<void> {
    const connectionString = this.config.get<string>('database.url');
    if (!connectionString) return;

    const client = new Client({ connectionString });
    this.client = client;

    // A dropped LISTEN connection is invisible otherwise: the worker keeps
    // running, no error is raised, and work simply takes up to POLL_INTERVAL_MS
    // longer forever. Reconnecting keeps the latency path alive.
    client.on('error', (error) => {
      this.logger.warn(
        `LISTEN connection error: ${error.message}. Reconnecting.`,
      );
      void this.reconnect();
    });

    client.on('notification', (message) => {
      if (message.channel !== 'treasury_command') return;
      // The payload is a POINTER — the command id — never the command itself.
      // Anything carried in a notification would be untrusted by the time it
      // arrives, and Postgres caps the payload at 8000 bytes anyway.
      //
      // A notification does NOT go straight to the processor: it triggers a
      // claim, so the row still goes through `FOR UPDATE SKIP LOCKED` exactly as
      // a swept row does. Two workers receiving the same notification is the
      // normal case, and only one may own the command.
      void this.sweep();
    });

    await client.connect();
    await client.query('LISTEN treasury_command');
    this.logger.log('Listening for treasury commands.');
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    await this.client?.end().catch(() => undefined);
    this.client = undefined;
    setTimeout(() => {
      if (!this.stopped) void this.listen().catch(() => undefined);
    }, 1_000).unref();
  }

  /**
   * The durable sweep.
   *
   * Picks up anything still live: notifications missed while the worker was
   * down, commands whose notification was dropped under load, anything restored
   * from a backup, and rows abandoned by a worker that died mid-command.
   *
   * Guarded against overlap so a slow batch does not stack up behind itself.
   */
  private async sweep(): Promise<void> {
    if (this.sweeping || this.stopped) return;
    this.sweeping = true;
    try {
      for (const commandId of await this.claim(POLL_BATCH_SIZE)) {
        if (this.stopped) break;
        await this.run(commandId);
      }
    } catch (error) {
      this.logger.error(
        `Treasury sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Atomically take ownership of a batch of commands.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes a second worker safe: each row is
   * locked by exactly one claimer, and the others step over it instead of
   * blocking behind it. Without `SKIP LOCKED` two workers serialize on the same
   * row and the second does the work again; without the lock at all they both
   * process every row.
   *
   * The `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` shape is
   * one statement, so claiming is atomic with no window between selecting a row
   * and marking it taken.
   *
   * Three kinds of row are claimable:
   *   - `pending`, never attempted
   *   - `processing` whose lease has expired — the worker that held it is gone
   *   - neither, once `attempts` is exhausted: left alone for a human
   */
  private async claim(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE treasury_command
         SET status      = 'processing',
             "claimedAt" = now(),
             "claimedBy" = ${this.workerId},
             attempts    = attempts + 1
       WHERE id IN (
         SELECT id FROM treasury_command
          WHERE attempts < ${MAX_ATTEMPTS}
            AND (
              status = 'pending'
              OR (
                status = 'processing'
                AND "claimedAt" < now() - ${`${LEASE_MS} milliseconds`}::interval
              )
            )
          ORDER BY "createdAt"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id
    `;
    return rows.map((row) => row.id);
  }

  /**
   * Dispatch one command.
   *
   * Swallows the error deliberately: the processor has already recorded the
   * failure reason on the row, and the row — not this in-memory call — is the
   * record of what happened. Rethrowing would take down the listener over a
   * single refused allocation, which is precisely the failure the durable queue
   * exists to avoid.
   */
  private async run(commandId: string | undefined): Promise<void> {
    if (!commandId) return;
    try {
      await this.allocateBudget.process(commandId);
    } catch (error) {
      this.logger.error(
        `Treasury command ${commandId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
