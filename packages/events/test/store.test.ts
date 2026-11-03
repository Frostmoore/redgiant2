import type { Event } from "@redgiant/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { EventStore, migrate, Redactor, type SqlClient, verifyEvents } from "../src/index.js";
import { memoryDb } from "./pglite.js";

let db: SqlClient;
let store: EventStore;

const user = (text: string) => ({ type: "message.user" as const, payload: { text } });

beforeEach(async () => {
  ({ db } = await memoryDb());
  await migrate(db);
  await migrate(db); // idempotent
  let t = Date.UTC(2026, 9, 31, 10);
  let n = 0;
  store = new EventStore(db, {
    now: () => {
      t += 1000;
      return new Date(t);
    },
    newId: () => `evt_${n++}`,
  });
});

describe("EventStore", () => {
  it("chains events and verifies the chain", async () => {
    const a = await store.append({ sessionId: "s1", projectId: "p1", body: user("one") });
    const b = await store.append({ sessionId: "s1", projectId: "p1", body: user("two") });
    expect(a.seq).toBe(0);
    expect(a.prevHash).toBeNull();
    expect(b.prevHash).toBe(a.hash);
    expect(await store.verify()).toEqual({ ok: true, checked: 2 });
    const listed = await store.list({ sessionId: "s1" });
    expect(listed.map((e) => e.payload)).toEqual([{ text: "one" }, { text: "two" }]);
    expect(listed[0]).toEqual(a);
  });

  it("serialises concurrent appends into one gap-free chain", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append({ body: user(`m${i}`) })));
    const all = await store.list();
    expect(all.map((e) => e.seq)).toEqual([...Array(20).keys()]);
    expect((await store.verify()).ok).toBe(true);
  });

  it("refuses DELETE and arbitrary UPDATE at the database level", async () => {
    await store.append({ body: user("keep me") });
    await expect(db.query("DELETE FROM rg_events")).rejects.toThrow(/append-only/);
    await expect(
      db.query("UPDATE rg_events SET payload = $1", ['{"text":"forged"}']),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query("UPDATE rg_events SET type = 'x', payload = NULL, erased = true"),
    ).rejects.toThrow(/append-only/);
  });

  it("detects tampering in an exported log", async () => {
    for (const t of ["a", "b", "c"]) await store.append({ body: user(t) });
    const lines: string[] = [];
    for await (const l of store.exportJsonl()) lines.push(l);
    const events = lines.map((l) => JSON.parse(l) as Event);
    expect(verifyEvents(events).ok).toBe(true);

    const forged = structuredClone(events);
    (forged[1] as { payload: unknown }).payload = { text: "B" };
    expect(verifyEvents(forged)).toMatchObject({ ok: false, seq: 1, reason: /payload/ });

    const relinked = structuredClone(events);
    relinked[2] = { ...relinked[2], prevHash: "0".repeat(64) } as Event;
    expect(verifyEvents(relinked)).toMatchObject({ ok: false, seq: 2 });

    const dropped = [events[0], events[2]] as Event[];
    expect(verifyEvents(dropped).ok).toBe(true); // a gap is not a forgery, but...
    expect(dropped[1]?.prevHash).toBe(events[1]?.hash); // ...the link shows what is missing
  });

  it("erases a payload, records the erasure and keeps the chain valid", async () => {
    const secret = await store.append({ body: user("my address is 1 Main St") });
    await store.append({ body: user("next") });
    const red = await store.erase(secret.seq, "data-protection request");
    expect(red.type).toBe("redaction");
    const [erased] = await store.list({ fromSeq: 0, limit: 1 });
    expect(erased).toMatchObject({ erased: true, payload: null, hash: secret.hash });
    expect(await store.verify()).toEqual({ ok: true, checked: 3 });
  });

  it("erases old payloads for retention, in one go, and the chain stays valid", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const s = new EventStore(db, { now: () => now });
    const before = (await s.list({})).length;
    await s.append({ body: user("old 1") });
    await s.append({ body: user("old 2") });
    now = new Date("2026-03-01T00:00:00Z");
    await s.append({ body: user("recent") });
    const cutoff = new Date("2026-02-01T00:00:00Z");
    expect(await s.eraseBefore(cutoff, "retention 30 days")).toBe(before + 2);
    const all = await s.list({});
    expect(all.map((e) => e.erased)).toEqual([...Array(before + 2).fill(true), false, false]);
    expect(all.at(-1)).toMatchObject({
      type: "redaction",
      payload: { reason: `retention 30 days (${before + 2} events)` },
    });
    expect(await s.eraseBefore(cutoff, "again")).toBe(0);
    expect(await s.verify()).toEqual({ ok: true, checked: before + 4 });
  });

  it("redacts secrets before they are hashed and stored", async () => {
    const redactor = new Redactor().addSecret("telegram", "my-very-private-value");
    const s = new EventStore(db, { redactor });
    const e = await s.append({
      body: user(
        "key sk-ant-api03-abcdefghijklmnopqrstuvwx and my-very-private-value, Bearer abcdefghijklmnopqrstuvwxyz123",
      ),
    });
    expect(e.payload).toEqual({
      text: "key [REDACTED:anthropic-key] and [REDACTED:telegram], Bearer [REDACTED:bearer]",
    });
    const [stored] = await db.query<{ payload: string }>("SELECT payload FROM rg_events");
    expect(stored?.payload).not.toMatch(/sk-ant|private-value/);
  });

  it("notifies subscribers after commit", async () => {
    const seen: number[] = [];
    const off = store.subscribe((e) => seen.push(e.seq));
    await store.append({ body: user("x") });
    off();
    await store.append({ body: user("y") });
    expect(seen).toEqual([0]);
  });
});

describe("Redactor", () => {
  it("catches common key formats and private keys", () => {
    const r = new Redactor();
    const text = [
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAABCDEFGHIJKLMNOP",
      "hf_abcdefghijklmnopqrstuvwxyz0123456",
      "123456789:AAbbccddeeffgghhiijjkkllmmnnooppqqr",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
      "sk-proj-abc1defghijklmnopqrstuvwx",
    ].join(" ");
    const out = r.redactText(text);
    expect(out.count).toBe(6);
    expect(out.text).not.toMatch(/ghp_|AKIA|hf_|AAbb|OPENSSH|sk-proj/);
  });

  it("leaves ordinary text alone", () => {
    expect(new Redactor().redactText("the sky is blue; sk-short").count).toBe(0);
    // A link of a search result is not a key (2026-11-04: "elon-musk-s-2026-political-…").
    const url =
      "https://www.today.com/video/inside-look-at-elon-musk-s-2026-political-spending-spree-250812";
    expect(new Redactor().redactText(url).text).toBe(url);
  });
});
