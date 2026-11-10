// canvas_edit (G37.1): the agent edits a file in the same editor as the person, with the same
// operations. One tool for every family: the family comes from the file, `help` gives its catalog
// of operations as a result (so the prompt's prefix stays short and the same for everyone),
// `dry_run` shows what would change. A batch is one revision, applied at once or kept as a
// proposal for the person (their rule, for the agent or the file). Refused, it says why: someone
// changed the same place since the agent's revision, or the person is typing there.
import { readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Tool, ToolContext } from "@redgiant/agent";
import type { CanvasState, DocFile } from "@redgiant/protocol";
import type { Workspace } from "@redgiant/tools";
import { z } from "zod";
import { fileAt, tabOf, within } from "../canvas-tools.js";
import { originalOfAnyCopy } from "./copies.js";
import type { EditorHost } from "./host.js";

export interface CanvasEditHost {
  editor: EditorHost;
  /** The person's canvas now (to edit the active tab without a path). */
  state(ownerId: string): Promise<CanvasState | undefined>;
  /** A file on disk as the editor names it; undefined when it is in no workspace. */
  docFileOf(ownerId: string, abs: string): Promise<DocFile | undefined>;
  /** The file behind a workspace's scope and path. */
  absOf(ownerId: string, file: DocFile): Promise<string>;
  /**
   * A closed format's open copy, made if missing (G37.4: a DOCX is edited on its ODT beside it);
   * undefined when the file has none.
   */
  copyOf?(ownerId: string, file: DocFile): Promise<DocFile | undefined>;
  /** Whether a scope's files are read only now (an archived project's, 2026-11-09). */
  readOnly?(ownerId: string, scope: string): boolean;
  /**
   * The open copy an agent just edited, shown in its original's tab (p3.5.4: the person kept
   * seeing the original's pages, «page 1 of 2» with three slides in the copy).
   */
  showCopy?(sessionId: string, original: DocFile, copy: DocFile): Promise<void>;
  /**
   * Whether the person said yes to this very call as a deletion for good (G36.17b, the broker's
   * record). A redaction (G37.8) never runs without it: without this, it is refused.
   */
  personApproved?(sessionId: string, callId: string | undefined): boolean;
}

/** Whether operations redact (the agent's words, or the family's actions made from them). */
function redacts(ops: readonly unknown[]): boolean {
  return ops.some((o) => {
    const x = (o ?? {}) as Record<string, unknown>;
    const name = String(x.op ?? x.action ?? x.type ?? x.t ?? "").toLowerCase();
    const inner = (x.op && typeof x.op === "object" ? x.op : {}) as Record<string, unknown>;
    return name === "redact" || String(inner.t ?? "").toLowerCase() === "redact";
  });
}

const Input = z.object({
  path: z.string().min(1).optional(),
  tab: z.number().int().positive().optional(),
  ops: z.array(z.unknown()).max(500).optional(),
  dry_run: z.boolean().optional(),
  expect_revision: z.number().int().nonnegative().optional(),
  help: z.boolean().optional(),
});

