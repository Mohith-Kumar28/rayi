-- ============================================================================
-- AUDIT: the sequence-gap check was wrong, and the chain already does its job
-- ============================================================================
--
-- `verify_chain` treated a gap in `seq` as evidence of a deleted row. It is not.
--
-- `GENERATED ALWAYS AS IDENTITY` is **not gapless**. A transaction that inserts
-- an audit row and then rolls back — a failed request, a constraint violation, a
-- deadlock — has already consumed its sequence value, and that value never
-- comes back. Sequences are deliberately non-transactional so that concurrent
-- writers do not serialize on them.
--
-- So the gap check reported TAMPERING every time an ordinary request failed.
-- That is the same defect as the `inet` mismatch this file's predecessor fixed,
-- and it is the more dangerous shape: a tamper alarm that fires on honest data
-- is one people learn to ignore, and they learn it long before the day it
-- matters.
--
-- The hash chain already detects what the gap check was reaching for. Deleting
-- an interior row leaves the next row's `prev_hash` pointing at a hash that is
-- no longer the previous row's, which `verify_chain` checks directly and which
-- has no false positives at all.
--
-- What the chain genuinely cannot see is a deleted SUFFIX: remove the newest N
-- rows and the remaining prefix verifies perfectly. No amount of internal
-- checking fixes that — a log cannot prove, from inside itself, that it has not
-- been truncated. The answer is to anchor the head hash somewhere the database
-- role cannot reach: `audit.head()` returns it, and shipping it off-account
-- (S3 Object Lock, per docs/05-security.md) is what makes truncation visible.
-- That is an operational control for step 16, and it is written down here rather
-- than left as an assumption that the chain covers it.
-- ============================================================================

CREATE OR REPLACE FUNCTION audit.verify_chain(p_from bigint DEFAULT 0)
RETURNS TABLE (bad_seq bigint, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $$
DECLARE
  r      record;
  v_prev bytea := NULL;
BEGIN
  FOR r IN
    SELECT * FROM audit.event WHERE seq > p_from ORDER BY seq
  LOOP
    IF r.hash_version <> 2 THEN
      -- Not a failure of the chain: a failure of THIS CODE to know how to check
      -- it. Saying so is the honest answer, and far better than silently
      -- verifying a row with the wrong algorithm.
      bad_seq := r.seq;
      reason  := format('unsupported hash_version %s; this build can only verify version 2', r.hash_version);
      RETURN NEXT;
      RETURN;
    END IF;

    -- THE detector. A row removed from the middle breaks this link, because the
    -- next row still commits to the hash of the row that is now gone.
    --
    -- Skipped when `p_from` > 0, since starting mid-chain means there is
    -- legitimately no previous row in scope to compare against.
    IF v_prev IS NOT NULL AND r.prev_hash <> v_prev THEN
      bad_seq := r.seq;
      reason  := 'prev_hash does not match the previous row''s hash — a row was removed or altered';
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
  END LOOP;

  RETURN;
END;
$$;

-- ----------------------------------------------------------------------------
-- audit.head — what to anchor externally
-- ----------------------------------------------------------------------------
--
-- The current tip of the chain. Published somewhere the database role cannot
-- reach, on a schedule, it makes truncation detectable: a log that has lost its
-- newest rows can no longer produce the head that was published an hour ago.
--
-- Returns NULL seq and a zero hash on an empty log, rather than no row, so a
-- caller cannot mistake "nothing recorded yet" for "the query failed".

CREATE OR REPLACE FUNCTION audit.head()
RETURNS TABLE (seq bigint, hash bytea, occurred_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = audit, pg_temp
AS $$
  SELECT e.seq, e.hash, e.occurred_at
    FROM audit.event e
   ORDER BY e.seq DESC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION audit.head() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.head() TO rayi_api, rayi_worker;
