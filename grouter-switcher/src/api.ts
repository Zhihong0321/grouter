import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ModelInfo {
  id: string;
}

export interface VerifyResult {
  valid: boolean;
  anthropicModels: ModelInfo[];
  openAiModels: ModelInfo[];
}

export interface AccountResult {
  username: string;
  recoveryPassword?: string;
}

export interface BalanceResult {
  username: string;
  balanceCents: number | null;
  spentCents: number;
  unlimited: boolean;
}

export type ToolMode = "official" | "grouter" | "smart";

export interface ToolStatus {
  installed: boolean;
  enabled: boolean;
  smart: boolean;
  drifted: boolean;
}

export interface StatusResult {
  claude: ToolStatus;
  codex: ToolStatus;
  opencode: ToolStatus;
  baseUrl: string;
  selectedAnthropicModel: string | null;
  selectedOpenAiModel: string | null;
}

export interface DetectResult {
  claudeConfigExists: boolean;
  codexConfigExists: boolean;
  opencodeConfigExists: boolean;
}

export type ToolId = "claude" | "codex" | "opencode";

export interface ToolInstallStatus {
  installed: boolean;
  version: string | null;
  latestVersion: string | null;
  path: string | null;
}

export type InstallStatusResult = Record<ToolId, ToolInstallStatus>;

export interface ToolLogEvent {
  tool: ToolId;
  line: string;
}

export interface ToolLogDoneEvent {
  tool: ToolId;
  success: boolean;
  exitCode: number | null;
}

export interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costCents: number;
  stream: boolean;
  createdAt: string;
}

export interface UsageResult {
  requestCount: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  recent: UsageEntry[];
}

export interface AppError {
  kind: "Io" | "ParseFailed" | "Network" | "InvalidKey" | "NotFound";
  message: string;
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as AppError).message);
  }
  return String(err);
}

export const api = {
  hasLocalKey: () => invoke<boolean>("has_local_key"),
  applyForKey: (username: string, recoveryPassword: string) =>
    invoke<AccountResult>("apply_for_key", { username, recoveryPassword }),
  recoverAccount: (recoveryPassword: string) => invoke<AccountResult>("recover_account", { recoveryPassword }),
  getBalance: () => invoke<BalanceResult>("get_balance"),
  getUsage: (range?: "7d" | "30d") => invoke<UsageResult>("get_usage", { range }),
  getStatus: () => invoke<StatusResult>("get_status"),
  verifyKey: (baseUrl: string, key: string) => invoke<VerifyResult>("verify_key", { baseUrl, key }),
  verifyStoredKey: () => invoke<VerifyResult>("verify_stored_key"),
  setConfig: (baseUrl: string, anthropicModel?: string, openAiModel?: string) =>
    invoke<void>("set_config", { baseUrl, anthropicModel, openAiModel }),
  toggleClaude: (mode: ToolMode) => invoke<void>("toggle_claude", { mode }),
  toggleCodex: (mode: ToolMode) => invoke<void>("toggle_codex", { mode }),
  toggleOpencode: (mode: ToolMode) => invoke<void>("toggle_opencode", { mode }),
  detectTools: () => invoke<DetectResult>("detect_tools"),
  openConfigDir: (tool: ToolId) => invoke<void>("open_config_dir", { tool }),
  detectInstallations: () => invoke<InstallStatusResult>("detect_installations"),
  installTool: (tool: ToolId) => invoke<void>("install_tool", { tool }),
  updateTool: (tool: ToolId) => invoke<void>("update_tool", { tool }),
};

// Subscribes to the streamed install/update output for a single tool,
// filtering out events meant for other tools. Resolves once both listeners
// are registered, so callers can await it before triggering the command
// that emits them. Returns an unsubscribe fn.
export async function listenToolLog(
  tool: ToolId,
  onLine: (line: string) => void,
  onDone: (result: { success: boolean; exitCode: number | null }) => void,
): Promise<() => void> {
  const unlistenLog = await listen<ToolLogEvent>("tool-log", (event) => {
    if (event.payload.tool === tool) onLine(event.payload.line);
  });
  const unlistenDone = await listen<ToolLogDoneEvent>("tool-log-done", (event) => {
    if (event.payload.tool === tool) onDone({ success: event.payload.success, exitCode: event.payload.exitCode });
  });

  return () => {
    unlistenLog();
    unlistenDone();
  };
}
