import http from "node:http";

export interface ApiCall {
  method: string;
  body: Record<string, unknown>;
  /** For sendMessage: the id Telegram gave the message. */
  messageId?: number;
}

/** The Telegram Bot API in miniature: records every call and answers like Telegram. */
export async function fakeTelegram() {
  const calls: ApiCall[] = [];
  /** Files users "sent", by file id. */
  const files = new Map<string, Buffer>();
  let messageId = 100;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    // Downloads: /file/bot<token>/files/<id> serves what the test put in `files`.
    const download = (req.url ?? "").match(/^\/file\/bot[^/]+\/files\/(.+)$/);
    if (download) {
      const data = files.get(decodeURIComponent(download[1] ?? ""));
      res.writeHead(data ? 200 : 404).end(data ?? "");
      return;
    }
    const method = (req.url ?? "").split("/").pop() ?? "";
    // Files come as multipart forms: only their fields' names are kept, to look at.
    const multipart = (req.headers["content-type"] ?? "").startsWith("multipart/");
    const body = multipart
      ? { multipart: true, fields: [...raw.matchAll(/name="([^"]+)"/g)].map((m) => m[1]) }
      : raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {};
    const call: ApiCall = { method, body };
    calls.push(call);
    const result =
      method === "getMe"
        ? {
            id: 1,
            is_bot: true,
            first_name: "RedGiant",
            username: "redgiant_test_bot",
            can_join_groups: false,
            can_read_all_group_messages: false,
            supports_inline_queries: false,
          }
        : method === "getFile"
          ? { file_id: body.file_id, file_unique_id: "u", file_path: `files/${body.file_id}` }
          : method === "sendMessage" || method === "editMessageText"
            ? {
                message_id: method === "sendMessage" ? ++messageId : Number(body.message_id),
                date: 0,
                chat: { id: body.chat_id, type: "private" },
                text: body.text,
              }
            : true;
    if (method === "sendMessage") call.messageId = messageId;
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: true, result }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  let updateId = 1;
  const from = (userId: number) => ({
    id: userId,
    is_bot: false,
    first_name: "User",
    username: `user${userId}`,
  });
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    calls,
    sent: (chatId: number) =>
      calls
        .filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId)
        .map((c) => c.body),
    text: (userId: number, text: string) => ({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: userId, type: "private" as const, first_name: "User" },
        from: from(userId),
        text,
        ...(text.startsWith("/") && {
          entities: [
            { type: "bot_command" as const, offset: 0, length: text.split(" ")[0]?.length ?? 0 },
          ],
        }),
      },
    }),
    files,
    /** A photo, a document or a voice note (its bytes go in `files` under `fileId`). */
    media: (
      userId: number,
      kind: "photo" | "document" | "voice",
      fileId: string,
      extra: { caption?: string; mime_type?: string; file_name?: string } = {},
    ) => ({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: userId, type: "private" as const, first_name: "User" },
        from: from(userId),
        ...(extra.caption && { caption: extra.caption }),
        ...(kind === "photo"
          ? {
              photo: [
                { file_id: `${fileId}-small`, file_unique_id: "s", width: 90, height: 90 },
                { file_id: fileId, file_unique_id: "b", width: 1280, height: 960 },
              ],
            }
          : kind === "voice"
            ? {
                voice: {
                  file_id: fileId,
                  file_unique_id: "v",
                  duration: 3,
                  mime_type: extra.mime_type ?? "audio/ogg",
                },
              }
            : {
                document: {
                  file_id: fileId,
                  file_unique_id: "d",
                  ...(extra.file_name && { file_name: extra.file_name }),
                  ...(extra.mime_type && { mime_type: extra.mime_type }),
                },
              }),
      },
    }),
    /** A text sent as a reply to one of the bot's messages. */
    reply: (userId: number, text: string, replyTo: number) => ({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: userId, type: "private" as const, first_name: "User" },
        from: from(userId),
        text,
        reply_to_message: {
          message_id: replyTo,
          date: 0,
          chat: { id: userId, type: "private" as const, first_name: "User" },
        },
      },
    }),
    button: (userId: number, data: string) => ({
      update_id: updateId++,
      callback_query: {
        id: `cb${updateId}`,
        from: from(userId),
        chat_instance: "x",
        data,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: userId, type: "private" as const, first_name: "User" },
        },
      },
    }),
    close: () => new Promise((ok) => server.close(ok)),
  };
}
