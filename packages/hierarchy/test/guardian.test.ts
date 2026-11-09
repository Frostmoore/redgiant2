import { describe, expect, it } from "vitest";
import { bashOutsideWrites, outsideShows, outsideWrites } from "../src/guardian.js";
import { DEFAULT_POLICY, evaluate, OUTSIDE_PROJECT } from "../src/policy.js";

const ctx = { roots: ["/data/projects/demo", "/data/worktrees/agent-1"], home: "/root" };

// The guardian's table (2026-11-04): what counts as writing outside the agent's folders.
const BASH: [string, string[]][] = [
  // Inside the project: nothing to ask.
  ["ls -la && cat README.md", []],
  ["echo hi > notes.txt", []],
  ["mkdir -p src/lib && touch src/lib/a.ts", []],
  ["npm test 2>&1 | tail -20", []],
  ["cp src/a.ts src/b.ts", []],
  ["echo x > /tmp/scratch.txt", []],
  ["make > /dev/null", []],
  ["cat /etc/hosts", []],
  ["cp /etc/hosts ./hosts.copy", []],
  ["git status && git commit -am wip", []],
  ["cd src && rm old.ts", []],
  // Outside: the guardian asks.
  ["echo x > /etc/hosts", ["/etc/hosts"]],
  ["echo x >> ~/.bashrc", ["/root/.bashrc"]],
  ["rm -rf /var/lib/thing", ["/var/lib/thing"]],
  ["rm -rf ../other-project", ["/data/projects/other-project"]],
  ["cp build.zip /srv/www/", ["/srv/www"]],
  ["mv notes.txt $HOME/notes.txt", ["/root/notes.txt"]],
  ["cd /opt/app && rm config.yml", ["/opt/app/config.yml"]],
  ["cd .. && touch x", ["/data/projects/x"]],
  ["sudo chmod 777 /usr/local/bin/tool", ["/usr/local/bin/tool"]],
  ["sed -i 's/a/b/' /etc/nginx/nginx.conf", ["/etc/nginx/nginx.conf"]],
  ["tar -xzf pkg.tgz -C /opt", ["/opt"]],
  ["git -C /srv/other pull", ["/srv/other"]],
  ["echo $SECRET > $TARGET", ["$TARGET"]],
  ["dd if=/dev/zero of=/dev/sda bs=1M", ["/dev/sda"]],
  ["ls; tee /etc/motd < msg", ["/etc/motd"]],
];

describe("the guardian (2026-11-04)", () => {
  for (const [command, expected] of BASH)
    it(`bash: ${command}`, () => {
      expect(bashOutsideWrites(command, ctx)).toEqual(expected);
    });

  it("file tools: inside the folders nothing, outside the path", () => {
    expect(
      outsideWrites(
        { callId: "1", name: "write_file", input: { path: "src/a.ts", content: "" } },
        ctx,
      ),
    ).toEqual([]);
    expect(
      outsideWrites(
        { callId: "1", name: "write_file", input: { path: "/etc/x.conf", content: "" } },
        ctx,
      ),
    ).toEqual(["/etc/x.conf"]);
    expect(
      outsideWrites({ callId: "1", name: "edit_file", input: { path: "../../secrets.env" } }, ctx),
    ).toEqual(["/data/secrets.env"]);
    expect(
      outsideWrites({ callId: "1", name: "read_file", input: { path: "/etc/passwd" } }, ctx),
    ).toEqual([]);
  });

  it("Windows paths: either slash, any case, the drive letter counts (CI on Windows)", () => {
    const win = { roots: ["C:\\Users\\Me\\AppData\\Local\\Temp\\rg-1\\ws"], home: "C:\\Users\\Me" };
    const w = (path: string) =>
      outsideWrites({ callId: "1", name: "write_file", input: { path } }, win);
    expect(w("notes.md")).toEqual([]);
    expect(w("src/a.ts")).toEqual([]);
    expect(w("c:/users/me/appdata/local/temp/rg-1/ws/b.md")).toEqual([]);
    expect(w("C:\\Windows\\x.dll")).toEqual(["C:\\Windows\\x.dll"]);
    expect(w("../other/x")).toEqual(["C:\\Users\\Me\\AppData\\Local\\Temp\\rg-1\\other\\x"]);
    expect(bashOutsideWrites("echo hi > out.txt && git.exe status", win)).toEqual([]);
  });

  it("an agent with no folder of its own is not checked", () => {
    expect(
      outsideWrites({ callId: "1", name: "bash", input: { command: "rm -rf /x" } }, { roots: [] }),
    ).toEqual([]);
  });
});

// show_file (G34.1): showing a file outside the folders asks, as writing there does.
const SHOWN: [string, string[]][] = [
  ["report.pdf", []],
  ["/data/projects/demo/out/video.mp4", []],
  ["/data/worktrees/agent-1/model.glb", []],
  ["/tmp/scratch.png", []],
  ["/etc/passwd", ["/etc/passwd"]],
  ["../other-project/secret.pdf", ["/data/projects/other-project/secret.pdf"]],
  ["~/photo.jpg", ["/root/photo.jpg"]],
  ["$SOMEWHERE/x.png", ["$SOMEWHERE/x.png"]],
];

