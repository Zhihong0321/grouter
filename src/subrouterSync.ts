import { Pool } from "pg";
import { env } from "./config/env.js";
import { SubRouterClient, SubRouterError } from "./lib/subrouterClient.js";
import { SupplierSyncError, syncAllSupplierActivity } from "./lib/supplierSync.js";

if (!env.SUBROUTER_SESSION || !env.SUBROUTER_USER_ID) {
  console.error(JSON.stringify({
    supplier: "subrouter",
    synchronized: false,
    errorType: "not_configured",
    error: "SubRouter credentials are not configured",
  }));
  process.exitCode = 1;
} else {
  const pg = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const result = await syncAllSupplierActivity({
      pg,
      quotaPerUsd: String(env.SUBROUTER_QUOTA_PER_USD),
      client: new SubRouterClient({
        baseUrl: env.SUBROUTER_BASE_URL,
        session: env.SUBROUTER_SESSION,
        userId: env.SUBROUTER_USER_ID,
        timeoutMs: env.SUBROUTER_SYNC_REQUEST_TIMEOUT_MS,
      }),
    });
    console.log(JSON.stringify({ synchronized: true, ...result }));
  } catch (error) {
    const known = error instanceof SubRouterError || error instanceof SupplierSyncError;
    console.error(JSON.stringify({
      supplier: "subrouter",
      synchronized: false,
      errorType: known ? error.type : "unknown",
      error: known ? error.message : "Supplier synchronization failed",
    }));
    process.exitCode = 1;
  } finally {
    await pg.end();
  }
}
