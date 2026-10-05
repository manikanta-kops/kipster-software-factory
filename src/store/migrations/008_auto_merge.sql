ALTER TABLE repositories ADD COLUMN auto_merge boolean NOT NULL DEFAULT false;
ALTER TABLE decision_log DROP CONSTRAINT decision_log_attempt_id_key;
ALTER TABLE decision_log ADD COLUMN purpose text NOT NULL DEFAULT 'step' CHECK (purpose IN ('step', 'merge'));
ALTER TABLE decision_log ADD COLUMN head_commit text;
ALTER TABLE decision_log ADD COLUMN merge_requested_at timestamptz;
ALTER TABLE decision_log ADD COLUMN merge_succeeded_at timestamptz;
ALTER TABLE decision_log ADD COLUMN merge_error text;
ALTER TABLE decision_log ADD CONSTRAINT merge_decision_head CHECK ((purpose = 'merge') = (head_commit IS NOT NULL));
CREATE UNIQUE INDEX decision_log_step_attempt ON decision_log(attempt_id) WHERE purpose = 'step';
CREATE UNIQUE INDEX decision_log_merge_head ON decision_log(ticket_id, head_commit) WHERE purpose = 'merge';

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
  decision_id integer REFERENCES decision_log(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'unavailable')),
  checks jsonb,
  bug_ticket_id integer REFERENCES tickets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  last_polled_at timestamptz,
  PRIMARY KEY (repository_id, merge_commit)
);
