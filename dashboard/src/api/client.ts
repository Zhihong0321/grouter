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
  createdAt: string;
  revokedAt: string | null;
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
}

export const api = {
  login: (email: string, password: string) => request<{ ok: true }>("/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: true }>("/logout", { method: "POST" }),
  me: () => request<{ adminId: string }>("/me"),

  listKeys: () => request<ApiKeyDto[]>("/keys"),
  getKey: (id: string) => request<ApiKeyDto>(`/keys/${id}`),
  createKey: (body: { name: string; rateLimitRpm?: number; budgetCents?: number; modelRestrictions?: string[] | null }) =>
    request<ApiKeyDto>("/keys", { method: "POST", body: JSON.stringify(body) }),
  updateKey: (id: string, body: Partial<{ name: string; rateLimitRpm: number; budgetCents: number; modelRestrictions: string[] | null }>) =>
    request<ApiKeyDto>(`/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  revokeKey: (id: string) => request<ApiKeyDto>(`/keys/${id}/revoke`, { method: "POST" }),

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

  getSupplierKeys: () => request<SupplierKeySyncDto>("/supplier-sync/keys"),
  syncSupplierKeys: () => request<SupplierKeySyncResultDto>("/supplier-sync/keys", { method: "POST" }),
  syncSupplierAvailableModels: () => request<SupplierAvailableModelSyncResultDto>("/supplier-sync/available-models", { method: "POST" }),

  getModelRoutes: (modelId: string) => request<ModelRouteDto[]>(`/models/${modelId}/routes`),
  putModelRoutes: (modelId: string, routes: { providerId: string; upstreamModelId: string; priority: number }[]) =>
    request<ModelRouteDto[]>(`/models/${modelId}/routes`, { method: "PUT", body: JSON.stringify({ routes }) }),

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
