import { Pool } from "pg";
import { env } from "./config/env.js";
import { SupplierKeySyncError, syncAvailableModelsFromSupplierKeys } from "./lib/supplierKeySync.js";

const pg = new Pool({ connectionString: env.DATABASE_URL });
try {
  const result = await syncAvailableModelsFromSupplierKeys({
    pg,
    upstreamBaseUrl: env.SUBROUTER_UPSTREAM_BASE_URL,
  });
  console.log(JSON.stringify({ synchronized: true, ...result }));
} catch (error) {
  const known = error instanceof SupplierKeySyncError;
  console.error(JSON.stringify({
    supplier: "subrouter",
    synchronized: false,
    errorType: known ? error.type : "unknown",
    error: known ? error.message : "SubRouter available-model synchronization failed",
  }));
  process.exitCode = 1;
} finally {
  await pg.end();
}
