// The agents' tools for closed and open formats (G34.3): `convert_file` makes an open copy of a
// closed file (or exports a Figma file through the keychain), `edit_package` reads and changes
// the inside of the zip-based open formats (OpenDocument, OpenRaster, EPUB…). Every agent with a
// workspace gets both (the tool set never depends on settings or on what is installed).

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import type { Tool, ToolContext } from "@redgiant/agent";
import { applyEdit, LocalWorkspace, type ShowFileHost, type Workspace } from "@redgiant/tools";
import { strFromU8, strToU8 } from "fflate";
import { z } from "zod";
import {
  ConvertError,
  type FigmaGet,
  type FileConverter,
  figmaExport,
  type NeedsView,
} from "./convert.js";
import { blenderTool } from "./convert-blender.js";
import { extOf } from "./convert-formats.js";
import { renderOra, rezip, unzip } from "./convert-js.js";
import type { Programs } from "./convert-programs.js";
import type { Vault, VaultCaller } from "./vault.js";

export interface ConvertToolDeps {
  converter: FileConverter;
  /**
   * A GET to Figma's API with a keychain credential (asked like use_credential), or the reason
   * it cannot be used. Absent: there is no keychain.
   */
  figma?: (ctx: ToolContext, credential: string | undefined) => FigmaGet;
  /** Blender for the `blender` tool (downloaded once when first used). */
  programs?: Programs;
  /** The canvas (show_file's host): `blender` opens its result there when asked. */
  show?: ShowFileHost;
}

/** What the person must do when no free program can read the file (for the agent to say). */
const needsLines = (n: NeedsView | undefined) =>
  n
    ? [
        `${n.message}${n.installed ? ` ${n.name} is installed on this computer: the person can open the file in it from the canvas.` : n.url ? ` (${n.url})` : ""}`,
      ]
    : [];

const fail = (content: string) => ({ content, isError: true });

const isFigmaHost = (h: string) => /(^|\.)figma\.com$/i.test(h.replace(/^\*\./, ""));

/**
 * Figma's API through the keychain, with the same rules as use_credential (who may use it, its
 * hosts, asking the person): the token goes on the request in the server, never to the agent.
 */
export function vaultFigma(
  vault: Vault,
  caller: Omit<VaultCaller, "tool">,
  credential: string | undefined,
): FigmaGet {
  return async (url) => {
    const name =
      credential ?? vault.names(caller.ownerId).find((c) => c.hosts.some(isFigmaHost))?.name;
    if (!name)
      throw new ConvertError(
        "There is no Figma credential in the keychain: the person adds a Figma personal access token (host api.figma.com) in Settings > Keychain.",
      );
    const r = await vault.request(
      { ...caller, tool: "use_credential" },
      { credential: name, method: "GET", url, headers: { "X-Figma-Token": `{{vault:${name}}}` } },
    );
    const status = Number(r.content.match(/^HTTP (\d+)/)?.[1] ?? 0);
    if (!status) throw new ConvertError(r.content);
    const at = r.content.indexOf("\n\n");
    return { status, body: at >= 0 ? r.content.slice(at + 2) : "" };
  };
}

/** The workspace's own confinement first (subprojects), then the path on disk. */
async function fileIn(ws: Workspace, path: string): Promise<string | undefined> {
  if (!(await ws.isFile(path).catch(() => false))) return undefined;
  return new LocalWorkspace(ws.root).resolve(path);
}

const ConvertInput = z.object({
  path: z.string().min(1).optional(),
  to: z.union([z.string(), z.array(z.string())]).optional(),
  check: z.boolean().optional(),
  url: z.string().optional(),
  format: z.enum(["svg", "pdf", "png"]).optional(),
  credential: z.string().optional(),
  dir: z.string().optional(),
});

const CANVA = `Canva designs live on Canva's servers: export them with the Canva connection (add "Canva" in Settings > Connections if it is not there), using its export-design tool (PDF or PNG; SVG on some plans), then save the file it gives into the workspace (e.g. curl -L -o design.pdf "<the export address>") and work on that PDF or PNG (convert_file on a PDF gives an editable ODG or SVG).`;

