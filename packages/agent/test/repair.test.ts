import { describe, expect, it } from "vitest";
import { repairJson } from "../src/index.js";

describe("repairJson", () => {
  it.each([
    ['{"path": "a.ts",}', { path: "a.ts" }],
    ["{'path': 'a.ts'}", { path: "a.ts" }],
    [
      '{path: "a.ts", recursive: True, depth: None}',
      { path: "a.ts", recursive: true, depth: null },
    ],
    ['```json\n{"path": "a.ts"}\n```', { path: "a.ts" }],
    ['Sure! Here are the arguments: {"path": "a.ts"}', { path: "a.ts" }],
    ['{"content": "line1\nline2"}', { content: "line1\nline2" }],
    ['{"path": "a.ts", "content": "unterminated', { path: "a.ts", content: "unterminated" }],
    ['{"items": [1, 2,', { items: [1, 2] }],
    ["{'say': 'it\\'s fine'}", { say: "it's fine" }],
    ["", {}],
  ])("repairs %j", (raw, expected) => {
    expect(repairJson(raw)).toEqual(expected);
  });

  it.each(["no json here", "[1, 2, 3]", "{text: oops}"])("gives up on %j", (raw) => {
    expect(repairJson(raw)).toBeUndefined();
  });
});
