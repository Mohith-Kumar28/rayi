/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

// The key lives in .env.worker (worker-only), everything else in .env. First
// file wins; a variable already in the real environment beats both.
loadEnv({ path: ['.env.worker', '.env'], quiet: true });

import Stripe from 'stripe';

/**
 * Stripe preflight.
 *
 * Answers, against the real account, the questions this project has written
 * decisions around — and which are otherwise answered by someone squinting at a
 * dashboard and remembering wrong three weeks later.
 *
 * **Nothing here reads a key from anywhere but the environment**, and nothing
 * prints one. A secret that passes through a terminal, a CI log or a chat
 * transcript has been disclosed, whatever happens next.
 *
 *   pnpm --filter @rayi/backend verify:stripe
 *
 * Exit codes: 0 everything expected, 1 something is wrong and is named.
 */

type Level = 'ok' | 'warn' | 'fail' | 'info';

const findings: Array<{ level: Level; title: string; detail: string }> = [];

function record(level: Level, title: string, detail: string) {
  findings.push({ level, title, detail });
}

/** Redacts a key to its prefix and last four. Never the middle. */
function fingerprint(key: string): string {
  const prefix = key.slice(0, key.indexOf('_', key.indexOf('_') + 1) + 1);
  return `${prefix}…${key.slice(-4)}`;
}

