import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { createLedger, createTransaction, ensureDefaultData, listAccounts, listCategories, listLedgers, listPendingOperations, listTransactions, openBookkeepingDatabase, saveCategory, saveSubscription, updateOperationStates, updateTransaction } from "../lib/local-database";
import { exportLedgerBackup, restoreLedgerBackup } from "../lib/backup-restore";
import { listSyncIssues, resolveSyncIssue } from "../lib/sync-recovery";
import { activateAccountDatabase, copyLedgerStorage, lockAccountDatabase, openAccountDatabase, openActiveAccountDatabase } from "../lib/account-storage";
import { ViewContext } from "../lib/view-context";
import type { RemoteSyncChange } from "../lib/domain";

async function fixture() {
  const database = await openBookkeepingDatabase(`test-${crypto.randomUUID()}`);
  await ensureDefaultData(database);
  const ledger = (await listLedgers(database))[0];
  const account = (await listAccounts(database, ledger.id))[0];
  const category = (await listCategories(database, ledger.id))[0];
  const row = await createTransaction(database, { operationId: crypto.randomUUID(), ledgerId: ledger.id, type: "expense", amountMinor: 1200, currency: "CNY", occurredAt: "2026-09-08T00:00:00.000Z", categoryId: category.id, categoryName: category.name, accountId: account.id, accountName: account.name, note: "本地内容" });
  return { database, ledger, row, account, category };
}

describe("account and asynchronous view isolation", () => {
  it("locks account data on logout and restores its pending outbox only after login", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const userId = crypto.randomUUID();
    const database = await openAccountDatabase(userId);
    try {
      await createLedger(database, "账号私有账本");
      const session = { key: "current" as const, token: "token", expiresAt: new Date(Date.now() + 60000).toISOString(), userId, username: "user", displayName: "用户", deviceId: "device-id" };
      await activateAccountDatabase(database, session);
      await lockAccountDatabase(database);
      const guest = await openActiveAccountDatabase();
      expect(await listLedgers(guest)).toHaveLength(0);
      guest.close();
      await activateAccountDatabase(database, session);
      const restored = await openActiveAccountDatabase();
      expect((await listLedgers(restored))[0].name).toBe("账号私有账本");
      restored.close();
    } finally { database.close(); vi.unstubAllGlobals(); }
  });
  it("keeps identical shared ledger IDs in independent account databases", async () => {
    const first = await openAccountDatabase(crypto.randomUUID());
    const second = await openAccountDatabase(crypto.randomUUID());
    try {
      await createLedger(first, "账号一", { id: "shared-ledger-id" });
      await createLedger(second, "账号二", { id: "shared-ledger-id" });
      expect((await listLedgers(first))[0].name).toBe("账号一");
      expect((await listLedgers(second))[0].name).toBe("账号二");
    } finally { first.close(); second.close(); }
  });

  it("copies only authorized ledgers and preserves existing pending edits on repeated login", async () => {
    const { database, ledger, row } = await fixture();
    const target = await openAccountDatabase(crypto.randomUUID());
    try {
      await createLedger(database, "不属于此账号的账本");
      await copyLedgerStorage(database, target, [ledger.id]);
      await updateTransaction(target, row.id, { ...row, transactionId: row.id, operationId: crypto.randomUUID(), note: "目标待同步修改" });
      await copyLedgerStorage(database, target, [ledger.id]);
      expect(await listLedgers(target)).toHaveLength(1);
      expect((await listTransactions(target, ledger.id))[0].note).toBe("目标待同步修改");
      expect(await listPendingOperations(target, ledger.id)).toHaveLength(2);
      expect((await listTransactions(database, ledger.id))[0].note).toBe("本地内容");
    } finally { database.close(); target.close(); }
  });

  it("rejects a delayed result even when switching A → B → A", async () => {
    const view = new ViewContext();
    const oldResult = view.capture();
    view.invalidate(); view.invalidate();
    expect(oldResult()).toBe(false);
    expect(view.capture()()).toBe(true);
  });
});

