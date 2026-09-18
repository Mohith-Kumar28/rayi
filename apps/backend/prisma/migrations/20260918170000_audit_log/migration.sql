-- ============================================================================
-- AUDIT LOG
-- ============================================================================
--
-- Append-only and hash-chained, so tampering is DETECTABLE rather than merely
-- forbidden. The distinction matters: `REVOKE UPDATE, DELETE` stops the
-- application from rewriting history, and the chain stops anyone who gets past
-- that — a compromised migrator role, a direct `psql` session, an insider —
-- from doing it without leaving evidence.
--
-- Its own schema, with its own grants, for the same reason the ledger has one:
-- the interesting question is not "can this code write an audit row" but "can
-- this code UNWRITE one", and the answer has to be no for every role.
--
-- Unlike the ledger, `rayi_api` legitimately writes here — revoking a session is
-- an API action and it must be recorded. So the api gets EXECUTE on the
-- recording function and nothing else: no direct table grant, no way to choose
-- what the hash chain says.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.event (
  -- A gapless, ordered position. The hash chain is defined over this order, so a
  -- deleted row is visible as a gap even before the hashes are checked.
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Stable public identifier, for referring to an event from a support ticket
  -- without exposing the sequence position.
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,

  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- Dotted and enumerable: 'session.revoked', 'email.change_requested'. Not free
  -- text — the set of things that can be audited should be reviewable, and a
  -- typo'd action name is an event that no alert will ever match.
  action text NOT NULL,

  -- WHO. Nullable because some events are system-initiated, and recording a
  -- fake actor would be worse than recording none.
  actor_user_id   text,
  actor_member_id text,
  organization_id text,

  -- WHAT it was done to.
  subject_type text,
  subject_id   text,

  -- HOW it arrived. Enough to correlate with an access log and a support call.
  request_id text,
  ip_address inet,
  user_agent text,

  -- Structured detail. Never a rendered sentence: a message is written once for
  -- humans reading it today, whereas the fields are queried by whoever
  -- investigates in two years.
  data jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- THE CHAIN. Each row commits to every row before it, so altering an old event
  -- requires recomputing every hash since — which the append-only triggers below
  -- make impossible through SQL.
  prev_hash bytea NOT NULL,
  hash      bytea NOT NULL UNIQUE,

  CONSTRAINT audit_event_action_shape CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

CREATE INDEX audit_event_actor_idx   ON audit.event (actor_user_id, occurred_at DESC);
CREATE INDEX audit_event_org_idx     ON audit.event (organization_id, occurred_at DESC);
CREATE INDEX audit_event_subject_idx ON audit.event (subject_type, subject_id, occurred_at DESC);
CREATE INDEX audit_event_action_idx  ON audit.event (action, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- Append-only
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit.refuse_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit.% is append-only; % is not permitted. An audit log that can be edited is not an audit log.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END;
$$;

CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

-- ----------------------------------------------------------------------------
-- audit.record — the only way an event is written
-- ----------------------------------------------------------------------------
--
-- The hash is computed HERE, from the row's own committed values, so the caller
-- cannot supply one. A caller that could choose the hash could write an event
-- whose hash matches a different payload, and the chain would verify while
-- saying something false.
--
-- `pg_advisory_xact_lock` serializes writers, because the chain is only
-- well-defined if each row sees the true previous one. Two concurrent inserts
-- reading the same `prev_hash` would produce a fork, and a forked chain verifies
-- as broken forever after.
--
-- The cost is that audit writes serialize, and the lock is held until COMMIT. At
-- this volume that is irrelevant; if it ever is not, the answer is to chain
-- per-actor rather than to drop the lock.

CREATE OR REPLACE FUNCTION audit.record(
  p_action          text,
  p_actor_user_id   text    DEFAULT NULL,
  p_actor_member_id text    DEFAULT NULL,
  p_organization_id text    DEFAULT NULL,
  p_subject_type    text    DEFAULT NULL,
  p_subject_id      text    DEFAULT NULL,
  p_request_id      text    DEFAULT NULL,
  p_ip_address      text    DEFAULT NULL,
  p_user_agent      text    DEFAULT NULL,
  p_data            jsonb   DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $$
DECLARE
  v_prev bytea;
  v_hash bytea;
  v_id   uuid := gen_random_uuid();
  v_at   timestamptz := now();
BEGIN
  -- One writer at a time. 4919 is an arbitrary but fixed key for this chain.
  PERFORM pg_advisory_xact_lock(4919);

  SELECT hash INTO v_prev FROM audit.event ORDER BY seq DESC LIMIT 1;

  -- The genesis link. 32 zero bytes, so the first row's prev_hash is a value
  -- rather than NULL — a NULL would make the column nullable, and a nullable
  -- link is a link someone can omit.
  IF v_prev IS NULL THEN
    v_prev := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
  END IF;

  -- Everything that is part of the record is part of the hash. A field left out
  -- here is a field an attacker may change freely while the chain still verifies.
  v_hash := sha256(
    v_prev
    || convert_to(v_id::text, 'UTF8')
    || convert_to(v_at::text, 'UTF8')
    || convert_to(p_action, 'UTF8')
    || convert_to(COALESCE(p_actor_user_id, ''), 'UTF8')
    || convert_to(COALESCE(p_actor_member_id, ''), 'UTF8')
    || convert_to(COALESCE(p_organization_id, ''), 'UTF8')
    || convert_to(COALESCE(p_subject_type, ''), 'UTF8')
    || convert_to(COALESCE(p_subject_id, ''), 'UTF8')
    || convert_to(COALESCE(p_request_id, ''), 'UTF8')
    || convert_to(COALESCE(p_ip_address, ''), 'UTF8')
    || convert_to(COALESCE(p_user_agent, ''), 'UTF8')
    -- jsonb::text is canonical in Postgres: keys sorted, whitespace normalised,
    -- duplicates removed. So the same logical payload always hashes the same,
    -- which json::text would not guarantee.
    || convert_to(COALESCE(p_data, '{}'::jsonb)::text, 'UTF8')
  );

  INSERT INTO audit.event (
    id, occurred_at, action,
    actor_user_id, actor_member_id, organization_id,
    subject_type, subject_id,
    request_id, ip_address, user_agent, data,
    prev_hash, hash
  )
  VALUES (
    v_id, v_at, p_action,
    p_actor_user_id, p_actor_member_id, p_organization_id,
    p_subject_type, p_subject_id,
    p_request_id, p_ip_address::inet, p_user_agent, COALESCE(p_data, '{}'::jsonb),
    v_prev, v_hash
  );

  RETURN v_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- audit.verify_chain — is the history intact?
-- ----------------------------------------------------------------------------
--
-- Recomputes every hash and reports the first position that disagrees. Run
-- nightly alongside the ledger reconciliation: an audit log nobody verifies is a
-- log that says whatever the last person with database access wanted it to say.
--
-- Returns the failing seq and why, or nothing at all when the chain is intact.

CREATE OR REPLACE FUNCTION audit.verify_chain(p_from bigint DEFAULT 0)
RETURNS TABLE (bad_seq bigint, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $$
DECLARE
  r      record;
  v_prev bytea := NULL;
  v_calc bytea;
  v_expected_seq bigint := NULL;
BEGIN
  FOR r IN
    SELECT * FROM audit.event WHERE seq > p_from ORDER BY seq
  LOOP
    -- A gap means a row was removed. The append-only trigger forbids DELETE
    -- through SQL, so a gap is evidence of something that bypassed it entirely.
    IF v_expected_seq IS NOT NULL AND r.seq <> v_expected_seq THEN
      bad_seq := r.seq;
      reason  := format('gap in sequence: expected %s, found %s', v_expected_seq, r.seq);
      RETURN NEXT;
      RETURN;
    END IF;

    IF v_prev IS NOT NULL AND r.prev_hash <> v_prev THEN
      bad_seq := r.seq;
      reason  := 'prev_hash does not match the previous row''s hash';
      RETURN NEXT;
      RETURN;
    END IF;

    v_calc := sha256(
      r.prev_hash
      || convert_to(r.id::text, 'UTF8')
      || convert_to(r.occurred_at::text, 'UTF8')
      || convert_to(r.action, 'UTF8')
      || convert_to(COALESCE(r.actor_user_id, ''), 'UTF8')
      || convert_to(COALESCE(r.actor_member_id, ''), 'UTF8')
      || convert_to(COALESCE(r.organization_id, ''), 'UTF8')
      || convert_to(COALESCE(r.subject_type, ''), 'UTF8')
      || convert_to(COALESCE(r.subject_id, ''), 'UTF8')
      || convert_to(COALESCE(r.request_id, ''), 'UTF8')
      || convert_to(COALESCE(r.ip_address::text, ''), 'UTF8')
      || convert_to(COALESCE(r.user_agent, ''), 'UTF8')
      || convert_to(COALESCE(r.data, '{}'::jsonb)::text, 'UTF8')
    );

    IF v_calc <> r.hash THEN
      bad_seq := r.seq;
      reason  := 'row contents do not match its recorded hash';
      RETURN NEXT;
      RETURN;
    END IF;

    v_prev := r.hash;
    v_expected_seq := r.seq + 1;
  END LOOP;

  RETURN;
END;
$$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
--
-- Nobody gets the table. Writing goes through `audit.record`, so no role can
-- choose what the chain says; reading goes through ordinary SELECT for the api,
-- which needs to show a user their own history.

REVOKE ALL ON SCHEMA audit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.record(text, text, text, text, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.verify_chain(bigint) FROM PUBLIC;

GRANT USAGE ON SCHEMA audit TO rayi_api, rayi_worker, rayi_webhooks;

-- SELECT only. No INSERT: an INSERT grant would let a caller write a row with a
-- hash of its own choosing, which is the one thing the chain exists to prevent.
GRANT SELECT ON audit.event TO rayi_api, rayi_worker;

GRANT EXECUTE ON FUNCTION audit.record(text, text, text, text, text, text, text, text, text, jsonb)
  TO rayi_api, rayi_worker, rayi_webhooks;
GRANT EXECUTE ON FUNCTION audit.verify_chain(bigint) TO rayi_api, rayi_worker;
