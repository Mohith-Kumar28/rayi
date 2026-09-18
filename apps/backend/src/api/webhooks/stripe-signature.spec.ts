import { createHmac } from 'node:crypto';

import { verifySvixSignature } from './svix-signature';
import { verifyStripeSignature } from './stripe-signature';

/**
 * Stripe's signature scheme.
 *
 * Written as attacks, like the Svix tests — and with one extra job: proving that
 * the two schemes are genuinely different, so a refactor that "unifies" them
 * fails here rather than in production, where it would reject every delivery and
 * look like an attack.
 */

const SECRET = 'whsec_test_secret_value_for_stripe';
const BODY = JSON.stringify({ id: 'evt_1', type: 'charge.succeeded' });

function sign(options: { body?: string; timestamp?: number; secret?: string } = {}) {
  const body = options.body ?? BODY;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const secret = options.secret ?? SECRET;

  // The secret AS-IS, the whole `whsec_...` string.
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  return { body, header: `t=${timestamp},v1=${signature}` };
}

function verify(signed: { body: string; header: string }, overrides: Record<string, unknown> = {}) {
  return verifyStripeSignature({ body: signed.body, header: signed.header, secret: SECRET, ...overrides });
}

describe('a genuine delivery', () => {
  it('verifies', () => {
    expect(verify(sign())).toEqual({ ok: true });
  });

  it('verifies a body with unicode and newlines', () => {
    expect(verify(sign({ body: '{"note":"café \\n line"}' }))).toEqual({ ok: true });
  });

  it('ignores an unknown scheme alongside a valid v1', () => {
    // A future scheme must not break an endpoint that correctly verifies the
    // version it understands.
    const signed = sign();
    const withV0 = { ...signed, header: `${signed.header},v0=deadbeef` };
    expect(verify(withV0)).toEqual({ ok: true });
  });
});

