-- Up Migration
ALTER TABLE reseller_model_routes
  ADD COLUMN admin_disabled boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE reseller_model_routes
  DROP COLUMN admin_disabled;
