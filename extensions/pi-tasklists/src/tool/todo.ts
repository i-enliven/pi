import { StringEnum } from "@i-enliven/pi-ai";
import type { ExtensionAPI, Theme } from "@i-enliven/pi-coding-agent";
import { Text } from "@i-enliven/pi-tui";
import { type Static, Type } from "typebox";
import type { Store } from "../state/store";
import type { Task, ToolResponseDetails } from "../state/types";

const TodoParams = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
	listId: Type.Optional(Type.String({ description: "List to operate on. Defaults to the active list." })),
	subject: Type.Optional(Type.String({ description: "Task subject (required for create)" })),
	id: Type.Optional(Type.Number({ description: "Task id (required for update/get/delete)" })),
	status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const)),
	description: Type.Optional(Type.String()),
	activeForm: Type.Optional(Type.String({ description: "Label shown while the task is in_progress" })),
	owner: Type.Optional(Type.String()),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	blockedBy: Type.Optional(Type.Array(Type.Number())),
	includeDeleted: Type.Optional(Type.Boolean({ description: "Include deleted tasks when listing" })),
});

export type TodoToolInput = Static<typeof TodoParams>;

function formatTaskLine(t: Task): string {
	const box = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
	const af = t.activeForm ? ` (${t.activeForm})` : "";
	return `${box} #${t.id} ${t.subject}${af}`;
}

export function registerTodoTool(pi: ExtensionAPI, store: Store): void {
	pi.registerTool({
		name: "todo",
		label: "Tasklist",
		description:
			"Manage tasks across multiple named lists. Actions: create (subject), update (id + fields), " +
			"list (optional status/includeDeleted filter), get (id), delete (id), clear. " +
			"Pass listId to target a specific list; otherwise the active list is used.",
		promptSnippet: "Manage multi-list todos: create/update/list/get/delete/clear tasks",
		parameters: TodoParams,

		async execute(_toolCallId, params: TodoToolInput) {
			const listId = params.listId?.trim() || store.getState().activeListId;
			const list = store.ensureList(listId);

			const ok = (text: string): { content: { type: "text"; text: string }[]; details: ToolResponseDetails } => {
				const current = store.getState().lists[listId];
				return {
					content: [{ type: "text", text }],
					details: { action: params.action, listId, tasks: current.tasks, nextId: current.nextId },
				};
			};

			const fail = (message: string): { content: { type: "text"; text: string }[]; details: ToolResponseDetails } => ({
				content: [{ type: "text", text: `Error: ${message}` }],
				details: { action: params.action, listId, tasks: list.tasks, nextId: list.nextId, error: message },
			});

			switch (params.action) {
				case "create": {
					if (!params.subject) return fail("subject is required for create");
					const task: Task = {
						id: list.nextId,
						subject: params.subject,
						status: "pending",
						description: params.description,
						activeForm: params.activeForm,
						owner: params.owner,
						metadata: params.metadata,
						blockedBy: params.blockedBy,
					};
					store.dispatch({ type: "CREATE_TASK", payload: { listId, task } });
					return ok(`Created #${task.id} in '${listId}': ${task.subject}`);
				}

				case "update": {
					if (params.id === undefined) return fail("id is required for update");
					if (!list.tasks.some((t) => t.id === params.id)) return fail(`task #${params.id} not found in '${listId}'`);
					const patch: Partial<Task> & { id: number } = { id: params.id };
					if (params.subject !== undefined) patch.subject = params.subject;
					if (params.status !== undefined) patch.status = params.status;
					if (params.description !== undefined) patch.description = params.description;
					if (params.activeForm !== undefined) patch.activeForm = params.activeForm;
					if (params.owner !== undefined) patch.owner = params.owner;
					if (params.metadata !== undefined) patch.metadata = params.metadata;
					if (params.blockedBy !== undefined) patch.blockedBy = params.blockedBy;
					store.dispatch({ type: "UPDATE_TASK", payload: { listId, task: patch } });
					return ok(`Updated #${params.id} in '${listId}'`);
				}

				case "delete": {
					if (params.id === undefined) return fail("id is required for delete");
					if (!list.tasks.some((t) => t.id === params.id)) return fail(`task #${params.id} not found in '${listId}'`);
					store.dispatch({ type: "DELETE_TASK", payload: { listId, taskId: params.id } });
					return ok(`Deleted #${params.id} in '${listId}'`);
				}

				case "clear": {
					const count = list.tasks.filter((t) => t.status !== "deleted").length;
					store.dispatch({ type: "CLEAR_LIST", payload: { listId } });
					return ok(`Cleared ${count} task(s) in '${listId}'`);
				}

				case "get": {
					if (params.id === undefined) return fail("id is required for get");
					const task = list.tasks.find((t) => t.id === params.id);
					if (!task) return fail(`task #${params.id} not found in '${listId}'`);
					return ok(formatTaskLine(task));
				}

				case "list": {
					const includeDeleted = params.includeDeleted ?? false;
					const visible = list.tasks
						.filter((t) => includeDeleted || t.status !== "deleted")
						.filter((t) => !params.status || t.status === params.status);
					const text = visible.length
						? `Tasks in '${listId}':\n${visible.map(formatTaskLine).join("\n")}`
						: `No tasks in '${listId}'`;
					return ok(text);
				}

				default:
					return fail(`unknown action: ${String(params.action)}`);
			}
		},

		renderCall(args: TodoToolInput, theme: Theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			const target = args.listId?.trim();
			if (target) text += ` ${theme.fg("accent", target)}`;
			if (args.subject) text += ` ${theme.fg("dim", `"${args.subject}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ToolResponseDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const first = result.content[0];
			return new Text(theme.fg("muted", first?.type === "text" ? first.text : ""), 0, 0);
		},
	});
}
