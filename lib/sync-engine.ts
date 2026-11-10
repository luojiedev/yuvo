import type { LocalOperation, NetworkSession, RemoteSyncChange } from "./domain";
import {
  applyRemoteChanges,
  cacheAttachmentBlob,
  getSyncCursor,
  listMissingAttachmentDownloads,
  listPendingAttachmentUploads,
  listPendingOperations,
  listLedgers,
  importRemoteLedgerSnapshot,
  markLedgerAsNetworkBound,
  saveSyncCursor,
  updateAttachmentUploadState,
  updateLocalTransactionCreators,
  updateOperationStates,
} from "./local-database";
import {
  apiRequest,
  registerRemotePrivateLedger,
  fetchRemoteLedgers,
  fetchRemoteLedgerSnapshot,
  downloadAttachmentBlob,
  NetworkApiError,
  uploadTransactionAttachment,
} from "./network-api";

const creatorMetadataLoaded = new Set<string>();

export interface SyncReport {
  pushed: number;
  pulled: number;
  conflicts: number;
  failed: number;
  uploaded: number;
  revision: number;
}

export async function synchronizeAccount(database: IDBDatabase, session: NetworkSession): Promise<SyncReport> {
  if (database.name !== `swift-ledger:user-${session.userId}`) throw new Error("同步空间与登录账号不匹配");
  const report: SyncReport = { pushed: 0, pulled: 0, conflicts: 0, failed: 0, uploaded: 0, revision: 0 };
  const localIds = new Set((await listLedgers(database)).map((ledger) => ledger.id));
  for (const remote of await fetchRemoteLedgers(session.token)) {
    if (localIds.has(remote.id)) continue;
    try {
      const snapshot = await fetchRemoteLedgerSnapshot(session.token, remote.id);
      await importRemoteLedgerSnapshot(database, snapshot, remote.role);
    } catch (error) {
      report.failed += 1;
      console.error("[sync] remote ledger download failed", { ledgerId: remote.id, error });
    }
  }
  for (const ledger of await listLedgers(database)) {
    try {
      const result = await synchronizeLedger(database, session, ledger.id);
      report.pushed += result.pushed;
      report.pulled += result.pulled;
      report.conflicts += result.conflicts;
      report.failed += result.failed;
      report.uploaded += result.uploaded;
      report.revision = Math.max(report.revision, result.revision);
    } catch (error) {
      report.failed += 1;
      console.error("[sync] ledger failed during account synchronization", { ledgerId: ledger.id, error });
      if (error instanceof NetworkApiError && error.status === 401) throw error;
    }
  }
  return report;
}

