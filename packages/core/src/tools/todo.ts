// TodoWrite (Claude Code's name, ADR-0010): the model keeps a short task list for multi-step
// work. Each call replaces the whole list. The list lives in the conversation as the tool
// call's arguments, so it survives a resume, and a compaction carries the latest one forward.
import { obj, type Tool, ToolInputError } from "./tool";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type Todo = { content: string; status: TodoStatus; activeForm?: string };

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];
const MAX_TODOS = 50;

export function parseTodos(raw: unknown): Todo[] {
  const o = obj(raw);
  let list = o.todos;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      throw new ToolInputError('"todos" must be a list');
    }
  }
  if (!Array.isArray(list)) throw new ToolInputError('"todos" must be a list of {content, status}');
  if (list.length > MAX_TODOS) throw new ToolInputError(`at most ${MAX_TODOS} todos`);
  return list.map((t, i) => {
    const item = (t ?? {}) as Record<string, unknown>;
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) throw new ToolInputError(`todo ${i + 1} needs a "content" string`);
    const status = item.status ?? "pending";
    if (!STATUSES.includes(status as TodoStatus))
      throw new ToolInputError(`todo ${i + 1}: status must be one of ${STATUSES.join(", ")}`);
    const activeForm =
      typeof item.activeForm === "string" && item.activeForm.trim() ? item.activeForm.trim() : undefined;
    return { content, status: status as TodoStatus, ...(activeForm ? { activeForm } : {}) };
  });
}

const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };

export function formatTodos(todos: Todo[]): string {
  return todos.map((t) => `${MARK[t.status]} ${t.content}`).join("\n");
}

export const todoWriteTool: Tool<Todo[]> = {
  spec: {
    name: "TodoWrite",
    description: `Create and update a task list for the current work. Use it for tasks with three or more steps, or when the user gives several things to do; skip it for a single quick change. Each call replaces the whole list. Keep exactly one item in_progress while you work, mark an item completed as soon as it is done (not in batches), and add items you discover along the way. Only mark an item completed when it is fully done and checked; if something blocks it, keep it in_progress and add an item for the blocker.`,
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full, updated list",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "What to do, in the imperative: 'Run the tests'" },
              status: { type: "string", enum: STATUSES },
              activeForm: { type: "string", description: "The same in the present continuous: 'Running the tests'" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  parse: parseTodos,
  access(todos) {
    const done = todos.filter((t) => t.status === "completed").length;
    return { kind: "read", paths: [], summary: `Update Todos (${done}/${todos.length} done)` };
  },
  async run(todos) {
    if (!todos.length) return { content: "Todo list cleared." };
    const doing = todos.filter((t) => t.status === "in_progress").length;
    const note =
      doing > 1
        ? "\nNote: more than one item is in_progress; keep one at a time."
        : doing === 0 && todos.some((t) => t.status === "pending")
          ? "\nNote: mark the item you start next as in_progress."
          : "";
    return { content: `Todo list updated:\n${formatTodos(todos)}${note}` };
  },
};

// The latest list in a conversation, from the last TodoWrite call, if any.
export function latestTodos(items: { kind: string; name?: string; args?: unknown }[]): Todo[] | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "tool_call" || item.name !== "TodoWrite") continue;
    try {
      return parseTodos(item.args);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
