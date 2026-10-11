# Code Review: pi-tasklists

## Status: addressed (refinement pass)

The first draft was written against a fabricated extension API (`@mariozechner/pi-ai`,
`initialize`/`run(context)` entry points, a custom `history` replay). It would not have
loaded in real Pi. The refinement pass rewrote the extension against the actual
`@i-enliven/pi-coding-agent` API, verified against the SDK docs
(`docs/extensions.md`, `docs/compaction.md`) and the canonical
`examples/extensions/todo.ts`.

| Requirement | Status | Notes |
| :--- | :--- | :--- |
| Correct extension API | PASS | Default-export factory, `pi.registerTool`, `pi.registerCommand`, TypeBox params, `{content, details}` results. |
| Multi-list Support | PASS | `lists` map + optional `listId` tool param. |
| `PI_TASKLIST_ID` Initialization | PASS | Used as a fallback only; persisted active-list entry wins. |
| Slash Commands | PASS | `/tasklist`, `/tasklists`, `/todos` via `pi.registerCommand`; output via `ctx.ui.notify`. |
| Compaction / reload survival | PASS | Tasks rebuilt from tool-result `details`; active list rebuilt from a `pi.appendEntry` custom entry. |
| State immutability | PASS | All transitions go through the pure `reducer`; no in-place mutation. |
| Session isolation | PASS | `Store` is per-load and reset on `session_start`/`session_tree`; no module singleton. |
| Type safety | PASS | `tsc --noEmit` clean against the real SDK types. |

## Resolved findings

### 1. State mutation in the tool handler (was: STATE INTEGRITY)
The old handler mutated lists in place (`list.tasks.push`, `task.status = ...`). The tool
now dispatches `CREATE_TASK` / `UPDATE_TASK` / `DELETE_TASK` / `CLEAR_LIST` actions; the
reducer produces new state.

### 2. Active-list context lost on compaction (was: COMPACTION FAIL)
`/tasklist` now persists `pi-tasklists:active-list` via `pi.appendEntry`, and
`reconstructState` restores `activeListId` from it. Verified: after a simulated reload
the active list is restored from the entry, not the env default.

## Verification
- `tsc --noEmit`: clean.
- jiti-driven functional smoke test (23 assertions) covering: tool create/update/
  delete/list/get, explicit `listId` targeting, `/tasklist` switching + persistence,
  `/tasklists` active marker, reload reconstruction (last-write-wins per list, `nextId`
  continuity), and `PI_TASKLIST_ID` fallback-vs-override ordering. All passed.
