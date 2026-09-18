/**
 * Emits openapi.json from the operation manifest, or verifies the committed
 * copy still matches (`--check`).
 *
 * The --check mode is the drift gate: CI runs it, so changing a contract
 * without regenerating the spec fails the build rather than silently shipping
 * a document that disagrees with the server.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_OPERATIONS, buildOpenApiDocument } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../../../openapi/openapi.json');

const document = buildOpenApiDocument(ALL_OPERATIONS, {
  title: 'Rayi API',
  version: '0.1.0',
  description:
    'Conditional payment rail for brand and creator collaborations. Money crosses this API as ' +
    'integer minor units in a string, never as a JSON number.',
});

const serialised = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(outputPath)) {
    console.error(`openapi.json is missing at ${outputPath}. Run: pnpm --filter @rayi/contracts emit:openapi`);
    process.exit(1);
  }
  const committed = readFileSync(outputPath, 'utf8');
  if (committed !== serialised) {
    console.error(
      'openapi.json is out of date with the operation manifest.\n' +
        'Run: pnpm --filter @rayi/contracts emit:openapi',
    );
    process.exit(1);
  }
  console.log(`openapi.json matches the manifest (${ALL_OPERATIONS.length} operations).`);
  process.exit(0);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, serialised);
console.log(`Wrote ${outputPath} (${ALL_OPERATIONS.length} operations).`);