export function convertFileTool(ws: Workspace, d: ConvertToolDeps): Tool {
  return {
    def: {
      name: "convert_file",
      description:
        "Agents work on open formats only: copy a closed file (PSD, AI, EPS, Office, InDesign, Sketch, Affinity, Figma…) into an open one in <file>.open/. check: only describe it. url: Figma/Canva link.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          to: { type: "string", description: '"svg", "ora,png"…' },
          check: { type: "boolean" },
          url: { type: "string" },
          format: { type: "string", enum: ["svg", "pdf", "png"] },
          credential: { type: "string" },
          dir: { type: "string" },
        },
      },
    },
    schema: ConvertInput,
    async run(i: z.infer<typeof ConvertInput>, ctx) {
      if (i.url) {
        if (/(^|\.)canva\.com\b|canva\.link/.test(i.url)) return CANVA;
        if (!d.figma) return fail("Figma needs the keychain, which is not available here.");
        if (ws.readOnly) return fail("This workspace is read-only.");
        try {
          const r = await figmaExport(
            ws.root,
            i.url,
            i.format ?? "svg",
            d.figma(ctx, i.credential),
            {
              ...(i.dir && { dir: i.dir }),
              ...(ctx.signal && { signal: ctx.signal }),
            },
          );
          return [
            `Exported from Figma into ${r.dir}/:`,
            ...r.outputs.map((p) => `- ${p}`),
            ...(r.losses.length ? ["Lost or left out:", ...r.losses.map((l) => `- ${l}`)] : []),
          ].join("\n");
        } catch (err) {
          return fail((err as Error).message);
        }
      }
      if (!i.path)
        return fail(
          'Give path (a file in your workspace) or url (a Figma or Canva link). What it makes, keeping the layout: PSD -> OpenRaster .ora (layers at their place) + PNG + layers.json (texts, fonts); AI, EPS -> PDF + SVG/ODG; Word/Excel/PowerPoint, Pages/Numbers/Keynote, Visio, Publisher, CorelDRAW -> ODT/ODS/ODP/ODG; IDML -> Scribus .sla + PDF (to: "sla"), or an ODG with every frame at its place (to: "odg"); text only: to: "odt"; Sketch -> SVG per page (shapes, text, images); PDF -> ODG or SVG, or a PNG of its first page (to: "png"; no Ghostscript needed); .blend, FBX, USD, Alembic -> glTF .glb; video/audio the browser cannot play -> WebM/Opus/FLAC. INDD, Affinity, XD, .fig: no free program reads them, only their stored preview; the person must export IDML/PDF/SVG from the app. Some need a free program downloaded once (LibreOffice, Scribus, Blender; with a bar for the person).',
        );
      if (!(await fileIn(ws, i.path).catch(() => undefined)))
        return fail(`There is no file "${i.path}" in your workspace.`);
      try {
        if (i.check) {
          const r = await d.converter.inspect(ws.root, i.path);
          if (!r.format) return `RedGiant does not know the format of ${i.path}.`;
          return [
            `${i.path}: ${r.format.name}, ${r.format.open ? "open" : "closed"} format${r.format.browser ? "" : ", not shown by a browser as it is"}.`,
            r.format.note,
            ...needsLines(r.needs),
            ...r.targets.map(
              (t) =>
                `- ${t.preview ? "only its preview" : "can become"} ${t.ext.toUpperCase()}${t.program ? ` with ${t.program.name} (${t.program.license}; ${t.program.here ? "on this computer" : t.program.canDownload ? `downloads once, ${t.program.size}` : `not here: ${t.program.install}`})` : ""}${t.losses.length ? `; loses: ${t.losses.join("; ")}` : ""}`,
            ),
            ...(r.converted
              ? [
                  `Already converted${r.converted.stale ? " (but the original changed since: convert again)" : ""}: ${r.converted.outputs.map((o) => o.path).join(", ")}`,
                ]
              : []),
          ].join("\n");
        }
        if (ws.readOnly)
          return fail("This workspace is read-only: the open copy cannot be written.");
        const to =
          i.to === undefined
            ? undefined
            : Array.isArray(i.to)
              ? i.to
              : i.to.split(/[\s,]+/).filter(Boolean);
        const r = await d.converter.convert(ws.root, i.path, {
          owner: ctx.ownerId,
          to,
          signal: ctx.signal,
        });
        if (r.previewOnly)
          return [
            `${i.path} could NOT be converted: no free program can read it. Only the preview picture it carries was taken, in ${r.dir}/ (the original is unchanged):`,
            ...r.outputs.map((o) => `- ${o.path}`),
            ...needsLines(r.needs),
            "Tell the person this, and work on what they export.",
          ].join("\n");
        return [
          `Converted ${i.path} into open files in ${r.dir}/ (the original is unchanged):`,
          ...r.outputs.map((o) => `- ${o.path}`),
          ...(r.losses.length
            ? ["What the conversion lost:", ...r.losses.map((l) => `- ${l}`)]
            : []),
          ...(r.skipped.length
            ? ["Not made:", ...r.skipped.map((s) => `- ${s.ext}: ${s.reason}`)]
            : []),
          "Work on these copies (edit_package for .ora .odt .ods .odp .odg; read_file and edit_file for .svg .sla .txt); tell the person what was lost if it matters.",
        ].join("\n");
      } catch (err) {
        if (err instanceof ConvertError) return fail(err.message);
        return fail(`The conversion failed: ${(err as Error).message}`);
      }
    },
  } as Tool;
}

