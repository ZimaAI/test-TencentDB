import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

/** mini-SWE-agent sends ordinary Chat Completions with bash tool calls. */
export const miniSweAgentAdapter: AgentAdapter = {
  agentKind: "mini-swe-agent",
  classifyRequest: () => "main",
  extractUserText: defaultAdapter.extractUserText,
};
