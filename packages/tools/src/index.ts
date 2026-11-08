import { canonicalTools, type Tool } from "@redgiant/agent";
import { type BackgroundCommands, bashOutputTool } from "./background.js";
import { editFileTool, readFileTool, writeFileTool } from "./files.js";
import { findFilesTool } from "./find.js";
import { viewImageTool } from "./image.js";
import type { ModelProfile } from "./profiles.js";
import { globTool, grepTool } from "./search.js";
import { bashTool } from "./shell.js";
import { type ShowFileHost, showFileTool } from "./show.js";
import { fetchTool, type ResolveHost, type WebSearchProvider, webSearchTool } from "./web.js";
import type { Workspace } from "./workspace.js";

export * from "./background.js";
export * from "./disk-wide.js";
export * from "./edit.js";
export * from "./files.js";
export * from "./find.js";
export * from "./image.js";
export * from "./profiles.js";
export * from "./scoped.js";
export * from "./search.js";
export * from "./shell.js";
export * from "./show.js";
export * from "./text.js";
export * from "./todos.js";
export * from "./web.js";
export * from "./workspace.js";

export interface BaseToolsOptions {
  workspace: Workspace;
  profile?: ModelProfile;
  search?: WebSearchProvider;
  fetch?: typeof fetch;
  /** Name resolution for fetch (tests): every address is checked before connecting. */
  lookup?: ResolveHost;
  /** Where show_file records what it opens in the canvas (G34.1); unavailable without one. */
  show?: ShowFileHost;
  /** Background commands (p3.3.1): `bash` with background, and `bash_output`. */
  background?: BackgroundCommands;
  /** The longest an ordinary bash call waits, per owner (G36.16, Settings > Commands). */
  bashMaxMs?: (ownerId: string) => number;
  /** Commands run on this computer (sandbox "host"): a walk of a whole disk is refused (p3.4.0). */
  host?: boolean;
}

/** The base tools every agent has (RD29), in canonical order. */
import { todosTool } from "./todos.js";

export function baseTools(o: BaseToolsOptions): Tool[] {
  const p = o.profile ?? "full";
  return canonicalTools([
    readFileTool(o.workspace, p),
    writeFileTool(o.workspace, p),
    editFileTool(o.workspace, p),
    globTool(o.workspace, p),
    grepTool(o.workspace, p),
    findFilesTool(o.workspace, p, { host: o.host }),
    bashTool(o.workspace, p, 30_000, o.background, o.bashMaxMs, o.host),
    bashOutputTool(o.background, p),
    fetchTool(p, o.fetch, o.lookup ? { lookup: o.lookup } : {}),
    webSearchTool(o.search, p),
    todosTool(),
    viewImageTool(o.workspace, p),
    showFileTool(o.workspace, p, o.show),
  ] as Tool[]);
}
