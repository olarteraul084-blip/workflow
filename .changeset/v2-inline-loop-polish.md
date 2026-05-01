---
"@workflow/core": patch
"@workflow/world-local": patch
---

V2 inline-loop polish: enforce a single inline executor per step (atomic `step_created` per correlationId via per-step mutex in world-local; ownership-gated inline dispatch in the runtime), drop the per-iteration `runs.get` round-trip in favor of detecting concurrent completion from the event log, and lower the lock-release polling interval from 100ms to 10ms so each writable-bearing step waits ~5ms instead of ~50ms. Together these eliminate orphaned `step_started` events on replay and cut several hundred ms off the critical path of streaming workflows like `DurableAgent.chat`.
