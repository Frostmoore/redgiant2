// G36.21: RedGiant's address as the person types it, which browser this is, the generator, the
// icon drawn at build time and the words in both languages.
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a build script in plain JavaScript
import { drawIcon, iconPng } from "../scripts/icons.mjs";
import { dictionaries, setLang, t } from "../src/i18n.js";
import { browserKind, homeHost, serverOrigin } from "../src/link.js";
import { generatePassword, SETS } from "../src/password.js";

describe("serverOrigin", () => {
  const table: [string, string | "bad" | "insecure"][] = [
    ["http://localhost:7650", "http://localhost:7650"],
    ["localhost:7650", "http://localhost:7650"],
    ["127.0.0.1:7650/settings", "http://127.0.0.1:7650"],
    ["192.168.1.12:7650", "http://192.168.1.12:7650"],
    ["http://nas.local:7650", "http://nas.local:7650"],
    ["http://redgiant:7650", "http://redgiant:7650"],
    ["redgiant.example.com", "https://redgiant.example.com"],
    ["https://redgiant.example.com/#/settings", "https://redgiant.example.com"],
    ["HTTPS://RedGiant.Example.com:8443", "https://redgiant.example.com:8443"],
    // Away from home only https: the code and the passwords never travel in the clear.
    ["http://redgiant.example.com", "insecure"],
    ["http://8.8.8.8:7650", "insecure"],
    ["", "bad"],
    ["ftp://localhost", "bad"],
    ["javascript:alert(1)", "bad"],
    ["https://user:pw@redgiant.example.com", "bad"],
    ["http://[::1]:7650", "http://[::1]:7650"],
  ];
  for (const [typed, want] of table)
    it(`${typed || "(empty)"} → ${want}`, () => {
      const r = serverOrigin(typed);
      if (want === "bad" || want === "insecure") expect(r).toEqual({ ok: false, why: want });
      else expect(r).toEqual({ ok: true, origin: want });
    });

  it("knows what stays at home", () => {
    for (const h of [
      "localhost",
      "10.0.0.2",
      "172.20.1.1",
      "100.100.1.1",
      "router",
      "nas.lan",
      "pc.home.arpa",
      "box.tail1234.ts.net",
      "[::1]",
      "fd00::1",
    ])
      expect(homeHost(h), h).toBe(true);
    for (const h of ["172.32.0.1", "8.8.8.8", "example.com", "localhost.evil.com", "2001:db8::1"])
      expect(homeHost(h), h).toBe(false);
  });
});

describe("browserKind", () => {
  const chrome =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  it("tells the browsers apart", () => {
    expect(browserKind({ userAgent: `${chrome} OPR/126.0.0.0` })).toBe("opera");
    expect(browserKind({ userAgent: `${chrome} Edg/141.0.0.0` })).toBe("edge");
    expect(browserKind({ userAgent: chrome, brave: {} })).toBe("brave");
    expect(browserKind({ userAgent: chrome })).toBe("chrome");
    expect(
      browserKind({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
      }),
    ).toBe("firefox");
    expect(browserKind({ userAgent: "curl/8" })).toBe("other");
  });
});

describe("generatePassword", () => {
  it("makes passwords of the asked length from the asked letters", () => {
    for (const kind of ["symbols", "letters", "digits"] as const) {
      const p = generatePassword(40, kind);
      expect(p).toHaveLength(40);
      expect([...p].every((c) => SETS[kind].includes(c))).toBe(true);
    }
    expect(generatePassword(20, "symbols")).not.toBe(generatePassword(20, "symbols"));
  });
});

describe("the icon", () => {
  it("is a real PNG of the asked size, red with the white key", () => {
    const png: Buffer = iconPng(48);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(48);
    const px: Uint8Array = drawIcon(48);
    // A corner is transparent, the middle of the square red or white, never anything else.
    expect(px[3]).toBe(0);
    const at = (x: number, y: number) => [...px.subarray((y * 48 + x) * 4, (y * 48 + x) * 4 + 4)];
    expect(at(6, 40)).toEqual([0xd2, 0x3a, 0x2c, 255]);
    const idat = png.indexOf("IDAT");
    expect(inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4))).length).toBe(
      48 * (48 * 4 + 1),
    );
  });
});

describe("words", () => {
  it("has every word in both languages, with the same placeholders", () => {
    for (const k of Object.keys(dictionaries.en) as (keyof typeof dictionaries.en)[]) {
      const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(dictionaries.it[k], k).toBeTruthy();
      expect(vars(dictionaries.it[k]), k).toEqual(vars(dictionaries.en[k]));
    }
    setLang("it");
    expect(t("forSite", { host: "github.com" })).toBe("Per github.com");
    setLang("en");
    expect(t("forSite", { host: "github.com" })).toBe("For github.com");
  });
});
