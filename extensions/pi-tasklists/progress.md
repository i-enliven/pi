# pi-tasklists Implementation Progress

## Phase 1: Planning
- [x] Technical specification created.

## Phase 2: Implementation
- [x] Initial draft (against an incorrect API — superseded).

## Phase 3: Review
- [x] Code audit. (See [review.md](review.md))

## Phase 4: Refinement
- [x] Rewrote against the real `@i-enliven/pi-coding-agent` extension API.
- [x] Default-export factory; `pi.registerTool` + `pi.registerCommand`.
- [x] State rebuilt from the session branch on `session_start`/`session_tree`.
- [x] Active list persisted via `pi.appendEntry` (survives reload/compaction).
- [x] Immutable state transitions via the reducer (no in-place mutation).
- [x] `PI_TASKLIST_ID` treated as a fallback, not an override.
- [x] `tsc --noEmit` clean; 23-assertion functional smoke test passing.

## To run
Install peer deps (`@i-enliven/pi-coding-agent`, `@i-enliven/pi-ai`,
`@i-enliven/pi-tui`, `typebox`), then load with `pi -e ./src/index.ts`, or place
the package under `~/.pi/agent/extensions/` for auto-discovery.
