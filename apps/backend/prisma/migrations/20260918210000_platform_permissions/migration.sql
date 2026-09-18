-- ============================================================================
-- Platform permissions
-- ============================================================================
--
-- The super-admin surface reads across tenants, which makes it the highest-value
-- target in the product: one compromised session sees every brand's funding
-- position, every creator's earnings, and the full shape of the business.
--
-- So it is a separate POPULATION, not a powerful role. These rows live at
-- `scope = 'platform'` and are resolved against the user's own `role` column —
-- never through an organization membership. A platform permission reachable from
-- an org role would make a sufficiently senior brand owner into a super-admin,
-- and the whole value of the separation is that it cannot.
--
-- `Admin` is the existing `Role` enum value on `user`, so this grants the
-- capability to a population that already exists rather than inventing a second
-- notion of who staff are.
-- ============================================================================

INSERT INTO "role_permission" (id, role, scope, permission) VALUES
  (gen_random_uuid()::text, 'Admin', 'platform', 'platform:read')
ON CONFLICT (role, scope, permission) DO NOTHING;

-- Deliberately NO `platform:write`. An admin surface that can also act is a
-- single session that can move any brand's money, and nothing needs that yet.
-- Adding one should be a decision with its own migration and its own review.
