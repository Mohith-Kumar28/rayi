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

@Injectable()
export class TreasuryCommandListener
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(TreasuryCommandListener.name);

  private client?: Client;
  private timer?: NodeJS.Timeout;
  private sweeping = false;
  private stopped = false;

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
      void this.run(message.payload);
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
   * Picks up anything still pending: notifications missed while the worker was
   * down, commands whose notification was dropped under load, and anything
   * restored from a backup. Guarded against overlap so a slow batch does not
   * stack up behind itself.
   */
  private async sweep(): Promise<void> {
    if (this.sweeping || this.stopped) return;
    this.sweeping = true;
    try {
      const pending = await this.prisma.treasuryCommand.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: POLL_BATCH_SIZE,
        select: { id: true },
      });

      for (const command of pending) {
        if (this.stopped) break;
        await this.run(command.id);
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
