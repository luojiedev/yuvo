export type TransactionType = "expense" | "income" | "transfer";
export type CategoryType = "expense" | "income";
export type SupportedCurrency = "CNY" | "USD";
export type ExchangeRateSource = "fixed" | "manual" | "frankfurter";

export interface Ledger {
  id: string;
  name: string;
  baseCurrency: string;
  kind?: "private" | "family";
  role?: "owner" | "admin" | "member" | "viewer";
  networkBound?: boolean;
  transferredToUserId?: string;
  isPlaceholder?: boolean;
  monthlyBudgetMinor?: number;
  version: number;
  createdAt: string;
  archivedAt: string | null;
}

export interface Account {
  id: string;
  ledgerId: string;
  name: string;
  type: "cash" | "bank" | "wallet";
  currency: string;
  openingBalanceMinor: number;
  status: "active" | "inactive";
  version?: number;
  createdAt: string;
}

export interface Category {
  id: string;
  ledgerId: string;
  type: CategoryType;
  name: string;
  icon: string;
  sortOrder: number;
  status: "active" | "inactive";
  version?: number;
}

export interface Subcategory {
  id: string;
  ledgerId: string;
  categoryId: string;
  name: string;
  sortOrder: number;
  status: "active" | "inactive";
  version?: number;
}

export interface TransactionImageAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  blob?: Blob;
  transactionId?: string;
  status?: "pending" | "uploading" | "uploaded" | "failed";
  lastError?: string | null;
}

export interface BookkeepingTransaction {
  id: string;
  operationId: string;
  ledgerId: string;
  type: Exclude<TransactionType, "transfer">;
  amountMinor: number;
  currency: string;
  baseAmountMinor?: number;
  exchangeRateMicros?: number;
  exchangeRateSource?: ExchangeRateSource;
  exchangeRateAt?: string;
  subscriptionId?: string | null;
  subscriptionPeriodKey?: string | null;
  occurredAt: string;
  categoryId: string;
  categoryName: string;
  subcategoryId: string | null;
  subcategoryName: string;
  accountId: string;
  accountName: string;
  note: string;
  images: TransactionImageAttachment[];
  excludeFromStats: boolean;
  isReimbursable?: boolean;
  isRecurring?: boolean;
  isPrivate?: boolean;
  createdByUserId?: string;
  createdByDisplayName?: string;
  version: number;
  createdAt: string;
  deletedAt: string | null;
}

export interface Subscription {
  id: string;
  ledgerId: string;
  name: string;
  beneficiary: string;
  accountId: string;
  categoryId: string;
  amountMinor: number;
  currency: SupportedCurrency;
  baseAmountMinor: number;
  exchangeRateMicros: number;
  exchangeRateSource: ExchangeRateSource;
  exchangeRateAt: string;
  frequency: "month" | "year";
  interval: number;
  nextChargeOn: string;
  /** 用户设定的扣费日（1-31）；旧数据可能缺失，缺失时取 nextChargeOn 的日。 */
  anchorDay?: number;
  remindDaysBefore: number;
  status: "active" | "paused" | "cancelled";
  lastGeneratedPeriodKey: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LocalOperation {
  operationId: string;
  entityType: "ledger" | "transaction" | "category" | "subcategory" | "account" | "subscription";
  entityId: string;
  ledgerId: string;
  operationType: "create" | "update" | "delete";
  baseVersion: number;
  payload: Record<string, unknown>;
  status: "pending" | "syncing" | "synced" | "failed" | "conflict";
  attemptCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
  createdOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkSession {
  key: "current";
  token: string;
  expiresAt: string;
  userId: string;
  username: string;
  displayName: string;
  deviceId: string;
}

export interface SyncCursor {
  ledgerId: string;
  revision: number;
  updatedAt: string;
}

export interface RemoteSyncChange {
  revision: number;
  entityType: "ledger" | "transaction" | "category" | "subcategory" | "account" | "subscription" | "attachment" | "profile";
  entityId: string;
  operationType: "create" | "update" | "delete";
  entityVersion: number;
  payload: Record<string, unknown>;
  operationId: string;
  changedByUserId: string;
  createdAt: string;
}

export interface Transfer {
  id: string;
  ledgerId: string;
  transactionOutId: string;
  transactionInId: string;
  createdAt: string;
}

export interface Tag {
  id: string;
  ledgerId: string;
  name: string;
  createdAt: string;
}

export interface TransactionTag {
  transactionId: string;
  tagId: string;
}

export interface Budget {
  id: string;
  ledgerId: string;
  categoryId: string | null;
  period: string;
  amountMinor: number;
  currency: string;
}

export interface CreateTransactionInput {
  transactionId?: string;
  operationId: string;
  ledgerId: string;
  type: Exclude<TransactionType, "transfer">;
  amountMinor: number;
  currency: string;
  baseAmountMinor?: number;
  exchangeRateMicros?: number;
  exchangeRateSource?: ExchangeRateSource;
  exchangeRateAt?: string;
  subscriptionId?: string | null;
  subscriptionPeriodKey?: string | null;
  occurredAt: string;
  categoryId: string;
  categoryName: string;
  subcategoryId?: string | null;
  subcategoryName?: string;
  accountId: string;
  accountName: string;
  note?: string;
  images?: TransactionImageAttachment[];
  excludeFromStats?: boolean;
  isReimbursable?: boolean;
  isRecurring?: boolean;
  isPrivate?: boolean;
  createdByUserId?: string;
  createdByDisplayName?: string;
}

export function assertMinorAmount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("金额必须是大于零的安全整数");
  }
}

