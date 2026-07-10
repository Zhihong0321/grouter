ALTER TABLE reseller_request_logs DROP COLUMN IF EXISTS pre_dispatch_ms;
ALTER TABLE reseller_request_logs DROP COLUMN IF EXISTS upstream_ttfb_ms;
