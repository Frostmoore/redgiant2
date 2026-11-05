import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installTemplate, templateFor } from "../src/chat-templates.js";

describe("RedGiant's chat templates (2026-11-05)", () => {
  it("gives gpt-oss a template that keeps past reasoning, and the others none", async () => {
    expect(templateFor("gpt-oss-120b-Q2_K-00001-of-00002.gguf")).toBe("redgiant-gpt-oss.jinja");
    expect(templateFor("Qwen3-14B-Q4_K_M.gguf")).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), "rg-tpl-"));
    const path = await installTemplate("redgiant-gpt-oss.jinja", join(dir, "templates"));
    const text = await readFile(path, "utf8");
    // The original drops the reasoning of a tool call once a final answer follows it.
    expect(text).not.toContain("not future_final_message.found");
    expect(text).toContain("rg_thinking");
    expect(text).toContain("reasoning_content");
  });
});
