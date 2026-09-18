import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { PrismaService } from '@/database/prisma.service';

import {
  EXPECTED_CONSTRAINTS,
  EXPECTED_FUNCTIONS,
  EXPECTED_GENERATED_COLUMNS,
  EXPECTED_RLS_TABLES,
  EXPECTED_TRIGGERS,
  EXPECTED_UNIQUE_INDEXES,
} from './ledger-controls';

/**
 * Asserts, at boot, that the database this process actually connected to still
 * has every control the money-safety argument rests on.
 *
 * The whole design says "over-allocation is impossible because a CHECK
 * constraint prevents it". That sentence is true of the schema in the
 * migrations, not of whatever database the `DATABASE_URL` happens to point at.
 * Between those two there is a migration that was rolled back, a restore from
 * before a control existed, a `DROP CONSTRAINT` in a hotfix nobody re-added, a
 * staging URL pasted into a production secret, and a compromised migrator role.
 * Every one of those produces a system that looks completely normal and silently
 * stops enforcing solvency.
 *
 * This is cheap — five catalog queries, once, at startup — and it is the
 * difference between discovering that in a reconciliation report and refusing to
 * start.
 *
 * It fails CLOSED: the process throws and does not serve. For a worker that
 * moves money, not running is the correct behaviour when its guarantees cannot
 * be verified.
 */