describe("complete JSON restore", () => {
  it("restores custom catalogs, subscriptions, budget and attachments with remapped references", async () => {
    const { database, ledger, row, account } = await fixture();
    try {
      const category = await saveCategory(database, { ledgerId: ledger.id, type: "expense", name: "自定义支出" });
      const subscription = await saveSubscription(database, { ledgerId: ledger.id, name: "会员", beneficiary: "家人", accountId: account.id, categoryId: category.id, amountMinor: 100, currency: "CNY", baseAmountMinor: 100, exchangeRateMicros: 1_000_000, exchangeRateSource: "fixed", exchangeRateAt: row.occurredAt, frequency: "month", interval: 1, nextChargeOn: "2026-10-08", remindDaysBefore: 3, status: "active", lastGeneratedPeriodKey: "2026-09-08" });
      const blob = new Blob(["image"], { type: "image/png" });
      await updateTransaction(database, row.id, { ...row, operationId: crypto.randomUUID(), categoryId: category.id, categoryName: category.name, subscriptionId: subscription.id, subscriptionPeriodKey: "2026-09-08", images: [{ id: "image-backup-1", name: "图片", type: blob.type, size: blob.size, blob, status: "pending" }] });
      const backup = await exportLedgerBackup(database, ledger.id);
      backup.ledger.monthlyBudgetMinor = 520000;
      const target = await createLedger(database, "恢复目标");
      await restoreLedgerBackup(database, target.id, backup);
      const restored = (await listTransactions(database, target.id))[0];
      expect(restored.id).not.toBe(row.id);
      expect(restored.categoryId).not.toBe(category.id);
      expect(restored.subscriptionId).not.toBe(subscription.id);
      expect(restored.subscriptionPeriodKey).toBe("2026-09-08");
      expect(await restored.images[0].blob!.text()).toBe("image");
      expect((await listLedgers(database)).find((item) => item.id === target.id)?.monthlyBudgetMinor).toBe(520000);
      const operationsBefore = await listPendingOperations(database, target.id, 1000);
      const repeated = await restoreLedgerBackup(database, target.id, backup);
      expect(repeated.imported).toBe(0);
      expect(await listTransactions(database, target.id)).toHaveLength(1);
      expect(await listPendingOperations(database, target.id, 1000)).toHaveLength(operationsBefore.length);
    } finally { database.close(); }
  });

  it("rolls back the entire import when a later catalog has pending changes", async () => {
    const { database, ledger } = await fixture();
    try {
      const backup = await exportLedgerBackup(database, ledger.id);
      const target = await createLedger(database, "回滚目标");
      const targetCategory = (await listCategories(database, target.id))[0];
      await saveCategory(database, { ...targetCategory, ledgerId: target.id });
      const before = await listPendingOperations(database, target.id, 1000);
      await expect(restoreLedgerBackup(database, target.id, backup)).rejects.toThrow("未同步修改");
      expect(await listTransactions(database, target.id)).toHaveLength(0);
      expect(await listPendingOperations(database, target.id, 1000)).toEqual(before);
    } finally { database.close(); }
  });

  it("rejects an incomplete backup instead of mapping to an arbitrary account", async () => {
    const { database, ledger } = await fixture();
    try {
      const backup = await exportLedgerBackup(database, ledger.id);
      backup.accounts = [];
      await expect(restoreLedgerBackup(database, ledger.id, backup)).rejects.toThrow("账户");
    } finally { database.close(); }
  });

  it("refuses a complete export while attachment contents are missing", async () => {
    const { database, ledger, row } = await fixture();
    try {
      await updateTransaction(database, row.id, { ...row, operationId: crypto.randomUUID(), images: [{ id: "missing-image", name: "图片", type: "image/png", size: 5, status: "failed" }] });
      await expect(exportLedgerBackup(database, ledger.id)).rejects.toThrow("附件尚未下载");
    } finally { database.close(); }
  });
});

describe("conflict recovery", () => {
  for (const choice of ["remote", "resubmit", "copy"] as const) {
    it(`resolves ${choice} atomically and refuses double submission`, async () => {
      const { database, ledger, row } = await fixture();
      try {
        await updateOperationStates(database, [{ operationId: row.operationId, status: "conflict", error: "版本冲突" }]);
        const issue = (await listSyncIssues(database, ledger.id))[0];
        const remote: RemoteSyncChange = { revision: 1, entityType: "transaction", entityId: row.id, entityVersion: 3, operationType: "update", operationId: "remote-operation", changedByUserId: "remote-user", createdAt: row.createdAt, payload: { ...row, note: "云端内容" } };
        await resolveSyncIssue(database, issue, remote, choice);
        expect(await listSyncIssues(database, ledger.id)).toHaveLength(0);
        const rows = await listTransactions(database, ledger.id);
        expect(rows).toHaveLength(choice === "copy" ? 2 : 1);
        const original = rows.find((item) => item.id === row.id)!;
        expect(original.note).toBe(choice === "resubmit" ? "本地内容" : "云端内容");
        const pending = await listPendingOperations(database, ledger.id);
        expect(pending).toHaveLength(choice === "remote" ? 0 : 1);
        if (choice === "resubmit") expect(pending[0]).toMatchObject({ baseVersion: 3, operationType: "update", payload: { note: "本地内容" } });
        await expect(resolveSyncIssue(database, issue, remote, choice)).rejects.toThrow("本地内容已变化");
      } finally { database.close(); }
    });
  }

  it("preserves newer edits made after the comparison was opened", async () => {
    const { database, ledger, row } = await fixture();
    try {
      await updateOperationStates(database, [{ operationId: row.operationId, status: "failed" }]);
      const issue = (await listSyncIssues(database, ledger.id))[0];
      await updateTransaction(database, row.id, { ...row, operationId: crypto.randomUUID(), note: "比较后新修改" });
      await expect(resolveSyncIssue(database, issue, null, "resubmit")).rejects.toThrow("本地内容已变化");
      expect((await listTransactions(database, ledger.id))[0].note).toBe("比较后新修改");
    } finally { database.close(); }
  });
});
