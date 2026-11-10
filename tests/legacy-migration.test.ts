import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkSession } from "../lib/domain";
import type { RemoteLedger } from "../lib/network-api";
import { inspectLegacyData, migrateLegacyData, selectLegacyMigrationSession } from "../lib/legacy-migration";
import { openAccountDatabase } from "../lib/account-storage";
import { createLedger, createTransaction, ensureDefaultData, getNetworkSession, getSyncCursor, listAccounts, listCategories, listLedgers, listPendingOperations, listTransactions, saveNetworkSession, saveSyncCursor, updateOperationStates, updateTransaction } from "../lib/local-database";
import { requestResult, transactionComplete } from "../lib/idb";

const databases: IDBDatabase[] = [];
const session: NetworkSession = { key: "current", userId: "verified-user", username: "owner", displayName: "所有者", deviceId: "verified-device", token: "verified-token", expiresAt: "2099-01-01T00:00:00.000Z" };

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => { databases.splice(0).forEach((database) => database.close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function legacyFixture() {
  const request = indexedDB.open("swift-ledger", 4);
  request.addEventListener("upgradeneeded", () => {
    const definitions = { ledgers: "id", accounts: "id", categories: "id", subcategories: "id", transactions: "id", subscriptions: "id", localOperations: "operationId", syncCursors: "ledgerId", networkSession: "key" };
    for (const [name, keyPath] of Object.entries(definitions)) {
      const store = request.result.createObjectStore(name, { keyPath });
      store.createIndex("ledgerId", "ledgerId");
      if (name === "transactions") store.createIndex("operationId", "operationId", { unique: true });
    }
  });
  const source = await requestResult(request);
  const target = await openAccountDatabase(session.userId);
  databases.push(source, target);
  await ensureDefaultData(source);
  await saveNetworkSession(source, session);
  const ledger = (await listLedgers(source))[0];
  const category = (await listCategories(source, ledger.id))[0];
  const account = (await listAccounts(source, ledger.id))[0];
  const blob = new Blob(["unchanged-image-bytes"], { type: "image/png" });
  const row = await createTransaction(source, {
    ledgerId: ledger.id, operationId: "stable-operation-id", type: "expense", amountMinor: 12345, currency: "CNY",
    occurredAt: "2026-09-01T00:00:00.000Z", categoryId: category.id, categoryName: category.name,
    accountId: account.id, accountName: account.name, createdByUserId: session.userId,
    createdByDisplayName: session.displayName, note: "必须保留的离线记录",
    images: [{ id: "stable-image-id", name: "收据", type: blob.type, size: blob.size, blob, status: "pending" }],
  });
  await saveSyncCursor(source, ledger.id, 42);
  return { source, target, ledger, row };
}

function authorize(ledgerId: string, overrides: Partial<RemoteLedger> = {}) {
  const remote: RemoteLedger = { id: ledgerId, name: "私人账本", kind: "private", role: "owner", base_currency: "CNY", monthly_budget_minor: 300000, version: 1, member_count: 1, ...overrides };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${session.token}`);
    if (String(input).endsWith("/me")) return Response.json({ user: { id: session.userId }, deviceId: session.deviceId });
    if (String(input).endsWith("/ledgers")) return Response.json({ ledgers: [remote] });
    throw new Error("迁移不应上传内容或读取未授权的账本");
  });
}

async function receipts(database: IDBDatabase) {
  const transaction = database.transaction("legacyMigrations", "readonly");
  const completed = transactionComplete(transaction);
  const rows = await requestResult(transaction.objectStore("legacyMigrations").getAll());
  await completed;
  return rows;
}

describe("legacy migration", () => {
  it("uses a saved legacy session only before an explicit account choice or logout", () => {
    expect(selectLegacyMigrationSession(null, session, null)).toBe(session);
    expect(selectLegacyMigrationSession(null, session, "guest-v1")).toBeNull();
    expect(selectLegacyMigrationSession(null, session, "user-other")).toBeNull();
    const current = { ...session, userId: "current-user" };
    expect(selectLegacyMigrationSession(current, session, "user-current-user")).toBe(current);
    expect(selectLegacyMigrationSession(null, { ...session, expiresAt: "invalid" }, null)).toBeNull();
    expect(selectLegacyMigrationSession(null, { ...session, expiresAt: "2000-01-01T00:00:00Z" }, null)).toBeNull();
  });
  it("does not create an empty legacy database while checking a fresh installation", async () => {
    expect(await inspectLegacyData()).toEqual({ hasLegacyData: false, session: null });
    expect(await indexedDB.databases()).toEqual([]);
  });

  it("preserves operation IDs, attachment bytes, versions and cursors without upgrading or deleting the original", async () => {
    const { source, target, ledger, row } = await legacyFixture();
    authorize(ledger.id);
    const before = await listTransactions(source, ledger.id);
    expect(await migrateLegacyData(target, session)).toMatchObject({ migratedLedgers: 1, completedLedgers: 1, lockedLedgers: 0 });
    expect(await listTransactions(target, ledger.id)).toEqual(before);
    expect((await listPendingOperations(target, ledger.id))[0].operationId).toBe(row.operationId);
    expect(await getSyncCursor(target, ledger.id)).toBe(42);
    expect(await (await listTransactions(target, ledger.id))[0].images[0].blob!.text()).toBe("unchanged-image-bytes");
    expect(await getNetworkSession(target)).toBeNull();
    expect(source.version).toBe(4);
    expect(await listTransactions(source, ledger.id)).toEqual(before);
    expect(await getNetworkSession(source)).toEqual(session);
    expect(await receipts(target)).toHaveLength(1);
  });

  it("retries completed migrations without duplicating data or overwriting new target edits", async () => {
    const { target, ledger, row } = await legacyFixture();
    authorize(ledger.id);
    await migrateLegacyData(target, session);
    await updateTransaction(target, row.id, { ...row, operationId: "new-target-operation", note: "迁移后的修改" });
    expect(await migrateLegacyData(target, session)).toMatchObject({ migratedLedgers: 0, completedLedgers: 1 });
    expect((await listTransactions(target, ledger.id))[0].note).toBe("迁移后的修改");
    expect(await listPendingOperations(target, ledger.id)).toHaveLength(2);
    expect(await receipts(target)).toHaveLength(1);
  });

  it("serializes two concurrent attempts into one committed copy", async () => {
    const { target, ledger } = await legacyFixture();
    authorize(ledger.id);
    const reports = await Promise.all([migrateLegacyData(target, session), migrateLegacyData(target, session)]);
    expect(reports.reduce((count, report) => count + report.migratedLedgers, 0)).toBe(1);
    expect(await listTransactions(target, ledger.id)).toHaveLength(1);
    expect(await receipts(target)).toHaveLength(1);
  });

  it("does not import another private ledger or an unbound guest ledger", async () => {
    const { source, target, ledger } = await legacyFixture();
    await createLedger(source, "其他账号私人账本");
    await createLedger(source, "从未绑定的账本");
    authorize(ledger.id);
    expect(await migrateLegacyData(target, session)).toMatchObject({ migratedLedgers: 1, lockedLedgers: 2 });
    expect(await listLedgers(target)).toHaveLength(1);
    expect(await listLedgers(source)).toHaveLength(3);
  });

  it("locks edits whose author cannot be established, even when the current user created the entry", async () => {
    const { source, target, ledger, row } = await legacyFixture();
    await updateTransaction(source, row.id, { ...row, operationId: "unknown-editor-operation", note: "修改人不明" });
    authorize(ledger.id, { kind: "family", role: "admin" });
    expect(await migrateLegacyData(target, session)).toMatchObject({ migratedLedgers: 0, lockedLedgers: 1 });
    expect(await listLedgers(target)).toHaveLength(0);
    expect((await listTransactions(source, ledger.id))[0].note).toBe("修改人不明");
    expect(await receipts(target)).toHaveLength(0);
  });

  it("locks a pending creation from a different saved account", async () => {
    const { source, target, ledger } = await legacyFixture();
    await saveNetworkSession(source, { ...session, userId: "other-account" });
    authorize(ledger.id, { kind: "family", role: "admin" });
    expect(await migrateLegacyData(target, session)).toMatchObject({ lockedLedgers: 1 });
    expect(await listLedgers(target)).toHaveLength(0);
  });

  it("rejects a cached user ID which the authenticated server identity does not confirm", async () => {
    const { target } = await legacyFixture();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ user: { id: "different-user" }, deviceId: session.deviceId }));
    await expect(migrateLegacyData(target, session)).rejects.toThrow("验证当前账号");
    expect(await listLedgers(target)).toHaveLength(0);
    expect(await receipts(target)).toHaveLength(0);
  });

  it("retains everything if the server rejects an expired or revoked session", async () => {
    const { source, target, ledger } = await legacyFixture();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { message: "登录失效" } }, { status: 401 }));
    await expect(migrateLegacyData(target, session)).rejects.toThrow("登录失效");
    expect(await listTransactions(source, ledger.id)).toHaveLength(1);
    expect(await listLedgers(target)).toHaveLength(0);
  });

  it("leaves legacy data untouched when network verification fails", async () => {
    const { source, target, ledger } = await legacyFixture();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(migrateLegacyData(target, session)).rejects.toThrow("网络不可用");
    expect(await listTransactions(source, ledger.id)).toHaveLength(1);
    expect(await receipts(target)).toHaveLength(0);
  });

  it("does not overwrite an independently populated target ledger", async () => {
    const { target, ledger } = await legacyFixture();
    await createLedger(target, "目标已有数据", { id: ledger.id });
    authorize(ledger.id);
    expect(await migrateLegacyData(target, session)).toMatchObject({ migratedLedgers: 0, lockedLedgers: 1 });
    expect((await listLedgers(target))[0].name).toBe("目标已有数据");
    expect(await receipts(target)).toHaveLength(0);
  });

  it("rolls back entity and receipt writes together after a key collision, then succeeds on retry", async () => {
    const { source, target, ledger, row } = await legacyFixture();
    authorize(ledger.id);
    const seed = target.transaction("transactions", "readwrite");
    seed.objectStore("transactions").add({ ...row, ledgerId: "other-ledger" });
    await transactionComplete(seed);
    await expect(migrateLegacyData(target, session)).rejects.toBeTruthy();
    expect(await listLedgers(target)).toHaveLength(0);
    expect(await listAccounts(target, ledger.id)).toHaveLength(0);
    expect(await receipts(target)).toHaveLength(0);
    expect(await listTransactions(source, ledger.id)).toHaveLength(1);
    const repair = target.transaction("transactions", "readwrite");
    repair.objectStore("transactions").delete(row.id);
    await transactionComplete(repair);
    expect(await migrateLegacyData(target, session)).toMatchObject({ migratedLedgers: 1 });
  });

  it("defers a copy when storage is insufficient without changing the source", async () => {
    const { source, target, ledger } = await legacyFixture();
    authorize(ledger.id);
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: 100, usage: 99 }) } });
    await expect(migrateLegacyData(target, session)).rejects.toThrow("空间不足");
    expect(await receipts(target)).toHaveLength(0);
    expect(await listTransactions(source, ledger.id)).toHaveLength(1);
  });

  it("keeps late legacy changes locked rather than overwriting the migrated copy", async () => {
    const { source, target, ledger, row } = await legacyFixture();
    authorize(ledger.id);
    await migrateLegacyData(target, session);
    await updateTransaction(source, row.id, { ...row, operationId: "late-legacy-change", note: "旧标签页的后续修改" });
    expect(await migrateLegacyData(target, session)).toMatchObject({ lockedLedgers: 1 });
    expect((await listTransactions(target, ledger.id))[0].note).toBe(row.note);
    expect((await listTransactions(source, ledger.id))[0].note).toBe("旧标签页的后续修改");
  });

  it("detects original data changing while verification is in flight", async () => {
    const { source, target, ledger, row } = await legacyFixture();
    const fetch = authorize(ledger.id);
    const respond = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/me")) await updateTransaction(source, row.id, { ...row, operationId: "concurrent-legacy-change", note: "迁移期间的修改" });
      return respond(input, init);
    });
    expect(await migrateLegacyData(target, session)).toMatchObject({ migratedLedgers: 1, completedLedgers: 0, lockedLedgers: 1 });
    expect((await listTransactions(source, ledger.id))[0].note).toBe("迁移期间的修改");
    expect((await listTransactions(target, ledger.id))[0].note).toBe(row.note);
  });

  it("does not require extra free space to recognize an already completed migration", async () => {
    const { target, ledger } = await legacyFixture();
    authorize(ledger.id);
    await migrateLegacyData(target, session);
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: 100, usage: 99 }) } });
    expect(await migrateLegacyData(target, session)).toMatchObject({ migratedLedgers: 0, completedLedgers: 1 });
  });

  it("locks unsent attachment changes on an otherwise synced entry", async () => {
    const { source, target, ledger, row } = await legacyFixture();
    authorize(ledger.id);
    await updateOperationStates(source, [{ operationId: row.operationId, status: "synced" }]);
    expect(await migrateLegacyData(target, session)).toMatchObject({ lockedLedgers: 1 });
    expect(await listTransactions(target, ledger.id)).toHaveLength(0);
  });

  it("locks incomplete references instead of importing a partially usable ledger", async () => {
    const { source, target, ledger, row } = await legacyFixture();
    authorize(ledger.id);
    const transaction = source.transaction("accounts", "readwrite");
    transaction.objectStore("accounts").delete(row.accountId);
    await transactionComplete(transaction);
    expect(await migrateLegacyData(target, session)).toMatchObject({ lockedLedgers: 1 });
    expect(await listLedgers(target)).toHaveLength(0);
    expect(await listTransactions(source, ledger.id)).toHaveLength(1);
  });

  it("reports unclassifiable legacy operations as locked instead of claiming everything was migrated", async () => {
    const { source, target, ledger } = await legacyFixture();
    authorize(ledger.id);
    const transaction = source.transaction("localOperations", "readwrite");
    transaction.objectStore("localOperations").add({ operationId: "unclassified-operation", entityId: "missing-entity", entityType: "transaction", operationType: "create" });
    await transactionComplete(transaction);
    expect(await migrateLegacyData(target, session)).toMatchObject({ migratedLedgers: 1, lockedLedgers: 1 });
    expect(await listPendingOperations(target, ledger.id)).toHaveLength(1);
  });
});
