import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HierarchyError } from "@redgiant/hierarchy";
import {
  AgentKind,
  Effort,
  LOCAL_OWNER_ID,
  type ModelSpec as ModelSpecType,
  PermissionMode,
  PermissionRequestInfo,
  PROTOCOL_VERSION,
} from "@redgiant/protocol";
import type { Context } from "hono";
import { type AuthProvider, bearer, type Principal } from "./auth.js";
import { NotFoundError, type RedGiantCore, SessionBusyError } from "./core.js";

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

const routes = {
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
            running: z.boolean(),
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
      body: { content: { "application/json": { schema: z.object({ text: z.string().min(1) }) } } },
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
export function createApp(core: RedGiantCore, auth: AuthProvider) {
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
    if (c.req.path === "/api/health" || c.req.path === "/api/openapi.json") return next();
    const principal = await auth.authenticate(bearer(c.req.header("authorization")));
    if (!principal) return c.json({ error: "Missing or invalid token" }, 401);
    c.set("principal", principal);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof SessionBusyError) return c.json({ error: err.message }, 409);
    if (err instanceof HierarchyError) return c.json({ error: err.message }, 400);
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
        running: core.isRunning(r.id),
      })),
      200,
    );
  });
  app.openapi(routes.startSession, async (c) =>
    c.json({ sessionId: await core.startSession(owner(c), c.req.valid("json").agentId) }, 201),
  );
  app.openapi(routes.sessionEvents, async (c) =>
    c.json(await core.history(owner(c), c.req.valid("param").id), 200),
  );
  app.openapi(routes.sendMessage, async (c) => {
    const { done } = await core.send(owner(c), c.req.valid("param").id, c.req.valid("json").text);
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
  app.openapi(routes.verifyLog, async (c) => c.json(await core.store.verify(), 200));

  return app;
}
