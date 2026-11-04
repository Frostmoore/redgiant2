import { describe, expect, it } from "vitest";
import { parseMeminfo, parseWindowsMemory, usableRamGb } from "../src/memory.js";

describe("the RAM a model can use now (2026-11-04)", () => {
  it("reads what Linux can hand out, its file cache included", () => {
    const m = parseMeminfo(
      "MemTotal:       65536000 kB\nMemFree:         1048576 kB\nMemAvailable:   33554432 kB\nCached:         20971520 kB\n",
    );
    expect(m).toEqual({ availableGb: 32, cachedGb: 20 });
    expect(parseMeminfo("nothing here")).toBeUndefined();
  });

  it("reads the launcher's file, and nothing from a broken one", () => {
    expect(parseWindowsMemory('{"totalGb":63.7,"availableGb":31.2,"engineGb":4.5}')).toEqual({
      availableGb: 31.2,
      engineGb: 4.5,
    });
    expect(parseWindowsMemory("{")).toBeUndefined();
    expect(parseWindowsMemory('{"availableGb":"lots"}')).toBeUndefined();
  });

  it("the Windows engine counts Windows' free memory plus the model it is leaving", () => {
    const windows = { availableGb: 30, engineGb: 12 };
    expect(usableRamGb({ windowsEngine: true, totalGb: 64, windows })).toEqual({
      gb: 42,
      measured: true,
    });
  });

  it("an engine in WSL never counts more than Windows can still give it", () => {
    const linux = { availableGb: 31, cachedGb: 2 };
    expect(usableRamGb({ windowsEngine: false, totalGb: 32, linux })).toEqual({
      gb: 31,
      measured: true,
    });
    const windows = { availableGb: 10, engineGb: 0 };
    expect(usableRamGb({ windowsEngine: false, totalGb: 32, linux, windows }).gb).toBe(12);
  });

  it("without a measure, 60 % of the total as before", () => {
    expect(usableRamGb({ windowsEngine: true, totalGb: 64 })).toEqual({
      gb: 38.4,
      measured: false,
    });
  });
});
