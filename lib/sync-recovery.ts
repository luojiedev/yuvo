import type { BookkeepingTransaction, LocalOperation, RemoteSyncChange } from "./domain";
import { createId } from "./domain";
import { requestResult, transactionComplete } from "./idb";
import { applyRemoteChanges } from "./local-database";

const entityStores = {
  ledger: "ledgers", transaction: "transactions", category: "categories",
  subcategory: "subcategories", account: "accounts", subscription: "subscriptions",
} as const;

export interface SyncIssue {
  operation: LocalOperation;
  local: Record<string, unknown>;
  fingerprint: string;
}

function fingerprint(operations: LocalOperation[], local: unknown): string {
  return JSON.stringify({ operations: operations.map(({ operationId, status, updatedAt }) => ({ operationId, status, updatedAt })), local });
}

export async function listSyncIssues(database: IDBDatabase, ledgerId: string): Promise<SyncIssue[]> {
  const transaction = database.transaction([...Object.values(entityStores), "localOperations"], "readonly");
  const operations = await requestResult(transaction.objectStore("localOperations").index("ledgerId").getAll(ledgerId)) as LocalOperation[];
  const issues: SyncIssue[] = [];
  const seen = new Set<string>();
  for (const operation of operations) {
    const key = `${operation.entityType}:${operation.entityId}`;
    if (seen.has(key) || (operation.status !== "failed" && operation.status !== "conflict")) continue;
    seen.add(key);
    const local = await requestResult(transaction.objectStore(entityStores[operation.entityType]).get(operation.entityId)) as Record<string, unknown> | undefined;
    const related = operations.filter((item) => item.entityType === operation.entityType && item.entityId === operation.entityId && item.status !== "synced");
    issues.push({ operation, local: local ?? {}, fingerprint: fingerprint(related, local ?? {}) });
  }
  await transactionComplete(transaction);
  return issues;
}

export type RecoveryChoice = "remote" | "resubmit" | "copy";

/** The caller supplies a freshly authenticated cloud version; the local comparison is checked atomically. */
export async function resolveSyncIssue(
  database: IDBDatabase,
  issue: SyncIssue,
  remote: RemoteSyncChange | null,
  choice: RecoveryChoice,
): Promise<void> {
  const operation = issue.operation;
  if (remote && (remote.entityId !== operation.entityId || remote.entityType !== operation.entityType)) throw new Error("云端版本与当前问题不匹配");
  const transaction = database.transaction([...Object.values(entityStores), "localOperations", "recoveryArchives"], "readwrite");
  const completed = transactionComplete(transaction);
  try {
    const store = transaction.objectStore(entityStores[operation.entityType]);
    const local = await requestResult(store.get(operation.entityId)) as Record<string, unknown> | undefined;
    const operationStore = transaction.objectStore("localOperations");
    const operations = await requestResult(operationStore.index("ledgerId").getAll(operation.ledgerId)) as LocalOperation[];
    const related = operations.filter((item) => item.entityType === operation.entityType && item.entityId === operation.entityId && item.status !== "synced");
    if (related.length === 0 || fingerprint(related, local ?? {}) !== issue.fingerprint) throw new Error("本地内容已变化，请刷新比较后再处理");
    if (!local) throw new Error("本地内容不存在，请重新同步");
    if (!remote && choice === "remote" && operation.entityType !== "transaction") throw new Error("云端不存在此项目；请修正后重新提交，避免破坏历史关联");
    if (choice === "copy" && operation.entityType !== "transaction") throw new Error("仅流水支持保留独立副本");
    if (choice === "resubmit" && remote?.operationType === "delete" && operation.entityType === "transaction" && !local.deletedAt) throw new Error("云端流水已删除，请选择保留本地副本");
    const now = new Date().toISOString();
    transaction.objectStore("recoveryArchives").add({ id: createId(), ledgerId: operation.ledgerId, local, operations: related, remote, choice, createdAt: now });
    for (const item of related) operationStore.put({ ...item, status: "synced", lastError: null, updatedAt: now });

    if (choice === "resubmit") {
      const deleted = operation.entityType === "transaction" ? Boolean(local.deletedAt) : local.status === "inactive";
      if (!(deleted && (!remote || remote.operationType === "delete"))) {
        const operationId = createId();
        const baseVersion = remote?.entityVersion ?? 0;
        store.put({ ...local, version: baseVersion + 1 });
        operationStore.add({
          ...operation, operationId, operationType: deleted ? "delete" : remote ? "update" : "create", baseVersion,
          payload: deleted ? {} : local, status: "pending", attemptCount: 0, lastError: null, nextRetryAt: null,
          createdOrder: performance.timeOrigin + performance.now(), createdAt: now, updatedAt: now,
        } satisfies LocalOperation);
      }
    } else {
      if (choice === "copy") {
        const original = local as unknown as BookkeepingTransaction;
        const id = createId();
        const operationId = createId();
        const copy: BookkeepingTransaction = {
          ...original, id, operationId, version: 1, deletedAt: null, createdAt: now,
          subscriptionId: null, subscriptionPeriodKey: null,
          images: original.images.map((image) => ({ ...image, id: createId(), transactionId: id, status: image.blob ? "pending" : "failed" })),
        };
        if (copy.images.some((image) => !image.blob)) throw new Error("请先下载本地副本的全部附件再处理");
        store.add(copy);
        const payload = Object.fromEntries(Object.entries(copy).filter(([key]) => key !== "images"));
        operationStore.add({ ...operation, operationId, entityId: id, operationType: "create", baseVersion: 0, payload,
          status: "pending", attemptCount: 0, lastError: null, nextRetryAt: null,
          createdOrder: performance.timeOrigin + performance.now(), createdAt: now, updatedAt: now } satisfies LocalOperation);
      }
      if (remote) await applyRemoteChanges(database, operation.ledgerId, [remote], transaction);
      else store.delete(operation.entityId);
    }
    await completed;
    console.debug("[sync-recovery] issue resolved", { ledgerId: operation.ledgerId, entityId: operation.entityId, choice });
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may already have aborted. */ }
    await completed.catch(() => undefined);
    console.error("[sync-recovery] resolution failed", { ledgerId: operation.ledgerId, entityId: operation.entityId, choice, error });
    throw error;
  }
}
