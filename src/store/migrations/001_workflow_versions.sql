-- Every workflow version the factory has loaded. Tickets will reference (name, version)
-- so a workflow edited mid-flight never changes a ticket that already started.
CREATE TABLE workflow_versions (
  name text NOT NULL,
  version text NOT NULL,
  source text NOT NULL,
  definition jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