describe('THE difference from Svix', () => {
  it('uses the secret AS-IS, not base64-decoded after stripping whsec_', () => {
    // Svix strips `whsec_` and base64-decodes the remainder. Stripe does
    // neither. Signing the Svix way must NOT verify the Stripe way — this is the
    // assertion that stops a well-meaning refactor unifying them.
    const timestamp = Math.floor(Date.now() / 1000);
    const svixStyleKey = Buffer.from(SECRET.replace('whsec_', ''), 'base64');
    const wrong = createHmac('sha256', svixStyleKey)
      .update(`${timestamp}.${BODY}`)
      .digest('hex');

    expect(verify({ body: BODY, header: `t=${timestamp},v1=${wrong}` })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('signs a different string than Svix does', () => {
    // Svix signs `{id}.{timestamp}.{body}`; Stripe signs `{timestamp}.{body}`.
    // A shared implementation would get one of them wrong.
    const timestamp = Math.floor(Date.now() / 1000);
    const svixStyle = createHmac('sha256', SECRET)
      .update(`msg_1.${timestamp}.${BODY}`)
      .digest('hex');

    expect(verify({ body: BODY, header: `t=${timestamp},v1=${svixStyle}` })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('a Stripe-signed request does not verify as Svix', () => {
    // The reverse direction, so neither verifier can be quietly swapped for the
    // other.
    const signed = sign();
    const timestamp = signed.header.match(/t=(\d+)/)![1]!;
    const signature = signed.header.match(/v1=([a-f0-9]+)/)![1]!;

    expect(
      verifySvixSignature({
        body: signed.body,
        headers: {
          id: 'msg_1',
          timestamp,
          signature: `v1,${Buffer.from(signature, 'hex').toString('base64')}`,
        },
        secret: SECRET,
      }).ok,
    ).toBe(false);
  });

  it('encodes the signature as HEX, where Svix uses base64', () => {
    const signed = sign();
    expect(signed.header).toMatch(/v1=[a-f0-9]{64}$/);
  });
});

describe('a tampered delivery', () => {
  it('rejects a changed body', () => {
    const signed = sign();
    expect(verify({ ...signed, body: JSON.stringify({ id: 'evt_2' }) })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a changed timestamp', () => {
    const signed = sign();
    const bumped = signed.header.replace(/t=(\d+)/, (_m, t: string) => `t=${Number(t) + 1}`);
    expect(verify({ ...signed, header: bumped })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a signature made with a different secret', () => {
    expect(verify(sign({ secret: 'whsec_a_completely_different_secret' }))).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a body re-serialised from parsed JSON', () => {
    // The most common way to break this: signing over
    // `JSON.stringify(request.body)` instead of the raw bytes.
    const raw = '{ "id": "evt_1" }';
    const signed = sign({ body: raw });
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    expect(verify({ ...signed, body: reserialised })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });
});

describe('replay protection', () => {
  it('rejects a delivery older than the tolerance', () => {
    // Stripe retries for three days. Without this, a captured delivery stays
    // usable indefinitely.
    expect(verify(sign({ timestamp: Math.floor(Date.now() / 1000) - 3600 }))).toEqual({
      ok: false,
      reason: 'timestamp_too_old',
    });
  });

  it('accepts one just inside the tolerance', () => {
    expect(verify(sign({ timestamp: Math.floor(Date.now() / 1000) - 240 }))).toEqual({ ok: true });
  });

  it('rejects one from the future', () => {
    expect(verify(sign({ timestamp: Math.floor(Date.now() / 1000) + 3600 }))).toEqual({
      ok: false,
      reason: 'timestamp_in_future',
    });
  });
});

describe('secret rotation', () => {
  it('accepts when ANY offered signature is valid', () => {
    // Stripe sends several `v1` entries while an endpoint secret is rotating.
    // A dropped delivery here is a money event we never see.
    const signed = sign();
    const withNoise = { ...signed, header: `${signed.header},v1=${'0'.repeat(64)}` };
    expect(verify(withNoise)).toEqual({ ok: true });

    const noiseFirst = {
      ...signed,
      header: signed.header.replace('v1=', `v1=${'0'.repeat(64)},v1=`),
    };
    expect(verify(noiseFirst)).toEqual({ ok: true });
  });

  it('still rejects when every offered signature is wrong', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    expect(
      verify({
        body: BODY,
        header: `t=${timestamp},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`,
      }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
});

describe('malformed input fails closed', () => {
  it('rejects a missing header', () => {
    expect(verifyStripeSignature({ body: BODY, header: undefined, secret: SECRET })).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it('rejects a header with no timestamp', () => {
    expect(verify({ body: BODY, header: `v1=${'0'.repeat(64)}` })).toEqual({
      ok: false,
      reason: 'malformed_signature',
    });
  });

  it('rejects a header with no v1 entry', () => {
    // A CURRENT timestamp, so the timestamp check passes and the missing-v1
    // check is what actually fires. The cheap checks run first by design.
    const timestamp = Math.floor(Date.now() / 1000);
    expect(verify({ body: BODY, header: `t=${timestamp},v0=abc` })).toEqual({
      ok: false,
      reason: 'no_v1_signature',
    });
  });

  it('rejects a non-numeric timestamp', () => {
    expect(verify({ body: BODY, header: `t=yesterday,v1=${'0'.repeat(64)}` })).toEqual({
      ok: false,
      reason: 'malformed_timestamp',
    });
  });

  it('rejects an empty secret rather than signing with nothing', () => {
    expect(verify(sign(), { secret: '  ' })).toEqual({ ok: false, reason: 'empty_secret' });
  });

  it('rejects a short signature without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch. A short signature must be a
    // clean rejection, not a 500 that tells an attacker they found an edge.
    const timestamp = Math.floor(Date.now() / 1000);
    expect(verify({ body: BODY, header: `t=${timestamp},v1=abcd` })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('never throws on arbitrary header garbage', () => {
    for (const header of ['', 't=', 't=1,v1=', 'garbage', 't=1,v1=zzzz', ',,,']) {
      expect(() => verify({ body: BODY, header })).not.toThrow();
    }
  });
});
