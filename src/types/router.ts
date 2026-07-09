export type ProviderStandard = "anthropic" | "openai";

export interface ModelCatalogEntry {
  modelId: string;
  brand: string;
  standard: ProviderStandard;
  displayName: string;
  active: boolean;
}

/** A model's route, pre-joined with its (decrypted) provider so the hot path never re-touches SQL. */
export interface ResolvedRoute {
  routeId: string;
  providerId: string;
  providerName: string;
  standard: ProviderStandard;
  baseUrl: string;
  apiKey: string;
  upstreamModelId: string;
  priority: number;
}
