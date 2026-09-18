import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The barrel must re-export every generated tag.
 *
 * orval emits one directory per OpenAPI tag, and `src/index.ts` is hand-written.
 * So adding a tag to the manifest produces hooks that compile, pass their own
 * typecheck, and are simply **not exported** — which surfaces as "has no
 * exported member named useListWorkspaces" inside a screen, long after the
 * contract work looked finished.
 */
function missingTags(tags: readonly string[], barrel: string): string[] {
  return tags.filter((tag) => !barrel.includes(`./generated/${tag}/${tag}.js`));
}

function generatedTags(): string[] {
  return readdirSync(join(here, 'generated'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'model')
    .map((entry) => entry.name)
    .sort();
}

describe('the api-client barrel', () => {
  it('exports every generated tag directory', () => {
    const barrel = readFileSync(join(here, 'index.ts'), 'utf8');
    const missing = missingTags(generatedTags(), barrel);
    expect(missing, `not exported from src/index.ts: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * The check, seen to fail.
   *
   * A rule that has only ever been observed passing is a rule nobody knows
   * still works — so the negative case runs the same function against a barrel
   * with a tag removed, and asserts it is caught.
   */
  it('catches a tag that is generated but not exported', () => {
    const tags = generatedTags();
    const barrel = readFileSync(join(here, 'index.ts'), 'utf8');
    const dropped = tags[0]!;
    const sabotaged = barrel.replace(`export * from './generated/${dropped}/${dropped}.js';\n`, '');

    expect(sabotaged).not.toBe(barrel);
    expect(missingTags(tags, sabotaged)).toEqual([dropped]);
  });
});
