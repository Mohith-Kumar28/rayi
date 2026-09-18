-- ============================================================================
-- An application role that RLS actually applies to
-- ============================================================================
--
-- The previous migration enabled row-level security and wrote the policies. It
-- was INERT, and would have stayed inert until production.
--
-- The development connection uses a role with `rolsuper` and `rolbypassrls`.
-- Both bypass every policy unconditionally — `FORCE ROW LEVEL SECURITY` makes
-- the table OWNER subject to policies, but it cannot touch a superuser. So every
-- policy was decorative, every test would have passed by seeing all rows, and
-- the first environment where the control mattered would have been the first one
-- where it had never run.
--
-- That is the exact failure this project keeps finding: a control that is
-- present, reviewed, and doing nothing.
--
-- `rayi_app` is the role the application connects as. NOLOGIN here — granting it
-- a password belongs to the deployment, not to a migration committed in a repo —
-- and deliberately WITHOUT superuser and WITHOUT bypassrls, so the policies are
-- real for it.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rayi_app') THEN
    CREATE ROLE rayi_app NOLOGIN;
  END IF;
END;
$$;

-- Explicit, even though these are the defaults. A future `ALTER ROLE` that
-- granted either would silently turn every policy off, so the intent is written
-- down where a reviewer reading this file will see it.
ALTER ROLE rayi_app NOSUPERUSER NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO rayi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rayi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rayi_app;

-- New tables inherit the grants rather than depending on someone remembering.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rayi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO rayi_app;

-- The audit log: write through the function only, never the table. Same boundary
-- as every other role — no INSERT grant means no way to choose what the hash
-- chain says.
GRANT USAGE ON SCHEMA audit TO rayi_app;
GRANT SELECT ON audit.event TO rayi_app;
GRANT EXECUTE ON FUNCTION audit.record(text, text, text, text, text, text, text, text, text, jsonb)
  TO rayi_app;
GRANT EXECUTE ON FUNCTION audit.verify_chain(bigint) TO rayi_app;
GRANT EXECUTE ON FUNCTION audit.head() TO rayi_app;

-- NO grants on the `ledger` schema. The api cannot reach money, and that is the
-- point of having a separate schema at all.
