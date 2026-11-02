import { canonicalTools, type Tool } from "@redgiant/agent";
import { editFileTool, readFileTool, writeFileTool } from "./files.js";
import type { ModelProfile } from "./profiles.js";
import { globTool, grepTool } from "./search.js";
import { bashTool } from "./shell.js";
import { fetchTool, type WebSearchProvider, webSearchTool } from "./web.js";
import type { Workspace } from "./workspace.js";

export * from "./edit.js";
export * from "./files.js";
export * from "./profiles.js";
export * from "./scoped.js";
export * from "./search.js";
export * from "./shell.js";
export * from "./text.js";
export * from "./web.js";
export * from "./workspace.js";

export interface BaseToolsOptions {
  workspace: Workspace;
  profile?: ModelProfile;
  search?: WebSearchProvider;
  fetch?: typeof fetch;
}

/** The base tools every agent has (RD29), in canonical order. */
export function baseTools(o: BaseToolsOptions): Tool[] {
  const p = o.profile ?? "full";
  return canonicalTools([
    readFileTool(o.workspace, p),
    writeFileTool(o.workspace, p),
    editFileTool(o.workspace, p),
    globTool(o.workspace, p),
    grepTool(o.workspace, p),
    bashTool(o.workspace, p),
    fetchTool(p, o.fetch),
    webSearchTool(o.search, p),
  ] as Tool[]);
}
