import { invoke } from "@tauri-apps/api/core";

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

export interface ToolStatus {
  installed: boolean;
  enabled: boolean;
  drifted: boolean;
}

export interface StatusResult {
  claude: ToolStatus;
  codex: ToolStatus;
  baseUrl: string;
  selectedAnthropicModel: string | null;
  selectedOpenAiModel: string | null;
}

export interface DetectResult {
  claudeConfigExists: boolean;
  codexConfigExists: boolean;
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
  toggleClaude: (on: boolean) => invoke<void>("toggle_claude", { on }),
  toggleCodex: (on: boolean) => invoke<void>("toggle_codex", { on }),
  detectTools: () => invoke<DetectResult>("detect_tools"),
  openConfigDir: (tool: "claude" | "codex") => invoke<void>("open_config_dir", { tool }),
};
