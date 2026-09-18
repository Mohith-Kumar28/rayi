-- ============================================================================
-- Row-level security on `deal`
-- ============================================================================
--
-- Split out of `20260918115934_campaign_domain` because these policies call
-- `public.current_tenant()`, created by `20260918200000_row_level_security` —
-- which sorts AFTER campaign_domain. Applied in creation order the dependency
-- was invisible; replayed in filename order it fails outright.
--
-- Guarded with DROP ... IF EXISTS so the migration is idempotent against a
-- database where the policies were already created by the earlier file.
-- ============================================================================

ALTER TABLE "deal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deal" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_tenant_isolation ON "deal";
CREATE POLICY deal_tenant_isolation ON "deal"
  USING ("organizationId" = public.current_tenant())
  WITH CHECK ("organizationId" = public.current_tenant());

DROP POLICY IF EXISTS deal_cross_tenant ON "deal";
CREATE POLICY deal_cross_tenant ON "deal"
  USING (public.is_cross_tenant())
  WITH CHECK (public.is_cross_tenant());
