-- Tokens an agent attempt's runs reported; null when none reported any, and for human and system attempts.
ALTER TABLE attempts
  ADD COLUMN input_tokens bigint CHECK (input_tokens >= 0),
  ADD COLUMN output_tokens bigint CHECK (output_tokens >= 0);
