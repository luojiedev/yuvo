import type { BookkeepingTransaction, Ledger, LocalOperation, NetworkSession } from "./domain";
import { requestResult, transactionComplete } from "./idb";
import { apiRequest, fetchRemoteLedgers } from "./network-api";
import type { RemoteLedger } from "./network-api";

const legacyDatabaseName = "swift-ledger";
const dataStores = ["ledgers", "accounts", "categories", "subcategories", "transactions", "subscriptions", "localOperations", "syncCursors", "recoveryArchives", "importReceipts"] as const;
type StoreName = typeof dataStores[number];
type Row = Record<string, unknown>;
type Contents = Record<StoreName, Row[]>;

export interface LegacyMigrationReport {
  hasLegacyData: boolean;
  migratedLedgers: number;
  completedLedgers: number;
  lockedLedgers: number;
}

export function selectLegacyMigrationSession(current: NetworkSession | null, legacy: NetworkSession | null, activePointer: string | null, now = Date.now()): NetworkSession | null {
  // A stored guest pointer represents an explicit logout; never resurrect its old session.
  const session = current ?? (activePointer === null ? legacy : null);
  const expiresAt = session ? Date.parse(session.expiresAt) : NaN;
  return session && Number.isFinite(expiresAt) && expiresAt > now ? session : null;
}

export function legacyMigrationMessage(report: LegacyMigrationReport): string {
  if (!report.hasLegacyData) return "";
  if (report.lockedLedgers) return `旧数据已保留：${report.completedLedgers} 个账本已迁移，${report.lockedLedgers} 组旧数据待确认并保持锁定。未确认内容不会显示或上传，原始副本未删除。`;
  return `旧数据迁移已完成，共 ${report.completedLedgers} 个账本。原始副本仍保留，重复检查不会重复入账。`;
}

/** Opening without a version leaves an existing legacy schema and all its records untouched. */
async function openLegacyDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(legacyDatabaseName);
    let absent = false;
    request.addEventListener("upgradeneeded", () => {
      absent = true;
      request.transaction?.abort();
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => absent ? resolve(null) : reject(request.error), { once: true });
  });
}

async function readLegacy(database: IDBDatabase): Promise<{ contents: Contents; session: NetworkSession | null }> {
  const names = [...dataStores, "networkSession"].filter((name) => database.objectStoreNames.contains(name));
  if (!names.length) return { contents: Object.fromEntries(dataStores.map((name) => [name, []])) as unknown as Contents, session: null };
  const transaction = database.transaction(names, "readonly");
  const completed = transactionComplete(transaction);
  const contents = Object.fromEntries(await Promise.all(dataStores.map(async (name) => [name,
    names.includes(name) ? await requestResult(transaction.objectStore(name).getAll()) : [],
  ]))) as Contents;
  const session = names.includes("networkSession")
    ? await requestResult(transaction.objectStore("networkSession").get("current")) as NetworkSession | undefined : null;
  await completed;
  return { contents, session: session ?? null };
}

export async function inspectLegacyData(): Promise<{ hasLegacyData: boolean; session: NetworkSession | null }> {
  const database = await openLegacyDatabase();
  if (!database) return { hasLegacyData: false, session: null };
  try {
    const names = [...dataStores, "networkSession"].filter((name) => database.objectStoreNames.contains(name));
    if (!names.length) return { hasLegacyData: false, session: null };
    const transaction = database.transaction(names, "readonly");
    const completed = transactionComplete(transaction);
    const counts = await Promise.all(dataStores.filter((name) => names.includes(name)).map((name) => requestResult(transaction.objectStore(name).count())));
    const session = names.includes("networkSession") ? await requestResult(transaction.objectStore("networkSession").get("current")) as NetworkSession | undefined : null;
    await completed;
    return { hasLegacyData: counts.some((count) => count > 0), session: session ?? null };
  } finally { database.close(); }
}

function ledgerContents(contents: Contents, ledgerId: string): Contents {
  const entityLedgerIds = new Map<string, unknown>();
  for (const name of ["accounts", "categories", "subcategories", "transactions", "subscriptions"] as const) {
    for (const row of contents[name]) entityLedgerIds.set(String(row.id), row.ledgerId);
  }
  return Object.fromEntries(dataStores.map((name) => [name, contents[name].filter((row) => {
    if (name === "ledgers") return row.id === ledgerId;
    if (name === "localOperations") return (row.ledgerId ?? entityLedgerIds.get(String(row.entityId)) ?? (row.entityType === "ledger" ? row.entityId : undefined)) === ledgerId;
    return row.ledgerId === ledgerId;
  })])) as Contents;
}

