import type { ExtensionContext } from "@i-enliven/pi-coding-agent";
import { type InternalAction, initialState, reducer } from "./reducer";
import { ACTIVE_LIST_ENTRY_TYPE, type ActiveListEntryData, type GlobalState, type ToolResponseDetails } from "./types";

type SessionManagerView = ExtensionContext["sessionManager"];

/**
 * Rebuild the full GlobalState from the current session branch.
 *
 * Compaction does not delete session entries — it only changes what the LLM
 * sees — so getBranch() still returns every `todo` tool result and every
 * active-list custom entry. We replay them in order:
 *   - todo tool results upsert their snapshotted list (last-write-wins per id)
 *   - active-list custom entries set the active list (and mark it known)
 *
 * `fallbackActiveId` (from PI_TASKLIST_ID) is only used when the branch has no
 * persisted active-list entry, so resuming a session keeps the user's last
 * /tasklist choice instead of snapping back to the env default.
 */
export function reconstructState(
	sessionManager: SessionManagerView,
	fallbackActiveId: string,
): GlobalState {
	let state: GlobalState = { ...initialState, activeListId: fallbackActiveId };
	const dispatch = (action: InternalAction) => {
		state = reducer(state, action);
	};

	let sawActiveEntry = false;

	for (const entry of sessionManager.getBranch()) {
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "toolResult" && msg.toolName === "todo") {
				const details = msg.details as ToolResponseDetails | undefined;
				if (details?.listId && !details.error) {
					dispatch({
						type: "UPSERT_LIST",
						payload: { id: details.listId, tasks: details.tasks, nextId: details.nextId },
					});
				}
			}
			continue;
		}

		if (entry.type === "custom" && entry.customType === ACTIVE_LIST_ENTRY_TYPE) {
			const data = entry.data as ActiveListEntryData | undefined;
			if (data?.listId) {
				sawActiveEntry = true;
				dispatch({ type: "ENSURE_LIST", payload: data.listId });
				dispatch({ type: "SET_ACTIVE_LIST", payload: data.listId });
			}
		}
	}

	if (!sawActiveEntry) {
		dispatch({ type: "SET_ACTIVE_LIST", payload: fallbackActiveId });
	}

	// Guarantee the active list always exists so the tool/commands never null-deref.
	dispatch({ type: "ENSURE_LIST", payload: state.activeListId });

	return state;
}
