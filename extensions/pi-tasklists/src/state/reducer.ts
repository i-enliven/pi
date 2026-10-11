import type { GlobalState, Task, TaskList, TaskStatus } from "./types";

export type InternalAction =
	| { type: "SET_ACTIVE_LIST"; payload: string }
	| { type: "ENSURE_LIST"; payload: string }
	| { type: "UPSERT_LIST"; payload: TaskList }
	| { type: "CREATE_TASK"; payload: { listId: string; task: Task } }
	| { type: "UPDATE_TASK"; payload: { listId: string; task: Partial<Task> & { id: number } } }
	| { type: "DELETE_TASK"; payload: { listId: string; taskId: number } }
	| { type: "CLEAR_LIST"; payload: { listId: string } }
	| { type: "SET_STATE"; payload: GlobalState };

export const initialState: GlobalState = {
	lists: {},
	activeListId: "default",
};

const emptyList = (id: string): TaskList => ({ id, tasks: [], nextId: 1 });

export function reducer(state: GlobalState, action: InternalAction): GlobalState {
	switch (action.type) {
		case "SET_ACTIVE_LIST":
			return { ...state, activeListId: action.payload };

		case "ENSURE_LIST": {
			const id = action.payload;
			if (state.lists[id]) return state;
			return { ...state, lists: { ...state.lists, [id]: emptyList(id) } };
		}

		case "UPSERT_LIST":
			return {
				...state,
				lists: { ...state.lists, [action.payload.id]: action.payload },
			};

		case "CREATE_TASK": {
			const { listId, task } = action.payload;
			const list = state.lists[listId] ?? emptyList(listId);
			const updated: TaskList = {
				...list,
				tasks: [...list.tasks, task],
				nextId: Math.max(list.nextId, task.id + 1),
			};
			return { ...state, lists: { ...state.lists, [listId]: updated } };
		}

		case "UPDATE_TASK": {
			const { listId, task } = action.payload;
			const list = state.lists[listId];
			if (!list) return state;
			const tasks = list.tasks.map((t) => (t.id === task.id ? { ...t, ...task } : t));
			return { ...state, lists: { ...state.lists, [listId]: { ...list, tasks } } };
		}

		case "DELETE_TASK": {
			const { listId, taskId } = action.payload;
			const list = state.lists[listId];
			if (!list) return state;
			const tasks = list.tasks.map((t) =>
				t.id === taskId ? { ...t, status: "deleted" as TaskStatus } : t,
			);
			return { ...state, lists: { ...state.lists, [listId]: { ...list, tasks } } };
		}

		case "CLEAR_LIST": {
			const { listId } = action.payload;
			const list = state.lists[listId];
			if (!list) return state;
			return { ...state, lists: { ...state.lists, [listId]: { ...list, tasks: [], nextId: 1 } } };
		}

		case "SET_STATE":
			return action.payload;

		default:
			return state;
	}
}
