-- Breaks the single opaque latency_ms into stages so a slow request can be
-- attributed to our own overhead vs. the network/provider connect vs. the
-- provider's own generation time, instead of one number that could mean any
-- of the three.
ALTER TABLE reseller_request_logs ADD COLUMN pre_dispatch_ms int;
ALTER TABLE reseller_request_logs ADD COLUMN upstream_ttfb_ms int;