export function createId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function formatMinorAmount(amountMinor: number, currency = "CNY"): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

export function transactionBaseAmountMinor(transaction: Pick<BookkeepingTransaction, "amountMinor" | "baseAmountMinor">): number {
  return Number.isSafeInteger(transaction.baseAmountMinor) ? transaction.baseAmountMinor! : transaction.amountMinor;
}

export function isTransactionVisibleOnDate(
  transaction: Pick<BookkeepingTransaction, "occurredAt">,
  today = new Date(),
): boolean {
  const occurredAt = new Date(transaction.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return false;
  const occurredDate = occurredAt.getFullYear() * 10_000 + (occurredAt.getMonth() + 1) * 100 + occurredAt.getDate();
  const currentDate = today.getFullYear() * 10_000 + (today.getMonth() + 1) * 100 + today.getDate();
  return occurredDate <= currentDate;
}

export function convertToBaseAmountMinor(amountMinor: number, exchangeRateMicros: number): number {
  assertMinorAmount(amountMinor);
  if (!Number.isSafeInteger(exchangeRateMicros) || exchangeRateMicros <= 0) throw new Error("汇率必须大于零");
  const result = Math.round((amountMinor * exchangeRateMicros) / 1_000_000);
  assertMinorAmount(result);
  return result;
}

export function formatTransactionCategory(categoryName: string, subtag = ""): string {
  const normalizedSubtag = subtag.trim();
  return normalizedSubtag ? `${categoryName}[${normalizedSubtag}]` : categoryName;
}

export interface TransactionDayGroup {
  key: string;
  label: string;
  expenseMinor: number;
  incomeMinor: number;
  transactions: BookkeepingTransaction[];
}

function localDayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function localDayLabel(value: Date, today: Date): string {
  if (localDayKey(value) === localDayKey(today)) return "今天";
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (localDayKey(value) === localDayKey(yesterday)) return "昨天";
  return `${value.getFullYear()}年${String(value.getMonth() + 1).padStart(2, "0")}月${String(value.getDate()).padStart(2, "0")}日`;
}

export function groupTransactionsByLocalDay(
  transactions: BookkeepingTransaction[],
  today = new Date(),
): TransactionDayGroup[] {
  const groups = new Map<string, TransactionDayGroup>();
  [...transactions]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .forEach((transaction) => {
      const occurredAt = new Date(transaction.occurredAt);
      const key = localDayKey(occurredAt);
      const group = groups.get(key) ?? {
        key,
        label: localDayLabel(occurredAt, today),
        expenseMinor: 0,
        incomeMinor: 0,
        transactions: [],
      };
      group.transactions.push(transaction);
      if (transaction.type === "income") group.incomeMinor += transactionBaseAmountMinor(transaction);
      else group.expenseMinor += transactionBaseAmountMinor(transaction);
      groups.set(key, group);
    });
  return Array.from(groups.values());
}
