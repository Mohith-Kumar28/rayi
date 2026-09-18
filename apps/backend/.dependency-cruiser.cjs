/**
 * Module boundary enforcement.
 *
 * Nest's own module system gives runtime DI encapsulation — a provider is
 * private unless exported. That is genuinely useful, but it is NOT an import
 * boundary: nothing stops a file from `import`ing another module's service
 * directly, or reaching in for a type, an enum or a constant.
 *
 * For a system whose central claim is "the treasury is unreachable from the
 * public HTTP surface", a DI boundary is not enough. These rules make it a
 * property of the import graph, checked in CI.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies are the most common cause of "Nest can\'t resolve dependencies of X (?)" ' +
        'at runtime. forwardRef() hides the cycle rather than removing it — extract the shared concept ' +
        'into a third module instead.',
      from: {},
      to: { circular: true },
    },

    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'A file nothing imports is usually a leftover from a refactor.',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)tsconfig\\.', '(^|/)\\.dependency-cruiser\\.cjs$'] },
      to: {},
    },

    {
      name: 'domain-is-framework-free',
      severity: 'error',
      comment:
        'A module\'s domain layer holds invariants and must stay testable without booting Nest. ' +
        'If it needs a framework import, the logic belongs in use-cases or infrastructure.',
      from: { path: '^src/api/[^/]+/domain/' },
      to: { path: 'node_modules/@nestjs/' },
    },

    {
      name: 'use-cases-are-framework-free',
      severity: 'error',
      comment:
        'Application logic depends on ports, not on Nest. Inject the adapter at the module edge instead.',
      from: { path: '^src/api/[^/]+/use-cases/' },
      to: { path: 'node_modules/@nestjs/' },
    },

    {
      name: 'no-cross-module-imports',
      severity: 'error',
      comment:
        'A feature module may not reach into another feature module. Depend on its public/ interface ' +
        'and wire the dependency in the .module.ts file. The capture group makes same-module imports pass.',
      from: { path: '^src/api/([^/]+)/', pathNot: '^src/api/[^/]+/[^/]+\\.module\\.ts$' },
      to: {
        path: '^src/api/([^/]+)/',
        pathNot: ['^src/api/$1/', '^src/api/[^/]+/public/'],
      },
    },

    {
      name: 'treasury-execution-is-not-http-reachable',
      severity: 'error',
      comment:
        'THE load-bearing rule. Nothing reachable from the public HTTP surface may import the code ' +
        'that EXECUTES money movement — the processors, the worker module, or the queue listener. ' +
        'The API is allowed to import treasury USE CASES, because all they do is write a ' +
        'treasury_command row inside the caller\'s transaction; that is the intended and only path. ' +
        'What must not exist is a synchronous route from a controller to a ledger posting or a ' +
        'Stripe call, and this rule is what keeps it from being added by accident.',
      from: {
        path: '^src/(app\\.module\\.ts|main\\.ts|api/)',
      },
      to: {
        path: '^src/treasury/(processors/|treasury-worker\\.module\\.ts$|treasury-command\\.listener\\.ts$)',
      },
    },

    {
      name: 'webhook-interpretation-is-not-http-reachable',
      severity: 'error',
      comment:
        'A webhook handler that also interprets the delivery has the PROVIDER\'s retry policy wired ' +
        'to our processing time: a slow interpreter becomes a timeout, a timeout becomes a retry, ' +
        'and a bug becomes a lost delivery once the provider gives up. For Stripe that is a ' +
        'three-day fuse on a silent money bug. So the controller may store a delivery and nothing ' +
        'more; the worker reads it back.',
      from: {
        path: '^src/(app\\.module\\.ts|main\\.ts|api/(?!webhooks/webhooks-worker\\.module|webhooks/resend-webhook\\.(service|poller)))',
      },
      to: {
        path: '^src/api/webhooks/(resend-webhook\\.service|resend-webhook\\.poller|webhooks-worker\\.module)',
      },
    },

    {
      name: 'ledger-is-not-http-reachable',
      severity: 'error',
      comment:
        'The api process must have no ledger call site at all. This mirrors the database privilege ' +
        'boundary — the rayi_api role holds no grants on the ledger schema — so the same statement is ' +
        'true at three independent layers: no import, no DI binding, no SQL privilege. A rule that ' +
        'held at only one of them would be one refactor from being false.',
      from: {
        path: '^src/(app\\.module\\.ts|main\\.ts|api/)',
      },
      to: { path: '^src/ledger/' },
    },

    {
      name: 'treasury-api-half-has-no-ledger',
      severity: 'error',
      comment:
        'TreasuryModule and its use cases are bound into the api graph, so they are held to the same ' +
        'rule as the controllers that call them. A use case that imported the ledger repository would ' +
        'defeat the split while still looking correct in the module file.',
      from: {
        path: '^src/treasury/(use-cases/|treasury\\.module\\.ts$)',
      },
      to: { path: '^src/ledger/' },
    },

    {
      name: 'no-controller-path-to-the-ledger',
      severity: 'error',
      comment:
        'TRANSITIVE, not just direct. The rules above forbid a controller importing the ledger ' +
        'outright; this one forbids it reaching the ledger through any chain of imports at all — a ' +
        'helper, a shared type file, a barrel. Money movement must not be callable from a request ' +
        'thread by any route, however indirect. ' +
        'Note what is deliberately NOT asserted here: app.module.ts statically imports the worker ' +
        'module, because both processes are built from one image, so the processor CODE is loaded in ' +
        'the api process. What must not exist is a way to REACH it — no DI binding in the api graph ' +
        '(asserted by test), no route, no Stripe credential, and no database grant.',
      from: { path: '\\.controller\\.ts$', pathNot: '\\.spec\\.ts$' },
      to: { path: '^src/ledger/', reachable: true },
    },

    {
      name: 'common-does-not-know-about-features',
      severity: 'error',
      comment:
        'common/ holds stateless helpers used by everything. If it imports a feature module it is not ' +
        'common, and it has created a cycle waiting to happen.',
      from: { path: '^src/common/' },
      to: { path: '^src/api/' },
    },

    {
      name: 'no-deprecated-core',
      severity: 'error',
      comment: 'Deprecated Node core APIs.',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|sys)$' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
