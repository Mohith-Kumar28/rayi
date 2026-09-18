-- ============================================================================
-- post_entry: CONCURRENT idempotency
-- ============================================================================
--
-- The original `post_entry` was idempotent SEQUENTIALLY — it looked for an
-- existing entry with the same (source_type, source_id) and returned it. Under
-- CONCURRENCY it was not: two workers handed the same job both find nothing,
-- both insert, and the second gets SQLSTATE 23505 from `entry_source_key`.
--
-- The ledger stayed correct — exactly one entry was posted, which is the
-- guarantee that matters — but the caller could not tell "you lost a harmless
-- race" from "this posting was refused". And 23505 is classified TERMINAL by
-- the retry policy, correctly, so the loser reported a failure for an allocation
-- that had in fact succeeded. The command row was then marked `failed` while a
-- real ledger entry existed for it: two records of the same event disagreeing,
-- which is the one outcome a double-entry system exists to prevent.
--
-- This is not hypothetical. At-least-once delivery is the contract, and two
-- workers receiving the same notification is the normal case during a rolling
-- deploy.
--
-- The fix is to make losing the race converge on the winner's result, so a
-- replay is a replay whether it arrives a second later or a day later.
-- ============================================================================

CREATE OR REPLACE FUNCTION ledger.post_entry(
  p_transition   text,
  p_source_type  text,
  p_source_id    text,
  p_lines        jsonb,
  p_actor        uuid    DEFAULT NULL,
  p_request_id   text    DEFAULT NULL,
  p_code_version text    DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ledger, pg_temp
AS $$
DECLARE
  v_entry_id uuid;
  v_existing uuid;
  v_account  uuid;
  v_delta    bigint;
BEGIN
  IF jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'post_entry requires at least 2 lines, got %.',
      jsonb_array_length(p_lines) USING ERRCODE = '23514';
  END IF;

  -- Fast path: the entry already exists and is committed. Cheap, and the common
  -- case for a redelivered job.
  SELECT id INTO v_existing
    FROM ledger.entry
   WHERE source_type = p_source_type AND source_id = p_source_id;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- Slow path: nothing was visible, so try to be the one that creates it.
  --
  -- A concurrent transaction may have inserted the same key since the SELECT
  -- above took its snapshot. If it has committed, this INSERT raises
  -- unique_violation; if it is still open, this INSERT BLOCKS on the unique
  -- index until that transaction commits or aborts, and then does the right
  -- thing either way. Both outcomes are handled.
  BEGIN
    INSERT INTO ledger.entry (
      transition, source_type, source_id, actor_principal_id, request_id, code_version
    )
    VALUES (
      p_transition, p_source_type, p_source_id, p_actor, p_request_id, p_code_version
    )
    RETURNING id INTO v_entry_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- We lost. The winner's entry is committed by now — READ COMMITTED takes a
      -- fresh snapshot for this statement, so it is visible — and it holds the
      -- same lines and the same balance effects. Returning it is not a
      -- consolation prize: it is the correct answer to "post this entry", which
      -- has happened exactly once.
      --
      -- STRICT because a missing row here would mean the unique violation came
      -- from somewhere other than this key, and silently returning NULL would
      -- hand the caller an entry id that does not exist.
      SELECT id INTO STRICT v_existing
        FROM ledger.entry
       WHERE source_type = p_source_type AND source_id = p_source_id;

      RETURN v_existing;
  END;

  -- Lines carry currency and normal_balance copied from their account, so the
  -- composite FK rejects any mismatch and `natural_minor` is computed correctly.
  INSERT INTO ledger.entry_line (
    entry_id, account_id, currency, normal_balance, direction, amount_minor
  )
  SELECT
    v_entry_id,
    a.id,
    a.currency,
    a.normal_balance,
    (l->>'direction')::ledger.direction,
    (l->>'amount_minor')::bigint
  FROM jsonb_array_elements(p_lines) AS l
  JOIN ledger.account a ON a.id = (l->>'account_id')::uuid;

  -- Every supplied line must have matched an account. A typo'd account id would
  -- otherwise silently drop a leg and leave the entry unbalanced at COMMIT —
  -- caught, but with a far less useful error.
  IF (SELECT COUNT(*) FROM ledger.entry_line WHERE entry_id = v_entry_id)
     <> jsonb_array_length(p_lines) THEN
    RAISE EXCEPTION 'One or more account_ids in post_entry do not exist.'
      USING ERRCODE = '23503';
  END IF;

  -- Apply balances in SORTED ACCOUNT ORDER. A canonical lock order is what stops
  -- two concurrent postings that touch the same pair of accounts from
  -- deadlocking against each other.
  FOR v_account, v_delta IN
    SELECT account_id, SUM(natural_minor)
      FROM ledger.entry_line
     WHERE entry_id = v_entry_id
     GROUP BY account_id
     ORDER BY account_id
  LOOP
    -- ONE STATEMENT: the UPDATE's RETURNING feeds the snapshot INSERT, so the
    -- mutable balance and its immutable history agree by construction. If the
    -- non-negative CHECK fires, the whole statement aborts and neither exists.
    --
    -- The UPDATE takes the row lock implicitly. Under READ COMMITTED, Postgres
    -- re-evaluates `balance_minor + v_delta` against the post-commit value, so a
    -- second concurrent writer sees the TRUE balance and the CHECK aborts it.
    -- No SERIALIZABLE, no 40001 retry storm.
    WITH updated AS (
      UPDATE ledger.account_balance
         SET balance_minor = balance_minor + v_delta,
             version       = version + 1
       WHERE account_id = v_account
      RETURNING account_id, balance_minor, version
    )
    INSERT INTO ledger.balance_snapshot (account_id, seq, balance_after, entry_id)
    SELECT account_id, version, balance_minor, v_entry_id FROM updated;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No balance row for account % — accounts must be created via ledger.create_account.',
        v_account USING ERRCODE = '23503';
    END IF;
  END LOOP;

  RETURN v_entry_id;
END;
$$;
