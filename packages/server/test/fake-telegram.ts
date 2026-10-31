import http from "node:http";

export interface ApiCall {
  method: string;
  body: Record<string, unknown>;
}

/** The Telegram Bot API in miniature: records every call and answers like Telegram. */
export async function fakeTelegram() {
  const calls: ApiCall[] = [];
  let messageId = 100;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const method = (req.url ?? "").split("/").pop() ?? "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ method, body });
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
        : method === "sendMessage" || method === "editMessageText"
          ? {
              message_id: method === "sendMessage" ? ++messageId : Number(body.message_id),
              date: 0,
              chat: { id: body.chat_id, type: "private" },
              text: body.text,
            }
          : true;
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
