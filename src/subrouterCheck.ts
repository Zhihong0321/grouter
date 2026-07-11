import { env } from "./config/env.js";
import { SubRouterClient, SubRouterError } from "./lib/subrouterClient.js";

if (!env.SUBROUTER_SESSION || !env.SUBROUTER_USER_ID) {
  console.error(JSON.stringify({
    supplier: "subrouter",
    connected: false,
    errorType: "not_configured",
    error: "SubRouter credentials are not configured",
  }));
  process.exitCode = 1;
} else {
  try {
    const result = await new SubRouterClient({
      baseUrl: env.SUBROUTER_BASE_URL,
      session: env.SUBROUTER_SESSION,
      userId: env.SUBROUTER_USER_ID,
      timeoutMs: env.SUBROUTER_REQUEST_TIMEOUT_MS,
    }).probeConnection();
    console.log(JSON.stringify(result));
  } catch (error) {
    const known = error instanceof SubRouterError;
    console.error(JSON.stringify({
      supplier: "subrouter",
      connected: false,
      errorType: known ? error.type : "unknown",
      error: known ? error.message : "SubRouter connection check failed",
    }));
    process.exitCode = 1;
  }
}
