import { createHmac } from 'node:crypto';

import { verifySvixSignature } from './svix-signature';

/**
 * The signature check is the only thing between a stranger and the webhook
 * handler, so every way it can fail has a test — and the tests are written as
 * attacks rather than as happy paths with variations.
 */

const SECRET = `whsec_${Buffer.from('a-test-signing-key-32-bytes-long').toString('base64')}`;
const ID = 'msg_2abc';
const BODY = JSON.stringify({
  type: 'email.bounced',
  data: { to: ['a@b.test'] },
});

function sign(options: {
  body?: string;
  id?: string;
  timestamp?: number;
  secret?: string;
}): { id: string; timestamp: string; signature: string; body: string } {
  const body = options.body ?? BODY;
  const id = options.id ?? ID;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const secret = options.secret ?? SECRET;

  const key = Buffer.from(secret.replace('whsec_', ''), 'base64');
  const digest = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');

  return { id, timestamp, signature: `v1,${digest}`, body };
}

function verify(
  signed: ReturnType<typeof sign>,
  overrides: Record<string, unknown> = {},
) {
  return verifySvixSignature({
    body: signed.body,
    headers: {
      id: signed.id,
      timestamp: signed.timestamp,
      signature: signed.signature,
    },
    secret: SECRET,
    ...overrides,
  });
}

describe('a genuine request', () => {
  it('verifies', () => {
    expect(verify(sign({}))).toEqual({ ok: true });
  });

  it('verifies with a body containing unicode and newlines', () => {
    // The signed content is the raw body, so anything a provider can send must
    // round-trip — including characters that a re-serialisation would change.
    const body = '{"note":"café — line\\nbreak","emoji":"💸"}';
    expect(verify(sign({ body }))).toEqual({ ok: true });
  });

  it('verifies an empty body', () => {
    expect(verify(sign({ body: '' }))).toEqual({ ok: true });
  });

  it('accepts a secret given without the whsec_ prefix', () => {
    const bare = SECRET.replace('whsec_', '');
    const signed = sign({ secret: bare });
    expect(
      verifySvixSignature({
        body: signed.body,
        headers: {
          id: signed.id,
          timestamp: signed.timestamp,
          signature: signed.signature,
        },
        secret: bare,
      }),
    ).toEqual({ ok: true });
  });
});

