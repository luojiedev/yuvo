export const defaultBookkeepingIds = {
  ledgerId: "ledger-default",
  accountId: "account-cash",
} as const;

export function accountIdForLedger(ledgerId: string): string {
  return ledgerId === defaultBookkeepingIds.ledgerId
    ? defaultBookkeepingIds.accountId
    : `account-cash:${ledgerId}`;
}

export function categoryIdForLedger(ledgerId: string, categoryId: string): string {
  return ledgerId === defaultBookkeepingIds.ledgerId ? categoryId : `${ledgerId}:${categoryId}`;
}
