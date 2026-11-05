// The agent's own steps (2026-11-05, as Claude Code's todo list, Codex's plan and Manus' todo
// file): the agent writes the whole list each time, at most one step in progress. Nothing is
// stored apart: the call is in the log, and the page shows the latest list above the composer.
// It keeps a long turn on its goal; the result is short so the context barely grows.

import type { Tool } from "@redgiant/agent";
import { z } from "zod";

export const TodoInput = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().min(1).max(300),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    )
    .max(50),
});

export function todosTool(): Tool<z.infer<typeof TodoInput>> {
  return {
    def: {
      name: "update_todos",
      description:
        "Keep your list of steps for this work: send the whole list each time, with each step pending, in_progress " +
        "or completed (one in progress at a time). Use it for work of three steps or more; mark a step completed as " +
        "soon as it is done. The person sees the list.",
      inputSchema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
    schema: TodoInput,
    async run({ todos }) {
      const doing = todos.filter((t) => t.status === "in_progress").length;
      if (doing > 1)
        return { content: "Only one step can be in progress at a time.", isError: true };
      const done = todos.filter((t) => t.status === "completed").length;
      const next =
        todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
      return `${done} of ${todos.length} done.${next ? ` Now: ${next.content}` : " All done."}`;
    },
  };
}
