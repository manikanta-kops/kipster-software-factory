ALTER TABLE attempts DROP CONSTRAINT attempts_waiting_for_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_waiting_for_check
  CHECK (waiting_for IN ('human', 'ask', 'pull-request-merge', 'pull-request-checks', 'decision'));

CREATE TABLE decision_log (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES tickets(id),
  attempt_id integer NOT NULL UNIQUE REFERENCES attempts(id),
  input jsonb NOT NULL,
  final_option text,
  decided_by text CHECK (decided_by IN ('model', 'owner')),
  overridden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK ((final_option IS NULL) = (decided_by IS NULL)),
  CHECK ((final_option IS NULL) = (decided_at IS NULL))
);
CREATE INDEX decision_log_ticket ON decision_log(ticket_id, id);
