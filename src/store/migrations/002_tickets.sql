-- Repositories, tickets and their attempts, artifacts and events.

CREATE TABLE repositories (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL CHECK (slug ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  clone_url text NOT NULL CHECK (clone_url <> ''),
  default_branch text NOT NULL CHECK (default_branch <> ''),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'failed')),
  last_error text,
  capabilities text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- GitHub treats owner/name case-insensitively.
CREATE UNIQUE INDEX repositories_slug ON repositories (lower(slug));

CREATE SEQUENCE ticket_numbers AS integer;

CREATE TABLE tickets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  repository_id integer NOT NULL REFERENCES repositories (id),
  workflow_name text NOT NULL,
  workflow_version text NOT NULL,
  title text NOT NULL CHECK (title <> ''),
  body text NOT NULL DEFAULT '',
  branch text NOT NULL UNIQUE,
  pull_request_url text,
  current_step text NOT NULL,
  -- Derived from the latest attempt by the lifecycle and kept here so lists can filter on it.
  status text NOT NULL
    CHECK (status IN ('queued', 'running', 'needs-you', 'done', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workflow_name, workflow_version)
    REFERENCES workflow_versions (name, version)
);

CREATE INDEX tickets_status ON tickets (status, updated_at DESC);

CREATE TABLE attempts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES tickets (id),
  step_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending', 'running', 'waiting', 'finished', 'failed', 'interrupted')
  ),
  outcome text,
  summary text,
  executor text,
  error text,
  waiting_for text CHECK (waiting_for IN ('human', 'ask', 'pull-request-merge')),
  ask_reason text CHECK (
    ask_reason IN ('needs-decision', 'routed', 'unrouted', 'limit', 'failed', 'interrupted')
  ),
  next jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  started_at timestamptz,
  waiting_since timestamptz,
  finished_at timestamptz,
  CHECK ((status = 'waiting') <= (waiting_for IS NOT NULL AND waiting_since IS NOT NULL)),
  CHECK ((waiting_for IS NOT DISTINCT FROM 'ask') = (ask_reason IS NOT NULL))
);

-- A ticket runs one step at a time.
CREATE UNIQUE INDEX attempts_one_open_per_ticket ON attempts (ticket_id)
  WHERE status IN ('pending', 'running', 'waiting');
CREATE INDEX attempts_ticket ON attempts (ticket_id, id);
CREATE INDEX attempts_claimable ON attempts (id)
  WHERE status = 'pending' AND claimed_at IS NULL;

CREATE TABLE artifacts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES tickets (id),
  attempt_id integer NOT NULL REFERENCES attempts (id),
  kind text NOT NULL
    CHECK (kind IN ('plan', 'comment', 'finding', 'evidence', 'log', 'note')),
  title text NOT NULL CHECK (title <> ''),
  content text,
  path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((content IS NULL) <> (path IS NULL))
);

CREATE INDEX artifacts_ticket ON artifacts (ticket_id, id);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  ticket_id integer REFERENCES tickets (id),
  kind text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_ticket ON events (ticket_id, id);

CREATE FUNCTION notify_factory_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('factory_events', NEW.id::text);
  RETURN NULL;
END
$$;

CREATE TRIGGER events_notify AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION notify_factory_event();

CREATE FUNCTION reject_event_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only';
END
$$;

CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION reject_event_change();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_event_change();
