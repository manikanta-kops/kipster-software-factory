CREATE TABLE factory_mode (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  demo boolean NOT NULL DEFAULT false
);
INSERT INTO factory_mode (demo)
  SELECT EXISTS (SELECT 1 FROM repositories WHERE lower(slug) = 'kipster/demo-shop');

ALTER TABLE tickets ADD COLUMN worktree_cleaned_at timestamptz;
