// G36.9: Matrix, Microsoft Teams and iMessage as chat platforms of the server.
import { IMessageTransport, MatrixTransport, TeamsTransport } from "@redgiant/gateway";
import { ChatPlatform, NotifyTarget } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { ChatSettings, PLATFORMS, transportFor } from "../src/chats.js";
import { startServer } from "./helpers.js";

const GUID = "11111111-2222-3333-4444-555555555555";

describe("chat platforms of G36.9", () => {
  it("are known everywhere: settings, automations' triggers and deliveries", () => {
    for (const p of ["matrix", "teams", "imessage"] as const) {
      expect(PLATFORMS).toContain(p);
      expect(ChatPlatform.options).toContain(p);
      expect(NotifyTarget.options).toContain(p);
    }
  });

  it("check their settings before a connection is tried", () => {
    expect(
      ChatSettings.matrix.safeParse({
        homeserver: "https://matrix.org",
        accessToken: "syt_x".repeat(4),
      }).success,
    ).toBe(true);
    expect(
      ChatSettings.matrix.safeParse({ homeserver: "matrix.org", accessToken: "syt_x".repeat(4) })
        .success,
    ).toBe(false);
    expect(
      ChatSettings.teams.safeParse({
        appId: ` ${GUID} `,
        appPassword: "secret-value",
        tenantId: GUID,
      }).data?.appId,
    ).toBe(GUID);
    expect(
      ChatSettings.teams.safeParse({ appId: "my-bot", appPassword: "secret-value", tenantId: GUID })
        .success,
    ).toBe(false);
    expect(
      ChatSettings.imessage.safeParse({
        url: "http://192.168.1.20:1234",
        password: "pw",
        privateApi: "on",
      }).success,
    ).toBe(true);
    expect(ChatSettings.imessage.safeParse({ url: "ftp://mac", password: "pw" }).success).toBe(
      false,
    );
  });

  it("make their own transports", () => {
    expect(
      transportFor("matrix", { homeserver: "https://matrix.org", accessToken: "syt_x".repeat(4) }),
    ).toBeInstanceOf(MatrixTransport);
    expect(
      transportFor("teams", { appId: GUID, appPassword: "secret-value", tenantId: GUID }),
    ).toBeInstanceOf(TeamsTransport);
    expect(transportFor("imessage", { url: "http://mac:1234", password: "pw" })).toBeInstanceOf(
      IMessageTransport,
    );
  });

  it("Teams' webhook is reachable without RedGiant's token, and refuses when Teams is off", async () => {
    const s = await startServer([]);
    try {
      const r = await fetch(`${s.url}/api/chats/teams/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "message" }),
      });
      expect(r.status).toBe(403);
      // The app package needs the person's token, and Teams set up.
      expect((await fetch(`${s.url}/api/chats/teams/app.zip`)).status).toBe(401);
      expect((await s.api("GET", "/api/chats/teams/app.zip")).status).toBe(400);
    } finally {
      await s.close();
    }
  });
});
