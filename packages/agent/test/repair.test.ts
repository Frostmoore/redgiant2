import { describe, expect, it } from "vitest";
import { decodeJsonStrings, repairJson } from "../src/index.js";

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

describe("decodeJsonStrings", () => {
  it("reads object, array, number and boolean arguments sent as their JSON text", () => {
    expect(
      decodeJsonStrings({
        render: '{"samples": 64}',
        show: "true",
        list: "[1, 2]",
        n: "12",
        path: "a.txt",
        text: "{not json",
      }),
    ).toEqual({
      render: { samples: 64 },
      show: true,
      list: [1, 2],
      n: 12,
      path: "a.txt",
      text: "{not json",
    });
    expect(decodeJsonStrings({ path: "a.txt", n: 3 })).toBeUndefined();
    expect(decodeJsonStrings("x")).toBeUndefined();
  });
});
