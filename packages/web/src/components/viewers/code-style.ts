// What CodeMirror needs to colour a file (G34.2, shared by the viewer, the editor and the
// difference view since G37.2): token classes coloured by the theme's variables (styles.css), and
// the language found from the file's name, loaded only when a file of it opens.
import { HighlightStyle, LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import { codeLanguageName } from "../../viewers/kind.js";

/** Token classes, coloured by the theme's variables. */
export const codeClasses = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier],
    class: "cmv-kw",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: "cmv-str" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "cmv-num" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: "cmv-com" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: "cmv-fn" },
  { tag: [tags.typeName, tags.className, tags.namespace], class: "cmv-type" },
  { tag: [tags.propertyName, tags.attributeName], class: "cmv-prop" },
  { tag: [tags.heading], class: "cmv-head" },
  { tag: [tags.link, tags.url], class: "cmv-link" },
  { tag: [tags.meta, tags.processingInstruction, tags.tagName], class: "cmv-meta" },
]);

/** The language of a file by its name, and its name to show («TypeScript»), if CodeMirror has it. */
export function languageOf(name: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, codeLanguageName(name));
}

/** The language's support, loaded; undefined when there is none or it does not load. */
export async function languageFor(name: string): Promise<LanguageSupport | undefined> {
  const lang = languageOf(name);
  return lang ? await lang.load().catch(() => undefined) : undefined;
}
