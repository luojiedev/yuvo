import type { Ledger } from "./domain";
import { requestResult, transactionComplete } from "./idb";

/** Check inside the same write transaction so a concurrent transfer cannot race a save. */
export async function assertLedgerWritable(transaction: IDBTransaction, ledgerId: string): Promise<void> {
  const ledger = await requestResult(transaction.objectStore("ledgers").get(ledgerId)) as Ledger | undefined;
  if (ledger?.transferredToUserId) {
    const completed = transactionComplete(transaction);
    transaction.abort();
    await completed.catch(() => undefined);
    console.error("[local-db] write rejected for transferred guest ledger", { ledgerId });
    throw new Error("此本机账本已移交账号，请登录所属账号继续记账");
  }
}
