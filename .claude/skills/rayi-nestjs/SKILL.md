---
name: rayi-nestjs
description: NestJS structure, naming and code standards for the Rayi backend — folder layout, file naming, module boundaries, layering, DI, errors, testing. Use whenever writing or reviewing anything under apps/backend, or adding a controller, service, module, guard, interceptor, DTO or job handler.
---

# NestJS standards for Rayi

Pairs with the installed `nestjs-best-practices` skill, which covers general Nest correctness. This
one covers **our** structure and the money-specific rules it cannot know about.

Rayi moves other people's money. The bar is not "clean code" in the abstract — it is that a reviewer
can tell quickly that a change cannot cause a wrong payment.

## 1. Layout — standard mode, not Nest monorepo mode

```
apps/backend/
  nest-cli.json            standard mode. NO "monorepo": true
  src/
    main.api.ts            three bootstraps, ONE image
    main.webhooks.ts
    main.worker.ts
    api.module.ts          one root module per process
    webhooks.module.ts
    worker.module.ts
    common/                stateless helpers. NO module.
      decorators/ filters/ guards/ interceptors/ pipes/
    core/                  app-wide singletons, wired once. HAS modules.
      core.module.ts
      config/ health/
    modules/               business domain, one folder per feature
      funding/
        funding.module.ts
        domain/            entities, invariants — NO framework imports
        use-cases/         application logic — NO framework imports
        infrastructure/    controllers, repositories, dto/ — the framework edge
        public/            the narrow interface other modules may depend on
  test/                    *.e2e-spec.ts
```

**Why standard mode.** Nest CLI monorepo mode (`"monorepo": true`, `apps/` + `libs/`) is what the
docs present, but **none of the five largest open-source Nest codebases use it** — Immich,
Ghostfolio, Novu, Twenty and Amplication all run Nest in standard mode inside Nx or pnpm workspaces.
We already have pnpm workspaces and Turborepo, which is the same shape. Monorepo mode would add a
second, weaker workspace system on top with no task graph and no caching.

**`common/` vs `core/`** is the official split, from Nest's own `sample/01-cats-app`:
- `common/` — stateless, dependency-free: guards, filters, decorators, pipes, interfaces. No module;
  import the files directly.
- `core/` — instantiated once and has a module: configuration, logging, persistence. Imported by each
  root module and nothing else.

**Do not use `shared/` or `SharedModule`.** Extremely common in blog posts, appears nowhere in
official Nest material.

**`packages/` is code shared with the frontend** (`domain`, `contracts`, `api-client`). Anything the
browser will never import belongs in `apps/backend/src/`.

## 2. Naming — the CLI enforces most of this

| Thing | Rule |
| --- | --- |
| Files | **kebab-case**, always. `normalizeToKebabOrSnakeCase` in the schematics forces it |
| Classes | **PascalCase + matching suffix**: `user-profile.service.ts` → `UserProfileService` |
| Suffixes | `.module .controller .service .guard .interceptor .pipe .filter .decorator .middleware .strategy` |
| DTO folder | **`dto/`** — singular — inside the feature folder |
| Entity folder | **`entities/`** — plural. Yes, the asymmetry is real and it is what the generator emits |
| DTO files | singular, operation-named: `create-user.dto.ts`, `get-details.dto.ts`. Class is `CreateUserDto` — `Dto`, not `DTO` |
| Unit tests | `*.spec.ts`, **colocated** next to the subject |
| E2E tests | `test/*.e2e-spec.ts` |

`*.repository.ts` has no schematic and no official mention — it is community convention, and we use
it. `*.strategy.ts` is canonical by documentation example (the Passport recipe), not by schematic.

Note: the docs bless **`.spec` or `.test`**. We standardise on `.spec.ts` only so we match what
`nest g` emits and never end up with a mix.

## 3. Feature modules are mandatory

**Never register a controller or provider directly on a root module.** Every feature gets a
`*.module.ts` that declares its own controllers and providers, and the root module imports it. A
controller attached straight to `ApiModule` has no boundary and cannot be tested or replaced
independently. The `nestjs-best-practices` skill rates this CRITICAL and it is the easiest rule to
break by accident.

**The `exports` array is the module's published API.** Keep it deliberately small — an exported
provider is one you can no longer refactor freely. Prefer exporting a single application service
over a repository, ever.

**Per-module layering, not global layers.** `src/domain/` + `src/infrastructure/` at app level gives
you one giant folder and no tool can tell you that `funding` reached into `treasury`. Layers inside
each module make "treasury is unreachable" a *path* rule a linter enforces.

## 4. Module boundaries are enforced in CI

`.dependency-cruiser.cjs` is the gate, run by `pnpm --filter @rayi/backend depcruise`. Nest's module
encapsulation is a **DI** boundary, not an **import** boundary — nothing stops a file importing
another module's service class directly, or reaching in for a type or a constant.

Rules that must stay green:
- `no-circular` at **error**. Cycles are cheap to prevent and expensive to unwind at 40 modules.
- `domain-is-framework-free` / `use-cases-are-framework-free` — no `@nestjs/*` in either.
- `no-cross-module-imports` — a feature may only reach another feature's `public/`.
- `treasury-is-not-http-reachable` — no controller, `api.module.ts` or `main.api.ts` may import
  `modules/treasury/`. **This is the load-bearing rule.**
- `common-does-not-know-about-features`.

Treasury isolation is four independent layers, because any one can be defeated:
1. the dependency-cruiser path rule,
2. `TreasuryModule` imported only by `worker.module.ts`,
3. a test asserting the treasury token is unresolvable in the api graph,
4. a distinct Postgres role with no write grant on ledger tables.

