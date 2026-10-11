# Technical Specification: pi-tasklists

## Overview
`pi-tasklists` is a Pi extension (for `@i-enliven/pi-coding-agent`) that adds
multi-list task management. Where a single global todo list is limiting, this lets
users segregate tasks into named contexts (e.g. "work", "personal", "project-x").

It follows the canonical stateful-extension pattern from the SDK's
`examples/extensions/todo.ts`: state lives in the session (not external files), so
branching and compaction stay correct automatically.

## Technical Architecture

### Extension shape
The module's default export is the factory `export default function (pi: ExtensionAPI)`.
The factory:
- creates a per-load `Store` (never a module singleton, so state cannot leak across
  `/new`, `/resume`, or `/fork`),
- rebuilds state on `session_start` and `session_tree`,
- registers the `todo` tool and the `/tasklist`, `/tasklists`, `/todos` commands.

### 1. State Management
`GlobalState` holds a map of `TaskList` objects plus `activeListId`. All transitions
go through a pure `reducer` (immutable updates) dispatched on the `Store`; nothing
mutates state objects in place.

### 2. Persistence & Compaction Survival
Compaction does **not** delete session entries — it only changes what the LLM sees —
so `ctx.sessionManager.getBranch()` still returns every prior entry. State is rebuilt
from the branch on each `session_start`/`session_tree`:
- **Tasks**: each `todo` tool result stores a `ToolResponseDetails` snapshot of the
  *single* list it touched (`listId`, `tasks`, `nextId`). Reconstruction replays these
  per `listId` (last-write-wins). Snapshotting only the touched list keeps sibling
  lists independent under branching.
- **Active list**: `/tasklist <name>` persists a `pi-tasklists:active-list` custom
  entry via `pi.appendEntry`. Reconstruction restores `activeListId` from the last such
  entry and treats every switched-to id as a known (possibly empty) list.

### 3. Environment Variable Initialization
`PI_TASKLIST_ID` is a **fallback**, not an override. It seeds the active list only when
the branch has no persisted active-list entry — so resuming a session keeps the user's
last `/tasklist` choice instead of snapping back to the env value. Defaults to `default`.

### 4. Multi-list Support
- **Explicit Targeting**: the `todo` tool accepts an optional `listId` (operates on that
  list without changing the active list).
- **Context Switching**: `/tasklist <name>` switches the active list (creating it if new).

## File Structure

```
pi-tasklists/
├── src/
│   ├── index.ts            # Default-export factory; wires events, tool, commands
│   ├── state/
│   │   ├── types.ts        # Task, TaskList, GlobalState, details/entry types
│   │   ├── reducer.ts      # Pure immutable state transitions
│   │   ├── store.ts        # Per-load state holder (dispatch/getState/ensureList)
│   │   └── replay.ts       # Rebuild GlobalState from the session branch
│   ├── tool/todo.ts        # `todo` tool (pi.registerTool, TypeBox params)
│   └── view/commands.ts    # /tasklist, /tasklists, /todos (pi.registerCommand)
├── package.json            # `pi` manifest + peer deps on @i-enliven/* + typebox
├── tsconfig.json           # Editor/typecheck config (runtime uses jiti, no build)
└── spec.md                 # This specification
```

Runtime imports: `@i-enliven/pi-coding-agent` (types), `@i-enliven/pi-ai`
(`StringEnum`), `@i-enliven/pi-tui` (`Text`), `typebox` (`Type`). Extensions are
loaded via jiti, so TypeScript runs without a build step.
