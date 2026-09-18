import { defineConfig } from 'orval';

/**
 * Generates the typed client and TanStack Query hooks from the committed
 * OpenAPI document. Mocks are hand-written in `src/mocks.ts` rather than
 * generated, because Faker money hides the bugs a money UI needs to show.
 *
 * Everything here is generated — never hand-edit `src/generated`. The contract
 * lives in `@rayi/contracts`; this package is downstream of it, which is what
 * makes the frontend buildable before the backend exists.
 */
export default defineConfig({
  rayi: {
    input: { target: '../../openapi/openapi.json' },
    output: {
      mode: 'tags-split',
      target: './src/generated/rayi.ts',
      schemas: './src/generated/model',
      client: 'react-query',
      clean: true,
      prettier: false,
      override: {
        mutator: { path: './src/fetcher.ts', name: 'rayiFetch' },
        // signal: false — orval passes a raw AbortSignal where RequestInit belongs
        // when this is on, which does not typecheck against a custom fetch mutator.
        query: { useQuery: true, useMutation: true, signal: false },
      },
    },
  },
});