/** The head of a text around the lines a batch changed (dry runs and results). */
function around(text: string, line: number, lines: number): string {
  const all = text.split("\n");
  const from = Math.max(1, line - 2);
  const to = Math.min(all.length, line + lines + 1, from + 40);
  const w = String(to).length;
  return all
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(w)}| ${l.length > 300 ? `${l.slice(0, 300)}…` : l}`)
    .join("\n");
}

export function canvasEditTool(
  agent: { id: string; name: string; ownerId: string },
  ws: Workspace,
  host: CanvasEditHost,
): Tool {
  const t: Tool<z.infer<typeof Input>> = {
    def: {
      name: "canvas_edit",
      description:
        'Edit a file in the person\'s canvas editor, where they see your changes highlighted and can undo them: prefer it to write_file/edit_file when the file is open there. The file is "path" or a tab (the active one otherwise). Call with "help": true first for the operations of its kind. "dry_run": true only shows what would change.',
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file to edit (outside your workspace the person is asked first)",
          },
          tab: { type: "number", description: "A canvas tab's number (the active one otherwise)" },
          ops: { type: "array", items: { type: "object" }, description: "Operations, see help" },
          dry_run: { type: "boolean" },
          expect_revision: { type: "number", description: "The revision you read" },
          help: { type: "boolean", description: "The operations of the file's kind" },
        },
      },
    },
    schema: Input,
    async run(i, ctx: ToolContext) {
      const fail = (content: string) => ({ content, isError: true });
      // Which file: a path in the workspace, a tab, or the active tab.
      let file: DocFile | undefined;
      let abs: string | undefined;
      if (i.path) {
        const f = await fileAt(ws, i.path);
        if ("error" in f) return i.help ? catalogs(host.editor) : fail(f.error);
        // Outside the agent's folders (God on a project's file): the guardian asked the person
        // first, as for write_file and edit_file (p3.5.3); the file must be in a workspace.
        abs = f.abs;
      } else {
        const state = await host.state(agent.ownerId);
        const tab = tabOf(state, i.tab);
        if (!tab || tab.target.kind !== "file") {
          if (i.help) return catalogs(host.editor);
          return fail(
            !state
              ? 'The person has no RedGiant page open: give the file\'s "path".'
              : i.tab
                ? `There is no file in tab ${i.tab}.`
                : 'No file is open in the canvas: give the file\'s "path".',
          );
        }
        if (tab.target.scope === "outside")
          return fail(
            `Tab ${tab.title} is outside every workspace: canvas_edit edits files of your workspace only.`,
          );
        file = { scope: tab.target.scope, path: tab.target.path };
        abs = await host.absOf(agent.ownerId, file).catch(() => undefined);
        if (!abs) return fail(`The file of tab ${tab.title} is not there anymore.`);
        const root = await realpath(ws.root).catch(() => resolve(ws.root));
        // A tab outside the agent's folders: its path, so the guardian can ask the person (the
        // same rule as write_file and edit_file outside the workspace).
        if (!within(root, await realpath(abs).catch(() => abs as string)))
          return fail(
            `Tab ${tab.title} is outside your workspace: to edit it, call canvas_edit with path "${abs}" (the person is asked first, as for edit_file).`,
          );
      }
      file ??= await host.docFileOf(agent.ownerId, abs);
      if (!file)
        return fail(
          `${basename(abs)} is in no project or folder RedGiant knows: canvas_edit edits files of the projects; use edit_file or write_file.`,
        );
      if (!i.help && host.readOnly?.(agent.ownerId, file.scope))
        return fail(
          `${basename(file.path)} belongs to an archived project: its files are read only until the person restores it.`,
        );
      let family = host.editor.familyFor(file.path);
      let copied = "";
      let original: DocFile | undefined;
      if (!family && host.copyOf && !i.help) {
        try {
          const copy = await host.copyOf(agent.ownerId, file);
          if (copy) {
            copied = ` (${basename(file.path)} is in a closed format: you edited its open copy ${copy.path}; the original stays as it is unless the person turned on writing it back)`;
            original = file;
            file = copy;
            family = host.editor.familyFor(copy.path);
          }
        } catch (err) {
          return fail(
            `${basename(file.path)} has no open copy to edit yet: ${(err as Error).message}.`,
          );
        }
      }
      if (!family) {
        if (i.help) return catalogs(host.editor);
        return fail(
          `There is no editor for ${basename(file.path)} yet: use edit_file or write_file.`,
        );
      }
      if (i.help) return family.catalog();
      if (!i.ops?.length) return fail('Give "ops" (call with "help": true for the list).');

      let read: Awaited<ReturnType<EditorHost["read"]>>;
      try {
        read = await host.editor.read(agent.ownerId, file);
      } catch (err) {
        return fail(`${basename(file.path)} cannot be edited here: ${(err as Error).message}.`);
      }
      // The revision the agent's operations are made on: the one it says, or the one it saw last.
      const base =
        i.expect_revision ??
        host.editor.lastSeen(ctx.sessionId, agent.ownerId, file) ??
        read.revision;
      if (base > read.revision)
        return fail(`Revision ${base} does not exist: the file is at revision ${read.revision}.`);
      const model = read.modelAt(base);
      if (model === undefined)
        return fail(
          `Revision ${base} cannot be read back anymore (the file changed from outside since). It is at revision ${read.revision}: look again with canvas_look view "structure".`,
        );
      // A family may make the operations ready first (G37.4: pictures of the workspace as blobs).
      let ops: readonly unknown[] = i.ops;
      if (family.prepare)
        try {
          ops = await family.prepare(i.ops, {
            read: async (p) => {
              const f = await fileAt(ws, p);
              if ("error" in f) throw new Error(f.error);
              if (f.outside) throw new Error(`"${p}" is outside your workspace`);
              return new Uint8Array(await readFile(f.abs));
            },
            putBlob: (b) => host.editor.putBlob(b),
          });
        } catch (err) {
          return fail(`Nothing applied: ${(err as Error).message}.`);
        }
      const made = await family.fromAgent(model, ops);
      if ("error" in made)
        return fail(
          `Nothing applied: ${made.index !== undefined ? `operation ${made.index + 1}: ` : ""}${made.error}.`,
        );
      const notes = host.editor.notesFor(ctx.sessionId);
      // The family's word when the edit likely missed its aim (p3.5.3: a row below a chart).
      const advice = family.advice?.(model, made.ops);
      if (advice) notes.unshift(advice);
      const tail = `${copied}${notes.length ? `\n\n${notes.join("\n")}` : ""}`;
      const author = { id: agent.id, name: agent.name, sessionId: ctx.sessionId };
      const mode = host.editor.modeFor(agent.ownerId, agent.id, file);
      if (i.dry_run) {
        const out = await host.editor.apply(agent.ownerId, file, {
          author,
          baseRevision: base,
          ops: made.ops,
          groupId: host.editor.groupOf(ctx.sessionId),
          dryRun: true,
        });
        if (!out.ok)
          return `Dry run on revision ${base}: it would be refused: ${out.reason}.${tail}`;
        let after: unknown = model;
        for (const op of made.ops) after = family.apply(after, op);
        const snap = family.snapshot(after);
        const preview =
          snap.family === "text"
            ? `\n${around(snap.text, out.summary.line ?? 1, out.summary.lines ?? 1)}`
            : out.summary.sheet?.range
              ? `\n${await family.structure(after, { cells: out.summary.sheet.range, ...(out.summary.sheet.name && { sheet: out.summary.sheet.name }) })}`
              : "";
        return `Dry run on revision ${base} (nothing changed): it would have ${out.summary.text}${mode === "propose" ? ", as a proposal for the person" : ""}.${preview}${tail}`;
      }
      // A redaction takes text out of the file for good (G37.8): only with the person's own yes
      // to this call, whatever the rules, the mode or the way the call came (p3.5.4).
      if (
        (redacts(i.ops) || redacts(made.ops)) &&
        host.personApproved?.(ctx.sessionId, ctx.callId) !== true
      )
        return fail(
          "Nothing applied: a redaction removes text for good, so it needs the person's own yes to this call, and they were not asked or did not say yes. Call canvas_edit again with the redaction (not from a script): the person is asked first.",
        );
      if (mode === "propose") {
        // A proposal follows the same rules as an edit (p3.5.3): where the person is typing, or
        // on a place someone changed since the agent's revision, it is refused, not kept.
        const check = await host.editor.apply(agent.ownerId, file, {
          author,
          baseRevision: base,
          ops: made.ops,
          groupId: host.editor.groupOf(ctx.sessionId),
          dryRun: true,
          tell: true,
        });
        if (!check.ok)
          return fail(
            `Refused (nothing proposed): ${check.reason}. The file is at revision ${check.revision}: canvas_look with view "structure" shows it.${tail}`,
          );
        const p = await host.editor.propose(agent.ownerId, file, {
          author,
          baseRevision: base,
          ops: made.ops,
          groupId: host.editor.groupOf(ctx.sessionId),
        });
        return `Proposed to the person (proposal ${p.proposalId}, on revision ${base}): ${p.summary.text}. The person chose to review your edits of this file: it applies when they accept it, and you will be told.${tail}`;
      }
      const out = await host.editor.apply(agent.ownerId, file, {
        author,
        baseRevision: base,
        ops: made.ops,
        groupId: host.editor.groupOf(ctx.sessionId),
      });
      if (!out.ok) {
        // What the agent has now: the head, to read before trying again.
        return fail(
          `Refused (nothing applied): ${out.reason}. The file is at revision ${out.revision}: canvas_look with view "structure" shows it.${tail}`,
        );
      }
      host.editor.seen(ctx.sessionId, agent.ownerId, file, out.revision);
      // The person has the original open: its tab shows the copy now, with the edit in it. Also
      // when the agent named the copy itself (p3.5.6: bilancio.xlsx kept showing the original
      // after edits of bilancio.xlsx.open/bilancio.ods).
      const copyOf = originalOfAnyCopy(file.path);
      const source = original ?? (copyOf ? { scope: file.scope, path: copyOf } : undefined);
      if (source && host.showCopy) {
        const state = await host.state(agent.ownerId).catch(() => undefined);
        const from = source;
        const open = state?.tabs.some(
          (t) =>
            t.target.kind === "file" &&
            t.target.scope === from.scope &&
            (t.target.path === from.path || t.target.path === file?.path),
        );
        if (open) await host.showCopy(ctx.sessionId, from, file).catch(() => {});
      }
      return `Applied as revision ${out.revision}${out.rebased ? ` (made on revision ${base}, moved over the later changes)` : ""}: ${out.summary.text}. The person sees it highlighted and can undo it (undo_id ${out.revision}).${tail}`;
    },
  };
  return t as Tool;
}

/** Every family's catalog, when the file has none. */
function catalogs(editor: EditorHost): string {
  return `canvas_edit edits these kinds of files:\n\n${editor
    .allFamilies()
    .map((f) => f.catalog())
    .join("\n\n")}`;
}
