import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "preact/hooks";
import { wsUrl } from "../api.js";
import { t } from "../i18n.js";
import { token } from "../state.js";

/** A shell in the sandbox of a project or of the platform, over /term. */
export function TerminalView({ scope }: { scope: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, 'JetBrains Mono', 'Cascadia Code', Menlo, monospace",
      fontSize: 13,
      theme: {
        background: "#120f10",
        foreground: "#e8dfdc",
        cursor: "#ef4b3a",
        selectionBackground: "#5a2320",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    const ws = new WebSocket(wsUrl("/term"));
    const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    ws.onopen = () =>
      send({ type: "hello", token: token.value, scope, cols: term.cols, rows: term.rows });
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; data?: string; message?: string };
      if (m.type === "output" && m.data) term.write(m.data);
      if (m.type === "error") term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`);
      if (m.type === "exit") term.write(`\r\n\x1b[90m${t("terminalClosed")}\x1b[0m\r\n`);
    };
    const input = term.onData((data) => send({ type: "input", data }));
    const resized = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);
    term.focus();
    return () => {
      observer.disconnect();
      input.dispose();
      resized.dispose();
      ws.close();
      term.dispose();
    };
  }, [scope]);

  return <div class="terminal" ref={host} />;
}
