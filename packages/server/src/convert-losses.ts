// What a conversion loses, as stable codes for the interface (G34, 3.3.0). The converters write
// their losses in plain English, for the agents (`conversion.json`, `convert_file`'s answer); the
// web page shows them in the person's language from these codes. Every text the converters write
// is here as a template: `{name}` parts are the values (a layer's name, a count, a list). A text
// that matches no template keeps `code: null` and the page shows the English as it is.

/** Every loss the converters can write, by its code. */
export const LOSS_TEMPLATES = {
  // What a target keeps and leaves out (convert-formats.ts).
  tiff_first_page: "only the first page or frame; layers and color profiles are flattened",
  pdf_to_odg: "each page becomes an editable drawing; complex text runs and some fonts can shift",
  first_page_fonts_effects: "only the first page; some fonts and effects can shift",
  first_page_fonts: "only the first page; some fonts can shift",
  first_page: "only the first page",
  media_reencoded: "re-encoded: a small loss of quality (lossy codec)",
  office_libreoffice:
    "LibreOffice keeps text, styles, tables, images and most layout; macros, some fonts (replaced by similar ones) and a few advanced effects can differ",
  visio_connectors: "connectors and some shapes can lose their behaviour",
  publisher_frames: "text frames and fonts can shift",
  cdr_effects: "effects, lenses and some fills are simplified",
  flat_picture: "one flat picture: no layers",
  ai_editing_data:
    "Illustrator's own editing data (live effects, symbols, artboard settings) stays only in the original",
  ai_ps_editing_data: "Illustrator's own editing data stays only in the original",
  ai_svg_first_artboard: "only the first artboard; gradients, blends and some fonts can shift",
  ai_odg_artboards: "every artboard as an editable drawing; effects and some fonts can shift",
  idml_scribus:
    "Scribus's own IDML import: pages, master pages, layers, frames at their place, text flowing through linked frames, styles, colours and images; tints, page-number markers, some crops of pictures and effects can differ (the PDF beside it shows how it came out)",
  idml_odg:
    "RedGiant's own import (when Scribus cannot be had): pages, frames, shapes and pictures at their exact place and size, text with its formatting, colours, layers",
  idml_pdf_from_odg: "printed from the ODG (Scribus makes its own PDF with the SLA)",
  idml_odt_target:
    "text only: the page layout (frames, positions, master pages, images) is not carried over, only the stories with their paragraph and character styles",
  preview_only:
    "this is NOT a conversion: only the small preview picture stored inside the file (layers, text and layout cannot be read by any free program)",
  preview_first_page: "often just the first page",
  sketch_svg:
    "RedGiant's own reading of the Sketch file: every artboard at its size, shapes, paths, text, colours, borders, opacity and images at their place; shadows, blurs, gradients beyond their first colour and symbol overrides are simplified",
  sketch_last_page: "the last page you looked at in Sketch",
  sketch_outline: "only the pages, artboards, layer names and texts: no shapes or styles",
  blender_gltf:
    "Blender's glTF export: meshes, materials (PBR), textures, cameras, lights and animations are kept; procedural shaders, modifiers not applied, particles and simulations are baked or left out",

  // Photoshop (convert-js.ts, psdToOra).
  psd_not_rgb: "the document was not RGB (CMYK, Lab or other): its colours were turned into RGB",
  psd_bits: "{bits}-bit colour reduced to 8 bits per channel",
  psd_adjustment: "adjustment layer dropped: «{layer}»",
  psd_smart_object: "smart object kept only as its pixels: «{layer}»",
  psd_text_pixels: "text layer kept as pixels (its words are in layers.json): «{layer}»",
  psd_effects: "layer effects (shadows, strokes, glows…) not applied: {names}",
  psd_masks: "masks and clipping not applied: {names}",
  psd_blend: "blend modes OpenRaster does not have, drawn as normal: {names}",
  psd_no_flat: "the file had no flat picture: it was drawn from the layers (normal blending only)",

  // IDML as text only (convert-js.ts, idmlToOdt).
  idml_odt_layout:
    "the page layout (frames, positions, master pages, columns) is not carried over: only the stories' text with their paragraph and character styles, in the document's order",
  idml_odt_images: "{n} placed image(s) are not carried over: {names}",
  idml_odt_tables: "tables, footnotes and anchored objects inside stories are kept as plain text",
  idml_no_text: "the stories had no text",

  // IDML with its layout (convert-idml.ts, idmlToOdg).
  idml_hidden: "hidden items (Visible off in InDesign) are left out",
  idml_effects:
    "effects (drop shadows, feathering, glows, blending modes) are left out; opacity is kept",
  idml_corners: "rounded or fancy corners are drawn square",
  idml_pasteboard: "{n} item(s) on the pasteboard, outside every page, are left out",
  idml_overset:
    "some stories look longer than their frames (overset text, hidden in InDesign): all of it is kept, in the last frame, and runs past its bottom",
  idml_threaded:
    "text that flows through linked frames is split between them by an estimate of how much each holds: line breaks can fall a little earlier or later than in InDesign (the frames' names say which story and which part)",
  idml_skew: "skewed frames are drawn without their skew",
  idml_mirror: "mirrored frames keep their place but not the mirroring of their content",
  idml_picture_formats:
    "pictures in formats LibreOffice cannot draw (Photoshop, unknown) stay in Pictures/ but may show empty",
  idml_picture_rotated: "pictures rotated inside their frame are drawn without the frame's crop",
  idml_missing_links:
    "{n} linked image(s) were not found beside the IDML (nor in a Links folder) and are grey boxes: {names}. Put them there and convert again",
  idml_gradients: "gradients are filled with their first colour",
  idml_tables: "tables are kept as their cells' text, one paragraph per cell",
  idml_anchored: "objects anchored inside the text are left out",
  idml_notes: "footnotes and notes are left out",
  idml_fonts:
    "fonts used: {fonts}; where one is not installed LibreOffice shows a similar one, and the text can reflow a little",
  idml_styles:
    "paragraph and character styles are kept as each paragraph's formatting (a drawing has no named text styles); master pages' items are copied on each page that uses them",

  // Sketch (convert-sketch.ts).
  sketch_gradients: "gradients and pattern fills are drawn with their first colour",
  sketch_fills: "layers with several fills keep only the top one",
  sketch_borders: "inside and outside borders are drawn centred on the edge",
  sketch_shadows: "shadows and blurs are left out",
  sketch_text_styles: "texts with several styles keep the first one",
  sketch_fixed_width:
    "fixed-width text boxes keep their own line breaks only (SVG text does not wrap)",
  sketch_boolean:
    "boolean operations (subtract, intersect, difference) are drawn as overlaid shapes",
  sketch_missing_bitmaps: "some bitmaps were missing from the file and are left out",
  sketch_library_symbols: "symbols from libraries outside the file are left out",
  sketch_overrides:
    "symbol overrides (changed texts or images inside symbols) show the symbol's own content",
  sketch_fonts: "fonts are named as in Sketch: where one is not installed, a similar one is shown",

  // Figma through its API (convert.ts).
  figma_png: "PNG is pixels: export SVG or PDF to keep the vectors",
  figma_svg:
    "text becomes outlines unless the fonts are installed; prototypes and components' behaviour are not kept",
  figma_not_exported: "not exported: {names}",
} as const;