function hasConfirmedOwnership(contents: Contents, userId: string, legacyUserId: string | undefined, remote: RemoteLedger): boolean {
  const transactions = contents.transactions as unknown as BookkeepingTransaction[];
  const pending = contents.localOperations.filter((row) => row.status !== "synced") as unknown as LocalOperation[];
  // A recorded creator proves a new entry's author, not the author of later edits or deletions.
  for (const operation of pending) {
    const row = transactions.find((item) => item.id === operation.entityId);
    if (legacyUserId !== userId || remote.role === "viewer" || operation.entityType !== "transaction"
      || operation.operationType !== "create" || (operation.baseVersion ?? 0) !== 0
      || !row || row.createdByUserId !== userId || row.operationId !== operation.operationId
      || pending.filter((item) => item.entityId === row.id).length !== 1) return false;
  }
  for (const row of transactions) {
    if (remote.kind === "private" && row.createdByUserId && row.createdByUserId !== userId) return false;
    if (row.images?.some((image) => image.blob && image.status !== "uploaded") && !pending.some((operation) => operation.entityId === row.id)) return false;
  }
  return remote.kind !== "private" || remote.role === "owner";
}

function validateReferences(contents: Contents): void {
  const accounts = new Set(contents.accounts.map((row) => row.id));
  const categories = new Set(contents.categories.map((row) => row.id));
  const subcategories = new Map(contents.subcategories.map((row) => [row.id, row.categoryId]));
  const subscriptions = new Set(contents.subscriptions.map((row) => row.id));
  for (const row of [...contents.transactions, ...contents.subscriptions]) {
    if (!accounts.has(row.accountId) || !categories.has(row.categoryId)
      || (row.subcategoryId && subcategories.get(row.subcategoryId) !== row.categoryId)
      || (row.subscriptionId && !subscriptions.has(row.subscriptionId))) throw new Error("旧账本关联不完整，原数据已保留并锁定");
  }
  for (const row of contents.subcategories) {
    if (!categories.has(row.categoryId)) throw new Error("旧子标签关联不完整，原数据已保留并锁定");
  }
}

async function canonicalValue(value: unknown): Promise<unknown> {
  if (value instanceof Blob) return { blobType: value.type, blobSize: value.size, sha256: await hashBytes(await value.arrayBuffer()) };
  // Hash blobs one at a time instead of materializing every attachment in memory together.
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) result.push(await canonicalValue(item));
    return result;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) result[key] = await canonicalValue(item);
    return result;
  }
  return value;
}

async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function fingerprint(contents: Contents): Promise<string> {
  return hashBytes(new TextEncoder().encode(JSON.stringify(await canonicalValue(contents))).buffer);
}

async function checkAvailableSpace(contents: Contents): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate();
  const attachmentBytes = (contents.transactions as unknown as BookkeepingTransaction[]).reduce((sum, row) => sum + (row.images ?? []).reduce((total, image) => total + (image.blob?.size ?? 0), 0), 0);
  const bytes = new Blob([JSON.stringify(contents)]).size + attachmentBytes;
  if (estimate.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < bytes * 1.2) throw new Error("本机可用空间不足，旧数据未删除；释放空间后可重试迁移");
}

async function copyVerifiedLedger(target: IDBDatabase, contents: Contents, remote: RemoteLedger, sourceFingerprint: string): Promise<"copied" | "completed" | "locked"> {
  const read = target.transaction(["ledgers", "legacyMigrations"], "readonly");
  const readCompleted = transactionComplete(read);
  const [previous, existing] = await Promise.all([
    requestResult(read.objectStore("legacyMigrations").get(remote.id)) as Promise<{ fingerprint: string } | undefined>,
    requestResult(read.objectStore("ledgers").get(remote.id)),
  ]);
  await readCompleted;
  if (previous) return previous.fingerprint === sourceFingerprint ? "completed" : "locked";
  if (existing) return "locked";
  await checkAvailableSpace(contents);
  const transaction = target.transaction([...dataStores, "legacyMigrations"], "readwrite");
  const completed = transactionComplete(transaction);
  try {
    const receipts = transaction.objectStore("legacyMigrations");
    const receipt = await requestResult(receipts.get(remote.id)) as { fingerprint: string } | undefined;
    if (receipt) {
      await completed;
      return receipt.fingerprint === sourceFingerprint ? "completed" : "locked";
    }
    if (await requestResult(transaction.objectStore("ledgers").get(remote.id))) {
      await completed;
      return "locked";
    }
    for (const name of dataStores) {
      const store = transaction.objectStore(name);
      for (const source of contents[name]) {
        const row = name === "ledgers" ? { ...source, role: remote.role, kind: remote.kind, networkBound: true }
          : name === "localOperations" ? { ...source, ledgerId: remote.id } : source;
        store.add(row);
      }
    }
    // Read back every inserted record inside the same transaction before recording success.
    for (const name of dataStores) {
      const store = transaction.objectStore(name);
      for (const row of contents[name]) {
        const key = row[String(store.keyPath)] as IDBValidKey;
        const copied = await requestResult(store.get(key)) as Row | undefined;
        if (!copied || (name !== "ledgers" && copied.ledgerId !== remote.id)) throw new Error("迁移校验失败，原数据已保留");
        if (name === "transactions") {
          const images = copied.images as BookkeepingTransaction["images"];
          const sourceImages = row.images as BookkeepingTransaction["images"];
          if (images.length !== sourceImages.length || images.some((image, index) => image.id !== sourceImages[index].id || image.blob?.size !== sourceImages[index].blob?.size)) throw new Error("附件迁移校验失败");
        }
      }
    }
    receipts.add({ id: remote.id, fingerprint: sourceFingerprint, copiedAt: new Date().toISOString(), rowCounts: Object.fromEntries(dataStores.map((name) => [name, contents[name].length])) });
    await completed;
    console.debug("[legacy-migration] ledger committed", { ledgerId: remote.id });
    return "copied";
  } catch (error) {
    try { transaction.abort(); } catch { /* A storage failure may have already aborted it. */ }
    await completed.catch(() => undefined);
    console.error("[legacy-migration] ledger copy rolled back", { ledgerId: remote.id, error });
    throw error;
  }
}