## 5. Circular dependencies

**`forwardRef()` is banned.** It does not remove the cycle, it tells Nest to tolerate it, and the
cycle stays in your module graph. Fix in this order:

1. **Extract the shared thing into a third module.** A↔B becomes A→C←B. Almost always right — the
   cycle usually exists because a type or constant belongs to neither.
2. **Invert with a port.** The lower module declares an interface; the higher provides the
   implementation; the DI token breaks the compile-time edge.
3. **Replace a call with an event.** Only for side effects you can afford to lose —
   `@nestjs/event-emitter` is in-memory and non-durable.
4. `ModuleRef` — never on the money path. It hides the dependency from the constructor and from the
   graph.

**Barrel files (`index.ts`) are banned for modules and providers.** Nest's docs warn about this
explicitly: a barrel forces a whole directory to evaluate before any file finishes, so a class
reference inside `@Module({ providers: [...] })` can be `undefined` when the decorator runs. The
symptom is the opaque `Nest can't resolve dependencies of the XService (?)` with no useful stack.
Barrels are acceptable only at a library's *outer* boundary, never for intra-directory imports.

## 6. Layering — four layers, one direction

```
Controller → Application service → Domain → Repository port
                                                  ↑
                                        Adapter (Prisma, Stripe)
```

- **Controller**: HTTP only. Parse, delegate, shape the response. No business logic, no money
  conditionals, no database access. Longer than ~10 lines means logic has leaked in.
- **Application service** (`use-cases/`): the transaction and authorization boundary. One public
  method per use case, named for the use case (`allocateBudget`, not `update`).
- **Domain**: pure. No `@nestjs/*`, no `@prisma/*`, no `stripe`, no clock, no randomness.
- **Repository**: the only place SQL lives. Returns domain types, never Prisma models.

**Ports for aggregates, direct Prisma for reads.** A repository wrapping `findMany` is the thin leaky
wrapper the critics are right about. A repository that enforces balanced double-entry and takes row
locks is hiding real complexity and earns its place. Repository methods are **named by intent**
(`findUnsettledForOrg`), never `find(condition)`.

## 7. Dependency injection

- Constructor injection only. No property injection, no service locator.
- **Inject by explicit token** — `@Inject(Reflector)` — on anything that must be constructible in a
  test. esbuild, and therefore vitest, does not emit decorator metadata, so type-inferred injection
  fails there.
- Ports are a **plain interface plus a `Symbol` token exported from the same file**. Symbols, not
  strings: two modules using the same string token collide silently.
- **No request-scoped providers on the money path.** They disable singleton optimisation and
  propagate scope up the whole injection chain. Use `nestjs-cls` for request context.
- **Dynamic modules** follow the Nest convention: `forRoot`/`forRootAsync` for configure-once,
  `forFeature` for per-feature scoping, `register`/`registerAsync` where each registration is
  independent. `CoreModule.forRole('api')` is ours.

## 8. Configuration

Validated by Zod at boot; `loadConfig` throws, so a misconfigured process dies before binding a port.

**The role is a property of the entrypoint, not the environment.** `CoreModule.forRole('api')` — not
an env var — so a misconfigured task definition cannot start the api process with worker permissions.

**Per-role secret rules are enforced in the schema**: `api` and `webhooks` refuse to boot if a full
`sk_` Stripe key is present; only `worker` may hold one. That is what makes "an RCE in api cannot
move money" true rather than aspirational.

`process.env` is read in `config.schema.ts` and nowhere else.

## 9. Errors

- Throw **domain errors** from the domain (`InsufficientFundsError`), never `HttpException` — the
  domain must not know what HTTP is.
- One global `ProblemFilter` maps to RFC 9457 `application/problem+json`. Clients branch on the
  stable `code`; `title` and `detail` are free to be reworded.
- **Never leak internals.** An unknown error becomes a generic 500 with a request id.
- **Never swallow an error on a money path.** No empty `catch`.

## 10. Money and the worker

- The api process **never moves money inline.** It validates, writes a `treasury_command` row and
  enqueues the job in **one transaction**, returns `202`. See [[rayi-prisma-ledger]].
- **No external call inside a database transaction** — no Stripe, no HTTP, no notification.
- The worker **re-derives authorization from the database** before any Stripe call: a weekly sweep or
  a 7–14 day timer runs long after the request, when the approver may have been removed.
- A job payload is **a pointer, never an instruction**. Re-read authoritative state.

## 11. Versions

- **NestJS ≥ 11.2.5.** Four 2026 CVEs sit below 11.1.19, including an authz bypass (CVE-2026-2293,
  CVSS 9.8) and a DoS (CVE-2026-40879). Re-check before launch.
- **Nest 12 shipped 2026-08-27** with native Standard Schema (`@Body({ schema })`), ESM, and Vitest
  by default. Do **not** adopt it yet — too new for a payments backend, and the ecosystem is lagging.
  Write the Zod validation pipe by hand now so the eventual migration is a mechanical swap.
- **Path aliases only survive `nest build`**, which rewrites them to relative paths. Plain `tsc`,
  `ts-node`, vitest and Dockerfiles that call `tsc` directly will break at runtime. We use relative
  imports to sidestep this entirely.

## 12. Banned

- `any`; `as` to silence an error rather than narrow a known type.
- `@ts-ignore` (use `@ts-expect-error` with a reason, tests only).
- Business logic in a controller, guard or interceptor.
- `forwardRef()`.
- Barrel files for modules/providers.
- A controller registered directly on a root module.
- Reading tenant scope from the session.
- A raw balance-adjustment endpoint. Corrections are reversing ledger entries with a reason code.
- `process.env` outside `config.schema.ts`.
