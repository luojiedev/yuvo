import type {
  Account,
  BookkeepingTransaction,
  Category,
  CreateTransactionInput,
  Ledger,
  LocalOperation,
  NetworkSession,
  RemoteSyncChange,
  Subscription,
  Subcategory,
  SyncCursor,
  TransactionImageAttachment,
} from "./domain";
import { assertMinorAmount, createId } from "./domain";
import {
  accountIdForLedger,
  categoryIdForLedger,
  defaultBookkeepingIds,
} from "./ledger-identifiers";
import { OperationTimeoutError } from "./operation-timeout";
import { requestResult, transactionComplete } from "./idb";
import { assertLedgerWritable } from "./ledger-write-access";
import { dayOfIsoDate, isValidAnchorDay } from "./subscription-schedule";

export {
  accountIdForLedger,
  categoryIdForLedger,
  defaultBookkeepingIds,
} from "./ledger-identifiers";

const DATABASE_NAME = "swift-ledger";
const DATABASE_VERSION = 6;
const DATABASE_OPEN_TIMEOUT_MS = 8_000;

const STORE = {
  ledgers: "ledgers",
  accounts: "accounts",
  categories: "categories",
  subcategories: "subcategories",
  transactions: "transactions",
  subscriptions: "subscriptions",
  localOperations: "localOperations",
  networkSession: "networkSession",
  syncCursors: "syncCursors",
} as const;

const DEFAULT_LEDGER_ID = defaultBookkeepingIds.ledgerId;
const DEFAULT_MONTHLY_BUDGET_MINOR = 300_000;
const MAX_MONTHLY_BUDGET_MINOR = 1_000_000_000_000;

const CATEGORY_TEMPLATES: Array<Omit<Category, "ledgerId">> = [
  { id: "category-food", type: "expense", name: "餐饮", icon: "餐", sortOrder: 1, status: "active" },
  { id: "category-transport", type: "expense", name: "交通", icon: "行", sortOrder: 2, status: "active" },
  { id: "category-shopping", type: "expense", name: "购物", icon: "购", sortOrder: 3, status: "active" },
  { id: "category-medical", type: "expense", name: "医疗", icon: "医", sortOrder: 4, status: "active" },
  { id: "category-investment", type: "expense", name: "投资", icon: "投", sortOrder: 5, status: "active" },
  { id: "category-home", type: "expense", name: "居家", icon: "家", sortOrder: 6, status: "active" },
  { id: "category-fixed", type: "expense", name: "固定支出", icon: "固", sortOrder: 7, status: "active" },
  { id: "category-travel", type: "expense", name: "旅行", icon: "旅", sortOrder: 8, status: "active" },
  { id: "category-other", type: "expense", name: "其他", icon: "其", sortOrder: 9, status: "active" },
  { id: "category-custom", type: "expense", name: "自定义", icon: "+", sortOrder: 10, status: "active" },
  { id: "category-salary", type: "income", name: "工资", icon: "薪", sortOrder: 1, status: "active" },
  { id: "category-bonus", type: "income", name: "奖金", icon: "奖", sortOrder: 2, status: "active" },
  { id: "category-part-time", type: "income", name: "兼职", icon: "兼", sortOrder: 3, status: "active" },
  { id: "category-investment-income", type: "income", name: "理财", icon: "财", sortOrder: 4, status: "active" },
  { id: "category-red-packet", type: "income", name: "红包", icon: "红", sortOrder: 5, status: "active" },
  { id: "category-reimbursement", type: "income", name: "报销", icon: "报", sortOrder: 6, status: "active" },
  { id: "category-refund", type: "income", name: "退款", icon: "退", sortOrder: 7, status: "active" },
  { id: "category-other-income", type: "income", name: "其他", icon: "其", sortOrder: 8, status: "active" },
];

const SUBCATEGORY_TEMPLATES: Record<string, readonly string[]> = {
  "category-food": ["早餐", "午餐", "晚餐", "夜宵", "外卖", "咖啡", "饮料"],
  "category-transport": ["公交", "地铁", "打车", "加油", "停车", "维修"],
  "category-medical": ["药品", "门诊", "住院", "体检", "牙科"],
  "category-shopping": ["日用品", "服饰", "数码", "家电", "网购"],
  "category-investment": ["基金", "股票", "保险", "储蓄"],
  "category-home": ["房租", "水电", "物业", "家居", "维修"],
  "category-fixed": ["房租", "物业水电", "学费", "电话费", "会员"],
  "category-travel": ["住宿", "交通", "门票", "餐饮", "纪念品"],
  "category-salary": ["基本工资", "绩效", "补贴", "加班费"],
  "category-bonus": ["年终奖", "项目奖", "提成"],
};

function categoriesForLedger(ledgerId: string): Category[] {
  return CATEGORY_TEMPLATES.map((category) => ({
    ...category,
    id: categoryIdForLedger(ledgerId, category.id),
    ledgerId,
    version: 1,
  }));
}

function subcategoriesForLedger(ledgerId: string): Subcategory[] {
  return Object.entries(SUBCATEGORY_TEMPLATES).flatMap(([templateCategoryId, names]) => {
    const categoryId = categoryIdForLedger(ledgerId, templateCategoryId);
    return names.map((name, index) => ({
      id: `${categoryId}:subtag-${index + 1}`,
      ledgerId,
      categoryId,
      name,
      sortOrder: index + 1,
      status: "active" as const,
      version: 1,
    }));
  });
}

export function openBookkeepingDatabase(scope?: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(scope ? `${DATABASE_NAME}:${scope}` : DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error("[local-db] database open timed out", { timeoutMs: DATABASE_OPEN_TIMEOUT_MS });
      reject(new OperationTimeoutError("open_local_database", DATABASE_OPEN_TIMEOUT_MS));
    }, DATABASE_OPEN_TIMEOUT_MS);

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    request.addEventListener("upgradeneeded", (event) => {
      const database = request.result;
      const upgradeTransaction = request.transaction;
      if (!upgradeTransaction) throw new Error("本地数据库升级事务不可用");
      const store = (name: string, keyPath: string): IDBObjectStore => database.objectStoreNames.contains(name)
        ? upgradeTransaction.objectStore(name)
        : database.createObjectStore(name, { keyPath });
      const index = (objectStore: IDBObjectStore, name: string, keyPath: string, options?: IDBIndexParameters) => {
        if (!objectStore.indexNames.contains(name)) objectStore.createIndex(name, keyPath, options);
      };

      const ledgerStore = store(STORE.ledgers, "id");
      index(ledgerStore, "archivedAt", "archivedAt");
      const accountStore = store(STORE.accounts, "id");
      index(accountStore, "ledgerId", "ledgerId");
      const categoryStore = store(STORE.categories, "id");
      index(categoryStore, "ledgerId", "ledgerId");
      const subcategoryStore = store(STORE.subcategories, "id");
      index(subcategoryStore, "ledgerId", "ledgerId");
      index(subcategoryStore, "categoryId", "categoryId");
      const transactionStore = store(STORE.transactions, "id");
      index(transactionStore, "ledgerId", "ledgerId");
      index(transactionStore, "occurredAt", "occurredAt");
      index(transactionStore, "operationId", "operationId", { unique: true });
      index(transactionStore, "subscriptionPeriodKey", "subscriptionPeriodKey");
      const subscriptionStore = store(STORE.subscriptions, "id");
      index(subscriptionStore, "ledgerId", "ledgerId");
      const operationStore = store(STORE.localOperations, "operationId");
      index(operationStore, "ledgerId", "ledgerId");
      index(operationStore, "status", "status");
      store(STORE.networkSession, "key");
      store(STORE.syncCursors, "ledgerId");
      store("recoveryArchives", "id");
      store("importReceipts", "id");
      store("legacyMigrations", "id");
      console.debug("[local-db] schema upgraded without clearing existing data", {
        oldVersion: event.oldVersion,
        newVersion: event.newVersion,
      });
    });

    request.addEventListener("success", () => {
      const database = request.result;
      database.addEventListener("versionchange", () => {
        console.debug("[local-db] closing stale connection for schema upgrade", { version: database.version });
        database.close();
      });
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(database);
    }, { once: true });
    request.addEventListener("error", () => rejectOnce(request.error ?? new Error("本地数据库打开失败")), { once: true });
    request.addEventListener("blocked", () => rejectOnce(new Error("本地数据库升级被其他页面阻止")), {
      once: true,
    });
  });
}

export async function ensureDefaultData(database: IDBDatabase): Promise<void> {
  const transaction = database.transaction(
    [STORE.ledgers, STORE.accounts, STORE.categories, STORE.subcategories],
    "readwrite",
  );
  const ledgerStore = transaction.objectStore(STORE.ledgers);
  const ledgerCount = ((await requestResult(ledgerStore.getAll())) as Ledger[]).filter((ledger) => !ledger.transferredToUserId).length;

  if (ledgerCount === 0) {
    const ledgerId = `ledger-${createId()}`;
    const now = new Date().toISOString();
    const ledger: Ledger = {
      id: ledgerId,
      name: "日常账本",
      isPlaceholder: true,
      baseCurrency: "CNY",
      kind: "private",
      role: "owner",
      monthlyBudgetMinor: DEFAULT_MONTHLY_BUDGET_MINOR,
      version: 1,
      createdAt: now,
      archivedAt: null,
    };
    const account: Account = {
      id: accountIdForLedger(ledgerId),
      ledgerId,
      name: "现金",
      type: "cash",
      currency: "CNY",
      openingBalanceMinor: 0,
      status: "active",
      version: 1,
      createdAt: now,
    };
    ledgerStore.add(ledger);
    transaction.objectStore(STORE.accounts).add(account);
    const categoryStore = transaction.objectStore(STORE.categories);
    categoriesForLedger(ledgerId).forEach((category) => categoryStore.add(category));
    const subcategoryStore = transaction.objectStore(STORE.subcategories);
    subcategoriesForLedger(ledgerId).forEach((subcategory) => subcategoryStore.add(subcategory));
    console.debug("[local-db] default bookkeeping data created", { ledgerId });
  }

  await transactionComplete(transaction);
}

