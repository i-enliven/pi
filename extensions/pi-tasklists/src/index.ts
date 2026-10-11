import type { ExtensionAPI, ExtensionContext } from "@i-enliven/pi-coding-agent";
import { reconstructState } from "./state/replay";
import { Store } from "./state/store";
import { registerTodoTool } from "./tool/todo";
import { registerCommands } from "./view/commands";

/**
 * pi-tasklists — multi-list task management.
 *
 * State lives in the session (todo tool-result `details` + an active-list custom
 * entry), so it is rebuilt from scratch on every session_start/session_tree and
 * survives reload, compaction, branching, and session switches. The Store is
 * per-load (not a module singleton) to avoid leaking state across sessions.
 */
export default function (pi: ExtensionAPI) {
	const store = new Store();

	// PI_TASKLIST_ID is only a fallback for the active list. A persisted
	// active-list entry on the branch always wins over it.
	const fallbackActiveId = process.env.PI_TASKLIST_ID?.trim() || "default";

	const rebuild = (ctx: ExtensionContext) => {
		store.setState(reconstructState(ctx.sessionManager, fallbackActiveId));
	};

	pi.on("session_start", async (_event, ctx) => rebuild(ctx));
	pi.on("session_tree", async (_event, ctx) => rebuild(ctx));

	registerTodoTool(pi, store);
	registerCommands(pi, store);
}
