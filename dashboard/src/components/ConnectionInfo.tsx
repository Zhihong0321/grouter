import { useState } from "react";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="secondary" onClick={copy}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// The proxy's /v1/messages route lives at the app's own root (see
// src/app.ts / src/routes/proxy/messages.ts), not under /admin -- so the
// "base URL" a client needs is just this dashboard's own origin.
export default function ConnectionInfo({ apiKey, keyPrefix }: { apiKey: string | null; keyPrefix: string }) {
  const baseUrl = window.location.origin;
  const keyForSnippet = apiKey ?? `${keyPrefix}…REISSUE_TO_RECOVER`;

  const envSnippet = `ANTHROPIC_BASE_URL=${baseUrl}\nANTHROPIC_API_KEY=${keyForSnippet}`;
  const curlSnippet = `curl ${baseUrl}/v1/messages \\\n  -H "x-api-key: ${keyForSnippet}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"<model-id>","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'`;

  const openAiEnvSnippet = `OPENAI_BASE_URL=${baseUrl}/v1\nOPENAI_API_KEY=${keyForSnippet}`;
  const openAiCurlSnippet = `curl ${baseUrl}/v1/chat/completions \\\n  -H "Authorization: Bearer ${keyForSnippet}" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"<model-id>","messages":[{"role":"user","content":"Hello"}]}'`;

  return (
    <div className="card">
      <h3>Connect a client</h3>
      <div className="form-row">
        <label>Base URL</label>
        <div style={{ display: "flex", gap: 8 }}>
          <code style={{ flex: 1, background: "#1a1d24", padding: "8px 10px", borderRadius: 6 }}>{baseUrl}</code>
          <CopyButton text={baseUrl} />
        </div>
      </div>

      {!apiKey && (
        <p style={{ color: "#ff8080", fontSize: 13 }}>
          This key's plaintext isn't stored (issued before key recovery was added) -- revoke and reissue to get a
          copyable key for the snippets below.
        </p>
      )}

      <div className="form-row">
        <label>Environment variables</label>
        <pre className="plaintext-reveal" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{envSnippet}</pre>
        <div><CopyButton text={envSnippet} /></div>
      </div>

      <div className="form-row">
        <label>curl example (swap in a real model id -- see the Prices page)</label>
        <pre className="plaintext-reveal" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{curlSnippet}</pre>
        <div><CopyButton text={curlSnippet} /></div>
      </div>

      <h3 style={{ marginTop: 24 }}>Connect an OpenAI-standard client</h3>
      <p style={{ fontSize: 13, color: "#9aa0aa" }}>
        For models whose upstream provider uses the OpenAI API (chat completions / responses), point the client at{" "}
        <code>{baseUrl}/v1</code> instead and send the key as a Bearer token.
      </p>

      <div className="form-row">
        <label>Environment variables</label>
        <pre className="plaintext-reveal" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{openAiEnvSnippet}</pre>
        <div><CopyButton text={openAiEnvSnippet} /></div>
      </div>

      <div className="form-row">
        <label>curl example (swap in a real model id -- see the Prices page)</label>
        <pre className="plaintext-reveal" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{openAiCurlSnippet}</pre>
        <div><CopyButton text={openAiCurlSnippet} /></div>
      </div>
    </div>
  );
}
