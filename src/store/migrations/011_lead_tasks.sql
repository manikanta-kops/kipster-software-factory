ALTER TABLE attempts DROP CONSTRAINT attempts_waiting_for_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_waiting_for_check
  CHECK (waiting_for IN ('human', 'ask', 'pull-request-merge', 'pull-request-checks', 'decision', 'other-repo', 'tasks'));

-- A lead's tasks. Each runs as a child ticket once the run-tasks step starts it.
CREATE TABLE tasks (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES tickets(id),
  attempt_id integer NOT NULL REFERENCES attempts(id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]*$'),
  title text NOT NULL CHECK (title <> ''),
  instructions text NOT NULL CHECK (instructions <> ''),
  land text NOT NULL CHECK (land IN ('branch', 'pr')),
  workflow text NOT NULL,
  agent jsonb CHECK (agent IS NULL OR jsonb_typeof(agent) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'pr-ready', 'merged', 'left-open', 'conflict', 'failed', 'cancelled')),
  -- The last status the lead was told about.
  reported_status text,
  decision text CHECK (decision IN ('merge', 'leave-open')),
  result text,
  child_ticket_id integer UNIQUE REFERENCES tickets(id),
  base_commit text CHECK (base_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, key),
  CHECK (ticket_id <> child_ticket_id),
  CHECK (decision IS NULL OR land = 'pr')
);
CREATE INDEX tasks_ticket ON tasks(ticket_id, id);
