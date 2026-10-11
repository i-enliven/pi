import type { AutocompleteItem } from "@i-enliven/pi-tui";
import type { ExtensionAPI } from "@i-enliven/pi-coding-agent";
import type { Store } from "../state/store";
import { ACTIVE_LIST_ENTRY_TYPE, type ActiveListEntryData, type Task } from "../state/types";

function renderTodos(store: Store): string {
	const { lists, activeListId } = store.getState();
	const list = lists[activeListId];
	const tasks = list?.tasks.filter((t) => t.status !== "deleted") ?? [];
	if (tasks.length === 0) return `Tasklist '${activeListId}' is empty.`;

	const groups: { label: string; status: Task["status"] }[] = [
		{ label: "In Progress", status: "in_progress" },
		{ label: "Pending", status: "pending" },
		{ label: "Completed", status: "completed" },
	];

	let out = `Tasks in '${activeListId}':`;
	for (const { label, status } of groups) {
		const group = tasks.filter((t) => t.status === status);
		if (group.length === 0) continue;
		out += `\n\n${label}:`;
		for (const t of group) {
			const box = status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
			const af = t.activeForm ? ` (${t.activeForm})` : "";
			out += `\n  ${box} #${t.id} ${t.subject}${af}`;
		}
	}
	return out;
}

export function registerCommands(pi: ExtensionAPI, store: Store): void {
	pi.registerCommand("tasklist", {
		description: "Switch the active tasklist (creates it if new)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = Object.keys(store.getState().lists)
				.filter((id) => id.startsWith(prefix))
				.map((id) => ({ value: id, label: id }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /tasklist <name>", "warning");
				return;
			}
			store.ensureList(name);
			store.dispatch({ type: "SET_ACTIVE_LIST", payload: name });
			// Persist so the active list survives reload/compaction. Reconstruction
			// also treats this id as a known (possibly empty) list.
			pi.appendEntry<ActiveListEntryData>(ACTIVE_LIST_ENTRY_TYPE, { listId: name });
			ctx.ui.notify(`Active tasklist: ${name}`, "info");
		},
	});

	pi.registerCommand("tasklists", {
		description: "List all tasklists",
		handler: async (_args, ctx) => {
			const { lists, activeListId } = store.getState();
			const ids = Object.keys(lists).sort();
			if (ids.length === 0) {
				ctx.ui.notify("No tasklists yet.", "info");
				return;
			}
			const body = ids
				.map((id) => {
					const open = lists[id].tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length;
					const marker = id === activeListId ? "*" : " ";
					return `${marker} ${id} (${open} open)`;
				})
				.join("\n");
			ctx.ui.notify(`Tasklists:\n${body}`, "info");
		},
	});

	pi.registerCommand("todos", {
		description: "Show tasks in the active tasklist",
		handler: async (_args, ctx) => {
			ctx.ui.notify(renderTodos(store), "info");
		},
	});
}
