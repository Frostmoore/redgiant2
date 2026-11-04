import { describe, expect, it } from "vitest";
import { bashOutsideWrites, outsideWrites } from "../src/guardian.js";

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

  it("an agent with no folder of its own is not checked", () => {
    expect(
      outsideWrites({ callId: "1", name: "bash", input: { command: "rm -rf /x" } }, { roots: [] }),
    ).toEqual([]);
  });
});