/** Membership is checked online on every attempt; a cached user ID alone never grants access. */
export async function migrateLegacyData(target: IDBDatabase, session: NetworkSession): Promise<LegacyMigrationReport> {
  const report: LegacyMigrationReport = { hasLegacyData: false, migratedLedgers: 0, completedLedgers: 0, lockedLedgers: 0 };
  if (target.name !== `swift-ledger:user-${session.userId}`) throw new Error("迁移目标与登录账号不匹配");
  const source = await openLegacyDatabase();
  if (!source) return report;
  try {
    const { contents, session: legacySession } = await readLegacy(source);
    report.hasLegacyData = dataStores.some((name) => contents[name].length > 0);
    if (!report.hasLegacyData) return report;
    const identity = await apiRequest("/me", { signal: AbortSignal.timeout(10_000) }, session.token);
    const user = identity.user as { id?: unknown } | undefined;
    if (user?.id !== session.userId || identity.deviceId !== session.deviceId) throw new Error("旧数据迁移需要验证当前账号，请重新登录");
    const remoteLedgers = await fetchRemoteLedgers(session.token, AbortSignal.timeout(10_000));
    const permitted = new Map(remoteLedgers.map((ledger) => [ledger.id, ledger]));
    const completedFingerprints = new Map<string, string>();
    const classifiedRows = new Set<Row>();
    for (const row of contents.ledgers) {
      const ledger = row as unknown as Ledger;
      const remote = permitted.get(ledger.id);
      const selected = ledgerContents(contents, ledger.id);
      for (const name of dataStores) for (const selectedRow of selected[name]) classifiedRows.add(selectedRow);
      if (!remote || !hasConfirmedOwnership(selected, session.userId, legacySession?.userId, remote)) {
        report.lockedLedgers += 1;
        continue;
      }
      try { validateReferences(selected); }
      catch {
        console.error("[legacy-migration] incomplete ledger retained", { ledgerId: ledger.id });
        report.lockedLedgers += 1;
        continue;
      }
      const sourceFingerprint = await fingerprint(selected);
      const result = await copyVerifiedLedger(target, selected, remote, sourceFingerprint);
      if (result === "locked") report.lockedLedgers += 1;
      else {
        report.completedLedgers += 1;
        completedFingerprints.set(ledger.id, sourceFingerprint);
      }
      if (result === "copied") report.migratedLedgers += 1;
    }
    const latest = await readLegacy(source);
    for (const [ledgerId, sourceFingerprint] of completedFingerprints) {
      if (await fingerprint(ledgerContents(latest.contents, ledgerId)) !== sourceFingerprint) {
        report.completedLedgers -= 1;
        report.lockedLedgers += 1;
        console.debug("[legacy-migration] concurrent legacy changes retained", { ledgerId });
      }
    }
    const known = new Set(contents.ledgers.map((row) => row.id));
    report.lockedLedgers += latest.contents.ledgers.filter((row) => !known.has(row.id)).length;
    if (dataStores.some((name) => contents[name].some((row) => !classifiedRows.has(row)))) report.lockedLedgers += 1;
    console.debug("[legacy-migration] inspection completed", report);
    return report;
  } finally { source.close(); }
}
