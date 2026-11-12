import { type ClientMessage, PROTOCOL_VERSION, type ServerMessage } from "@redgiant/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thin client over the HTTP API and the live WebSocket channel. */
export class RedGiantClient {
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}

  async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.url.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
    return data as T;
  }

  /** Opens the live channel; resolves after the server's welcome. */
  live(
    onMessage: (m: ServerMessage) => void,
    /** The channel closed after it opened (the server stopped or restarted). */
    onClose?: () => void,
  ): Promise<{ send: (m: ClientMessage) => void; close: () => void }> {
    const ws = new WebSocket(`${this.url.replace(/^http/, "ws").replace(/\/$/, "")}/ws`);
    return new Promise((ok, ko) => {
      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, token: this.token }),
        );
      });
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data)) as ServerMessage;
        if (m.type === "welcome")
          ok({ send: (x) => ws.send(JSON.stringify(x)), close: () => ws.close() });
        onMessage(m);
      });
      ws.addEventListener("close", (e) => {
        ko(new Error(`Connection closed (${e.code} ${e.reason})`));
        onClose?.();
      });
      ws.addEventListener("error", () => ko(new Error(`Cannot connect to ${this.url}`)));
    });
  }
}
