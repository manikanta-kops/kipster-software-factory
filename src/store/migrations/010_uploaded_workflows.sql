-- The current version of each workflow added through the API. Workflow files on
-- disk are loaded at startup and are not listed here.
CREATE TABLE uploaded_workflows (
  name text PRIMARY KEY,
  version text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (name, version) REFERENCES workflow_versions (name, version)
);
