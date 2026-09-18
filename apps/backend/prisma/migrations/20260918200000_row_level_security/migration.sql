-- ============================================================================
-- ROW LEVEL SECURITY on org-scoped tables
-- ============================================================================
--
-- Every tenant query in the application already carries its predicate in the
-- WHERE clause, and the composite foreign keys make a cross-org row
-- unrepresentable. This is the third layer, and it exists for the case the other
-- two cannot cover: a query someone writes LATER that forgets the predicate.
--
-- The threat is not a malicious developer. It is `findMany({ where: { state:
-- 'live' } })` in a reporting endpoint six months from now — correct-looking,
-- reviewed, and returning every organization's campaigns.
--
-- **What RLS can and cannot do here.**
--
-- It is a real control only if the connection carries the tenant. Postgres has
-- no idea which organization an application-pooled connection is acting for, so
-- the application must SET it — which means RLS depends on application code
-- doing something, exactly like the WHERE clause does.
--
-- What it buys is the FAILURE MODE. A forgotten `withTenant()` returns ZERO rows
-- rather than everyone's rows: a visibly broken feature instead of a silent
-- cross-tenant leak. That asymmetry is the entire point, and it is worth saying
-- plainly rather than claiming RLS makes leaks impossible.
--
-- The policies are PERMISSIVE and keyed on a session variable, so a connection
-- with no tenant set sees nothing at all.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The tenant, as the current connection understands it
-- ----------------------------------------------------------------------------
--
-- `current_setting(..., true)` returns NULL rather than raising when unset,
-- which is what lets "no tenant" be a clean zero-row result instead of an error
-- every migration and health check would trip over.

CREATE OR REPLACE FUNCTION public.current_tenant() RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('rayi.organization_id', true), '');
$$;

-- ----------------------------------------------------------------------------
-- Policies
-- ----------------------------------------------------------------------------
--
-- One shape, applied to every table carrying an organizationId:
--
--   visible when NO tenant is set  -> false  (fail closed)
--   visible when a tenant is set   -> the row belongs to it
--
-- `campaign` and `workspace` are the ones a reporting query is most likely to
-- reach for. `member`, `money_authority` and `treasury_command` are included
-- because each of them answers a question about somebody's money or access.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaign', 'workspace', 'member', 'money_authority', 'treasury_command']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the table owner is subject to it too. Without this the policies
    -- are inert for exactly the role the application is most likely to connect
    -- as in development, and the control is untested until production.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format($f$
      CREATE POLICY %I ON %I
        USING ("organizationId" = public.current_tenant())
        WITH CHECK ("organizationId" = public.current_tenant())
    $f$, t || '_tenant_isolation', t);
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- The escape hatch, and why it is narrow
-- ----------------------------------------------------------------------------
--
-- Some work is legitimately cross-tenant: migrations, the nightly
-- reconciliation, the super-admin surface, and the worker sweeping every pending
-- treasury command. Those cannot run under a single tenant.
--
-- Rather than granting BYPASSRLS to the application role — which would make the
-- policies decorative — cross-tenant work sets a separate, explicit flag. It is
-- greppable, it appears in the code that uses it, and it cannot be acquired by
-- forgetting something.

CREATE OR REPLACE FUNCTION public.is_cross_tenant() RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('rayi.cross_tenant', true), 'off') = 'on';
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaign', 'workspace', 'member', 'money_authority', 'treasury_command']
  LOOP
    EXECUTE format($f$
      CREATE POLICY %I ON %I
        USING (public.is_cross_tenant())
        WITH CHECK (public.is_cross_tenant())
    $f$, t || '_cross_tenant', t);
  END LOOP;
END;
$$;
