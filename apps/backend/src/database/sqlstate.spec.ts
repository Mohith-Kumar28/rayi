import { isCheckViolation, sqlStateOf } from './sqlstate';

/**
 * Reading a SQLSTATE off whatever the driver hands us.
 *
 * The case that matters most is the one that was missing: Prisma's
 * `PrismaClientUnknownRequestError` carries no structured code and no meta, and
 * stringifies the connector error into its message instead. Every constraint
 * refusal on a Prisma `updateMany` arrives that way, so without the message
 * fallback a CORRECT database refusal reads as an unknown failure — and the
 * caller reports "something went wrong" instead of "that exceeds the ceiling".
 */

function pgError(code: string): Error {
  return Object.assign(new Error('db'), { code });
}

/** The real shape, trimmed. */
function prismaUnknownError(sqlstate: string, constraint: string): Error {
  return new Error(
    `\nInvalid \`prisma.budgetEnvelope.updateMany()\` invocation:\n\n\n` +
      `Error occurred during query execution:\n` +
      `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError ` +
      `{ code: "${sqlstate}", message: "new row for relation \\"budget_envelope\\" violates check ` +
      `constraint \\"${constraint}\\"", severity: "ERROR" }), transient: false })`,
  );
}

describe('sqlStateOf', () => {
  it('reads a SQLSTATE off the error itself', () => {
    expect(sqlStateOf(pgError('40001'))).toBe('40001');
  });

  it('walks the cause chain, since ORMs wrap the driver error', () => {
    expect(sqlStateOf(Object.assign(new Error('wrap'), { cause: pgError('23514') }))).toBe('23514');
  });

  it('reads it out of the message when there is no structured code', () => {
    const error = prismaUnknownError('23514', 'budget_envelope_within_ceiling');
    expect((error as { code?: unknown }).code).toBeUndefined();
    expect(sqlStateOf(error)).toBe('23514');
  });

  /**
   * A five-character token in prose is not a SQLSTATE. The message fallback is
   * anchored on the connector's own `code: "…"` rendering precisely so that a
   * request id, a ticket reference or an uppercase word cannot be read as one.
   */
  it('does not mistake an arbitrary token in a message for a SQLSTATE', () => {
    expect(sqlStateOf(new Error('Request ABC12 failed while writing ORDER'))).toBeUndefined();
  });

  it('returns undefined when there is no SQLSTATE anywhere', () => {
    expect(sqlStateOf(new Error('boom'))).toBeUndefined();
    expect(sqlStateOf(undefined)).toBeUndefined();
  });
});

describe('isCheckViolation', () => {
  it('matches the named constraint', () => {
    const error = prismaUnknownError('23514', 'budget_envelope_within_ceiling');
    expect(isCheckViolation(error, 'budget_envelope_within_ceiling')).toBe(true);
  });

  /**
   * The distinction this function exists for.
   *
   * A bare "was it a 23514" catch swallows every other invariant on the same
   * table, so a bug that produced a NEGATIVE commitment would be reported to the
   * caller as an ordinary "ceiling reached" — and the real defect would never
   * surface.
   */
  it('does not match a different constraint on the same table', () => {
    const error = prismaUnknownError('23514', 'budget_envelope_non_negative');
    expect(isCheckViolation(error, 'budget_envelope_within_ceiling')).toBe(false);
  });

  it('does not match a unique violation', () => {
    expect(isCheckViolation(pgError('23505'), 'budget_envelope_within_ceiling')).toBe(false);
  });
});
