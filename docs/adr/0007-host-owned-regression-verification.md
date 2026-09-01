# Make verification a host-owned regression gate

## Status

Proposed. Focused validation planning and snapshot-bound review evidence exist, but automatic profile execution and baseline regression classification are not yet a complete product gate.

Domi, rather than the model, will choose and run the user-confirmed Verification Profile, compare failures with the Session Base, and permit Ready to Apply only when the required level has no new Regression. Existing Baseline Failures remain visible without blocking, while failures may trigger at most two Agent Repair Cycles; this trades some latency and implementation cost for deterministic evidence without requiring every existing project check to be green.
