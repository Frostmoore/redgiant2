// @vitest-environment jsdom
// The artifacts' bridge in the page (3.6, G38.7): a frame's call is taken only from that frame's own
// window and only in the right shape; it goes to the server with the artifact the page shows (never
// one the frame names), and the answer goes back to the window that asked, while it still shows
// the same load. Widgets have no bridge. The person's grant card says it in words, with the cap.
import {
  ARTIFACT_GRANT_TOOL,
  ARTIFACT_PENDING_MAX,
  type PermissionRequestInfo,
} from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../src/i18n.js";

const sent: { type: string; requestId?: string; [k: string]: unknown }[] = [];

vi.mock("../src/api.js", async (orig) => {
  const real = await orig<typeof import("../src/api.js")>();
  class Api {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: a stand-in for the whole API
      return new Proxy({}, { get: () => async () => [] });
    }
  }
  class Live {
    send(m: { type: string }) {
      sent.push(m);
    }
    close() {}
  }
  return { ...real, Api, Live };
});

const state = await import("../src/state.js");
const { bridgeRejection, frameMessage } = await import("../src/artifact-frame.js");
const { bridgeResult, forgetFrame, forwardBridge } = await import("../src/artifact-bridge.js");
const { ArtifactGrantCard } = await import("../src/components/ArtifactGrantCard.js");

beforeAll(async () => {
  await state.signIn("token").catch(() => {});
});
beforeEach(() => {
  setLang("it");
  sent.length = 0;
});
afterEach(() => cleanup());

/** A frame's window that keeps what it was sent. */
const win = () => {
  const got: { message: unknown; origin: string }[] = [];
  return { got, postMessage: (message: unknown, origin: string) => got.push({ message, origin }) };
};

const call = (params: unknown, id = 1) => ({
  jsonrpc: "2.0",
  method: "redgiant/bridge",
  id,
  params,
});
const FILE = { kind: "file" as const, scope: "project:shop", path: "artefatti/cruscotto.html" };

