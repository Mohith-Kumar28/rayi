-- ============================================================================
-- AUDIT: hash the STORED values, not the inputs
-- ============================================================================
--
-- The first version of `audit.record` hashed its text ARGUMENTS while
-- `audit.verify_chain` hashed the COLUMNS. For every field stored as text those
-- are the same string. For `ip_address`, typed `inet`, they are not:
--
--   input  '203.0.113.10'
--   stored '203.0.113.10/32'
--
-- So every event carrying an IP address — which is every security-relevant
-- event, the ones this log exists for — verified as TAMPERED. A tamper-evidence
-- mechanism that cries wolf on honest data is worse than none, because people
-- learn to ignore it, and they learn that before the day it matters.
--
-- The fix is structural rather than a matching pair of casts: `record` now
-- materialises each value at its COLUMN's type first, and hashes those exact
-- values. Hash input and stored row are the same object by construction, so
-- this class of mismatch cannot come back through a future column type change.
--
-- `hash_version` is added so a future change to the algorithm has somewhere to
-- live. Rotating a hash function otherwise means either invalidating all history
-- or keeping two implementations with nothing recording which applies where.
--
-- The existing rows are removed. They are pre-release test data, their hashes
-- were computed by the broken function, and no algorithm can make them verify.
-- Deleting them is stated here rather than done quietly, because silently
-- discarding audit rows is precisely what this table exists to make impossible.
-- ============================================================================

ALTER TABLE audit.event
  ADD COLUMN hash_version smallint NOT NULL DEFAULT 2;

-- Pre-release only. The append-only trigger has to come off to do it, which is
-- itself the demonstration of why this must never happen again after launch.
ALTER TABLE audit.event DISABLE TRIGGER audit_event_append_only;
DELETE FROM audit.event;
ALTER TABLE audit.event ENABLE TRIGGER audit_event_append_only;

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
  v_id   uuid        := gen_random_uuid();
  v_at   timestamptz := now();

  -- Materialised at the COLUMN's type. Everything below hashes and inserts these
  -- exact values, so what was hashed and what was stored cannot differ.
  v_ip   inet  := p_ip_address::inet;
  v_data jsonb := COALESCE(p_data, '{}'::jsonb);
BEGIN
  -- One writer at a time. The chain is only well-defined if each row sees the
  -- true previous one; two concurrent inserts reading the same prev_hash fork
  -- it, and a forked chain verifies as broken forever after.
  PERFORM pg_advisory_xact_lock(4919);

  SELECT hash INTO v_prev FROM audit.event ORDER BY seq DESC LIMIT 1;

  -- The genesis link: 32 zero bytes, so the first row's prev_hash is a value
  -- rather than NULL. A nullable link is a link someone can omit.
  IF v_prev IS NULL THEN
    v_prev := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
  END IF;

  v_hash := audit.event_hash(
    v_prev, v_id, v_at, p_action,
    p_actor_user_id, p_actor_member_id, p_organization_id,
    p_subject_type, p_subject_id, p_request_id,
    v_ip, p_user_agent, v_data
  );

  INSERT INTO audit.event (
    id, occurred_at, action,
    actor_user_id, actor_member_id, organization_id,
    subject_type, subject_id,
    request_id, ip_address, user_agent, data,
    prev_hash, hash, hash_version
  )
  VALUES (
    v_id, v_at, p_action,
    p_actor_user_id, p_actor_member_id, p_organization_id,
    p_subject_type, p_subject_id,
    p_request_id, v_ip, p_user_agent, v_data,
    v_prev, v_hash, 2
  );

  RETURN v_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- audit.event_hash — ONE definition of the hash
-- ----------------------------------------------------------------------------
--
-- Extracted so `record` and `verify_chain` cannot drift apart. Two copies of a
-- hash definition is exactly how the `inet` bug happened: both were individually
-- reasonable and they disagreed about one field.
--
-- IMMUTABLE and takes typed arguments, so a caller cannot accidentally pass a
-- differently-rendered form of the same value.

