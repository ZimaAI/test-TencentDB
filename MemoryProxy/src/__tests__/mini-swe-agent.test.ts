import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initAuth } from "../auth.js";
import { resolveAgentAdapter } from "../agent-adapters/index.js";
import { DEFAULT_CONFIG } from "../config.js";
import { extractSpaceIdFromPath } from "../credit-reporter.js";
import { createApp } from "../server.js";

describe("mini-SWE-agent knowledge evaluation API", () => {
  let server: Server;
  let base: string;
  let calls: Array<{ path: string; body: any; headers: Record<string, unknown> }>;
  let failKnowledge: boolean;
  let emptyAssets: boolean;
  let disableWiki: boolean;
  let resourceCount: number;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const path = req.url!;
      calls.push({ path, body, headers: req.headers });
      res.setHeader("content-type", "application/json");
      if (path === "/v1/chat/completions") {
        const message = { role: "assistant", content: "Inspect the repository.", tool_calls: [
          { id: "call-bash", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } },
        ] };
        if (body.stream) {
          res.setHeader("content-type", "text/event-stream");
          res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        } else res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: "tool_calls" }] }));
        return;
      }
      let data: unknown;
      switch (path) {
        case "/v3/meta/auth/verify":
          data = { valid: body.user_key === "test-user-key", user: { user_id: "user-test" } }; break;
        case "/v3/internal/meta/instance-upstream/list": data = { items: [] }; break;
        case "/v3/meta/team/list": data = { items: [{ team_id: "team-test", name: "Test" }], total: 1 }; break;
        case "/v3/meta/agent/list":
          data = { items: [{ agent_id: "agent-test", team_id: "team-test", name: "Test" }], total: 1 }; break;
        case "/v3/meta/agent-fixed-asset/list-with-detail":
          data = { agent: {}, items: emptyAssets ? [] : Array.from({ length: resourceCount }, (_, i) => ({
            asset_id: i === 0 ? "kb-test" : `kb-${i}`, asset_type: "llm_wiki",
          })).slice(body.offset, body.offset + body.limit), total: emptyAssets ? 0 : resourceCount }; break;
        case "/v3/meta/config/user/get":
          data = { items: disableWiki ? [{ param_name: "llm_wiki.enabled", effective_value: "false" }] : [] }; break;
        case "/v3/knowledge/list":
          if (failKnowledge) { res.writeHead(503).end(); return; }
          data = { items: body.knowledge_ids.map((id: string) => ({ knowledge_id: id, type: "wiki", team_id: "team-test", name: "Test wiki",
            service_url: "http://memory-hub:8424/v3", summary: "Test knowledge" })), total: body.knowledge_ids.length }; break;
        default: res.writeHead(500).end(JSON.stringify({ error: `Unexpected API: ${path}` })); return;
      }
      res.end(JSON.stringify({ code: 0, data }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    initAuth({ ...DEFAULT_CONFIG.auth, enabled: false });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    calls = [];
    failKnowledge = emptyAssets = disableWiki = false;
    resourceCount = 1;
    initAuth({ ...DEFAULT_CONFIG.auth, enabled: true, url: base });
  });

  function config() {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.upstream.url = `${base}/v1`;
    cfg.coreSkill = { ...cfg.coreSkill, endpoint: base, serviceToken: "internal-test", timeoutMs: 2000 };
    cfg.knowledge = { ...cfg.knowledge, ...cfg.coreSkill, enabled: true };
    cfg.injection.enabled = true;
    cfg.injection.injectors = ["knowledge", "skill", "tdai-memory"];
    cfg.sessionInit.enabled = true;
    cfg.tdai.enabled = true;
    cfg.tdai.memory.enabled = true;
    cfg.tdai.endpoint = base;
    return cfg;
  }

  const messages = [
    { role: "system", content: "Solve the task using bash." },
    { role: "user", content: "mem:help" },
    { role: "assistant", content: null, reasoning_content: "Inspect first", tool_calls: [
      { id: "old-call", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
    ] },
    { role: "tool", tool_call_id: "old-call", content: "src tests" },
  ];
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }];

  function request(headers: Record<string, string> = {}, body: object = { messages, tools, model: "test-model" }, path = "/mini-swe-agent/default/v1/chat/completions") {
    return createApp(config()).request(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-user-key", "x-conversation-id": "same-session",
        "x-team-id": "team-test", "x-agent-id": "agent-test", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("recognizes the client and tenant, and preserves the complete baseline request", async () => {
    expect(extractSpaceIdFromPath("/mini-swe-agent/tenant-a/v1/chat/completions")).toBe("tenant-a");
    expect(resolveAgentAdapter("mini-swe-agent").agentKind).toBe("mini-swe-agent");
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-tdai-knowledge")).toBe("disabled");
    expect(calls.find((c) => c.path === "/v1/chat/completions")?.body).toMatchObject({ messages, tools });
    expect(calls.every((c) => ["/v3/meta/auth/verify", "/v3/internal/meta/instance-upstream/list", "/v1/chat/completions"].includes(c.path))).toBe(true);
  });

  it.each([false, true])("injects only bound knowledge and preserves bash (stream=%s)", async (stream) => {
    const response = await request({ "x-tdai-knowledge": "enabled", "x-tdai-knowledge-url": "http://host.docker.internal:8424/v3" }, { messages, tools, stream, model: "test-model" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-tdai-knowledge-count")).toBe("1");
    expect(await response.text()).toContain("bash");
    const forwarded = calls.find((c) => c.path === "/v1/chat/completions")!.body;
    expect(forwarded.tools).toEqual(tools);
    expect(forwarded.messages.slice(1)).toEqual(messages.slice(1));
    expect(forwarded.messages[0].content).toContain("<knowledge_tools>");
    expect(forwarded.messages[0].content).toContain("http://host.docker.internal:8424/v3");
    expect(forwarded.messages[0].content).not.toContain("internal-test");
    expect(forwarded.messages[0].content).not.toContain("<session_context>");
    expect(calls.find((c) => c.path.includes("list-with-detail"))?.body.touch_usage).toBe(false);
    expect(calls.find((c) => c.path === "/v3/knowledge/list")?.body).toEqual({ team_id: "team-test", knowledge_ids: ["kb-test"], pagination: { limit: 200 } });
    expect(calls.filter((c) => c.path.startsWith("/v3/")).every((c) => c.headers["x-tdai-service-id"] === "default")).toBe(true);
    expect(calls.some((c) => /write|extract|participation|conversation\/add/.test(c.path))).toBe(false);
  });

  it("does not leak an enabled request into a disabled request with the same session", async () => {
    expect((await request({ "x-tdai-knowledge": "enabled" })).status).toBe(200);
    calls = [];
    expect((await request({ "x-tdai-knowledge": "disabled" }, { messages, model: "test-model" }, "/mini-swe-agent/default/chat/completions")).status).toBe(200);
    expect(calls.find((c) => c.path === "/v1/chat/completions")?.body.messages).toEqual(messages);
    expect(calls.some((c) => c.path.includes("knowledge") || c.path.includes("agent-fixed"))).toBe(false);
  });

  it("paginates bindings and batches knowledge IDs without truncating an enabled run", async () => {
    resourceCount = 201;
    const response = await request({ "x-tdai-knowledge": "enabled" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-tdai-knowledge-count")).toBe("201");
    expect(calls.filter((c) => c.path.includes("list-with-detail")).map((c) => c.body.offset)).toEqual([0, 100, 200]);
    expect(calls.filter((c) => c.path === "/v3/knowledge/list").map((c) => c.body.knowledge_ids.length)).toEqual([200, 1]);
  });

  it.each([
    [{ "x-conversation-id": "" }, 400],
    [{ "x-tdai-knowledge": "maybe" }, 400],
    [{ "x-tdai-knowledge": "enabled", "x-agent-id": "" }, 400],
    [{ "x-tdai-knowledge": "enabled", "x-team-id": "another-team" }, 403],
    [{ "x-tdai-knowledge": "enabled", "x-agent-id": "another-agent" }, 403],
    [{ "x-tdai-knowledge": "enabled", "x-tdai-knowledge-url": "file:///private" }, 400],
    [{ authorization: "Bearer invalid-key" }, 401],
  ] as Array<[Record<string, string>, number]>)("rejects invalid identity or options: %j", async (headers, status) => {
    expect((await request(headers)).status).toBe(status);
    expect(calls.some((c) => c.path === "/v1/chat/completions")).toBe(false);
  });

  it.each(["empty", "disabled", "unavailable"])("fails visibly when knowledge is %s", async (failure) => {
    emptyAssets = failure === "empty";
    disableWiki = failure === "disabled";
    failKnowledge = failure === "unavailable";
    expect((await request({ "x-tdai-knowledge": "enabled" })).status).toBe(failKnowledge ? 503 : 409);
    expect(calls.some((c) => c.path === "/v1/chat/completions")).toBe(false);
  });
});
