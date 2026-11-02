#!/usr/bin/env node
// A stand-in for Claude Code's `claude auth …` (tests): the login is a file in CLAUDE_CONFIG_DIR.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = process.env.CLAUDE_CONFIG_DIR ?? ".";
const file = join(dir, ".credentials.json");
const [cmd, sub] = process.argv.slice(2);
if (cmd === "auth" && sub === "status") {
  const logged = existsSync(file);
  console.log(
    JSON.stringify(
      logged
        ? { loggedIn: true, authMethod: "claude.ai", ...JSON.parse(readFileSync(file, "utf8")) }
        : { loggedIn: false, authMethod: "none" },
      null,
      2,
    ),
  );
} else if (cmd === "auth" && sub === "logout") {
  rmSync(file, { force: true });
  console.log("Successfully logged out.");
} else if (cmd === "auth" && sub === "login") {
  console.log("Opening browser to sign in…");
  console.log(
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc",
  );
  process.stdout.write("Paste code here if prompted > ");
  const rl = createInterface({ input: process.stdin });
  rl.once("line", (code) => {
    if (code === "good-code#abc") {
      writeFileSync(file, JSON.stringify({ email: "me@example.com", subscriptionType: "max" }));
      console.log("Login successful.");
      process.exit(0);
    }
    console.log(
      "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt.",
    );
    process.exit(1);
  });
} else {
  console.error(`unknown: ${process.argv.slice(2).join(" ")}`);
  process.exit(2);
}
