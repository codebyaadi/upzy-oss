-- Tells waiting workers that jobs were queued, so they start within milliseconds instead of at their next poll. One
-- notification per queue per statement, delivered when the inserting transaction commits. The payload is the queue name.
CREATE FUNCTION notify_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('upzy_jobs', q) FROM (SELECT DISTINCT queue AS q FROM new_rows) s;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER jobs_notify AFTER INSERT ON "jobs" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION notify_jobs();