function namespacedEntityId(entityId: string, oldLedgerId: string, newLedgerId: string): string {
  return entityId.startsWith(`${oldLedgerId}:`)
    ? `${newLedgerId}${entityId.slice(oldLedgerId.length)}`
    : `${newLedgerId}:${entityId}`;
}

function remapOperationPayload(
  operation: LocalOperation,
  oldLedgerId: string,
  newLedgerId: string,
  accountIds: ReadonlyMap<string, string>,
  categoryIds: ReadonlyMap<string, string>,
  subcategoryIds: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const payload = { ...operation.payload };
  if (payload.ledgerId === oldLedgerId) payload.ledgerId = newLedgerId;
  if (typeof payload.accountId === "string") payload.accountId = accountIds.get(payload.accountId) ?? payload.accountId;
  if (typeof payload.categoryId === "string") payload.categoryId = categoryIds.get(payload.categoryId) ?? payload.categoryId;
  if (typeof payload.subcategoryId === "string") payload.subcategoryId = subcategoryIds.get(payload.subcategoryId) ?? payload.subcategoryId;
  if (typeof payload.id === "string") {
    const ids = operation.entityType === "account"
      ? accountIds
      : operation.entityType === "category"
        ? categoryIds
        : operation.entityType === "subcategory"
          ? subcategoryIds
          : null;
    if (ids) payload.id = ids.get(payload.id) ?? payload.id;
  }
  return payload;
}

export async function ensureOfflineLedgerUsesUniqueId(
  database: IDBDatabase,
  ledgerId: string,
): Promise<string> {
  if (ledgerId !== DEFAULT_LEDGER_ID) return ledgerId;

  const transaction = database.transaction(Object.values(STORE), "readwrite");
  const ledgerStore = transaction.objectStore(STORE.ledgers);
  const ledger = (await requestResult(ledgerStore.get(ledgerId))) as Ledger | undefined;
  if (!ledger) {
    await transactionComplete(transaction);
    return ledgerId;
  }
  const session = (await requestResult(
    transaction.objectStore(STORE.networkSession).get("current"),
  )) as NetworkSession | undefined;
  if (session || ledger.networkBound) {
    if (session && !ledger.networkBound) ledgerStore.put({ ...ledger, networkBound: true });
    await transactionComplete(transaction);
    console.debug("[local-db] legacy ledger migration skipped for a bound account", { ledgerId });
    return ledgerId;
  }

  const newLedgerId = `ledger-${createId()}`;
  const accountStore = transaction.objectStore(STORE.accounts);
  const categoryStore = transaction.objectStore(STORE.categories);
  const subcategoryStore = transaction.objectStore(STORE.subcategories);
  const bookkeepingTransactionStore = transaction.objectStore(STORE.transactions);
  const operationStore = transaction.objectStore(STORE.localOperations);
  const cursorStore = transaction.objectStore(STORE.syncCursors);
  const [accounts, categories, subcategories, bookkeepingTransactions, operations] = await Promise.all([
    requestResult(accountStore.index("ledgerId").getAll(ledgerId)) as Promise<Account[]>,
    requestResult(categoryStore.index("ledgerId").getAll(ledgerId)) as Promise<Category[]>,
    requestResult(subcategoryStore.index("ledgerId").getAll(ledgerId)) as Promise<Subcategory[]>,
    requestResult(bookkeepingTransactionStore.index("ledgerId").getAll(ledgerId)) as Promise<BookkeepingTransaction[]>,
    requestResult(operationStore.index("ledgerId").getAll(ledgerId)) as Promise<LocalOperation[]>,
  ]);

  const accountIds = new Map(accounts.map((account) => [
    account.id,
    account.id === defaultBookkeepingIds.accountId
      ? accountIdForLedger(newLedgerId)
      : namespacedEntityId(account.id, ledgerId, newLedgerId),
  ]));
  const categoryIds = new Map(categories.map((category) => [
    category.id,
    namespacedEntityId(category.id, ledgerId, newLedgerId),
  ]));
  const subcategoryIds = new Map(subcategories.map((subcategory) => {
    const mappedCategoryId = categoryIds.get(subcategory.categoryId)
      ?? namespacedEntityId(subcategory.categoryId, ledgerId, newLedgerId);
    const mappedId = subcategory.id.startsWith(subcategory.categoryId)
      ? `${mappedCategoryId}${subcategory.id.slice(subcategory.categoryId.length)}`
      : namespacedEntityId(subcategory.id, ledgerId, newLedgerId);
    return [subcategory.id, mappedId];
  }));

  ledgerStore.delete(ledgerId);
  ledgerStore.add({ ...ledger, id: newLedgerId });
  for (const account of accounts) {
    accountStore.delete(account.id);
    accountStore.add({ ...account, id: accountIds.get(account.id)!, ledgerId: newLedgerId });
  }
  for (const category of categories) {
    categoryStore.delete(category.id);
    categoryStore.add({ ...category, id: categoryIds.get(category.id)!, ledgerId: newLedgerId });
  }
  for (const subcategory of subcategories) {
    subcategoryStore.delete(subcategory.id);
    subcategoryStore.add({
      ...subcategory,
      id: subcategoryIds.get(subcategory.id)!,
      ledgerId: newLedgerId,
      categoryId: categoryIds.get(subcategory.categoryId) ?? subcategory.categoryId,
    });
  }
  for (const row of bookkeepingTransactions) {
    bookkeepingTransactionStore.put({
      ...row,
      ledgerId: newLedgerId,
      accountId: accountIds.get(row.accountId) ?? row.accountId,
      categoryId: categoryIds.get(row.categoryId) ?? row.categoryId,
      subcategoryId: row.subcategoryId ? subcategoryIds.get(row.subcategoryId) ?? row.subcategoryId : null,
    });
  }
  for (const operation of operations) {
    const entityIds = operation.entityType === "account"
      ? accountIds
      : operation.entityType === "category"
        ? categoryIds
        : operation.entityType === "subcategory"
          ? subcategoryIds
          : null;
    operationStore.put({
      ...operation,
      ledgerId: newLedgerId,
      entityId: operation.entityType === "ledger"
        ? newLedgerId
        : entityIds?.get(operation.entityId) ?? operation.entityId,
      payload: remapOperationPayload(operation, ledgerId, newLedgerId, accountIds, categoryIds, subcategoryIds),
    });
  }
  cursorStore.delete(ledgerId);

  await transactionComplete(transaction);
  console.debug("[local-db] unbound legacy ledger migrated to a unique identifier", {
    oldLedgerId: ledgerId,
    newLedgerId,
    accountCount: accounts.length,
    categoryCount: categories.length,
    subcategoryCount: subcategories.length,
    transactionCount: bookkeepingTransactions.length,
    operationCount: operations.length,
  });
  return newLedgerId;
}

export async function markLedgerAsNetworkBound(database: IDBDatabase, ledgerId: string): Promise<void> {
  const transaction = database.transaction(STORE.ledgers, "readwrite");
  const store = transaction.objectStore(STORE.ledgers);
  const ledger = (await requestResult(store.get(ledgerId))) as Ledger | undefined;
  if (ledger && !ledger.networkBound) store.put({ ...ledger, networkBound: true });
  await transactionComplete(transaction);
  if (ledger) console.debug("[local-db] ledger marked as network bound", { ledgerId });
}

