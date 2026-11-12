import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, stat, statfs } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AutomationNotFoundError, RecipeError, WebhookForbiddenError } from "@redgiant/automations";
import {
  exportSkill,
  importSkill,
  loadCustomTools,
  loadSkills,
  SKILL_ARCHIVE_LIMITS,
  NAME_RE as SKILL_NAME_RE,
  SkillArchiveError,
  SkillExistsError,
} from "@redgiant/extensions";
import { teamsAppPackage } from "@redgiant/gateway";
import { HierarchyError } from "@redgiant/hierarchy";
import {
  AgentKind,
  ARTIFACT_SANDBOX,
  ArtifactError,
  ArtifactRef,
  Automation,
  AutomationRun,
  Effort,
  ImagePart,
  LOCAL_OWNER_ID,
  MachineAccess,
  MachineBody,
  MEDIA_KINDS,
  type ModelSpec as ModelSpecType,
  PermissionMode,
  PermissionRequestInfo,
  PROTOCOL_VERSION,
  RefineRequest,
  SEARCH_PROVIDER_IDS,
} from "@redgiant/protocol";
import type { TelegramGateway } from "@redgiant/telegram";
import { PathOutsideWorkspaceError } from "@redgiant/tools";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  artifactHeaders,
  artifactPage,
  LIB_HEADERS,
  serveLib,
  widgetPage,
} from "./artifact-engine.js";
import { artifactRoutes } from "./artifact-routes.js";
import { type AuthProvider, bearer, type Principal } from "./auth.js";
import { BackupError, exportBackup, importBackup, previewBackup, removeBackup } from "./backup.js";
import { browserRoutes } from "./browser-routes.js";
import {
  bridge,
  PREVIEW_HEADERS,
  previewHeaders,
  previewOrigins,
  previewWrapper,
  rewrite,
  serveFile,
  serveRaw,
} from "./canvas.js";
import { ChatError } from "./chat.js";
import { type ChatHub, ChatSettings, PLATFORMS } from "./chats.js";
import { CodeChangeError } from "./code.js";
import { convertRoutes } from "./convert-routes.js";
import {
  BadRequestError,
  NoModelError,
  NotFoundError,
  ProjectArchivedError,
  type RedGiantCore,
  SessionBusyError,
} from "./core.js";
import { debugLog } from "./debug-log.js";
import { imageRoutes } from "./editor/image-routes.js";
import { modelRoutes } from "./editor/model-routes.js";
import { officeRoutes } from "./editor/office-routes.js";
import { pdfRoutes } from "./editor/pdf-routes.js";
import { svgRoutes } from "./editor/svg-routes.js";
import { MailboxNotFoundError } from "./email.js";
import { MachineError, type MachinePatch } from "./machines.js";
import { sessionMarkdown } from "./export.js";
import { ConflictError, FileService } from "./files.js";
import { HuggingFace } from "./hf.js";
import { importRoutes } from "./import-routes.js";
import { knowledgeRoutes } from "./knowledge/routes.js";
import { localModelChoices } from "./local-models.js";
import { LoginError } from "./login.js";
import { MagicNotFoundError, MagicStateError } from "./magic.js";
import { personRoutes } from "./person-routes.js";
import { ConfigError, PlatformPolicy } from "./platform.js";
import { SubprojectError } from "./projects.js";
import { RefineError } from "./prompt-refiner.js";
import { RoomError } from "./rooms.js";
import type { SetupService } from "./setup.js";
import { MEMORY_ENTRY_LIMIT, MemoryError } from "./shared-memory.js";
import { sheetRoutes } from "./sheet-routes.js";
import { updateRoutes } from "./update-routes.js";
import { UpdateRequiredError } from "./updates.js";
import { VaultError } from "./vault.js";
import { MAX_AUDIO_BYTES, TranscriptionError } from "./voice.js";
import { COMPRESSIBLE, CompressedFiles, MIN_COMPRESS, pickEncoding } from "./web-compress.js";
import type { OpenPages } from "./ws.js";

type Env = { Variables: { principal: Principal } };

/**
 * The protocol's ModelSpec is recursive (fallback chain); registered under a name, the
 * OpenAPI generator references it instead of expanding it forever.
 */
const ModelSpec: z.ZodType<ModelSpecType> = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    version: z.string().min(1).optional(),
    effort: Effort.optional(),
    get fallback() {
      return ModelSpec.optional();
    },
  })
  .openapi("ModelSpec");

const ErrorBody = z.object({ error: z.string() }).openapi("Error");
const Project = z
  .object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    createdAt: z.string(),
    /** Archived (2026-11-09): read only, out of the lists, until it is restored. */
    archivedAt: z.string().optional(),
  })
  .openapi("Project");
const Agent = z
  .object({
    id: z.string(),
    kind: AgentKind,
    parentId: z.string().nullable(),
    projectId: z.string().nullable(),
    persistent: z.boolean(),
    name: z.string(),
    role: z.string().optional(),
    systemPrompt: z.string().optional(),
    model: ModelSpec.optional(),
    mode: PermissionMode.optional(),
    connections: z.array(z.string()).optional(),
    subprojectId: z.string().optional(),
    compaction: z.object({ at: z.number().optional(), keep: z.number().optional() }).optional(),
    skills: z.array(z.string()).optional(),
    projects: z.array(z.string()).optional(),
    status: z.enum(["active", "stopped"]),
  })
  .openapi("Agent");
const NewAgent = z
  .object({
    kind: AgentKind,
    parentId: z.string().nullable(),
    projectId: z.string().nullable().optional(),
    persistent: z.boolean().optional(),
    name: z.string().min(1),
    role: z.string().optional(),
    systemPrompt: z.string().optional(),
    model: ModelSpec.optional(),
    mode: PermissionMode.optional(),
    connections: z.array(z.string().min(1)).optional(),
    subprojectId: z.string().min(1).optional(),
  })
  .openapi("NewAgent");

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Missing or invalid token"),
  404: json(ErrorBody, "Not found"),
};
const security = [{ bearer: [] }];

const AutomationSaved = z.object({
  automation: Automation,
  /** Shown only now: RedGiant keeps a hash. */
  webhookSecret: z.string().optional(),
});
const automationId = z.object({ id: z.string() });
const yamlBody = {
  body: { content: { "application/json": { schema: z.object({ yaml: z.string().min(1) }) } } },
};

const routes = {
  listAutomations: createRoute({
    method: "get",
    path: "/api/automations",
    security,
    responses: { 200: json(z.array(Automation), "Automations"), ...errors },
  }),
  createAutomation: createRoute({
    method: "post",
    path: "/api/automations",
    security,
    request: yamlBody,
    responses: { 201: json(AutomationSaved, "Created"), ...errors },
  }),
  getAutomation: createRoute({
    method: "get",
    path: "/api/automations/{id}",
    security,
    request: { params: automationId },
    responses: { 200: json(Automation, "Automation"), ...errors },
  }),
  updateAutomation: createRoute({
    method: "put",
    path: "/api/automations/{id}",
    security,
    request: { params: automationId, ...yamlBody },
    responses: { 200: json(AutomationSaved, "Updated"), ...errors },
  }),
  deleteAutomation: createRoute({
    method: "delete",
    path: "/api/automations/{id}",
    security,
    request: { params: automationId },
    responses: { 200: json(z.object({ ok: z.literal(true) }), "Deleted"), ...errors },
  }),
  enableAutomation: createRoute({
    method: "post",
    path: "/api/automations/{id}/enabled",
    security,
    request: {
      params: automationId,
      body: { content: { "application/json": { schema: z.object({ enabled: z.boolean() }) } } },
    },
    responses: { 200: json(Automation, "Updated"), ...errors },
  }),
  runAutomation: createRoute({
    method: "post",
    path: "/api/automations/{id}/run",
    security,
    request: { params: automationId },
    responses: { 202: json(AutomationRun, "Started (or skipped: already running)"), ...errors },
  }),
  rotateAutomationSecret: createRoute({
    method: "post",
    path: "/api/automations/{id}/secret",
    security,
    request: { params: automationId },
    responses: {
      200: json(z.object({ webhookSecret: z.string() }), "The new secret"),
      ...errors,
    },
  }),
  automationRuns: createRoute({
    method: "get",
    path: "/api/automations/{id}/runs",
    security,
    request: { params: automationId },
    responses: { 200: json(z.array(AutomationRun), "Recent runs, newest first"), ...errors },
  }),
  listProjects: createRoute({
    method: "get",
    path: "/api/projects",
    security,
    responses: { 200: json(z.array(Project), "Projects"), ...errors },
  }),
  createProject: createRoute({
    method: "post",
    path: "/api/projects",
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              /** A folder that already exists, which the project adopts as it is (G36.15). */
              path: z.string().min(1).optional(),
            }),
          },
        },
      },
    },
    responses: { 201: json(Project, "Created"), ...errors },
  }),
  listAgents: createRoute({
    method: "get",
    path: "/api/agents",
    security,
    request: { query: z.object({ projectId: z.string().optional() }) },
    responses: { 200: json(z.array(Agent), "Agents"), ...errors },
  }),
  createAgent: createRoute({
    method: "post",
    path: "/api/agents",
    security,
    request: { body: { content: { "application/json": { schema: NewAgent } } } },
    responses: { 201: json(Agent, "Created"), ...errors },
  }),
  configureAgent: createRoute({
    method: "patch",
    path: "/api/agents/{id}",
    security,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              /** null: the default model again (or the parent's). */
              model: ModelSpec.nullable().optional(),
              /** A new name (2026-11-03): every agent can be renamed by the person. */
              name: z.string().trim().min(1).max(60).optional(),
              mode: PermissionMode.optional(),
              systemPrompt: z.string().optional(),
              role: z.string().min(1).optional(),
              connections: z.array(z.string().min(1)).optional(),
              compaction: z
                .object({
                  at: z.number().min(0.3).max(0.95).optional(),
                  keep: z.number().min(0).max(0.5).optional(),
                })
                .optional(),
              /** The skills it uses; null: all of them again. */
              skills: z.array(z.string().min(1)).nullable().optional(),
              /** Other projects it is assigned to; null or []: none. */
              projects: z
                .array(z.string().regex(/^[a-z0-9-]+$/))
                .max(50)
                .nullable()
                .optional(),
            }),
          },
        },
      },
    },
    responses: { 200: json(Agent, "Updated"), ...errors },
  }),
  stopAgent: createRoute({
    method: "post",
    path: "/api/agents/{id}/stop",
    security,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ reason: z.string().default("stopped by the user") }),
          },
        },
      },
    },
    responses: { 200: json(z.object({ stopped: z.array(z.string()) }), "Stopped"), ...errors },
  }),
  listSessions: createRoute({
    method: "get",
    path: "/api/sessions",
    security,
    request: { query: z.object({ agentId: z.string().optional() }) },
    responses: {
      200: json(
        z.array(
          z.object({
            id: z.string(),
            agentId: z.string(),
            projectId: z.string().nullable(),
            createdAt: z.string(),
            lastAt: z.string().nullable(),
            title: z.string().nullable(),
            pinned: z.boolean(),
            archived: z.boolean(),
            folder: z.string().nullable().optional(),
            /** The conversation it goes on from (G36.23). */
            forkedFrom: z.string().nullable().optional(),
            running: z.boolean(),
            /** The title of the task it works on, while one is open (p3.5.4). */
            task: z.string().nullable().optional(),
            /** The session's own model, when it does not use the agent's. */
            model: ModelSpec.nullable(),
          }),
        ),
        "Sessions",
      ),
      ...errors,
    },
  }),
  startSession: createRoute({
    method: "post",
    path: "/api/sessions",
    security,
    request: {
      body: { content: { "application/json": { schema: z.object({ agentId: z.string() }) } } },
    },
    responses: { 201: json(z.object({ sessionId: z.string() }), "Started"), ...errors },
  }),
  sessionEvents: createRoute({
    method: "get",
    path: "/api/sessions/{id}/events",
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json(z.array(z.unknown()), "The session's events, oldest first"), ...errors },
  }),
  sendMessage: createRoute({
    method: "post",
    path: "/api/sessions/{id}/messages",
    security,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              text: z.string().min(1),
              images: z.array(ImagePart).max(10).optional(),
            }),
          },
        },
      },
    },
    responses: {
      202: json(z.object({ accepted: z.literal(true) }), "The agent is working"),
      409: json(ErrorBody, "Busy"),
      ...errors,
    },
  }),
  interrupt: createRoute({
    method: "post",
    path: "/api/sessions/{id}/interrupt",
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json(z.object({ interrupted: z.boolean() }), "Interrupted"), ...errors },
  }),
  listPermissions: createRoute({
    method: "get",
    path: "/api/permissions",
    security,
    responses: { 200: json(z.array(PermissionRequestInfo), "Pending requests"), ...errors },
  }),
  decidePermission: createRoute({
    method: "post",
    path: "/api/permissions/{id}",
    security,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": { schema: z.object({ decision: z.enum(["allow", "deny"]) }) },
        },
      },
    },
    responses: { 200: json(z.object({ ok: z.literal(true) }), "Decided"), ...errors },
  }),
  listFiles: createRoute({
    method: "get",
    path: "/api/files/list",
    security,
    request: { query: z.object({ scope: z.string(), path: z.string().default(".") }) },
    responses: {
      200: json(
        z.array(
          z.object({
            name: z.string(),
            path: z.string(),
            type: z.enum(["file", "dir", "link"]),
            size: z.number(),
            modifiedAt: z.string(),
          }),
        ),
        "Directory entries, folders first",
      ),
      ...errors,
    },
  }),
  readFile: createRoute({
    method: "get",
    path: "/api/files/content",
    security,
    request: { query: z.object({ scope: z.string(), path: z.string() }) },
    responses: {
      200: json(
        z.object({
          path: z.string(),
          encoding: z.enum(["utf8", "base64"]),
          content: z.string(),
          size: z.number(),
          modifiedAt: z.string(),
        }),
        "File content",
      ),
      ...errors,
    },
  }),
  writeFile: createRoute({
    method: "put",
    path: "/api/files/content",
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              scope: z.string(),
              path: z.string(),
              content: z.string(),
              encoding: z.enum(["utf8", "base64"]).default("utf8"),
              expectedModifiedAt: z.string().nullable().optional(),
              ifExists: z.enum(["replace", "keep-both", "fail"]).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ path: z.string(), modifiedAt: z.string() }), "Written"),
      409: json(
        z.object({ error: z.string(), modifiedAt: z.string().nullable() }),
        "Changed since it was read, or the name is taken",
      ),
      ...errors,
    },
  }),
  fileOp: createRoute({
    method: "post",
    path: "/api/files/op",
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.discriminatedUnion("op", [
              z.object({ op: z.literal("mkdir"), scope: z.string(), path: z.string() }),
              z.object({
                op: z.literal("rename"),
                scope: z.string(),
                path: z.string(),
                to: z.string(),
              }),
              z.object({ op: z.literal("delete"), scope: z.string(), path: z.string() }),
            ]),
          },
        },
      },
    },
    responses: { 200: json(z.object({ ok: z.literal(true) }), "Done"), ...errors },
  }),
  budgets: createRoute({
    method: "get",
    path: "/api/budgets",
    security,
    responses: {
      200: json(
        z.array(
          z.object({
            scope: z.enum(["agent", "project", "global"]),
            id: z.string(),
            limit: z.object({ usd: z.number().optional(), tokens: z.number().optional() }),
            used: z.object({ usd: z.number(), tokens: z.number() }),
          }),
        ),
        "Spend and limits",
      ),
      ...errors,
    },
  }),
  setBudget: createRoute({
    method: "put",
    path: "/api/budgets",
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              scope: z.enum(["agent", "project", "global"]),
              id: z.string(),
              usd: z.number().positive().optional(),
              tokens: z.number().int().positive().optional(),
            }),
          },
        },
      },
    },
    responses: { 200: json(z.object({ ok: z.literal(true) }), "Saved"), ...errors },
  }),
  boardThreads: createRoute({
    method: "get",
    path: "/api/board/threads",
    security,
    request: {
      query: z.object({
        projectId: z.string().optional(),
        status: z.enum(["open", "resolved", "blocked"]).optional(),
        /** A subproject's view: its threads and the whole project's (G24.14c). */
        subprojectId: z.string().optional(),
      }),
    },
    responses: {
      200: json(z.array(z.unknown()), "Threads of a board (no projectId = the global board)"),
      ...errors,
    },
  }),
  boardThread: createRoute({
    method: "get",
    path: "/api/board/threads/{id}",
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: json(
        z.object({ thread: z.unknown(), posts: z.array(z.unknown()) }),
        "A thread and its posts",
      ),
      ...errors,
    },
  }),
  boardPost: createRoute({
    method: "post",
    path: "/api/board/posts",
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              threadId: z.string().optional(),
              projectId: z.string().nullable().optional(),
              subprojectId: z.string().nullable().optional(),
              title: z.string().min(3).optional(),
              kind: z.enum(["task", "result", "question", "decision", "blocker", "note"]),
              body: z.string().min(1),
            }),
          },
        },
      },
    },
    responses: {
      201: json(z.object({ threadId: z.string(), postId: z.string() }), "Posted"),
      ...errors,
    },
  }),
  boardStatus: createRoute({
    method: "post",
    path: "/api/board/threads/{id}/status",
    security,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ status: z.enum(["open", "resolved", "blocked"]) }),
          },
        },
      },
    },
    responses: { 200: json(z.object({ ok: z.literal(true) }), "Updated"), ...errors },
  }),
  boardSearch: createRoute({
    method: "get",
    path: "/api/board/search",
    security,
    request: { query: z.object({ q: z.string().min(1) }) },
    responses: { 200: json(z.array(z.unknown()), "Matching posts"), ...errors },
  }),
  boardDigest: createRoute({
    method: "get",
    path: "/api/board/digest",
    security,
    request: { query: z.object({ projectId: z.string().optional(), since: z.string() }) },
    responses: {
      200: json(z.object({ digest: z.string() }), "A digest written by the board model"),
      ...errors,
    },
  }),
  proposals: createRoute({
    method: "get",
    path: "/api/extensions/proposals",
    security,
    request: {
      query: z.object({
        status: z.enum(["failed", "pending", "installed", "rejected"]).optional(),
      }),
    },
    responses: {
      200: json(z.array(z.unknown()), "Proposed tools and skills, with their test reports"),
      ...errors,
    },
  }),
  createExtension: createRoute({
    method: "post",
    path: "/api/extensions/proposals",
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ projectId: z.string().nullable(), input: z.unknown() }),
          },
        },
      },
    },
    responses: {
      201: json(z.unknown(), "Tested; installed if the tests pass (the user is the author)"),
      ...errors,
    },
  }),
  decideExtension: createRoute({
    method: "post",
    path: "/api/extensions/proposals/{id}/decision",
    security,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": { schema: z.object({ decision: z.enum(["approve", "reject"]) }) },
        },
      },
    },
    responses: { 200: json(z.unknown(), "Decided"), ...errors },
  }),
  listMcp: createRoute({
    method: "get",
    path: "/api/extensions/mcp",
    security,
    responses: { 200: json(z.array(z.unknown()), "Configured MCP servers"), ...errors },
  }),
  setMcp: createRoute({
    method: "put",
    path: "/api/extensions/mcp",
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/),
              projectId: z.string().nullable(),
              transport: z.discriminatedUnion("type", [
                z.object({
                  type: z.literal("stdio"),
                  command: z.string().min(1),
                  args: z.array(z.string()).optional(),
                  env: z.record(z.string(), z.string()).optional(),
                }),
                z.object({
                  type: z.literal("http"),
                  url: z.url(),
                  headers: z.record(z.string(), z.string()).optional(),
                  oauth: z.boolean().optional(),
                }),
              ]),
              /** Keys for the server: kept in a private file, never shown again. */
              secrets: z
                .object({
                  headers: z.record(z.string(), z.string()).optional(),
                  env: z.record(z.string(), z.string()).optional(),
                  /** The person's own OAuth app (G24.14c). */
                  app: z
                    .object({
                      clientId: z.string().min(1).max(500),
                      clientSecret: z.string().max(2000).optional(),
                      scope: z.string().max(4000).optional(),
                      authParams: z.record(z.string(), z.string()).optional(),
                    })
                    .optional(),
                })
                .optional(),
            }),
          },
        },
      },
    },
    responses: { 200: json(z.object({ ok: z.literal(true) }), "Saved"), ...errors },
  }),
  deleteMcp: createRoute({
    method: "delete",
    path: "/api/extensions/mcp/{name}",
    security,
    request: { params: z.object({ name: z.string() }) },
    responses: { 200: json(z.object({ ok: z.literal(true) }), "Removed"), ...errors },
  }),
  installed: createRoute({
    method: "get",
    path: "/api/extensions/installed",
    security,
    responses: {
      200: json(
        z.array(
          z.object({
            kind: z.enum(["tool", "skill"]),
            name: z.string(),
            description: z.string(),
            scope: z.string(),
            path: z.string(),
          }),
        ),
        "Installed tools and skills",
      ),
      ...errors,
    },
  }),
  verifyLog: createRoute({
    method: "get",
    path: "/api/log/verify",
    security,
    responses: {
      200: json(
        z.object({
          ok: z.boolean(),
          checked: z.number().optional(),
          seq: z.number().optional(),
          reason: z.string().optional(),
        }),
        "Integrity of the event log",
      ),
      ...errors,
    },
  }),
};

