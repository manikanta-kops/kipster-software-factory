ALTER TABLE repositories ADD COLUMN kit_status text NOT NULL DEFAULT 'missing'
  CHECK (kit_status IN ('missing', 'valid', 'invalid'));
ALTER TABLE repositories ADD COLUMN kit_error text;
ALTER TABLE attempts ADD COLUMN head_commit text;
ALTER TABLE artifacts ADD COLUMN media_type text NOT NULL DEFAULT 'application/octet-stream';
UPDATE artifacts SET media_type = 'text/markdown' WHERE content IS NOT NULL;
