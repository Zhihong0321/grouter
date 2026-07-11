import JSONbigFactory from "json-bigint";

const JSONbig = JSONbigFactory();

export type SubRouterErrorType =
  | "auth_expired"
  | "invalid_response"
  | "network"
  | "timeout"
  | "upstream_http";

export class SubRouterError extends Error {
  constructor(
    public readonly type: SubRouterErrorType,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "SubRouterError";
  }
}

type FetchLike = typeof fetch;
export type JsonInteger = number | bigint | { isInteger(): boolean; toFixed(): string };

export interface SubRouterClientOptions {
  baseUrl: string;
  session: string;
  userId: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

interface Envelope {
  success: boolean;
  message?: unknown;
  data: unknown;
}

interface GetResult {
  statusCode: number;
  data: unknown;
}

export interface ActivityPage {
  page: number;
  pageSize: number;
  total: number;
  items: Record<string, unknown>[];
}

export interface SupplierStats {
  quota: string;
  token: string;
}

export interface SubRouterTokenPage {
  page: number;
  pageSize: number;
  total: number;
  items: Record<string, unknown>[];
}

export interface SubRouterModelCatalog {
  /** Maps a supplier group/channel identifier to the model IDs it advertises. */
  groups: Record<string, string[]>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function integerString(value: unknown, field: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    value.constructor?.name === "BigNumber" &&
    typeof (value as { isInteger?: unknown }).isInteger === "function" &&
    typeof (value as { toFixed?: unknown }).toFixed === "function" &&
    (value as { isInteger(): boolean }).isInteger()
  ) {
    return (value as { toFixed(): string }).toFixed();
  }
  throw new SubRouterError("invalid_response", `SubRouter field ${field} was not an exact integer`);
}

function nonNegativeSafeNumber(value: unknown, field: string): number {
  const parsed = integerString(value, field);
  const asNumber = Number(parsed);
  if (!Number.isSafeInteger(asNumber) || asNumber < 0) {
    throw new SubRouterError("invalid_response", `SubRouter field ${field} was out of range`);
  }
  return asNumber;
}

function isAuthRedirect(response: Response): boolean {
  if (!response.redirected || !response.url) return false;
  try {
    return /\/(login|auth)(\/|$)/i.test(new URL(response.url).pathname);
  } catch {
    return false;
  }
}

function looksLikeAuthFailure(message: unknown): boolean {
  return typeof message === "string" && /(auth|login|session|unauthor|forbidden|未登录|登录)/i.test(message);
}

export function stringifySupplierJson(value: unknown): string {
  return JSONbig.stringify(value);
}

export function parseSupplierJson(value: string): unknown {
  return JSONbig.parse(value);
}

export class SubRouterClient {
  private readonly baseUrl: string;
  private readonly session: string;
  private readonly userId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: SubRouterClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.session = options.session;
    this.userId = options.userId;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async get(path: string, query?: Record<string, string>): Promise<GetResult> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          Accept: "application/json",
          Cookie: `session=${this.session}`,
          "New-Api-User": this.userId,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new SubRouterError("timeout", "SubRouter request timed out");
      }
      throw new SubRouterError("network", "SubRouter request failed");
    } finally {
      clearTimeout(timeout);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === 401 || response.status === 403 || isAuthRedirect(response) || contentType.includes("text/html")) {
      throw new SubRouterError("auth_expired", "SubRouter authentication was rejected", response.status);
    }

    if (!response.ok) {
      throw new SubRouterError("upstream_http", `SubRouter returned HTTP ${response.status}`, response.status);
    }

    let envelope: unknown;
    try {
      envelope = JSONbig.parse(await response.text());
    } catch {
      throw new SubRouterError("invalid_response", "SubRouter returned invalid JSON", response.status);
    }

    if (!isRecord(envelope) || typeof envelope.success !== "boolean" || !("data" in envelope)) {
      throw new SubRouterError("invalid_response", "SubRouter returned an invalid response envelope", response.status);
    }

    const parsed = envelope as unknown as Envelope;
    if (!parsed.success) {
      if (looksLikeAuthFailure(parsed.message)) {
        throw new SubRouterError("auth_expired", "SubRouter authentication was rejected", response.status);
      }
      throw new SubRouterError("invalid_response", "SubRouter rejected the request", response.status);
    }

    return { statusCode: response.status, data: parsed.data };
  }

  async getAccount(): Promise<Record<string, unknown>> {
    const result = await this.get("/api/user/self");
    if (!isRecord(result.data) || String(result.data.id) !== this.userId) {
      throw new SubRouterError("invalid_response", "SubRouter account identity did not match");
    }
    return result.data;
  }

  async listActivity(params: {
    page: number;
    pageSize: number;
    startTimestamp: number;
    endTimestamp: number;
  }): Promise<ActivityPage> {
    const result = await this.get("/api/log/self", {
      p: String(params.page),
      page_size: String(params.pageSize),
      type: "0",
      start_timestamp: String(params.startTimestamp),
      end_timestamp: String(params.endTimestamp),
    });
    if (!isRecord(result.data) || !Array.isArray(result.data.items)) {
      throw new SubRouterError("invalid_response", "SubRouter activity response was invalid");
    }
    const items = result.data.items;
    if (!items.every(isRecord)) {
      throw new SubRouterError("invalid_response", "SubRouter activity contained an invalid record");
    }
    return {
      page: nonNegativeSafeNumber(result.data.page, "data.page"),
      pageSize: nonNegativeSafeNumber(result.data.page_size, "data.page_size"),
      total: nonNegativeSafeNumber(result.data.total, "data.total"),
      items,
    };
  }

  async getStats(startTimestamp: number, endTimestamp: number): Promise<SupplierStats> {
    const result = await this.get("/api/log/self/stat", {
      type: "0",
      start_timestamp: String(startTimestamp),
      end_timestamp: String(endTimestamp),
    });
    if (!isRecord(result.data)) {
      throw new SubRouterError("invalid_response", "SubRouter statistics response was invalid");
    }
    return {
      quota: integerString(result.data.quota, "data.quota"),
      token: integerString(result.data.token, "data.token"),
    };
  }

  async listTokens(params: { page: number; pageSize: number }): Promise<SubRouterTokenPage> {
    const result = await this.get("/api/token/", {
      p: String(params.page),
      size: String(params.pageSize),
    });
    if (!isRecord(result.data) || !Array.isArray(result.data.items) || !result.data.items.every(isRecord)) {
      throw new SubRouterError("invalid_response", "SubRouter token response was invalid");
    }
    return {
      page: nonNegativeSafeNumber(result.data.page, "data.page"),
      pageSize: nonNegativeSafeNumber(result.data.page_size, "data.page_size"),
      total: nonNegativeSafeNumber(result.data.total, "data.total"),
      items: result.data.items,
    };
  }

  async listModels(): Promise<SubRouterModelCatalog> {
    const result = await this.get("/api/models");
    if (!isRecord(result.data)) {
      throw new SubRouterError("invalid_response", "SubRouter model catalog response was invalid");
    }

    const groups: Record<string, string[]> = {};
    for (const [group, value] of Object.entries(result.data)) {
      // The endpoint currently also returns one metadata object alongside its
      // group -> model[] map. Preserve the model arrays and ignore metadata.
      if (!Array.isArray(value)) continue;
      if (!value.every((model) => typeof model === "string")) {
        throw new SubRouterError("invalid_response", `SubRouter model group ${group} was invalid`);
      }
      groups[group] = value;
    }

    if (Object.keys(groups).length === 0) {
      throw new SubRouterError("invalid_response", "SubRouter returned no model groups");
    }
    return { groups };
  }

  async probeConnection(): Promise<SubRouterConnectionProbe> {
    const endTimestamp = Math.floor(Date.now() / 1000);
    const startTimestamp = endTimestamp - 60 * 60;

    await this.getAccount();
    const activity = await this.listActivity({
      page: 1,
      pageSize: 1,
      startTimestamp,
      endTimestamp,
    });
    await this.getStats(startTimestamp, endTimestamp);

    return {
      supplier: "subrouter",
      connected: true,
      checkedAt: new Date().toISOString(),
      endpoints: {
        account: 200,
        activity: activity ? 200 : 500,
        statistics: 200,
      },
    };
  }
}

export interface SubRouterConnectionProbe {
  supplier: "subrouter";
  connected: true;
  checkedAt: string;
  endpoints: {
    account: number;
    activity: number;
    statistics: number;
  };
}
