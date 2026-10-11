# pi-tasklists

Multi-list task management for the [Pi coding agent](https://github.com/badlogic/pi-mono). Where a single global todo list is limiting, `pi-tasklists` lets you segregate tasks into named contexts — `work`, `personal`, `project-x` — and switch between them. It registers a `todo` tool the model can call and `/tasklist`, `/tasklists`, `/todos` commands for you.

State lives in the session (not external files), so it stays correct across branching, reload, and compaction — the same pattern as the SDK's `examples/extensions/todo.ts`.

## Features

- **Multiple named lists** — keep separate task lists and switch the active context.
- **`todo` tool** — the model manages tasks via `create`, `update`, `list`, `get`, `delete`, `clear`. Pass `listId` to target a specific list, or omit it to use the active one.
- **Rich task fields** — `subject`, `description`, `status` (`pending` / `in_progress` / `completed` / `deleted`), `activeForm`, `owner`, `blockedBy`, `metadata`.
- **Survives reload & compaction** — tasks are rebuilt from each tool result's `details` snapshot, and the active list is persisted as a session entry. Compaction never loses your lists or which one is active.
- **Session isolation** — state is per-session; `/new`, `/resume`, and `/fork` don't leak tasks between sessions.
- **`PI_TASKLIST_ID`** — seeds the initial active list (fallback only; a saved `/tasklist` choice always wins on resume).

## Installation

Install from this repo as a Pi package:

```bash
pi install git:github.com/strugglingcomic/pi-tasklists
```

Or load a local checkout directly:

```bash
pi -e ./src/index.ts
```

Or place the package under `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local) for auto-discovery and `/reload` support.

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/tasklist <name>` | Switch the active tasklist (creates it if new). |
| `/tasklists` | List all tasklists, marking the active one with `*` and showing open-task counts. |
| `/todos` | Show the active list's tasks, grouped by status. |

### The `todo` tool

The model calls `todo` with an `action`:

```jsonc
{ "action": "create", "subject": "Write the migration" }
{ "action": "create", "listId": "work", "subject": "Review PR #42" }
{ "action": "update", "id": 1, "status": "in_progress", "activeForm": "Writing the migration" }
{ "action": "list", "status": "pending" }
{ "action": "delete", "id": 1 }
{ "action": "clear" }
```

A bare `listId` on a `todo` call targets that list without changing your active context; use `/tasklist` to switch the active list.

### Environment

```bash
PI_TASKLIST_ID=work pi
```

Starts with `work` as the active list. This is only a fallback — once you switch lists with `/tasklist`, that choice is what's restored on resume.

## How state survives compaction

Compaction doesn't delete session entries; it only changes what the LLM sees. On every `session_start` / `session_tree`, the extension rebuilds state from `ctx.sessionManager.getBranch()`:

- Each `todo` tool result carries a `details` snapshot of the **single list it touched** (`listId`, `tasks`, `nextId`). Replaying these per-`listId` (last-write-wins) reconstructs every list and keeps sibling lists independent under branching.
- `/tasklist` writes a `pi-tasklists:active-list` custom entry via `pi.appendEntry`, so the active list is restored too.

All state transitions go through a pure reducer — no in-place mutation.

## Development

Runtime needs no build step: Pi loads the TypeScript directly via [jiti](https://github.com/unjs/jiti). To typecheck:

```bash
npm install   # pulls peer deps for type resolution
npm run typecheck
```

### Layout

```
src/
├── index.ts            # Default-export factory; wires events, tool, commands
├── state/
│   ├── types.ts        # Task, TaskList, GlobalState, details/entry types
│   ├── reducer.ts      # Pure immutable state transitions
│   ├── store.ts        # Per-load state holder
│   └── replay.ts       # Rebuild GlobalState from the session branch
├── tool/todo.ts        # `todo` tool (pi.registerTool, TypeBox params)
└── view/commands.ts    # /tasklist, /tasklists, /todos (pi.registerCommand)
```

See [spec.md](spec.md) for the full technical specification.

## License

MIT
