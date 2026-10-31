/** Yields the `data:` payload of each Server-Sent Event in a byte stream. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n?/g, "\n");
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const data = dataOf(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (data !== undefined) yield data;
        sep = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const tail = dataOf(buffer);
    if (tail !== undefined) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function dataOf(event: string): string | undefined {
  const lines = event
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  return lines.length > 0 ? lines.join("\n") : undefined;
}
