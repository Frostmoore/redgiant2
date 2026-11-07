import { generateKeyPairSync, sign } from "node:crypto";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Incoming } from "../src/bridge.js";
import { teamsAppPackage, teamsManifest } from "../src/teams-app.js";
import { type TeamsActivity, TeamsTransport, teamsText } from "../src/teams.js";

// ---------- Microsoft, simulated: sign-in, the Bot Connector's keys, the conversations API ----------

const APP = "11111111-2222-3333-4444-555555555555";
const TENANT = "99999999-8888-7777-6666-555555555555";
const SERVICE = "https://smba.trafficmanager.net/emea/";
const NOW = 1_800_000_000_000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", endorsements: ["msteams"] };

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function jwt(claims: Record<string, unknown>, o: { kid?: string; key?: typeof privateKey } = {}) {
  const head = b64({ alg: "RS256", typ: "JWT", kid: o.kid ?? "k1" });
  const body = b64(claims);
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), o.key ?? privateKey);
  return `Bearer ${head}.${body}.${sig.toString("base64url")}`;
}

const good = (extra: Record<string, unknown> = {}) =>
  jwt({
    iss: "https://api.botframework.com",
    aud: APP,
    exp: NOW / 1000 + 600,
    nbf: NOW / 1000 - 10,
    serviceurl: SERVICE,
    ...extra,
  });

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

