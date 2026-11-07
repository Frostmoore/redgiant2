import { canonicalTools, type Tool } from "@redgiant/agent";
import { editFileTool, readFileTool, writeFileTool } from "./files.js";
import { viewImageTool } from "./image.js";
import type { ModelProfile } from "./profiles.js";
import { globTool, grepTool } from "./search.js";
import { bashTool } from "./shell.js";
import { type ShowFileHost, showFileTool } from "./show.js";
import { fetchTool, type ResolveHost, type WebSearchProvider, webSearchTool } from "./web.js";
import type { Workspace } from "./workspace.js";

export * from "./edit.js";
export * from "./files.js";
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
    bashTool(o.workspace, p),
    fetchTool(p, o.fetch, o.lookup ? { lookup: o.lookup } : {}),
    webSearchTool(o.search, p),
    todosTool(),
    viewImageTool(o.workspace, p),
    showFileTool(o.workspace, p, o.show),
  ] as Tool[]);
}
