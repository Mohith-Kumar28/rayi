-- ============================================================================
-- cluster_identity
-- ============================================================================
--
-- Which physical PostgreSQL cluster owns this ledger.
--
-- The failure this makes visible: a restored copy of the database running
-- ALONGSIDE the original, both accepting postings and both re-issuing transfers.
-- PITR rehearsals are exactly when that happens, and nothing in the application
-- would otherwise notice.
--
-- An OBSERVATION, not a control, and the distinction is deliberate:
--
--   `system_identifier` is copied by a physical restore, so on its own it cannot
--   tell a fork from the original. It catches the different failure of a worker
--   pointed at an entirely different cluster — a staging URL in a production
--   secret — which is worth catching.
--
--   `timeline_id` does advance on recovery, but it also advances on an ordinary
--   RDS Multi-AZ failover. Refusing to start on a timeline change would take the
--   money path down during exactly the incident it is meant to survive.
--
-- So the worker logs and alarms; it does not refuse. The real protection against
-- a fork re-issuing money is deriving Stripe idempotency keys from ECONOMIC
-- IDENTITY rather than from a row id a rollback can reassign (roadmap step 13).
-- ============================================================================

CREATE TABLE ledger.cluster_identity (
  -- Singleton. `only_row` is always true and is the primary key, so a second row
  -- is rejected by the storage engine rather than by a convention someone can
  -- forget. Cheaper and stricter than a partial unique index on a constant.
  only_row boolean PRIMARY KEY DEFAULT true,

  system_identifier bigint  NOT NULL,
  timeline_id       integer NOT NULL,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  observed_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cluster_identity_is_singleton CHECK (only_row)
);

GRANT SELECT, INSERT, UPDATE ON ledger.cluster_identity TO rayi_worker;
