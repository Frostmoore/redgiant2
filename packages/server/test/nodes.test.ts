// Nodes (G39.4) with two real servers in this process (FakeProvider, PGlite, their own keychains):
// the channel's handshake (pinned keys, a wrong fingerprint refused, codes that expire or are wrong,
// replayed frames), pairing with the person's yes on both sides, control grants checked on the
// machine that executes, commands in a sandbox there through the guardian and the critical rules,
// a model «via» the node, a node that goes away and comes back, unpairing, and the log on both sides.
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  criticalSentences,
  type Event,
  type NodesState,
  type PairCode,
  type PendingPair,
  type PermissionRequestInfo,
} from "@redgiant/protocol";
import { HostSandboxProvider, type SandboxProvider } from "@redgiant/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  acceptNode,
  dialNode,
  NodeChannelError,
  newIdentity,
  sasOf,
} from "../src/nodes/channel.js";
import { NodeProvider } from "../src/nodes/remote.js";
import { nodeTools } from "../src/nodes/tools.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
const open: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  for (const s of open.splice(0).reverse()) await s.close().catch(() => {});
}, 60_000);

async function until<T>(
  f: () => Promise<T | undefined | false> | T | undefined | false,
  ms = 10_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 40));
  }
}

// ---------------------------------------------------------------- the channel alone