const agentOut = (a: NonNullable<ReturnType<RedGiantCore["registry"]["get"]>>) => {
  const { ownerId: _o, ...rest } = a;
  return rest;
};

/** The HTTP API. Every route but /api/health and /api/openapi.json needs a bearer token. */
export interface AppOptions {
  /** Directory of the built web UI; served at / with a fallback to index.html. */
  webDir?: string;
  /** Mutable: the setup wizard can start the bot while the server runs. */
  telegram?: { gateway?: TelegramGateway; webhookSecret?: string };
  /** Discord, Slack, Signal, WhatsApp (G29.5). */
  chats?: ChatHub;
  setup?: SetupService;
  hf?: HuggingFace;
  /** Whose password signs in (one owner per installation; default the local owner). */
  loginOwner?: string;
  /** The models folder of the engine on Windows itself (G24.3b), when there is one. */
  winHf?: HuggingFace;
  /** The pages connected now (3.5.3): the launcher asks after an update before opening one. */
  pages?: OpenPages;
}

export function createApp(core: RedGiantCore, auth: AuthProvider, options: AppOptions = {}) {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          { error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
          400,
        );
    },
  });

  app.get("/api/health", (c) => c.json({ ok: true, protocolVersion: PROTOCOL_VERSION }));
  app.doc31("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "RedGiant", version: String(PROTOCOL_VERSION) },
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
  });

  // Debug mode (2026-11-04): every request with its answer and its time, but not the ones the
  // page repeats every second to follow progress.
  app.use("/api/*", async (c, next) => {
    if (!debugLog.enabled) return next();
    const started = Date.now();
    await next();
    const quiet =
      c.req.method === "GET" && /^\/api\/(jobs|health|limits|activity)/.test(c.req.path);
    if (!quiet || c.res.status >= 400)
      debugLog.write("http", `${c.req.method} ${c.req.path}`, {
        status: c.res.status,
        ms: Date.now() - started,
      });
  });

  app.use("/api/*", async (c, next) => {
    const open = [
      "/api/health",
      "/api/openapi.json",
      "/api/telegram/webhook",
      // WhatsApp checks its webhook with a token and signs every message (G29.5).
      "/api/chats/whatsapp/webhook",
      // Teams signs every activity with a Bot Connector token (G36.9).
      "/api/chats/teams/messages",
      // Signing in with a password (G24.6): the password is the credential.
      "/api/auth/methods",
      "/api/auth/login",
      // The service sends the person back here after signing in; the state is the credential.
      "/api/extensions/oauth/callback",
    ];
    // Automation webhooks carry their own secret; the browser extension its device token (G36.21),
    // checked by its own routes: the person's sign-in does not open them.
    if (
      open.includes(c.req.path) ||
      c.req.path.startsWith("/api/browser-ext/") ||
      /^\/api\/automations\/[\w-]+\/hook(\/[\w-]+)?$/.test(c.req.path)
    )
      return next();
    const principal = await auth.authenticate(bearer(c.req.header("authorization")));
    if (!principal) return c.json({ error: "Missing or invalid token" }, 401);
    c.set("principal", principal);
    return next();
  });

  app.onError((err, c) => {
    if (
      err instanceof NotFoundError ||
      err instanceof AutomationNotFoundError ||
      err instanceof MailboxNotFoundError ||
      err instanceof MagicNotFoundError
    )
      return c.json({ error: err.message }, 404);
    if (err instanceof MagicStateError) return c.json({ error: err.message }, 400);
    if (err instanceof RecipeError) return c.json({ error: err.message }, 400);
    // A mandatory update is waiting (G36.19): refused, nothing lost; the page shows its window.
    if (err instanceof UpdateRequiredError)
      return c.json({ error: err.message, code: err.code }, 423);
    // An archived project (2026-11-09): read only until the person restores it.
    if (err instanceof ProjectArchivedError)
      return c.json({ error: err.message, code: err.code }, 423);
    if (err instanceof SessionBusyError) return c.json({ error: err.message }, 409);
    if (err instanceof NoModelError) return c.json({ error: err.message, code: err.code }, 400);
    if (
      err instanceof HierarchyError ||
      err instanceof BadRequestError ||
      err instanceof PathOutsideWorkspaceError
    ) {
      return c.json({ error: err.message }, 400);
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return c.json({ error: "No such file or directory" }, 404);
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "ENOTDIR")
      return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  const owner = (c: Context<Env>) => c.get("principal").ownerId ?? LOCAL_OWNER_ID;
  // Who is asking, as far as can be trusted: Cloudflare's header (it overwrites it), the last
  // address our own proxy added, or the connection itself. The first X-Forwarded-For entry is
  // whatever the client wrote.
  const clientAddress = (c: Context<Env>) => {
    const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress;
    return (
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() ||
      socket ||
      "local"
    );
  };
  // Signing in with a password (G24.6): one owner per installation.
  const loginOwner = options.loginOwner ?? LOCAL_OWNER_ID;
  const loginFailure = (c: Context<Env>, err: unknown) =>
    err instanceof LoginError
      ? c.json({ error: err.message, code: err.code }, err.code === "too_many" ? 429 : 400)
      : Promise.reject(err);
  app.get("/api/auth/methods", async (c) => c.json(await core.logins.status(loginOwner), 200));
  app.post("/api/auth/login", async (c) => {
    const b = z
      .object({ password: z.string().min(1).max(500), code: z.string().max(12).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "A password is needed" }, 400);
    const address = clientAddress(c);
    try {
      return c.json(
        await core.logins.login(
          loginOwner,
          b.data.password,
          b.data.code,
          address,
          (c.req.header("user-agent") ?? "Browser").slice(0, 80),
        ),
        200,
      );
    } catch (err) {
      return loginFailure(c, err);
    }
  });
  app.get("/api/auth/sessions", async (c) => c.json(await core.logins.sessions(owner(c)), 200));
  app.post("/api/auth/sessions/revoke", async (c) => {
    await core.logins.revokeAll(owner(c));
    return c.json({ ok: true }, 200);
  });
  app.put("/api/auth/password", async (c) => {
    const b = z
      .object({ password: z.string().max(500) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "A password is needed" }, 400);
    try {
      await core.logins.setPassword(owner(c), b.data.password);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return loginFailure(c, err);
    }
  });
  // The second check: a secret for the app, switched on by one of its codes.
  app.post("/api/auth/code/new", (c) => c.json(core.logins.newCodeSecret(owner(c)), 200));
  app.post("/api/auth/code", async (c) => {
    const b = z
      .object({ secret: z.string().min(16).max(64), code: z.string().max(12) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "A secret and a code are needed" }, 400);
    try {
      await core.logins.enableCode(owner(c), b.data.secret, b.data.code);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return loginFailure(c, err);
    }
  });
  app.delete("/api/auth/code", async (c) => {
    await core.logins.disableCode(owner(c));
    return c.json({ ok: true }, 200);
  });
  const human = (c: Context<Env>) => ({ type: "human" as const, ownerId: owner(c) });

  app.openapi(routes.listProjects, async (c) => c.json(await core.projects.list(owner(c)), 200));
  app.openapi(routes.createProject, async (c) => {
    try {
      const { name, path } = c.req.valid("json");
      return c.json(await core.projects.create(owner(c), name, path), 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.openapi(routes.listAgents, async (c) => {
    const { projectId } = c.req.valid("query");
    return c.json(
      core.registry.list({ ownerId: owner(c), ...(projectId && { projectId }) }).map(agentOut),
      200,
    );
  });
  // What an agent's summaries do by default, for the sliders (G33.4: 12% on a local model).
  app.get("/api/agents/:id/compaction-defaults", (c) => {
    try {
      return c.json(core.compactionDefaults(owner(c), c.req.param("id")), 200);
    } catch (err) {
      if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });
  app.openapi(routes.createAgent, async (c) => {
    const body = c.req.valid("json");
    if (body.projectId && !(await core.projects.get(owner(c), body.projectId)))
      return c.json({ error: `Project "${body.projectId}" not found` }, 404);
    if (body.subprojectId) {
      const sub = await core.projects.subproject(owner(c), body.subprojectId);
      const project =
        body.projectId ?? core.registry.get(body.parentId ?? "")?.projectId ?? undefined;
      if (!sub || sub.projectId !== project)
        return c.json({ error: `Subproject "${body.subprojectId}" not found in the project` }, 404);
    }
    const { parentId, ...rest } = body;
    const input = Object.fromEntries(
      Object.entries({ ...rest, parentId: parentId ?? null }).filter(([, v]) => v !== undefined),
    );
    return c.json(
      agentOut(
        await core.registry.create(
          human(c),
          input as unknown as Parameters<typeof core.registry.create>[1],
        ),
      ),
      201,
    );
  });
  app.openapi(routes.configureAgent, async (c) => {
    const change = Object.fromEntries(
      Object.entries(c.req.valid("json")).filter(([, v]) => v !== undefined),
    );
    const id = c.req.valid("param").id;
    if (core.registry.get(id)?.ownerId !== owner(c))
      return c.json({ error: "Agent not found" }, 404);
    // Only working agents go to other projects, and only to projects that exist (2026-11-03).
    const assigned = change.projects as string[] | null | undefined;
    if (assigned && assigned.length > 0) {
      const a = core.registry.get(id);
      if (a?.kind !== "agent" && a?.kind !== "assistant")
        return c.json(
          { error: "Only agents and personal agents can be assigned to projects" },
          400,
        );
      for (const p of assigned)
        if (!(await core.projects.get(owner(c), p)))
          return c.json({ error: `No project "${p}"` }, 400);
      change.projects = [...new Set(assigned)].filter((p) => p !== a.projectId);
    }
    const { name, ...rest } = change as typeof change & { name?: string };
    if (name !== undefined) await core.registry.rename(id, name);
    const updated = await core.registry.configure(human(c), id, rest);
    if ("model" in change) core.agentModelChanged(id);
    return c.json(agentOut(updated), 200);
  });
  // An agent's instructions as the person reads them (2026-11-06): its own or the built-in ones,
  // with the current names; saving keeps the names as placeholders. Open conversations keep theirs.
  const PromptBody = z.object({ text: z.string().max(100_000).nullable() });
  app.get("/api/agents/:id/prompt", async (c) => {
    const a = core.registry.get(c.req.param("id"));
    if (a?.ownerId !== owner(c)) return c.json({ error: "Agent not found" }, 404);
    return c.json(await core.promptOf(a), 200);
  });
  app.put("/api/agents/:id/prompt", async (c) => {
    const a = core.registry.get(c.req.param("id"));
    if (a?.ownerId !== owner(c)) return c.json({ error: "Agent not found" }, 404);
    const b = PromptBody.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "A text (or null) is needed" }, 400);
    return c.json(await core.setPrompt(a, b.data.text), 200);
  });
  app.get("/api/chat/prompt", async (c) => c.json(await core.chatPrompt(owner(c)), 200));
  app.put("/api/chat/prompt", async (c) => {
    const b = PromptBody.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "A text (or null) is needed" }, 400);
    return c.json(await core.setChatPrompt(owner(c), b.data.text), 200);
  });
  // The instructions' refiner (G36.13) and God's instructions for a new agent (G36.14): an
  // estimate first, then the revised text. Nothing is saved: the person saves from the editor.
  const refining = async (
    c: Context<Env>,
    f: (r: z.output<typeof RefineRequest>) => Promise<unknown>,
  ) => {
    const b = RefineRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "A target and a goal are needed" }, 400);
    try {
      return c.json(await f(b.data), 200);
    } catch (err) {
      if (err instanceof RefineError) return c.json({ error: err.message, code: err.code }, 400);
      throw err;
    }
  };
  app.post("/api/prompts/refine/estimate", (c) =>
    refining(c, (r) => core.estimateRefine(owner(c), r)),
  );
  app.post("/api/prompts/refine", (c) =>
    refining(c, (r) => core.refinePrompt(owner(c), r, c.req.raw.signal)),
  );
  app.openapi(routes.stopAgent, async (c) => {
    const id = c.req.valid("param").id;
    if (core.registry.get(id)?.ownerId !== owner(c))
      return c.json({ error: "Agent not found" }, 404);
    return c.json(
      { stopped: await core.registry.stop(human(c), id, c.req.valid("json").reason) },
      200,
    );
  });

  app.openapi(routes.listSessions, async (c) => {
    const rows = await core.listSessions(owner(c), c.req.valid("query").agentId);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        projectId: r.project_id,
        createdAt: new Date(r.created_at).toISOString(),
        lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
        title: r.title,
        pinned: r.pinned,
        archived: r.archived,
        folder: r.folder ?? null,
        forkedFrom: r.forked_from ?? null,
        running: core.isRunning(r.id),
        task: core.tasks.openFor(r.agent_id, r.id)?.title ?? null,
        model: (typeof r.model === "string"
          ? JSON.parse(r.model)
          : r.model) as ModelSpecType | null,
      })),
      200,
    );
  });
  app.patch("/api/sessions/:id", async (c) => {
    const b = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        model: ModelSpec.nullable().optional(),
        /** A folder's name; null takes it out of any folder. */
        folder: z.string().trim().min(1).max(60).nullable().optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: b.error.message }, 400);
    if (b.data.model !== undefined)
      await core.setSessionModel(owner(c), c.req.param("id"), b.data.model);
    await core.updateSession(owner(c), c.req.param("id"), {
      ...(b.data.title !== undefined && { title: b.data.title }),
      ...(b.data.pinned !== undefined && { pinned: b.data.pinned }),
      ...(b.data.archived !== undefined && { archived: b.data.archived }),
      ...(b.data.folder !== undefined && { folder: b.data.folder }),
    });
    return c.json({ ok: true }, 200);
  });
  // A conversation as a Markdown file.
  app.get("/api/sessions/:id/export", async (c) => {
    const o = owner(c);
    const id = c.req.param("id");
    const events = await core.history(o, id);
    const row = (await core.listSessions(o)).find((r) => r.id === id);
    const agent = core.registry.get(row?.agent_id ?? "");
    const title = row?.title ?? agent?.name ?? id;
    const md = sessionMarkdown(events, {
      title,
      agentName: agent?.name ?? "",
      language: core.language(o),
    });
    const file = `${
      title
        .replace(/[^\p{L}\p{N} _-]+/gu, "")
        .trim()
        .slice(0, 60) || "conversation"
    }.md`;
    return c.body(md, 200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file)}`,
    });
  });
  // ChatGPT's login (G21): a device code the human types at OpenAI; Codex keeps the login.
  const chatgpt = () => {
    if (!core.providers.has("chatgpt-subscription")) return undefined;
    return core.providers.get("chatgpt-subscription") as unknown as {
      account(): Promise<{ email: string | null; plan: string | null } | null>;
      login(): Promise<{ url: string; code: string; done: Promise<boolean> }>;
      logout(): Promise<void>;
    };
  };
  app.get("/api/subscriptions/chatgpt", async (c) => {
    const p = chatgpt();
    // Where Codex comes from, and whether the person's own sign-in is used (2026-11-05).
    const tool = setup?.toolStatus("codex") ?? { program: null, sharedLogin: false };
    if (!p) return c.json({ on: false, account: null, ...tool }, 200);
    return c.json({ on: true, account: await p.account().catch(() => null), ...tool }, 200);
  });
  app.post("/api/subscriptions/chatgpt/login", async (c) => {
    const p = chatgpt();
    if (!p) return c.json({ error: "Switch the ChatGPT subscription on first" }, 400);
    const { url, code, done } = await p.login();
    done.catch(() => {});
    return c.json({ url, code }, 200);
  });
  app.post("/api/subscriptions/chatgpt/logout", async (c) => {
    await chatgpt()?.logout();
    return c.json({ ok: true }, 200);
  });
  // The plans' limits of the flat subscriptions (the header's bars).
  app.get("/api/limits", async (c) => c.json(await core.limits(), 200));
  // How many of the person's pages are connected (3.5.3): after an update the launcher opens one
  // only when none came back by itself. A number only, behind the sign-in.
  app.get("/api/pages", (c) => c.json({ pages: options.pages?.count(owner(c)) ?? 0 }, 200));
  // Long actions (G24.1): the UI follows them and finds them again after a reload.
  app.get("/api/jobs", (c) => c.json(core.jobs.list(owner(c)), 200));
  app.get("/api/jobs/:id", (c) => {
    const job = core.jobs.get(owner(c), c.req.param("id"));
    return job ? c.json(job, 200) : c.json({ error: "No such job" }, 404);
  });
  app.post("/api/jobs/:id/cancel", (c) =>
    core.jobs.cancel(owner(c), c.req.param("id"))
      ? c.json({ ok: true }, 200)
      : c.json({ error: "Nothing to cancel" }, 409),
  );
  // What the composer offers: every provider's models, and whether they take an effort.
  app.get("/api/models", async (c) => c.json(await core.models(), 200));
  // The models catalog in use (3.5.4) and «Update now».
  app.get("/api/models/catalog", (c) => c.json(core.catalog?.status() ?? null, 200));
  app.post("/api/models/catalog/refresh", async (c) =>
    c.json((await core.catalog?.check()) ?? null, 200),
  );
  app.get("/api/search", async (c) =>
    c.json(await core.search(owner(c), c.req.query("q") ?? ""), 200),
  );
  app.openapi(routes.startSession, async (c) =>
    c.json({ sessionId: await core.startSession(owner(c), c.req.valid("json").agentId) }, 201),
  );
  app.openapi(routes.sessionEvents, async (c) =>
    c.json(await core.history(owner(c), c.req.valid("param").id), 200),
  );
  app.openapi(routes.sendMessage, async (c) => {
    const { text, images } = c.req.valid("json");
    const { done } = await core.send(owner(c), c.req.valid("param").id, text, {
      ...(images?.length ? { images } : {}),
      watch: true,
      queue: true,
    });
    done.catch((err) => console.error("session failed:", err));
    return c.json({ accepted: true as const }, 202);
  });
  app.openapi(routes.interrupt, async (c) =>
    c.json({ interrupted: await core.interrupt(owner(c), c.req.valid("param").id) }, 200),
  );

  app.openapi(routes.listPermissions, (c) => c.json(core.approvals.list(owner(c)), 200));
  app.openapi(routes.decidePermission, (c) =>
    core.approvals.decide(
      owner(c),
      c.req.valid("param").id,
      c.req.valid("json").decision,
      undefined,
      "web",
    )
      ? c.json({ ok: true as const }, 200)
      : c.json({ error: "No such pending request" }, 404),
  );
  const files = new FileService(core);
  app.openapi(routes.listFiles, async (c) => {
    const q = c.req.valid("query");
    return c.json(await files.list(owner(c), q.scope, q.path), 200);
  });
  app.openapi(routes.readFile, async (c) => {
    const q = c.req.valid("query");
    return c.json(await files.read(owner(c), q.scope, q.path), 200);
  });
  app.openapi(routes.writeFile, async (c) => {
    const b = c.req.valid("json");
    try {
      const r = await files.write(owner(c), b.scope, b.path, b.content, b.encoding, {
        ...(b.expectedModifiedAt !== undefined && { expectedModifiedAt: b.expectedModifiedAt }),
        ...(b.ifExists && { ifExists: b.ifExists }),
      });
      return c.json(r, 200);
    } catch (err) {
      if (err instanceof ConflictError)
        return c.json({ error: err.message, modifiedAt: err.modifiedAt }, 409);
      throw err;
    }
  });
  app.openapi(routes.fileOp, async (c) => {
    const b = c.req.valid("json");
    if (b.op === "mkdir") await files.mkdir(owner(c), b.scope, b.path);
    if (b.op === "rename") await files.rename(owner(c), b.scope, b.path, b.to);
    if (b.op === "delete") await files.remove(owner(c), b.scope, b.path);
    return c.json({ ok: true as const }, 200);
  });
  // Raw download (any size, any type): outside OpenAPI because it is not JSON.
  app.get("/api/files/raw", async (c) => {
    const { stream, size, name } = await files.download(
      owner(c),
      c.req.query("scope") ?? "",
      c.req.query("path") ?? "",
    );
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(size),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  });

  // Closed formats into open ones (G34.3): what a file is, and a conversion as a job.
  convertRoutes(app, core, owner);
  officeRoutes(app, core, owner, options.webDir);
  pdfRoutes(app, core, owner);
  imageRoutes(app, core, owner, () => core.pictures);
  // Import from other agents (G36.7): previews, the import as a job, undo.
  importRoutes(app, core, owner, options.setup);
  // The person's artifacts (3.5.9): the collection, export and import.
  artifactRoutes(app, core, owner);
  // Commands' limits and requests to the person (G36.16, G36.17).
  personRoutes(app, core, owner);
  sheetRoutes(app, core, owner);
  svgRoutes(app, core, owner);
  modelRoutes(app, core, owner);
  browserRoutes(app, core.browserLinks, owner, clientAddress);
  // Mandatory and breaking updates (G36.19): the status, the safety backup, found backups.
  updateRoutes(app, core, owner, options.setup);
  // The knowledge (G36, the RAG): collections, sources, models, search, citations.
  knowledgeRoutes(app, () => core.knowledge, owner);

  // Backup (2026-11-03): every project, agent and conversation in one file, and back. Outside
  // OpenAPI: the file goes up and down as raw bytes.
  const BACKUP_NAME = /^[a-z0-9-]+\.rgbackup$/;
  app.post("/api/backup/export", async (c) => {
    const o = owner(c);
    // The keychain goes in only sealed with the person's passphrase (G33.4).
    const pass = (
      await c.req.json<{ keychainPassphrase?: string }>().catch(() => ({ keychainPassphrase: "" }))
    ).keychainPassphrase;
    let keychain: string | undefined;
    try {
      keychain = pass && core.vault.ready ? core.vault.exportSealed(o, pass) : undefined;
    } catch (err) {
      return vaultFailed(c, err);
    }
    const running = core.jobs
      .list(o)
      .find((j) => j.kind === "backup_export" && j.state === "running");
    if (running) return c.json(running, 200);
    const dir = core.backupsDir;
    const name = `redgiant-backup-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.rgbackup`;
    const job = core.jobs.start(
      o,
      "backup_export",
      ["data", "conversations", "files"],
      async (h) => {
        // One backup at a time stays here: the older ones were downloaded already.
        await mkdir(dir, { recursive: true });
        for (const f of await readdir(dir))
          if (f.startsWith("redgiant-backup-")) await removeBackup(join(dir, f));
        // The knowledge's pieces and vectors only when the person asked (G36.6).
        const vectors = (await core.knowledge?.settings(o).catch(() => undefined))?.backupVectors;
        await exportBackup(core.backupDeps, o, join(dir, name), h, keychain, {
          ...(vectors && { vectors }),
        });
        h.info({ file: name });
      },
      { file: name },
    );
    return c.json(job, 200);
  });
  app.get("/api/backup/file/:name", async (c) => {
    const name = c.req.param("name");
    if (!BACKUP_NAME.test(name)) return c.json({ error: "No such backup" }, 404);
    const file = join(core.backupsDir, name);
    const st = await stat(file).catch(() => undefined);
    if (!st) return c.json({ error: "No such backup" }, 404);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(st.size),
        "content-disposition": `attachment; filename="${name}"`,
      },
    });
  });
  // The file to import, streamed to disk; what it holds comes back for the person to confirm.
  app.post("/api/backup/upload", async (c) => {
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "No file" }, 400);
    const id = `import-${randomUUID()}`;
    const file = join(core.backupsDir, `${id}.rgbackup`);
    await mkdir(core.backupsDir, { recursive: true });
    await pipeline(Readable.fromWeb(body as never), createWriteStream(file));
    try {
      return c.json({ id, preview: await previewBackup(core.backupDeps, owner(c), file) }, 200);
    } catch (err) {
      await removeBackup(file);
      if (err instanceof BackupError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.post("/api/backup/import", async (c) => {
    const b = await c.req.json<{
      id?: string;
      godName?: string;
      demigodName?: string;
      keychainPassphrase?: string;
    }>();
    const name = `${b.id ?? ""}.rgbackup`;
    if (!b.id?.startsWith("import-") || !BACKUP_NAME.test(name))
      return c.json({ error: "No such backup" }, 404);
    const file = join(core.backupsDir, name);
    if (!(await stat(file).catch(() => undefined))) return c.json({ error: "No such backup" }, 404);
    const o = owner(c);
    const job = core.jobs.start(
      o,
      "backup_import",
      ["data", "conversations", "files"],
      async (h) => {
        try {
          const r = await importBackup(
            core.backupDeps,
            o,
            file,
            {
              ...(b.godName && { godName: b.godName }),
              ...(b.demigodName && { demigodName: b.demigodName }),
            },
            h,
          );
          h.info({
            projects: String(r.projects.length),
            agents: String(r.agents),
            conversations: String(r.conversations),
            files: String(r.files),
          });
          // The keychain it carries, opened with the person's passphrase (G33.4); a wrong one
          // leaves everything else imported and says so.
          if (r.keychain && b.keychainPassphrase)
            h.info({
              keychain: await core.vault
                .importSealed(o, r.keychain, b.keychainPassphrase)
                .then(String)
                .catch(() => "wrong"),
            });
        } finally {
          // The agents in memory follow what was added.
          await core.registry.load();
          await removeBackup(file);
        }
      },
    );
    return c.json(job, 200);
  });

  app.openapi(routes.budgets, async (c) => {
    const o = owner(c);
    const projects = [
      ...(await core.projects.list(o)).map((p) => p.id),
      // A subproject's budget is kept under its id (G24.13).
      ...(await core.projects.subprojects(o)).map((s) => s.id),
    ];
    const agents = core.registry.list({ ownerId: o }).map((a) => a.id);
    const rows = await core.budget.listFor(o, projects, agents);
    // The total is always there, so its limit can be set before anything is spent.
    if (!rows.some((r) => r.scope === "global"))
      rows.unshift({ scope: "global", id: o, limit: {}, used: { usd: 0, tokens: 0 } });
    return c.json(rows, 200);
  });
  app.openapi(routes.setBudget, async (c) => {
    const b = c.req.valid("json");
    const o = owner(c);
    const mine =
      (b.scope === "global" && b.id === o) ||
      (b.scope === "project" &&
        ((await core.projects.get(o, b.id)) !== undefined ||
          (await core.projects.subproject(o, b.id)) !== undefined)) ||
      (b.scope === "agent" && core.registry.get(b.id)?.ownerId === o);
    if (!mine) return c.json({ error: "Not found" }, 404);
    // Through the configuration, so the change is in the history and can be undone.
    await core.config.setBudget(
      o,
      "human",
      { scope: b.scope, id: b.id },
      {
        ...(b.usd !== undefined && { usd: b.usd }),
        ...(b.tokens !== undefined && { tokens: b.tokens }),
      },
    );
    return c.json({ ok: true as const }, 200);
  });
  // Spend per day (G24.10), for the month's chart.
  app.get("/api/budgets/daily", async (c) => {
    const from = c.req.query("from") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return c.json({ error: "from must be YYYY-MM-DD" }, 400);
    return c.json(await core.budget.daily(owner(c), from), 200);
  });

  const ownsProject = async (c: Context<Env>, projectId: string | null | undefined) =>
    projectId === null ||
    projectId === undefined ||
    (await core.projects.get(owner(c), projectId)) !== undefined;
  app.openapi(routes.boardThreads, async (c) => {
    const q = c.req.valid("query");
    if (!(await ownsProject(c, q.projectId))) return c.json({ error: "Project not found" }, 404);
    return c.json(
      await core.board.threads(owner(c), q.projectId ?? null, q.status, q.subprojectId),
      200,
    );
  });
  app.openapi(routes.boardThread, async (c) => {
    const id = c.req.valid("param").id;
    const thread = await core.board.thread(owner(c), id);
    if (!thread) return c.json({ error: "Thread not found" }, 404);
    return c.json({ thread, posts: await core.board.posts(owner(c), id) }, 200);
  });
  app.openapi(routes.boardPost, async (c) => {
    const b = c.req.valid("json");
    const post = { author: "human", kind: b.kind, body: b.body };
    if (b.threadId) {
      if (!(await core.board.thread(owner(c), b.threadId)))
        return c.json({ error: "Thread not found" }, 404);
      const p = await core.board.reply(owner(c), b.threadId, post);
      return c.json({ threadId: b.threadId, postId: p.id }, 201);
    }
    if (!b.title) return c.json({ error: "Give threadId to reply or title to open a thread" }, 400);
    if (!(await ownsProject(c, b.projectId))) return c.json({ error: "Project not found" }, 404);
    const r = await core.board.createThread({
      ownerId: owner(c),
      projectId: b.projectId ?? null,
      subprojectId: b.subprojectId ?? null,
      title: b.title,
      first: post,
    });
    return c.json({ threadId: r.thread.id, postId: r.post.id }, 201);
  });
  app.openapi(routes.boardStatus, async (c) => {
    const id = c.req.valid("param").id;
    if (!(await core.board.thread(owner(c), id))) return c.json({ error: "Thread not found" }, 404);
    await core.board.setStatus(owner(c), id, c.req.valid("json").status, "human");
    return c.json({ ok: true as const }, 200);
  });
  app.openapi(routes.boardSearch, async (c) =>
    c.json(await core.board.search(owner(c), c.req.valid("query").q, "all"), 200),
  );
  app.openapi(routes.boardDigest, async (c) => {
    const q = c.req.valid("query");
    if (!core.summarizer) return c.json({ error: "No model is configured for the board" }, 400);
    if (!(await ownsProject(c, q.projectId))) return c.json({ error: "Project not found" }, 404);
    return c.json(
      { digest: await core.summarizer.digest(owner(c), q.projectId ?? null, q.since) },
      200,
    );
  });

  app.openapi(routes.proposals, async (c) =>
    c.json(await core.extensions.list(owner(c), c.req.valid("query").status), 200),
  );
  app.openapi(routes.createExtension, async (c) => {
    const b = c.req.valid("json");
    if (!(await ownsProject(c, b.projectId))) return c.json({ error: "Project not found" }, 404);
    try {
      // The user is the author: if the tests pass there is nobody else to ask.
      const p = await core.extensions.propose({
        ownerId: owner(c),
        projectId: b.projectId,
        author: "human",
        input: b.input as never,
        autoInstall: true,
      });
      return c.json(p, 201);
    } catch (err) {
      const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
      return c.json(
        {
          error: issues
            ? issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")
            : (err as Error).message,
        },
        400,
      );
    }
  });
  app.openapi(routes.decideExtension, async (c) => {
    try {
      return c.json(
        await core.extensions.decide(
          owner(c),
          c.req.valid("param").id,
          c.req.valid("json").decision,
          "human",
        ),
        200,
      );
    } catch (err) {
      return c.json(
        { error: (err as Error).message },
        /No proposal/.test((err as Error).message) ? 404 : 400,
      );
    }
  });
  app.openapi(routes.installed, async (c) => {
    const o = owner(c);
    const roots = [
      { dir: core.platformPath(o), scope: "platform" as const, label: "platform" },
      ...(await core.projects.list(o)).map((p) => ({
        dir: join(p.path, ".redgiant"),
        scope: "project" as const,
        label: `project:${p.id}`,
      })),
    ];
    const out: {
      kind: "tool" | "skill";
      name: string;
      description: string;
      scope: string;
      path: string;
    }[] = [];
    for (const r of roots) {
      for (const sk of await loadSkills([r]))
        out.push({
          kind: "skill",
          name: sk.name,
          description: sk.description,
          scope: r.label,
          path: `${r.scope === "platform" ? "" : ".redgiant/"}skills/${sk.name}/SKILL.md`,
        });
      for (const t of await loadCustomTools([r]))
        out.push({
          kind: "tool",
          name: t.spec.name,
          description: t.spec.description,
          scope: r.label,
          path: `${r.scope === "platform" ? "" : ".redgiant/"}tools/${t.spec.name}/tool.json`,
        });
    }
    return c.json(out, 200);
  });
  app.openapi(routes.listMcp, async (c) => c.json(await core.listMcp(owner(c)), 200));
  app.openapi(routes.setMcp, async (c) => {
    const b = c.req.valid("json");
    if (!(await ownsProject(c, b.projectId))) return c.json({ error: "Project not found" }, 404);
    const { secrets, ...config } = b;
    await core.setMcp(owner(c), config as never, secrets as never);
    return c.json({ ok: true as const }, 200);
  });
  app.openapi(routes.deleteMcp, async (c) => {
    await core.removeMcp(owner(c), c.req.valid("param").name);
    return c.json({ ok: true as const }, 200);
  });

  // Telegram: pairing, linked accounts, and the webhook (authenticated by Telegram's secret header).
  const tg = options.telegram;
  app.post("/api/telegram/pair", async (c) => {
    const gateway = tg?.gateway;
    if (!gateway) return c.json({ error: "Telegram is not configured" }, 400);
    const me = await gateway.init();
    return c.json(
      {
        ...gateway.pairingCode(owner(c)),
        bot: me.username,
        link: `https://t.me/${me.username}`,
      },
      200,
    );
  });
  app.get("/api/telegram/links", async (c) =>
    c.json(tg?.gateway ? await tg.gateway.links(owner(c)) : [], 200),
  );
  app.delete("/api/telegram/links/:userId", async (c) => {
    if (tg?.gateway) await tg.gateway.unlink(owner(c), Number(c.req.param("userId")));
    return c.json({ ok: true }, 200);
  });
  app.post("/api/telegram/webhook", async (c) => {
    const secret = c.req.header("x-telegram-bot-api-secret-token") ?? "";
    const expected = tg?.webhookSecret ?? "";
    const gateway = tg?.gateway;
    if (
      !gateway ||
      !expected ||
      secret.length !== expected.length ||
      !timingSafeEqual(Buffer.from(secret), Buffer.from(expected))
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }
    // Answer Telegram at once; the agents may take minutes.
    void gateway
      .handleUpdate(await c.req.json())
      .catch((err) => console.error("telegram update:", err));
    return c.json({ ok: true }, 200);
  });

  // The other chat platforms (G29.5): pairing and linked accounts, as for Telegram.
  const platformOf = (c: Context<Env>) => {
    const p = c.req.param("platform") as (typeof PLATFORMS)[number];
    return PLATFORMS.includes(p) ? p : undefined;
  };
  app.post("/api/chats/:platform/pair", async (c) => {
    const p = platformOf(c);
    const bridge = p && options.chats?.get(p);
    if (!bridge) return c.json({ error: "This chat platform is not configured" }, 400);
    return c.json(bridge.pairingCode(owner(c)), 200);
  });
  app.get("/api/chats/:platform/links", async (c) => {
    const p = platformOf(c);
    const bridge = p && options.chats?.get(p);
    return c.json(bridge ? await bridge.links(owner(c)) : [], 200);
  });
  app.delete("/api/chats/:platform/links/:userId", async (c) => {
    const p = platformOf(c);
    const bridge = p && options.chats?.get(p);
    if (bridge) await bridge.unlink(owner(c), c.req.param("userId"));
    return c.json({ ok: true }, 200);
  });
  // WhatsApp's webhook: Meta checks it once with the verify token, then signs every delivery.
  app.get("/api/chats/whatsapp/webhook", (c) => {
    const challenge = options.chats?.whatsapp()?.verify(c.req.query());
    return challenge ? c.text(challenge, 200) : c.json({ error: "Forbidden" }, 403);
  });
  app.post("/api/chats/whatsapp/webhook", async (c) => {
    const wa = options.chats?.whatsapp();
    if (!wa) return c.json({ error: "Forbidden" }, 403);
    const ok = await wa.webhook(await c.req.text(), c.req.header("x-hub-signature-256"));
    return ok ? c.json({ ok: true }, 200) : c.json({ error: "Forbidden" }, 403);
  });

  // Teams (G36.9): Microsoft posts here, signed; the app package names the bot for Teams.
  app.post("/api/chats/teams/messages", async (c) => {
    const teams = options.chats?.teams();
    if (!teams) return c.json({ error: "Forbidden" }, 403);
    const r = await teams.webhook(await c.req.text(), c.req.header("authorization"));
    return r.body === undefined
      ? c.body(null, r.status as 200)
      : c.json(r.body as Record<string, unknown>, r.status as 200);
  });
  app.get("/api/chats/teams/app.zip", async (c) => {
    const appId = (await (setup as SetupService | undefined)?.chatSetting("teams", "appId")) ?? "";
    if (!appId) return c.json({ error: "Teams is not set up" }, 400);
    const host = (c.req.query("host") ?? "").replace(/[^a-z0-9.:-]/gi, "").split(":")[0];
    const zip = teamsAppPackage({ appId, ...(host && { host }) });
    return c.body(new Uint8Array(zip), 200, {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="redgiant-teams.zip"',
    });
  });

  // The platform (G14): how it runs, its changes, undo, the permission policy.
  app.get("/api/platform", async (c) => c.json(await core.platformInfo(), 200));
  // A voice message: the raw audio in, its text out (the client shows it before sending).
  app.post("/api/transcribe", async (c) => {
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.length > MAX_AUDIO_BYTES) return c.json({ error: "The recording is too long" }, 413);
    try {
      const text = await core.transcribe(
        audio,
        c.req.header("content-type") ?? "application/octet-stream",
        c.req.query("lang"),
      );
      return c.json({ text }, 200);
    } catch (err) {
      if (err instanceof TranscriptionError) return c.json({ error: err.message }, 502);
      throw err;
    }
  });
  app.get("/api/platform/changes", async (c) => c.json(await core.changes.list(owner(c)), 200));
  app.post("/api/platform/changes/:id/undo", async (c) => {
    try {
      return c.json(await core.config.undo(owner(c), "human", c.req.param("id")), 200);
    } catch (err) {
      if (err instanceof ConfigError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  // The human promotes a tested change (G24.10): the same checks as God's tool.
  app.post("/api/platform/changes/:id/promote", async (c) => {
    if (!core.code) return c.json({ error: "Code changes are not enabled" }, 400);
    try {
      return c.json({ commit: await core.code.promote(owner(c), "human", c.req.param("id")) }, 200);
    } catch (err) {
      if (err instanceof CodeChangeError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.post("/api/platform/changes/:id/discard", async (c) => {
    if (!core.code) return c.json({ error: "Code changes are not enabled" }, 400);
    try {
      return c.json(await core.code.discard(owner(c), "human", c.req.param("id")), 200);
    } catch (err) {
      if (err instanceof CodeChangeError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  // The tools page (G34.5): the common tools, their weight, and what the person switched off for
  // every agent or for one; new conversations get the new set. Essential tools refuse to go (400).
  app.get("/api/tools", async (c) =>
    c.json(await core.toolsView(owner(c), c.req.query("agentId") || undefined), 200),
  );
  app.put("/api/tools", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { off?: unknown } | null;
    if (!Array.isArray(body?.off) || !body.off.every((x) => typeof x === "string"))
      return c.json({ error: "off must be a list of tool ids" }, 400);
    try {
      return c.json(await core.setToolsOff(owner(c), body.off as string[]), 200);
    } catch (err) {
      if (err instanceof ConfigError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.put("/api/agents/:id/tools", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { tools?: unknown } | null;
    const tools = body?.tools;
    if (
      !tools ||
      typeof tools !== "object" ||
      !Object.values(tools).every((v) => v === "on" || v === "off" || v === "default")
    )
      return c.json({ error: 'tools: { <id>: "on" | "off" | "default" }' }, 400);
    try {
      return c.json(
        await core.setAgentTools(
          owner(c),
          c.req.param("id"),
          tools as Record<string, "on" | "off" | "default">,
        ),
        200,
      );
    } catch (err) {
      if (err instanceof ConfigError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.get("/api/platform/policy", async (c) => c.json(core.policies.get(owner(c)), 200));
  app.put("/api/platform/policy", async (c) => {
    const parsed = PlatformPolicy.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json(await core.config.setPolicy(owner(c), "human", parsed.data), 200);
  });

  // The daily chat (G16): ordinary history, outside the event log.
  const chatError = (err: unknown) => {
    if (err instanceof ChatError) return new NotFoundError(err.message);
    return err;
  };
  app.get("/api/chats", async (c) => c.json(await core.chat.list(owner(c)), 200));
  app.post("/api/chats", async (c) => c.json(await core.chat.create(owner(c)), 201));
  app.get("/api/chats/:id", async (c) => {
    try {
      return c.json(await core.chat.entries(owner(c), c.req.param("id")), 200);
    } catch (err) {
      throw chatError(err);
    }
  });
  app.patch("/api/chats/:id", async (c) => {
    const { title, folder } = (await c.req.json()) as { title?: string; folder?: string | null };
    if (folder !== undefined) {
      const f = typeof folder === "string" ? folder.trim().slice(0, 60) || null : null;
      await core.chat.setFolder(owner(c), c.req.param("id"), f).catch((e) => {
        throw chatError(e);
      });
      if (title === undefined) return c.json({ ok: true }, 200);
    }
    if (!title?.trim()) return c.json({ error: "title is required" }, 400);
    await core.chat.rename(owner(c), c.req.param("id"), title.trim().slice(0, 120)).catch((e) => {
      throw chatError(e);
    });
    return c.json({ ok: true }, 200);
  });
  app.delete("/api/chats/:id", async (c) => {
    await core.chat.remove(owner(c), c.req.param("id")).catch((e) => {
      throw chatError(e);
    });
    return c.json({ ok: true }, 200);
  });
  app.get("/api/chat/settings", async (c) => c.json(await core.chat.settings(owner(c)), 200));
  // The Chat's agent (2026-11-03): made on first use, its conversations are the chats.
  app.get("/api/chat/agent-id", async (c) =>
    c.json({ id: await core.chatAgentIdOf(owner(c)) }, 200),
  );
  app.get("/api/chat/agent", async (c) => {
    try {
      return c.json(agentOut(await core.chatAgent(owner(c))), 200);
    } catch (err) {
      if (err instanceof ChatError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.put("/api/chat/settings", async (c) => {
    const body = z
      .object({
        /** null: the default model again. */
        model: ModelSpec.nullable().optional(),
        systemPrompt: z.string().min(1).optional(),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    // One setting at a time: the others stay as they are.
    const { model: _old, ...kept } = await core.chat.settings(owner(c));
    const model = body.data.model === undefined ? _old : body.data.model;
    await core.chat.setSettings(owner(c), {
      ...kept,
      ...(model && { model }),
      ...(body.data.systemPrompt && { systemPrompt: body.data.systemPrompt }),
    });
    await core.syncChatAgent(owner(c));
    return c.json({ ok: true }, 200);
  });
  // A message: the answer streams back as server-sent events (delta, tool, entry, done, error).
  app.post("/api/chats/:id/messages", async (c) => {
    const body = z
      .object({
        text: z.string().min(1).max(100_000),
        attachments: z
          .array(
            z.union([
              z.object({ name: z.string().max(200), content: z.string().max(400_000) }),
              ImagePart,
            ]),
          )
          .max(10)
          .default([]),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const ownerId = owner(c);
    const chatId = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      try {
        await core.chat.send(
          ownerId,
          chatId,
          body.data.text,
          body.data.attachments,
          (e) => void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }),
          abort.signal,
        );
        await stream.writeSSE({ event: "done", data: "{}" });
      } catch (err) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: (err as Error).message }),
        });
      }
    });
  });

  // The project inspector (G18): its chats and its settings (alerts, daily summary, model).
  const inspectorScope = (c: Context<Env>) => ({
    kind: "inspector" as const,
    projectId: c.req.param("id") as string,
  });
  const knownProject = async (c: Context<Env>) => {
    if (!(await core.projects.get(owner(c), c.req.param("id") as string)))
      throw new NotFoundError(`Project "${c.req.param("id")}" not found`);
  };
  app.get("/api/projects/:id/inspector/chats", async (c) => {
    await knownProject(c);
    return c.json(await core.chat.list(owner(c), inspectorScope(c)), 200);
  });
  app.post("/api/projects/:id/inspector/chats", async (c) => {
    await knownProject(c);
    return c.json(await core.chat.create(owner(c), "New chat", inspectorScope(c)), 201);
  });
  app.get("/api/projects/:id/inspector/settings", async (c) => {
    await knownProject(c);
    return c.json(await core.inspector.settings(owner(c), c.req.param("id")), 200);
  });
  app.put("/api/projects/:id/inspector/settings", async (c) => {
    await knownProject(c);
    const b = z
      .object({
        model: ModelSpec.optional(),
        alerts: z.boolean().optional(),
        summaryHour: z.number().int().min(0).max(23).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: b.error.message }, 400);
    await core.inspector.setSettings(owner(c), c.req.param("id"), {
      ...(b.data.model && { model: b.data.model }),
      ...(b.data.alerts !== undefined && { alerts: b.data.alerts }),
      ...(b.data.summaryHour !== undefined && { summaryHour: b.data.summaryHour }),
    });
    return c.json({ ok: true }, 200);
  });

  // The setup wizard (G17).
  const setup = options.setup;
  const hf = options.hf;
  // The Windows engine keeps its models in a folder of Windows: each engine its own folder.
  const modelsFor = (variant: string | undefined) => (variant === "windows" ? options.winHf : hf);
  const wizard = async (c: Context<Env>, f: () => Promise<unknown>) => {
    if (!setup) return c.json({ error: "Setup is not available" }, 400);
    try {
      return c.json((await f()) ?? { ok: true }, 200);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      return c.json(
        { error: (err as Error).message, ...(typeof code === "string" && { code }) },
        400,
      );
    }
  };
  const parsed = async <T extends z.ZodType>(c: Context<Env>, schema: T): Promise<z.infer<T>> => {
    const r = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!r.success)
      throw new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  };
  const Engine = z.object({
    variant: z.enum(["cpu", "cuda", "vulkan", "windows"]),
    model: z.string().min(1),
    /** SSD stream (2026-11-03), and the share of the card given to the experts' cache. */
    stream: z.boolean().optional(),
    tuning: z
      .object({
        moeCacheShare: z.number().min(0).max(0.8).optional(),
        opOffload: z.boolean().optional(),
        /** Tokens a pass, a row of the bigger passes' tries (G32.1). */
        batch: z.number().int().min(512).max(16384).optional(),
      })
      .optional(),
    /** Bigger reading passes with SSD stream (G32.1, experimental). */
    bigChunks: z.boolean().optional(),
    /** The next layer's experts copied ahead, patched llama.cpp on Windows (G32.2, experimental). */
    moePrefetch: z.boolean().optional(),
    /** Speculative decoding (2026-11-04): a small model of the family, or the text written. */
    speculative: z.enum(["draft", "ngram"]).optional(),
    draftModel: z.string().min(1).optional(),
  });
  app.get("/api/setup", (c) => wizard(c, () => (setup as SetupService).state()));
  app.put("/api/setup/models", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveModels(
        await parsed(
          c,
          z.object({
            searxngUrl: z.url().nullable().optional(),
            search: z
              .object({
                provider: z.enum(SEARCH_PROVIDER_IDS),
                url: z.url().optional(),
                key: z.string().trim().min(8).max(500).optional(),
              })
              .nullable()
              .optional(),
            images: z
              .object({ key: z.string().min(10).optional(), model: z.string().min(1).optional() })
              .nullable()
              .optional(),
            transcription: z
              .object({
                // "local": whisper.cpp on this computer, no address (RedGiant 3.0).
                api: z.enum(["whisper-asr", "openai", "local"]),
                url: z.union([z.url(), z.literal("")]),
                model: z.string().min(1).optional(),
                key: z.string().optional(),
              })
              .nullable()
              .optional(),
            defaultModel: ModelSpec.optional(),
          }),
        ),
      ),
    ),
  );
  // A provider of the catalog with the user's key: checked, then kept (G24.2).
  app.put("/api/setup/keys/:id", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveKey(
        c.req.param("id"),
        (await parsed(c, z.object({ key: z.string().trim().min(8).max(500) }))).key,
      ),
    ),
  );
  app.delete("/api/setup/keys/:id", (c) =>
    wizard(c, async () => (setup as SetupService).saveKey(c.req.param("id"), null)),
  );
  // The user's own OpenAI-compatible server (Ollama, LM Studio, vLLM…).
  app.put("/api/setup/server", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveServer(
        await parsed(c, z.object({ baseUrl: z.url(), key: z.string().optional() })),
      ),
    ),
  );
  app.delete("/api/setup/server", (c) =>
    wizard(c, async () => (setup as SetupService).saveServer(null)),
  );
  // Standard or advanced; GitHub and Gitea (G24.5).
  app.put("/api/setup/mode", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveMode(
        (await parsed(c, z.object({ mode: z.enum(["standard", "advanced"]) }))).mode,
      ),
    ),
  );
  app.put("/api/setup/github", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveGithub(
        (await parsed(c, z.object({ token: z.string().trim().min(20).max(400) }))).token,
      ),
    ),
  );
  app.delete("/api/setup/github", (c) => wizard(c, () => (setup as SetupService).saveGithub(null)));
  app.post("/api/setup/gitea", (c) =>
    wizard(c, async () => {
      const b = await parsed(
        c,
        z.object({
          user: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,38}$/),
          password: z.string().min(10).max(200),
        }),
      );
      return (setup as SetupService).startGitea(b.user, b.password);
    }),
  );
  app.delete("/api/setup/gitea", (c) => wizard(c, () => (setup as SetupService).stopGitea()));
  // Who makes pictures, videos and sounds (G25.3), their keys and the voices for speech.
  app.put("/api/setup/media/:kind", (c) =>
    wizard(c, async () => {
      const kind = z.enum(MEDIA_KINDS).parse(c.req.param("kind"));
      const b = await parsed(
        c,
        z.object({
          choice: z
            .object({
              provider: z.string().min(1),
              model: z.string().min(1).max(120),
              voice: z.string().max(120).optional(),
            })
            .nullable(),
        }),
      );
      const ch = b.choice;
      await (setup as SetupService).saveMedia(
        kind,
        ch && { provider: ch.provider, model: ch.model, ...(ch.voice && { voice: ch.voice }) },
      );
    }),
  );
  app.put("/api/setup/media-keys/:provider", (c) =>
    wizard(c, async () => {
      const b = await parsed(c, z.object({ key: z.string().min(8).max(500).nullable() }));
      await (setup as SetupService).saveMediaKey(c.req.param("provider"), b.key);
    }),
  );
  app.get("/api/setup/media/voices", (c) =>
    wizard(c, () => (setup as SetupService).mediaVoices(c.req.query("provider") ?? "")),
  );
  // Pi-hole, the home's own DNS, by choice (G24.14c).
  // «Look for updates» (2026-11-04).
  app.post("/api/update/check", (c) =>
    wizard(c, async () => {
      // The signed kind of the release (G36.19) comes with the answer: the page opens its window.
      const gate = await core.updates?.check();
      return {
        ...(await (setup as SetupService).checkUpdates()),
        ...(gate && { gate: gate.gate }),
      };
    }),
  );
  // The models moved to another SSD (Windows, 2026-11-03).
  app.post("/api/setup/models-disk", (c) =>
    wizard(c, async () => {
      const b = await parsed(
        c,
        z.object({
          drive: z.string().regex(/^[A-Za-z]$/),
          kind: z.literal("models").default("models"),
          // A folder of that disk (2026-11-06); absent: <drive>:\\RedGiant\\models.
          folder: z.string().min(3).max(240).optional(),
        }),
      );
      return (setup as SetupService).startModelsMove(b.drive, b.kind, b.folder);
    }),
  );
  // RedGiant's own search engine (SearXNG, 2026-11-03).
  // A web search service tried before it is saved (2026-11-03).
  app.post("/api/setup/search/try", (c) =>
    wizard(c, async () => {
      const b = await parsed(
        c,
        z.object({
          provider: z.enum(SEARCH_PROVIDER_IDS),
          url: z.string().url().optional(),
          key: z.string().min(1).max(500).optional(),
        }),
      );
      return (setup as SetupService).tryWebSearch({
        provider: b.provider,
        ...(b.url && { url: b.url }),
        ...(b.key && { key: b.key }),
      });
    }),
  );
  app.post("/api/setup/searxng", (c) =>
    wizard(c, async () => (setup as SetupService).startSearch()),
  );
  app.delete("/api/setup/searxng", (c) => wizard(c, () => (setup as SetupService).stopSearch()));
  app.post("/api/setup/pihole", (c) =>
    wizard(c, async () => {
      const b = await parsed(
        c,
        z.object({
          lanIp: z.ipv4(),
          domain: z
            .string()
            .regex(/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i)
            .optional(),
        }),
      );
      return (setup as SetupService).startPihole(b.lanIp, b.domain);
    }),
  );
  app.delete("/api/setup/pihole", (c) => wizard(c, () => (setup as SetupService).stopPihole()));
  app.get("/api/setup/pihole/password", (c) =>
    wizard(c, async () => ({ password: (setup as SetupService).piholePassword() })),
  );
  // The canvas (G25.1): signed links to what agents show, and when it last changed.
  app.post("/api/canvas/link", async (c) => {
    const body = z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("file"), scope: z.string(), path: z.string() }),
        z.object({
          kind: z.literal("port"),
          agentId: z.string(),
          port: z.number().int().min(1).max(65535),
          path: z.string().optional(),
        }),
      ])
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    return c.json(await core.canvasLink(owner(c), body.data), 200);
  });
  app.get("/api/canvas/version", async (c) => {
    const scope = c.req.query("scope");
    const path = c.req.query("path");
    if (!scope || path === undefined) return c.json({ error: "scope and path are needed" }, 400);
    const fileOnly = c.req.query("only") === "file";
    return c.json({ version: await core.canvasVersion(owner(c), scope, path, fileOnly) }, 200);
  });
  // A board's answer (G25.4): the person chose a variant or commented on one.
  app.post("/api/sessions/:id/variants", async (c) => {
    const body = z
      .object({
        proposalId: z.string().regex(/^[0-9a-f]{12}$/),
        variant: z.number().int().min(1).max(8).nullable(),
        choice: z.boolean().default(false),
        comment: z.string().max(4000).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    await core.answerVariants(owner(c), c.req.param("id"), body.data);
    return c.json({ ok: true }, 200);
  });
  app.get("/api/sessions/:id/variants/:proposal/link", async (c) =>
    c.json(await core.boardLink(owner(c), c.req.param("id"), c.req.param("proposal")), 200),
  );
  // Artifacts and widgets (3.5.9): a widget's signed link, «Tienilo», «Fanne un progetto», errors.
  const WidgetParams = z.object({
    seq: z.coerce.number().int().nonnegative(),
    index: z.coerce.number().int().min(0).max(50),
  });
  app.get("/api/sessions/:id/widgets/:seq/:index/link", async (c) => {
    const p = WidgetParams.safeParse({ seq: c.req.param("seq"), index: c.req.param("index") });
    if (!p.success) return c.json({ error: p.error.message }, 400);
    return c.json(
      await core.widgetLink(owner(c), { sessionId: c.req.param("id"), ...p.data }),
      200,
    );
  });
  app.post("/api/sessions/:id/widgets/:seq/:index/keep", async (c) => {
    const p = WidgetParams.safeParse({ seq: c.req.param("seq"), index: c.req.param("index") });
    if (!p.success) return c.json({ error: p.error.message }, 400);
    return c.json(
      await core.keepWidget(owner(c), { sessionId: c.req.param("id"), ...p.data }),
      200,
    );
  });
  app.post("/api/artifacts/project", async (c) => {
    const b = z
      .object({
        scope: z.string().min(1),
        path: z.string().min(1),
        sessionId: z.string().optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: b.error.message }, 400);
    return c.json(
      await core.artifactToProject(
        owner(c),
        { scope: b.data.scope, path: b.data.path },
        b.data.sessionId,
      ),
      200,
    );
  });
  app.post("/api/artifacts/errors", async (c) => {
    const b = z
      .object({
        ref: ArtifactRef,
        sessionId: z.string().max(80).optional(),
        errors: z.array(ArtifactError).max(20),
        /** The frame loaded again: what it said before is forgotten. */
        fresh: z.boolean().optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: b.error.message }, 400);
    if (b.data.fresh) core.artifactReloaded(owner(c), b.data.ref);
    const added = b.data.errors.length
      ? await core.reportArtifactErrors(owner(c), b.data.ref, b.data.errors, b.data.sessionId)
      : 0;
    return c.json({ added }, 200);
  });
  // The preview itself: the signed link is the credential, so no bearer token here.
  app.all("/preview/:token/*", async (c) => {
    const token = c.req.param("token");
    const found = core.previews.verify(token);
    if (!found)
      return c.text("This link has expired: open it again from the canvas.", 403, PREVIEW_HEADERS);
    const prefix = `/preview/${token}`;
    const rest = c.req.path.slice(prefix.length + 1);
    const t = found.target;
    if (t.kind === "port") return bridge(t, rest, c.req.raw, prefix);
    if (c.req.method !== "GET" && c.req.method !== "HEAD")
      return c.text("A folder preview only reads", 405, PREVIEW_HEADERS);
    const origins = previewOrigins(c.req.raw);
    // Artifacts and widgets (3.5.9): the page, and RedGiant's libraries under lib/; nothing else.
    if (t.kind === "artifact" || t.kind === "widget") {
      if (rest.startsWith("lib/")) {
        const lib = await serveLib(rest.slice(4)).catch(() => undefined);
        if (!lib) return c.text("Not found", 404, PREVIEW_HEADERS);
        return c.body(lib.body as never, 200, { ...LIB_HEADERS, "Content-Type": lib.type });
      }
      const entry = t.kind === "artifact" ? basename(t.path) : "widget.html";
      if (decodeURIComponent(rest) !== entry)
        return c.text("Outside the preview", 403, PREVIEW_HEADERS);
      if (c.req.header("sec-fetch-dest") === "document") {
        const url = new URL(c.req.url);
        const w = previewWrapper(
          `${url.pathname}${url.search}`,
          origins,
          prefix,
          /^it\b/i.test(c.req.header("accept-language") ?? ""),
          ARTIFACT_SANDBOX,
        );
        return c.body(w.body, 200, w.headers);
      }
      let page: string;
      try {
        page =
          t.kind === "artifact"
            ? await artifactPage(await readFile(t.path, "utf8"), prefix)
            : await widgetPage(await core.widgetHtml(found.ownerId, t), prefix);
      } catch {
        return c.text("Not found", 404, PREVIEW_HEADERS);
      }
      return c.body(page, 200, {
        ...artifactHeaders(origins, prefix),
        "Content-Type": "text/html; charset=utf-8",
      });
    }
    // One file shown from outside every workspace (G34.1): that file, nothing around it.
    let f =
      t.kind === "file"
        ? decodeURIComponent(rest) === basename(t.path)
          ? await serveRaw(t.path, c.req.header("range"))
          : { status: 403, body: "Outside the preview", type: "text/plain" }
        : await serveFile(t.root, rest, prefix, c.req.header("range"));
    // One file is served as it is: an HTML page still gets the preview's script (links, paths).
    if (t.kind === "file" && f.status === 200 && f.type.startsWith("text/html")) {
      if (f.body instanceof ReadableStream) await f.body.cancel();
      const text = await readFile(t.path, "utf8");
      f = { status: 200, body: rewrite(text, f.type, prefix, true), type: f.type };
    }
    // A page opened on its own in a tab is framed by RedGiant, as in the canvas (3.5.8).
    if (
      f.status === 200 &&
      f.type.startsWith("text/html") &&
      c.req.header("sec-fetch-dest") === "document"
    ) {
      const url = new URL(c.req.url);
      const w = previewWrapper(
        `${url.pathname}${url.search}`,
        origins,
        prefix,
        /^it\b/i.test(c.req.header("accept-language") ?? ""),
      );
      return c.body(w.body, 200, w.headers);
    }
    return c.body(f.body as never, f.status as 200, {
      ...previewHeaders("files", origins, prefix, f.type),
      ...f.headers,
      "Content-Type": f.type,
    });
  });
  // Undo a summary asked by hand (G24.14): the whole history comes back from the log.
  // The conversation an agent works in for the chats (Telegram, Discord…): the web and the CLI
  // open the same one, so a talk begun on a phone goes on here (2026-11-05).
  app.post("/api/agents/:id/work-session", async (c) => {
    const agent = core.registry.get(c.req.param("id"));
    if (!agent || agent.ownerId !== owner(c)) return c.json({ error: "Agent not found" }, 404);
    return c.json({ sessionId: await core.workSession(agent) }, 200);
  });
  // Every agent's notes (2026-11-05), read and written by the person through the same queue and
  // limit as the agents' memory tool.
  const NotesQuery = z.object({
    scope: z.enum(["user", "self", "project"]),
    agentId: z.string().optional(),
    projectId: z.string().optional(),
  });
  const notesWho = (c: Context<Env>) => {
    const q = NotesQuery.safeParse(c.req.query());
    if (!q.success) return undefined;
    return {
      scope: q.data.scope,
      who: { ownerId: owner(c), agentId: q.data.agentId ?? "-", projectId: q.data.projectId },
    };
  };
  app.get("/api/notes", async (c) => {
    const n = notesWho(c);
    if (!n) return c.json({ error: "scope is user, self or project" }, 400);
    return c.json({ text: await core.notes.read(n.who, n.scope) }, 200);
  });
  app.put("/api/notes", async (c) => {
    const n = notesWho(c);
    if (!n) return c.json({ error: "scope is user, self or project" }, 400);
    const b = await c.req
      .json()
      .then((x) => z.object({ text: z.string() }).parse(x))
      .catch(() => undefined);
    if (!b) return c.json({ error: "text is required" }, 400);
    try {
      await core.notes.set(n.who, n.scope, b.text);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ ok: true }, 200);
  });
  // The keychain (G33.4): the person's credentials, which agents use by name without seeing them.
  // A value comes back only through «Show» (the person's own request); nothing here logs a body.
  const vaultFailed = (c: Context<Env>, err: unknown) => {
    if (err instanceof VaultError) return c.json({ error: err.message, code: err.code }, 400);
    if (err instanceof z.ZodError)
      return c.json(
        { error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        400,
      );
    throw err;
  };
  const vaultBody = async <T extends z.ZodTypeAny>(c: Context<Env>, schema: T) =>
    schema.parse(await c.req.json().catch(() => ({}))) as z.output<T>;
  app.get("/api/vault", async (c) => c.json(await core.vault.view(owner(c)), 200));
  app.post("/api/vault", async (c) => {
    try {
      return c.json(await core.vault.put(owner(c), await c.req.json().catch(() => ({}))), 200);
    } catch (err) {
      return vaultFailed(c, err);
    }
  });
  app.put("/api/vault/:id", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      return c.json(await core.vault.put(owner(c), body, c.req.param("id")), 200);
    } catch (err) {
      return vaultFailed(c, err);
    }
  });
  app.delete("/api/vault/:id", async (c) => {
    try {
      await core.vault.remove(owner(c), c.req.param("id"));
      return c.json({ ok: true }, 200);
    } catch (err) {
      return vaultFailed(c, err);
    }
  });
  app.post("/api/vault/:id/reveal", (c) => {
    try {
      c.header("cache-control", "no-store");
      return c.json({ value: core.vault.reveal(owner(c), c.req.param("id")) }, 200);
    } catch (err) {
      return vaultFailed(c, err);
    }
  });
  app.post("/api/vault-import/preview", async (c) => {
    try {
      const b = await vaultBody(c, z.object({ csv: z.string().min(1).max(20_000_000) }));
      return c.json(core.vault.previewImport(owner(c), b.csv), 200);
    } catch (err) {
      return vaultFailed(c, err);
    }
  });
  app.post("/api/vault-import/confirm", async (c) => {
    try {
      const b = await vaultBody(
        c,
        z.object({ id: z.string(), keep: z.array(z.number().int().min(0)).max(10_000) }),
      );
      return c.json({ added: await core.vault.confirmImport(owner(c), b.id, b.keep) }, 200);
    } catch (err) {
      return vaultFailed(c, err);
    }
  });
  app.post("/api/vault-export", async (c) => {
    try {
      const b = await vaultBody(c, z.object({ passphrase: z.string().max(500) }));
      c.header("cache-control", "no-store");
      return c.json({ file: core.vault.exportSealed(owner(c), b.passphrase) }, 200);
    } catch (err) {
      return vaultFailed(c, err);
    }
  });
  app.post("/api/vault-import/sealed", async (c) => {
    try {
      const b = await vaultBody(
        c,
        z.object({ file: z.string().min(1).max(50_000_000), passphrase: z.string().max(500) }),
      );
      return c.json({ added: await core.vault.importSealed(owner(c), b.file, b.passphrase) }, 200);
    } catch (err) {
      return vaultFailed(c, err);
    }
  });
  // The shared memory (G33.2): what every agent knows about the person. The person sees, adds,
  // edits, removes and undoes each memory, and turns the learning from the conversations on or off.
  const memoryFailed = (c: Context<Env>, err: unknown) => {
    if (err instanceof MemoryError) return c.json({ error: err.message, code: err.code }, 400);
    throw err;
  };
  const MemoryText = z.object({
    text: z
      .string()
      .min(1)
      .max(MEMORY_ENTRY_LIMIT * 2),
  });
  const byPerson = { by: "human" } as const;
  app.get("/api/memory", async (c) => c.json(await core.sharedMemoryView(owner(c)), 200));
  app.post("/api/memory", async (c) => {
    const b = MemoryText.safeParse(await c.req.json().catch(() => undefined));
    if (!b.success) return c.json({ error: "text is required" }, 400);
    try {
      const r = await core.sharedMemory.add(owner(c), b.data.text, byPerson);
      return c.json(r, 200);
    } catch (err) {
      return memoryFailed(c, err);
    }
  });
  app.put("/api/memory/settings", async (c) => {
    const b = z.object({ auto: z.boolean() }).safeParse(await c.req.json().catch(() => undefined));
    if (!b.success) return c.json({ error: "auto is required" }, 400);
    await core.sharedMemory.setAuto(owner(c), b.data.auto, "human");
    return c.json({ ok: true }, 200);
  });
  app.post("/api/memory/undo", async (c) => {
    const b = z
      .object({ seq: z.number().int() })
      .safeParse(await c.req.json().catch(() => undefined));
    if (!b.success) return c.json({ error: "seq is required" }, 400);
    try {
      await core.sharedMemory.undo(owner(c), b.data.seq, byPerson);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return memoryFailed(c, err);
    }
  });
  app.put("/api/memory/:id", async (c) => {
    const b = MemoryText.safeParse(await c.req.json().catch(() => undefined));
    if (!b.success) return c.json({ error: "text is required" }, 400);
    try {
      return c.json(
        await core.sharedMemory.edit(owner(c), c.req.param("id"), b.data.text, byPerson),
        200,
      );
    } catch (err) {
      return memoryFailed(c, err);
    }
  });
  // Forgotten for good: the memory and its text in every past event (not undoable).
  app.post("/api/memory/:id/forget", async (c) => {
    try {
      await core.sharedMemory.forget(owner(c), c.req.param("id"), byPerson);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return memoryFailed(c, err);
    }
  });
  app.delete("/api/memory/:id", async (c) => {
    try {
      await core.sharedMemory.remove(owner(c), c.req.param("id"), byPerson);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return memoryFailed(c, err);
    }
  });
  // A new conversation that goes on from this one (G36.23): «Continua da qui» from a message
  // (`fromSeq`), or before a message to send it edited (`beforeSeq`, 2026-11-05).
  app.post("/api/sessions/:id/fork", async (c) => {
    const body = await c.req
      .json()
      .then((b) =>
        z
          .union([
            z.object({ fromSeq: z.number().int().nonnegative() }),
            z.object({ beforeSeq: z.number().int().positive() }),
          ])
          .parse(b),
      )
      .catch(() => undefined);
    if (!body) return c.json({ error: "fromSeq or beforeSeq is required" }, 400);
    const sessionId = await core.forkSession(owner(c), c.req.param("id"), body);
    return c.json({ sessionId }, 201);
  });
  // «Intanto» (G36.24): a side question, answered with the conversation's prefix and never part
  // of it; also while the agent works.
  app.post("/api/sessions/:id/aside", async (c) => {
    const body = await c.req
      .json()
      .then((b) => z.object({ question: z.string().trim().min(1).max(20_000) }).parse(b))
      .catch(() => undefined);
    if (!body) return c.json({ error: "question is required" }, 400);
    const aside = await core.aside(owner(c), c.req.param("id"), body.question);
    return c.json({ aside }, 201);
  });
  // «Porta nella chat»: the side question and its answer become a normal exchange.
  app.post("/api/sessions/:id/asides/:aside/chat", async (c) => {
    await core.promoteAside(owner(c), c.req.param("id"), c.req.param("aside"));
    return c.json({ ok: true }, 200);
  });
  // A background command's log (p3.3.1): every line with its time and stream; the last 2000, or
  // from a line on (the page follows a running one).
  app.get("/api/sessions/:id/commands/:cmd/output", async (c) => {
    const from = Number(c.req.query("from"));
    const r = await core.commandOutput(owner(c), c.req.param("id"), c.req.param("cmd"), {
      ...(Number.isInteger(from) && from > 0 && { from }),
    });
    return c.json(r, 200);
  });
  app.post("/api/sessions/:id/compaction/undo", async (c) => {
    try {
      const ok = await core.undoCompaction(owner(c), c.req.param("id"));
      return ok
        ? c.json({ ok: true }, 200)
        : c.json({ error: "Only the last summary asked by hand, with nothing said since" }, 400);
    } catch (err) {
      if (err instanceof SessionBusyError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });
  // Subprojects (G24.13): parts of a project, each in its own folder.
  app.get("/api/projects/:id/subprojects", async (c) =>
    c.json(await core.projects.subprojects(owner(c), c.req.param("id")), 200),
  );
  app.post("/api/projects/:id/subprojects", async (c) => {
    const b = z
      .object({ name: z.string().min(1).max(80), dir: z.string().max(200).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "A name is needed" }, 400);
    try {
      return c.json(
        await core.projects.createSubproject(owner(c), c.req.param("id"), b.data.name, b.data.dir),
        201,
      );
    } catch (err) {
      if (err instanceof SubprojectError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  // Archiving a whole project (2026-11-09): who is working there now (the page says it first),
  // then archive or restore, recorded in the history and undoable like God's changes.
  app.get("/api/projects/:id/work", async (c) =>
    c.json(await core.projectWork(owner(c), c.req.param("id")), 200),
  );
  app.get("/api/projects/:id/tasks", async (c) =>
    c.json(await core.projectTasks(owner(c), c.req.param("id")), 200),
  );
  for (const [path, archived] of [
    ["archive", true],
    ["restore", false],
  ] as const)
    app.post(`/api/projects/:id/${path}`, async (c) => {
      try {
        return c.json(
          await core.config.project(owner(c), "human", c.req.param("id"), archived),
          200,
        );
      } catch (err) {
        if (err instanceof ConfigError) return c.json({ error: err.message }, 400);
        throw err;
      }
    });
  // An existing project becomes a subproject of this one (G24.14c), with its history.
  app.post("/api/projects/:id/adopt", async (c) => {
    const b = z
      .object({
        project: z.string().min(1),
        name: z.string().max(80).optional(),
        dir: z.string().max(200).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "The project to bring in is needed" }, 400);
    try {
      const sub = await core.adoptProject(owner(c), c.req.param("id"), b.data.project, {
        ...(b.data.name && { name: b.data.name }),
        ...(b.data.dir && { dir: b.data.dir }),
      });
      return c.json(sub, 201);
    } catch (err) {
      if (err instanceof SubprojectError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  // A subproject's own sandbox image, or the project's again (G24.14c).
  app.patch("/api/projects/:id/subprojects/:sub", async (c) => {
    const b = z
      .object({ image: z.string().max(300).nullable() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "image (or null) is needed" }, 400);
    const sub = await core.projects.subproject(owner(c), c.req.param("sub"));
    if (!sub || sub.projectId !== c.req.param("id"))
      return c.json({ error: "Subproject not found" }, 404);
    try {
      await core.projects.setSubprojectImage(owner(c), sub.id, b.data.image?.trim() || null);
      return c.json({ ok: true }, 200);
    } catch (err) {
      if (err instanceof SubprojectError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  // Group chats (G24.12): the person and 1–6 agents.
  const room = async <T>(c: Context<Env>, f: () => Promise<T>) => {
    try {
      return c.json((await f()) as object, 200);
    } catch (err) {
      if (err instanceof RoomError) return c.json({ error: err.message }, 400);
      throw err;
    }
  };
  // "inspector:<project>" is a project's inspector, made on first use.
  const memberId = async (c: Context<Env>, id: string) => {
    const project = id.match(/^inspector:(.+)$/)?.[1];
    return project ? (await core.inspectorAgent(owner(c), project)).id : id;
  };
  app.get("/api/rooms", (c) => room(c, () => core.rooms.list(owner(c))));
  app.post("/api/rooms", async (c) => {
    const b = z
      .object({
        title: z.string().max(120).optional(),
        members: z.array(z.string()).default([]),
        from: z.object({ agentId: z.string(), sessionId: z.string() }).optional(),
        context: z.string().max(60_000).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "members (agent ids) are needed" }, 400);
    const input = b.data;
    if (input.from) {
      const rows = await core.listSessions(owner(c), input.from.agentId);
      if (!rows.some((r) => r.id === input.from?.sessionId))
        return c.json({ error: "Conversation not found" }, 404);
    }
    return room(c, async () =>
      core.rooms.create(owner(c), {
        members: await Promise.all(input.members.map((m) => memberId(c, m))),
        ...(input.title && { title: input.title }),
        ...(input.from && { from: input.from }),
        ...(input.context && { context: input.context }),
      }),
    );
  });
  app.get("/api/rooms/:id/events", (c) =>
    room(c, () => core.rooms.events(owner(c), c.req.param("id"))),
  );
  app.post("/api/rooms/:id/members", async (c) => {
    const b = z.object({ agentId: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "agentId is needed" }, 400);
    return room(c, async () =>
      core.rooms.add(owner(c), c.req.param("id"), await memberId(c, b.data.agentId)),
    );
  });
  app.delete("/api/rooms/:id/members/:agentId", (c) =>
    room(c, () => core.rooms.remove(owner(c), c.req.param("id"), c.req.param("agentId"))),
  );
  app.post("/api/rooms/:id/messages", async (c) => {
    const b = z
      .object({
        text: z.string().min(1).max(100_000),
        images: z.array(ImagePart).max(10).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "text is needed" }, 400);
    try {
      // Answers come later, through the log ("room.changed"): never wait for the whole round.
      await core.rooms.post(owner(c), c.req.param("id"), b.data.text, b.data.images ?? []);
      return c.json({ ok: true }, 202);
    } catch (err) {
      if (err instanceof RoomError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  // Sharing skills: a skill's folder as a .zip (the agentskills.io layout), and back. The
  // scope is the one /api/extensions/installed lists: "platform" or "project:<id>".
  const skillRoot = async (c: Context<Env>, scope: string | undefined) => {
    if (!scope || scope === "platform") return core.platformPath(owner(c));
    const id = scope.startsWith("project:") ? scope.slice("project:".length) : scope;
    const p = await core.projects.get(owner(c), id);
    return p ? join(p.path, ".redgiant") : undefined;
  };
  app.get("/api/extensions/skills/:name/export", async (c) => {
    const name = c.req.param("name");
    const root = await skillRoot(c, c.req.query("scope"));
    if (!root) return c.json({ error: "Project not found" }, 404);
    if (!SKILL_NAME_RE.test(name)) return c.json({ error: "Invalid skill name" }, 400);
    const dir = join(root, "skills", name);
    if (!(await stat(join(dir, "SKILL.md")).catch(() => undefined)))
      return c.json({ error: `No skill "${name}"` }, 404);
    try {
      const zip = await exportSkill(dir);
      return new Response(new Uint8Array(zip), {
        headers: {
          "content-type": "application/zip",
          "content-length": String(zip.length),
          "content-disposition": `attachment; filename="${name}.zip"`,
        },
      });
    } catch (err) {
      if (err instanceof SkillArchiveError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  /** The archive is the raw body; `?scope=` as above, `?replace=1` to overwrite a skill. */
  app.post("/api/extensions/skills/import", async (c) => {
    const root = await skillRoot(c, c.req.query("scope"));
    if (!root) return c.json({ error: "Project not found" }, 404);
    const tooLarge = { error: "The archive is too large" };
    if (Number(c.req.header("content-length") ?? 0) > SKILL_ARCHIVE_LIMITS.archiveBytes)
      return c.json(tooLarge, 413);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.length > SKILL_ARCHIVE_LIMITS.archiveBytes) return c.json(tooLarge, 413);
    try {
      const r = await importSkill(body, root, { replace: c.req.query("replace") === "1" });
      return c.json({ name: r.name, description: r.description, replaced: r.replaced }, 201);
    } catch (err) {
      if (err instanceof SkillExistsError) return c.json({ error: err.message }, 409);
      if (err instanceof SkillArchiveError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  // MCP servers that sign in with OAuth (G24.9): the service's page, then back here.
  app.get("/api/extensions/mcp/status", async (c) => c.json(await core.mcpStatus(owner(c)), 200));
  app.post("/api/extensions/mcp/:name/login", async (c) => {
    const b = z.object({ origin: z.url() }).safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "RedGiant's address (origin) is needed" }, 400);
    return c.json(await core.startMcpAuth(owner(c), c.req.param("name"), b.data.origin), 200);
  });
  app.get("/api/extensions/oauth/callback", async (c) => {
    const page = (title: string, text: string, ok: boolean) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RedGiant</title>` +
          `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
          `<h2 style="color:${ok ? "#2e9d5b" : "#d23d3d"}">${title}</h2><p>${text}</p>` +
          `<script>setTimeout(()=>window.close(),${ok ? 1500 : 60000})</script></body>`,
        ok ? 200 : 400,
      );
    const code = c.req.query("code");
    const state = c.req.query("state");
    const it = core.uiLanguageOf(LOCAL_OWNER_ID) === "it";
    if (!code || !state)
      return page(
        it ? "Collegamento non riuscito" : "Sign-in failed",
        escapeHtml(c.req.query("error_description") ?? c.req.query("error") ?? "No code"),
        false,
      );
    try {
      const r = await core.finishMcpAuth(state, code);
      return page(
        it ? "Collegato" : "Connected",
        it
          ? `${escapeHtml(r.name)} è collegato a RedGiant (${r.tools} strumenti). Puoi chiudere questa scheda.`
          : `${escapeHtml(r.name)} is connected to RedGiant (${r.tools} tools). You can close this tab.`,
        true,
      );
    } catch (err) {
      return page(
        it ? "Collegamento non riuscito" : "Sign-in failed",
        escapeHtml((err as Error).message),
        false,
      );
    }
  });
  app.post("/api/setup/git/sync", (c) => wizard(c, () => (setup as SetupService).gitSync()));
  // The mailbox for email routines (G24.14c): the password is never sent back.
  app.get("/api/settings/email", async (c) => {
    const a = await core.email.account(owner(c));
    return c.json(
      a
        ? { configured: true, host: a.host, port: a.port, secure: a.secure, user: a.user }
        : { configured: false },
      200,
    );
  });
  app.put("/api/settings/email", async (c) => {
    const b = z
      .object({
        host: z.string().min(1).max(200),
        port: z.number().int().min(1).max(65535).default(993),
        secure: z.boolean().default(true),
        user: z.string().min(1).max(320),
        password: z.string().min(1).max(500),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "Server, user and password are needed" }, 400);
    try {
      await core.setEmail(owner(c), b.data);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return c.json(
        { error: `The mailbox did not answer: ${(err as Error).message}`, code: "email_failed" },
        400,
      );
    }
  });
  app.delete("/api/settings/email", async (c) => {
    await core.email.remove(owner(c));
    return c.json({ ok: true }, 200);
  });
  // The person's machines over SSH (G38.2). Keys, passphrases and passwords go straight to the
  // keychain and are never sent back; the page gets the public key and the fingerprints.
  const machineError = (c: Context, err: unknown) => {
    if (!(err instanceof MachineError)) throw err;
    const status = err.code === "not-found" ? 404 : err.code === "vault" ? 409 : 400;
    return c.json(
      { error: err.message, code: err.code, ...(err.hostKey && { hostKey: err.hostKey }) },
      status,
    );
  };
  app.get("/api/settings/machines", async (c) =>
    c.json({ machines: await core.machines.list(owner(c)) }, 200),
  );
  app.post("/api/settings/machines", async (c) => {
    const b = MachineBody.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success)
      return c.json(
        {
          error: `A name, the host and the user are needed (${b.error.issues[0]?.path.join(".")})`,
        },
        400,
      );
    try {
      return c.json(await core.machines.add(owner(c), b.data), 201);
    } catch (err) {
      return machineError(c, err);
    }
  });
  const MachinePatchBody = z.object({
    name: z.string().optional(),
    host: z.string().optional(),
    port: z.number().int().optional(),
    user: z.string().optional(),
    folder: z.string().max(1000).nullable().optional(),
    access: MachineAccess.optional(),
    password: z.string().max(500).nullable().optional(),
    privateKey: z.string().max(20_000).optional(),
    passphrase: z.string().max(500).nullable().optional(),
    newKey: z.boolean().optional(),
  });
  app.put("/api/settings/machines/:id", async (c) => {
    const b = MachinePatchBody.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: b.error.issues[0]?.message ?? "Bad machine" }, 400);
    const patch = Object.fromEntries(
      Object.entries(b.data).filter(([, v]) => v !== undefined),
    ) as MachinePatch;
    try {
      return c.json(await core.machines.update(owner(c), c.req.param("id"), patch), 200);
    } catch (err) {
      if (err instanceof z.ZodError)
        return c.json({ error: err.issues[0]?.message ?? "Bad machine" }, 400);
      return machineError(c, err);
    }
  });
  app.delete("/api/settings/machines/:id", async (c) => {
    try {
      await core.machines.remove(owner(c), c.req.param("id"));
      return c.json({ ok: true }, 200);
    } catch (err) {
      return machineError(c, err);
    }
  });
  app.post("/api/settings/machines/:id/test", async (c) => {
    try {
      return c.json(await core.machines.test(owner(c), c.req.param("id")), 200);
    } catch (err) {
      return machineError(c, err);
    }
  });
  app.post("/api/settings/machines/:id/trust", async (c) => {
    const b = z
      .object({ fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{20,}$/) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "The fingerprint the person saw is needed" }, 400);
    try {
      return c.json(
        await core.machines.trust(owner(c), c.req.param("id"), b.data.fingerprint),
        200,
      );
    } catch (err) {
      return machineError(c, err);
    }
  });
  // Many mailboxes, each with its name and category (G33.3); passwords are never sent back.
  const MailboxBody = z.object({
    name: z.string().max(80).default(""),
    category: z.string().max(40).default("other"),
    host: z.string().min(1).max(200),
    port: z.number().int().min(1).max(65535).default(993),
    secure: z.boolean().default(true),
    user: z.string().min(1).max(320),
    password: z.string().min(1).max(500),
    smtp: z
      .object({
        host: z.string().min(1).max(200),
        port: z.number().int().min(1).max(65535),
        secure: z.boolean(),
      })
      .optional(),
  });
  app.get("/api/settings/mailboxes", async (c) =>
    c.json(
      {
        boxes: await core.email.boxes(owner(c)),
        categories: await core.email.categories(owner(c)),
      },
      200,
    ),
  );
  app.post("/api/settings/mailboxes", async (c) => {
    const b = MailboxBody.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "Server, user and password are needed" }, 400);
    try {
      const { smtp, ...rest } = b.data;
      return c.json(await core.addMailbox(owner(c), { ...rest, ...(smtp && { smtp }) }), 201);
    } catch (err) {
      return c.json(
        { error: `The mailbox did not answer: ${(err as Error).message}`, code: "email_failed" },
        400,
      );
    }
  });
  app.put("/api/settings/mailboxes/:id", async (c) => {
    const b = MailboxBody.partial()
      .extend({ smtp: MailboxBody.shape.smtp.unwrap().nullable().optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: b.error.issues[0]?.message ?? "Bad mailbox" }, 400);
    const patch = Object.fromEntries(
      Object.entries(b.data).filter(([, v]) => v !== undefined),
    ) as Parameters<typeof core.updateMailbox>[2];
    try {
      return c.json(await core.updateMailbox(owner(c), c.req.param("id"), patch), 200);
    } catch (err) {
      if (err instanceof MailboxNotFoundError) throw err;
      return c.json(
        { error: `The mailbox did not answer: ${(err as Error).message}`, code: "email_failed" },
        400,
      );
    }
  });
  app.delete("/api/settings/mailboxes/:id", async (c) => {
    await core.email.removeBox(owner(c), c.req.param("id"));
    return c.json({ ok: true }, 200);
  });
  // What the editor shows while the person writes (G33.3): the recipe read, or why not, and
  // its next times.
  app.post("/api/automations/preview", async (c) => {
    const b = z
      .object({ yaml: z.string().max(100_000), count: z.number().int().min(1).max(20).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "yaml is needed" }, 400);
    return c.json(await core.automations.preview(owner(c), b.data.yaml, b.data.count ?? 5), 200);
  });
  // Magic automations (G33.3): a conversation with God that ends in a proposal; only the
  // person's yes makes it an automation.
  app.get("/api/magic", async (c) => c.json(await core.magic.list(owner(c)), 200));
  app.post("/api/magic", async (c) => {
    const b = z
      .object({ request: z.string().trim().min(1).max(20_000) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "Write what the automation should do" }, 400);
    return c.json(await core.magic.create(owner(c), b.data.request), 201);
  });
  app.get("/api/magic/:id", async (c) =>
    c.json(await core.magic.get(owner(c), c.req.param("id")), 200),
  );
  app.post("/api/magic/:id/approve", async (c) => {
    const b = z
      .object({ yaml: z.string().min(1).max(100_000).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: "Bad recipe" }, 400);
    return c.json(await core.magic.approve(owner(c), c.req.param("id"), b.data.yaml), 200);
  });
  app.post("/api/magic/:id/reject", async (c) => {
    const b = z
      .object({ reason: z.string().max(4000).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    return c.json(
      await core.magic.reject(owner(c), c.req.param("id"), b.success ? b.data.reason : undefined),
      200,
    );
  });
  app.delete("/api/magic/:id", async (c) => {
    await core.magic.dismiss(owner(c), c.req.param("id"));
    return c.json({ ok: true }, 200);
  });
  // A routine on a project's repository events (G24.14c): the webhook is added on Gitea or GitHub.
  app.post("/api/automations/:id/repo-hook", async (c) => {
    const b = z
      .object({
        secret: z.string().regex(/^rgwh_[\w-]+$/),
        project: z.string().min(1),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success)
      return c.json({ error: "The routine's secret and its project are needed" }, 400);
    const a = await autos.get(owner(c), c.req.param("id"));
    const events = a.recipe.on.events ?? ["push"];
    return wizard(c, () =>
      (setup as SetupService).repoHook(b.data.project, a.id, b.data.secret, events),
    );
  });
  // Access from outside home (G24.6): Tailscale, a Cloudflare Tunnel, or one's own domain.
  app.post("/api/setup/remote", (c) =>
    wizard(c, async () =>
      (setup as SetupService).startRemote(
        await parsed(
          c,
          z.discriminatedUnion("way", [
            z.object({ way: z.literal("tailscale") }),
            z.object({
              way: z.literal("cloudflare"),
              token: z.string().trim().min(40).max(4000),
              hostname: z
                .string()
                .trim()
                .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i),
            }),
            z.object({
              way: z.literal("caddy"),
              domain: z
                .string()
                .trim()
                .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i),
            }),
          ]),
        ),
      ),
    ),
  );
  app.delete("/api/setup/remote", (c) => wizard(c, () => (setup as SetupService).stopRemote()));
  // Starting the local engine is a job (image, start, load, a first answer); null stops it.
  // The local model turned on or off (2026-11-04); on is a job that loads it again.
  app.put("/api/setup/engine/power", (c) =>
    wizard(c, async () => {
      const b = await parsed(c, z.object({ on: z.boolean() }));
      return (setup as SetupService).setEnginePower(b.on);
    }),
  );

  // Debug mode (2026-11-04): its switch, the logs as one archive, and deleting them.
  app.get("/api/debug", async (c) => c.json(await debugLog.state()));
  app.put("/api/debug", async (c) => {
    const b = await parsed(c, z.object({ enabled: z.boolean() }));
    await debugLog.setEnabled(b.enabled);
    return c.json(await debugLog.state());
  });
  app.get("/api/debug/logs", async (c) => {
    const body = await debugLog.archive();
    const name = `redgiant-logs-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.tar.gz`;
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${name}"`,
      },
    });
  });
  app.delete("/api/debug/logs", async (c) => {
    await debugLog.clear();
    return c.json(await debugLog.state());
  });

  // What speculative decoding gains here (2026-11-04): a job that tries each mode and puts the
  // engine back as it was.
  app.post("/api/setup/engine/speed-test", (c) =>
    wizard(c, async () => {
      const b = await parsed(
        c,
        z.object({
          engine: Engine,
          modes: z
            .array(z.enum(["none", "draft", "ngram"]))
            .min(1)
            .max(3),
        }),
      );
      return (setup as SetupService).testSpeed(b.engine, b.modes);
    }),
  );
  app.put("/api/setup/engine", (c) =>
    wizard(c, async () => {
      const e = (await parsed(c, z.object({ engine: Engine.nullable() }))).engine;
      if (!e) return (setup as SetupService).saveEngine(null);
      return (setup as SetupService).startEngine(e);
    }),
  );
  app.put("/api/setup/backup-model", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveBackupModel(
        (
          await parsed(
            c,
            z.object({
              model: z
                .object({
                  provider: z.string().min(1),
                  model: z.string().min(1),
                  effort: z.enum(["low", "medium", "high", "max"]).optional(),
                })
                .nullable(),
            }),
          )
        ).model,
      ),
    ),
  );
  app.put("/api/setup/instructions", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveInstructions(
        (await parsed(c, z.object({ text: z.string().max(20_000) }))).text,
      ),
    ),
  );
  app.put("/api/setup/names", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveNames(
        await parsed(
          c,
          z.object({
            god: z.string().trim().min(1).max(40),
            demigod: z.string().trim().min(1).max(40),
            godPrompt: z.string().min(1).nullable().optional(),
            language: z.enum(["it", "en"]).optional(),
            agentLanguage: z.string().min(2).max(20).optional(),
          }),
        ),
      ),
    ),
  );
  // The interface's language and the agents' (G33.5), from the wizard's first step and Settings.
  app.put("/api/setup/languages", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveLanguages(
        await parsed(
          c,
          z.object({
            language: z.enum(["it", "en"]).optional(),
            agentLanguage: z.string().min(2).max(20).optional(),
          }),
        ),
      ),
    ),
  );
  // Claude's subscription from the browser (G24.2): Anthropic's page, then the code it shows.
  app.get("/api/subscriptions/claude", (c) =>
    wizard(c, () => (setup as SetupService).claudeStatus()),
  );
  app.post("/api/subscriptions/claude/login", (c) =>
    wizard(c, async () =>
      (setup as SetupService).claudeLoginStart(
        (await parsed(c, z.object({ ack: z.boolean().default(false) }))).ack,
      ),
    ),
  );
  app.post("/api/subscriptions/claude/code", (c) =>
    wizard(c, async () =>
      (setup as SetupService).claudeLoginFinish(
        (await parsed(c, z.object({ code: z.string().trim().min(4).max(2000) }))).code,
      ),
    ),
  );
  app.post("/api/subscriptions/claude/logout", (c) =>
    wizard(c, () => (setup as SetupService).claudeSignOut()),
  );
  app.put("/api/setup/subscriptions", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveSubscriptions(
        await parsed(
          c,
          z.object({
            ack: z.boolean().optional(),
            claude: z
              .object({ token: z.string().min(20).optional() })
              .nullable()
              .optional(),
            chatgpt: z.boolean().optional(),
          }),
        ),
      ),
    ),
  );
  app.put("/api/setup/chats/:platform", (c) =>
    wizard(c, async () => {
      const p = platformOf(c);
      if (!p) throw new Error("Unknown chat platform");
      const { settings } = await parsed(
        c,
        z.object({ settings: ChatSettings[p as "discord"].nullable() }),
      );
      return (setup as SetupService).saveChat(p, settings);
    }),
  );
  app.put("/api/setup/telegram", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveTelegram(
        (
          await parsed(
            c,
            z.object({
              token: z
                .string()
                .regex(/^\d+:[\w-]+$/)
                .nullable(),
            }),
          )
        ).token,
      ),
    ),
  );
  app.put("/api/setup/safety", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveSafety(
        await parsed(
          c,
          z.object({
            humanOnly: z.array(z.string()).optional(),
            disabledDanger: z.array(z.string()).optional(),
            budgetUsd: z.number().positive().nullable().optional(),
            retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
            subscriptionAck: z.boolean().optional(),
            guardian: z.enum(["ask", "auto"]).optional(),
            skills: z.enum(["ask", "auto"]).optional(),
          }),
        ),
      ),
    ),
  );
  app.post("/api/setup/complete", (c) => wizard(c, () => (setup as SetupService).complete()));
  app.get("/api/setup/hf/search", (c) =>
    wizard(c, async () => (hf ? hf.search(c.req.query("q") ?? "") : [])),
  );
  app.get("/api/setup/hf/files", (c) =>
    wizard(c, async () => (hf ? hf.files(c.req.query("repo") ?? "") : [])),
  );
  // The suggested local models for this computer, and what the models folder holds (G24.3).
  app.get("/api/setup/local-models", (c) =>
    wizard(c, async () => {
      const folder = modelsFor(c.req.query("variant"));
      if (!folder) return { models: [], files: [] };
      const hw = (await (setup as SetupService).state()).hardware;
      // SSD stream (2026-11-03): a model may be as big as RAM and card together; what does not
      // fit there is read from the SSD, slower but possible.
      const stream = c.req.query("stream") === "1";
      // In order (2026-11-04): the card, then the RAM free now, then the SSD. Memory shared by
      // the card and the processor counts once (the RAM).
      const card = hw.suggestion.kind === "gpu" ? hw.suggestion.maxModelGb : 0;
      const budget = stream
        ? Math.max(hw.suggestion.maxModelGb, Math.round((card + hw.freeRamGb * 0.9) * 10) / 10)
        : hw.suggestion.maxModelGb;
      // Beyond that, with SSD stream: a model as big as the models' disk allows.
      const diskFreeGb = stream
        ? await statfs(folder.dir)
            .then((d) => (d.bavail * d.bsize) / 1024 ** 3)
            .catch(() => 0)
        : 0;
      const files = await folder.local();
      const have = new Set(files.filter((f) => !f.partial).map((f) => f.file));
      return {
        models: await localModelChoices(folder, budget, stream ? { diskFreeGb } : undefined, have),
        files,
        budgetGb: budget,
        ...(stream && { diskFreeGb: Math.round(diskFreeGb * 10) / 10 }),
      };
    }),
  );
  // A download is a job: followed with its progress, cancelled to pause, started again to go on.
  app.post("/api/setup/local-models/download", (c) =>
    wizard(c, async () => {
      const b = await parsed(
        c,
        z.object({ repo: z.string(), file: z.string(), variant: z.string().optional() }),
      );
      const folder = modelsFor(b.variant);
      if (!folder) throw new Error("No models folder");
      const target = HuggingFace.target(b.file);
      const running = core.jobs
        .list(owner(c))
        .find(
          (j) => j.kind === "model_download" && j.state === "running" && j.vars.model === target,
        );
      return (
        running ??
        core.jobs.start(
          owner(c),
          "model_download",
          ["download"],
          (h) => folder.download(b.repo, b.file, h),
          {
            model: target,
          },
        )
      );
    }),
  );
  app.delete("/api/setup/local-models/:file", (c) =>
    wizard(c, async () => {
      const folder = modelsFor(c.req.query("variant"));
      if (!folder) throw new Error("No models folder");
      await folder.remove(c.req.param("file"));
    }),
  );

  // Automations (G13).
  const autos = core.automations;
  app.openapi(routes.listAutomations, async (c) => c.json(await autos.list(owner(c)), 200));
  app.openapi(routes.createAutomation, async (c) =>
    c.json(await autos.create(owner(c), c.req.valid("json").yaml), 201),
  );
  app.openapi(routes.getAutomation, async (c) =>
    c.json(await autos.get(owner(c), c.req.valid("param").id), 200),
  );
  app.openapi(routes.updateAutomation, async (c) =>
    c.json(await autos.update(owner(c), c.req.valid("param").id, c.req.valid("json").yaml), 200),
  );
  app.openapi(routes.deleteAutomation, async (c) => {
    await autos.remove(owner(c), c.req.valid("param").id);
    return c.json({ ok: true as const }, 200);
  });
  app.openapi(routes.enableAutomation, async (c) =>
    c.json(
      await autos.setEnabled(owner(c), c.req.valid("param").id, c.req.valid("json").enabled),
      200,
    ),
  );
  app.openapi(routes.runAutomation, async (c) => {
    const { run, done } = await autos.runNow(owner(c), c.req.valid("param").id);
    done.catch((err) => console.error("automation:", err));
    return c.json(run, 202);
  });
  app.openapi(routes.rotateAutomationSecret, async (c) =>
    c.json({ webhookSecret: await autos.rotateSecret(owner(c), c.req.valid("param").id) }, 200),
  );
  app.openapi(routes.automationRuns, async (c) =>
    c.json(await autos.runs(owner(c), c.req.valid("param").id), 200),
  );
  // The webhook: the recipe's secret in a header, or in the address (GitHub and Gitea, which
  // cannot send a header of ours); any body up to 1 MB (JSON, or kept as text).
  const hook = async (c: Context<Env>, secret: string) => {
    const body = await c.req.text();
    if (body.length > 1_048_576) return c.json({ error: "Body larger than 1 MB" }, 413);
    let payload: unknown = body;
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {}
    const event =
      c.req.header("x-github-event") ??
      c.req.header("x-gitea-event") ??
      c.req.header("x-gogs-event");
    try {
      const r = await autos.webhook(c.req.param("id") ?? "", secret, payload, event);
      if (!r) return c.json({ ignored: true }, 202);
      r.done.catch((err) => console.error("automation:", err));
      return c.json({ runId: r.run.id, status: r.run.status }, 202);
    } catch (err) {
      if (err instanceof WebhookForbiddenError) return c.json({ error: "Forbidden" }, 403);
      throw err;
    }
  };
  app.post("/api/automations/:id/hook", (c) => hook(c, c.req.header("x-redgiant-secret") ?? ""));
  app.post("/api/automations/:id/hook/:secret", (c) => hook(c, c.req.param("secret")));

  app.openapi(routes.verifyLog, async (c) => c.json(await core.store.verify(), 200));

  if (options.webDir) {
    const root = options.webDir;
    const compressed = new CompressedFiles();
    app.get("*", async (c) => {
      if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found" }, 404);
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "") || "index.html";
      const file = resolve(root, rel);
      const inside = file.startsWith(resolve(root) + sep);
      const target =
        inside && (await stat(file).catch(() => undefined))?.isFile()
          ? file
          : join(root, "index.html");
      const raw = await readFile(target).catch(() => undefined);
      if (!raw) return c.text("The web UI is not built (pnpm --filter @redgiant/web build).", 404);
      // Compressed once and kept (3.5.11): the page's scripts are text, most of it repeated.
      const enc =
        COMPRESSIBLE.test(target) && raw.length >= MIN_COMPRESS
          ? pickEncoding(c.req.header("accept-encoding"))
          : undefined;
      const when = enc && (await stat(target).catch(() => undefined))?.mtimeMs;
      const body = enc ? await compressed.get(`${target}\0${raw.length}\0${when}`, enc, raw) : raw;
      const type = MIME[extname(target)] ?? "application/octet-stream";
      // Hashed assets never change; index.html must always be fresh.
      const cache = target.includes(`${sep}assets${sep}`)
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      // RedGiant's page frames only itself (3.5.8): a preview cannot take its frame to another site.
      const frames = type.startsWith("text/html")
        ? { "content-security-policy": "frame-src 'self'" }
        : {};
      return new Response(body, {
        headers: {
          "content-type": type,
          "cache-control": cache,
          ...(COMPRESSIBLE.test(target) && { vary: "accept-encoding" }),
          ...(enc && { "content-encoding": enc }),
          ...frames,
        },
      });
    });
  }

  return app;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
};

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
