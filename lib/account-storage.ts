import type { Ledger, NetworkSession } from "./domain";
import { requestResult, transactionComplete } from "./idb";
import { clearNetworkSession, ensureDefaultData, getNetworkSession, openBookkeepingDatabase, saveNetworkSession } from "./local-database";

export const activeStorageKey = "swift-ledger.active-storage-v1";
const guestScope = "guest-v1";
export function activeStorageScope(): string {
  return localStorage.getItem(activeStorageKey) ?? guestScope;
}

export async function openActiveAccountDatabase(): Promise<IDBDatabase> {
  const scope = activeStorageScope();
  const database = await openBookkeepingDatabase(scope);
  if (scope !== guestScope) {
    const session = await getNetworkSession(database);
    if (!session || scope !== `user-${session.userId}` || Date.parse(session.expiresAt) <= Date.now()) {
      await clearNetworkSession(database);
      database.close();
      localStorage.setItem(activeStorageKey, guestScope);
      return openBookkeepingDatabase(guestScope);
    }
  }
  return database;
}

export function openAccountDatabase(userId: string): Promise<IDBDatabase> {
  if (!userId || !/^[a-zA-Z0-9_-]+$/u.test(userId)) throw new Error("账号标识不正确");
  return openBookkeepingDatabase(`user-${userId}`);
}

export async function activateAccountDatabase(database: IDBDatabase, session: NetworkSession): Promise<void> {
  if (database.name !== `swift-ledger:user-${session.userId}`) throw new Error("本地空间与登录账号不匹配");
  await saveNetworkSession(database, session);
  localStorage.setItem(activeStorageKey, `user-${session.userId}`);
  console.debug("[account-storage] account space activated", { userId: session.userId });
}

export async function lockAccountDatabase(database: IDBDatabase): Promise<void> {
  // Change the active pointer first so another tab cannot reopen this account while logout completes.
  localStorage.setItem(activeStorageKey, guestScope);
  await clearNetworkSession(database);
  console.debug("[account-storage] account space locked");
}

/** Copy only explicitly selected ledgers; never mix another account's cache into the target. */
export async function copyLedgerStorage(source: IDBDatabase, target: IDBDatabase, ledgerIds: string[]): Promise<void> {
  const names = ["ledgers", "accounts", "categories", "subcategories", "transactions", "subscriptions", "localOperations", "syncCursors", "recoveryArchives", "importReceipts"];
  const selected = new Set(ledgerIds);
  const read = source.transaction(names, "readonly");
  const readCompleted = transactionComplete(read);
  const contents = await Promise.all(names.map(async (name) => ({ name, rows: await requestResult(read.objectStore(name).getAll()) as Array<Record<string, unknown>> })));
  await readCompleted;
  const write = target.transaction(names, "readwrite");
  const completed = transactionComplete(write);
  try {
    const existing = await requestResult(write.objectStore("ledgers").getAll()) as Ledger[];
    for (const ledger of existing) selected.delete(ledger.id);
    for (const { name, rows } of contents) {
      for (const row of rows) {
        if (selected.has(String(name === "ledgers" ? row.id : row.ledgerId))) write.objectStore(name).add(row);
      }
    }
    await completed;
    console.debug("[account-storage] ledger data copied", { ledgerCount: selected.size });
  } catch (error) {
    try { write.abort(); } catch { /* A failed write has already aborted. */ }
    await completed.catch(() => undefined);
    console.error("[account-storage] ledger copy failed", { error });
    throw error;
  }
}

export async function removeTransferredGuestLedger(database: IDBDatabase, ledgerId: string): Promise<void> {
  if (database.name !== `swift-ledger:${guestScope}`) throw new Error("只能移交访客账本");
  const names = ["ledgers", "accounts", "categories", "subcategories", "transactions", "subscriptions", "localOperations", "syncCursors", "recoveryArchives", "importReceipts"];
  const transaction = database.transaction(names, "readwrite");
  const completed = transactionComplete(transaction);
  for (const name of names) {
    const store = transaction.objectStore(name);
    const rows = await requestResult(store.getAll()) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if ((name === "ledgers" ? row.id : row.ledgerId) === ledgerId) store.delete(row[String(store.keyPath)] as IDBValidKey);
    }
  }
  await completed;
  await ensureDefaultData(database);
  console.debug("[account-storage] guest ledger transferred", { ledgerId });
}
