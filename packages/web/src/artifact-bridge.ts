// The artifacts' bridge on the page's side (3.6, G38.7, study §4.3): a frame's `redgiant/bridge`
// call (already checked: its source is that frame's window, its shape is `BridgeFrameMessage`)
// goes to the server over the WebSocket with the artifact the page shows in that frame, never one
// the frame names; the answer goes back to that same window only, and only while it still shows
// the same load (a reload drops what the page before it asked).
import {
  ARTIFACT_PENDING_MAX,
  type ArtifactRef,
  type BridgeError,
  type BridgeFrameMessage,
} from "@redgiant/protocol";

/** The window of a frame, as far as the bridge needs it. */
export interface FrameWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface Pending {
  win: FrameWindow;
  id: number;
  /** Still the same frame and load: otherwise the answer is dropped. */
  current: () => boolean;
  timer: ReturnType<typeof setTimeout>;
  owner: object;
}

/** The longest a call waits (a grant waits for the person, then the model answers). */
const WAIT_MS = 15 * 60_000;

const pending = new Map<string, Pending>();
let seq = 0;

const reply = (p: Pending, body: { result?: unknown; error?: BridgeError }) => {
  if (!p.current()) return;
  try {
    p.win.postMessage({ jsonrpc: "2.0", method: "redgiant/bridge-result", id: p.id, ...body }, "*");
  } catch {}
};

/** Calls waiting for one frame. */
export const waitingFor = (owner: object) =>
  [...pending.values()].filter((p) => p.owner === owner).length;

/**
 * Forwards a frame's bridge call. `owner` identifies the frame on the page (its component),
 * `current` says whether the window still shows the load that asked. Widgets have no bridge.
 */
export function forwardBridge(
  m: BridgeFrameMessage,
  o: {
    win: FrameWindow;
    owner: object;
    ref: ArtifactRef;
    sessionId?: string | undefined;
    current: () => boolean;
    send: (msg: {
      type: "artifact.bridge";
      requestId: string;
      ref: ArtifactRef;
      sessionId?: string;
      call: BridgeFrameMessage["params"];
    }) => void;
  },
): void {
  const local = (error: BridgeError) =>
    reply(
      { win: o.win, id: m.id, current: o.current, timer: 0 as never, owner: o.owner },
      { error },
    );
  if (o.ref.kind !== "file") {
    local({
      code: "unavailable",
      message: "Widgets have no bridge: keep it as an artifact first («Keep it»)",
    });
    return;
  }
  if (waitingFor(o.owner) >= ARTIFACT_PENDING_MAX) {
    local({ code: "rate_limited", message: "Too many bridge calls waiting" });
    return;
  }
  const requestId = `b${Date.now().toString(36)}${(++seq).toString(36)}`;
  const p: Pending = {
    win: o.win,
    id: m.id,
    current: o.current,
    owner: o.owner,
    timer: setTimeout(() => {
      pending.delete(requestId);
      reply(p, { error: { code: "failed", message: "No answer from RedGiant" } });
    }, WAIT_MS),
  };
  pending.set(requestId, p);
  try {
    o.send({
      type: "artifact.bridge",
      requestId,
      ref: o.ref,
      ...(o.sessionId && { sessionId: o.sessionId }),
      call: m.params,
    });
  } catch {
    clearTimeout(p.timer);
    pending.delete(requestId);
    local({ code: "failed", message: "RedGiant is not connected" });
  }
}

/** The server's answer (`artifact.bridge.result`): to the frame that asked, if it still shows it. */
export function bridgeResult(m: {
  requestId: string;
  result?: unknown;
  error?: BridgeError;
}): void {
  const p = pending.get(m.requestId);
  if (!p) return;
  pending.delete(m.requestId);
  clearTimeout(p.timer);
  reply(p, m.error ? { error: m.error } : { result: m.result ?? {} });
}

/** A frame goes away: what it asked is forgotten (answers to it are dropped). */
export function forgetFrame(owner: object): void {
  for (const [k, p] of pending)
    if (p.owner === owner) {
      clearTimeout(p.timer);
      pending.delete(k);
    }
}
