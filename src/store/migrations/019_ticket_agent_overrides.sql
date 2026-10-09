-- Only explicit ticket choices are stored; omitted choices keep following settings.
ALTER TABLE tickets ADD COLUMN agent_overrides jsonb
  CHECK (agent_overrides IS NULL OR jsonb_typeof(agent_overrides) = 'object');
