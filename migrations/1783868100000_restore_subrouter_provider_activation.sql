-- Up Migration
UPDATE reseller_providers p
SET active = true
WHERE p.active = false
  AND EXISTS (
    SELECT 1
    FROM reseller_supplier_keys k
    WHERE k.provider_id = p.id OR k.anthropic_provider_id = p.id
  );

-- Down Migration
-- This data repair intentionally has no reverse operation: the prior
-- provider-level toggles were the behavior this migration corrects.
SELECT 1;