async function main(): Promise<number> {
  const secretKey = process.env['STRIPE_SECRET_KEY']?.trim();
  const restrictedKey = process.env['STRIPE_RESTRICTED_KEY']?.trim();
  const platformSecret = process.env['STRIPE_WEBHOOK_SECRET_PLATFORM']?.trim();
  const connectSecret = process.env['STRIPE_WEBHOOK_SECRET_CONNECT']?.trim();

  if (!secretKey) {
    console.error(
      'STRIPE_SECRET_KEY is not set.\n\n' +
        'Get a TEST key from https://dashboard.stripe.com/test/apikeys and put it in\n' +
        'apps/backend/.env — never anywhere it would be committed or logged:\n\n' +
        '  STRIPE_SECRET_KEY=sk_test_...\n',
    );
    return 1;
  }

  // --- Shape, before anything is sent anywhere ---------------------------

  if (!/^sk_(test|live)_/.test(secretKey)) {
    record('fail', 'STRIPE_SECRET_KEY is not a secret key', 'It must begin sk_test_ or sk_live_.');
    return report();
  }

  const live = secretKey.startsWith('sk_live_');
  record(
    live ? 'warn' : 'ok',
    `Using a ${live ? 'LIVE' : 'test'} key (${fingerprint(secretKey)})`,
    live
      ? 'This talks to real money. Every check below is read-only, but stop and be sure you meant to.'
      : 'Test mode. Nothing here can move real money.',
  );

  if (restrictedKey && !/^rk_(test|live)_/.test(restrictedKey)) {
    record(
      'fail',
      'STRIPE_RESTRICTED_KEY is not a restricted key',
      'It must begin rk_. A full sk_ here defeats the point of the api process holding a weaker key.',
    );
  }

  if (restrictedKey && restrictedKey.startsWith('rk_live_') !== live) {
    // One key from each mode is how you end up writing test data against a live
    // account, or wondering why a live webhook never matches.
    record(
      'fail',
      'The secret and restricted keys are from different modes',
      'One is live and the other is test.',
    );
  }

  /*
   * No explicit `apiVersion`.
   *
   * The SDK is pinned to an exact version, and each SDK release pins the API
   * version it was built against — so the pin lives in one place. Naming a
   * version here too means two pins that can disagree, and the way you find
   * out is a field that silently stops being returned.
   */
  const stripe = new Stripe(secretKey);

  // --- The account itself -------------------------------------------------

  // `retrieve(null)` is the platform's OWN account — the one this key belongs to.
  const account = await stripe.accounts.retrieve(null);
  record(
    'info',
    `Account ${account.id}`,
    `${account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? 'unnamed'} · ${account.country ?? '??'} · ${account.default_currency?.toUpperCase() ?? '??'}`,
  );

  if (account.country !== 'US') {
    record(
      'warn',
      `The account country is ${account.country}`,
      'ACH Direct Debit, the 2-year hold limit and the return windows this project is built on are US facts.',
    );
  }

  // --- Capabilities we actually depend on ---------------------------------

  const capabilities = (account.capabilities ?? {}) as Record<string, string | undefined>;
  for (const [capability, why] of [
    ['us_bank_account_ach_payments', 'Brands fund by ACH. Without it there is no funding path at all.'],
    ['transfers', 'Releasing a milestone is a Transfer to a connected account.'],
  ] as const) {
    const state = capabilities[capability];
    record(
      state === 'active' ? 'ok' : 'fail',
      `Capability ${capability}: ${state ?? 'not requested'}`,
      why,
    );
  }

  // --- Payout schedule MUST be manual -------------------------------------
  //
  // Not a preference. Stripe warns that automatic payouts interfere with
  // transfers that have no `source_transaction`, and this design deliberately
  // has none — no transfer happens until `charge.succeeded`, then it is paid
  // from the available balance. An automatic schedule sweeps the balance those
  // transfers draw on.
  const schedule = account.settings?.payouts?.schedule?.interval;
  record(
    schedule === 'manual' ? 'ok' : 'fail',
    `Platform payout schedule: ${schedule ?? 'unknown'}`,
    schedule === 'manual'
      ? 'Correct. Payouts are swept deliberately, not on Stripe’s schedule.'
      : 'Must be MANUAL. Automatic payouts sweep the balance that milestone transfers are paid from, ' +
        'and Stripe documents the interference. Change it at dashboard.stripe.com/settings/payouts.',
  );

  // --- Webhooks: TWO endpoints, TWO secrets --------------------------------

  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });

  /*
   * Endpoints are classified by the EVENTS they listen for, not by a flag.
   *
   * `connect: true` is a create parameter and is not returned on the object, so
   * there is nothing to read. That turns out to be the better check anyway: what
   * matters is not "is this endpoint marked Connect" but "is anything listening
   * for the events this design depends on". An endpoint that exists and is
   * subscribed to the wrong events is indistinguishable from no endpoint at all,
   * and fails exactly as silently.
   */
  const REQUIRED_EVENTS: Array<{ event: string; why: string }> = [
    {
      event: 'charge.succeeded',
      why: 'No transfer may happen before this. Releasing earlier means Stripe covers it from our own balance.',
    },
    {
      event: 'charge.dispute.created',
      why: 'An ACH RETURN arrives here — not as charge.failed. A guard on charge.failed is aimed at an event that never fires.',
    },
    {
      event: 'account.updated',
      why: 'The only signal that a creator changed their payout destination. Without it there is no 72-hour hold.',
    },
    { event: 'payout.paid', why: 'Tells a creator their money actually arrived.' },
    { event: 'payout.failed', why: 'Tells us it did not.' },
    {
      event: 'transfer.reversed',
      why: 'The clawback path when an ACH return lands after a release.',
    },
  ];

  const subscribed = new Set(
    endpoints.data
      .filter((endpoint) => endpoint.status === 'enabled')
      .flatMap((endpoint) =>
        endpoint.enabled_events.includes('*') ? REQUIRED_EVENTS.map((r) => r.event) : endpoint.enabled_events,
      ),
  );

  record(
    'info',
    `${endpoints.data.length} webhook endpoint(s) registered`,
    endpoints.data.map((endpoint) => `${endpoint.url} [${endpoint.status}]`).join('\n          ') ||
      'None. Run `stripe listen --forward-to localhost:3000/webhooks/stripe` while developing.',
  );

  if (endpoints.data.length === 0 && !live) {
    /*
     * Normal in development, not a failure.
     *
     * `stripe listen` forwards events to localhost without any endpoint being
     * registered — localhost cannot BE a registered endpoint. Reporting six
     * failures here would train whoever runs this to ignore the output, which
     * is the opposite of what a preflight is for. In LIVE mode the same state
     * is a failure, and is reported as one below.
     */
    record(
      'warn',
      'No registered endpoint — expected in development',
      'Forward events with `stripe listen --forward-to localhost:8000/api/webhooks/stripe` (and ' +
        '`--forward-connect-to` for Connect). Register real endpoints before going live.',
    );
  } else {
    for (const { event, why } of REQUIRED_EVENTS) {
      record(
        subscribed.has(event) ? 'ok' : 'fail',
        `Listening for ${event}`,
        subscribed.has(event) ? '' : why,
      );
    }
  }

  if (!platformSecret || !connectSecret) {
    record(
      'fail',
      'A webhook signing secret is missing',
      'TWO endpoints means TWO secrets. Using the platform secret for Connect rejects every Connect ' +
        'delivery, silently.',
    );
  } else if (platformSecret === connectSecret) {
    record(
      'fail',
      'The platform and Connect webhook secrets are identical',
      'They are different endpoints with different secrets. One of these is wrong.',
    );
  } else {
    record('ok', 'Two distinct webhook signing secrets are set', '');
  }

  /*
   * Does this account have a dispute window we can observe?
   *
   * An ACH return arrives as `charge.dispute.created`, NOT `charge.failed` —
   * guards written against the latter are aimed at an event that never fires.
   * Nothing here can prove the event shape, but a count of existing disputes
   * tells an operator whether they have ever seen one.
   */
  const disputes = await stripe.disputes.list({ limit: 1 });
  record(
    'info',
    `${disputes.has_more ? 'More than 1' : disputes.data.length} dispute(s) on this account`,
    'ACH returns arrive here, as disputes — not as charge.failed.',
  );

  return report();
}

function report(): number {
  const icon: Record<Level, string> = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ', info: ' ---- ' };
  console.log('\nStripe preflight\n');
  for (const finding of findings) {
    console.log(`[${icon[finding.level]}] ${finding.title}`);
    if (finding.detail) console.log(`          ${finding.detail}`);
  }

  const failures = findings.filter((finding) => finding.level === 'fail').length;
  const warnings = findings.filter((finding) => finding.level === 'warn').length;
  console.log(
    `\n${failures} failing, ${warnings} to look at, ` +
      `${findings.filter((f) => f.level === 'ok').length} fine.\n`,
  );
  return failures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // Stripe puts the useful part in `message`. The key is never in it, but do
    // not print the whole error object in case a future SDK version changes that.
    console.error(`\nStripe preflight could not run: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
