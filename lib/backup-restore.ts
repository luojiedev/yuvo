import type { Account, BookkeepingTransaction, Category, Ledger, LocalOperation, Subcategory, Subscription } from "./domain";
import { createId } from "./domain";
import type { LedgerBackup } from "./data-portability";
import { createLedgerBackup, restoreAttachment, validateLedgerBackup } from "./data-portability";
import { requestResult, transactionComplete } from "./idb";
import { assertLedgerWritable } from "./ledger-write-access";

const stores = ["ledgers", "accounts", "categories", "subcategories", "subscriptions", "transactions", "localOperations", "importReceipts"];
const isManagerEntry = (id: string) => id === "category-custom" || id.endsWith(":category-custom") || id.startsWith("category-manager:");

export async function exportLedgerBackup(database: IDBDatabase, ledgerId: string): Promise<LedgerBackup> {
  const transaction = database.transaction(stores.slice(0, 6), "readonly");
  const completed = transactionComplete(transaction);
  const [ledger, accounts, categories, subcategories, subscriptions, transactions] = await Promise.all([
    requestResult(transaction.objectStore("ledgers").get(ledgerId)) as Promise<Ledger | undefined>,
    requestResult(transaction.objectStore("accounts").index("ledgerId").getAll(ledgerId)) as Promise<Account[]>,
    requestResult(transaction.objectStore("categories").index("ledgerId").getAll(ledgerId)) as Promise<Category[]>,
    requestResult(transaction.objectStore("subcategories").index("ledgerId").getAll(ledgerId)) as Promise<Subcategory[]>,
    requestResult(transaction.objectStore("subscriptions").index("ledgerId").getAll(ledgerId)) as Promise<Subscription[]>,
    requestResult(transaction.objectStore("transactions").index("ledgerId").getAll(ledgerId)) as Promise<BookkeepingTransaction[]>,
  ]);
  await completed;
  if (!ledger) throw new Error("账本不存在");
  return createLedgerBackup({ backupId: createId(), ledger, accounts, categories: categories.filter((row) => !isManagerEntry(row.id)), subcategories, subscriptions, transactions });
}

