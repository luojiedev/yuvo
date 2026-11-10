import { describe, expect, it } from "vitest";
import { OperationTimeoutError, withOperationTimeout } from "../lib/operation-timeout";

describe("operation timeout", () => {
  it("returns a completed operation", async () => {
    await expect(withOperationTimeout(Promise.resolve("ready"), "startup", 50)).resolves.toBe("ready");
  });

  it("rejects an operation that remains pending", async () => {
    const pending = new Promise<never>(() => undefined);
    await expect(withOperationTimeout(pending, "read_local_ledger", 5)).rejects.toMatchObject({
      name: "OperationTimeoutError",
      operation: "read_local_ledger",
      timeoutMs: 5,
    } satisfies Partial<OperationTimeoutError>);
  });
});
