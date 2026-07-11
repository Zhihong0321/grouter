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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      envelope = await response.json();
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

  async probeConnection(): Promise<SubRouterConnectionProbe> {
    const endTimestamp = Math.floor(Date.now() / 1000);
    const startTimestamp = endTimestamp - 60 * 60;

    const account = await this.get("/api/user/self");
    if (!isRecord(account.data) || String(account.data.id) !== this.userId) {
      throw new SubRouterError("invalid_response", "SubRouter account identity did not match");
    }

    const activity = await this.get("/api/log/self", {
      p: "1",
      page_size: "1",
      type: "0",
      start_timestamp: String(startTimestamp),
      end_timestamp: String(endTimestamp),
    });
    if (!isRecord(activity.data) || !Array.isArray(activity.data.items)) {
      throw new SubRouterError("invalid_response", "SubRouter activity response was invalid");
    }

    const stats = await this.get("/api/log/self/stat", {
      type: "0",
      start_timestamp: String(startTimestamp),
      end_timestamp: String(endTimestamp),
    });
    if (!isRecord(stats.data) || !("quota" in stats.data) || !("token" in stats.data)) {
      throw new SubRouterError("invalid_response", "SubRouter statistics response was invalid");
    }

    return {
      supplier: "subrouter",
      connected: true,
      checkedAt: new Date().toISOString(),
      endpoints: {
        account: account.statusCode,
        activity: activity.statusCode,
        statistics: stats.statusCode,
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
