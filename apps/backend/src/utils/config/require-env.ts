/**
 * Reads an environment variable that the accompanying validator class has
 * already declared required.
 *
 * Preferred over a non-null assertion (`process.env.X!`). The assertion silences
 * the compiler and leaves nothing behind; this throws if the validator and the
 * config factory ever drift apart — which they will, because they are edited at
 * different times by different people.
 *
 * Only use this where the validator marks the variable @IsNotEmpty(). Where the
 * validator says @IsOptional(), the config type should admit `undefined` rather
 * than pretending otherwise.
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        `Its validator declares it required, so the process cannot start without it.`,
    );
  }
  return value;
}