export async function synchronizeLedger(
  database: IDBDatabase,
  session: NetworkSession,
  ledgerId: string,
): Promise<SyncReport> {
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    throw new NetworkApiError(401, "SESSION_EXPIRED", "登录已过期，请重新登录");
  }
  const ledger = (await listLedgers(database)).find((row) => row.id === ledgerId);
  if (!ledger) throw new Error("要同步的账本不存在或已锁定");
  if (!ledger.networkBound && ledger.kind !== "family") {
    if (database.name !== `swift-ledger:user-${session.userId}`) throw new Error("只能同步当前账号空间内的私人账本");
    try {
      await registerRemotePrivateLedger(session.token, ledger);
      await markLedgerAsNetworkBound(database, ledgerId);
      console.debug("[sync] private ledger registered", { ledgerId, userId: session.userId });
    } catch (error) {
      console.error("[sync] private ledger registration failed", { ledgerId, error });
      throw error;
    }
  }
  let pushed = 0;
  let failed = 0;
  let conflicts = 0;
  let uploaded = 0;
  while (true) {
    const pending = await listPendingOperations(database, ledgerId, 50);
    if (pending.length === 0) break;
    await updateOperationStates(database, pending.map((operation) => ({ operationId: operation.operationId, status: "syncing" })));
    try {
      const response = await apiRequest("/sync/push", {
        method: "POST",
        body: JSON.stringify({
          ledgerId,
          deviceId: session.deviceId,
          operations: pending.map((operation) => ({
            operationId: operation.operationId,
            entityType: operation.entityType,
            entityId: operation.entityId,
            operationType: operation.operationType,
            baseVersion: operation.baseVersion,
            payload: operation.payload,
          })),
        }),
      }, session.token);
      const results = Array.isArray(response.results) ? response.results as Array<Record<string, unknown>> : [];
      if (results.length !== pending.length || pending.some((operation) => results.filter((result) => result.operationId === operation.operationId).length !== 1)) {
        throw new Error("同步结果不完整，请重试");
      }
      await updateOperationStates(database, results.map((result) => {
        const status: LocalOperation["status"] = result.status === "applied"
          ? "synced"
          : result.status === "conflict"
            ? "conflict"
            : result.retryable === true
              ? "pending"
              : "failed";
        if (status === "synced") pushed += 1;
        else if (status === "conflict") conflicts += 1;
        else failed += 1;
        const error = result.error && typeof result.error === "object" ? result.error as Record<string, unknown> : {};
        return {
          operationId: typeof result.operationId === "string" ? result.operationId : "",
          status,
          error: typeof error.message === "string" ? error.message : null,
        };
      }).filter((update) => update.operationId));
      if (results.some((result) => result.status !== "applied")) break;
    } catch (error) {
      await updateOperationStates(database, pending.map((operation) => ({
        operationId: operation.operationId,
        status: "pending",
        error: error instanceof Error ? error.message : "同步失败",
      })));
      throw error;
    }
  }

  const pendingAttachments = await listPendingAttachmentUploads(database, ledgerId);
  for (const { transactionId, attachment } of pendingAttachments) {
    await updateAttachmentUploadState(database, transactionId, attachment.id, "uploading");
    try {
      await uploadTransactionAttachment(session.token, ledgerId, transactionId, attachment);
      await updateAttachmentUploadState(database, transactionId, attachment.id, "uploaded");
      uploaded += 1;
    } catch (error) {
      await updateAttachmentUploadState(
        database,
        transactionId,
        attachment.id,
        "failed",
        error instanceof Error ? error.message : "图片上传失败",
      );
      failed += 1;
      console.error("[sync] attachment upload failed", { ledgerId, transactionId, attachmentId: attachment.id, error });
    }
  }

  let cursor = await getSyncCursor(database, ledgerId);
  const creatorMetadataKey = `${session.userId}:${ledgerId}`;
  if (!creatorMetadataLoaded.has(creatorMetadataKey)) {
    const response = await apiRequest(`/ledgers/${encodeURIComponent(ledgerId)}/transaction-creators`, {}, session.token);
    const creators = Array.isArray(response.creators)
      ? response.creators.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const row = value as Record<string, unknown>;
          return typeof row.transactionId === "string" && typeof row.userId === "string" && typeof row.displayName === "string"
            ? [{ transactionId: row.transactionId, userId: row.userId, displayName: row.displayName }]
            : [];
        })
      : [];
    await updateLocalTransactionCreators(database, creators);
    creatorMetadataLoaded.add(creatorMetadataKey);
  }
  let pulled = 0;
  let hasMore = true;
  while (hasMore) {
    const response = await apiRequest(
      `/sync/pull?ledger_id=${encodeURIComponent(ledgerId)}&after_revision=${cursor}&limit=100`,
      {},
      session.token,
    );
    const changes = Array.isArray(response.changes) ? response.changes as RemoteSyncChange[] : [];
    await Promise.all(changes.map(async (change) => {
      if (change.entityType !== "attachment" || change.operationType === "delete") return;
      try {
        change.payload.blob = await downloadAttachmentBlob(session.token, change.entityId);
      } catch (error) {
        console.error("[sync] attachment download failed", { ledgerId, attachmentId: change.entityId, error });
      }
    }));
    const applied = await applyRemoteChanges(database, ledgerId, changes);
    pulled += applied.applied;
    conflicts += applied.conflicts;
    const nextRevision = Number(response.nextRevision);
    if (Number.isSafeInteger(nextRevision) && nextRevision >= cursor) {
      cursor = nextRevision;
      await saveSyncCursor(database, ledgerId, cursor);
    }
    hasMore = response.hasMore === true && changes.length > 0;
  }
  const missingAttachments = await listMissingAttachmentDownloads(database, ledgerId);
  for (const missing of missingAttachments) {
    try {
      const blob = await downloadAttachmentBlob(session.token, missing.attachmentId);
      await cacheAttachmentBlob(database, missing.transactionId, missing.attachmentId, blob);
    } catch (error) {
      console.error("[sync] missing attachment retry failed", { ledgerId, attachmentId: missing.attachmentId, error });
    }
  }
  console.debug("[sync] ledger synchronization completed", { ledgerId, pushed, pulled, conflicts, failed, uploaded, revision: cursor });
  return { pushed, pulled, conflicts, failed, uploaded, revision: cursor };
}
