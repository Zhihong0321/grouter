import { describe, expect, it, vi } from "vitest";
import { SubRouterClient, SubRouterError } from "../src/lib/subrouterClient.js";

const SESSION = "session-secret-value";
const USER_ID = "42";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SubRouterClient", () => {
  it("authenticates and validates all three production probe endpoints", async () => {
    const requests: { url: URL; headers: Headers }[] = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, headers: new Headers(init?.headers) });

      if (url.pathname === "/api/user/self") {
        return jsonResponse({ success: true, data: { id: 42 } });
      }
      if (url.pathname === "/api/log/self") {
        return jsonResponse({ success: true, data: { page: 1, page_size: 1, total: 0, items: [] } });
      }
      if (url.pathname === "/api/log/self/stat") {
        return jsonResponse({ success: true, data: { quota: 0, token: 0, rpm: 0, tpm: 0 } });
      }
      return jsonResponse({ success: false, data: null }, 404);
    }) as typeof fetch;

    const result = await new SubRouterClient({
      baseUrl: "https://subrouter.ai",
      session: SESSION,
      userId: USER_ID,
      fetchImpl,
    }).probeConnection();

    expect(result.connected).toBe(true);
    expect(result.endpoints).toEqual({ account: 200, activity: 200, statistics: 200 });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/api/user/self",
      "/api/log/self",
      "/api/log/self/stat",
    ]);
    expect(requests[1].url.searchParams.get("page_size")).toBe("1");
    expect(requests[1].url.searchParams.get("type")).toBe("0");

    for (const request of requests) {
      expect(request.headers.get("cookie")).toBe(`session=${SESSION}`);
      expect(request.headers.get("new-api-user")).toBe(USER_ID);
      expect(request.headers.get("accept")).toBe("application/json");
    }
  });

  it("classifies rejected credentials without exposing them", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: false, message: `session ${SESSION} user ${USER_ID} must login`, data: null }),
    ) as typeof fetch;

    const client = new SubRouterClient({
      baseUrl: "https://subrouter.ai",
      session: SESSION,
      userId: USER_ID,
      fetchImpl,
    });

    await expect(client.probeConnection()).rejects.toMatchObject<Partial<SubRouterError>>({
      type: "auth_expired",
      message: "SubRouter authentication was rejected",
    });

    try {
      await client.probeConnection();
    } catch (error) {
      expect(String(error)).not.toContain(SESSION);
      expect(String(error)).not.toContain(USER_ID);
    }
  });

  it("rejects an account response for a different user", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: { id: 99 } })) as typeof fetch;
    const client = new SubRouterClient({
      baseUrl: "https://subrouter.ai",
      session: SESSION,
      userId: USER_ID,
      fetchImpl,
    });

    await expect(client.probeConnection()).rejects.toMatchObject({
      type: "invalid_response",
      message: "SubRouter account identity did not match",
    });
  });
});