function fakeMicrosoft(o: { secret?: string } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const headers = new Headers(init?.headers);
    const c: Call = {
      method: init?.method ?? "GET",
      url,
      auth: headers.get("authorization"),
      body:
        typeof raw === "string"
          ? raw.startsWith("{")
            ? JSON.parse(raw)
            : Object.fromEntries(new URLSearchParams(raw))
          : raw
            ? Buffer.from(raw as Uint8Array).toString()
            : undefined,
    };
    calls.push(c);
    if (url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
      const form = c.body as Record<string, string>;
      if (form.client_secret !== (o.secret ?? "s3cret-value"))
        return Response.json(
          { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret" },
          { status: 401 },
        );
      return Response.json({ access_token: "bot-token", expires_in: 3600 });
    }
    if (url === "https://login.botframework.com/v1/.well-known/openidconfiguration")
      return Response.json({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" });
    if (url === "https://login.botframework.com/v1/.well-known/keys")
      return Response.json({ keys: [jwk] });
    if (url.endsWith("/discovery/v2.0/keys")) return Response.json({ keys: [] });
    if (url.startsWith(`${SERVICE}v3/conversations/`)) {
      n += 1;
      return Response.json({ id: `act${n}` });
    }
    if (url === "https://contoso.sharepoint.com/download/a.pdf") return new Response("PDF");
    if (url === `${SERVICE}v3/attachments/img1`)
      return c.auth === "Bearer bot-token"
        ? new Response("IMG")
        : new Response("no", { status: 401 });
    if (url === "https://upload.example/onedrive") return new Response("", { status: 201 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

function make(o: { secret?: string } = {}) {
  const f = fakeMicrosoft(o);
  const t = new TeamsTransport({
    appId: APP,
    appPassword: o.secret ?? "s3cret-value",
    tenantId: TENANT,
    fetch: f.fetch,
    now: () => NOW,
  });
  return { t, calls: f.calls };
}

const msg = (a: Partial<TeamsActivity> = {}): TeamsActivity => ({
  type: "message",
  id: "m1",
  text: "hello",
  serviceUrl: SERVICE,
  from: { id: "29:anna", name: "Anna Rossi" },
  conversation: { id: "a:conv1", conversationType: "personal", tenantId: TENANT },
  recipient: { id: `28:${APP}` },
  ...a,
});

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("TeamsTransport", () => {
  it("refuses to start with a wrong secret", async () => {
    const f = fakeMicrosoft();
    const t = new TeamsTransport({
      appId: APP,
      appPassword: "wrong-one",
      tenantId: TENANT,
      fetch: f.fetch,
    });
    await expect(t.start(async () => {})).rejects.toThrow(/invalid_client/);
  });

  it("takes only activities Microsoft signed for this bot", async () => {
    const got: Incoming[] = [];
    const { t } = make();
    await t.start(async (m) => {
      got.push(m);
    });
    const body = JSON.stringify(msg());
    expect((await t.webhook(body, undefined)).status).toBe(401);
    expect((await t.webhook(body, "Bearer nonsense")).status).toBe(401);
    // Signed with a key Microsoft never published.
    expect(
      (
        await t.webhook(
          body,
          jwt(
            { iss: "https://api.botframework.com", aud: APP, exp: NOW / 1000 + 600 },
            { key: other.privateKey },
          ),
        )
      ).status,
    ).toBe(401);
    // For another bot, expired, from another issuer, about another serviceUrl.
    expect((await t.webhook(body, good({ aud: "someone-else" }))).status).toBe(401);
    expect((await t.webhook(body, good({ exp: NOW / 1000 - 3600 }))).status).toBe(401);
    expect((await t.webhook(body, good({ iss: "https://evil.example" }))).status).toBe(401);
    expect((await t.webhook(body, good({ serviceurl: "https://evil.example/" }))).status).toBe(401);
    expect(got).toHaveLength(0);
    expect((await t.webhook(body, good())).status).toBe(200);
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual({
      userId: "29:anna",
      chatId: `${SERVICE}|a:conv1`,
      username: "Anna Rossi",
      text: "hello",
    });
  });

  it("reads mentions and HTML as plain words, card buttons as buttons", async () => {
    const got: Incoming[] = [];
    const { t } = make();
    await t.start(async (m) => {
      got.push(m);
    });
    await t.webhook(
      JSON.stringify(msg({ text: "<at>RedGiant</at> <p>/start 123456</p>" })),
      good(),
    );
    await t.webhook(
      JSON.stringify(msg({ text: "", value: { rgButton: "perm:r1:allow" } })),
      good(),
    );
    await waitFor(() => got.length === 2);
    expect(got[0]?.text).toBe("/start 123456");
    expect(got[1]?.button).toBe("perm:r1:allow");
    expect(teamsText("a &amp; b<br>c &lt;d&gt;")).toBe("a & b\nc <d>");
  });

  it("downloads files from OneDrive and pictures with the bot's token", async () => {
    const got: Incoming[] = [];
    const { t } = make();
    await t.start(async (m) => {
      got.push(m);
    });
    await t.webhook(
      JSON.stringify(
        msg({
          text: "look",
          attachments: [
            {
              contentType: "application/vnd.microsoft.teams.file.download.info",
              name: "a.pdf",
              content: {
                downloadUrl: "https://contoso.sharepoint.com/download/a.pdf",
                fileType: "pdf",
              },
            },
            {
              contentType: "image/png",
              contentUrl: `${SERVICE}v3/attachments/img1`,
              name: "shot.png",
            },
            { contentType: "text/html", content: {} },
          ],
        }),
      ),
      good(),
    );
    await waitFor(() => got.length === 1);
    expect(got[0]?.files?.map((f) => [f.name, f.mime, f.data.toString()])).toEqual([
      ["a.pdf", "application/pdf", "PDF"],
      ["shot.png", "image/png", "IMG"],
    ]);
  });

  it("sends text, cards with buttons, edits, typing to the conversation's service", async () => {
    const { t, calls } = make();
    await t.start(async () => {});
    const chat = `${SERVICE}|a:conv1`;
    await t.send(chat, "hi");
    const id = await t.send(chat, "Approve?", [
      { id: "perm:r1:allow", label: "Allow" },
      { id: "perm:r1:deny", label: "Deny" },
    ]);
    await t.edit(chat, id as string, "Approve?\n\nAllowed");
    await t.typing(chat);
    const acts = calls.filter((c) => c.url.startsWith(`${SERVICE}v3/`));
    expect(acts.every((c) => c.auth === "Bearer bot-token")).toBe(true);
    expect(acts[0]?.url).toBe(`${SERVICE}v3/conversations/a%3Aconv1/activities`);
    expect(acts[0]?.body).toEqual({ type: "message", text: "hi" });
    const card = (
      acts[1]?.body as { attachments: { content: { actions: unknown[] } }[] } | undefined
    )?.attachments[0];
    expect(card?.content.actions).toEqual([
      {
        type: "Action.Submit",
        title: "Allow",
        data: { rgButton: "perm:r1:allow" },
        style: "positive",
      },
      { type: "Action.Submit", title: "Deny", data: { rgButton: "perm:r1:deny" } },
    ]);
    expect(acts[2]?.method).toBe("PUT");
    expect(acts[2]?.url).toBe(`${SERVICE}v3/conversations/a%3Aconv1/activities/${id}`);
    expect(acts[2]?.body).toEqual({
      type: "message",
      id,
      text: "Approve?\n\nAllowed",
      attachments: [],
    });
    expect(acts[3]?.body).toEqual({ type: "typing" });
    // One sign-in for all of them.
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(1);
  });

  it("sends a big file through the consent card, uploads it once accepted", async () => {
    const { t, calls } = make();
    await t.start(async () => {});
    const chat = `${SERVICE}|a:conv1`;
    const data = Buffer.alloc(40_000, 65);
    await t.sendFile(chat, data, "report.pdf", "application/pdf", "The report");
    const consent = calls.at(-1)?.body as {
      attachments: {
        contentType: string;
        content: { acceptContext: { rgFile: string }; sizeInBytes: number };
      }[];
    };
    expect(consent.attachments[0]?.contentType).toBe(
      "application/vnd.microsoft.teams.card.file.consent",
    );
    expect(consent.attachments[0]?.content.sizeInBytes).toBe(40_000);
    const ctx = consent.attachments[0]?.content.acceptContext;
    const r = await t.webhook(
      JSON.stringify(
        msg({
          type: "invoke",
          name: "fileConsent/invoke",
          value: {
            type: "fileUpload",
            action: "accept",
            context: ctx,
            uploadInfo: {
              uploadUrl: "https://upload.example/onedrive",
              contentUrl: "https://contoso-my.sharepoint.com/report.pdf",
              name: "report.pdf",
              uniqueId: "u1",
              fileType: "pdf",
            },
          },
        }),
      ),
      good(),
    );
    expect(r).toEqual({ status: 200, body: { status: 200 } });
    await waitFor(() => calls.some((c) => c.url === "https://upload.example/onedrive"));
    await waitFor(
      () =>
        (calls.at(-1)?.body as { attachments?: { contentType: string }[] })?.attachments?.[0]
          ?.contentType === "application/vnd.microsoft.teams.card.file.info",
    );
    const put = calls.find((c) => c.url === "https://upload.example/onedrive");
    expect(put?.method).toBe("PUT");
    expect(put?.auth).toBeNull();
    expect(String(put?.body).length).toBe(40_000);
    // A second "accept" for the same file does nothing.
    const before = calls.length;
    await t.webhook(
      JSON.stringify(
        msg({
          type: "invoke",
          name: "fileConsent/invoke",
          value: {
            action: "accept",
            context: ctx,
            uploadInfo: { uploadUrl: "https://upload.example/onedrive" },
          },
        }),
      ),
      good(),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(before);
  });

  it("sends a small picture inline", async () => {
    const { t, calls } = make();
    await t.start(async () => {});
    await t.sendFile(`${SERVICE}|a:conv1`, Buffer.from("PNGDATA"), "x.png", "image/png");
    const body = calls.at(-1)?.body as { attachments: { contentUrl: string }[] };
    expect(body.attachments[0]?.contentUrl).toBe(
      `data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}`,
    );
  });
});

// ---------- The app package: a zip Teams accepts ----------

/** Reads a stored or deflated zip back (enough for our own files). */
function unzip(zip: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString();
    const localName = zip.readUInt16LE(local + 26);
    const extra = zip.readUInt16LE(local + 28);
    out[name] = zip.subarray(local + 30 + localName + extra, local + 30 + localName + extra + size);
    at += 46 + nameLen;
  }
  return out;
}

describe("teamsAppPackage", () => {
  it("holds a manifest naming the bot and two PNG icons of the sizes Teams asks", () => {
    const files = unzip(teamsAppPackage({ appId: APP, host: "rg.example.org" }));
    expect(Object.keys(files).sort()).toEqual(["color.png", "manifest.json", "outline.png"]);
    const manifest = JSON.parse(files["manifest.json"]?.toString() ?? "{}");
    expect(manifest).toEqual(teamsManifest({ appId: APP, host: "rg.example.org" }));
    expect(manifest.id).toBe(APP);
    expect(manifest.bots[0]).toMatchObject({ botId: APP, supportsFiles: true });
    expect(manifest.validDomains).toEqual(["rg.example.org"]);
    for (const [name, size] of [
      ["color.png", 192],
      ["outline.png", 32],
    ] as const) {
      const png = files[name] as Buffer;
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
      const idat = png.indexOf("IDAT");
      const len = png.readUInt32BE(idat - 4);
      expect(inflateSync(png.subarray(idat + 4, idat + 4 + len)).length).toBe(
        (size * 4 + 1) * size,
      );
    }
  });
});
