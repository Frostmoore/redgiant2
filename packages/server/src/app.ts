import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AutomationNotFoundError, RecipeError, WebhookForbiddenError } from "@redgiant/automations";
import { loadCustomTools, loadSkills } from "@redgiant/extensions";
import { HierarchyError } from "@redgiant/hierarchy";
import {
  AgentKind,
  Automation,
  AutomationRun,
  Effort,
  ImagePart,
  LOCAL_OWNER_ID,
  type ModelSpec as ModelSpecType,
  PermissionMode,
  PermissionRequestInfo,
  PROTOCOL_VERSION,
} from "@redgiant/protocol";
import type { TelegramGateway } from "@redgiant/telegram";
import { PathOutsideWorkspaceError } from "@redgiant/tools";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { type AuthProvider, bearer, type Principal } from "./auth.js";
import { ChatError } from "./chat.js";
import { CodeChangeError } from "./code.js";
import { BadRequestError, NotFoundError, type RedGiantCore, SessionBusyError } from "./core.js";
import { PairingError } from "./devices.js";
import { sessionMarkdown } from "./export.js";
import { ConflictError, FileService } from "./files.js";
import type { HuggingFace } from "./hf.js";
import { ConfigError, PlatformPolicy } from "./platform.js";
import type { SetupService } from "./setup.js";
import { MAX_AUDIO_BYTES, TranscriptionError } from "./voice.js";

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
  .object({ id: z.string(), name: z.string(), path: z.string(), createdAt: z.string() })
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
      body: { content: { "application/json": { schema: z.object({ name: z.string().min(1) }) } } },
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
              model: ModelSpec.optional(),
              mode: PermissionMode.optional(),
              systemPrompt: z.string().optional(),
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
            running: z.boolean(),
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
                }),
              ]),
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
  setup?: SetupService;
  hf?: HuggingFace;
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

  app.use("/api/*", async (c, next) => {
    const open = [
      "/api/health",
      "/api/openapi.json",
      "/api/telegram/webhook",
      // A phone with a pairing code has no token yet: the code is its credential, once.
      "/api/devices/claim",
    ];
    // Automation webhooks carry their own secret.
    if (open.includes(c.req.path) || /^\/api\/automations\/[\w-]+\/hook$/.test(c.req.path))
      return next();
    const principal = await auth.authenticate(bearer(c.req.header("authorization")));
    if (!principal) return c.json({ error: "Missing or invalid token" }, 401);
    c.set("principal", principal);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof NotFoundError || err instanceof AutomationNotFoundError)
      return c.json({ error: err.message }, 404);
    if (err instanceof RecipeError) return c.json({ error: err.message }, 400);
    if (err instanceof SessionBusyError) return c.json({ error: err.message }, 409);
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
  const human = (c: Context<Env>) => ({ type: "human" as const, ownerId: owner(c) });

  app.openapi(routes.listProjects, async (c) => c.json(await core.projects.list(owner(c)), 200));
  app.openapi(routes.createProject, async (c) => {
    try {
      return c.json(await core.projects.create(owner(c), c.req.valid("json").name), 201);
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
  app.openapi(routes.createAgent, async (c) => {
    const body = c.req.valid("json");
    if (body.projectId && !(await core.projects.get(owner(c), body.projectId)))
      return c.json({ error: `Project "${body.projectId}" not found` }, 404);
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
    return c.json(agentOut(await core.registry.configure(human(c), id, change)), 200);
  });
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
        running: core.isRunning(r.id),
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
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: b.error.message }, 400);
    if (b.data.model !== undefined)
      await core.setSessionModel(owner(c), c.req.param("id"), b.data.model);
    await core.updateSession(owner(c), c.req.param("id"), {
      ...(b.data.title !== undefined && { title: b.data.title }),
      ...(b.data.pinned !== undefined && { pinned: b.data.pinned }),
      ...(b.data.archived !== undefined && { archived: b.data.archived }),
    });
    return c.json({ ok: true }, 200);
  });
  // Devices (G20.9): a QR code to pair a phone, the list, revocation.
  app.post("/api/devices/pair", (c) => c.json(core.devices.pairingCode(owner(c)), 200));
  app.post("/api/devices/claim", async (c) => {
    const b = z
      .object({ code: z.string().min(4).max(20), name: z.string().max(200).default("") })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return c.json({ error: b.error.message }, 400);
    try {
      return c.json(await core.devices.claim(b.data.code, b.data.name), 200);
    } catch (err) {
      if (err instanceof PairingError) return c.json({ error: err.message }, 403);
      throw err;
    }
  });
  app.get("/api/devices", async (c) => c.json(await core.devices.list(owner(c)), 200));
  app.delete("/api/devices/:id", async (c) =>
    (await core.devices.revoke(owner(c), c.req.param("id")))
      ? c.json({ ok: true }, 200)
      : c.json({ error: "No such device" }, 404),
  );
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
    if (!p) return c.json({ on: false, account: null }, 200);
    return c.json({ on: true, account: await p.account().catch(() => null) }, 200);
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
  // What the composer offers: every provider's models, and whether they take an effort.
  app.get("/api/models", async (c) => c.json(await core.models(), 200));
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
    });
    done.catch((err) => console.error("session failed:", err));
    return c.json({ accepted: true as const }, 202);
  });
  app.openapi(routes.interrupt, async (c) =>
    c.json({ interrupted: await core.interrupt(owner(c), c.req.valid("param").id) }, 200),
  );

  app.openapi(routes.listPermissions, (c) => c.json(core.approvals.list(owner(c)), 200));
  app.openapi(routes.decidePermission, (c) =>
    core.approvals.decide(owner(c), c.req.valid("param").id, c.req.valid("json").decision)
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

  app.openapi(routes.budgets, async (c) => {
    const o = owner(c);
    const projects = (await core.projects.list(o)).map((p) => p.id);
    const agents = core.registry.list({ ownerId: o }).map((a) => a.id);
    return c.json(await core.budget.listFor(o, projects, agents), 200);
  });
  app.openapi(routes.setBudget, async (c) => {
    const b = c.req.valid("json");
    const o = owner(c);
    const mine =
      (b.scope === "global" && b.id === o) ||
      (b.scope === "project" && (await core.projects.get(o, b.id)) !== undefined) ||
      (b.scope === "agent" && core.registry.get(b.id)?.ownerId === o);
    if (!mine) return c.json({ error: "Not found" }, 404);
    await core.budget.setLimit(
      { scope: b.scope, id: b.id },
      {
        ...(b.usd !== undefined && { usd: b.usd }),
        ...(b.tokens !== undefined && { tokens: b.tokens }),
      },
    );
    return c.json({ ok: true as const }, 200);
  });

  const ownsProject = async (c: Context<Env>, projectId: string | null | undefined) =>
    projectId === null ||
    projectId === undefined ||
    (await core.projects.get(owner(c), projectId)) !== undefined;
  app.openapi(routes.boardThreads, async (c) => {
    const q = c.req.valid("query");
    if (!(await ownsProject(c, q.projectId))) return c.json({ error: "Project not found" }, 404);
    return c.json(await core.board.threads(owner(c), q.projectId ?? null, q.status), 200);
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
    await core.setMcp(owner(c), b as never);
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
  app.post("/api/platform/changes/:id/discard", async (c) => {
    if (!core.code) return c.json({ error: "Code changes are not enabled" }, 400);
    try {
      return c.json(await core.code.discard(owner(c), "human", c.req.param("id")), 200);
    } catch (err) {
      if (err instanceof CodeChangeError) return c.json({ error: err.message }, 400);
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
    const { title } = (await c.req.json()) as { title?: string };
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
  app.put("/api/chat/settings", async (c) => {
    const body = z
      .object({ model: ModelSpec.optional(), systemPrompt: z.string().min(1).optional() })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    await core.chat.setSettings(owner(c), {
      ...(body.data.model && { model: body.data.model }),
      ...(body.data.systemPrompt && { systemPrompt: body.data.systemPrompt }),
    });
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
  const wizard = async (c: Context<Env>, f: () => Promise<unknown>) => {
    if (!setup) return c.json({ error: "Setup is not available" }, 400);
    try {
      return c.json((await f()) ?? { ok: true }, 200);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  };
  const parsed = async <T extends z.ZodType>(c: Context<Env>, schema: T): Promise<z.infer<T>> => {
    const r = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!r.success)
      throw new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  };
  const Engine = z.object({ variant: z.enum(["cpu", "cuda"]), model: z.string().min(1) });
  app.get("/api/setup", (c) => wizard(c, () => (setup as SetupService).state()));
  app.put("/api/setup/models", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveModels(
        await parsed(
          c,
          z.object({
            anthropicKey: z.string().min(10).nullable().optional(),
            openai: z
              .object({ baseUrl: z.url(), key: z.string().optional() })
              .nullable()
              .optional(),
            searxngUrl: z.url().nullable().optional(),
            images: z
              .object({ key: z.string().min(10).optional(), model: z.string().min(1).optional() })
              .nullable()
              .optional(),
            transcription: z
              .object({
                api: z.enum(["whisper-asr", "openai"]),
                url: z.url(),
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
  app.put("/api/setup/engine", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveEngine(
        (await parsed(c, z.object({ engine: Engine.nullable() }))).engine,
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
          }),
        ),
      ),
    ),
  );
  app.put("/api/setup/subscriptions", (c) =>
    wizard(c, async () =>
      (setup as SetupService).saveSubscriptions(
        await parsed(
          c,
          z.object({
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
  app.post("/api/setup/hf/download", (c) =>
    wizard(c, async () => {
      if (!hf) throw new Error("No models folder");
      const b = await parsed(c, z.object({ repo: z.string(), file: z.string() }));
      return hf.start(b.repo, b.file);
    }),
  );
  app.get("/api/setup/hf/downloads", (c) => wizard(c, async () => hf?.list() ?? []));

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
  // The webhook: the recipe's secret in a header; any body up to 64 kB (JSON, or kept as text).
  app.post("/api/automations/:id/hook", async (c) => {
    const body = await c.req.text();
    if (body.length > 65_536) return c.json({ error: "Body larger than 64 kB" }, 413);
    let payload: unknown = body;
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {}
    try {
      const { run, done } = await autos.webhook(
        c.req.param("id"),
        c.req.header("x-redgiant-secret") ?? "",
        payload,
      );
      done.catch((err) => console.error("automation:", err));
      return c.json({ runId: run.id, status: run.status }, 202);
    } catch (err) {
      if (err instanceof WebhookForbiddenError) return c.json({ error: "Forbidden" }, 403);
      throw err;
    }
  });

  app.openapi(routes.verifyLog, async (c) => c.json(await core.store.verify(), 200));

  if (options.webDir) {
    const root = options.webDir;
    app.get("*", async (c) => {
      if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found" }, 404);
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "") || "index.html";
      const file = resolve(root, rel);
      const inside = file.startsWith(resolve(root) + sep);
      const target =
        inside && (await stat(file).catch(() => undefined))?.isFile()
          ? file
          : join(root, "index.html");
      const body = await readFile(target).catch(() => undefined);
      if (!body) return c.text("The web UI is not built (pnpm --filter @redgiant/web build).", 404);
      const type = MIME[extname(target)] ?? "application/octet-stream";
      // Hashed assets never change; index.html must always be fresh.
      const cache = target.includes(`${sep}assets${sep}`)
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      return new Response(body, { headers: { "content-type": type, "cache-control": cache } });
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
};
