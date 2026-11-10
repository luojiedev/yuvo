import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NetworkSession } from "../lib/domain";
import { transferGuestLedgers } from "../lib/guest-transfer";
import { requestResult, transactionComplete } from "../lib/idb";
import { countUnsyncedOperations, createLedger, createTransaction, ensureDefaultData, listAccounts, listCategories, listLedgers, listPendingOperations, listTransactions, openBookkeepingDatabase, saveAccount, updateLedgerMonthlyBudget } from "../lib/local-database";
import { synchronizeAccount, synchronizeLedger } from "../lib/sync-engine";

const databases: IDBDatabase[] = [];
async function open(scope: string) { const database = await openBookkeepingDatabase(scope); databases.push(database); return database; }
function session(): NetworkSession {
  return { key: "current", userId: crypto.randomUUID(), token: "test-token", deviceId: "test-device", username: "test", displayName: "测试", expiresAt: new Date(Date.now() + 60000).toISOString() };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  await requestResult(indexedDB.deleteDatabase("swift-ledger:guest-v1"));
});

describe("local ledger ownership and full synchronization", () => {
  it("does not create another cloud ledger for an unused guest placeholder", async () => {
    const user = session();
    const source = await open("guest-v1");
    const target = await open(`user-${user.userId}`);
    await ensureDefaultData(source);
    expect(await transferGuestLedgers(source, target, user)).toBe(0);
    const ledger = (await listLedgers(source))[0];
    await updateLedgerMonthlyBudget(source, ledger.id, 123000);
    expect(await transferGuestLedgers(source, target, user)).toBe(1);
  });
  it("claims the empty initial ledger when account creation has already registered its ID", async () => {
    const user = session();
    const source = await open("guest-v1");
    const target = await open(`user-${user.userId}`);
    await ensureDefaultData(source);
    const ledger = (await listLedgers(source))[0];
    expect(await transferGuestLedgers(source, target, user, ledger.id)).toBe(1);
    expect(await listLedgers(source)).toHaveLength(0);
  });
  it("transfers all guest ledgers with images and outbox, freezes the source and resumes without overwriting edits", async () => {
    const user = session();
    const source = await open("guest-v1");
    const target = await open(`user-${user.userId}`);
    const first = await createLedger(source, "日常");
    await createLedger(source, "旅行");
    const account = (await listAccounts(source, first.id))[0];
    const category = (await listCategories(source, first.id))[0];
    const row = await createTransaction(source, { ledgerId: first.id, operationId: crypto.randomUUID(), type: "expense", amountMinor: 1234, currency: "CNY", occurredAt: new Date().toISOString(), accountId: account.id, accountName: account.name, categoryId: category.id, categoryName: category.name });
    const write = source.transaction("transactions", "readwrite");
    const completed = transactionComplete(write);
    write.objectStore("transactions").put({ ...row, images: [{ id: "image-local", blob: new Blob(["image-data"], { type: "image/jpeg" }), status: "pending" }] });
    await completed;
    await updateLedgerMonthlyBudget(source, first.id, 555000);
    const operations = await listPendingOperations(source, first.id);
    expect(await transferGuestLedgers(source, target, user)).toBe(2);
    expect(await listLedgers(source)).toHaveLength(0);
    expect(await countUnsyncedOperations(source)).toBe(0);
    expect(await listLedgers(target)).toHaveLength(2);
    expect(await listPendingOperations(target, first.id)).toEqual(operations);
    const copied = (await listTransactions(target, first.id))[0];
    expect(copied.id).toBe(row.id);
    expect(await copied.images[0].blob!.text()).toBe("image-data");
    await expect(saveAccount(source, { ledgerId: first.id, name: "不能继续保存", type: "bank" })).rejects.toThrow("已移交账号");
    await expect(updateLedgerMonthlyBudget(source, first.id, 777000)).rejects.toThrow("已移交账号");
    await updateLedgerMonthlyBudget(target, first.id, 888000);
    expect(await transferGuestLedgers(source, target, user)).toBe(0);
    expect((await listLedgers(target)).find((ledger) => ledger.id === first.id)?.monthlyBudgetMinor).toBe(888000);
    const other = session();
    expect(await transferGuestLedgers(source, await open(`user-${other.userId}`), other)).toBe(0);
    await ensureDefaultData(source);
    expect(await listLedgers(source)).toHaveLength(1);
  });

  it("retains a claimed source after a failed target copy and lets only that account resume", async () => {
    const user = session();
    const source = await open("guest-v1");
    const target = await open(`user-${user.userId}`);
    const ledger = await createLedger(source, "本机");
    await createLedger(target, "已存在的冲突", { id: ledger.id });
    await expect(transferGuestLedgers(source, target, user)).rejects.toThrow("同标识");
    expect(await listLedgers(source)).toHaveLength(0);
    const write = target.transaction("ledgers", "readwrite");
    const completed = transactionComplete(write);
    write.objectStore("ledgers").delete(ledger.id);
    await completed;
    // Remove the test collision's seeded rows; a real conflict requires explicit recovery.
    for (const name of ["accounts", "categories", "subcategories"]) {
      const transaction = target.transaction(name, "readwrite");
      const done = transactionComplete(transaction);
      transaction.objectStore(name).clear();
      await done;
    }
    expect(await transferGuestLedgers(source, target, user)).toBe(1);
  });

  it("registers every private ledger before uploading, retries registration and continues past another ledger failure", async () => {
    const user = session();
    const database = await open(`user-${user.userId}`);
    const first = await createLedger(database, "第一本");
    const second = await createLedger(database, "第二本");
    const registered: string[] = [];
    let rejectFirst = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/ledgers")) return Response.json({ ledgers: [] });
      if (path.endsWith("/ledgers/private")) {
        const body = JSON.parse(String(init?.body));
        registered.push(body.ledgerId);
        if (body.ledgerId === first.id && rejectFirst) throw new Error("connection lost after registration");
        return Response.json({ ledger: { id: body.ledgerId } });
      }
      if (path.includes("transaction-creators")) return Response.json({ creators: [] });
      if (path.includes("/sync/pull")) return Response.json({ changes: [], nextRevision: 0, hasMore: false });
      throw new Error(`Unexpected request: ${path}`);
    });
    expect((await synchronizeAccount(database, user)).failed).toBe(1);
    expect(registered).toEqual([first.id, second.id]);
    expect(await countUnsyncedOperations(database)).toBe(1);
    rejectFirst = false;
    expect((await synchronizeAccount(database, user)).failed).toBe(0);
    expect(registered).toEqual([first.id, second.id, first.id]);
    expect(await countUnsyncedOperations(database)).toBe(0);
    const guest = await open("guest-v1");
    const guestLedger = await createLedger(guest, "访客不能直接上传");
    await expect(synchronizeLedger(guest, user, guestLedger.id)).rejects.toThrow("当前账号空间");
  });
});