export type LossId = keyof typeof LOSS_TEMPLATES;

/** A loss as the page shows it: its code (null when unknown) and the values in its text. */
export interface LossCode {
  code: LossId | null;
  vars?: Record<string, string>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each template as an anchored pattern, with the names of its values in order. */
const MATCHERS = (Object.entries(LOSS_TEMPLATES) as [LossId, string][]).map(([code, text]) => {
  const names: string[] = [];
  const source = text
    .split(/(\{\w+\})/)
    .map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (!m) return escapeRe(part);
      names.push(m[1] as string);
      return "([\\s\\S]+?)";
    })
    .join("");
  return { code, names, re: new RegExp(`^${source}$`) };
});

/** The English text of a loss, from its code and values (the converters' own words). */
export function lossText(code: LossId, vars: Record<string, string> = {}): string {
  return LOSS_TEMPLATES[code].replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);
}

/** The code of a loss the converters wrote, with its values; `code: null` when it is not known. */
export function lossCode(text: string): LossCode {
  for (const m of MATCHERS) {
    const found = m.re.exec(text);
    if (!found) continue;
    if (m.names.length === 0) return { code: m.code };
    return {
      code: m.code,
      vars: Object.fromEntries(m.names.map((n, i) => [n, found[i + 1] ?? ""])),
    };
  }
  return { code: null };
}

/** The codes of a list of losses, in the same order. */
export const lossCodes = (losses: readonly string[]): LossCode[] => losses.map(lossCode);
