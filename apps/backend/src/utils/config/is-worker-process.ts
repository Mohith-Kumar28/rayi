/**
 * Whether this process is the worker — read from the RAW environment.
 *
 * **Do not reach for `args.object.IS_WORKER` inside a class-validator
 * constraint.** `validateConfig` runs `plainToClass` with
 * `enableImplicitConversion: true`, and class-transformer's implicit boolean
 * conversion is `Boolean(value)`. So for a property declared `IS_WORKER: boolean`:
 *
 *   'true'  -> true
 *   'false' -> true        <-- every non-empty string is true
 *   '0'     -> true
 *   ''      -> false
 *
 * That silently inverted the meaning of the flag. A constraint asking "is this
 * the worker?" answered YES for `IS_WORKER=false`, which is what `.env.example`
 * ships for the api process — so a full Stripe secret key was permitted on the
 * internet-reachable api, which is precisely the thing the check exists to stop.
 *
 * Reading the raw string and comparing it explicitly removes the conversion from
 * the path entirely. Only the exact string `true` counts, so a typo, a `1`, or
 * an accidental `yes` fails CLOSED — treated as "not the worker", which is the
 * side that denies the credential.
 */
export function isWorkerProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['IS_WORKER']?.trim().toLowerCase() === 'true';
}
