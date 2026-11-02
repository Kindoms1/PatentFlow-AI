// Mock OpenAI-compatible model + AnySearch upstream for local Worker tests. No real key, no cost.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8789);
const seen = [];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method === "GET" && req.url === "/__seen") return send(res, 200, seen);
    const auth = req.headers.authorization || "";
    seen.push({ path: req.url, auth, bytes: raw.length });
    if (req.url.startsWith("/v1/chat/completions")) {
      if (auth !== "Bearer mock-model-key") return send(res, 401, { error: { message: "bad key" } });
      const body = JSON.parse(raw || "{}");
      const last = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
      const text = "模拟模型已收到：" + String((last && last.content) || "").slice(0, 12);
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const parts = text.match(/.{1,3}/gsu) || [text];
        for (const part of parts) {
          res.write("data: " + JSON.stringify({ id: "m", object: "chat.completion.chunk", model: "mock-model", choices: [{ index: 0, delta: { content: part }, finish_reason: null }] }) + "\n\n");
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        res.write("data: " + JSON.stringify({ id: "m", object: "chat.completion.chunk", model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: parts.length, total_tokens: 10 + parts.length } }) + "\n\n");
        res.end("data: [DONE]\n\n");
        return;
      }
      return send(res, 200, { id: "m", object: "chat.completion", model: "mock-model", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }
    if (req.url.startsWith("/v1/search") || req.url.startsWith("/v1/extract")) {
      if (auth !== "Bearer mock-search-key") return send(res, 401, { code: 401, message: "bad key" });
      if (req.url.startsWith("/v1/extract")) {
        const body = JSON.parse(raw || "{}");
        return send(res, 200, { code: 0, data: { url: body.url, title: "模拟提取页面", content: "模拟网页正文，仅用于 Worker 运行时测试。" } });
      }
      return send(res, 200, { code: 0, data: { results: [{ title: "模拟检索结果", url: "https://example.com/a", content: "模拟片段" }] } });
    }
    send(res, 404, {});
  })
  .listen(PORT, "127.0.0.1", () => console.log("mock upstream on http://127.0.0.1:" + PORT));