@Injectable()
export class LedgerIntegrityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LedgerIntegrityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    const failures = await this.verify();

    if (failures.length > 0) {
      const detail = failures.map((failure) => `  - ${failure}`).join('\n');
      throw new Error(
        `Ledger integrity check FAILED. This process will not start.\n\n${detail}\n\n` +
          `The database this process connected to is missing controls the money-safety design ` +
          `depends on. Do not remove this check to get past it: either the migrations have not ` +
          `been applied, or the connection points somewhere unexpected, or a control was dropped. ` +
          `See docs/04-money-rules.md.`,
      );
    }

    this.logger.log(
      `Ledger integrity verified: ${EXPECTED_CONSTRAINTS.length} constraints, ` +
        `${EXPECTED_TRIGGERS.length} triggers, ${EXPECTED_FUNCTIONS.length} functions, ` +
        `${EXPECTED_UNIQUE_INDEXES.length} unique indexes, ` +
        `${EXPECTED_GENERATED_COLUMNS.length} generated columns, ` +
        `${EXPECTED_RLS_TABLES.length} RLS-protected tables.`,
    );

    await this.recordClusterIdentity();
  }

  /**
   * Returns a human-readable failure for every control that is missing or wrong.
   *
   * Collects ALL of them rather than throwing on the first. Someone woken at
   * 3am should see the whole picture in one message — "three controls missing"
   * points at a restore, "one control missing" points at a bad migration, and a
   * check that stops at the first difference cannot tell them apart.
   */
  async verify(): Promise<string[]> {
    const failures: string[] = [];

    const isolation = await this.prisma.$queryRaw<Array<{ level: string }>>`
      SELECT current_setting('transaction_isolation') AS level
    `;
    const level = isolation[0]?.level;
    if (level !== 'read committed') {
      // Not a style preference. The solvency argument is specifically that under
      // READ COMMITTED, Postgres re-evaluates `balance + delta` against the
      // post-commit value (EvalPlanQual) so the second writer sees the true
      // balance. Under REPEATABLE READ or SERIALIZABLE the same code produces
      // 40001 serialization failures instead, and the retry policy is not
      // written for that volume.
      failures.push(
        `transaction_isolation is "${level}", expected "read committed" — the concurrency ` +
          `argument in docs/04-money-rules.md does not hold at other levels.`,
      );
    }

    // ---- constraints -------------------------------------------------------
    const constraints = await this.prisma.$queryRaw<
      Array<{ name: string; table: string }>
    >`
      SELECT c.conname AS name,
             n.nspname || '.' || t.relname AS table
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'ledger'
    `;
    const haveConstraint = new Set(
      constraints.map((row) => `${row.table}:${row.name}`),
    );
    for (const expected of EXPECTED_CONSTRAINTS) {
      if (!haveConstraint.has(`${expected.table}:${expected.name}`)) {
        failures.push(
          `MISSING CONSTRAINT ${expected.table}.${expected.name} — ${expected.guards}`,
        );
      }
    }

    // ---- triggers ----------------------------------------------------------
    const triggers = await this.prisma.$queryRaw<
      Array<{
        name: string;
        table: string;
        deferrable: boolean;
        initdeferred: boolean;
      }>
    >`
      SELECT tg.tgname AS name,
             n.nspname || '.' || t.relname AS table,
             tg.tgdeferrable AS deferrable,
             tg.tginitdeferred AS initdeferred
        FROM pg_trigger tg
        JOIN pg_class t ON t.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'ledger' AND NOT tg.tgisinternal
    `;
    const triggersByKey = new Map(
      triggers.map((row) => [`${row.table}:${row.name}`, row]),
    );
    for (const expected of EXPECTED_TRIGGERS) {
      const found = triggersByKey.get(`${expected.table}:${expected.name}`);
      if (!found) {
        failures.push(
          `MISSING TRIGGER ${expected.table}.${expected.name} — ${expected.guards}`,
        );
        continue;
      }
      if (expected.deferrable && !(found.deferrable && found.initdeferred)) {
        // The balanced-entry assertion MUST run at COMMIT. As an immediate
        // trigger it fires after the first line, when the entry legitimately
        // does not balance yet, and rejects every real posting.
        failures.push(
          `TRIGGER ${expected.table}.${expected.name} is not DEFERRABLE INITIALLY DEFERRED — ` +
            `it must run at COMMIT, not per row.`,
        );
      }
    }

    // ---- functions ---------------------------------------------------------
    const functions = await this.prisma.$queryRaw<
      Array<{ name: string; secdef: boolean }>
    >`
      SELECT p.proname AS name, p.prosecdef AS secdef
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ledger'
    `;
    const functionsByName = new Map(functions.map((row) => [row.name, row]));
    for (const expected of EXPECTED_FUNCTIONS) {
      const found = functionsByName.get(expected.name);
      if (!found) {
        failures.push(
          `MISSING FUNCTION ledger.${expected.name}() — ${expected.guards}`,
        );
        continue;
      }
      if (expected.securityDefiner && !found.secdef) {
        // Without SECURITY DEFINER the function runs as the caller, so the
        // "one door, and callers need nothing but EXECUTE" boundary is gone —
        // every caller would need direct table grants instead.
        failures.push(
          `FUNCTION ledger.${expected.name}() is not SECURITY DEFINER — the privilege ` +
            `boundary depends on it running as the schema owner.`,
        );
      }
    }

    // ---- unique indexes ----------------------------------------------------
    const indexes = await this.prisma.$queryRaw<
      Array<{ name: string; table: string }>
    >`
      SELECT i.relname AS name,
             n.nspname || '.' || t.relname AS table
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'ledger' AND x.indisunique
    `;
    const haveIndex = new Set(indexes.map((row) => `${row.table}:${row.name}`));
    for (const expected of EXPECTED_UNIQUE_INDEXES) {
      if (!haveIndex.has(`${expected.table}:${expected.name}`)) {
        failures.push(
          `MISSING UNIQUE INDEX ${expected.name} on ${expected.table} — ${expected.guards}`,
        );
      }
    }

    // ---- generated columns -------------------------------------------------
    const generated = await this.prisma.$queryRaw<
      Array<{ table: string; column: string }>
    >`
      SELECT table_schema || '.' || table_name AS table, column_name AS column
        FROM information_schema.columns
       WHERE table_schema = 'ledger' AND is_generated = 'ALWAYS'
    `;
    const haveGenerated = new Set(
      generated.map((row) => `${row.table}:${row.column}`),
    );
    for (const expected of EXPECTED_GENERATED_COLUMNS) {
      if (!haveGenerated.has(`${expected.table}:${expected.column}`)) {
        failures.push(
          `COLUMN ${expected.table}.${expected.column} is not GENERATED ALWAYS — ${expected.guards}`,
        );
      }
    }

    // ---- row-level security -----------------------------------------------
    //
    // Checked here rather than trusted, because RLS has TWO ways of being
    // silently inert and both look identical from the application: the table
    // can have policies but not have them enabled, and the connecting role can
    // bypass them entirely.
    //
    // The second one is how this was first written: development connects as a
    // superuser, every policy was decorative, and the first environment where it
    // mattered would have been the first where it had never run.
    const roles = await this.prisma.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>
    >`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    const role = roles[0];

    if (role && (role.rolsuper || role.rolbypassrls)) {
      failures.push(
        `The connected role "${role.rolname}" ${role.rolsuper ? 'is a SUPERUSER' : 'has BYPASSRLS'}, ` +
          `so every row-level security policy is inert. Connect as rayi_app, which has neither.`,
      );
    }

    const rlsTables = await this.prisma.$queryRaw<
      Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
    `;
    const rlsByTable = new Map(rlsTables.map((row) => [row.relname, row]));

    for (const expected of EXPECTED_RLS_TABLES) {
      const found = rlsByTable.get(expected.table);
      if (!found) {
        failures.push(`MISSING TABLE ${expected.table} — expected row-level security on it.`);
        continue;
      }
      if (!found.relrowsecurity) {
        failures.push(`ROW LEVEL SECURITY is OFF on ${expected.table} — ${expected.guards}`);
      } else if (!found.relforcerowsecurity) {
        // Enabled but not FORCED means the table owner bypasses every policy,
        // and in development the application usually IS the owner.
        failures.push(
          `ROW LEVEL SECURITY on ${expected.table} is not FORCED, so the table owner bypasses it.`,
        );
      }
    }

    return failures;
  }

  /**
   * Records which physical cluster this worker is talking to, and logs loudly
   * when it changes.
   *
   * A restored copy of the database running alongside the original — both
   * accepting postings, both re-issuing transfers — is the worst operational
   * failure available to us, and PITR rehearsals are exactly when it happens.
   *
   * This DELIBERATELY logs rather than refuses, and the distinction matters:
   *
   * `system_identifier` is copied by a physical restore, so it does NOT
   * distinguish a fork from the original — a plausible-sounding check that would
   * never fire. `timeline_id` does advance on recovery or promotion, but it also
   * advances on an ordinary RDS Multi-AZ failover, so refusing on a timeline
   * change would take the money path down during exactly the incident it is
   * supposed to survive.
   *
   * So this is an alarm, not a fence. The real protection against a fork
   * re-issuing money is that Stripe idempotency keys derive from ECONOMIC
   * IDENTITY rather than from a row id a rollback can reassign (roadmap step
   * 13). Until that exists, this makes the fork visible to a human, and says so
   * rather than implying a guarantee it does not provide.
   */
  private async recordClusterIdentity(): Promise<void> {
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ system_identifier: bigint; timeline_id: number }>
      >`
        SELECT s.system_identifier, c.timeline_id
          FROM pg_control_system() s, pg_control_checkpoint() c
      `;
      const current = rows[0];
      if (!current) return;

      const stored = await this.prisma.$queryRaw<
        Array<{ system_identifier: bigint; timeline_id: number }>
      >`
        SELECT system_identifier, timeline_id FROM ledger.cluster_identity WHERE only_row
      `;
      const previous = stored[0];

      if (!previous) {
        await this.prisma.$executeRaw`
          INSERT INTO ledger.cluster_identity (system_identifier, timeline_id)
          VALUES (${current.system_identifier}, ${current.timeline_id})
          ON CONFLICT (only_row) DO NOTHING
        `;
        this.logger.log(
          `Cluster identity recorded: system ${current.system_identifier}, timeline ${current.timeline_id}.`,
        );
        return;
      }

      if (previous.system_identifier !== current.system_identifier) {
        this.logger.error(
          `CLUSTER CHANGED. Stored system identifier ${previous.system_identifier}, ` +
            `connected to ${current.system_identifier}. This worker is pointed at a DIFFERENT ` +
            `PostgreSQL cluster than the one that owns this ledger. Investigate before allowing ` +
            `any release to run.`,
        );
        return;
      }

      if (previous.timeline_id !== current.timeline_id) {
        this.logger.warn(
          `Timeline advanced ${previous.timeline_id} → ${current.timeline_id}. This is either an ` +
            `ordinary failover (expected) or a restore (NOT expected in production). If a restore, ` +
            `confirm no second copy is still accepting postings.`,
        );
        await this.prisma.$executeRaw`
          UPDATE ledger.cluster_identity
             SET timeline_id = ${current.timeline_id}, observed_at = now()
           WHERE only_row
        `;
      }
    } catch (error) {
      // Never block boot on this. It is an observation, not a control — and
      // `pg_control_system()` is superuser-only on some managed providers.
      this.logger.warn(
        `Could not record cluster identity: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
