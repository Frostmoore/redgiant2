/** Builds a streaming HTTP response from SSE events, for adapter tests without network. */
export function sseResponse(
  events: { event?: string; data: unknown }[],
  init: { delayMs?: number; signal?: AbortSignal } = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) {
        if (init.delayMs) await new Promise((r) => setTimeout(r, init.delayMs));
        if (init.signal?.aborted) {
          controller.error(new DOMException("aborted", "AbortError"));
          return;
        }
        const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
        controller.enqueue(
          encoder.encode(`${e.event ? `event: ${e.event}\n` : ""}data: ${data}\n\n`),
        );
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

/** A fetch that records requests and answers with `respond`. */
export function fakeFetch(
  respond: (call: RecordedCall, signal?: AbortSignal) => Response | Promise<Response>,
) {
  const calls: RecordedCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const call = { url, body: raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : {} };
    calls.push(call);
    return respond(call, init?.signal ?? undefined);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** Anthropic Messages stream for a text answer and optional tool call. */
export function anthropicEvents(opts: {
  text?: string;
  tool?: { id: string; name: string; json: string };
  stop: string;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}) {
  const u = opts.usage ?? { input: 10, output: 5 };
  const events: { event: string; data: unknown }[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: u.input,
            output_tokens: 1,
            cache_read_input_tokens: u.cacheRead ?? 0,
            cache_creation_input_tokens: u.cacheWrite ?? 0,
          },
        },
      },
    },
  ];
  let index = 0;
  if (opts.text !== undefined) {
    events.push({
      event: "content_block_start",
      data: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    });
    for (const piece of opts.text.match(/\S+\s*/g) ?? []) {
      events.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } },
      });
    }
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    index++;
  }
  if (opts.tool) {
    events.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: opts.tool.id, name: opts.tool.name, input: {} },
      },
    });
    const half = Math.floor(opts.tool.json.length / 2);
    for (const part of [opts.tool.json.slice(0, half), opts.tool.json.slice(half)]) {
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: part },
        },
      });
    }
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  }
  events.push(
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: opts.stop, stop_sequence: null },
        usage: { output_tokens: u.output },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  );
  return events;
}

/** OpenAI-compatible chunks for a text answer (as llama.cpp sends them). */
export function openAiTextEvents(text: string, extra: Record<string, unknown> = {}) {
  const events: { data: unknown }[] = (text.match(/\S+\s*/g) ?? []).map((piece) => ({
    data: { model: "m", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] },
  }));
  events.push({
    data: { model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...extra },
  });
  events.push({ data: "[DONE]" });
  return events;
}
