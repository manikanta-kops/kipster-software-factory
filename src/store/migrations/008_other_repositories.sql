ALTER TABLE attempts DROP CONSTRAINT attempts_waiting_for_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_waiting_for_check
  CHECK (waiting_for IN ('human', 'ask', 'pull-request-merge', 'pull-request-checks', 'decision', 'other-repo'));

CREATE TABLE ticket_dependencies (
  ticket_id integer NOT NULL REFERENCES tickets(id),
  repository_id integer NOT NULL REFERENCES repositories(id),
  PRIMARY KEY (ticket_id, repository_id)
);

CREATE TABLE ticket_links (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  original_ticket_id integer NOT NULL REFERENCES tickets(id),
  attempt_id integer NOT NULL UNIQUE REFERENCES attempts(id),
  linked_ticket_id integer NOT NULL UNIQUE REFERENCES tickets(id),
  merge_commit text CHECK (merge_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  resolved_at timestamptz,
  CHECK (original_ticket_id <> linked_ticket_id)
);
CREATE INDEX ticket_links_original ON ticket_links(original_ticket_id);