describe('a tampered request', () => {
  it('rejects a changed body', () => {
    const signed = sign({});
    signed.body = JSON.stringify({
      type: 'email.delivered',
      data: { to: ['a@b.test'] },
    });
    expect(verify(signed)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a body changed only by one character', () => {
    const signed = sign({ body: '{"amount":"100"}' });
    signed.body = '{"amount":"900"}';
    expect(verify(signed)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a changed message id, so a signature cannot be moved between messages', () => {
    const signed = sign({});
    signed.id = 'msg_different';
    expect(verify(signed)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a changed timestamp, so the signed window cannot be extended', () => {
    const signed = sign({});
    signed.timestamp = String(Number(signed.timestamp) + 1);
    expect(verify(signed)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a signature made with a different secret', () => {
    const other = `whsec_${Buffer.from('a-completely-different-key-here!').toString('base64')}`;
    expect(verify(sign({ secret: other }))).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it.each([
    // Whitespace, which Fastify's JSON parse-then-stringify removes.
    ['whitespace', '{ "a": 1 }'],
    // Number formatting. `1.0` and `1e3` do not survive a round-trip.
    ['a trailing zero', '{"amount":1.0}'],
    ['exponential notation', '{"amount":1e3}'],
    // A duplicate key, which JSON.parse silently collapses.
    ['a duplicate key', '{"a":1,"a":2}'],
  ])('rejects a body re-serialised from parsed JSON — %s', (_label, raw) => {
    // THE most common way to get this wrong: signing over
    // `JSON.stringify(request.body)` instead of the raw bytes. It fails closed,
    // so it looks like an attack rather than a bug, which is why it gets its own
    // test rather than being discovered in production.
    const signed = sign({ body: raw });
    signed.body = JSON.stringify(JSON.parse(raw));
    expect(signed.body).not.toBe(raw); // the premise of the test
    expect(verify(signed)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
});

describe('replay protection', () => {
  it('rejects a request older than the tolerance', () => {
    // Without this a captured request is valid forever, and a webhook that moves
    // state is a replayable command.
    const timestamp = Math.floor(Date.now() / 1000) - 10 * 60;
    expect(verify(sign({ timestamp }))).toEqual({
      ok: false,
      reason: 'timestamp_too_old',
    });
  });

  it('accepts one just inside the tolerance', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 4 * 60;
    expect(verify(sign({ timestamp }))).toEqual({ ok: true });
  });

  it('rejects one from the future, so skew cannot widen the window', () => {
    const timestamp = Math.floor(Date.now() / 1000) + 10 * 60;
    expect(verify(sign({ timestamp }))).toEqual({
      ok: false,
      reason: 'timestamp_in_future',
    });
  });

  it('honours an explicit clock, so the check is deterministic', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const timestamp = Math.floor(at.getTime() / 1000);
    expect(verify(sign({ timestamp }), { now: at })).toEqual({ ok: true });
    expect(
      verify(sign({ timestamp }), { now: new Date('2026-01-01T01:00:00Z') }),
    ).toEqual({
      ok: false,
      reason: 'timestamp_too_old',
    });
  });
});

describe('secret rotation', () => {
  it('accepts a request when ANY of the offered signatures is valid', () => {
    // Svix sends a space-separated list while a secret is being rotated.
    // Accepting any valid one is what lets a rotation happen without dropping
    // deliveries — and dropping a bounce notification means we keep emailing a
    // dead address.
    const good = sign({});
    const bogus =
      'v1,' +
      Buffer.from('not-a-real-signature-at-all-ok!!').toString('base64');

    expect(
      verify({ ...good, signature: `${bogus} ${good.signature}` }),
    ).toEqual({ ok: true });
    expect(
      verify({ ...good, signature: `${good.signature} ${bogus}` }),
    ).toEqual({ ok: true });
  });

  it('still rejects when every offered signature is wrong', () => {
    const good = sign({});
    const bogus =
      'v1,' +
      Buffer.from('not-a-real-signature-at-all-ok!!').toString('base64');
    expect(verify({ ...good, signature: `${bogus} ${bogus}` })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });
});

describe('malformed input fails closed', () => {
  it.each([
    ['no id', { id: undefined }],
    ['no timestamp', { timestamp: undefined }],
    ['no signature', { signature: undefined }],
  ])('rejects with %s', (_label, missing) => {
    const signed = sign({});
    expect(
      verifySvixSignature({
        body: signed.body,
        headers: {
          id: signed.id,
          timestamp: signed.timestamp,
          signature: signed.signature,
          ...missing,
        },
        secret: SECRET,
      }),
    ).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects a non-numeric timestamp', () => {
    const signed = sign({});
    expect(verify({ ...signed, timestamp: 'yesterday' })).toEqual({
      ok: false,
      reason: 'malformed_timestamp',
    });
  });

  it('rejects a fractional timestamp rather than rounding it', () => {
    const signed = sign({});
    expect(verify({ ...signed, timestamp: '1700000000.5' })).toEqual({
      ok: false,
      reason: 'malformed_timestamp',
    });
  });

  it('rejects a signature with no v1 entry', () => {
    const signed = sign({});
    expect(verify({ ...signed, signature: 'v2,something' })).toEqual({
      ok: false,
      reason: 'no_v1_signature',
    });
  });

  it('rejects an empty signature header', () => {
    const signed = sign({});
    expect(verify({ ...signed, signature: '' })).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
  });

  it('rejects an empty secret rather than signing with nothing', () => {
    const signed = sign({});
    expect(verify(signed, { secret: '' })).toEqual({
      ok: false,
      reason: 'malformed_secret',
    });
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch. A short signature must be a
    // clean rejection, not a 500 that tells an attacker they found an edge.
    const signed = sign({});
    expect(
      verify({
        ...signed,
        signature: 'v1,' + Buffer.from('short').toString('base64'),
      }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('never throws on arbitrary header garbage', () => {
    const signed = sign({});
    for (const signature of ['v1,', 'v1,!!!!', 'v1,=', '   ', 'v1']) {
      expect(() => verify({ ...signed, signature })).not.toThrow();
    }
  });
});
