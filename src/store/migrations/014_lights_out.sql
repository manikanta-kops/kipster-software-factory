ALTER TABLE tickets ADD COLUMN lights_out boolean NOT NULL DEFAULT false;

ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('plan', 'comment', 'finding', 'evidence', 'log', 'note', 'decision'));
ALTER TABLE artifacts ADD COLUMN decision jsonb;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_decision_check
  CHECK ((kind = 'decision') = (decision IS NOT NULL));

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending', 'running', 'parked', 'pr-ready', 'merged', 'left-open', 'conflict', 'failed', 'cancelled'));
