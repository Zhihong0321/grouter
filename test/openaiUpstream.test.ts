import { afterEach, describe, expect, it, vi } from "vitest";
import { callUpstream } from "../src/lib/upstream.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible upstream transport", () => {
  it("uses Bearer auth and injects stream usage for Chat Completions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await callUpstream(
      { standard: "openai", baseUrl: "https://supplier.example", apiKey: "secret", upstreamModelId: "supplier-chat-model" },
      { model: "public-model", stream: true, stream_options: { custom_flag: true } },
      undefined,
      "chat/completions",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://supplier.example/v1/chat/completions",
      expect.objectContaining({
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
      }),
    );
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      model: "supplier-chat-model",
      stream_options: { custom_flag: true, include_usage: true },
    });
  });

  it("routes Responses requests to /v1/responses without Chat-only stream options", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await callUpstream(
      { standard: "openai", baseUrl: "https://supplier.example", apiKey: "secret", upstreamModelId: "supplier-response-model" },
      { model: "public-model", stream: true },
      undefined,
      "responses",
    );

    expect(fetchMock).toHaveBeenCalledWith("https://supplier.example/v1/responses", expect.anything());
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({ model: "supplier-response-model", stream: true });
  });
});
