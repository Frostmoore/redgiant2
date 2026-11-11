import { render } from "preact";
import { App } from "./components/App.js";
import "./styles.css";
import { listenPreviewLinks } from "./preview-links.js";
import { applyTheme } from "./theme.js";

applyTheme();
listenPreviewLinks();

const root = document.getElementById("app");
if (root && location.hash === "#ui-gallery")
  void import("./dev/Gallery.js").then(({ Gallery }) => render(<Gallery />, root));
else if (root) render(<App />, root);

// Installable as an app (G20.9); the worker caches nothing, see public/sw.js.
if ("serviceWorker" in navigator && location.protocol !== "file:")
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
