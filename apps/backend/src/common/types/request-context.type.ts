/**
 * What a request knows about itself, for audit rows.
 *
 * Lives in `common/` rather than in a feature module because more than one
 * module needs it — and a type borrowed across feature boundaries is the first
 * step towards borrowing a service across them. dependency-cruiser caught
 * exactly that when this type lived in `api/account`.
 *
 * Every field is attacker-influenced. It is recorded as EVIDENCE — enough to
 * correlate an audit row with an access log and a support call — and never used
 * for authorization.
 */
export interface RequestContext {
  readonly requestId?: string | undefined;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}
