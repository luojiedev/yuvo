import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyRemoteChanges,
  clearNetworkSession,
  createLedger,
  createTransaction,
  defaultBookkeepingIds,
  ensureDefaultData,
  ensureOfflineLedgerUsesUniqueId,
  importRemoteLedgerSnapshot,
  deleteTransaction,
  listAccounts,
  listCategories,
  listLedgers,
  listPendingOperations,
  listSubscriptions,
  listSubcategories,
  listTransactions,
  markLedgerAsNetworkBound,
  openBookkeepingDatabase,
  saveNetworkSession,
  saveSubscription,
  updateTransaction,
  updateLedgerMonthlyBudget,
  updateOperationStates,
} from "../lib/local-database";

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("swift-ledger");
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("测试数据库删除被阻止")), { once: true });
  });
}

describe("local ledger identifiers", () => {
  beforeEach(deleteDatabase);

  it("creates new offline ledgers with a UUID", async () => {
    const database = await openBookkeepingDatabase();
    try {
      await ensureDefaultData(database);
      const ledgers = await listLedgers(database);
      expect(ledgers).toHaveLength(1);
      expect(ledgers[0].id).toMatch(/^ledger-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      expect(ledgers[0].id).not.toBe(defaultBookkeepingIds.ledgerId);
    } finally {
      database.close();
    }
  });

  it("stores a monthly budget locally and queues an idempotent ledger update", async () => {
    const database = await openBookkeepingDatabase();
    try {
      await ensureDefaultData(database);
      const ledger = (await listLedgers(database))[0];
      expect(ledger.monthlyBudgetMinor).toBe(300_000);

      const updated = await updateLedgerMonthlyBudget(database, ledger.id, 520_000);
      expect(updated.monthlyBudgetMinor).toBe(520_000);
      expect((await listLedgers(database))[0].monthlyBudgetMinor).toBe(520_000);
      expect(await listPendingOperations(database, ledger.id)).toEqual([
        expect.objectContaining({
          entityType: "ledger",
          entityId: ledger.id,
          operationType: "update",
          baseVersion: 1,
          payload: { monthlyBudgetMinor: 520_000 },
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("atomically rekeys an unbound legacy ledger and its outbox", async () => {
    const database = await openBookkeepingDatabase();
    try {
      await ensureDefaultData(database);
      await createLedger(database, "旧账本", { id: defaultBookkeepingIds.ledgerId });
      const legacyCategories = await listCategories(database, defaultBookkeepingIds.ledgerId);
      const legacySubcategories = await listSubcategories(database, defaultBookkeepingIds.ledgerId);
      const legacyAccounts = await listAccounts(database, defaultBookkeepingIds.ledgerId);
      const food = legacyCategories.find((category) => category.name === "餐饮")!;
      const breakfast = legacySubcategories.find((subcategory) => subcategory.categoryId === food.id)!;
      const cash = legacyAccounts[0];
      await createTransaction(database, {
        operationId: "operation-legacy-transaction",
        ledgerId: defaultBookkeepingIds.ledgerId,
        type: "expense",
        amountMinor: 1200,
        currency: "CNY",
        occurredAt: "2026-07-16T08:00:00.000Z",
        categoryId: food.id,
        categoryName: food.name,
        subcategoryId: breakfast.id,
        subcategoryName: breakfast.name,
        accountId: cash.id,
        accountName: cash.name,
      });

      const migratedLedgerId = await ensureOfflineLedgerUsesUniqueId(database, defaultBookkeepingIds.ledgerId);
      expect(migratedLedgerId).toMatch(/^ledger-[0-9a-f-]{36}$/u);
      expect((await listLedgers(database)).some((ledger) => ledger.id === defaultBookkeepingIds.ledgerId)).toBe(false);

      const migratedAccounts = await listAccounts(database, migratedLedgerId);
      const migratedCategories = await listCategories(database, migratedLedgerId);
      const migratedSubcategories = await listSubcategories(database, migratedLedgerId);
      const migratedTransactions = await listTransactions(database, migratedLedgerId);
      const migratedOperations = await listPendingOperations(database, migratedLedgerId);
      expect(migratedAccounts[0].id).toBe(`account-cash:${migratedLedgerId}`);
      expect(migratedCategories.every((category) => category.id.startsWith(`${migratedLedgerId}:`))).toBe(true);
      expect(migratedSubcategories.every((subcategory) => subcategory.id.startsWith(`${migratedLedgerId}:`))).toBe(true);
      expect(migratedTransactions[0]).toMatchObject({
        ledgerId: migratedLedgerId,
        accountId: migratedAccounts[0].id,
      });
      expect(migratedTransactions[0].categoryId).toBe(`${migratedLedgerId}:${food.id}`);
      expect(migratedTransactions[0].subcategoryId).toBe(`${migratedLedgerId}:${breakfast.id}`);
      expect(migratedOperations[0]).toMatchObject({
        operationId: "operation-legacy-transaction",
        ledgerId: migratedLedgerId,
      });
      expect(migratedOperations[0].payload).toMatchObject({
        accountId: migratedAccounts[0].id,
        categoryId: migratedTransactions[0].categoryId,
        subcategoryId: migratedTransactions[0].subcategoryId,
      });
    } finally {
      database.close();
    }
  });

  it("preserves the legacy identifier after the ledger is bound to an account", async () => {
    const database = await openBookkeepingDatabase();
    try {
      await ensureDefaultData(database);
      await createLedger(database, "已绑定账本", { id: defaultBookkeepingIds.ledgerId });
      await saveNetworkSession(database, {
        key: "current",
        token: "session-token",
        expiresAt: "2026-08-16T00:00:00.000Z",
        userId: "owner-user",
        username: "owner",
        displayName: "Owner",
        deviceId: "device-owner",
      });
      await markLedgerAsNetworkBound(database, defaultBookkeepingIds.ledgerId);
      await clearNetworkSession(database);
      expect(await ensureOfflineLedgerUsesUniqueId(database, defaultBookkeepingIds.ledgerId))
        .toBe(defaultBookkeepingIds.ledgerId);
      expect((await listLedgers(database)).some((ledger) => ledger.id === defaultBookkeepingIds.ledgerId)).toBe(true);
    } finally {
      database.close();
    }
  });

  it("updates transaction recorder names from a remote profile change", async () => {
    const database = await openBookkeepingDatabase();
    try {
      await ensureDefaultData(database);
      const ledger = (await listLedgers(database))[0];
      const category = (await listCategories(database, ledger.id))[0];
      const account = (await listAccounts(database, ledger.id))[0];
      const row = await createTransaction(database, {
        operationId: "operation-profile-name-test",
        ledgerId: ledger.id,
        type: "expense",
        amountMinor: 100,
        currency: "CNY",
        occurredAt: "2026-07-16T08:00:00.000Z",
        categoryId: category.id,
        categoryName: category.name,
        accountId: account.id,
        accountName: account.name,
        createdByUserId: "user-family-member",
        createdByDisplayName: "旧名称",
      });

      await applyRemoteChanges(database, ledger.id, [{
        revision: 1,
        entityType: "profile",
        entityId: "user-family-member",
        operationType: "update",
        entityVersion: 1,
        payload: { userId: "user-family-member", displayName: "新名称" },
        operationId: "profile-name-change",
        changedByUserId: "user-family-member",
        createdAt: "2026-07-16T09:00:00.000Z",
      }]);

      expect((await listTransactions(database, ledger.id)).find((item) => item.id === row.id)?.createdByDisplayName)
        .toBe("新名称");
    } finally {
      database.close();
    }
  });

  it("removes legacy ghost transactions when their subscription change arrives", async () => {
    const database = await openBookkeepingDatabase();
    try {
      await ensureDefaultData(database);
      const ledger = (await listLedgers(database))[0];
      const category = (await listCategories(database, ledger.id))[0];
      const account = (await listAccounts(database, ledger.id))[0];
      const subscriptionId = "subscription-legacy-ghost";
      const ghost = await createTransaction(database, {
        transactionId: subscriptionId,
        operationId: "operation-legacy-ghost",
        ledgerId: ledger.id,
        type: "expense",
        amountMinor: 1_500,
        currency: "CNY",
        occurredAt: "2026-07-20T10:00:00.000Z",
        categoryId: category.id,
        categoryName: "",
        accountId: account.id,
        accountName: "",
      });
      await updateOperationStates(database, [{ operationId: ghost.operationId, status: "synced" }]);

      const result = await applyRemoteChanges(database, ledger.id, [{
        revision: 1,
        entityType: "subscription",
        entityId: subscriptionId,
        operationType: "create",
        entityVersion: 1,
        payload: {
          name: "视频会员", beneficiary: "全家", accountId: account.id, categoryId: category.id,
          amountMinor: 1_500, currency: "CNY", baseAmountMinor: 1_500, exchangeRateMicros: 1_000_000,
          exchangeRateSource: "fixed", exchangeRateAt: "2026-07-20T10:00:00.000Z", frequency: "month",
          interval: 1, nextChargeOn: "2026-08-20", remindDaysBefore: 3, status: "active",
          lastGeneratedPeriodKey: null,
        },
        operationId: "remote-subscription-create",
        changedByUserId: "family-member",
        createdAt: "2026-07-20T10:00:00.000Z",
      }]);

      expect(result).toEqual({ applied: 1, conflicts: 0 });
      expect(await listTransactions(database, ledger.id)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("ignores unknown remote entity types instead of creating blank transactions", async () => {
    const database = await openBookkeepingDatabase();
    try {
      await ensureDefaultData(database);
      const ledger = (await listLedgers(database))[0];
      const result = await applyRemoteChanges(database, ledger.id, [{
        revision: 1,
        entityType: "future-entity" as "transaction",
        entityId: "future-entity-1",
        operationType: "create",
        entityVersion: 1,
        payload: { amountMinor: 2_000 },
        operationId: "remote-future-entity",
        changedByUserId: "family-member",
        createdAt: "2026-07-20T10:00:00.000Z",
      }]);

      expect(result).toEqual({ applied: 0, conflicts: 0 });
      expect(await listTransactions(database, ledger.id)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("removes legacy subscription ghosts while importing a login snapshot", async () => {
    const database = await openBookkeepingDatabase();
    try {
      await ensureDefaultData(database);
      const ledger = (await listLedgers(database))[0];
      const category = (await listCategories(database, ledger.id))[0];
      const account = (await listAccounts(database, ledger.id))[0];
      const subscriptionId = "subscription-login-ghost";
      await createTransaction(database, {
        transactionId: subscriptionId,
        operationId: "operation-login-ghost",
        ledgerId: ledger.id,
        type: "expense",
        amountMinor: 2_500,
        currency: "CNY",
        occurredAt: "2026-07-20T11:00:00.000Z",
        categoryId: category.id,
        categoryName: "",
        accountId: account.id,
        accountName: "",
      });

      await importRemoteLedgerSnapshot(database, {
        ledger: {
          id: ledger.id, name: ledger.name, kind: "private", base_currency: "CNY",
          monthly_budget_minor: 300_000, version: 1, updated_at: "2026-07-20T11:00:00.000Z",
        },
        accounts: [], categories: [], subcategories: [], transactions: [], attachments: [], revision: 1,
        subscriptions: [{
          id: subscriptionId, ledger_id: ledger.id, name: "云存储", beneficiary: "我",
          account_id: account.id, category_id: category.id, amount_minor: 2_500, currency: "CNY",
          base_amount_minor: 2_500, exchange_rate_micros: 1_000_000, exchange_rate_source: "fixed",
          exchange_rate_at: "2026-07-20T11:00:00.000Z", frequency: "month", interval: 1,
          next_charge_on: "2026-08-20", remind_days_before: 3, status: "cancelled",
          last_generated_period_key: null, version: 2, created_at: "2026-07-20T11:00:00.000Z",
          updated_at: "2026-07-20T11:00:00.000Z",
        }],
      }, "owner");

      expect(await listTransactions(database, ledger.id)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("keeps the subscription anchor day across clamped months and resets it when the date is edited", async () => {
    const database = await openBookkeepingDatabase();
    try {
      await ensureDefaultData(database);
      const ledger = (await listLedgers(database))[0];
      const category = (await listCategories(database, ledger.id))[0];
      const account = (await listAccounts(database, ledger.id))[0];
      const base = {
        ledgerId: ledger.id, name: "云存储", beneficiary: "我", accountId: account.id, categoryId: category.id,
        amountMinor: 2_500, currency: "CNY" as const, baseAmountMinor: 2_500, exchangeRateMicros: 1_000_000,
        exchangeRateSource: "fixed" as const, exchangeRateAt: "2026-01-01T00:00:00.000Z",
        frequency: "month" as const, interval: 1, remindDaysBefore: 3, status: "active" as const,
        lastGeneratedPeriodKey: null,
      };

      const created = await saveSubscription(database, { ...base, nextChargeOn: "2026-01-31" });
      expect(created.anchorDay).toBe(31);

      // 确认扣费后下次日期被截到 2/28，显式传入锚点则保持 31。
      const advanced = await saveSubscription(database, { ...created, nextChargeOn: "2026-02-28", anchorDay: created.anchorDay });
      expect(advanced.anchorDay).toBe(31);

      // 只改名称、日期不变：沿用原锚点，而不是退化成 28。
      const renamed = await saveSubscription(database, { ...base, id: created.id, name: "云盘", nextChargeOn: "2026-02-28" });
      expect(renamed.anchorDay).toBe(31);

      // 用户手动改了日期：以新日期的日为锚点。
      const rescheduled = await saveSubscription(database, { ...base, id: created.id, nextChargeOn: "2026-03-15" });
      expect(rescheduled.anchorDay).toBe(15);

      const operations = await listPendingOperations(database, ledger.id);
      expect(operations.map((operation) => operation.payload.anchorDay)).toEqual([31, 31, 31, 15]);
    } finally {
      database.close();
    }
  });

  it("maps the subscription anchor day from remote changes and login snapshots", async () => {
    const database = await openBookkeepingDatabase();
    try {
      await ensureDefaultData(database);
      const ledger = (await listLedgers(database))[0];
      const category = (await listCategories(database, ledger.id))[0];
      const account = (await listAccounts(database, ledger.id))[0];
      const remote = {
        name: "视频会员", beneficiary: "", accountId: account.id, categoryId: category.id, amountMinor: 3_000,
        currency: "CNY", baseAmountMinor: 3_000, exchangeRateMicros: 1_000_000, exchangeRateSource: "fixed",
        exchangeRateAt: "2026-01-01T00:00:00.000Z", frequency: "month", interval: 1,
        nextChargeOn: "2026-02-28", remindDaysBefore: 3, status: "active", lastGeneratedPeriodKey: null,
      };

      await applyRemoteChanges(database, ledger.id, [{
        revision: 1, entityType: "subscription", entityId: "subscription-remote-anchor", operationType: "create",
        entityVersion: 1, payload: { ...remote, anchorDay: 30 }, operationId: "remote-subscription-anchor",
        changedByUserId: "family-member", createdAt: "2026-07-20T10:00:00.000Z",
      }]);
      expect((await listSubscriptions(database, ledger.id))[0].anchorDay).toBe(30);

      await importRemoteLedgerSnapshot(database, {
        ledger: {
          id: ledger.id, name: ledger.name, kind: "private", base_currency: "CNY",
          monthly_budget_minor: 300_000, version: 1, updated_at: "2026-07-20T11:00:00.000Z",
        },
        accounts: [], categories: [], subcategories: [], transactions: [], attachments: [], revision: 2,
        subscriptions: [
          {
            id: "subscription-remote-anchor", ledger_id: ledger.id, name: "视频会员", beneficiary: "",
            account_id: account.id, category_id: category.id, amount_minor: 3_000, currency: "CNY",
            base_amount_minor: 3_000, exchange_rate_micros: 1_000_000, exchange_rate_source: "fixed",
            exchange_rate_at: "2026-01-01T00:00:00.000Z", frequency: "month", interval: 1,
            next_charge_on: "2026-02-28", anchor_day: 31, remind_days_before: 3, status: "active",
            last_generated_period_key: null, version: 2, created_at: "2026-07-20T11:00:00.000Z",
            updated_at: "2026-07-20T11:00:00.000Z",
          },
        ],
      }, "owner");
      expect((await listSubscriptions(database, ledger.id))[0].anchorDay).toBe(31);
    } finally {
      database.close();
    }
  });

  it("queues offline transaction updates and deletes in order", async () => {
    const database = await openBookkeepingDatabase();
    try {
      await ensureDefaultData(database);
      const ledger = (await listLedgers(database))[0];
      const category = (await listCategories(database, ledger.id))[0];
      const account = (await listAccounts(database, ledger.id))[0];
      const created = await createTransaction(database, {
        operationId: "operation-create-edit-delete",
        ledgerId: ledger.id,
        type: "expense",
        amountMinor: 1600,
        currency: "CNY",
        occurredAt: "2026-07-16T06:06:00.000Z",
        categoryId: category.id,
        categoryName: category.name,
        accountId: account.id,
        accountName: account.name,
        note: "原备注",
      });
      const updated = await updateTransaction(database, created.id, {
        operationId: "operation-update-edit-delete",
        ledgerId: ledger.id,
        type: "expense",
        amountMinor: 1680,
        currency: "CNY",
        occurredAt: created.occurredAt,
        categoryId: category.id,
        categoryName: category.name,
        accountId: account.id,
        accountName: account.name,
        note: "修改后备注",
      });
      expect(updated).toMatchObject({ amountMinor: 1680, note: "修改后备注", version: 2 });

      await deleteTransaction(database, created.id, "operation-delete-edit-delete");
      expect(await listTransactions(database, ledger.id)).toHaveLength(0);
      const operations = await listPendingOperations(database, ledger.id);
      expect(operations.map((operation) => [operation.operationType, operation.baseVersion])).toEqual([
        ["create", 0],
        ["update", 1],
        ["delete", 2],
      ]);
    } finally {
      database.close();
    }
  });
});