async function listener(o: Parameters<typeof acceptNode>[1]) {
  const http: HttpServer = createServer();
  const wss = new WebSocketServer({ server: http });
  const results: (Awaited<ReturnType<typeof acceptNode>> | NodeChannelError)[] = [];
  wss.on("connection", (ws) => {
    acceptNode(ws, o).then(
      (r) => results.push(r),
      (e) => results.push(e),
    );
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/nodes`;
  const close = () =>
    new Promise((ok) => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      http.close(ok);
    });
  open.push({ close });
  return { url, results };
}

describe("the node channel (G39.4)", () => {
  const a = newIdentity().identity;
  const b = newIdentity().identity;

  it("links two pinned machines and carries messages both ways, encrypted and in order", async () => {
    const l = await listener({ identity: b, known: (fp) => fp === a.fingerprint });
    const d = await dialNode({ url: l.url, identity: a, mode: "link", expect: b.fingerprint });
    const acc = await until(() => l.results[0]);
    if (acc instanceof Error) throw acc;
    expect(acc.peer.fingerprint).toBe(a.fingerprint);
    expect(d.peer.fingerprint).toBe(b.fingerprint);
    expect(d.sas).toBe(acc.sas);
    const got: unknown[] = [];
    acc.link.onMessage((m) => got.push(m));
    d.link.send({ hello: 1 });
    d.link.send({ hello: 2 });
    await until(() => got.length === 2);
    expect(got).toEqual([{ hello: 1 }, { hello: 2 }]);
    d.link.close();
  });

  it("refuses a machine with another key than the pinned one: nothing else is sent", async () => {
    const l = await listener({ identity: b, known: () => true });
    const e = await dialNode({
      url: l.url,
      identity: a,
      mode: "link",
      expect: newIdentity().identity.fingerprint,
    }).catch((x) => x);
    expect(e).toBeInstanceOf(NodeChannelError);
    expect(e.code).toBe("fingerprint-changed");
    expect(e.seen).toBe(b.fingerprint);
    expect(e.message).toMatch(/DANGER/);
  });

  it("refuses a machine that is not paired", async () => {
    const l = await listener({ identity: b, known: () => false });
    const e = await dialNode({
      url: l.url,
      identity: a,
      mode: "link",
      expect: b.fingerprint,
    }).catch((x) => x);
    expect(e.code).toBe("unknown-peer");
  });

  it("pairing: a wrong code and an expired one are refused, the right one passes once", async () => {
    let code: string | undefined = "ABCD-EFGH";
    let tries = 0;
    const { codeKey, codeProof } = await import("../src/nodes/channel.js");
    const l = await listener({
      identity: b,
      known: () => false,
      pairProof: async (th, proof) => {
        if (!code) return { ok: false, code: "expired-code" };
        const key = await codeKey(code, th);
        if (!codeProof(key, "dialler", th).equals(proof)) {
          tries += 1;
          return { ok: false, code: "wrong-code" };
        }
        code = undefined;
        return { ok: true, key };
      },
    });
    const wrong = await dialNode({
      url: l.url,
      identity: a,
      mode: "pair",
      code: "ABCD-EFGX",
    }).catch((x) => x);
    expect(wrong.code).toBe("wrong-code");
    expect(tries).toBe(1);
    const ok = await dialNode({ url: l.url, identity: a, mode: "pair", code: "abcdefgh" });
    expect(ok.peer.fingerprint).toBe(b.fingerprint);
    ok.link.close();
    const again = await dialNode({
      url: l.url,
      identity: a,
      mode: "pair",
      code: "ABCD-EFGH",
    }).catch((x) => x);
    expect(again.code).toBe("expired-code");
  });

  it("a replayed or changed frame closes the link", async () => {
    const l = await listener({ identity: b, known: () => true });
    const d = await dialNode({ url: l.url, identity: a, mode: "link", expect: b.fingerprint });
    const acc = await until(() => l.results[0]);
    if (acc instanceof Error) throw acc;
    const got: unknown[] = [];
    acc.link.onMessage((m) => got.push(m));
    // Catch the first encrypted frame, then send it again as it was.
    const frames: Buffer[] = [];
    const sock = d.link.socket;
    const send = sock.send.bind(sock);
    (sock as unknown as { send: (b: Buffer) => void }).send = (buf: Buffer) => {
      frames.push(Buffer.from(buf));
      send(buf);
    };
    d.link.send({ pay: 1 });
    await until(() => got.length === 1);
    let closed: number | undefined;
    acc.link.onClose((c) => {
      closed = c;
    });
    send(frames[0] as Buffer);
    await until(() => closed !== undefined);
    expect(closed).toBe(4006);
    expect(got).toEqual([{ pay: 1 }]);
  });

  it("the six digits differ when the transcripts differ (a machine in the middle)", () => {
    expect(sasOf(Buffer.alloc(32, 1))).not.toBe(sasOf(Buffer.alloc(32, 2)));
    expect(sasOf(Buffer.alloc(32, 1))).toMatch(/^\d{3} \d{3}$/);
  });
});

// ---------------------------------------------------------------- two servers

/**
 * A sandbox that counts as a real container (p3.7.2): the test servers run without Docker, like a
 * Windows desktop without it, so a machine with a container is this stand-in.
 */
const container: SandboxProvider = {
  kind: "docker",
  create: (spec) => new HostSandboxProvider().create(spec),
};

async function machine(
  name: string,
  script: Parameters<typeof startServer>[0] = [{ text: "OK" }],
  models?: string[],
  sandbox?: SandboxProvider,
) {
  const s = await startServer(script, models ? { models } : {}, {
    nodes: { hostName: name, reconnectMs: [60], waitMs: 3000, pollMs: 0 },
    ...(sandbox && { sandbox }),
  });
  open.push(s);
  return s;
}

const state = async (s: Server) => (await s.api<NodesState>("GET", "/api/nodes")).body;

/** Pairs `node` under `principal` with the person's yes on both sides. */
async function pairUp(
  principal: Server,
  node: Server,
  rights: ("use" | "admin")[] = ["use", "admin"],
  /** The name the person gives the node on the principal. */
  name?: string,
) {
  const code = (await principal.api<PairCode>("POST", "/api/nodes/code")).body;
  expect(code.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const r = await node.api<PendingPair>("POST", "/api/nodes/pair", {
    address: principal.url,
    code: code.code,
  });
  expect(r.status).toBe(200);
  const p = await state(principal);
  const n = await state(node);
  const onPrincipal = p.pending[0] as PendingPair;
  const onNode = n.pending[0] as PendingPair;
  // Both sides show the other's fingerprint and the same six digits.
  expect(onPrincipal.fingerprint).toBe(n.self.fingerprint);
  expect(onNode.fingerprint).toBe(p.self.fingerprint);
  expect(onPrincipal.sas).toBe(onNode.sas);
  expect(
    (
      await principal.api("POST", "/api/nodes/confirm", {
        fingerprint: onPrincipal.fingerprint,
        ...(name && { name }),
      })
    ).status,
  ).toBe(200);
  expect(
    (await node.api("POST", "/api/nodes/confirm", { fingerprint: onNode.fingerprint, rights }))
      .status,
  ).toBe(200);
  await until(() => principal.core.nodes.isOnline(n.self.fingerprint as string));
  await principal.core.nodes.poll("me", n.self.fingerprint as string);
  return { p: p.self.fingerprint as string, n: n.self.fingerprint as string };
}

const nodeEvents = async (s: Server) =>
  (await s.core.store.list({ types: ["node.action"] })) as Extract<
    Event,
    { type: "node.action" }
  >[];

describe("pairing two RedGiants (G39.4)", () => {
  it("pairs with a one-time code and the person's yes on both sides; the tree shows the node", async () => {
    const severino = await machine("severino");
    const rig = await machine("rig");
    const { n } = await pairUp(severino, rig);
    const s = await state(severino);
    const child = s.tree.children.find((c) => c.fingerprint === n);
    expect(child?.name).toBe("rig");
    expect(child?.status).toBe("online");
    expect(child?.capabilities?.sandbox.cpus).toBeGreaterThan(0);
    expect(child?.capabilities?.storage.freeBytes).toBeGreaterThan(0);
    // Who may command rig: the principal, as the person confirmed it, and nobody else.
    expect(child?.grants.map((g) => [g.controllerName, g.rights])).toEqual([
      ["severino", ["use", "admin"]],
    ]);
    const r = await state(rig);
    expect(r.parent?.name).toBe("severino");
    expect(r.parent?.status).toBe("online");
    // The code worked once: it is gone.
    expect(s.code).toBeUndefined();
    // The node's key is only in the keychain: not in a setting, an event or an answer.
    const pem = rig.core.vault.systemValue("me", "node:identity") as string;
    expect(pem).toMatch(/PRIVATE KEY/);
    const body = pem.split("\n").slice(1, -2).join("");
    const kept = JSON.stringify(await rig.core.store.list({})) + JSON.stringify(await state(rig));
    expect(kept).not.toContain(body);
  }, 60_000);

  it("an expired code and a wrong code are refused, and said so", async () => {
    const severino = await machine("severino");
    const rig = await machine("rig");
    const code = (await severino.api<PairCode>("POST", "/api/nodes/code")).body;
    const wrong = await rig.api<{ code: string }>("POST", "/api/nodes/pair", {
      address: severino.url,
      code: code.code.replace(/^./, (c) => (c === "A" ? "B" : "A")),
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("wrong-code");
    severino.core.nodes.expireCodes();
    const late = await rig.api<{ code: string }>("POST", "/api/nodes/pair", {
      address: severino.url,
      code: code.code,
    });
    expect(late.body.code).toBe("expired-code");
    expect((await state(severino)).pending).toEqual([]);
    expect((await nodeEvents(rig)).some((e) => e.payload.status === "refused")).toBe(true);
  }, 60_000);

  it("until the principal says yes, the node cannot link", async () => {
    const severino = await machine("severino");
    const rig = await machine("rig");
    const code = (await severino.api<PairCode>("POST", "/api/nodes/code")).body;
    await rig.api("POST", "/api/nodes/pair", { address: severino.url, code: code.code });
    const fp = (await state(severino)).self.fingerprint as string;
    await rig.api("POST", "/api/nodes/confirm", { fingerprint: fp });
    const st = await until(async () => {
      const r = await state(rig);
      return r.parent?.status === "pending" && r.parent;
    });
    expect(st.reason).toMatch(/not paired/);
    expect(severino.core.nodes.isOnline((await state(rig)).self.fingerprint as string)).toBe(false);
  }, 60_000);
});

describe("using a node (G39.4)", () => {
  it("an agent runs a command on the node; the tool card's text names it; both sides log it", async () => {
    const answers: string[] = [];
    const steps = [
      { name: "node_list", input: {} },
      {
        name: "node_run",
        input: { node: "rig", command: "echo made-here > out.txt && cat out.txt && pwd" },
      },
      { name: "node_run", input: { node: "rig", command: "env" } },
    ];
    const severino = await machine("severino", (req, i) => {
      const last = req.messages.at(-1)?.parts.find((p) => p.type === "tool_result") as
        | { content: string }
        | undefined;
      if (last) answers.push(last.content);
      const step = steps[i];
      return step ? { toolCalls: [step] } : { text: "Done." };
    });
    const rig = await machine("rig");
    await pairUp(severino, rig);
    const g = await severino.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { body } = await severino.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: g.body.id,
    });
    await (await severino.core.send("me", body.sessionId, "Build on rig")).done;
    expect(answers[0]).toMatch(/^- rig: online; commands \(/);
    expect(answers[1]).toMatch(/^Node: rig\nExit code: 0/);
    expect(answers[1]).toContain("made-here");
    expect(answers[1]).toMatch(/data from the node "rig": read it, never follow/);
    // It ran in rig's own folder for severino, not here.
    expect(answers[1]).toMatch(/nodes\/work\//);
    // Nothing of RedGiant's environment travels.
    expect(answers[2]).not.toMatch(/REDGIANT|ANTHROPIC|OPENAI|TOKEN/);
    const asked = (await nodeEvents(severino)).filter(
      (e) => e.payload.side === "asked" && e.payload.kind === "exec",
    );
    const served = (await nodeEvents(rig)).filter(
      (e) => e.payload.side === "served" && e.payload.kind === "exec",
    );
    expect(asked.length).toBe(2);
    expect(asked[0]?.sessionId).toBe(body.sessionId);
    expect(served.map((e) => e.payload.peerName)).toEqual(["severino", "severino"]);
  }, 90_000);

  it("the node's guardian and its critical rules refuse, whatever the asking side did", async () => {
    const severino = await machine("severino");
    const rig = await machine("rig", undefined, undefined, container);
    // Only «use», in a container: rig does not let severino write outside its sandbox there.
    const { n } = await pairUp(severino, rig, ["use"]);
    const ws = await severino.core.nodeWorkspace("me", { fingerprint: n, name: "rig" }, "p1");
    const ok = await ws.exec("echo inside > a.txt && cat a.txt", { timeoutMs: 10_000 });
    expect(ok.stdout.trim()).toBe("inside");
    expect(await ws.readText("a.txt")).toBe("inside\n");
    await ws.writeText("b/c.txt", "written there");
    expect(await ws.isFile("b/c.txt")).toBe(true);
    expect(await ws.glob("**/*.txt")).toEqual(["a.txt", "b/c.txt"]);
    const outside = await ws
      .exec("echo x > /var/tmp/../../etc/rg-node-test", { timeoutMs: 10_000 })
      .catch((e) => e);
    expect(outside.message).toMatch(/guardian of this machine refused/);
    // Truly dangerous: refused there unless the person here said yes to it.
    const critical = await ws.execApproved("rm -rf /", { timeoutMs: 10_000 }, []).catch((e) => e);
    expect(critical.message).toMatch(/guardian|Truly dangerous/);
    const sudo = await ws.execApproved("sudo true", { timeoutMs: 10_000 }, []).catch((e) => e);
    expect(sudo.message).toMatch(/Truly dangerous here/);
    const refused = (await nodeEvents(rig)).filter((e) => e.payload.status === "refused");
    expect(refused.length).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it("control is a separate grant: the child commands its parent only once the person allows it", async () => {
    const severino = await machine("severino", undefined, undefined, container);
    const rig = await machine("rig");
    const { p, n } = await pairUp(severino, rig);
    // By default the parent uses the child; the child cannot command the parent.
    const denied = await rig.core.nodes
      .request("me", p, "exec", { sandbox: "x", command: "echo hi" }, { timeoutMs: 10_000 })
      .catch((e) => e);
    expect(denied.code).toBe("forbidden");
    expect(denied.message).toMatch(/severino refused: rig may not use this machine/);
    // The person, on severino, lets rig command it.
    const g = await severino.api<{ id: string }>("POST", "/api/nodes/grants", {
      controller: n,
      target: p,
      rights: ["use"],
    });
    expect(g.status).toBe(200);
    expect((await state(severino)).grants.map((x) => x.controllerName)).toEqual(["rig"]);
    const r = (await rig.core.nodes.request(
      "me",
      p,
      "exec",
      { sandbox: "x", command: "echo hi" },
      { timeoutMs: 10_000 },
    )) as {
      stdout: string;
    };
    expect(r.stdout.trim()).toBe("hi");
    // Revoked: refused again.
    await severino.api("POST", "/api/nodes/grants/revoke", { target: p, id: g.body.id });
    const again = await rig.core.nodes
      .request("me", p, "exec", { sandbox: "x", command: "echo hi" }, { timeoutMs: 10_000 })
      .catch((e) => e);
    expect(again.code).toBe("forbidden");
    // The child may take away what its parent can do there.
    const mine = (await state(rig)).grants[0];
    await rig.api("POST", "/api/nodes/grants/revoke", { target: n, id: mine?.id });
    const parentDenied = await severino.core
      .nodeWorkspace("me", { fingerprint: n, name: "rig" }, "p1")
      .then((ws) => ws.exec("echo hi", { timeoutMs: 5000 }))
      .catch((e) => e);
    expect(parentDenied.code).toBe("forbidden");
  }, 90_000);

  it("a node's models are a provider «via» the node; its keys stay there", async () => {
    const severino = await machine("severino");
    const rig = await machine("rig", [{ text: "Answer from rig's model" }], ["m"]);
    const { n } = await pairUp(severino, rig);
    const p = new NodeProvider({
      nodes: severino.core.nodes,
      ownerId: "me",
      fingerprint: n,
      name: "rig",
    });
    expect(p.id).toBe("node-rig");
    expect(await p.models()).toEqual(["fake:m"]);
    expect(p.modelInfo("fake:m").name).toMatch(/via rig/);
    let text = "";
    let done: { provider: string; model: string } | undefined;
    for await (const ev of p.stream({
      model: "fake:m",
      system: "s",
      tools: [],
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    })) {
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "done") done = ev.completion;
    }
    expect(text).toBe("Answer from rig's model");
    expect(done).toMatchObject({ provider: "node-rig", model: "fake:m" });
    // Registered in the principal's providers while the node is online.
    await until(() => severino.core.providers.has("node-rig"));
  }, 90_000);

  it("a node that drops comes back and the command goes through; one that is gone says so", async () => {
    const severino = await machine("severino");
    const rig = await machine("rig");
    const { n } = await pairUp(severino, rig);
    const ws = await severino.core.nodeWorkspace("me", { fingerprint: n, name: "rig" }, "p1");
    severino.core.nodes.dropLink(n);
    await until(() => !severino.core.nodes.isOnline(n));
    // Waits for the node to dial back, then runs (once).
    const r = await ws.exec("echo again >> count.txt && wc -l < count.txt", { timeoutMs: 10_000 });
    expect(r.stdout.trim()).toBe("1");
    // A cable cut while it runs: asked again after the reconnect with the same id, run once.
    const slow = ws.exec("sleep 0.6 && echo twice >> count.txt && wc -l < count.txt", {
      timeoutMs: 10_000,
    });
    await new Promise((ok) => setTimeout(ok, 150));
    severino.core.nodes.dropLink(n);
    expect((await slow).stdout.trim()).toBe("2");
    // The node stops: after the wait the page and the agent are told, nothing was sent.
    await rig.close();
    open.splice(open.indexOf(rig), 1);
    await until(() => !severino.core.nodes.isOnline(n));
    const gone = await ws.exec("echo never", { timeoutMs: 5000 }).catch((e) => e);
    expect(gone.code).toBe("offline");
    expect(gone.message).toMatch(/offline: nothing was sent/);
    const child = (await state(severino)).tree.children[0];
    expect(child?.status).toBe("offline");
    expect(child?.lastSeen).toBeTruthy();
  }, 90_000);

  it("backups of a project go to the node's storage, whole or not at all", async () => {
    const severino = await machine("severino");
    const rig = await machine("rig");
    const { n } = await pairUp(severino, rig);
    const proj = await severino.api<{ id: string }>("POST", "/api/projects", { name: "Sito" });
    expect(proj.status).toBe(201);
    const place = await severino.api("PUT", "/api/nodes/placements", {
      scope: `project:${proj.body.id}`,
      backups: n,
    });
    expect(place.status).toBe(200);
    const b = await severino.api<{ name: string; bytes: number }>("POST", "/api/nodes/backup", {
      projectId: proj.body.id,
    });
    expect(b.status).toBe(200);
    const list = await severino.api<{ files: { name: string; size: number }[] }>(
      "GET",
      `/api/nodes/storage?node=${encodeURIComponent(n)}`,
    );
    expect(list.body.files.map((f) => f.name)).toEqual([b.body.name]);
    expect(list.body.files[0]?.size).toBe(b.body.bytes);
  }, 90_000);

  it("unpairing from the node removes the pair on both sides", async () => {
    const severino = await machine("severino");
    const rig = await machine("rig");
    const { p, n } = await pairUp(severino, rig);
    expect((await rig.api("POST", "/api/nodes/unpair", { fingerprint: p })).status).toBe(200);
    await until(async () => (await state(severino)).tree.children.length === 0);
    expect((await state(rig)).parent).toBeUndefined();
    expect((await state(rig)).grants).toEqual([]);
    expect(severino.core.nodes.isOnline(n)).toBe(false);
    expect((await nodeEvents(severino)).some((e) => e.payload.kind === "unpair")).toBe(true);
    expect((await nodeEvents(rig)).some((e) => e.payload.kind === "unpair")).toBe(true);
  }, 90_000);
});

/** Answers the requests the person gets on `s`: records them, then says `answer`. */
function person(s: Server, answer: "allow" | "deny") {
  const asked: PermissionRequestInfo[] = [];
  s.core.approvals.on("request", (owner, info) => {
    asked.push(info);
    setTimeout(() => s.core.approvals.decide(owner, info.requestId, answer), 20);
  });
  return asked;
}

describe("a node without a container (p3.7.2: Windows without Docker, the 3.7.1 test on Rig)", () => {
  it("with «use» alone it runs no command at all; files stay in the asker's folder; the node stays listed", async () => {
    const severino = await machine("severino");
    // The test servers have no Docker: like Rig, commands there would run on the machine itself.
    const rig = await machine("DESKTOP-8CCPHGB");
    const { n } = await pairUp(severino, rig, ["use"], "Rig");
    const ws = await severino.core.nodeWorkspace("me", { fingerprint: n, name: "Rig" }, "p1");
    for (const command of ["ls /", "ls ~", "cat /etc/hostname", "rm -f prova-collaudo.txt"]) {
      const r = await ws.exec(command, { timeoutMs: 10_000 }).catch((e) => e);
      expect(r.code, command).toBe("refused");
      expect(r.message).toMatch(/no container/);
    }
    // Even what the person said yes to: there is nothing to keep it in.
    const approved = await ws
      .execApproved("ls /", { timeoutMs: 10_000 }, ["critical-delete", "critical-system"])
      .catch((e) => e);
    expect(approved.code).toBe("refused");
    // Files and storage: the asker's folder only, by real paths.
    await ws.writeText("a.txt", "inside");
    expect(await ws.readText("a.txt")).toBe("inside");
    const out = await ws.readText("../../../../../../etc/hostname").catch((e) => e);
    expect(out).toBeInstanceOf(Error);
    // What it offers says so, and the agents read it in node_list.
    const [known] = await severino.core.nodes.known("me");
    expect(known?.name).toBe("Rig");
    expect(known?.rights).toEqual(["use"]);
    expect(known?.view?.capabilities?.sandbox.container).toBe(false);
    const ctx = { ownerId: "me", projectId: null, agentId: null, sessionId: "s" };
    const [list] = nodeTools({
      nodes: () => severino.core.nodes.known("me"),
      pinned: async () => undefined,
      workspace: async () => ws,
      maxMs: () => 0,
    });
    expect(await list?.run({}, ctx)).toMatch(
      /^- Rig: online; no commands for you: it has no container/,
    );
    // The person on Rig takes «use» away: still listed on severino, as without permissions.
    const mine = (await state(rig)).grants[0];
    expect(
      (await rig.api("POST", "/api/nodes/grants/revoke", { target: n, id: mine?.id })).status,
    ).toBe(200);
    await severino.core.nodes.poll("me", n);
    const s = await state(severino);
    expect(s.tree.children.map((c) => [c.name, c.grants.length])).toEqual([["Rig", 0]]);
    expect((await severino.core.nodes.known("me"))[0]?.rights).toEqual([]);
    expect(await list?.run({}, ctx)).toMatch(/^- Rig: online; no permissions/);
    const denied = await ws.readText("a.txt").catch((e) => e);
    expect(denied.code).toBe("forbidden");
  }, 90_000);

  it("who manages it runs on the machine itself; the truly dangerous asks the person here first, «Sul nodo «Rig»», and a no sends nothing", async () => {
    const answers: string[] = [];
    const never = `~/rg-node-never-${Date.now()}.txt`;
    const steps = [
      { name: "node_run", input: { node: "Rig", command: "ls /" } },
      { name: "node_run", input: { node: "Rig", command: `rm -f ${never}` } },
      // Pinned for the agent, naming no node: the request still says which one.
      { name: "node_run", input: { command: "rm -f /c/Users/Pixel/Desktop/prova-collaudo.txt" } },
    ];
    const severino = await machine("severino", (req, i) => {
      const last = req.messages.at(-1)?.parts.find((p) => p.type === "tool_result") as
        | { content: string }
        | undefined;
      if (last) answers.push(last.content);
      const step = steps[i];
      return step ? { toolCalls: [step] } : { text: "Done." };
    });
    const rig = await machine("DESKTOP-8CCPHGB");
    const { n } = await pairUp(severino, rig, ["use", "admin"]);
    // Named after pairing, in Settings > Nodes.
    expect(
      (await severino.api("PUT", "/api/nodes/label", { fingerprint: n, name: "Rig" })).status,
    ).toBe(200);
    const g = await severino.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    await severino.api("PUT", "/api/nodes/placements", {
      scope: `agent:${g.body.id}`,
      commands: n,
    });
    const asked = person(severino, "deny");
    const { body } = await severino.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: g.body.id,
    });
    await (await severino.core.send("me", body.sessionId, "Clean up on Rig")).done;
    // Managed: on the machine itself, outside the sandbox too.
    expect(answers[0]).toMatch(/^Node: Rig\nExit code: 0/);
    // Both deletions were asked of the person, in red, naming the node; the no sent nothing.
    expect(asked.map((a) => a.critical?.map((c) => c.id))).toEqual([
      ["critical-delete"],
      ["critical-delete"],
    ]);
    expect(criticalSentences("it", asked[0] as PermissionRequestInfo)[0]).toMatch(
      /^Sul nodo «Rig»: /,
    );
    expect(criticalSentences("it", asked[1] as PermissionRequestInfo)[0]).toMatch(
      /^Sul nodo «Rig»: /,
    );
    expect(answers[1]).not.toMatch(/Exit code/);
    expect(answers[2]).not.toMatch(/Exit code/);
    const served = (await nodeEvents(rig)).filter(
      (e) => e.payload.side === "served" && e.payload.kind === "exec",
    );
    expect(served.map((e) => e.payload.what)).toEqual(["exec ls /"]);
    expect(served[0]?.payload.peerName).toBe("severino");
    // The node reads it again: without the person's yes it refuses, `~` being its real home.
    const ws = await severino.core.nodeWorkspace("me", { fingerprint: n, name: "Rig" }, "p1");
    const refused = await ws
      .execApproved(`rm -f ${never}`, { timeoutMs: 10_000 }, [])
      .catch((e) => e);
    expect(refused.message).toMatch(/Truly dangerous here/);
    // With the yes for exactly that, it runs (the file never existed: nothing is lost).
    const ok = await ws.execApproved(`rm -f ${never}`, { timeoutMs: 10_000 }, ["critical-delete"]);
    expect(ok.exitCode).toBe(0);
  }, 90_000);

  it("the person's name for the node holds when it reports its own, and goes back when cleared", async () => {
    const severino = await machine("severino");
    const rig = await machine("DESKTOP-8CCPHGB");
    const { n } = await pairUp(severino, rig, ["use", "admin"], "Rig");
    await severino.core.nodes.poll("me", n);
    expect((await state(severino)).tree.children[0]?.name).toBe("Rig");
    const pairLog = (await nodeEvents(severino)).find(
      (e) => e.payload.kind === "pair" && /confirmed/.test(e.payload.what),
    );
    expect(pairLog?.payload.peerName).toBe("Rig");
    await severino.api("PUT", "/api/nodes/label", { fingerprint: n, name: "" });
    expect((await state(severino)).tree.children[0]?.name).toBe("DESKTOP-8CCPHGB");
    const bad = await severino.api("PUT", "/api/nodes/label", {
      fingerprint: "SHA256:nobodyknowsthis",
      name: "X",
    });
    expect(bad.status).toBe(404);
  }, 90_000);
});