async function restoredId(target: string, source: string, type: string, id: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([target, source, type, id])));
  return `restore-${Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
}

/** Restores configuration, references, images and outbox as one all-or-nothing write. */
export async function restoreLedgerBackup(database: IDBDatabase, ledgerId: string, backup: LedgerBackup): Promise<{ imported: number; skipped: number }> {
  validateLedgerBackup(backup);
  const definitions = [
    ["account", backup.accounts], ["category", backup.categories], ["subcategory", backup.subcategories],
    ["subscription", backup.subscriptions ?? []], ["transaction", backup.transactions],
  ] as const;
  const ids = new Map<string, string>();
  await Promise.all(definitions.flatMap(([type, rows]) => rows.map(async (row) => {
    ids.set(`${type}:${row.id}`, ledgerId === backup.ledger.id ? row.id : await restoredId(ledgerId, backup.ledger.id, type, row.id));
  })));
  const preparedImages = new Map(await Promise.all(backup.transactions.map(async (row) => [row.id, await Promise.all(row.images.map(async (image) => ({
    ...await restoreAttachment(image), id: ledgerId === backup.ledger.id ? image.id : await restoredId(ledgerId, backup.ledger.id, "attachment", image.id),
    transactionId: ids.get(`transaction:${row.id}`),
  })))] as const)));
  const transaction = database.transaction(stores, "readwrite");
  const completed = transactionComplete(transaction);
  let imported = 0;
  let skipped = 0;
  try {
    await assertLedgerWritable(transaction, ledgerId);
    const ledgerStore = transaction.objectStore("ledgers");
    const ledger = await requestResult(ledgerStore.get(ledgerId)) as Ledger | undefined;
    if (!ledger) throw new Error("目标账本不存在");
    if (ledger.role && ledger.role !== "owner" && ledger.role !== "admin") throw new Error("只有所有者或管理员可以恢复完整账本");
    const receipts = transaction.objectStore("importReceipts");
    const now = new Date().toISOString();
    let order = performance.timeOrigin + performance.now();
    const queue = (type: LocalOperation["entityType"], id: string, operationType: LocalOperation["operationType"], version: number, payload: Record<string, unknown>) => {
      const operationId = createId();
      transaction.objectStore("localOperations").add({ operationId, ledgerId, entityId: id, entityType: type,
        operationType, baseVersion: version, payload, status: "pending", attemptCount: 0, nextRetryAt: null, lastError: null,
        createdOrder: order += 0.01, createdAt: now, updatedAt: now } satisfies LocalOperation);
      return operationId;
    };
    const receiptId = (type: string, id: string) => JSON.stringify([ledgerId, backup.ledger.id, type, id]);
    const pending = await requestResult(transaction.objectStore("localOperations").index("ledgerId").getAll(ledgerId)) as LocalOperation[];
    const inactive: Array<{ store: string; type: "account" | "category" | "subcategory"; row: Account | Category | Subcategory }> = [];
    for (const [type, sourceRows] of definitions.slice(0, 3)) {
      const catalogType = type as "account" | "category" | "subcategory";
      const storeName = { account: "accounts", category: "categories", subcategory: "subcategories" }[catalogType];
      const store = transaction.objectStore(storeName);
      const existingRows = await requestResult(store.index("ledgerId").getAll(ledgerId)) as Array<Account | Category | Subcategory>;
      for (const source of sourceRows as Array<Account | Category | Subcategory>) {
        if (type === "category" && isManagerEntry(source.id)) continue;
        const receipt = await requestResult(receipts.get(receiptId(type, source.id))) as { targetId: string } | undefined;
        if (receipt) { ids.set(`${type}:${source.id}`, receipt.targetId); skipped += 1; continue; }
        const parentId = "categoryId" in source ? ids.get(`category:${source.categoryId}`) : undefined;
        const existing = existingRows.find((row) => row.id === ids.get(`${type}:${source.id}`)) ?? existingRows.find((row) => row.name === source.name
          && (type !== "category" || (row as Category).type === (source as Category).type)
          && (type !== "subcategory" || (row as Subcategory).categoryId === parentId));
        if (existing && pending.some((op) => op.entityId === existing.id && op.status !== "synced")) throw new Error(`“${source.name}”有未同步修改，请先处理再恢复`);
        const id = existing?.id ?? ids.get(`${type}:${source.id}`)!;
        ids.set(`${type}:${source.id}`, id);
        const row = { ...source, id, ledgerId, ...(parentId ? { categoryId: parentId } : {}), status: "active" as const, version: (existing?.version ?? 0) + 1 };
        store.put(row);
        queue(catalogType, id, existing ? "update" : "create", existing?.version ?? 0, { ...row });
        if (source.status === "inactive") inactive.push({ store: storeName, type: catalogType, row });
        receipts.put({ id: receiptId(type, source.id), ledgerId, targetId: id });
        imported += 1;
      }
    }
    for (const source of backup.subscriptions ?? []) {
      const id = ids.get(`subscription:${source.id}`)!;
      const store = transaction.objectStore("subscriptions");
      if (await requestResult(store.get(id))) { skipped += 1; continue; }
      const row: Subscription = { ...source, id, ledgerId, accountId: ids.get(`account:${source.accountId}`)!, categoryId: ids.get(`category:${source.categoryId}`)!, version: 1 };
      store.add(row);
      queue("subscription", id, "create", 0, { ...row });
      imported += 1;
    }
    for (const source of backup.transactions) {
      const id = ids.get(`transaction:${source.id}`)!;
      const store = transaction.objectStore("transactions");
      if (await requestResult(store.get(id))) { skipped += 1; continue; }
      const images = preparedImages.get(source.id)!;
      const sourcePayload = Object.fromEntries(Object.entries(source).filter(([key]) => key !== "images")) as Omit<typeof source, "images">;
      const payload = { ...sourcePayload, id, ledgerId, accountId: ids.get(`account:${source.accountId}`)!, categoryId: ids.get(`category:${source.categoryId}`)!,
        subcategoryId: source.subcategoryId ? ids.get(`subcategory:${source.subcategoryId}`)! : null,
        subscriptionId: source.subscriptionId ? ids.get(`subscription:${source.subscriptionId}`)! : null,
        version: 1, deletedAt: null };
      const operationId = queue("transaction", id, "create", 0, payload);
      const row = { ...payload, operationId, images };
      if (source.deletedAt) {
        queue("transaction", id, "delete", 1, {});
        store.add({ ...row, version: 2, deletedAt: source.deletedAt });
      } else store.add(row);
      imported += 1;
    }
    // Historical catalog entries must remain active until dependent entries have reached the server.
    for (const item of inactive) {
      transaction.objectStore(item.store).put({ ...item.row, status: "inactive", version: item.row.version! + 1 });
      queue(item.type, item.row.id, "delete", item.row.version!, {});
    }
    const budgetReceipt = receiptId("budget", backup.backupId);
    if (!await requestResult(receipts.get(budgetReceipt))) {
      if (backup.ledger.monthlyBudgetMinor !== undefined && backup.ledger.monthlyBudgetMinor !== ledger.monthlyBudgetMinor) {
        if (pending.some((op) => op.entityType === "ledger" && op.status !== "synced")) throw new Error("预算有未同步修改，请先处理再恢复");
        ledgerStore.put({ ...ledger, monthlyBudgetMinor: backup.ledger.monthlyBudgetMinor, version: ledger.version + 1 });
        queue("ledger", ledgerId, "update", ledger.version, { monthlyBudgetMinor: backup.ledger.monthlyBudgetMinor });
      }
      receipts.put({ id: budgetReceipt, ledgerId, targetId: ledgerId });
    }
    await completed;
    console.debug("[backup] restore completed", { ledgerId, imported, skipped });
    return { imported, skipped };
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may already have aborted. */ }
    await completed.catch(() => undefined);
    console.error("[backup] restore rolled back", { ledgerId, error });
    throw error;
  }
}