/** A light check that an XML entry is still well formed (every tag closed, in order). */
export function xmlProblem(xml: string): string | undefined {
  const open: string[] = [];
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][\s\S]*?>|<(\/?)([^\s/>]+)[^>]*?(\/?)>/g;
  for (const m of xml.matchAll(re)) {
    if (!m[2]) continue;
    if (m[1] === "/") {
      const top = open.pop();
      if (top !== m[2]) return `</${m[2]}> closes ${top ? `<${top}>` : "nothing"}`;
    } else if (m[3] !== "/") open.push(m[2]);
  }
  if (open.length) return `<${open[open.length - 1]}> is never closed`;
  const stray = xml.replace(re, "").match(/[<>]/);
  return stray ? `a stray "${stray[0]}" outside a tag (write &lt; or &gt;)` : undefined;
}

const PackageInput = z.object({
  path: z.string().min(1),
  action: z.enum(["list", "read", "write", "replace", "extract", "insert", "remove", "render"]),
  entry: z.string().optional(),
  content: z.string().optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  replace_all: z.boolean().optional(),
  file: z.string().optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

const MAX_PACKAGE = 500 * 1024 * 1024;
const READ_CHARS = 60_000;

export function editPackageTool(ws: Workspace): Tool {
  return {
    def: {
      name: "edit_package",
      description:
        "Read or change the entries inside .odt .ods .odp .odg .ora .epub files, keeping them valid.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          action: {
            type: "string",
            enum: ["list", "read", "write", "replace", "extract", "insert", "remove", "render"],
          },
          entry: { type: "string" },
          content: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
          file: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path", "action"],
      },
    },
    schema: PackageInput,
    async run(i: z.infer<typeof PackageInput>) {
      const abs = await fileIn(ws, i.path).catch(() => undefined);
      if (!abs) return fail(`There is no file "${i.path}" in your workspace.`);
      const changes = !["list", "read", "extract"].includes(i.action);
      if (changes && ws.readOnly) return fail("This workspace is read-only.");
      if ((await stat(abs)).size > MAX_PACKAGE) return fail(`${i.path} is larger than 500 MB.`);
      const entries = unzip(new Uint8Array(await readFile(abs)));
      if (!entries)
        return fail(
          `${i.path} is not a zip package. For a closed format use convert_file first; for SVG or .sla use read_file and edit_file.`,
        );
      const isOra = extOf(i.path) === "ora" || entries["stack.xml"] !== undefined;
      const need = (what: string | undefined, name: string) =>
        what === undefined ? `Give ${name} for ${i.action}.` : undefined;
      const entryOf = () => {
        if (!i.entry) return undefined;
        return i.entry.replace(/^\/+/, "");
      };
      const name = entryOf();
      if (i.action === "list")
        return [
          ...Object.entries(entries).map(([n, b]) => `${n} (${b.length} bytes)`),
          "",
          isOra
            ? "OpenRaster: stack.xml lists the layers, topmost first; data/*.png are their pixels. Every change redraws mergedimage.png."
            : "OpenDocument: the text is in content.xml, the styles in styles.xml. read takes offset/limit (characters); replace works like edit_file; XML is checked before saving.",
        ].join("\n");
      if (i.action !== "render" && !name) return fail(need(undefined, "entry") as string);
      const textOf = (n: string) => {
        const b = entries[n];
        if (!b) return undefined;
        const s = strFromU8(b);
        return s.includes("\u0000") ? null : s;
      };
      const save = async (note: string) => {
        if (isOra && entries["stack.xml"]) {
          try {
            const r = renderOra(entries);
            entries["mergedimage.png"] = r.merged;
            entries["Thumbnails/thumbnail.png"] = r.thumbnail;
            if (r.approximated.length)
              note += ` mergedimage.png redrawn (blend modes drawn as normal: ${r.approximated.slice(0, 5).join(", ")}).`;
            else note += " mergedimage.png redrawn.";
          } catch (err) {
            return fail(`Not saved: the layers cannot be drawn (${(err as Error).message}).`);
          }
        }
        const part = `${abs}.part`;
        await writeFile(part, rezip(entries));
        await rename(part, abs);
        return note;
      };
      const checked = (n: string, text: string) =>
        /\.(xml|rdf|xhtml|opf|ncx|svg)$/i.test(n) ? xmlProblem(text) : undefined;
      switch (i.action) {
        case "read": {
          const s = textOf(name as string);
          if (s === undefined)
            return fail(`There is no entry "${name}". Entries: ${Object.keys(entries).join(", ")}`);
          if (s === null) return fail(`${name} is binary: use extract to get it as a file.`);
          const from = i.offset ?? 0;
          const part = s.slice(from, from + (i.limit ?? READ_CHARS));
          const more = s.length - from - part.length;
          return more > 0
            ? `${part}\n… (${more} more characters: read again with offset ${from + part.length})`
            : part;
        }
        case "write": {
          const miss = need(i.content, "content");
          if (miss) return fail(miss);
          const bad = checked(name as string, i.content as string);
          if (bad) return fail(`Not saved: ${name} would not be valid XML (${bad}).`);
          entries[name as string] = strToU8(i.content as string);
          return save(`Wrote ${name} in ${i.path}.`);
        }
        case "replace": {
          const miss = need(i.old_string, "old_string") ?? need(i.new_string, "new_string");
          if (miss) return fail(miss);
          const s = textOf(name as string);
          if (typeof s !== "string") return fail(`There is no text entry "${name}".`);
          const r = applyEdit(
            s,
            i.old_string as string,
            i.new_string as string,
            i.replace_all ?? false,
          );
          if (!r.ok) return fail(r.error);
          const bad = checked(name as string, r.content);
          if (bad) return fail(`Not saved: ${name} would not be valid XML (${bad}).`);
          entries[name as string] = strToU8(r.content);
          return save(`Replaced ${r.replacements} occurrence(s) in ${name} of ${i.path}.`);
        }
        case "extract": {
          const miss = need(i.file, "file");
          if (miss) return fail(miss);
          const b = entries[name as string];
          if (!b) return fail(`There is no entry "${name}".`);
          if (ws.readOnly) return fail("This workspace is read-only.");
          try {
            // The workspace's own write first: folders made, confinement checked.
            await ws.writeText(i.file as string, "");
          } catch (err) {
            return fail((err as Error).message);
          }
          await writeFile(await new LocalWorkspace(ws.root).resolve(i.file as string), b);
          return `Extracted ${name} (${b.length} bytes) to ${i.file}.`;
        }
        case "insert": {
          const miss = need(i.file, "file");
          if (miss) return fail(miss);
          const from = await fileIn(ws, i.file as string).catch(() => undefined);
          if (!from) return fail(`There is no file "${i.file}" in your workspace.`);
          if (name === "mimetype")
            return fail("mimetype says what the package is: it is not replaced.");
          const b = new Uint8Array(await readFile(from));
          if (/\.(xml)$/i.test(name as string)) {
            const bad = xmlProblem(strFromU8(b));
            if (bad) return fail(`Not saved: ${name} would not be valid XML (${bad}).`);
          }
          entries[name as string] = b;
          return save(`Put ${i.file} into ${i.path} as ${name}.`);
        }
        case "remove": {
          if (!entries[name as string]) return fail(`There is no entry "${name}".`);
          if (name === "mimetype" || (isOra && name === "stack.xml"))
            return fail(`${name} is needed: the package would not open without it.`);
          delete entries[name as string];
          return save(`Removed ${name} from ${i.path}.`);
        }
        case "render": {
          if (!isOra) return fail("render is for OpenRaster (.ora) files.");
          return save(`Rendered ${i.path}.`);
        }
      }
      return fail("Unknown action");
    },
  } as Tool;
}

/** Both tools, for every agent with a workspace. */
export function convertTools(ws: Workspace, d: ConvertToolDeps): Tool[] {
  return [
    ...(d.programs
      ? [blenderTool(ws, { programs: d.programs, ...(d.show && { show: d.show }) })]
      : []),
    convertFileTool(ws, d),
    editPackageTool(ws),
  ];
}
