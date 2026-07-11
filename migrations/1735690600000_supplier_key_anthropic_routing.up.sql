-- A supplier key can serve both OpenAI-compatible and Anthropic-compatible
-- endpoints. Keep a distinct provider for each protocol so their base URL,
-- authentication headers, health checks, and model routes remain correct.
ALTER TABLE reseller_supplier_keys
  ADD COLUMN anthropic_provider_id uuid REFERENCES reseller_providers(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_supplier_keys_anthropic_provider
  ON reseller_supplier_keys (anthropic_provider_id)
  WHERE anthropic_provider_id IS NOT NULL;
