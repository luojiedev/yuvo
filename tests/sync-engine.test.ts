import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRemoteChanges, countUnsyncedOperations, createTransaction, ensureDefaultData, listAccounts, listCategories, listLedgers, listPendingOperations, listTransactions, markLedgerAsNetworkBound, openBookkeepingDatabase, updateOperationStates, updateTransaction } from "../lib/local-database";
import { synchronizeLedger } from "../lib/sync-engine";
import type { NetworkSession } from "../lib/domain";

afterEach(() => vi.restoreAllMocks());

describe("synchronization recovery boundaries", () => {
  it("drains more than 50 operations in globally chronological batches", async () => {
    const database = await openBookkeepingDatabase(`sync-${crypto.randomUUID()}`);
    try {
      await ensureDefaultData(database);
      const ledger = (await listLedgers(database))[0];
      await markLedgerAsNetworkBound(database, ledger.id);
      const category = (await listCategories(database, ledger.id))[0];
      const account = (await listAccounts(database, ledger.id))[0];
      const ids: string[] = [];
      for (let index = 0; index < 61; index += 1) {
        const operationId = `operation-${String(100 - index).padStart(3, "0")}`;
        ids.push(operationId);
        await createTransaction(database, { ledgerId: ledger.id, operationId, type: "expense", amountMinor: 100, currency: "CNY", occurredAt: new Date().toISOString(), categoryId: category.id, categoryName: category.name, accountId: account.id, accountName: account.name });
      }
      const pushed: string[][] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const path = String(input);
        if (path.endsWith("/sync/push")) {
          const body = JSON.parse(String(init?.body)) as { operations: Array<{ operationId: string }> };
          pushed.push(body.operations.map((operation) => operation.operationId));
          return Response.json({ results: body.operations.map((operation) => ({ operationId: operation.operationId, status: "applied" })) });
        }
        if (path.includes("transaction-creators")) return Response.json({ creators: [] });
        if (path.includes("/sync/pull")) return Response.json({ changes: [], nextRevision: 0, hasMore: false });
        throw new Error(`Unexpected request: ${path}`);
      });
      const session: NetworkSession = { key: "current", token: "test-token", expiresAt: new Date(Date.now() + 60000).toISOString(), userId: crypto.randomUUID(), username: "test", displayName: "测试", deviceId: "device-test" };
      const report = await synchronizeLedger(database, session, ledger.id);
      expect(pushed.map((batch) => batch.length)).toEqual([50, 11]);
      expect(pushed.flat()).toEqual(ids);
      expect(report.pushed).toBe(61);
      expect(await countUnsyncedOperations(database)).toBe(0);
    } finally { database.close(); }
  });

  it("does not flag a later local edit as conflict when pulling its acknowledged creation", async () => {
    const database = await openBookkeepingDatabase(`sync-${crypto.randomUUID()}`);
    try {
      await ensureDefaultData(database);
      const ledger = (await listLedgers(database))[0];
      const category = (await listCategories(database, ledger.id))[0];
      const account = (await listAccounts(database, ledger.id))[0];
      const created = await createTransaction(database, { ledgerId: ledger.id, operationId: crypto.randomUUID(), type: "expense", amountMinor: 100, currency: "CNY", occurredAt: new Date().toISOString(), categoryId: category.id, categoryName: category.name, accountId: account.id, accountName: account.name });
      await updateOperationStates(database, [{ operationId: created.operationId, status: "synced" }]);
      await updateTransaction(database, created.id, { ...created, operationId: crypto.randomUUID(), note: "尚未提交的新修改" });
      const result = await applyRemoteChanges(database, ledger.id, [{ revision: 1, entityType: "transaction", entityId: created.id, entityVersion: 1, operationType: "create", operationId: created.operationId, payload: { ...created }, changedByUserId: "test-user", createdAt: created.createdAt }]);
      expect(result.conflicts).toBe(0);
      expect((await listTransactions(database, ledger.id))[0].note).toBe("尚未提交的新修改");
      expect(await listPendingOperations(database, ledger.id)).toHaveLength(1);
    } finally { database.close(); }
  });
});
