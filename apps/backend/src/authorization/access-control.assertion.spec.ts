import { findSecondAuthorizationAuthority } from './access-control.assertion';

/**
 * There must be exactly ONE authority on who can do what.
 *
 * Better Auth ships its own `ac` model. Configuring it would create a second
 * evaluator that `PermissionGuard` never consults and no test covers — and two
 * authorities do not stay in agreement. They drift, and the drift is discovered
 * when one allows something the other would have refused.
 *
 * Its `/organization/*` endpoints are 404'd at the mount, so its access control
 * governs nothing. The honest configuration is therefore to leave it unset, and
 * this asserts that absence.
 */

describe('the current configuration has one authority', () => {
  it('passes for options with no access-control model', () => {
    expect(
      findSecondAuthorizationAuthority({
        emailAndPassword: { enabled: false },
        plugins: [{ id: 'two-factor' }, { id: 'magic-link' }],
      }),
    ).toEqual([]);
  });
});

describe('a second authority is caught wherever it is introduced', () => {
  it('catches a top-level ac', () => {
    expect(findSecondAuthorizationAuthority({ ac: {} })).toEqual(['options.ac']);
  });

  it('catches top-level roles', () => {
    expect(findSecondAuthorizationAuthority({ roles: { admin: {} } })).toEqual(['options.roles']);
  });

  it('catches dynamicAccessControl', () => {
    // Listed for a different reason: its `cacheAllRoles` is a module-level Map
    // written on every call with no TTL and no invalidation, so across several
    // tasks a REVOKED permission can remain honoured indefinitely.
    expect(findSecondAuthorizationAuthority({ dynamicAccessControl: { enabled: true } })).toEqual([
      'options.dynamicAccessControl',
    ]);
  });

  it('catches one hidden in a PLUGIN, which is where it would actually appear', () => {
    // The organization plugin takes its own `ac`. A check that only looked at
    // top-level options would miss the one place this is likely to be added.
    expect(
      findSecondAuthorizationAuthority({
        plugins: [{ id: 'organization', options: { ac: {}, roles: {} } }],
      }),
    ).toEqual(['organization.ac', 'organization.roles']);
  });

  it('names an anonymous plugin by position, so the message is still actionable', () => {
    expect(findSecondAuthorizationAuthority({ plugins: [{ options: { ac: {} } }] })).toEqual([
      'plugin[0].ac',
    ]);
  });

  it('reports EVERY one, not just the first', () => {
    const found = findSecondAuthorizationAuthority({
      ac: {},
      roles: {},
      plugins: [{ id: 'organization', options: { ac: {} } }],
    });
    expect(found).toHaveLength(3);
  });

  it('does not trip over a plugin with no options', () => {
    expect(findSecondAuthorizationAuthority({ plugins: [{ id: 'bare' }] })).toEqual([]);
  });

  it('treats an explicit undefined as absent', () => {
    // `{ ac: undefined }` is how an option ends up present-but-unset after a
    // spread, and it configures nothing.
    expect(findSecondAuthorizationAuthority({ ac: undefined })).toEqual([]);
  });
});
