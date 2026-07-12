const BASE = "/admin/api";

// A session can die mid-browse (expiry, or the server restarting on deploy
// since sessions aren't preserved across process restarts). Every page's API
// calls funnel through here, so this is the one place to catch that and kick
// the SPA back to the login screen instead of leaving a page stuck on
// "Loading..." with an unhandled rejection in the console.
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  if (res.status === 401 && path !== "/me") {
    window.dispatchEvent(new Event("admin-unauthenticated"));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.message ?? body.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface ApiKeyDto {
  id: string;
  name: string;
  keyPrefix: string;
  key: string | null;
  status: "active" | "revoked";
  rateLimitRpm: number;
  budgetCents: number;
  spentCents: number;
  modelRestrictions: string[] | null;
  /** Smart Routing Mode -- per-key, per-client opt-in. Not the provider-failover "smart routing" on the Router page. */
  smartRoutingClaudeCode: boolean;
  smartRoutingCodex: boolean;
  createdAt: string;
  revokedAt: string | null;
}

export type Tier = "brain" | "build" | "routine";

export interface TierConfigDto {
  tiers: { brain: string; build: string; routine: string };
  longContextTokens: number;
  shortTurnTokens: number;
  smallFastModelName: string;
  mode: "smart" | "honor_tier";
  honorExplicitRoutine: boolean;
}

export interface TierRoutingSavingsDto {
  client: string | null;
  overridden_request_count: string;
  cost_baseline_cents: string;
  cost_saved_cents: string;
}

export interface ModelPriceDto {
  modelId: string;
  inputPriceCentsPerMillion: number;
  outputPriceCentsPerMillion: number;
  cacheWritePriceCentsPerMillion: number;
  cacheReadPriceCentsPerMillion: number;
  active: boolean;
  updatedAt: string;
}

export interface UsageBreakdown {
  input_tokens: string;
  output_tokens: string;
  cache_creation_input_tokens: string;
  cache_read_input_tokens: string;
  input_cost_cents: string;
  output_cost_cents: string;
  cache_write_cost_cents: string;
  cache_read_cost_cents: string;
  cost_cents: string;
  request_count: string;
}

export interface UsageResponse {
  breakdown: UsageBreakdown;
  daily: { day: string; cost_cents: string; total_tokens: string }[];
  recent: any[];
}

export interface SettingsDto {
  keyPrefix: string;
}

export interface ProviderHealthDto {
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  modelCount?: number;
  message: string;
}

export interface EndpointTestResultDto {
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  message: string;
}

export interface OpenAiEndpointTestResultDto {
  chat: EndpointTestResultDto;
  responses: EndpointTestResultDto;
}

export interface StreamingTestResultDto {
  ok: boolean;
  statusCode?: number;
  ttfbMs?: number;
  totalMs: number;
  chunksReceived: number;
  message: string;
}

export interface OpenAiStreamingTestResultDto {
  chat: StreamingTestResultDto;
  responses: StreamingTestResultDto;
}

export interface ProviderModelTestResultDto {
  standard: "anthropic" | "openai";
  modelId: string;
  results: Array<EndpointTestResultDto & { endpoint: "messages" | "chat/completions" | "responses" }>;
}

export interface ModelDto {
  modelId: string;
  brand: string;
  standard: "anthropic" | "openai";
  displayName: string;
  active: boolean;
  createdAt: string;
}

export interface ProviderDto {
  id: string;
  name: string;
  standard: "anthropic" | "openai";
  baseUrl: string;
  apiKeySet: boolean;
  apiKeyLast4: string;
  active: boolean;
  createdAt: string;
  source: "manual" | "subrouter";
  /** Exact model IDs returned by GET /v1/models for this imported supplier key. */
  supplierKeyModelIds: string[] | null;
}

export interface ModelRouteDto {
  routeId: string;
  providerId: string;
  providerName: string;
  standard: "anthropic" | "openai";
  upstreamModelId: string;
  priority: number;
  active: boolean;
}

export interface SupplierKeyDto {
  id: string;
  externalTokenId: string;
  name: string;
  status: number;
  keyLast4: string;
  remainingQuotaUnits: string | null;
  usedQuotaUnits: string | null;
  unlimitedQuota: boolean;
  modelLimitsEnabled: boolean;
  allowedModels: string[];
  supplierGroup: string | null;
  expiresAt: string | null;
  accessedAt: string | null;
  presentOnSupplier: boolean;
  lastSyncedAt: string;
}

export interface SupplierKeySyncDto {
  supplier: "subrouter";
  sync: {
    supplier: "subrouter";
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastErrorType: string | null;
    lastError: string | null;
    lastKeyCount: number;
    lastModelCount: number;
    lastModelSyncAttemptAt: string | null;
    lastModelSyncSuccessAt: string | null;
    lastModelSyncErrorType: string | null;
    lastModelSyncError: string | null;
    lastAvailableModelCount: number;
  } | null;
  catalogModelCount: number;
  keys: SupplierKeyDto[];
}

export interface SupplierKeySyncResultDto {
  synchronized: true;
  supplier: "subrouter";
  keyCount: number;
  modelCount: number;
  restrictedKeyCount: number;
  routingProviderCount: number;
  syncedAt: string;
}

export interface SupplierAvailableModelSyncResultDto {
  synchronized: true;
  supplier: "subrouter";
  keyCount: number;
  availableModelCount: number;
  addedToRoutingCatalog: number;
  alreadyInRoutingCatalog: number;
  conflictingModelIds: string[];
  syncedAt: string;
}

export interface SmartRouteDto {
  routeId: string;
  providerId: string;
  providerName: string;
  priority: number;
  active: boolean;
  upstreamModelId: string;
  keyLast4: string | null;
  smokeHistory: { ok: boolean; latencyMs: number; message: string; testedAt: string }[];
}

export interface SmartRoutingModelDto {
  modelId: string;
  brand: string;
  standard: "anthropic" | "openai";
  displayName: string;
  active: boolean;
  routes: SmartRouteDto[];
}

export interface SmartRoutingSyncResultDto {
  synchronized: true;
  supplier: "subrouter";
  keys: SupplierKeySyncResultDto;
  models: SupplierAvailableModelSyncResultDto;
  routes: { addedRouteCount: number; reactivatedRouteCount: number; deactivatedRouteCount: number; routedModelCount: number };
}

export interface SupplierActivityDto {
  createdAt: string;
  tokenName: string | null;
  modelName: string | null;
  promptTokens: string;
  completionTokens: string;
  cacheTokens: string;
  costUsd: string;
  group: string | null;
  providerName: string | null;
  channelName: string | null;
  requestId: string | null;
  logId: string;
}

export interface SupplierActivityDashboardDto {
  supplier: "subrouter";
  sync: {
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastErrorType: string | null;
    lastError: string | null;
    lastImportedCount: number;
    totalImportedCount: string;
    reconciliationMatched: boolean | null;
  } | null;
  account: {
    remainingQuotaUnits: string;
    usedQuotaUnits: string;
    remainingWalletUsd: string;
    usedWalletUsd: string;
    requestCount: string;
    lastFetchedAt: string;
  } | null;
  summary: { activityCount: string; totalCostUsd: string; totalTokens: string };
  activity: SupplierActivityDto[];
}

export interface SupplierActivitySyncResultDto {
  synchronized: true;
  supplier: "subrouter";
  fetchedCount: number;
  importedCount: number;
  totalStoredCount: number;
  reconciliationMatched: true;
  quotaUnits: string;
  tokenCount: string;
}

export interface RequestLogDto {
  id: string;
  created_at: string;
  key_id: string | null;
  key_name: string | null;
  endpoint: string;
  model: string;
  outcome: "success" | "upstream_error" | "all_providers_failed" | "no_route";
  status_code: number | null;
  provider_id: string | null;
  provider_name: string | null;
  upstream_model_id: string | null;
  error_message: string | null;
  attempts: { providerName: string; statusCode?: number; error?: string }[] | null;
  /** Time from upstream dispatch to full response consumed (ttfb + generation/streaming). */
  latency_ms: number | null;
  /** Our own overhead before dispatch: auth lookup, rate limit, budget check, routing lookup. */
  pre_dispatch_ms: number | null;
  /** Time from dispatch to the winning provider's response headers arriving. */
  upstream_ttfb_ms: number | null;

  /** Smart Routing Mode decision, captured as it was at request time. */
  client: "claude_code" | "codex" | "unknown" | null;
  smart_routing_enabled: boolean | null;
  routing_mode: "smart" | "honor_tier" | null;
  requested_tier: Tier | null;
  chosen_model: string | null;
  rule_id: string | null;
  was_overridden: boolean | null;
  cost_baseline_cents: string | null;
  cost_saved_cents: string | null;
}

export const api = {
  login: (email: string, password: string) => request<{ ok: true }>("/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: true }>("/logout", { method: "POST" }),
  me: () => request<{ adminId: string }>("/me"),

  listKeys: () => request<ApiKeyDto[]>("/keys"),
  getKey: (id: string) => request<ApiKeyDto>(`/keys/${id}`),
  createKey: (body: { name: string; rateLimitRpm?: number; budgetCents?: number; modelRestrictions?: string[] | null; smartRoutingClaudeCode?: boolean; smartRoutingCodex?: boolean }) =>
    request<ApiKeyDto>("/keys", { method: "POST", body: JSON.stringify(body) }),
  updateKey: (
    id: string,
    body: Partial<{ name: string; rateLimitRpm: number; budgetCents: number; modelRestrictions: string[] | null; smartRoutingClaudeCode: boolean; smartRoutingCodex: boolean }>,
  ) => request<ApiKeyDto>(`/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  revokeKey: (id: string) => request<ApiKeyDto>(`/keys/${id}/revoke`, { method: "POST" }),
  removeKey: (id: string) => request<void>(`/keys/${id}`, { method: "DELETE" }),

  getKeyUsage: (id: string, range: "7d" | "30d") => request<UsageResponse>(`/keys/${id}/usage?range=${range}`),

  listPrices: () => request<ModelPriceDto[]>("/prices"),
  updatePrice: (modelId: string, body: Partial<ModelPriceDto>) =>
    request<ModelPriceDto>(`/prices/${modelId}`, { method: "PATCH", body: JSON.stringify(body) }),

  getSettings: () => request<SettingsDto>("/settings"),
  updateSettings: (body: { keyPrefix?: string }) => request<SettingsDto>("/settings", { method: "PATCH", body: JSON.stringify(body) }),

  listModels: () => request<ModelDto[]>("/models"),
  createModel: (body: { modelId: string; displayName: string; brand?: string; standard?: "anthropic" | "openai" }) =>
    request<ModelDto>("/models", { method: "POST", body: JSON.stringify(body) }),
  updateModel: (modelId: string, body: Partial<{ displayName: string; brand: string; active: boolean }>) =>
    request<ModelDto>(`/models/${modelId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteModel: (modelId: string) => request<ModelDto>(`/models/${modelId}`, { method: "DELETE" }),

  listProviders: () => request<ProviderDto[]>("/providers"),
  createProvider: (body: { name: string; baseUrl: string; apiKey: string; standard?: "anthropic" | "openai" }) =>
    request<ProviderDto>("/providers", { method: "POST", body: JSON.stringify(body) }),
  updateProvider: (id: string, body: Partial<{ name: string; baseUrl: string; apiKey: string; active: boolean }>) =>
    request<ProviderDto>(`/providers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProvider: (id: string) => request<void>(`/providers/${id}`, { method: "DELETE" }),
  checkProviderHealth: (id: string) => request<ProviderHealthDto>(`/providers/${id}/health`, { method: "POST" }),
  testOpenaiProvider: (id: string) => request<OpenAiEndpointTestResultDto>(`/providers/${id}/test-openai`, { method: "POST" }),
  testOpenaiStreaming: (id: string) => request<OpenAiStreamingTestResultDto>(`/providers/${id}/test-openai-streaming`, { method: "POST" }),
  testProviderModel: (id: string, modelId: string) => request<ProviderModelTestResultDto>(`/providers/${id}/test-model`, { method: "POST", body: JSON.stringify({ modelId }) }),

  getSupplierKeys: () => request<SupplierKeySyncDto>("/supplier-sync/keys"),
  syncSupplierKeys: () => request<SupplierKeySyncResultDto>("/supplier-sync/keys", { method: "POST" }),
  syncSupplierAvailableModels: () => request<SupplierAvailableModelSyncResultDto>("/supplier-sync/available-models", { method: "POST" }),
  syncSmartRouting: () => request<SmartRoutingSyncResultDto>("/supplier-sync/smart-routing", { method: "POST" }),
  getSmartRouting: () => request<SmartRoutingModelDto[]>("/smart-routing"),
  smokeTestAllSmartRoutes: () => request<{ tested: number; passed: number; failed: number }>("/smart-routing/smoke-test-all", { method: "POST" }),
  getSupplierActivity: () => request<SupplierActivityDashboardDto>("/supplier-sync/activity"),
  syncSupplierActivity: () => request<SupplierActivitySyncResultDto>("/supplier-sync/activity", { method: "POST" }),

  getModelRoutes: (modelId: string) => request<ModelRouteDto[]>(`/models/${modelId}/routes`),
  putModelRoutes: (modelId: string, routes: { providerId: string; upstreamModelId: string; priority: number }[]) =>
    request<ModelRouteDto[]>(`/models/${modelId}/routes`, { method: "PUT", body: JSON.stringify({ routes }) }),
  setModelRoutePriority: (modelId: string, providerIds: string[]) =>
    request<ModelRouteDto[]>(`/models/${modelId}/routes/priority`, { method: "PUT", body: JSON.stringify({ providerIds }) }),

  getTierRoutingConfig: () => request<TierConfigDto>("/tier-routing/config"),
  updateTierRoutingConfig: (
    body: Partial<{
      brainModel: string;
      buildModel: string;
      routineModel: string;
      longContextTokens: number;
      shortTurnTokens: number;
      smallFastModelName: string;
      mode: "smart" | "honor_tier";
      honorExplicitRoutine: boolean;
    }>,
  ) => request<TierConfigDto>("/tier-routing/config", { method: "PATCH", body: JSON.stringify(body) }),
  getTierRoutingSavings: () => request<TierRoutingSavingsDto[]>("/tier-routing/savings"),

  listRequestLogs: (filters: { limit?: number; model?: string; outcome?: string; keyId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.limit) params.set("limit", String(filters.limit));
    if (filters.model) params.set("model", filters.model);
    if (filters.outcome) params.set("outcome", filters.outcome);
    if (filters.keyId) params.set("keyId", filters.keyId);
    const qs = params.toString();
    return request<RequestLogDto[]>(`/logs${qs ? `?${qs}` : ""}`);
  },
};

export function centsToDollars(cents: number | string): string {
  return `$${(Number(cents) / 100).toFixed(4)}`;
}