export async function listLedgers(database: IDBDatabase): Promise<Ledger[]> {
  const transaction = database.transaction(STORE.ledgers, "readonly");
  const rows = (await requestResult(transaction.objectStore(STORE.ledgers).getAll())) as Ledger[];
  await transactionComplete(transaction);
  return rows
    .filter((ledger) => ledger.archivedAt === null && !ledger.transferredToUserId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function createLedger(
  database: IDBDatabase,
  name: string,
  options: { id?: string; kind?: Ledger["kind"]; role?: Ledger["role"] } = {},
): Promise<Ledger> {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("请输入账本名称");
  if (normalizedName.length > 20) throw new Error("账本名称最多 20 个字");

  const existingLedgers = await listLedgers(database);
  if (existingLedgers.some((ledger) => ledger.name === normalizedName)) {
    throw new Error("已存在同名账本");
  }

  const now = new Date().toISOString();
  const ledger: Ledger = {
    id: options.id ?? `ledger-${createId()}`,
    name: normalizedName,
    baseCurrency: "CNY",
    kind: options.kind ?? "private",
    role: options.role ?? "owner",
    monthlyBudgetMinor: DEFAULT_MONTHLY_BUDGET_MINOR,
    version: 1,
    createdAt: now,
    archivedAt: null,
  };
  const account: Account = {
    id: accountIdForLedger(ledger.id),
    ledgerId: ledger.id,
    name: "现金",
    type: "cash",
    currency: "CNY",
    openingBalanceMinor: 0,
    status: "active",
    version: 1,
    createdAt: now,
  };
  const transaction = database.transaction(
    [STORE.ledgers, STORE.accounts, STORE.categories, STORE.subcategories],
    "readwrite",
  );
  transaction.objectStore(STORE.ledgers).add(ledger);
  transaction.objectStore(STORE.accounts).add(account);
  const categoryStore = transaction.objectStore(STORE.categories);
  categoriesForLedger(ledger.id).forEach((category) => categoryStore.add(category));
  const subcategoryStore = transaction.objectStore(STORE.subcategories);
  subcategoriesForLedger(ledger.id).forEach((subcategory) => subcategoryStore.add(subcategory));
  await transactionComplete(transaction);
  console.debug("[local-db] ledger created", { ledgerId: ledger.id });
  return ledger;
}

export async function updateLedgerMonthlyBudget(
  database: IDBDatabase,
  ledgerId: string,
  monthlyBudgetMinor: number,
): Promise<Ledger> {
  if (!Number.isSafeInteger(monthlyBudgetMinor) || monthlyBudgetMinor <= 0 || monthlyBudgetMinor > MAX_MONTHLY_BUDGET_MINOR) {
    throw new Error("预算金额应大于 0 且不超过 100 亿元");
  }
  const transaction = database.transaction([STORE.ledgers, STORE.localOperations], "readwrite");
  await assertLedgerWritable(transaction, ledgerId);
  const ledgerStore = transaction.objectStore(STORE.ledgers);
  const ledger = (await requestResult(ledgerStore.get(ledgerId))) as Ledger | undefined;
  if (!ledger) {
    transaction.abort();
    throw new Error("账本不存在");
  }
  const now = new Date().toISOString();
  const updated: Ledger = {
    ...ledger,
    monthlyBudgetMinor,
    version: Math.max(1, ledger.version + 1),
  };
  const operation: LocalOperation = {
    operationId: createId(),
    entityType: "ledger",
    entityId: ledgerId,
    ledgerId,
    operationType: "update",
    baseVersion: ledger.version,
    payload: { monthlyBudgetMinor },
    status: "pending",
    attemptCount: 0,
    nextRetryAt: null,
    lastError: null,
    createdOrder: operationOrder(),
    createdAt: now,
    updatedAt: now,
  };
  ledgerStore.put(updated);
  transaction.objectStore(STORE.localOperations).add(operation);
  await transactionComplete(transaction);
  console.debug("[local-db] monthly ledger budget updated", { ledgerId, monthlyBudgetMinor, operationId: operation.operationId });
  return updated;
}

export async function listCategories(database: IDBDatabase, ledgerId: string): Promise<Category[]> {
  const transaction = database.transaction(STORE.categories, "readonly");
  const rows = (await requestResult(transaction.objectStore(STORE.categories).index("ledgerId").getAll(ledgerId))) as Category[];
  await transactionComplete(transaction);
  return rows.filter((row) => row.status === "active").sort((left, right) => left.sortOrder - right.sortOrder);
}

export async function listAccounts(database: IDBDatabase, ledgerId: string): Promise<Account[]> {
  const transaction = database.transaction(STORE.accounts, "readonly");
  const rows = (await requestResult(transaction.objectStore(STORE.accounts).index("ledgerId").getAll(ledgerId))) as Account[];
  await transactionComplete(transaction);
  return rows.filter((row) => row.status === "active").sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function listSubscriptions(database: IDBDatabase, ledgerId: string): Promise<Subscription[]> {
  const transaction = database.transaction(STORE.subscriptions, "readonly");
  const rows = (await requestResult(transaction.objectStore(STORE.subscriptions).index("ledgerId").getAll(ledgerId))) as Subscription[];
  await transactionComplete(transaction);
  return rows.sort((left, right) => left.nextChargeOn.localeCompare(right.nextChargeOn));
}

export async function saveSubscription(
  database: IDBDatabase,
  input: Omit<Subscription, "id" | "version" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<Subscription> {
  const name = input.name.trim();
  const beneficiary = input.beneficiary.trim();
  if (!name || name.length > 40) throw new Error("订阅名称应为 1-40 个字");
  if (beneficiary.length > 20) throw new Error("使用人最多 20 个字");
  assertMinorAmount(input.amountMinor);
  assertMinorAmount(input.baseAmountMinor);
  if (!Number.isSafeInteger(input.exchangeRateMicros) || input.exchangeRateMicros <= 0) throw new Error("汇率必须大于零");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.nextChargeOn)) throw new Error("下次扣费日期不正确");
  if (!Number.isSafeInteger(input.interval) || input.interval < 1 || input.interval > 24) throw new Error("扣费间隔不正确");
  const transaction = database.transaction([STORE.ledgers, STORE.subscriptions, STORE.localOperations], "readwrite");
  await assertLedgerWritable(transaction, input.ledgerId);
  const store = transaction.objectStore(STORE.subscriptions);
  const existing = input.id ? await requestResult(store.get(input.id)) as Subscription | undefined : undefined;
  const now = new Date().toISOString();
  // 日期没被改动时沿用原锚点；用户改了日期或新建时，以所选日期的日作为新的锚点。
  const anchorDay = isValidAnchorDay(input.anchorDay)
    ? input.anchorDay
    : existing && existing.nextChargeOn === input.nextChargeOn && isValidAnchorDay(existing.anchorDay)
      ? existing.anchorDay
      : dayOfIsoDate(input.nextChargeOn);
  const row: Subscription = {
    ...input,
    anchorDay,
    id: existing?.id ?? `subscription-${createId()}`,
    name,
    beneficiary,
    version: (existing?.version ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.put(row);
  transaction.objectStore(STORE.localOperations).add(entityOperation({
    operationId: createId(),
    ledgerId: row.ledgerId,
    entityType: "subscription",
    entityId: row.id,
    operationType: existing ? "update" : "create",
    baseVersion: existing?.version ?? 0,
    payload: subscriptionSyncPayload(row),
    now,
  }));
  await transactionComplete(transaction);
  console.debug("[local-db] subscription saved", { subscriptionId: row.id, ledgerId: row.ledgerId, version: row.version });
  return row;
}

export async function cancelSubscription(database: IDBDatabase, subscriptionId: string): Promise<void> {
  const transaction = database.transaction([STORE.ledgers, STORE.subscriptions, STORE.localOperations], "readwrite");
  const store = transaction.objectStore(STORE.subscriptions);
  const existing = await requestResult(store.get(subscriptionId)) as Subscription | undefined;
  if (!existing) { await transactionComplete(transaction); return; }
  await assertLedgerWritable(transaction, existing.ledgerId);
  const now = new Date().toISOString();
  const row = { ...existing, status: "cancelled" as const, version: existing.version + 1, updatedAt: now };
  store.put(row);
  transaction.objectStore(STORE.localOperations).add(entityOperation({
    operationId: createId(), ledgerId: row.ledgerId, entityType: "subscription", entityId: row.id,
    operationType: "update", baseVersion: existing.version, payload: subscriptionSyncPayload(row), now,
  }));
  await transactionComplete(transaction);
  console.debug("[local-db] subscription cancelled", { subscriptionId, ledgerId: row.ledgerId });
}

function subscriptionSyncPayload(row: Subscription): Record<string, unknown> {
  return {
    name: row.name, beneficiary: row.beneficiary, accountId: row.accountId, categoryId: row.categoryId,
    amountMinor: row.amountMinor, currency: row.currency, baseAmountMinor: row.baseAmountMinor,
    exchangeRateMicros: row.exchangeRateMicros, exchangeRateSource: row.exchangeRateSource,
    exchangeRateAt: row.exchangeRateAt, frequency: row.frequency, interval: row.interval,
    nextChargeOn: row.nextChargeOn, anchorDay: row.anchorDay ?? dayOfIsoDate(row.nextChargeOn),
    remindDaysBefore: row.remindDaysBefore, status: row.status,
    lastGeneratedPeriodKey: row.lastGeneratedPeriodKey,
  };
}

export async function saveAccount(database: IDBDatabase, input: {
  id?: string;
  ledgerId: string;
  name: string;
  type: Account["type"];
}): Promise<Account> {
  const name = input.name.trim();
  if (!name) throw new Error("请输入账户名称");
  if (name.length > 12) throw new Error("账户名称最多 12 个字");
  const accounts = await listAccounts(database, input.ledgerId);
  if (accounts.some((account) => account.id !== input.id && account.name === name)) throw new Error("已存在同名账户");
  const existing = input.id ? accounts.find((account) => account.id === input.id) : undefined;
  const now = new Date().toISOString();
  const account: Account = {
    id: existing?.id ?? `${input.ledgerId}:account-${createId()}`,
    ledgerId: input.ledgerId,
    name,
    type: input.type,
    currency: existing?.currency ?? "CNY",
    openingBalanceMinor: existing?.openingBalanceMinor ?? 0,
    status: "active",
    version: (existing ? existing.version ?? 1 : 0) + 1,
    createdAt: existing?.createdAt ?? now,
  };
  const transaction = database.transaction([STORE.ledgers, STORE.accounts, STORE.localOperations], "readwrite");
  await assertLedgerWritable(transaction, input.ledgerId);
  transaction.objectStore(STORE.accounts).put(account);
  transaction.objectStore(STORE.localOperations).add(entityOperation({
    operationId: createId(), ledgerId: input.ledgerId, entityType: "account", entityId: account.id,
    operationType: existing ? "update" : "create", baseVersion: existing ? existing.version ?? 1 : 0,
    payload: { ...account }, now,
  }));
  await transactionComplete(transaction);
  console.debug("[local-db] account saved", { accountId: account.id, ledgerId: input.ledgerId });
  return account;
}

export async function deactivateAccount(database: IDBDatabase, accountId: string, ledgerId: string): Promise<boolean> {
  const transaction = database.transaction([STORE.ledgers, STORE.accounts, STORE.localOperations], "readwrite");
  await assertLedgerWritable(transaction, ledgerId);
  const store = transaction.objectStore(STORE.accounts);
  const existing = (await requestResult(store.get(accountId))) as Account | undefined;
  if (!existing) {
    await transactionComplete(transaction);
    return false;
  }
  if (existing.ledgerId !== ledgerId) {
    transaction.abort();
    throw new Error("账户不属于当前账本");
  }
  const now = new Date().toISOString();
  store.put({ ...existing, status: "inactive", version: (existing.version ?? 1) + 1 } satisfies Account);
  transaction.objectStore(STORE.localOperations).add(entityOperation({
    operationId: createId(), ledgerId, entityType: "account", entityId: accountId,
    operationType: "delete", baseVersion: existing.version ?? 1, payload: {}, now,
  }));
  await transactionComplete(transaction);
  console.debug("[local-db] account deactivated", { accountId, ledgerId });
  return true;
}

export async function listSubcategories(database: IDBDatabase, ledgerId: string): Promise<Subcategory[]> {
  const transaction = database.transaction(STORE.subcategories, "readonly");
  const rows = (await requestResult(transaction.objectStore(STORE.subcategories).index("ledgerId").getAll(ledgerId))) as Subcategory[];
  await transactionComplete(transaction);
  return rows.filter((row) => row.status === "active").sort((left, right) => left.sortOrder - right.sortOrder);
}

export async function saveCategory(database: IDBDatabase, input: {
  id?: string;
  ledgerId: string;
  type: Category["type"];
  name: string;
  icon?: string;
}): Promise<Category> {
  const name = input.name.trim();
  if (!name) throw new Error("请输入分类名称");
  if (name.length > 8) throw new Error("分类名称最多 8 个字");
  const categories = await listCategories(database, input.ledgerId);
  if (categories.some((item) => item.id !== input.id && item.type === input.type && item.name === name)) throw new Error("已存在同名分类");
  const existing = input.id ? categories.find((item) => item.id === input.id) : undefined;
  const category: Category = {
    id: existing?.id ?? `${input.ledgerId}:category-${createId()}`,
    ledgerId: input.ledgerId,
    type: input.type,
    name,
    icon: input.icon?.trim().slice(0, 1) || name.slice(0, 1),
    sortOrder: existing?.sortOrder ?? Math.max(0, ...categories.filter((item) => item.type === input.type).map((item) => item.sortOrder)) + 1,
    status: "active",
    version: (existing ? existing.version ?? 1 : 0) + 1,
  };
  const now = new Date().toISOString();
  const operationId = createId();
  const transaction = database.transaction([STORE.ledgers, STORE.categories, STORE.localOperations], "readwrite");
  await assertLedgerWritable(transaction, input.ledgerId);
  transaction.objectStore(STORE.categories).put(category);
  transaction.objectStore(STORE.localOperations).add(entityOperation({
    operationId,
    ledgerId: input.ledgerId,
    entityType: "category",
    entityId: category.id,
    operationType: existing ? "update" : "create",
    baseVersion: existing ? existing.version ?? 1 : 0,
    payload: { ...category },
    now,
  }));
  await transactionComplete(transaction);
  console.debug("[local-db] category saved", { categoryId: category.id, ledgerId: input.ledgerId });
  return category;
}

export async function saveSubcategory(database: IDBDatabase, input: {
  id?: string;
  ledgerId: string;
  categoryId: string;
  name: string;
}): Promise<Subcategory> {
  const name = input.name.trim();
  if (!name) throw new Error("请输入子标签名称");
  if (name.length > 10) throw new Error("子标签最多 10 个字");
  const subcategories = await listSubcategories(database, input.ledgerId);
  if (subcategories.some((item) => item.id !== input.id && item.categoryId === input.categoryId && item.name === name)) throw new Error("当前分类已有同名子标签");
  const existing = input.id ? subcategories.find((item) => item.id === input.id) : undefined;
  const row: Subcategory = {
    id: existing?.id ?? `${input.categoryId}:subtag-${createId()}`,
    ledgerId: input.ledgerId,
    categoryId: input.categoryId,
    name,
    sortOrder: existing?.sortOrder ?? Math.max(0, ...subcategories.filter((item) => item.categoryId === input.categoryId).map((item) => item.sortOrder)) + 1,
    status: "active",
    version: (existing ? existing.version ?? 1 : 0) + 1,
  };
  const now = new Date().toISOString();
  const operationId = createId();
  const transaction = database.transaction([STORE.ledgers, STORE.subcategories, STORE.localOperations], "readwrite");
  await assertLedgerWritable(transaction, input.ledgerId);
  transaction.objectStore(STORE.subcategories).put(row);
  transaction.objectStore(STORE.localOperations).add(entityOperation({
    operationId,
    ledgerId: input.ledgerId,
    entityType: "subcategory",
    entityId: row.id,
    operationType: existing ? "update" : "create",
    baseVersion: existing ? existing.version ?? 1 : 0,
    payload: { ...row },
    now,
  }));
  await transactionComplete(transaction);
  console.debug("[local-db] subcategory saved", { subcategoryId: row.id, categoryId: input.categoryId });
  return row;
}

export async function deleteSubcategory(database: IDBDatabase, input: {
  id: string;
  ledgerId: string;
  categoryId: string;
}): Promise<boolean> {
  const transaction = database.transaction([STORE.ledgers, STORE.subcategories, STORE.localOperations], "readwrite");
  await assertLedgerWritable(transaction, input.ledgerId);
  const store = transaction.objectStore(STORE.subcategories);
  const existing = (await requestResult(store.get(input.id))) as Subcategory | undefined;
  if (!existing) {
    await transactionComplete(transaction);
    console.debug("[local-db] subcategory delete skipped because it no longer exists", { subcategoryId: input.id });
    return false;
  }
  if (existing.ledgerId !== input.ledgerId || existing.categoryId !== input.categoryId) {
    transaction.abort();
    throw new Error("子标签不属于当前账本或分类");
  }
  const now = new Date().toISOString();
  const updated: Subcategory = { ...existing, status: "inactive", version: (existing.version ?? 1) + 1 };
  store.put(updated);
  transaction.objectStore(STORE.localOperations).add(entityOperation({
    operationId: createId(),
    ledgerId: input.ledgerId,
    entityType: "subcategory",
    entityId: input.id,
    operationType: "delete",
    baseVersion: existing.version ?? 1,
    payload: { categoryId: input.categoryId },
    now,
  }));
  await transactionComplete(transaction);
  console.debug("[local-db] subcategory deleted", { subcategoryId: input.id, categoryId: input.categoryId });
  return true;
}

export async function listTransactions(
  database: IDBDatabase,
  ledgerId: string,
): Promise<BookkeepingTransaction[]> {
  const transaction = database.transaction(STORE.transactions, "readonly");
  const index = transaction.objectStore(STORE.transactions).index("ledgerId");
  const rows = (await requestResult(index.getAll(ledgerId))) as BookkeepingTransaction[];
  await transactionComplete(transaction);
  return rows
    .filter((row) => row.deletedAt === null)
    .map((row) => ({
      ...row,
      baseAmountMinor: Number.isSafeInteger(row.baseAmountMinor) ? row.baseAmountMinor : row.amountMinor,
      exchangeRateMicros: Number.isSafeInteger(row.exchangeRateMicros) ? row.exchangeRateMicros : 1_000_000,
      exchangeRateSource: row.exchangeRateSource ?? "fixed",
      exchangeRateAt: row.exchangeRateAt ?? row.createdAt,
    }))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

function isLegacySubscriptionGhostTransaction(row: BookkeepingTransaction): boolean {
  return !row.categoryName && !row.accountName && !row.note && !row.subscriptionId;
}

function entityOperation(input: {
  operationId: string;
  ledgerId: string;
  entityType: "category" | "subcategory" | "account" | "subscription";
  entityId: string;
  operationType: LocalOperation["operationType"];
  baseVersion: number;
  payload: Record<string, unknown>;
  now: string;
}): LocalOperation {
  return {
    operationId: input.operationId,
    ledgerId: input.ledgerId,
    entityType: input.entityType,
    entityId: input.entityId,
    operationType: input.operationType,
    baseVersion: input.baseVersion,
    payload: input.payload,
    status: "pending",
    attemptCount: 0,
    nextRetryAt: null,
    lastError: null,
    createdOrder: operationOrder(),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export async function createTransaction(
  database: IDBDatabase,
  input: CreateTransactionInput,
): Promise<BookkeepingTransaction> {
  assertMinorAmount(input.amountMinor);
  const transaction = database.transaction(
    [STORE.ledgers, STORE.transactions, STORE.localOperations],
    "readwrite",
  );
  await assertLedgerWritable(transaction, input.ledgerId);
  const operationStore = transaction.objectStore(STORE.localOperations);
  const existingOperation = (await requestResult(
    operationStore.get(input.operationId),
  )) as LocalOperation | undefined;

  if (existingOperation) {
    const existing = (await requestResult(
      transaction.objectStore(STORE.transactions).get(existingOperation.entityId),
    )) as BookkeepingTransaction;
    await transactionComplete(transaction);
    console.debug("[local-db] duplicate create operation reused", {
      operationId: input.operationId,
    });
    return existing;
  }

  const now = new Date().toISOString();
  const transactionId = input.transactionId ?? createId();
  const row: BookkeepingTransaction = {
    ...input,
    id: transactionId,
    baseAmountMinor: input.baseAmountMinor ?? input.amountMinor,
    exchangeRateMicros: input.exchangeRateMicros ?? 1_000_000,
    exchangeRateSource: input.exchangeRateSource ?? "fixed",
    exchangeRateAt: input.exchangeRateAt ?? now,
    subscriptionId: input.subscriptionId ?? null,
    subscriptionPeriodKey: input.subscriptionPeriodKey ?? null,
    subcategoryId: input.subcategoryId ?? null,
    subcategoryName: input.subcategoryName?.trim() ?? "",
    note: input.note?.trim() ?? "",
    images: (input.images ?? []).map((image) => ({
      ...image,
      transactionId,
      status: image.status ?? "pending",
      lastError: null,
    })),
    excludeFromStats: input.excludeFromStats ?? false,
    isReimbursable: input.isReimbursable ?? false,
    isRecurring: input.isRecurring ?? false,
    isPrivate: input.isPrivate ?? false,
    version: 1,
    createdAt: now,
    deletedAt: null,
  };
  const operation: LocalOperation = {
    operationId: input.operationId,
    entityType: "transaction",
    entityId: row.id,
    ledgerId: row.ledgerId,
    operationType: "create",
    baseVersion: 0,
    payload: transactionSyncPayload(row),
    status: "pending",
    attemptCount: 0,
    nextRetryAt: null,
    lastError: null,
    createdOrder: operationOrder(),
    createdAt: now,
    updatedAt: now,
  };

  transaction.objectStore(STORE.transactions).add(row);
  operationStore.add(operation);
  await transactionComplete(transaction);
  console.debug("[local-db] transaction created", { transactionId: row.id });
  return row;
}

export async function updateTransaction(
  database: IDBDatabase,
  transactionId: string,
  input: CreateTransactionInput,
): Promise<BookkeepingTransaction> {
  assertMinorAmount(input.amountMinor);
  const transaction = database.transaction([STORE.ledgers, STORE.transactions, STORE.localOperations], "readwrite");
  await assertLedgerWritable(transaction, input.ledgerId);
  const transactionStore = transaction.objectStore(STORE.transactions);
  const existing = (await requestResult(transactionStore.get(transactionId))) as BookkeepingTransaction | undefined;
  if (!existing || existing.deletedAt !== null) {
    transaction.abort();
    throw new Error("要修改的账单不存在");
  }
  if (existing.ledgerId !== input.ledgerId) {
    transaction.abort();
    throw new Error("不能将账单移动到其他账本");
  }

  const now = new Date().toISOString();
  const row: BookkeepingTransaction = {
    ...existing,
    type: input.type,
    amountMinor: input.amountMinor,
    currency: input.currency,
    baseAmountMinor: input.baseAmountMinor ?? input.amountMinor,
    exchangeRateMicros: input.exchangeRateMicros ?? 1_000_000,
    exchangeRateSource: input.exchangeRateSource ?? "fixed",
    exchangeRateAt: input.exchangeRateAt ?? now,
    subscriptionId: input.subscriptionId ?? existing.subscriptionId ?? null,
    subscriptionPeriodKey: input.subscriptionPeriodKey ?? existing.subscriptionPeriodKey ?? null,
    occurredAt: input.occurredAt,
    categoryId: input.categoryId,
    categoryName: input.categoryName,
    subcategoryId: input.subcategoryId ?? null,
    subcategoryName: input.subcategoryName?.trim() ?? "",
    accountId: input.accountId,
    accountName: input.accountName,
    note: input.note?.trim() ?? "",
    images: (input.images ?? existing.images).map((image) => ({ ...image, transactionId })),
    excludeFromStats: input.excludeFromStats ?? false,
    isReimbursable: input.isReimbursable ?? false,
    isRecurring: input.isRecurring ?? false,
    isPrivate: input.isPrivate ?? false,
    version: existing.version + 1,
  };
  const operation: LocalOperation = {
    operationId: input.operationId,
    entityType: "transaction",
    entityId: transactionId,
    ledgerId: existing.ledgerId,
    operationType: "update",
    baseVersion: existing.version,
    payload: transactionSyncPayload(row),
    status: "pending",
    attemptCount: 0,
    nextRetryAt: null,
    lastError: null,
    createdOrder: operationOrder(),
    createdAt: now,
    updatedAt: now,
  };
  transactionStore.put(row);
  transaction.objectStore(STORE.localOperations).add(operation);
  await transactionComplete(transaction);
  console.debug("[local-db] transaction updated", { transactionId, operationId: input.operationId, version: row.version });
  return row;
}

export async function deleteTransaction(
  database: IDBDatabase,
  transactionId: string,
  operationId: string,
): Promise<void> {
  const transaction = database.transaction([STORE.ledgers, STORE.transactions, STORE.localOperations], "readwrite");
  const transactionStore = transaction.objectStore(STORE.transactions);
  const existing = (await requestResult(transactionStore.get(transactionId))) as BookkeepingTransaction | undefined;
  if (!existing || existing.deletedAt !== null) {
    await transactionComplete(transaction);
    return;
  }
  await assertLedgerWritable(transaction, existing.ledgerId);
  const now = new Date().toISOString();
  transactionStore.put({ ...existing, version: existing.version + 1, deletedAt: now } satisfies BookkeepingTransaction);
  transaction.objectStore(STORE.localOperations).add({
    operationId,
    entityType: "transaction",
    entityId: transactionId,
    ledgerId: existing.ledgerId,
    operationType: "delete",
    baseVersion: existing.version,
    payload: {},
    status: "pending",
    attemptCount: 0,
    nextRetryAt: null,
    lastError: null,
    createdOrder: operationOrder(),
    createdAt: now,
    updatedAt: now,
  } satisfies LocalOperation);
  await transactionComplete(transaction);
  console.debug("[local-db] transaction deleted", { transactionId, operationId, version: existing.version + 1 });
}

export interface PendingAttachmentUpload {
  transactionId: string;
  attachment: TransactionImageAttachment & { blob: Blob };
}

export async function listPendingAttachmentUploads(
  database: IDBDatabase,
  ledgerId: string,
): Promise<PendingAttachmentUpload[]> {
  const transaction = database.transaction([STORE.transactions, STORE.localOperations], "readonly");
  const rows = (await requestResult(
    transaction.objectStore(STORE.transactions).index("ledgerId").getAll(ledgerId),
  )) as BookkeepingTransaction[];
  const operations = (await requestResult(transaction.objectStore(STORE.localOperations).getAll())) as LocalOperation[];
  const blockedTransactionIds = new Set(operations
    .filter((operation) => operation.entityType === "transaction" && operation.status !== "synced")
    .map((operation) => operation.entityId));
  await transactionComplete(transaction);
  return rows.flatMap((row) => row.deletedAt === null
    && !blockedTransactionIds.has(row.id)
    ? row.images
      .filter((image): image is TransactionImageAttachment & { blob: Blob } =>
        image.blob instanceof Blob && image.status !== "uploaded",
      )
      .map((attachment) => ({ transactionId: row.id, attachment }))
    : []);
}

export interface MissingAttachmentDownload {
  transactionId: string;
  attachmentId: string;
}

export async function listMissingAttachmentDownloads(
  database: IDBDatabase,
  ledgerId: string,
): Promise<MissingAttachmentDownload[]> {
  const transaction = database.transaction(STORE.transactions, "readonly");
  const rows = (await requestResult(
    transaction.objectStore(STORE.transactions).index("ledgerId").getAll(ledgerId),
  )) as BookkeepingTransaction[];
  await transactionComplete(transaction);
  return rows.flatMap((row) => row.images
    .filter((image) => !image.blob && image.status === "failed")
    .map((image) => ({ transactionId: row.id, attachmentId: image.id })));
}

export async function cacheAttachmentBlob(
  database: IDBDatabase,
  transactionId: string,
  attachmentId: string,
  blob: Blob,
): Promise<void> {
  const transaction = database.transaction(STORE.transactions, "readwrite");
  const store = transaction.objectStore(STORE.transactions);
  const row = (await requestResult(store.get(transactionId))) as BookkeepingTransaction | undefined;
  if (row) {
    store.put({
      ...row,
      images: row.images.map((image) => image.id === attachmentId
        ? { ...image, blob, status: "uploaded", lastError: null }
        : image),
    } satisfies BookkeepingTransaction);
  }
  await transactionComplete(transaction);
}

export async function updateAttachmentUploadState(
  database: IDBDatabase,
  transactionId: string,
  attachmentId: string,
  status: NonNullable<TransactionImageAttachment["status"]>,
  lastError: string | null = null,
): Promise<void> {
  const transaction = database.transaction(STORE.transactions, "readwrite");
  const store = transaction.objectStore(STORE.transactions);
  const row = (await requestResult(store.get(transactionId))) as BookkeepingTransaction | undefined;
  if (row) {
    store.put({
      ...row,
      images: row.images.map((image) => image.id === attachmentId
        ? { ...image, transactionId, status, lastError }
        : image),
    } satisfies BookkeepingTransaction);
  }
  await transactionComplete(transaction);
}

function transactionSyncPayload(row: BookkeepingTransaction): Record<string, unknown> {
  return {
    type: row.type,
    amountMinor: row.amountMinor,
    currency: row.currency,
    baseAmountMinor: row.baseAmountMinor ?? row.amountMinor,
    exchangeRateMicros: row.exchangeRateMicros ?? 1_000_000,
    exchangeRateSource: row.exchangeRateSource ?? "fixed",
    exchangeRateAt: row.exchangeRateAt ?? row.createdAt,
    subscriptionId: row.subscriptionId ?? null,
    subscriptionPeriodKey: row.subscriptionPeriodKey ?? null,
    occurredAt: row.occurredAt,
    categoryId: row.categoryId,
    subcategoryId: row.subcategoryId,
    subcategoryName: row.subcategoryName,
    accountId: row.accountId,
    note: row.note,
    excludeFromStats: row.excludeFromStats,
  };
}

export async function listPendingOperations(
  database: IDBDatabase,
  ledgerId: string,
  limit = 50,
): Promise<LocalOperation[]> {
  const transaction = database.transaction([STORE.localOperations, STORE.transactions], "readonly");
  const operationStore = transaction.objectStore(STORE.localOperations);
  const rows = (await requestResult(operationStore.getAll())) as Array<Partial<LocalOperation> & Pick<LocalOperation, "operationId" | "entityId" | "entityType" | "operationType" | "createdAt">>;
  const operations: LocalOperation[] = [];
  for (const row of rows) {
    const transactionRow = row.entityType === "transaction"
      ? (await requestResult(transaction.objectStore(STORE.transactions).get(row.entityId))) as BookkeepingTransaction | undefined
      : undefined;
    const rowLedgerId = row.ledgerId ?? transactionRow?.ledgerId;
    const status = row.status ?? "pending";
    if (rowLedgerId !== ledgerId || !(["pending", "syncing"] as const).includes(status as "pending" | "syncing")) continue;
    if (row.entityType === "transaction" && !transactionRow) continue;
    const entityType = row.entityType === "ledger" || row.entityType === "category" || row.entityType === "subcategory" || row.entityType === "account" || row.entityType === "subscription" ? row.entityType : "transaction";
    const payload = row.payload ?? (transactionRow ? transactionSyncPayload(transactionRow) : {});
    operations.push({
      operationId: row.operationId,
      entityType,
      entityId: row.entityId,
      ledgerId: rowLedgerId,
      operationType: row.operationType,
      baseVersion: row.baseVersion ?? 0,
      payload,
      status: "pending",
      attemptCount: row.attemptCount ?? 0,
      nextRetryAt: row.nextRetryAt ?? null,
      lastError: row.lastError ?? null,
      createdOrder: row.createdOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt ?? row.createdAt,
    });
  }
  await transactionComplete(transaction);
  return operations.sort((left, right) => {
    const leftOrder = left.createdOrder ?? Date.parse(left.createdAt);
    const rightOrder = right.createdOrder ?? Date.parse(right.createdAt);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    const priority = { ledger: 0, category: 1, subcategory: 2, account: 3, subscription: 4, transaction: 5 } as const;
    return priority[left.entityType] - priority[right.entityType];
  }).slice(0, limit);
}

function operationOrder(): number {
  return typeof performance === "undefined" ? Date.now() : performance.timeOrigin + performance.now();
}

export async function updateOperationStates(
  database: IDBDatabase,
  updates: Array<{
    operationId: string;
    status: LocalOperation["status"];
    error?: string | null;
  }>,
): Promise<void> {
  if (updates.length === 0) return;
  const transaction = database.transaction(STORE.localOperations, "readwrite");
  const store = transaction.objectStore(STORE.localOperations);
  const now = new Date().toISOString();
  for (const update of updates) {
    const row = (await requestResult(store.get(update.operationId))) as LocalOperation | undefined;
    if (!row) continue;
    store.put({
      ...row,
      status: update.status,
      attemptCount: (row.attemptCount ?? 0) + (update.status === "syncing" ? 1 : 0),
      lastError: update.error ?? null,
      nextRetryAt: null,
      updatedAt: now,
    });
  }
  await transactionComplete(transaction);
}

export async function countUnsyncedOperations(database: IDBDatabase): Promise<number> {
  const transaction = database.transaction([STORE.ledgers, STORE.localOperations, STORE.transactions], "readonly");
  const ledgers = (await requestResult(transaction.objectStore(STORE.ledgers).getAll())) as Ledger[];
  const locked = new Set(ledgers.filter((ledger) => ledger.transferredToUserId).map((ledger) => ledger.id));
  const rows = (await requestResult(transaction.objectStore(STORE.localOperations).getAll())) as Array<Partial<LocalOperation>>;
  const transactions = (await requestResult(transaction.objectStore(STORE.transactions).getAll())) as BookkeepingTransaction[];
  await transactionComplete(transaction);
  const operationCount = rows.filter((row) => !locked.has(row.ledgerId ?? "") && (!row.status || row.status === "pending" || row.status === "syncing" || row.status === "failed" || row.status === "conflict")).length;
  const attachmentCount = transactions.filter((row) => !locked.has(row.ledgerId)).reduce((count, row) => count + row.images.filter((image) =>
    image.status === "pending" || image.status === "uploading" || image.status === "failed",
  ).length, 0);
  const registrationCount = database.name.startsWith("swift-ledger:user-")
    ? ledgers.filter((ledger) => !ledger.networkBound && ledger.kind !== "family" && ledger.archivedAt === null && !ledger.transferredToUserId).length : 0;
  return operationCount + attachmentCount + registrationCount;
}

export async function getNetworkSession(database: IDBDatabase): Promise<NetworkSession | null> {
  const transaction = database.transaction(STORE.networkSession, "readonly");
  const row = (await requestResult(transaction.objectStore(STORE.networkSession).get("current"))) as NetworkSession | undefined;
  await transactionComplete(transaction);
  return row ?? null;
}

export async function saveNetworkSession(database: IDBDatabase, session: NetworkSession): Promise<void> {
  const transaction = database.transaction(STORE.networkSession, "readwrite");
  transaction.objectStore(STORE.networkSession).put(session);
  await transactionComplete(transaction);
}

export async function clearNetworkSession(database: IDBDatabase): Promise<void> {
  const transaction = database.transaction(STORE.networkSession, "readwrite");
  transaction.objectStore(STORE.networkSession).delete("current");
  await transactionComplete(transaction);
}

export async function getSyncCursor(database: IDBDatabase, ledgerId: string): Promise<number> {
  const transaction = database.transaction(STORE.syncCursors, "readonly");
  const row = (await requestResult(transaction.objectStore(STORE.syncCursors).get(ledgerId))) as SyncCursor | undefined;
  await transactionComplete(transaction);
  return row?.revision ?? 0;
}

export async function saveSyncCursor(database: IDBDatabase, ledgerId: string, revision: number): Promise<void> {
  const transaction = database.transaction(STORE.syncCursors, "readwrite");
  transaction.objectStore(STORE.syncCursors).put({ ledgerId, revision, updatedAt: new Date().toISOString() } satisfies SyncCursor);
  await transactionComplete(transaction);
}

export async function applyRemoteChanges(
  database: IDBDatabase,
  ledgerId: string,
  changes: RemoteSyncChange[],
  existingTransaction?: IDBTransaction,
): Promise<{ applied: number; conflicts: number }> {
  if (changes.length === 0) return { applied: 0, conflicts: 0 };
  const transaction = existingTransaction ?? database.transaction(
    [STORE.ledgers, STORE.transactions, STORE.categories, STORE.subcategories, STORE.accounts, STORE.subscriptions, STORE.localOperations],
    "readwrite",
  );
  const transactionStore = transaction.objectStore(STORE.transactions);
  const ledgerStore = transaction.objectStore(STORE.ledgers);
  const categoryStore = transaction.objectStore(STORE.categories);
  const subcategoryStore = transaction.objectStore(STORE.subcategories);
  const accountStore = transaction.objectStore(STORE.accounts);
  const subscriptionStore = transaction.objectStore(STORE.subscriptions);
  const operationStore = transaction.objectStore(STORE.localOperations);
  const allOperations = (await requestResult(operationStore.getAll())) as LocalOperation[];
  let applied = 0;
  let conflicts = 0;

  for (const change of changes) {
    if (change.entityType === "profile") {
      const userId = stringValue(change.payload.userId, change.entityId);
      const displayName = stringValue(change.payload.displayName);
      if (!userId || !displayName) continue;
      const rows = (await requestResult(transactionStore.getAll())) as BookkeepingTransaction[];
      for (const row of rows) {
        if (row.ledgerId === ledgerId && row.createdByUserId === userId) {
          transactionStore.put({ ...row, createdByDisplayName: displayName } satisfies BookkeepingTransaction);
        }
      }
      applied += 1;
      continue;
    }

    const pending = allOperations.find((operation) =>
      operation.entityType === change.entityType &&
      operation.entityId === change.entityId &&
      operation.operationId !== change.operationId &&
      operation.status !== "synced",
    );
    if (pending) {
      // Older history and acknowledgements of our own writes must not overwrite later local edits.
      if (change.entityVersion <= pending.baseVersion || allOperations.some((operation) => operation.operationId === change.operationId && operation.status === "synced")) continue;
      operationStore.put({
        ...pending,
        status: "conflict",
        lastError: "云端存在更新版本，请处理冲突后重试",
        updatedAt: new Date().toISOString(),
      } satisfies LocalOperation);
      conflicts += 1;
      continue;
    }

    if (change.entityType === "attachment") {
      const payload = change.payload;
      const transactionId = stringValue(payload.transactionId);
      const existingTransaction = transactionId
        ? (await requestResult(transactionStore.get(transactionId))) as BookkeepingTransaction | undefined
        : undefined;
      if (!existingTransaction) continue;
      if (change.operationType === "delete") {
        transactionStore.put({
          ...existingTransaction,
          images: existingTransaction.images.filter((image) => image.id !== change.entityId),
        } satisfies BookkeepingTransaction);
      } else {
        const existingImage = existingTransaction.images.find((image) => image.id === change.entityId);
        const remoteBlob = payload.blob instanceof Blob ? payload.blob : existingImage?.blob;
        const remoteImage: TransactionImageAttachment = {
          id: change.entityId,
          transactionId,
          name: stringValue(payload.name, existingImage?.name),
          type: stringValue(payload.type, existingImage?.type),
          size: safeIntegerValue(payload.size, existingImage?.size ?? 0),
          blob: remoteBlob,
          status: remoteBlob ? "uploaded" : "failed",
          lastError: remoteBlob ? null : "图片等待重新下载",
        };
        transactionStore.put({
          ...existingTransaction,
          images: existingImage
            ? existingTransaction.images.map((image) => image.id === change.entityId ? remoteImage : image)
            : [...existingTransaction.images, remoteImage],
        } satisfies BookkeepingTransaction);
      }
      applied += 1;
      continue;
    }

    if (change.entityType === "ledger") {
      const existing = (await requestResult(ledgerStore.get(change.entityId))) as Ledger | undefined;
      if (!existing || change.operationType === "delete") continue;
      ledgerStore.put({
        ...existing,
        monthlyBudgetMinor: safeIntegerValue(
          change.payload.monthlyBudgetMinor,
          existing.monthlyBudgetMinor ?? DEFAULT_MONTHLY_BUDGET_MINOR,
        ),
        version: change.entityVersion,
      } satisfies Ledger);
      applied += 1;
      continue;
    }

    if (change.entityType === "category") {
      const existing = (await requestResult(categoryStore.get(change.entityId))) as Category | undefined;
      const payload = change.payload;
      if (change.operationType === "delete" && existing) {
        categoryStore.put({ ...existing, status: "inactive", version: change.entityVersion } satisfies Category);
        applied += 1;
        continue;
      }
      categoryStore.put({
        id: change.entityId,
        ledgerId,
        type: payload.type === "income" ? "income" : "expense",
        name: stringValue(payload.name, existing?.name),
        icon: stringValue(payload.icon, existing?.icon ?? "记"),
        sortOrder: safeIntegerValue(payload.sortOrder, existing?.sortOrder ?? 0),
        status: change.operationType === "delete" || payload.status === "inactive" ? "inactive" : "active",
        version: change.entityVersion,
      } satisfies Category);
      applied += 1;
      continue;
    }

    if (change.entityType === "subcategory") {
      const existing = (await requestResult(subcategoryStore.get(change.entityId))) as Subcategory | undefined;
      const payload = change.payload;
      if (change.operationType === "delete" && existing) {
        subcategoryStore.put({ ...existing, status: "inactive", version: change.entityVersion } satisfies Subcategory);
        applied += 1;
        continue;
      }
      subcategoryStore.put({
        id: change.entityId,
        ledgerId,
        categoryId: stringValue(payload.categoryId, existing?.categoryId),
        name: stringValue(payload.name, existing?.name),
        sortOrder: safeIntegerValue(payload.sortOrder, existing?.sortOrder ?? 0),
        status: change.operationType === "delete" || payload.status === "inactive" ? "inactive" : "active",
        version: change.entityVersion,
      } satisfies Subcategory);
      applied += 1;
      continue;
    }

    if (change.entityType === "account") {
      const existing = (await requestResult(accountStore.get(change.entityId))) as Account | undefined;
      const payload = change.payload;
      if (change.operationType === "delete" && existing) {
        accountStore.put({ ...existing, status: "inactive", version: change.entityVersion } satisfies Account);
        applied += 1;
        continue;
      }
      accountStore.put({
        id: change.entityId,
        ledgerId,
        name: stringValue(payload.name, existing?.name),
        type: payload.type === "bank" || payload.type === "wallet" ? payload.type : "cash",
        currency: stringValue(payload.currency, existing?.currency ?? "CNY"),
        openingBalanceMinor: safeIntegerValue(payload.openingBalanceMinor, existing?.openingBalanceMinor ?? 0),
        status: change.operationType === "delete" || payload.status === "inactive" ? "inactive" : "active",
        version: change.entityVersion,
        createdAt: existing?.createdAt ?? stringValue(payload.createdAt, change.createdAt),
      } satisfies Account);
      applied += 1;
      continue;
    }

    if (change.entityType === "subscription") {
      const existing = await requestResult(subscriptionStore.get(change.entityId)) as Subscription | undefined;
      const payload = change.payload;
      const legacyGhost = await requestResult(transactionStore.get(change.entityId)) as BookkeepingTransaction | undefined;
      if (legacyGhost && isLegacySubscriptionGhostTransaction(legacyGhost)) {
        transactionStore.delete(legacyGhost.id);
        console.debug("[local-db] legacy subscription ghost transaction removed", {
          ledgerId,
          subscriptionId: change.entityId,
        });
      }
      subscriptionStore.put({
        id: change.entityId,
        ledgerId,
        name: stringValue(payload.name, existing?.name),
        beneficiary: stringValue(payload.beneficiary, existing?.beneficiary),
        accountId: stringValue(payload.accountId, existing?.accountId),
        categoryId: stringValue(payload.categoryId, existing?.categoryId),
        amountMinor: safeIntegerValue(payload.amountMinor, existing?.amountMinor ?? 0),
        currency: payload.currency === "USD" ? "USD" : "CNY",
        baseAmountMinor: safeIntegerValue(payload.baseAmountMinor, existing?.baseAmountMinor ?? safeIntegerValue(payload.amountMinor)),
        exchangeRateMicros: safeIntegerValue(payload.exchangeRateMicros, existing?.exchangeRateMicros ?? 1_000_000),
        exchangeRateSource: payload.exchangeRateSource === "manual" || payload.exchangeRateSource === "frankfurter" ? payload.exchangeRateSource : "fixed",
        exchangeRateAt: stringValue(payload.exchangeRateAt, existing?.exchangeRateAt ?? change.createdAt),
        frequency: payload.frequency === "year" ? "year" : "month",
        interval: safeIntegerValue(payload.interval, existing?.interval ?? 1),
        nextChargeOn: stringValue(payload.nextChargeOn, existing?.nextChargeOn),
        anchorDay: isValidAnchorDay(payload.anchorDay) ? payload.anchorDay : existing?.anchorDay,
        remindDaysBefore: safeIntegerValue(payload.remindDaysBefore, existing?.remindDaysBefore ?? 3),
        status: payload.status === "paused" || payload.status === "cancelled" ? payload.status : "active",
        lastGeneratedPeriodKey: typeof payload.lastGeneratedPeriodKey === "string" ? payload.lastGeneratedPeriodKey : null,
        version: change.entityVersion,
        createdAt: existing?.createdAt ?? stringValue(payload.createdAt, change.createdAt),
        updatedAt: stringValue(payload.updatedAt, change.createdAt),
      } satisfies Subscription);
      applied += 1;
      continue;
    }

    if (change.entityType !== "transaction") {
      console.error("[local-db] unsupported remote entity ignored", {
        ledgerId,
        entityId: change.entityId,
        entityType: change.entityType,
      });
      continue;
    }

    const existing = (await requestResult(transactionStore.get(change.entityId))) as BookkeepingTransaction | undefined;
    if (change.operationType === "delete") {
      if (existing) {
        transactionStore.put({
          ...existing,
          version: change.entityVersion,
          deletedAt: stringValue(change.payload.deletedAt, change.createdAt),
        });
        applied += 1;
      }
      continue;
    }
    const payload = change.payload;
    const remote: BookkeepingTransaction = {
      id: change.entityId,
      operationId: existing?.operationId ?? change.operationId,
      ledgerId,
      type: payload.type === "income" ? "income" : "expense",
      amountMinor: safeIntegerValue(payload.amountMinor),
      currency: stringValue(payload.currency, "CNY"),
      baseAmountMinor: safeIntegerValue(payload.baseAmountMinor, safeIntegerValue(payload.amountMinor)),
      exchangeRateMicros: safeIntegerValue(payload.exchangeRateMicros, 1_000_000),
      exchangeRateSource: payload.exchangeRateSource === "manual" || payload.exchangeRateSource === "frankfurter" ? payload.exchangeRateSource : "fixed",
      exchangeRateAt: stringValue(payload.exchangeRateAt, change.createdAt),
      subscriptionId: typeof payload.subscriptionId === "string" ? payload.subscriptionId : null,
      subscriptionPeriodKey: typeof payload.subscriptionPeriodKey === "string" ? payload.subscriptionPeriodKey : null,
      occurredAt: stringValue(payload.occurredAt, change.createdAt),
      categoryId: stringValue(payload.categoryId),
      categoryName: stringValue(payload.categoryName),
      subcategoryId: typeof payload.subcategoryId === "string" ? payload.subcategoryId : null,
      subcategoryName: stringValue(payload.subcategoryName),
      accountId: stringValue(payload.accountId),
      accountName: stringValue(payload.accountName),
      note: stringValue(payload.note),
      images: existing?.images ?? [],
      excludeFromStats: payload.excludeFromStats === true,
      isReimbursable: existing?.isReimbursable ?? false,
      isRecurring: existing?.isRecurring ?? false,
      isPrivate: existing?.isPrivate ?? false,
      createdByUserId: stringValue(payload.createdByUserId, existing?.createdByUserId),
      createdByDisplayName: stringValue(payload.createdByDisplayName, existing?.createdByDisplayName),
      version: change.entityVersion,
      createdAt: existing?.createdAt ?? stringValue(payload.updatedAt, change.createdAt),
      deletedAt: typeof payload.deletedAt === "string" ? payload.deletedAt : null,
    };
    transactionStore.put(remote);
    applied += 1;
  }
  if (!existingTransaction) await transactionComplete(transaction);
  console.debug("[local-db] remote changes applied", { ledgerId, applied, conflicts });
  return { applied, conflicts };
}

export async function importRemoteLedgerSnapshot(
  database: IDBDatabase,
  snapshot: Record<string, unknown>,
  role: Ledger["role"],
): Promise<string> {
  const remoteLedger = recordValue(snapshot.ledger);
  const ledgerId = stringValue(remoteLedger.id);
  if (!ledgerId) throw new Error("云端账本标识缺失");
  const now = new Date().toISOString();
  const transaction = database.transaction(
    [STORE.ledgers, STORE.accounts, STORE.categories, STORE.subcategories, STORE.transactions, STORE.subscriptions, STORE.syncCursors],
    "readwrite",
  );
  transaction.objectStore(STORE.ledgers).put({
    id: ledgerId,
    name: stringValue(remoteLedger.name, "未命名账本"),
    baseCurrency: stringValue(remoteLedger.base_currency, "CNY"),
    kind: remoteLedger.kind === "family" ? "family" : "private",
    role,
    networkBound: true,
    monthlyBudgetMinor: safeIntegerValue(remoteLedger.monthly_budget_minor, DEFAULT_MONTHLY_BUDGET_MINOR),
    version: safeIntegerValue(remoteLedger.version),
    createdAt: stringValue(remoteLedger.updated_at, now),
    archivedAt: null,
  } satisfies Ledger);

  const accountStore = transaction.objectStore(STORE.accounts);
  for (const value of arrayValue(snapshot.accounts)) {
    const row = recordValue(value);
    accountStore.put({
      id: stringValue(row.id),
      ledgerId,
      name: stringValue(row.name),
      type: row.type === "bank" || row.type === "wallet" ? row.type : "cash",
      currency: stringValue(row.currency, "CNY"),
      openingBalanceMinor: safeIntegerValue(row.opening_balance_minor, 0),
      status: row.status === "inactive" ? "inactive" : "active",
      version: safeIntegerValue(row.version, 1),
      createdAt: stringValue(row.created_at, now),
    } satisfies Account);
  }
  const categoryStore = transaction.objectStore(STORE.categories);
  for (const value of arrayValue(snapshot.categories)) {
    const row = recordValue(value);
    categoryStore.put({
      id: stringValue(row.id),
      ledgerId,
      type: row.type === "income" ? "income" : "expense",
      name: stringValue(row.name),
      icon: stringValue(row.icon, "记"),
      sortOrder: safeIntegerValue(row.sort_order, 0),
      status: row.status === "inactive" ? "inactive" : "active",
      version: safeIntegerValue(row.version, 1),
    } satisfies Category);
  }
  const managerCategoryId = categoryIdForLedger(ledgerId, "category-custom");
  categoryStore.put({
    id: managerCategoryId,
    ledgerId,
    type: "expense",
    name: "自定义",
    icon: "+",
    sortOrder: 10_000,
    status: "active",
    version: 1,
  } satisfies Category);
  const subcategoryStore = transaction.objectStore(STORE.subcategories);
  for (const value of arrayValue(snapshot.subcategories)) {
    const row = recordValue(value);
    subcategoryStore.put({
      id: stringValue(row.id),
      ledgerId,
      categoryId: stringValue(row.category_id),
      name: stringValue(row.name),
      sortOrder: safeIntegerValue(row.sort_order, 0),
      status: row.status === "inactive" ? "inactive" : "active",
      version: safeIntegerValue(row.version, 1),
    } satisfies Subcategory);
  }
  const transactionStore = transaction.objectStore(STORE.transactions);
  for (const value of arrayValue(snapshot.transactions)) {
    const row = recordValue(value);
    const existing = (await requestResult(transactionStore.get(stringValue(row.id)))) as BookkeepingTransaction | undefined;
    transactionStore.put({
      id: stringValue(row.id),
      operationId: existing?.operationId ?? `snapshot-${stringValue(row.id)}`,
      ledgerId,
      type: row.type === "income" ? "income" : "expense",
      amountMinor: safeIntegerValue(row.amount_minor),
      currency: stringValue(row.currency, "CNY"),
      baseAmountMinor: safeIntegerValue(row.base_amount_minor, safeIntegerValue(row.amount_minor)),
      exchangeRateMicros: safeIntegerValue(row.exchange_rate_micros, 1_000_000),
      exchangeRateSource: row.exchange_rate_source === "manual" || row.exchange_rate_source === "frankfurter" ? row.exchange_rate_source : "fixed",
      exchangeRateAt: stringValue(row.exchange_rate_at, stringValue(row.created_at, now)),
      subscriptionId: typeof row.subscription_id === "string" ? row.subscription_id : null,
      subscriptionPeriodKey: typeof row.subscription_period_key === "string" ? row.subscription_period_key : null,
      occurredAt: stringValue(row.occurred_at, now),
      categoryId: stringValue(row.category_id),
      categoryName: stringValue(row.category_name),
      subcategoryId: typeof row.subcategory_id === "string" ? row.subcategory_id : null,
      subcategoryName: stringValue(row.subcategory_name),
      accountId: stringValue(row.account_id),
      accountName: stringValue(row.account_name),
      note: stringValue(row.note),
      images: existing?.images ?? [],
      excludeFromStats: row.exclude_from_stats === 1 || row.exclude_from_stats === true,
      isReimbursable: existing?.isReimbursable ?? false,
      isRecurring: existing?.isRecurring ?? false,
      isPrivate: existing?.isPrivate ?? false,
      createdByUserId: stringValue(row.created_by_user_id, existing?.createdByUserId),
      createdByDisplayName: stringValue(row.created_by_display_name, existing?.createdByDisplayName),
      version: safeIntegerValue(row.version, 1),
      createdAt: stringValue(row.created_at, now),
      deletedAt: typeof row.deleted_at === "string" ? row.deleted_at : null,
    } satisfies BookkeepingTransaction);
  }
  const subscriptionStore = transaction.objectStore(STORE.subscriptions);
  const remoteSubscriptionIds = new Set<string>();
  for (const value of arrayValue(snapshot.subscriptions)) {
    const row = recordValue(value);
    remoteSubscriptionIds.add(stringValue(row.id));
    subscriptionStore.put({
      id: stringValue(row.id), ledgerId, name: stringValue(row.name), beneficiary: stringValue(row.beneficiary),
      accountId: stringValue(row.account_id), categoryId: stringValue(row.category_id),
      amountMinor: safeIntegerValue(row.amount_minor), currency: row.currency === "USD" ? "USD" : "CNY",
      baseAmountMinor: safeIntegerValue(row.base_amount_minor, safeIntegerValue(row.amount_minor)),
      exchangeRateMicros: safeIntegerValue(row.exchange_rate_micros, 1_000_000),
      exchangeRateSource: row.exchange_rate_source === "manual" || row.exchange_rate_source === "frankfurter" ? row.exchange_rate_source : "fixed",
      exchangeRateAt: stringValue(row.exchange_rate_at, now), frequency: row.frequency === "year" ? "year" : "month",
      interval: safeIntegerValue(row.interval, 1), nextChargeOn: stringValue(row.next_charge_on),
      anchorDay: isValidAnchorDay(row.anchor_day) ? row.anchor_day : undefined,
      remindDaysBefore: safeIntegerValue(row.remind_days_before, 3),
      status: row.status === "paused" || row.status === "cancelled" ? row.status : "active",
      lastGeneratedPeriodKey: typeof row.last_generated_period_key === "string" ? row.last_generated_period_key : null,
      version: safeIntegerValue(row.version, 1), createdAt: stringValue(row.created_at, now), updatedAt: stringValue(row.updated_at, now),
    } satisfies Subscription);
  }
  const localTransactionRows = (await requestResult(transactionStore.index("ledgerId").getAll(ledgerId))) as BookkeepingTransaction[];
  for (const row of localTransactionRows) {
    if (remoteSubscriptionIds.has(row.id) && isLegacySubscriptionGhostTransaction(row)) {
      transactionStore.delete(row.id);
      console.debug("[local-db] snapshot removed legacy subscription ghost transaction", {
        ledgerId,
        subscriptionId: row.id,
      });
    }
  }
  for (const value of arrayValue(snapshot.attachments)) {
    const row = recordValue(value);
    const transactionId = stringValue(row.transaction_id);
    const existing = (await requestResult(transactionStore.get(transactionId))) as BookkeepingTransaction | undefined;
    if (!existing) continue;
    const attachmentId = stringValue(row.id);
    const existingImage = existing.images.find((image) => image.id === attachmentId);
    const blob = row.blob instanceof Blob ? row.blob : existingImage?.blob;
    const image: TransactionImageAttachment = {
      id: attachmentId,
      transactionId,
      name: stringValue(row.name, existingImage?.name),
      type: stringValue(row.content_type, existingImage?.type),
      size: safeIntegerValue(row.size_bytes, existingImage?.size ?? 0),
      blob,
      status: blob ? "uploaded" : "failed",
      lastError: blob ? null : "图片等待重新下载",
    };
    transactionStore.put({
      ...existing,
      images: existingImage
        ? existing.images.map((item) => item.id === attachmentId ? image : item)
        : [...existing.images, image],
    } satisfies BookkeepingTransaction);
  }
  const revision = safeIntegerValue(snapshot.revision, 0);
  transaction.objectStore(STORE.syncCursors).put({ ledgerId, revision, updatedAt: now } satisfies SyncCursor);
  await transactionComplete(transaction);
  console.debug("[local-db] remote ledger snapshot imported", { ledgerId, revision });
  return ledgerId;
}

export async function updateLocalCreatorDisplayName(
  database: IDBDatabase,
  userId: string,
  displayName: string,
): Promise<void> {
  const transaction = database.transaction(STORE.transactions, "readwrite");
  const store = transaction.objectStore(STORE.transactions);
  const rows = (await requestResult(store.getAll())) as BookkeepingTransaction[];
  for (const row of rows) {
    if (row.createdByUserId === userId) {
      store.put({ ...row, createdByDisplayName: displayName } satisfies BookkeepingTransaction);
    }
  }
  await transactionComplete(transaction);
  console.debug("[local-db] creator display name updated", { userId, transactionCount: rows.length });
}

export async function updateLocalTransactionCreators(
  database: IDBDatabase,
  creators: Array<{ transactionId: string; userId: string; displayName: string }>,
): Promise<void> {
  if (creators.length === 0) return;
  const transaction = database.transaction(STORE.transactions, "readwrite");
  const store = transaction.objectStore(STORE.transactions);
  let updated = 0;
  for (const creator of creators) {
    const row = (await requestResult(store.get(creator.transactionId))) as BookkeepingTransaction | undefined;
    if (!row) continue;
    store.put({
      ...row,
      createdByUserId: creator.userId,
      createdByDisplayName: creator.displayName,
    } satisfies BookkeepingTransaction);
    updated += 1;
  }
  await transactionComplete(transaction);
  console.debug("[local-db] transaction creators refreshed", { requested: creators.length, updated });
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function safeIntegerValue(value: unknown, fallback?: number): number {
  if (!Number.isSafeInteger(value)) {
    if (fallback !== undefined) return fallback;
    throw new Error("云端整数格式不正确");
  }
  return value as number;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
