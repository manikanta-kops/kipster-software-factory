ALTER TABLE attempts DROP CONSTRAINT attempts_waiting_for_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_waiting_for_check
  CHECK (waiting_for IN ('human', 'ask', 'pull-request-merge', 'pull-request-checks'));

CREATE TABLE pull_request_descriptions (
  ticket_id integer NOT NULL REFERENCES tickets(id),
  head_commit text NOT NULL,
  body text NOT NULL,
  PRIMARY KEY (ticket_id, head_commit)
);
