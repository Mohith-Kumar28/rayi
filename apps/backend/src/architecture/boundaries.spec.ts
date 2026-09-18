import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The module boundaries, asserted rather than documented.
 *
 * "The payment service is never publicly exposed" is the requirement the whole
 * topology exists to satisfy, and it is satisfied structurally — no controller,
 * no DI binding in the api graph, no database grant. But nothing in TypeScript
 * stops someone adding `import { LedgerRepository } from '@/ledger/...'` to a
 * controller, and the day that happens every other layer becomes decoration.
 *
 * So the rule is checked, AND the check is checked: each test writes a file that
 * deliberately breaks the rule and asserts the tool reports it. A boundary rule
 * that has never been seen to fail is a boundary rule nobody knows still works —
 * a typo in a regex silences it permanently and silently.
 */

const ROOT = join(__dirname, '..', '..');

interface Violation {
  rule: { name: string };
  from: string;
  to: string;
}

function cruise(extraFile?: { path: string; source: string }): Violation[] {
  let created: string | undefined;

  if (extraFile) {
    created = join(ROOT, extraFile.path);
    writeFileSync(created, extraFile.source, 'utf8');
  }

  try {
    const output = execFileSync(
      'node',
      [
        join(
          ROOT,
          'node_modules',
          'dependency-cruiser',
          'bin',
          'dependency-cruise.mjs',
        ),
        'src',
        '--config',
        join(ROOT, '.dependency-cruiser.cjs'),
        '--output-type',
        'json',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return (JSON.parse(output) as { summary: { violations: Violation[] } })
      .summary.violations;
  } catch (error) {
    // dependency-cruiser exits non-zero when it finds errors, and the JSON it
    // has already written is on stdout. That is the case we most want to read.
    const stdout = (error as { stdout?: string }).stdout;
    if (!stdout) throw error;
    return (JSON.parse(stdout) as { summary: { violations: Violation[] } })
      .summary.violations;
  } finally {
    if (created) rmSync(created, { force: true });
  }
}

const errorsOnly = (violations: Violation[]) =>
  violations.filter((violation) => violation.rule.name !== 'no-orphans');

describe('the import graph as it stands', () => {
  it('has no boundary violations', () => {
    expect(errorsOnly(cruise())).toEqual([]);
  }, 120_000);
});

describe('and the rules actually fire when broken', () => {
  it('catches a controller importing the ledger', () => {
    const violations = cruise({
      path: 'src/api/health/breach.controller.ts',
      source: [
        "import { LedgerRepository } from '@/ledger/infrastructure/ledger.repository';",
        'export const breach = LedgerRepository;',
      ].join('\n'),
    });

    expect(violations.map((violation) => violation.rule.name)).toContain(
      'ledger-is-not-http-reachable',
    );
  }, 120_000);

  it('catches a controller importing a treasury processor', () => {
    const violations = cruise({
      path: 'src/api/health/breach2.controller.ts',
      source: [
        "import { AllocateBudgetProcessor } from '@/treasury/processors/allocate-budget.processor';",
        'export const breach = AllocateBudgetProcessor;',
      ].join('\n'),
    });

    expect(violations.map((violation) => violation.rule.name)).toContain(
      'treasury-execution-is-not-http-reachable',
    );
  }, 120_000);

  it('catches a controller reaching the ledger INDIRECTLY, through a helper', () => {
    // The direct rules would miss this: the controller imports a helper, and the
    // helper imports the ledger. One indirection is all it takes, and it is what
    // a refactor produces naturally.
    const helper = 'src/api/health/breach-helper.ts';
    const created = join(ROOT, helper);
    writeFileSync(
      created,
      [
        "import { LedgerRepository } from '@/ledger/infrastructure/ledger.repository';",
        'export const helper = LedgerRepository;',
      ].join('\n'),
      'utf8',
    );

    try {
      const violations = cruise({
        path: 'src/api/health/breach3.controller.ts',
        source: [
          "import { helper } from './breach-helper';",
          'export const breach = helper;',
        ].join('\n'),
      });

      expect(violations.map((violation) => violation.rule.name)).toContain(
        'no-controller-path-to-the-ledger',
      );
    } finally {
      rmSync(created, { force: true });
    }
  }, 120_000);

  it('catches the webhook CONTROLLER importing the interpreter', () => {
    // A handler that also interprets has the provider's retry policy wired to
    // our processing time — a slow interpreter becomes a lost delivery.
    const violations = cruise({
      path: 'src/api/health/breach4.controller.ts',
      source: [
        "import { ResendWebhookService } from '@/api/webhooks/resend-webhook.service';",
        'export const breach = ResendWebhookService;',
      ].join('\n'),
    });

    expect(violations.map((violation) => violation.rule.name)).toContain(
      'webhook-interpretation-is-not-http-reachable',
    );
  }, 120_000);

  it('catches a treasury use case importing the ledger', () => {
    const violations = cruise({
      path: 'src/treasury/use-cases/breach.use-case.ts',
      source: [
        "import { LedgerRepository } from '@/ledger/infrastructure/ledger.repository';",
        'export const breach = LedgerRepository;',
      ].join('\n'),
    });

    expect(violations.map((violation) => violation.rule.name)).toContain(
      'treasury-api-half-has-no-ledger',
    );
  }, 120_000);
});
