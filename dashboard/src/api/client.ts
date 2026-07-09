const BASE = "/admin/api";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface ApiKeyDto {
  id: string;
  name: string;
  keyPrefix: string;
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
  subrouterApiKeyMasked: string | null;
  subrouterConfigured: boolean;
  subrouterBaseUrl: string | null;
  keyPrefix: string;
}

export const api = {
  login: (email: string, password: string) => request<{ ok: true }>("/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: true }>("/logout", { method: "POST" }),
  me: () => request<{ adminId: string }>("/me"),

  listKeys: () => request<ApiKeyDto[]>("/keys"),
  getKey: (id: string) => request<ApiKeyDto>(`/keys/${id}`),
  createKey: (body: { name: string; rateLimitRpm?: number; budgetCents?: number; modelRestrictions?: string[] | null }) =>
    request<ApiKeyDto & { plaintextKey: string }>("/keys", { method: "POST", body: JSON.stringify(body) }),
  updateKey: (id: string, body: Partial<{ name: string; rateLimitRpm: number; budgetCents: number; modelRestrictions: string[] | null }>) =>
    request<ApiKeyDto>(`/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  revokeKey: (id: string) => request<ApiKeyDto>(`/keys/${id}/revoke`, { method: "POST" }),

  getKeyUsage: (id: string, range: "7d" | "30d") => request<UsageResponse>(`/keys/${id}/usage?range=${range}`),

  listPrices: () => request<ModelPriceDto[]>("/prices"),
  updatePrice: (modelId: string, body: Partial<ModelPriceDto>) =>
    request<ModelPriceDto>(`/prices/${modelId}`, { method: "PATCH", body: JSON.stringify(body) }),

  getSettings: () => request<SettingsDto>("/settings"),
  updateSettings: (body: { subrouterApiKey?: string; subrouterBaseUrl?: string; keyPrefix?: string }) =>
    request<SettingsDto>("/settings", { method: "PATCH", body: JSON.stringify(body) }),
};

export function centsToDollars(cents: number | string): string {
  return `$${(Number(cents) / 100).toFixed(4)}`;
}
