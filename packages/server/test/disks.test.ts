import { describe, expect, it } from "vitest";
import { driveOf, parseDisks } from "../src/hardware.js";

describe("the computer's disks (2026-11-03)", () => {
  it("reads them as Windows' launcher writes them", () => {
    expect(parseDisks("C|ssd|nvme|120.5|476.9;D|hdd|sata|900|1863;E|?|usb|10|64")).toEqual([
      { name: "C", ssd: true, bus: "nvme", freeGb: 120.5, totalGb: 476.9 },
      { name: "D", ssd: false, bus: "sata", freeGb: 900, totalGb: 1863 },
      { name: "E", ssd: null, bus: "usb", freeGb: 10, totalGb: 64 },
    ]);
    expect(parseDisks("")).toEqual([]);
    expect(parseDisks("broken")).toEqual([]);
  });

  it("finds the drive of a Windows path and of WSL's view of it", () => {
    expect(driveOf("D:\\RedGiant\\data")).toBe("D");
    expect(driveOf("/mnt/c/Users/me/AppData/Local/RedGiant/engine")).toBe("C");
    expect(driveOf("/data")).toBeUndefined();
    expect(driveOf(undefined)).toBeUndefined();
  });
});
