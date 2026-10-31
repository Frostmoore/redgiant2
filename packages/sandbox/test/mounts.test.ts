import { describe, expect, it } from "vitest";
import { translateMount } from "../src/index.js";

describe("translateMount", () => {
  const vol = { name: "redgiant-data", mountPoint: "/data" };

  it("mounts workspaces under the data volume from the volume, with a subpath", () => {
    expect(translateMount({ type: "bind", source: "/data/workspaces/local/demo" }, vol)).toEqual({
      type: "volume",
      name: "redgiant-data",
      subpath: "workspaces/local/demo",
    });
    expect(translateMount({ type: "bind", source: "/data/" }, vol)).toEqual({
      type: "volume",
      name: "redgiant-data",
    });
  });

  it("leaves everything else alone", () => {
    const outside = { type: "bind" as const, source: "/database/x" };
    expect(translateMount(outside, vol)).toEqual(outside);
    expect(translateMount({ type: "bind", source: "/data/x" })).toEqual({
      type: "bind",
      source: "/data/x",
    });
    const already = { type: "volume" as const, name: "v", subpath: "a" };
    expect(translateMount(already, vol)).toEqual(already);
  });
});
