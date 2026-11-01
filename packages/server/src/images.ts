// Image generation (G20.7) through the OpenAI Images API: partial previews while it draws (the API
// streams up to three, blurry to sharp), the cost from the tokens it reports, the picture saved in the
// agent's workspace so the human sees it in the chat and in the files.

export const IMAGE_MODEL = "gpt-image-2.5-flare";
export const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;

/** USD per million tokens for GPT Image 2 / 2.5 (OpenAI's price list, 2026-10). */
const RATES = { textIn: 5, imageIn: 8, imageOut: 30 };

export interface ImageUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

export function imageCost(usage: ImageUsage | undefined): number | null {
  if (!usage || typeof usage.output_tokens !== "number") return null;
  const text = usage.input_tokens_details?.text_tokens ?? usage.input_tokens ?? 0;
  const images = usage.input_tokens_details?.image_tokens ?? 0;
  return (
    (text * RATES.textIn + images * RATES.imageIn + usage.output_tokens * RATES.imageOut) / 1e6
  );
}

export class ImageError extends Error {}

export interface ImageProgress {
  /** Steps, not a measure: 5 when asked, then one step per preview, 100 at the end. */
  percent: number;
  /** A partial picture (base64 PNG), blurry first. */
  preview?: string;
}

type Answer = { data?: { b64_json?: string }[]; error?: { message?: string }; usage?: ImageUsage };

/** Reads the streamed answer: partial images, then the finished one with its usage. */
async function readStream(
  r: Response,
  previews: number,
  onProgress: (p: ImageProgress) => void,
): Promise<Answer> {
  const reader = r.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let rest = "";
  let final: Answer = {};
  const handle = (block: string) => {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    if (!data || data === "[DONE]") return;
    let j: {
      type?: string;
      b64_json?: string;
      partial_image_index?: number;
      usage?: ImageUsage;
      error?: { message?: string };
    };
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (j.type?.endsWith("partial_image") && j.b64_json) {
      const i = j.partial_image_index ?? 0;
      onProgress({
        percent: Math.min(95, Math.round(((i + 1) / (previews + 1)) * 100)),
        preview: j.b64_json,
      });
    } else if (j.type?.endsWith("completed") && j.b64_json) {
      final = { data: [{ b64_json: j.b64_json }], ...(j.usage && { usage: j.usage }) };
    } else if (j.error) final = { error: j.error };
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) rest += decoder.decode(value, { stream: true });
    const blocks = rest.split(/\r?\n\r?\n/);
    rest = blocks.pop() ?? "";
    for (const b of blocks) handle(b);
    if (done) break;
  }
  if (rest.trim()) handle(rest);
  return final;
}

export interface GeneratedImage {
  base64: string;
  model: string;
  costUsd: number | null;
  tokens: number;
}

/** Draws one image. Errors carry OpenAI's own words (refused content, no credit…), never the key. */
export async function generateImage(
  prompt: string,
  o: {
    key: string;
    model?: string | undefined;
    size?: (typeof IMAGE_SIZES)[number] | undefined;
    quality?: (typeof IMAGE_QUALITIES)[number] | undefined;
    baseUrl?: string | undefined;
    onProgress?: ((p: ImageProgress) => void) | undefined;
    fetch?: typeof fetch;
    signal?: AbortSignal | undefined;
  },
): Promise<GeneratedImage> {
  if (!prompt.trim()) throw new ImageError("The description is empty");
  const model = o.model ?? IMAGE_MODEL;
  const previews = o.onProgress ? 3 : 0;
  const ask = async (stream: boolean) => {
    try {
      return await (o.fetch ?? fetch)(
        `${(o.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/images/generations`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${o.key}` },
          body: JSON.stringify({
            model,
            prompt,
            size: o.size ?? "1024x1024",
            quality: o.quality ?? "auto",
            n: 1,
            ...(stream && { stream: true, partial_images: previews }),
          }),
          signal: o.signal ?? AbortSignal.timeout(10 * 60_000),
        },
      );
    } catch (err) {
      throw new ImageError(`OpenAI is unreachable: ${(err as Error).message}`);
    }
  };
  o.onProgress?.({ percent: 5 });
  let r = await ask(previews > 0);
  let answer: Answer;
  if (previews > 0 && r.ok && (r.headers.get("content-type") ?? "").includes("text/event-stream")) {
    answer = await readStream(r, previews, o.onProgress ?? (() => {}));
  } else {
    answer = (await r.json().catch(() => ({}))) as Answer;
    // A model without streaming: once more without previews.
    if (previews > 0 && r.status === 400 && /stream|partial/i.test(answer.error?.message ?? "")) {
      r = await ask(false);
      answer = (await r.json().catch(() => ({}))) as Answer;
    }
  }
  if (!r.ok || answer.error)
    throw new ImageError(
      r.status === 401 || r.status === 403
        ? "OpenAI refused the images key"
        : `OpenAI ${r.status}: ${answer.error?.message ?? "error"}`,
    );
  const base64 = answer.data?.[0]?.b64_json;
  if (!base64) throw new ImageError("OpenAI returned no image");
  o.onProgress?.({ percent: 100 });
  return {
    base64,
    model,
    costUsd: imageCost(answer.usage),
    tokens: (answer.usage?.input_tokens ?? 0) + (answer.usage?.output_tokens ?? 0),
  };
}

/** A readable file name from the prompt: lower case, dashes, at most 40 characters. */
export function imageFileName(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "image"
  );
}
