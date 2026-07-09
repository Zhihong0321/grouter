ALTER TABLE reseller_usage_logs DROP COLUMN IF EXISTS provider_id;
ALTER TABLE reseller_usage_logs DROP COLUMN IF EXISTS upstream_model_id;

DROP TABLE IF EXISTS reseller_model_routes;
DROP TABLE IF EXISTS reseller_providers;
DROP TABLE IF EXISTS reseller_models;
