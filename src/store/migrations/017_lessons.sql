CREATE TABLE lessons (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repository_id integer REFERENCES repositories(id),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 200 AND text !~ E'[\\r\\n]'),
  source text NOT NULL CHECK (source IN ('changes-needed', 'repeated-failure', 'owner-comment')),
  source_ticket_id integer NOT NULL REFERENCES tickets(id),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'retired')),
  retired_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK ((status = 'retired') = (retired_reason IS NOT NULL))
);
-- Rejected and retired mistakes stay decided rather than reappearing at every park.
CREATE UNIQUE INDEX lessons_scope_key ON lessons (coalesce(repository_id, 0), key);
CREATE INDEX lessons_status ON lessons (status, repository_id);
