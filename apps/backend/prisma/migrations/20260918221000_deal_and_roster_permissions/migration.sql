-- Permissions for the deal, campaign-update, roster and organization-update
-- routes.
--
-- A route declaring a permission that no role holds is a route NOBODY can call.
-- It fails closed, which is the right direction, but it fails silently — the
-- endpoint 403s for every user including the owner, and the first report is a
-- customer saying a button does nothing. The integration test added alongside
-- this migration asserts every permission in the operation manifest is granted
-- to at least one role, so the gap is a failing test rather than a support call.

INSERT INTO "role_permission" ("id", "role", "scope", "permission") VALUES
  -- Owner — everything.
  (gen_random_uuid(), 'owner', 'org', 'org:update'),
  (gen_random_uuid(), 'owner', 'org', 'campaign:update'),
  (gen_random_uuid(), 'owner', 'org', 'creator:read'),
  (gen_random_uuid(), 'owner', 'org', 'deal:read'),
  (gen_random_uuid(), 'owner', 'org', 'deal:create'),
  (gen_random_uuid(), 'owner', 'org', 'deal:offer'),
  (gen_random_uuid(), 'owner', 'org', 'deal:terminate'),
  (gen_random_uuid(), 'owner', 'org', 'workspace:update'),
  (gen_random_uuid(), 'owner', 'org', 'member:update'),
  (gen_random_uuid(), 'owner', 'org', 'deliverable:read'),
  (gen_random_uuid(), 'owner', 'org', 'deliverable:review'),

  -- Admin — can run the business but NOT rename the organization, because the
  -- name is what creators see on every offer already sent.
  (gen_random_uuid(), 'admin', 'org', 'campaign:update'),
  (gen_random_uuid(), 'admin', 'org', 'campaign:create'),
  (gen_random_uuid(), 'admin', 'org', 'creator:read'),
  (gen_random_uuid(), 'admin', 'org', 'deal:read'),
  (gen_random_uuid(), 'admin', 'org', 'deal:create'),
  (gen_random_uuid(), 'admin', 'org', 'deal:offer'),
  (gen_random_uuid(), 'admin', 'org', 'deal:terminate'),
  (gen_random_uuid(), 'admin', 'org', 'workspace:update'),
  (gen_random_uuid(), 'admin', 'org', 'member:update'),
  (gen_random_uuid(), 'admin', 'org', 'member:remove'),
  (gen_random_uuid(), 'admin', 'org', 'deliverable:read'),
  (gen_random_uuid(), 'admin', 'org', 'deliverable:review'),

  -- Member — sees who the org works with, and nothing that commits money.
  (gen_random_uuid(), 'member', 'org', 'creator:read'),
  (gen_random_uuid(), 'member', 'org', 'deal:read'),

  -- Workspace admin — runs a sub-brand end to end, including offering deals
  -- beneath the envelope finance approved.
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'campaign:update'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'creator:read'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'deal:read'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'deal:create'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'deal:offer'),
  (gen_random_uuid(), 'workspace_admin', 'workspace', 'deal:terminate'),

  -- Campaign manager — "marketing spends at the speed of DMs". Creates and
  -- offers deals, but cannot END one: terminating decides what money comes back
  -- and what stays with the creator, which is a finance conversation.
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'campaign:update'),
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'creator:read'),
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'deal:read'),
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'deal:create'),
  (gen_random_uuid(), 'campaign_manager', 'workspace', 'deal:offer'),

  -- Reviewer — reads deals so the queue can show what a decision is worth.
  -- Cannot create, offer or end one.
  (gen_random_uuid(), 'reviewer', 'workspace', 'deal:read'),
  (gen_random_uuid(), 'reviewer', 'workspace', 'creator:read'),

  -- Viewer — read-only.
  (gen_random_uuid(), 'viewer', 'workspace', 'campaign:read'),
  (gen_random_uuid(), 'viewer', 'workspace', 'deal:read')
ON CONFLICT DO NOTHING;
