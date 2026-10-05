import type { Context } from "hono";
import { renderKnowledgeToolsBlock } from "./injection/injectors/knowledge-tools-injector.js";
import type { KnowledgeItem } from "./knowledge/core-client.js";
import { MetadataClient } from "./meta/client.js";
import type { CoreSkillConfig, ProxyConfig } from "./types.js";

export class MiniSweAgentError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 409 | 503, message: string) {
    super(message);
  }
}

/** Evaluation requests must fail visibly instead of silently running without knowledge. */
async function post<T>(
  config: CoreSkillConfig, spaceId: string, userKey: string, path: string, body: object,
): Promise<T> {
  const response = await fetch(`${config.endpoint.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.serviceToken}`,
      "content-type": "application/json",
      "x-tdai-service-id": spaceId,
      "x-tdai-user-key": userKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new MiniSweAgentError(503, `Knowledge dependency failed (HTTP ${response.status})`);
  const envelope = await response.json() as { code: number; data?: T };
  if (envelope.code !== 0 || !envelope.data) throw new MiniSweAgentError(503, "Knowledge dependency returned an error");
  return envelope.data;
}

export async function prepareMiniSweAgentRequest(
  c: Context, config: ProxyConfig, body: Record<string, unknown>,
  identity: { userId: string; userKey: string; spaceId: string },
): Promise<Record<string, unknown>> {
  const mode = c.req.header("x-tdai-knowledge") ?? "disabled";
  if (mode !== "enabled" && mode !== "disabled") {
    throw new MiniSweAgentError(400, "x-tdai-knowledge must be enabled or disabled");
  }
  const sessionId = c.req.header("x-conversation-id")?.trim();
  if (!sessionId) throw new MiniSweAgentError(400, "x-conversation-id is required; use a unique ID per run/instance");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new MiniSweAgentError(400, "messages must be a non-empty array");
  }
  c.header("x-tdai-knowledge", mode);
  c.header("x-tdai-knowledge-count", "0");
  if (mode === "disabled") return body;

  const teamId = c.req.header("x-team-id")?.trim();
  const agentId = c.req.header("x-agent-id")?.trim();
  if (!teamId || !agentId) throw new MiniSweAgentError(400, "Knowledge requires x-team-id and x-agent-id");
  if (!identity.userId || !identity.userKey) throw new MiniSweAgentError(401, "Knowledge requires an authenticated user key");
  if (!config.knowledge.enabled || !config.injection.enabled || !config.injection.injectors.includes("knowledge")) {
    throw new MiniSweAgentError(503, "Knowledge injection is disabled on this proxy");
  }

  // This URL is rendered for the agent's shell, never fetched by the proxy.
  let publicUrl: string | undefined;
  if (c.req.header("x-tdai-knowledge-url")) {
    let url: URL;
    try { url = new URL(c.req.header("x-tdai-knowledge-url")!); }
    catch { throw new MiniSweAgentError(400, "x-tdai-knowledge-url must be an absolute HTTP(S) URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new MiniSweAgentError(400, "x-tdai-knowledge-url must be HTTP(S) without credentials, query or fragment");
    }
    publicUrl = url.toString().replace(/\/+$/, "");
  }

  const { userId, userKey, spaceId } = identity;
  const metadata = new MetadataClient(config.coreSkill, spaceId, userKey);
  const teams = await metadata.listTeams(userId);
  if (!teams.some((t) => t.team_id === teamId)) throw new MiniSweAgentError(403, "Team is not accessible to this user");
  const agents = await metadata.listAgents(teamId, userId);
  if (!agents.some((a) => a.agent_id === agentId && a.team_id === teamId)) {
    throw new MiniSweAgentError(403, "Agent is not accessible in this team");
  }
  const assets = await metadata.getAgentFixedAssets(agentId, {
    assetTypes: ["llm_wiki", "code_graph"], applyVisibilityFilter: true, touchUsage: false,
  });
  const ids = assets.items
    .filter((a) => ["llm_wiki", "code_graph"].includes(a.asset_type)
      && !["archived", "deprecated", "failed"].includes(a.status ?? ""))
    .map((a) => a.asset_id);
  if (!ids.length) throw new MiniSweAgentError(409, "No visible knowledge is bound to this agent");

  const capabilities = await post<{ items: Array<{ param_name: string; effective_value: string }> }>(
    config.coreSkill, spaceId, userKey, "/v3/meta/config/user/get", { user_id: userId, module: "asset_type" },
  );
  const disabled = new Set(capabilities.items
    .filter((p) => !["1", "true"].includes(p.effective_value.toLowerCase()))
    .map((p) => p.param_name));
  const knowledge: KnowledgeItem[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const page = await post<{ items: KnowledgeItem[] }>(
      config.knowledge, spaceId, userKey, "/v3/knowledge/list",
      { team_id: teamId, knowledge_ids: ids.slice(offset, offset + 200), pagination: { limit: 200 } },
    );
    knowledge.push(...page.items);
  }
  const resources = knowledge
    .filter((r) => ids.includes(r.knowledge_id) && r.team_id === teamId
      && ["wiki", "code-graph"].includes(r.type)
      && !disabled.has(r.type === "wiki" ? "llm_wiki.enabled" : "code_graph.enabled"))
    .map((r) => ({ ...r, service_url: publicUrl ?? r.service_url }))
    .sort((a, b) => a.knowledge_id.localeCompare(b.knowledge_id));
  const content = renderKnowledgeToolsBlock(resources, spaceId, {
    sessionKey: `mini-swe-agent:${sessionId}`, userId, teamId, agentId, agentSource: "mini-swe-agent", spaceId,
  });
  if (!content) throw new MiniSweAgentError(409, "No ready, enabled knowledge is available for this agent");

  // Keep bash tools, reasoning fields, tool results and all user messages intact.
  const messages = [...body.messages] as Array<Record<string, unknown>>;
  const index = messages.findIndex((m) => m.role === "system");
  if (index < 0) messages.unshift({ role: "system", content });
  else {
    const original = messages[index];
    messages[index] = {
      ...original,
      content: Array.isArray(original.content)
        ? [...original.content, { type: "text", text: content }]
        : `${original.content ?? ""}\n\n${content}`,
    };
  }
  c.header("x-tdai-knowledge-count", String(resources.length));
  console.log(`[mini-swe-agent] session=${sessionId} knowledge=enabled resources=${resources.length}`);
  return { ...body, messages };
}
