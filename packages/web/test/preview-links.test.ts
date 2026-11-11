// @vitest-environment jsdom
import { FILES_SANDBOX, PROGRAM_SANDBOX } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { previewLink } from "../src/preview-links.js";

describe("links asked by agent-made pages (3.5.8)", () => {
  const frame = (src: string) => {
    const f = document.createElement("iframe");
    f.src = src;
    document.body.append(f);
    return f;
  };
  const msg = (data: unknown, source: Window | null) =>
    new MessageEvent("message", { data, source });

  it("counts only a preview frame's request for an http(s) link", () => {
    const preview = frame("/preview/abc.def/");
    const other = frame("/zeta/frame.html");
    const ask = { redgiant: "open-link", url: "https://example.com/a?b=1" };
    expect(previewLink(msg(ask, preview.contentWindow), [preview, other])?.href).toBe(
      "https://example.com/a?b=1",
    );
    // From a frame that is not a preview, or from nowhere.
    expect(previewLink(msg(ask, other.contentWindow), [preview, other])).toBeUndefined();
    expect(previewLink(msg(ask, window), [preview, other])).toBeUndefined();
    // Not a link worth asking about.
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "nonsense"])
      expect(
        previewLink(msg({ redgiant: "open-link", url }, preview.contentWindow), [preview]),
      ).toBeUndefined();
    expect(previewLink(msg("open-link", preview.contentWindow), [preview])).toBeUndefined();
  });

  it("keeps popups and top navigation away from agent-made pages", () => {
    expect(FILES_SANDBOX).not.toMatch(/allow-popups|allow-top-navigation|allow-same-origin/);
    expect(PROGRAM_SANDBOX).toContain("allow-popups");
    expect(PROGRAM_SANDBOX).not.toMatch(/allow-top-navigation|allow-same-origin/);
  });
});