describe("bridge messages from a frame (3.6)", () => {
  it("takes a call only from its own frame's window, in the right shape", () => {
    const own = win();
    const frame = { contentWindow: own };
    const ok = call({ op: "files.read", path: "dati/vendite.csv" });
    expect(frameMessage({ source: own, data: ok }, frame)).toMatchObject({
      method: "redgiant/bridge",
      params: { op: "files.read", path: "dati/vendite.csv", as: "text" },
    });
    // Another artifact's frame, a child frame of this one, or the page itself: ignored.
    for (const source of [win(), {}, null, window])
      expect(frameMessage({ source, data: ok }, frame)).toBeUndefined();
    // Wrong shapes: nothing.
    for (const params of [
      { op: "files.write", path: "x" },
      { op: "storage.set", key: "a", value: 5 },
      { op: "storage.set", key: "", value: "x" },
      { op: "storage.get", key: "k".repeat(201) },
      { op: "ask", prompt: "" },
      { op: "ask", prompt: "x".repeat(20_001) },
      { op: "files.read", path: "p".repeat(1001) },
      { op: "files.read", path: "a", as: "exec" },
      "ask",
    ])
      expect(frameMessage({ source: own, data: call(params) }, frame)).toBeUndefined();
    expect(
      frameMessage({ source: own, data: call({ op: "ask", prompt: "x" }, -1) }, frame),
    ).toBeUndefined();
  });

  it("answers a call of the wrong shape with an error, only to its own frame", () => {
    const own = win();
    const frame = { contentWindow: own };
    expect(
      bridgeRejection({ source: own, data: call({ op: "files.write", path: "x" }, 4) }, frame),
    ).toEqual({
      id: 4,
      error: { code: "bad_request", message: expect.any(String) },
    });
    expect(
      bridgeRejection(
        {
          source: own,
          data: call({ op: "storage.set", key: "a", value: "x".repeat(5 * 1024 * 1024 + 1) }, 5),
        },
        frame,
      )?.error.code,
    ).toBe("too_big");
    // A good call, another window, another method, no id: nothing to say.
    expect(
      bridgeRejection({ source: own, data: call({ op: "storage.get", key: "a" }) }, frame),
    ).toBeUndefined();
    expect(bridgeRejection({ source: win(), data: call({ op: "x" }) }, frame)).toBeUndefined();
    expect(
      bridgeRejection({ source: own, data: { method: "ui/message", id: 1 } }, frame),
    ).toBeUndefined();
    expect(
      bridgeRejection({ source: own, data: { method: "redgiant/bridge", params: {} } }, frame),
    ).toBeUndefined();
  });

  it("sends the page's artifact, never one the frame names", () => {
    const own = win();
    const m = frameMessage(
      {
        source: own,
        data: call({
          op: "storage.get",
          key: "k",
          scope: "platform",
          path: "artefatti/altro.html",
          ref: { kind: "file" },
        }),
      },
      { contentWindow: own },
    );
    if (m?.method !== "redgiant/bridge") throw new Error("not a bridge call");
    forwardBridge(m, {
      win: own,
      owner: {},
      ref: FILE,
      sessionId: "sess_1",
      current: () => true,
      send: (x) => sent.push(x),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "artifact.bridge", ref: FILE, sessionId: "sess_1" });
    expect(sent[0]?.call).toEqual({ op: "storage.get", key: "k" });
  });

  it("answers the window that asked, only while it shows the same load", () => {
    const a = win();
    const b = win();
    const ownerA = {};
    let loadA = 1;
    const m = {
      method: "redgiant/bridge" as const,
      id: 7,
      params: { op: "storage.get" as const, key: "k" },
    };
    forwardBridge(m, {
      win: a,
      owner: ownerA,
      ref: FILE,
      current: () => loadA === 1,
      send: (x) => sent.push(x),
    });
    forwardBridge(
      { ...m, id: 8 },
      { win: b, owner: {}, ref: FILE, current: () => true, send: (x) => sent.push(x) },
    );
    const [first, second] = sent;
    bridgeResult({ requestId: first?.requestId ?? "", result: { value: "v" } });
    expect(a.got).toEqual([
      {
        message: {
          jsonrpc: "2.0",
          method: "redgiant/bridge-result",
          id: 7,
          result: { value: "v" },
        },
        origin: "*",
      },
    ]);
    expect(b.got).toEqual([]);
    // Answered twice, or for nobody: nothing more.
    bridgeResult({ requestId: first?.requestId ?? "", result: { value: "again" } });
    bridgeResult({ requestId: "b-unknown", result: { value: "x" } });
    expect(a.got).toHaveLength(1);
    // The other frame reloaded meanwhile (another load): its answer is dropped.
    forwardBridge(
      { ...m, id: 9 },
      { win: a, owner: ownerA, ref: FILE, current: () => loadA === 1, send: (x) => sent.push(x) },
    );
    loadA = 2;
    bridgeResult({
      requestId: sent[2]?.requestId ?? "",
      result: { value: "old" },
    });
    expect(a.got).toHaveLength(1);
    // An error reaches the frame as such.
    bridgeResult({ requestId: second?.requestId ?? "", error: { code: "denied", message: "no" } });
    expect(b.got[0]?.message).toMatchObject({ id: 8, error: { code: "denied", message: "no" } });
  });

  it("widgets have no bridge; too many calls waiting are refused; a closed frame is forgotten", () => {
    const w = win();
    const m = {
      method: "redgiant/bridge" as const,
      id: 1,
      params: { op: "storage.get" as const, key: "k" },
    };
    forwardBridge(m, {
      win: w,
      owner: {},
      ref: { kind: "widget", sessionId: "s1", seq: 3, index: 0 },
      current: () => true,
      send: (x) => sent.push(x),
    });
    expect(sent).toEqual([]);
    expect(w.got[0]?.message).toMatchObject({ error: { code: "unavailable" } });
    const owner = {};
    const flood = win();
    for (let i = 0; i < ARTIFACT_PENDING_MAX + 3; i++)
      forwardBridge(
        { ...m, id: i },
        { win: flood, owner, ref: FILE, current: () => true, send: (x) => sent.push(x) },
      );
    expect(sent).toHaveLength(ARTIFACT_PENDING_MAX);
    expect(
      flood.got.filter(
        (g) => (g.message as { error?: { code: string } }).error?.code === "rate_limited",
      ),
    ).toHaveLength(3);
    forgetFrame(owner);
    for (const s of sent) bridgeResult({ requestId: s.requestId ?? "", result: {} });
    expect(flood.got).toHaveLength(3);
  });
});

describe("the grant card (3.6)", () => {
  const request = (capability: string): PermissionRequestInfo => ({
    requestId: `art_${capability}`,
    agentId: "agent_a",
    agentName: "Analista",
    projectId: "shop",
    tool: ARTIFACT_GRANT_TOOL,
    input: {
      artifact: "Cruscotto",
      scope: "project:shop",
      path: "artefatti/cruscotto.html",
      capability,
      agent: "Analista",
    },
    reasons: [],
    danger: [],
    createdAt: "2026-11-12T10:00:00.000Z",
  });

  it("says what it asks in words and sends the cap the person picked", async () => {
    const { container, getByText } = render(<ArtifactGrantCard r={request("ask")} />);
    expect(container.textContent).toContain(
      "L'artefatto «Cruscotto» chiede di fare domande a «Analista»",
    );
    expect(container.textContent).toContain("artefatti/cruscotto.html");
    expect(container.querySelector("input")).toBeNull();
    fireEvent.click(getByText("2 $"));
    await new Promise((r) => setTimeout(r, 700));
    const yes = getByText("Consenti, fino a 2 $");
    await waitFor(() => expect((yes as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(yes);
    expect(sent.at(-1)).toMatchObject({
      type: "permission.resolve",
      requestId: "art_ask",
      decision: "allow",
      capUsd: 2,
    });
  });

  it("a folder: read only, said so; no cap", () => {
    const { container } = render(<ArtifactGrantCard r={request("files:dati/")} />);
    expect(container.textContent).toContain(
      "leggere i file della cartella dati/ del progetto (solo lettura)",
    );
    expect(container.textContent).not.toContain("Tetto");
  });
});
