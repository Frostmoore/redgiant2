// Git Bash's paths on Windows (p3.5.4, the 3.5.3 test: «There is no file "/c/Users/…/app.py" on
// this computer», and a bash write into an archived project the guardian did not recognise).
// One pure function turns them into Windows paths, for the file tools and for the guardian.
import { describe, expect, it } from "vitest";
import { nativePath, nativePaths } from "../src/paths.js";

const win = { windows: true, home: "C:\\Users\\Pixel" };

const TABLE: [string, string][] = [
  // Git Bash (MSYS): the drive as the first folder, either case.
  ["/c/Users/Pixel/app.py", "C:\\Users\\Pixel\\app.py"],
  ["/C/Users/Pixel/app.py", "C:\\Users\\Pixel\\app.py"],
  ["/e/coding/XAMPP/htdocs", "E:\\coding\\XAMPP\\htdocs"],
  ["/d", "D:\\"],
  ["/d/", "D:\\"],
  // Cygwin and WSL's way.
  ["/cygdrive/c/Users/Pixel/a.txt", "C:\\Users\\Pixel\\a.txt"],
  ["/mnt/c/Users/Pixel/a.txt", "C:\\Users\\Pixel\\a.txt"],
  // The home, as bash, PowerShell and cmd write it.
  ["~", "C:\\Users\\Pixel"],
  ["~/progetti/a.txt", "C:\\Users\\Pixel\\progetti\\a.txt"],
  ["$HOME/progetti", "C:\\Users\\Pixel\\progetti"],
  ["${HOME}/progetti", "C:\\Users\\Pixel\\progetti"],
  ["$USERPROFILE\\progetti", "C:\\Users\\Pixel\\progetti"],
  ["%USERPROFILE%\\progetti", "C:\\Users\\Pixel\\progetti"],
  ["$env:USERPROFILE\\progetti", "C:\\Users\\Pixel\\progetti"],
  // Already Windows paths, relative paths and other words: as they are.
  ["C:\\Users\\Pixel\\a.txt", "C:\\Users\\Pixel\\a.txt"],
  ["C:/Users/Pixel/a.txt", "C:/Users/Pixel/a.txt"],
  ["src/app.py", "src/app.py"],
  ["./c/app.py", "./c/app.py"],
  ["/cd/app.py", "/cd/app.py"],
  ["~other/a.txt", "~other/a.txt"],
  ["$HOMEPATH/a", "$HOMEPATH/a"],
  ["\\\\server\\share\\a", "\\\\server\\share\\a"],
];

describe("Git Bash paths on Windows (p3.5.4)", () => {
  for (const [given, expected] of TABLE)
    it(`${given} -> ${expected}`, () => expect(nativePath(given, win)).toBe(expected));

  it("elsewhere nothing changes", () => {
    for (const [given] of TABLE)
      expect(nativePath(given, { windows: false, home: "/home/me" })).toBe(given);
  });

  it("without a home, the home's forms stay", () => {
    expect(nativePath("~/a", { windows: true })).toBe("~/a");
    expect(nativePath("/c/a", { windows: true })).toBe("C:\\a");
  });

  it("a tool's input: the fields that are paths, however deep; never a command or a text", () => {
    const input = {
      path: "/c/Users/Pixel/app.py",
      paths: ["/c/a", "b"],
      command: "cat /c/Users/Pixel/app.py",
      content: "/c/Users/Pixel is my home",
      pattern: "/c/",
      ops: [{ op: "sign", image: "/c/firma.png", text: "/c/x" }],
      source_path: "~/doc.pdf",
      cwd: "/e/coding",
    };
    expect(nativePaths(input, win)).toEqual({
      ...input,
      path: "C:\\Users\\Pixel\\app.py",
      paths: ["C:\\a", "b"],
      ops: [{ op: "sign", image: "C:\\firma.png", text: "/c/x" }],
      source_path: "C:\\Users\\Pixel\\doc.pdf",
      cwd: "E:\\coding",
    });
    // Nothing to change: the same object back.
    const plain = { path: "src/a.ts" };
    expect(nativePaths(plain, win)).toBe(plain);
    expect(nativePaths(input, { windows: false })).toBe(input);
  });
});
