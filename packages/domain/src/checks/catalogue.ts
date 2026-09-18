/**
 * The closed catalogue of verification checks.
 *
 * One declaration per check, carrying its tier and the words a reviewer reads.
 * Three things follow from keeping them together, and each is a defect this
 * prevents rather than a tidiness argument:
 *
 * **The label is server-owned, like every other piece of status copy.** The
 * funding vocabulary already works this way — copy is keyed on real state and
 * driven from the server — and for the same reason: a `name → label` map living
 * in the console drifts the moment a check is added, and the reviewer then sees
 * a raw registry key like `disclosure` in the one place they are deciding
 * whether to pay someone.
 *
 * **The tier lives beside the label.** BLOCKING work never reaches the brand
 * queue; ADVISORY work informs a reviewer who may well approve anyway. A check
 * whose tier is declared in one file and rendered from another is a check that
 * will eventually be shown as a veto when it is only context.
 *
 * **The catalogue is closed.** An unrecognised check name is a bug in the
 * pipeline, not a string to render. `checkLabel` says so rather than falling
 * back to the key and letting it reach a screen.
 *
 * Pure data. No I/O, no framework — the same rule the rest of `packages/domain`
 * follows, so the console and the api read one source and cannot disagree.
 */

export type CheckTier = 'BLOCKING' | 'ADVISORY';
export type CheckStatus = 'PASS' | 'FAIL' | 'ERROR';

export interface CheckDefinition {
  readonly name: string;
  /** What a reviewer reads. Never the registry key. */
  readonly label: string;
  readonly tier: CheckTier;
}

export const CHECK_CATALOGUE = [
  {
    name: 'disclosure',
    label: 'Paid partnership disclosure',
    // Blocking: an undisclosed ad is an FTC problem for the brand, and the fix
    // costs the creator one caption edit rather than a revision cycle.
    tier: 'BLOCKING',
  },
  {
    name: 'duration',
    label: 'Length within brief',
    tier: 'BLOCKING',
  },
  {
    name: 'resolution',
    label: 'Resolution meets the brief',
    tier: 'BLOCKING',
  },
  {
    name: 'malware',
    label: 'Clean malware scan',
    tier: 'BLOCKING',
  },
  {
    name: 'duplicate',
    // Advisory on purpose. A near-identical clip is often a legitimate series
    // recap or a cross-post the brand asked for, so this informs the reviewer
    // and never bounces the work.
    label: 'Not seen in another campaign',
    tier: 'ADVISORY',
  },
  {
    name: 'brand_safety',
    label: 'Brand safety review',
    tier: 'ADVISORY',
  },
] as const satisfies readonly CheckDefinition[];

export type CheckName = (typeof CHECK_CATALOGUE)[number]['name'];

const BY_NAME = new Map<string, CheckDefinition>(
  CHECK_CATALOGUE.map((definition) => [definition.name, definition]),
);

export class UnknownCheckError extends Error {
  // `checkName`, not `name` — a parameter property called `name` shadows
  // `Error.name`, and the `this.name = ...` below would then silently discard
  // the very value the error exists to report.
  readonly checkName: string;

  constructor(checkName: string) {
    super(
      `Unknown check "${checkName}". The catalogue is closed — add it to CHECK_CATALOGUE ` +
        `rather than emitting a name the UI has no words for.`,
    );
    this.name = 'UnknownCheckError';
    this.checkName = checkName;
  }
}

/** The definition for a check name, or a throw. Never a fallback to the key. */
export function checkDefinition(name: string): CheckDefinition {
  const definition = BY_NAME.get(name);
  if (!definition) throw new UnknownCheckError(name);
  return definition;
}

export function checkLabel(name: string): string {
  return checkDefinition(name).label;
}

export function checkTier(name: string): CheckTier {
  return checkDefinition(name).tier;
}

export function isCheckName(name: string): name is CheckName {
  return BY_NAME.has(name);
}
