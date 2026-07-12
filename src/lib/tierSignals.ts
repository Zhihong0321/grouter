/**
 * Smart Routing Mode -- signal extraction. Pure, wire-format-aware adapters
 * that turn an inbound request body into the normalized `Signals` the
 * tierRouting engine decides on. See smart_routing_buildplan.md section 4.
 *
 * NOT to be confused with src/lib/smartRouting.ts, which syncs the provider
 * failover matrix (which supplier key serves which model) -- a completely
 * different concern. This module is model-TIER selection (brain/build/routine).
 */

export type Tier = "brain" | "build" | "routine";
export type ClientKind = "claude_code" | "codex" | "unknown";

export interface Signals {
  client: ClientKind;
  requestedTier: Tier;
  /** Claude Code's small-fast background slot. Always false for Codex. */
  isBackground: boolean;
  thinkingEnabled: boolean;
  inputTokens: number;
  hasTools: boolean;
}

export interface TierModelMap {
  brain: string;
  build: string;
  routine: string;
}

const CODEX_UA_PATTERN = /codex/i;

/**
 * Path is the primary signal: this proxy only ever receives Claude Code
 * traffic on /v1/messages, and /v1/responses is Codex-only in practice.
 * /v1/chat/completions is shared with generic OpenAI-compatible clients, so
 * User-Agent is the only way to tell a real Codex CLI apart from those.
 */
export function detectClient(
  headers: Record<string, string | string[] | undefined>,
  path: "messages" | "chat/completions" | "responses",
): ClientKind {
  if (path === "messages") return "claude_code";
  if (path === "responses") return "codex";
  const ua = headers["user-agent"];
  const uaStr = Array.isArray(ua) ? ua[0] ?? "" : ua ?? "";
  return CODEX_UA_PATTERN.test(uaStr) ? "codex" : "unknown";
}

/**
 * ~4 chars/token heuristic. There's no local tokenizer in this proxy, and
 * calling the real count_tokens endpoint per request would double every
 * upstream call just to make a routing decision -- tier thresholds are
 * coarse by design, so an approximation is good enough.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Maps a client-requested model name to the nearest tier when it isn't an
 * exact match for one of the configured tier models (e.g. a client asking
 * for a model that isn't the admin's current brain/build/routine pick).
 */
export function classifyRequestedTier(model: string, tiers: TierModelMap): Tier {
  if (model === tiers.brain) return "brain";
  if (model === tiers.build) return "build";
  if (model === tiers.routine) return "routine";
  const lower = model.toLowerCase();
  // Check routine suffixes first: "gpt-5-mini"/"o1-mini" would otherwise also
  // match the "gpt-5"/"o1" brain prefix below.
  if (/\bhaiku\b|\bmini\b|\bnano\b/.test(lower)) return "routine";
  if (/\bopus\b|\bo1\b|\bo3\b|\bgpt-5\b/.test(lower)) return "brain";
  return "build";
}

export interface AnthropicSignalsConfig {
  tiers: TierModelMap;
  /** Configured name of Claude Code's small-fast (background) model slot. */
  smallFastModelName: string;
}

export function signalsFromAnthropic(body: Record<string, unknown>, cfg: AnthropicSignalsConfig): Signals {
  const model = typeof body.model === "string" ? body.model : "";
  const thinking = body.thinking as { type?: string } | undefined;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = typeof body.system === "string" ? body.system : "";
  const tools = Array.isArray(body.tools) ? body.tools : [];

  // Extract text content from messages (not JSON structure)
  let contentText = system;
  for (const msg of messages) {
    if (typeof msg === "object" && msg !== null) {
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === "string") {
        contentText += content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null && typeof (block as Record<string, unknown>).text === "string") {
            contentText += (block as Record<string, unknown>).text;
          }
        }
      }
    }
  }

  return {
    client: "claude_code",
    requestedTier: classifyRequestedTier(model, cfg.tiers),
    isBackground: model.length > 0 && model === cfg.smallFastModelName,
    thinkingEnabled: thinking?.type === "enabled",
    inputTokens: estimateTokens(contentText),
    hasTools: tools.length > 0,
  };
}

export interface OpenAiSignalsConfig {
  tiers: TierModelMap;
}

function mapEffortToTier(effort: string): Tier {
  if (effort === "high") return "brain";
  if (effort === "low") return "routine";
  return "build";
}

export function signalsFromOpenAI(
  body: Record<string, unknown>,
  endpoint: "chat/completions" | "responses",
  cfg: OpenAiSignalsConfig,
): Signals {
  const model = typeof body.model === "string" ? body.model : "";
  const reasoning = body.reasoning as { effort?: string } | undefined;
  const effort = reasoning?.effort ?? (typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const content = endpoint === "responses" ? body.input : body.messages;

  // Extract text content from messages/input (not JSON structure)
  let contentText = "";
  if (typeof content === "string") {
    contentText = content;
  } else if (Array.isArray(content)) {
    for (const msg of content) {
      if (typeof msg === "object" && msg !== null) {
        const msgContent = (msg as Record<string, unknown>).content;
        if (typeof msgContent === "string") {
          contentText += msgContent;
        } else if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (typeof block === "object" && block !== null) {
              const text = (block as Record<string, unknown>).text;
              if (typeof text === "string") {
                contentText += text;
              }
            }
          }
        }
      }
    }
  }

  return {
    client: "codex",
    requestedTier: effort ? mapEffortToTier(effort) : classifyRequestedTier(model, cfg.tiers),
    isBackground: false,
    thinkingEnabled: effort === "high",
    inputTokens: estimateTokens(contentText),
    hasTools: tools.length > 0,
  };
}
