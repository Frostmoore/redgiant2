// Artifacts (3.5.9, study_artifacts.md): a single-file HTML app an agent makes in one turn. It lives as a
// file `artefatti/<name>.html` whose first comment is a header; a widget is a ```widget block in an answer.
// Shared contract between the Canvas engine, the widget, the collection and export/import: keep identical.
import { z } from "zod";

/** The folder of a project (or of an agent's workspace) that holds its artifacts. */
export const ARTIFACT_DIR = "artefatti";

/** Libraries an artifact may ask for; RedGiant serves them offline from the preview's `lib/`. */
export const ARTIFACT_LIBS = ["react", "preact", "d3", "chartjs", "three", "papaparse", "sheetjs", "lucide", "mermaid", "marked"] as const;
export const ArtifactLib = z.enum(ARTIFACT_LIBS);
export type ArtifactLib = z.infer<typeof ArtifactLib>;

/** The header comment: `<!-- redgiant-artifact {json} -->`, first thing in the file. */
export const ArtifactHeader = z.object({
  name: z.string().min(1).max(120),
  version: z.number().int().min(1).default(1),
  libs: z.array(ArtifactLib).default([]),
  /** Capabilities it will ask for in 3.6 (e.g. "files:dati/"); granted by the person, never by the file. */
  wants: z.array(z.string().max(200)).max(20).default([]),
  /** The agent that made it. */
  from: z.string().max(120).optional(),
});
export type ArtifactHeader = z.infer<typeof ArtifactHeader>;

const HEADER = /^\s*<!--\s*redgiant-artifact\s+(\{[\s\S]*?\})\s*-->/;

/** The header of an artifact's text, or undefined when the file has none or a broken one. */
export function artifactHeaderOf(html: string): ArtifactHeader | undefined {
  const m = HEADER.exec(html);
  if (!m?.[1]) return undefined;
  try {
    const r = ArtifactHeader.safeParse(JSON.parse(m[1]));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** The text with its header written (replacing an old one). */
export function withArtifactHeader(html: string, header: ArtifactHeader): string {
  const line = `<!-- redgiant-artifact ${JSON.stringify(header)} -->`;
  return HEADER.test(html) ? html.replace(HEADER, line) : `${line}\n${html}`;
}

/** Whether a path is an artifact by place: `artefatti/*.html` anywhere in the scope. */
export const isArtifactPath = (path: string): boolean =>
  new RegExp(`(^|[\\\\/])${ARTIFACT_DIR}[\\\\/][^\\\\/]+\\.html?$`, "i").test(path);

/** The manifest inside a `.rgartifact` export (a zip: artifact.html, manifest.json, data.json?). */
export const ArtifactManifest = z.object({
  format: z.literal("rgartifact-1"),
  header: ArtifactHeader,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  redgiant: z.string(),
  hasData: z.boolean().default(false),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifest>;
