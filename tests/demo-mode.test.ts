import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("blocks API calls before credentials or ledger data can leave the public demo", async () => {
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
  vi.resetModules();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { apiRequest } = await import("../lib/network-api");

  await expect(apiRequest("/sync/push", { method: "POST", body: JSON.stringify({ note: "local-only entry" }) }, "test-token"))
    .rejects.toMatchObject({ code: "DEMO_LOCAL_ONLY" });
  expect(fetch).not.toHaveBeenCalled();
});
