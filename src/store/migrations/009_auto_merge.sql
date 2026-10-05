ALTER TABLE repositories ADD COLUMN auto_merge boolean NOT NULL DEFAULT false;
ALTER TABLE attempts ADD COLUMN owner_review jsonb CHECK (
  owner_review IS NULL OR coalesce((
    jsonb_typeof(owner_review) = 'object' AND
    jsonb_typeof(owner_review->'reason') = 'string' AND
    length(btrim(owner_review->>'reason')) BETWEEN 1 AND 1000
  ), false)
);

CREATE TABLE merge_requests (
  ticket_id integer NOT NULL REFERENCES tickets(id),
  head_commit text NOT NULL CHECK (head_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz,
  error text,
  gate jsonb NOT NULL,
  PRIMARY KEY (ticket_id, head_commit)
);
CREATE TABLE base_syncs (
  ticket_id integer PRIMARY KEY REFERENCES tickets(id),
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0)
);
CREATE TABLE post_merge_checks (
  repository_id integer NOT NULL REFERENCES repositories(id),
  merge_commit text NOT NULL,
  ticket_id integer NOT NULL REFERENCES tickets(id),
  attempt_id integer NOT NULL REFERENCES attempts(id),
  pull_request_url text NOT NULL,
  had_ci boolean NOT NULL,
  merged_by text NOT NULL CHECK (merged_by IN ('factory', 'owner')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'unavailable')),
  kit_failures integer NOT NULL DEFAULT 0 CHECK (kit_failures >= 0),
  kit_error text,
  checks jsonb,
  bug_ticket_id integer REFERENCES tickets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  last_polled_at timestamptz,
  PRIMARY KEY (repository_id, merge_commit)
);
