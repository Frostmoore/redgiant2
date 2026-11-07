import type { Tool } from "@redgiant/agent";
import { z } from "zod";
import type { ExtensionBuilder } from "./builder.js";

/**
 * `propose_extension`: an agent writes a tool or a skill with its tests; the builder tests it
 * in a sandbox and, if it passes, queues it for the user's approval.
 */
export function proposeTool(
  self: { id: string; ownerId: string; projectId: string | null },
  builder: ExtensionBuilder,
  /** G29.4: the person chose to have tested skills installed at once (tools always wait). */
  autoSkills: () => boolean = () => false,
): Tool {
  const Input = z.object({
    kind: z.enum(["tool", "skill"]),
    name: z.string(),
    description: z.string(),
    files: z.record(z.string(), z.string()).optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    command: z.string().optional(),
    tests: z.array(z.record(z.string(), z.unknown())).optional(),
    body: z.string().optional(),
    untestable_reason: z.string().optional(),
    summary: z.string().optional(),
    updates: z.boolean().optional(),
  });
  return {
    def: {
      name: "propose_extension",
      description:
        "Propose a new tool or skill for this project. A tool: input_schema, command (run in the tool's folder with the path of a " +
        "JSON file of arguments as last argument; print the result) and files, plus tests [{input, expectExitCode?, " +
        "expectStdoutContains?}]. A skill: body (instructions) and files, plus tests [{command}] or untestable_reason, " +
        "and summary (the problem and what worked, two or three lines). To change an installed skill use its name " +
        "with updates: true (files you leave out stay). It is tested in a sandbox and waits for the user's approval.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["tool", "skill"] },
          name: { type: "string", description: "lowercase-with-dashes" },
          description: { type: "string" },
          files: { type: "object", additionalProperties: { type: "string" } },
          input_schema: { type: "object" },
          command: { type: "string" },
          tests: { type: "array", items: { type: "object" } },
          body: { type: "string" },
          untestable_reason: { type: "string" },
          summary: { type: "string" },
          updates: { type: "boolean" },
        },
        required: ["kind", "name", "description"],
      },
    },
    schema: Input,
    async run(i: z.infer<typeof Input>) {
      const input =
        i.kind === "tool"
          ? {
              kind: "tool" as const,
              spec: {
                name: i.name,
                description: i.description,
                inputSchema: i.input_schema ?? { type: "object" },
                command: i.command ?? "",
              },
              files: i.files ?? {},
              tests: i.tests ?? [],
            }
          : {
              kind: "skill" as const,
              name: i.name,
              description: i.description,
              body: i.body ?? "",
              files: i.files ?? {},
              tests: (i.tests ?? []) as { command: string }[],
              ...(i.untestable_reason && { untestableReason: i.untestable_reason }),
              ...(i.summary?.trim() && { summary: i.summary.trim().slice(0, 2000) }),
              ...(i.updates && { updates: true }),
            };
      let p: Awaited<ReturnType<ExtensionBuilder["propose"]>>;
      try {
        p = await builder.propose({
          ownerId: self.ownerId,
          projectId: self.projectId,
          author: self.id,
          input: input as never,
          autoInstall: input.kind === "skill" && autoSkills(),
        });
      } catch (err) {
        const issues = (err as { issues?: { path: (string | number)[]; message: string }[] })
          .issues;
        return {
          content: `Not accepted: ${issues ? issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") : (err as Error).message}`,
          isError: true,
        };
      }
      const lines = p.report.map(
        (r) => `${r.passed ? "✓" : "✗"} ${r.name}: ${r.detail.split("\n")[0]}`,
      );
      if (p.status === "failed")
        return {
          content: `Proposal ${p.id} failed its tests:\n${lines.join("\n")}\nFix it and propose again.`,
          isError: true,
        };
      if (p.status === "installed")
        return `Skill "${i.name}" passed its tests and is installed: every agent finds it from its next conversation.\n${lines.join("\n")}`;
      if (p.previous)
        return `Proposal ${p.id} (an update of the skill "${i.name}") passed its tests and waits for the user's approval:\n${lines.join("\n")}`;
      return `Proposal ${p.id} passed its tests and waits for the user's approval:\n${lines.join("\n")}`;
    },
  } as Tool;
}
