/**
 * The budget envelope, as other feature modules may use it.
 *
 * Deals needs to commit against a workspace's ceiling when it offers, and
 * release when it terminates — but it must not reach into `WorkspacesService`
 * to do it. A feature module importing another's implementation is how module
 * boundaries dissolve one convenient import at a time, and dependency-cruiser
 * fails the build on it.
 *
 * So the capability is narrowed to the two operations a caller outside this
 * module legitimately needs. Everything else about envelopes — approving one,
 * reading who approved it, listing them — stays inside.
 */
export interface BudgetPort {
  /**
   * Draw down the ceiling, atomically.
   *
   * Returns `false` when there is no envelope, when it has expired, or when the
   * draw-down would exceed the ceiling. All three refuse a NEW commitment and
   * none of them touch anything already committed — a creator who has accepted a
   * deal never loses their milestone because somebody else exhausted a budget.
   */
  tryCommit(
    organizationId: string,
    workspaceId: string,
    amountMinor: bigint,
    now?: Date,
  ): Promise<boolean>;

  /**
   * Return a commitment to the ceiling.
   *
   * Only ever the UNCOMMITTED remainder. Money already released stays released —
   * payout is final, and nothing in this codebase claws it back.
   */
  release(organizationId: string, workspaceId: string, amountMinor: bigint): Promise<void>;
}

/**
 * The DI token.
 *
 * A `Symbol` rather than the class, so a caller cannot accidentally inject the
 * concrete service and reach the rest of its surface.
 */
export const BUDGET_PORT = Symbol('BUDGET_PORT');
