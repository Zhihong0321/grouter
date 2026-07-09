import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    // Several suites share one real Postgres instance (docker-compose.yml)
    // and do broad cleanup in afterEach/afterAll -- running files in
    // parallel would race those against each other's fixtures.
    fileParallelism: false,
  },
});
