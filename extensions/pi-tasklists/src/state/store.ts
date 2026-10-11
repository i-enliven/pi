import { type InternalAction, initialState, reducer } from "./reducer";
import type { GlobalState, TaskList } from "./types";

/**
 * Holds the reconstructed task-list state for one session. Instantiated per
 * extension load (never a module singleton) so state cannot leak across
 * /new, /resume, or /fork — session_start resets it via setState().
 */
export class Store {
	private state: GlobalState = initialState;

	getState(): GlobalState {
		return this.state;
	}

	dispatch(action: InternalAction): void {
		this.state = reducer(this.state, action);
	}

	setState(state: GlobalState): void {
		this.state = state;
	}

	/** Returns the list, lazily creating an empty one if it does not exist yet. */
	ensureList(listId: string): TaskList {
		this.dispatch({ type: "ENSURE_LIST", payload: listId });
		return this.state.lists[listId];
	}
}
