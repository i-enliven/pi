export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	owner?: string;
	status: TaskStatus;
	blockedBy?: number[];
	metadata?: Record<string, unknown>;
}

export interface TaskList {
	id: string;
	tasks: Task[];
	nextId: number;
}

export interface GlobalState {
	lists: Record<string, TaskList>;
	activeListId: string;
}

export type TaskToolAction = "create" | "update" | "list" | "get" | "delete" | "clear";

/**
 * Snapshot stored in each `todo` tool result's `details`. Reconstruction replays
 * these per `listId` (last-write-wins) to rebuild the `lists` map after a reload
 * or compaction. Each call snapshots only the list it touched — never the whole
 * map — so that branching keeps sibling lists independent.
 */
export interface ToolResponseDetails {
	action: TaskToolAction;
	listId: string;
	tasks: Task[];
	nextId: number;
	error?: string;
}

/** Custom session entry that persists the active list across reloads/compaction. */
export const ACTIVE_LIST_ENTRY_TYPE = "pi-tasklists:active-list";

export interface ActiveListEntryData {
	listId: string;
}