describe("the guardian and show_file (G34.1)", () => {
  for (const [path, want] of SHOWN)
    it(`show_file: ${path}`, () => {
      expect(outsideShows({ callId: "1", name: "show_file", input: { path } }, ctx)).toEqual(want);
    });

  it("other tools are not its business; no folders, no check", () => {
    expect(
      outsideShows({ callId: "1", name: "read_file", input: { path: "/etc/passwd" } }, ctx),
    ).toEqual([]);
    expect(
      outsideShows(
        { callId: "1", name: "show_file", input: { path: "/etc/passwd" } },
        { roots: [] },
      ),
    ).toEqual([]);
  });

  // G36.12: looking at the canvas and leafing through it follow the same rule, by path.
  for (const name of ["canvas_look", "canvas_act"])
    it(`${name}: inside free, outside the person's call, no path no check`, () => {
      const s = { ...DEFAULT_POLICY, roots: ctx.roots, home: ctx.home };
      expect(outsideShows({ callId: "1", name, input: { path: "/etc/passwd" } }, ctx)).toEqual([
        "/etc/passwd",
      ]);
      expect(outsideShows({ callId: "1", name, input: { page: 3 } }, ctx)).toEqual([]);
      expect(evaluate("plan", { callId: "1", name, input: { path: "a.pdf" } }, s).decision).toBe(
        "allow",
      );
      expect(evaluate("readonly", { callId: "1", name, input: {} }, s).decision).toBe("allow");
      const out = evaluate("auto", { callId: "1", name, input: { path: "/etc/passwd" } }, s);
      expect(out.decision).toBe("ask");
      expect(out.danger).toContain(OUTSIDE_PROJECT);
      expect(out.reasons[0]).toMatch(
        name === "canvas_look" ? /^looks at a file outside/ : /^shows a file outside/,
      );
    });

  // G37.1: canvas_edit writes where its path says, as edit_file; without a path, the tab (in the
  // agent's workspace, the tool checks it).
  it("canvas_edit: a path outside the folders is the person's call", () => {
    const s = { ...DEFAULT_POLICY, roots: ctx.roots, home: ctx.home };
    const edit = (input: unknown) => ({ callId: "1", name: "canvas_edit", input });
    expect(outsideWrites(edit({ path: "/etc/hosts", ops: [] }), ctx)).toEqual(["/etc/hosts"]);
    expect(outsideWrites(edit({ path: "notes.txt", ops: [] }), ctx)).toEqual([]);
    expect(outsideWrites(edit({ tab: 1, ops: [] }), ctx)).toEqual([]);
    expect(outsideWrites(edit({ path: "/etc/hosts", help: true }), ctx)).toEqual([]);
    const out = evaluate(
      "auto",
      edit({ path: "~/notes.txt", ops: [{ op: "insert", text: "x" }] }),
      s,
    );
    expect(out.decision).toBe("ask");
    expect(out.danger).toContain(OUTSIDE_PROJECT);
    expect(evaluate("auto", edit({ path: "notes.txt", ops: [] }), s).decision).toBe("allow");
  });

  // 3.5.3: a knowledge source by its path reads files into a collection: outside, the person's call.
  it("knowledge_add_source: a folder or file outside asks, a project or a page does not", () => {
    const s = { ...DEFAULT_POLICY, roots: ctx.roots, home: ctx.home };
    const add = (input: unknown) => ({ callId: "1", name: "knowledge_add_source", input });
    expect(outsideShows(add({ kind: "folder", path: "/home/me/Documents" }), ctx)).toEqual([
      "/home/me/Documents",
    ]);
    expect(outsideShows(add({ kind: "file", path: "docs/manual.pdf" }), ctx)).toEqual([]);
    expect(outsideShows(add({ kind: "folder", path: "/data/projects/demo/docs" }), ctx)).toEqual(
      [],
    );
    expect(outsideShows(add({ kind: "project", project: "demo", path: "/etc" }), ctx)).toEqual([]);
    expect(outsideShows(add({ kind: "url", url: "https://example.com" }), ctx)).toEqual([]);
    const out = evaluate("auto", add({ kind: "folder", path: "~/Documents" }), s);
    expect(out.decision).toBe("ask");
    expect(out.danger).toContain(OUTSIDE_PROJECT);
    expect(out.reasons[0]).toMatch(/^reads files outside the project into the knowledge/);
    expect(evaluate("auto", add({ kind: "folder", path: "docs" }), s).decision).toBe("allow");
    // Its state only reads, in every mode.
    expect(
      evaluate("readonly", { callId: "1", name: "knowledge_status", input: {} }, s).decision,
    ).toBe("allow");
  });

  it("the policy: inside allowed in every mode, outside asks the human, auto lets it be", () => {
    const s = { ...DEFAULT_POLICY, roots: ctx.roots, home: ctx.home };
    const call = (path: string) => ({ callId: "1", name: "show_file", input: { path } });
    expect(evaluate("auto", call("a.pdf"), s).decision).toBe("allow");
    expect(evaluate("readonly", call("a.pdf"), s).decision).toBe("allow");
    expect(evaluate("plan", call("a.pdf"), s).decision).toBe("allow");
    const out = evaluate("readonly", call("/home/someone/x.pdf"), s);
    expect(out.decision).toBe("ask");
    expect(out.danger).toContain(OUTSIDE_PROJECT);
    expect(s.humanOnly).toContain(OUTSIDE_PROJECT);
    expect(evaluate("auto", call("/home/someone/x.pdf"), { ...s, guardian: "auto" }).decision).toBe(
      "allow",
    );
    // A rule of the person's still comes first.
    expect(
      evaluate("auto", call("/etc/passwd"), {
        ...s,
        rules: [{ tool: "show_file", decision: "deny" }],
      }).decision,
    ).toBe("deny");
  });
});
