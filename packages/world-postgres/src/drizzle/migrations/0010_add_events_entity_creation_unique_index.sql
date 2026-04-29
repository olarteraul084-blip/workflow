-- Enforce uniqueness of (run_id, correlation_id, event_type) for the
-- entity-creating events (step_created, hook_created, wait_created).
--
-- Without this constraint, two concurrent runtime invocations producing
-- identical correlationIds (e.g. the snapshot runtime's deterministic
-- ULIDs across replays of the same resumption) can both insert events,
-- causing duplicate step/hook/wait events in the log. The unique
-- violation is caught in events.create and surfaced as
-- EntityConflictError, which the runtime already handles as a dedup
-- signal.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_entity_creation_unique"
	ON "workflow"."workflow_events" ("run_id", "correlation_id", "type")
	WHERE "type" IN ('step_created', 'hook_created', 'wait_created');
