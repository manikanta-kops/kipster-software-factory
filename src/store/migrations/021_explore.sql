-- The factory's local repository for tickets without one; at most one exists.
ALTER TABLE repositories ADD COLUMN scratch boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX repositories_one_scratch ON repositories (scratch) WHERE scratch;

ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('plan', 'comment', 'finding', 'evidence', 'log', 'note', 'decision', 'output'));
