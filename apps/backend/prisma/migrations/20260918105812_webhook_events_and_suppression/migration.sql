-- CreateTable
CREATE TABLE "webhook_event" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "processedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "webhookEventId" TEXT,
    "suppressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt" TIMESTAMP(3),
    "liftedBy" TEXT,

    CONSTRAINT "email_suppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_event_status_receivedAt_idx" ON "webhook_event"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "webhook_event_source_eventType_receivedAt_idx" ON "webhook_event"("source", "eventType", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_source_externalId_key" ON "webhook_event"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "email_suppression_email_key" ON "email_suppression"("email");

-- CreateIndex
CREATE INDEX "email_suppression_reason_suppressedAt_idx" ON "email_suppression"("reason", "suppressedAt");

-- ----------------------------------------------------------------------------
-- The stored payload is EVIDENCE, so it is append-only
-- ----------------------------------------------------------------------------
--
-- The signature was computed over these exact bytes. If the payload, the headers
-- or the provider's id can be edited after the fact, then "we can prove what
-- Stripe told us" stops being true — and that proof is what settles a dispute
-- about a payment that did or did not happen.
--
-- The PROCESSING columns must still be writable: a worker marks a row processed
-- or failed. So this is a column-level rule, not a table-level one, and it is
-- enforced by comparing OLD to NEW rather than by revoking UPDATE outright.

CREATE OR REPLACE FUNCTION public.webhook_event_payload_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source      IS DISTINCT FROM OLD.source
  OR NEW."externalId" IS DISTINCT FROM OLD."externalId"
  OR NEW."eventType"  IS DISTINCT FROM OLD."eventType"
  OR NEW.payload      IS DISTINCT FROM OLD.payload
  OR NEW.headers      IS DISTINCT FROM OLD.headers
  OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN
    RAISE EXCEPTION
      'webhook_event is evidence: source, externalId, eventType, payload, headers and receivedAt cannot be changed after receipt.'
      USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_event_payload_immutable
  BEFORE UPDATE ON "webhook_event"
  FOR EACH ROW EXECUTE FUNCTION public.webhook_event_payload_is_immutable();

-- A delivery that has been received is never deleted. Retention is a separate,
-- deliberate operation; a DELETE here is how an inconvenient event disappears.
CREATE OR REPLACE FUNCTION public.webhook_event_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'webhook_event is append-only; DELETE is not permitted.'
    USING ERRCODE = '0A000';
END;
$$;

CREATE TRIGGER webhook_event_append_only
  BEFORE DELETE ON "webhook_event"
  FOR EACH ROW EXECUTE FUNCTION public.webhook_event_no_delete();

-- ----------------------------------------------------------------------------
-- Suppression is compared case-insensitively
-- ----------------------------------------------------------------------------
--
-- The application lower-cases before writing, but that is a convention a future
-- code path can forget. This makes `A@b.com` and `a@b.com` the same row at the
-- storage engine, so a suppression cannot be bypassed by changing case.

DROP INDEX IF EXISTS "email_suppression_email_key";
CREATE UNIQUE INDEX "email_suppression_email_key" ON "email_suppression" (lower("email"));

ALTER TABLE "email_suppression"
  ADD CONSTRAINT email_suppression_reason_known
  CHECK (reason IN ('hard_bounce', 'complaint', 'manual'));
