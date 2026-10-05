ALTER TABLE artifacts ADD COLUMN scenario text;
ALTER TABLE artifacts ADD COLUMN pruned_at timestamptz;
ALTER TABLE artifacts ADD COLUMN retention_days integer;
ALTER TABLE attempts ADD COLUMN reproduction_attempt_id integer REFERENCES attempts(id);
CREATE TABLE merge_gates (
  ticket_id integer PRIMARY KEY REFERENCES tickets(id),
  evaluation jsonb NOT NULL,
  last_green jsonb
);
CREATE INDEX artifacts_retention ON artifacts(ticket_id) WHERE pruned_at IS NULL AND kind IN ('evidence', 'log');
ALTER TABLE artifacts DROP CONSTRAINT artifacts_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_content CHECK (pruned_at IS NOT NULL OR ((content IS NULL) <> (path IS NULL)));
ALTER TABLE artifacts ADD COLUMN scenario_result text CHECK (scenario_result IN ('passed', 'failed', 'unverified', 'reproduced'));
ALTER TABLE tickets ADD COLUMN evidence_pruned_at timestamptz;
ALTER TABLE artifacts ADD COLUMN observed_commit text CHECK (observed_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$');
