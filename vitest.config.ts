import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        compatibilityDate: "2026-07-16",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["ATTACHMENTS"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "drizzle")),
          VAPID_PUBLIC_KEY: "test-vapid-public-key",
          VAPID_PRIVATE_KEY: "test-vapid-private-key",
          VAPID_SUBJECT: "mailto:test@example.com",
        },
      },
    })),
  ],
  test: {
    include: ["worker-tests/**/*.test.ts"],
    setupFiles: ["./worker-tests/apply-migrations.ts"],
    testTimeout: 20_000,
  },
});
