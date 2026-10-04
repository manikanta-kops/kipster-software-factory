CREATE TABLE factory_mode (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  demo boolean NOT NULL DEFAULT false
);
INSERT INTO factory_mode DEFAULT VALUES;

ALTER TABLE tickets ADD COLUMN worktree_cleaned_at timestamptz;
