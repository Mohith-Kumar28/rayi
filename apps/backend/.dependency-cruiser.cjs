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
      name: 'treasury-is-not-http-reachable',
      severity: 'error',
      comment:
        'THE load-bearing rule. Nothing on the public HTTP surface may import the treasury module. ' +
        'Money movement is reached only by writing a treasury_command row inside the caller\'s ' +
        'transaction; the worker picks it up. There is no synchronous path from a controller to a ' +
        'Stripe call, and this rule is what keeps it that way.',
      from: { path: '^src/(app\\.module\\.ts|main\\.ts|api/[^/]+/.*\\.controller\\.ts)$' },
      to: { path: '^src/treasury/' },
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
