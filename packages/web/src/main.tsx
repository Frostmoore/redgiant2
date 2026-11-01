import { render } from "preact";
import { App } from "./components/App.js";
import "./styles.css";
import { applyTheme } from "./theme.js";

applyTheme();

const root = document.getElementById("app");
if (root) render(<App />, root);
