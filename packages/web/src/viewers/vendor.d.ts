// The browser build of mammoth (BSD-2-Clause): the same API as the package's own types.
declare module "mammoth/mammoth.browser.min.js" {
  const mammoth: typeof import("mammoth");
  export default mammoth;
}

// The drawing editor's engine (G37.6): @svgedit/svgcanvas' own source, plain JavaScript.
declare module "@svgedit/svgcanvas/svgcanvas.js" {
  // biome-ignore lint/suspicious/noExplicitAny: untyped JavaScript, wrapped in svg-island.ts
  const SvgCanvas: any;
  export default SvgCanvas;
}
