ALTER TABLE attempts ADD COLUMN parallel_parent_id integer UNIQUE REFERENCES attempts(id);
DROP INDEX attempts_one_open_per_ticket;
CREATE UNIQUE INDEX attempts_one_open_per_ticket ON attempts (ticket_id)
  WHERE status IN ('pending', 'running', 'waiting') AND parallel_parent_id IS NULL;
