UPDATE reseller_providers p
SET active = true
WHERE p.active = false
  AND EXISTS (
    SELECT 1
    FROM reseller_supplier_keys k
    WHERE k.provider_id = p.id OR k.anthropic_provider_id = p.id
  );
