// Our changes to @svgedit/svgcanvas 7.4.2 (G37.6), made when the page is built (vite.config.ts):
// the package itself is never forked or edited in node_modules. Each replacement must apply
// exactly as many times as expected, or the build stops (a new svgcanvas is looked at again).
//  - sanitize.js: attributes and elements of other programs' namespaces (Inkscape, Sodipodi, RDF,
//    any) are kept, never event handlers; spaces in texts are kept (svgcanvas trimmed every text
//    node: «Officina 2026» became «Officina2026»).
//  - history.js: each command class names itself (`rgName`), so the undo manager's checks survive
//    minification (it compared `constructor.name`); and tells the page each command as it is
//    made (`globalThis.__rgSvgCommand`), with the DOM as it is right then; a text's words are
//    recorded (svgcanvas read them as an attribute and never made a command for them).
//  - layer.js: elements of other programs (no `style`) inside a layer do not stop the loading.
//  - undo.js: no `x="NaN"` on the tspans of a text whose change had no x/y.

type Patch = { file: RegExp; edits: [string | RegExp, string, number][] };

const HOOK = "\n    globalThis.__rgSvgCommand?.(this)";

export const SVGCANVAS_PATCHES: Patch[] = [
  {
    file: /svgcanvas[\\/]core[\\/]sanitize\.js$/,
    edits: [
      [
        "if (attrNsURI !== allowedAttrsNS[attrLocalName] && attrNsURI !== NS.XMLNS &&",
        "if (!(attrNsURI && attrNsURI !== NS.SVG && attrNsURI !== NS.XLINK && attrNsURI !== NS.XMLNS && !/^on/i.test(attrLocalName)) && attrNsURI !== allowedAttrsNS[attrLocalName] && attrNsURI !== NS.XMLNS &&",
        1,
      ],
      [
        "const allowedAttrs = svgWhiteList_[node.nodeName]",
        "if (node.namespaceURI && node.namespaceURI !== NS.SVG && node.namespaceURI !== NS.HTML) { return }\n  const allowedAttrs = svgWhiteList_[node.nodeName]",
        1,
      ],
      [
        "    node.nodeValue = node.nodeValue.trim()\n    // Remove if empty\n    if (!node.nodeValue.length) {\n      node.remove()\n    }",
        "    // RedGiant (G37.6): a text's spaces are the person's; only blank nodes between elements go\n    const keep = node.parentNode && /^(text|tspan|textPath|title|desc|style|foreignObject)$/.test(node.parentNode.localName)\n    if (!keep && !node.nodeValue.trim()) {\n      node.remove()\n    }",
        1,
      ],
    ],
  },
  {
    file: /svgcanvas[\\/]core[\\/]history\.js$/,
    edits: [
      [
        "return this.constructor.name",
        "return this.constructor.rgName || this.constructor.name",
        1,
      ],
      [
        /export class (\w+Command) extends Command \{/g,
        "export class $1 extends Command {\n  static rgName = '$1'",
        5,
      ],
      [
        "    this.newParent = elem.parentNode\n  }",
        `    this.newParent = elem.parentNode${HOOK}\n  }`,
        1,
      ],
      [
        "    this.nextSibling = this.elem.nextSibling\n  }",
        `    this.nextSibling = this.elem.nextSibling${HOOK}\n  }`,
        1,
      ],
      [
        "    this.nextSibling = oldNextSibling\n    this.parent = oldParent\n  }",
        `    this.nextSibling = oldNextSibling\n    this.parent = oldParent${HOOK}\n  }`,
        1,
      ],
      // A text's words are its content, not an attribute: svgcanvas never recorded them.
      [
        "      oldValues[i] = elem.getAttribute(attrName)",
        "      oldValues[i] = attrName === '#text' ? elem.textContent : elem.getAttribute(attrName)",
        1,
      ],
      [
        "      if (changes[attrName] !== elem.getAttribute(attrName)) {",
        "      if (changes[attrName] !== (attrName === '#text' ? elem.textContent : elem.getAttribute(attrName))) {",
        1,
      ],
      [
        "        this.newValues[attr] = elem.getAttribute(attr)\n      }\n    }\n  }",
        `        this.newValues[attr] = elem.getAttribute(attr)\n      }\n    }${HOOK}\n  }`,
        1,
      ],
    ],
  },
  {
    // Elements of other programs (kept by the change above) have no `style`.
    file: /svgcanvas[\\/]core[\\/]layer\.js$/,
    edits: [
      [
        "      e.style.pointerEvents = 'inherit'",
        "      if (e.style) e.style.pointerEvents = 'inherit'",
        1,
      ],
    ],
  },
  {
    file: /svgcanvas[\\/]core[\\/]undo\.js$/,
    edits: [
      [
        "const tspans = cmd.elem.children",
        "const tspans = Number.isFinite(dx) && Number.isFinite(dy) ? cmd.elem.children : []",
        1,
      ],
    ],
  },
];

const count = (s: string, what: string | RegExp) =>
  typeof what === "string"
    ? s.split(what).length - 1
    : (s.match(new RegExp(what.source, "g")) ?? []).length;

/** The file's code with our changes, or undefined when it is not one we change. */
export function patchSvgcanvas(id: string, code: string): string | undefined {
  const p = SVGCANVAS_PATCHES.find((x) => x.file.test(id.replace(/\?.*$/, "")));
  if (!p) return undefined;
  let s = code;
  for (const [from, to, n] of p.edits) {
    const found = count(s, from);
    if (found !== n)
      throw new Error(
        `svgcanvas patch: «${String(from).slice(0, 60)}» found ${found} times in ${id}, expected ${n}`,
      );
    s = typeof from === "string" ? s.split(from).join(to) : s.replace(from, to);
  }
  return s;
}