CREATE OR REPLACE FUNCTION audit.event_hash(
  p_prev            bytea,
  p_id              uuid,
  p_occurred_at     timestamptz,
  p_action          text,
  p_actor_user_id   text,
  p_actor_member_id text,
  p_organization_id text,
  p_subject_type    text,
  p_subject_id      text,
  p_request_id      text,
  p_ip_address      inet,
  p_user_agent      text,
  p_data            jsonb
) RETURNS bytea
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT sha256(
       p_prev
    || convert_to(p_id::text, 'UTF8')
    -- to_char with an explicit format rather than ::text: the default rendering
    -- of a timestamptz depends on the session's DateStyle and TimeZone, so two
    -- sessions could hash the same instant differently and the chain would break
    -- for no reason at all.
    || convert_to(to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8')
    || convert_to(p_action, 'UTF8')
    || convert_to(COALESCE(p_actor_user_id, ''), 'UTF8')
    || convert_to(COALESCE(p_actor_member_id, ''), 'UTF8')
    || convert_to(COALESCE(p_organization_id, ''), 'UTF8')
    || convert_to(COALESCE(p_subject_type, ''), 'UTF8')
    || convert_to(COALESCE(p_subject_id, ''), 'UTF8')
    || convert_to(COALESCE(p_request_id, ''), 'UTF8')
    || convert_to(COALESCE(host(p_ip_address), ''), 'UTF8')
    || convert_to(COALESCE(p_user_agent, ''), 'UTF8')
    -- jsonb::text is canonical in Postgres: keys sorted, whitespace normalised,
    -- duplicates removed. json::text would not be.
    || convert_to(COALESCE(p_data, '{}'::jsonb)::text, 'UTF8')
  );
$$;

-- ----------------------------------------------------------------------------
-- verify_chain, now using the one shared definition
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit.verify_chain(p_from bigint DEFAULT 0)
RETURNS TABLE (bad_seq bigint, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $$
DECLARE
  r      record;
  v_prev bytea := NULL;
  v_expected_seq bigint := NULL;
BEGIN
  FOR r IN
    SELECT * FROM audit.event WHERE seq > p_from ORDER BY seq
  LOOP
    -- A gap means a row was removed. The append-only trigger forbids DELETE, so
    -- a gap is evidence of something that bypassed it entirely.
    IF v_expected_seq IS NOT NULL AND r.seq <> v_expected_seq THEN
      bad_seq := r.seq;
      reason  := format('gap in sequence: expected %s, found %s', v_expected_seq, r.seq);
      RETURN NEXT;
      RETURN;
    END IF;

    IF r.hash_version <> 2 THEN
      -- Not a failure of the chain: a failure of THIS CODE to know how to check
      -- it. Saying so is the only honest answer, and far better than silently
      -- verifying a row with the wrong algorithm.
      bad_seq := r.seq;
      reason  := format('unsupported hash_version %s; this build can only verify version 2', r.hash_version);
      RETURN NEXT;
      RETURN;
    END IF;

    IF v_prev IS NOT NULL AND r.prev_hash <> v_prev THEN
      bad_seq := r.seq;
      reason  := 'prev_hash does not match the previous row''s hash';
      RETURN NEXT;
      RETURN;
    END IF;

    IF audit.event_hash(
         r.prev_hash, r.id, r.occurred_at, r.action,
         r.actor_user_id, r.actor_member_id, r.organization_id,
         r.subject_type, r.subject_id, r.request_id,
         r.ip_address, r.user_agent, r.data
       ) <> r.hash THEN
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

REVOKE ALL ON FUNCTION audit.event_hash(bytea, uuid, timestamptz, text, text, text, text, text, text, text, inet, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.event_hash(bytea, uuid, timestamptz, text, text, text, text, text, text, text, inet, text, jsonb) TO rayi_api, rayi_worker;
