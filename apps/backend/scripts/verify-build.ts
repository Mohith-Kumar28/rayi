/**
 * Asserts the BUILT output can do what the source can.
 *
 * `nest build` compiles `.ts` only — its swc builder hardcodes
 * `extensions ?? ['.ts']` and exposes no flag to change it. The React Email
 * templates are `.tsx`, so they were silently absent from `dist` while every
 * unit test passed, every typecheck passed, and the build reported success. The
 * first symptom would have been a worker crashing on its first outbound email,
 * in production, on the sign-in path.
 *
 * A separate `build:templates` step fixes it. This verifies the fix rather than
 * trusting it — because the failure mode is "a file is missing", which nothing
 * that runs against `src` can ever see.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(__dirname, '..', 'dist');

const REQUIRED = [
  'shared/mail/templates/signin-magic-link.js',
  'shared/mail/templates/email-verification.js',
  'shared/mail/templates/reset-password.js',
  'shared/mail/templates/layout.js',
  'shared/mail/mail.service.js',
  'main.js',
];

function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`\nBuild verification FAILED: ${message}\n`);
  process.exit(1);
}

for (const file of REQUIRED) {
  if (!existsSync(join(DIST, file))) {
    fail(
      `dist/${file} is missing. If it is a .tsx file, \`nest build\` did not compile it — ` +
        `that is what \`pnpm build:templates\` exists for.`,
    );
  }
}

// Presence is not enough: a template that compiled but throws on render is the
// same outage. Render one for real, from the built artifact.
async function main(): Promise<void> {
  const { render } = (await import('@react-email/render')) as {
    render: (el: unknown) => Promise<string>;
  };
  const mod = require(join(DIST, 'shared/mail/templates/signin-magic-link.js')) as {
    default: (props: { email: string; url: string }) => unknown;
  };

  const html = await render(
    mod.default({ email: 'build-check@rayi.test', url: 'https://app.rayi.test/verify' }),
  );

  if (!html.includes('build-check@rayi.test')) {
    fail('The built magic-link template rendered without its props.');
  }
  if (!html.includes('https://app.rayi.test/verify')) {
    fail('The built magic-link template rendered without its destination URL.');
  }
  // The handlebars placeholders that used to be default prop values. If one ever
  // comes back, it ships to a user as literal text.
  if (html.includes('{{')) {
    fail('The built template contains an un-interpolated {{placeholder}}.');
  }

  // eslint-disable-next-line no-console
  console.log(`Build verified: ${REQUIRED.length} required files present, templates render.`);
}

void main();
