ALTER TABLE tickets ADD COLUMN skipped_steps jsonb NOT NULL DEFAULT '[]'::jsonb;
