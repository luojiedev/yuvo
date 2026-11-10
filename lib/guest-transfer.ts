import type { Ledger, NetworkSession } from "./domain";
import { requestResult, transactionComplete } from "./idb";

const stores = ["ledgers", "accounts", "categories", "subcategories", "transactions", "subscriptions", "localOperations", "syncCursors", "recoveryArchives", "importReceipts"];
export const guestTransferKey = "swift-ledger.guest-transfer-v1";

/** Claim first, then copy atomically. The frozen source survives interruption and only its owner can resume. */
export async function transferGuestLedgers(source: IDBDatabase, target: IDBDatabase, session: NetworkSession, initialPrivateLedgerId?: string): Promise<number> {
  if (!Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new Error("登录已过期，请重新登录后接入本机账本");
  if (source.name !== "swift-ledger:guest-v1" || target.name !== `swift-ledger:user-${session.userId}`) {
    throw new Error("只能将本机体验账本移交到当前登录账号");
  }
  const claim = source.transaction(stores, "readwrite");
  const claimed = transactionComplete(claim);
  const contents = await Promise.all(stores.map(async (name) => ({ name, rows: await requestResult(claim.objectStore(name).getAll()) as Array<Record<string, unknown>> })));
  const modifiedIds = new Set(contents.filter(({ name }) => name === "localOperations" || name === "transactions")
    .flatMap(({ rows }) => rows.map((row) => String(row.ledgerId))));
  const ledgers = (contents[0].rows as unknown as Ledger[]).filter((ledger) =>
    !ledger.networkBound && ledger.kind !== "family" && ledger.archivedAt === null
    && (!ledger.isPlaceholder || modifiedIds.has(ledger.id) || ledger.id === initialPrivateLedgerId)
    && (!ledger.transferredToUserId || ledger.transferredToUserId === session.userId));
  for (const ledger of ledgers) claim.objectStore("ledgers").put({ ...ledger, transferredToUserId: session.userId });
  await claimed;
  if (typeof window !== "undefined" && ledgers.length > 0) window.localStorage.setItem(guestTransferKey, crypto.randomUUID());

  const write = target.transaction(stores, "readwrite");
  const completed = transactionComplete(write);
  let copied = 0;
  try {
    for (const ledger of ledgers) {
      const receiptId = `guest-transfer:${ledger.id}`;
      if (await requestResult(write.objectStore("importReceipts").get(receiptId))) continue;
      if (await requestResult(write.objectStore("ledgers").get(ledger.id))) throw new Error("目标账号已有同标识账本，本机数据已保留，请先处理账本冲突");
      for (const { name, rows } of contents) {
        for (const row of rows) {
          if ((name === "ledgers" ? row.id : row.ledgerId) !== ledger.id) continue;
          if (name === "ledgers") {
            const copiedLedger: Record<string, unknown> = { ...row, kind: "private", role: "owner" };
            delete copiedLedger.transferredToUserId;
            delete copiedLedger.isPlaceholder;
            write.objectStore(name).add(copiedLedger);
          } else write.objectStore(name).add(row);
        }
      }
      write.objectStore("importReceipts").add({ id: receiptId, ledgerId: ledger.id, userId: session.userId });
      copied += 1;
    }
    await completed;
    console.debug("[guest-transfer] local ledgers transferred", { userId: session.userId, copied });
    return copied;
  } catch (error) {
    try { write.abort(); } catch { /* Already aborted. */ }
    await completed.catch(() => undefined);
    console.error("[guest-transfer] transfer interrupted; frozen source retained", { userId: session.userId, error });
    throw error;
  }
}
