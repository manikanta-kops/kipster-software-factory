-- Engine settings edited in the web app. One row; once saved it replaces the
-- concurrency, step timeout and agent values from config.json.
CREATE TABLE settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  engine jsonb NOT NULL CHECK (jsonb_typeof(engine) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The CLI, model and effort an agent attempt ran with.
ALTER TABLE attempts ADD COLUMN agent jsonb
  CHECK (agent IS NULL OR jsonb_typeof(agent) = 'object');
