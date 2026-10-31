#!/usr/bin/env node
import { runCli, terminalIo } from "./cli.js";

process.exit(await runCli(process.argv.slice(2), process.env, await terminalIo()));
