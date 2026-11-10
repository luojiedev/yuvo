import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateDeviceId } from "../lib/network-api";

describe("client device identifiers", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
    });
  });

  it("reuses a device identifier for the same account and isolates different accounts", () => {
    const ownerDeviceId = getOrCreateDeviceId("Owner");
    expect(getOrCreateDeviceId(" owner ")).toBe(ownerDeviceId);
    expect(getOrCreateDeviceId("family-member")).not.toBe(ownerDeviceId);
  });
});
