import { authenticate, requireLedgerAccess } from "./auth";
import {
  ApiError,
  asObject,
  jsonResponse,
  logDebug,
  logError,
  optionalBoolean,
  optionalString,
  readJsonBody,
  requiredInteger,
  requiredString,
  type RequestContext,
} from "./http";
import { hashCanonicalValue } from "./security";
import { scheduleNotificationDelivery, type NotificationRuntime } from "./notification-service";

type SyncOperationType = "create" | "update" | "delete";

interface TransactionOperation {
  operationId: string;
  entityType: "ledger" | "transaction" | "category" | "subcategory" | "account" | "subscription";
  operationType: SyncOperationType;
  entityId: string;
  baseVersion: number;
  payload: Record<string, unknown>;
}

interface StoredOperationRow {
  request_hash: string;
  result_json: string;
}

interface CategoryAccountRow {
  category_id: string;
  category_name: string;
  category_type: "expense" | "income";
  account_id: string;
  account_name: string;
}

interface ExistingTransactionRow {
  id: string;
  ledger_id: string;
  version: number;
  deleted_at: string | null;
  created_by_user_id: string;
  created_by_display_name: string;
}

interface D1WriteMeta {
  changes?: number;
}

interface PullChangeRow {
  revision: number;
  entity_type: string;
  entity_id: string;
  operation_type: string;
  entity_version: number;
  payload_json: string;
  operation_id: string;
  changed_by_user_id: string;
  created_at: string;
}

// 快照里最多携带的账单数；超出时不声称快照完整，让客户端从 revision 0 起通过增量拉取补齐。
export const SNAPSHOT_TRANSACTION_LIMIT = 5000;

const ID_PATTERN = /^[A-Za-z0-9:._-]+$/u;
const ISO_CURRENCY_PATTERN = /^[A-Z]{3}$/u;

function parseOperation(value: unknown): TransactionOperation {
  const object = asObject(value);
  const entityType = requiredString(object, "entityType", { min: 1, max: 30 });
  if (!(entityType === "ledger" || entityType === "transaction" || entityType === "category" || entityType === "subcategory" || entityType === "account" || entityType === "subscription")) {
    throw new ApiError(400, "UNSUPPORTED_ENTITY", "当前不支持该实体同步");
  }
  const operationType = requiredString(object, "operationType", { min: 1, max: 10 });
  if (!(["create", "update", "delete"] as const).includes(operationType as SyncOperationType)) {
    throw new ApiError(400, "UNSUPPORTED_OPERATION", "不支持该同步操作");
  }
  return {
    operationId: requiredString(object, "operationId", { min: 16, max: 100, pattern: ID_PATTERN }),
    entityType,
    operationType: operationType as SyncOperationType,
    entityId: requiredString(object, "entityId", { min: 8, max: 120, pattern: ID_PATTERN }),
    baseVersion: requiredInteger(object, "baseVersion", { min: 0 }),
    payload: asObject(object.payload ?? {}),
  };
}

interface ValidatedTransactionPayload {
  type: "expense" | "income";
  amountMinor: number;
  currency: string;
  baseAmountMinor: number;
  exchangeRateMicros: number;
  exchangeRateSource: "fixed" | "manual" | "frankfurter";
  exchangeRateAt: string;
  subscriptionId: string | null;
  subscriptionPeriodKey: string | null;
  occurredAt: string;
  categoryId: string;
  subcategoryId: string | null;
  subcategoryName: string;
  accountId: string;
  note: string;
  excludeFromStats: boolean;
}

function validateTransactionPayload(payload: Record<string, unknown>): ValidatedTransactionPayload {
  const typeValue = requiredString(payload, "type", { min: 1, max: 10 });
  if (typeValue !== "expense" && typeValue !== "income") {
    throw new ApiError(400, "INVALID_TRANSACTION_TYPE", "账单类型不正确");
  }
  const occurredAt = requiredString(payload, "occurredAt", { min: 20, max: 35 });
  if (!Number.isFinite(Date.parse(occurredAt))) throw new ApiError(400, "INVALID_OCCURRED_AT", "账单时间不正确");
  const currency = requiredString(payload, "currency", { min: 3, max: 3, pattern: ISO_CURRENCY_PATTERN });
  if (currency !== "CNY" && currency !== "USD") throw new ApiError(400, "UNSUPPORTED_CURRENCY", "当前仅支持人民币和美元");
  const amountMinor = requiredInteger(payload, "amountMinor", { min: 1, max: 1_000_000_000_000 });
  const baseAmountMinor = payload.baseAmountMinor === undefined
    ? amountMinor
    : requiredInteger(payload, "baseAmountMinor", { min: 1, max: 1_000_000_000_000 });
  const exchangeRateMicros = payload.exchangeRateMicros === undefined
    ? 1_000_000
    : requiredInteger(payload, "exchangeRateMicros", { min: 1, max: 100_000_000 });
  const sourceValue = typeof payload.exchangeRateSource === "string" ? payload.exchangeRateSource : "fixed";
  if (sourceValue !== "fixed" && sourceValue !== "manual" && sourceValue !== "frankfurter") throw new ApiError(400, "INVALID_EXCHANGE_RATE_SOURCE", "汇率来源不正确");
  const exchangeRateAtValue = typeof payload.exchangeRateAt === "string" ? payload.exchangeRateAt : occurredAt;
  if (!Number.isFinite(Date.parse(exchangeRateAtValue))) throw new ApiError(400, "INVALID_EXCHANGE_RATE_AT", "汇率时间不正确");
  const subcategoryValue = payload.subcategoryId;
  if (subcategoryValue !== undefined && subcategoryValue !== null && typeof subcategoryValue !== "string") {
    throw new ApiError(400, "INVALID_FIELD", "subcategoryId 格式不正确");
  }
  return {
    type: typeValue,
    amountMinor,
    currency,
    baseAmountMinor,
    exchangeRateMicros,
    exchangeRateSource: sourceValue,
    exchangeRateAt: new Date(exchangeRateAtValue).toISOString(),
    subscriptionId: typeof payload.subscriptionId === "string" ? payload.subscriptionId : null,
    subscriptionPeriodKey: typeof payload.subscriptionPeriodKey === "string" ? payload.subscriptionPeriodKey : null,
    occurredAt: new Date(occurredAt).toISOString(),
    categoryId: requiredString(payload, "categoryId", { min: 8, max: 120, pattern: ID_PATTERN }),
    subcategoryId: typeof subcategoryValue === "string" && subcategoryValue ? subcategoryValue : null,
    subcategoryName: optionalString(payload, "subcategoryName", 20),
    accountId: requiredString(payload, "accountId", { min: 8, max: 120, pattern: ID_PATTERN }),
    note: optionalString(payload, "note", 150),
    excludeFromStats: optionalBoolean(payload, "excludeFromStats"),
  };
}

export async function selectLedger(
  request: Request,
  database: D1Database,
  context: RequestContext,
  ledgerId: string,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  await requireLedgerAccess(database, user.userId, ledgerId, "viewer");
  await database.prepare(
    "UPDATE devices SET last_selected_ledger_id = ?1, last_seen_at = ?2 WHERE id = ?3 AND user_id = ?4",
  ).bind(ledgerId, context.now, user.deviceId, user.userId).run();
  return jsonResponse({ selectedLedgerId: ledgerId }, context);
}

export async function ledgerSnapshot(
  request: Request,
  database: D1Database,
  context: RequestContext,
  ledgerId: string,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  await requireLedgerAccess(database, user.userId, ledgerId, "viewer");
  const [ledger, accounts, categories, subcategories, transactions, subscriptions, attachments, revision] = await database.batch([
    database.prepare("SELECT id, name, kind, base_currency, monthly_budget_minor, version, updated_at FROM ledgers WHERE id = ?1").bind(ledgerId),
    database.prepare("SELECT * FROM accounts WHERE ledger_id = ?1 ORDER BY created_at").bind(ledgerId),
    database.prepare("SELECT * FROM categories WHERE ledger_id = ?1 ORDER BY type, sort_order").bind(ledgerId),
    database.prepare("SELECT * FROM subcategories WHERE ledger_id = ?1 ORDER BY category_id, sort_order").bind(ledgerId),
    database.prepare(
      `SELECT t.*, creator.display_name AS created_by_display_name
       FROM transactions t JOIN users creator ON creator.id = t.created_by_user_id
       WHERE t.ledger_id = ?1 ORDER BY t.occurred_at DESC LIMIT ?2`,
    ).bind(ledgerId, SNAPSHOT_TRANSACTION_LIMIT + 1),
    database.prepare("SELECT * FROM recurring_subscriptions WHERE ledger_id = ?1 ORDER BY next_charge_on").bind(ledgerId),
    database.prepare(
      `SELECT id, ledger_id, transaction_id, name, content_type, size_bytes, sha256, created_at
       FROM transaction_attachments WHERE ledger_id = ?1 ORDER BY created_at`,
    ).bind(ledgerId),
    database.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM sync_changes WHERE ledger_id = ?1").bind(ledgerId),
  ]);
  const truncated = transactions.results.length > SNAPSHOT_TRANSACTION_LIMIT;
  const transactionRows = truncated ? transactions.results.slice(0, SNAPSHOT_TRANSACTION_LIMIT) : transactions.results;
  // 快照被截断时把 revision 置 0：客户端会以它作为同步游标，从头回放变更即可补全更早的账单。
  const revisionValue = truncated
    ? 0
    : (revision.results[0] as { revision?: number } | undefined)?.revision ?? 0;
  logDebug(context, "sync.snapshot.read", { userId: user.userId, ledgerId, revision: revisionValue, truncated });
  return jsonResponse({
    ledger: ledger.results[0] ?? null,
    accounts: accounts.results,
    categories: categories.results,
    subcategories: subcategories.results,
    transactions: transactionRows,
    truncated,
    subscriptions: subscriptions.results,
    attachments: attachments.results,
    revision: revisionValue,
  }, context);
}

export async function transactionCreators(
  request: Request,
  database: D1Database,
  context: RequestContext,
  ledgerId: string,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  await requireLedgerAccess(database, user.userId, ledgerId, "viewer");
  const rows = await database.prepare(
    `SELECT t.id AS transaction_id, t.created_by_user_id AS user_id, creator.display_name
     FROM transactions t JOIN users creator ON creator.id = t.created_by_user_id
     WHERE t.ledger_id = ?1`,
  ).bind(ledgerId).all<{ transaction_id: string; user_id: string; display_name: string }>();
  logDebug(context, "sync.transaction-creators.read", { userId: user.userId, ledgerId, count: rows.results.length });
  return jsonResponse({
    creators: rows.results.map((row) => ({
      transactionId: row.transaction_id,
      userId: row.user_id,
      displayName: row.display_name,
    })),
  }, context);
}

export async function pullChanges(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  const url = new URL(request.url);
  const ledgerId = url.searchParams.get("ledger_id") ?? "";
  if (!ID_PATTERN.test(ledgerId)) throw new ApiError(400, "INVALID_LEDGER_ID", "账本标识不正确");
  const afterRevision = parseSafeQueryInteger(url.searchParams.get("after_revision"), 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = parseSafeQueryInteger(url.searchParams.get("limit"), 1, 200, 100);
  await requireLedgerAccess(database, user.userId, ledgerId, "viewer");
  const rows = await database.prepare(
    `SELECT revision, entity_type, entity_id, operation_type, entity_version, payload_json,
            operation_id, changed_by_user_id, created_at
     FROM sync_changes
     WHERE ledger_id = ?1 AND revision > ?2
     ORDER BY revision ASC LIMIT ?3`,
  ).bind(ledgerId, afterRevision, limit + 1).all<PullChangeRow>();
  const hasMore = rows.results.length > limit;
  const selected = rows.results.slice(0, limit);
  const changes = selected.map((row) => ({
    revision: row.revision,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operationType: row.operation_type,
    entityVersion: row.entity_version,
    payload: JSON.parse(row.payload_json) as unknown,
    operationId: row.operation_id,
    changedByUserId: row.changed_by_user_id,
    createdAt: row.created_at,
  }));
  return jsonResponse({
    ledgerId,
    changes,
    nextRevision: selected.at(-1)?.revision ?? afterRevision,
    hasMore,
  }, context);
}

export async function pushOperations(
  request: Request,
  database: D1Database,
  context: RequestContext,
  notificationRuntime?: NotificationRuntime,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  const object = asObject(await readJsonBody(request));
  const ledgerId = requiredString(object, "ledgerId", { min: 8, max: 120, pattern: ID_PATTERN });
  const deviceId = requiredString(object, "deviceId", { min: 8, max: 80, pattern: ID_PATTERN });
  if (deviceId !== user.deviceId) throw new ApiError(403, "DEVICE_MISMATCH", "同步设备与当前会话不一致");
  const access = await requireLedgerAccess(database, user.userId, ledgerId, "member");
  if (!Array.isArray(object.operations) || object.operations.length < 1 || object.operations.length > 50) {
    throw new ApiError(400, "INVALID_OPERATIONS", "每次需提交 1-50 个同步操作");
  }

  const results: Array<Record<string, unknown>> = [];
  for (const value of object.operations) {
    let operationId = "unknown";
    try {
      const operation = parseOperation(value);
      operationId = operation.operationId;
      if (operation.entityType !== "transaction" && operation.entityType !== "subscription" && access.role !== "owner" && access.role !== "admin") {
        throw new ApiError(403, "LEDGER_SETTINGS_WRITE_DENIED", "只有账本所有者或管理员可以修改账本设置、分类和账户");
      }
      results.push(await applySyncOperation(
        database,
        user,
        ledgerId,
        operation,
        context,
        access.kind === "family",
        notificationRuntime,
      ));
    } catch (error) {
      const apiError = error instanceof ApiError
        ? error
        : new ApiError(500, "OPERATION_FAILED", "同步操作执行失败");
      logError(context, "sync.operation.failed", apiError.message, {
        operationId,
        ledgerId,
        code: apiError.code,
        status: apiError.status,
      });
      results.push({
        operationId,
        status: apiError.status === 409 ? "conflict" : "failed",
        retryable: apiError.status >= 500,
        error: { code: apiError.code, message: apiError.message, details: apiError.details ?? null },
      });
    }
  }
  const revision = await database.prepare(
    "SELECT COALESCE(MAX(revision), 0) AS revision FROM sync_changes WHERE ledger_id = ?1",
  ).bind(ledgerId).first<{ revision: number }>();
  logDebug(context, "sync.push.completed", {
    userId: user.userId,
    ledgerId,
    operationCount: results.length,
    failedCount: results.filter((result) => result.status === "failed" || result.status === "conflict").length,
  });
  return jsonResponse({ ledgerId, results, revision: revision?.revision ?? 0 }, context);
}

async function applySyncOperation(
  database: D1Database,
  user: { userId: string; deviceId: string; displayName: string },
  ledgerId: string,
  operation: TransactionOperation,
  context: RequestContext,
  shouldNotifyMembers: boolean,
  notificationRuntime?: NotificationRuntime,
): Promise<Record<string, unknown>> {
  const requestHash = await hashCanonicalValue({ ledgerId, ...operation });
  const existing = await database.prepare(
    "SELECT request_hash, result_json FROM sync_operations WHERE operation_id = ?1",
  ).bind(operation.operationId).first<StoredOperationRow>();
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "operationId 已用于其他请求");
    }
    return { ...(JSON.parse(existing.result_json) as Record<string, unknown>), replayed: true };
  }

  if (operation.entityType === "ledger") {
    return updateLedgerSettings(database, user, ledgerId, operation, requestHash, context);
  }

  if (operation.entityType === "subscription") {
    return applySubscriptionOperation(database, user, ledgerId, operation, requestHash, context);
  }

  if (operation.entityType !== "transaction") {
    return applyCatalogOperation(database, user, ledgerId, operation, requestHash, context);
  }

  if (operation.operationType === "create") {
    if (operation.baseVersion !== 0) throw new ApiError(409, "VERSION_CONFLICT", "新建账单的 baseVersion 必须为 0");
    return createTransaction(
      database,
      user,
      ledgerId,
      operation,
      requestHash,
      context,
      shouldNotifyMembers,
      notificationRuntime,
    );
  }
  return mutateTransaction(database, user, ledgerId, operation, requestHash, context);
}

export async function readSyncEntity(request: Request, database: D1Database, context: RequestContext): Promise<Response> {
  const user = await authenticate(request, database, context);
  const parameters = new URL(request.url).searchParams;
  const ledgerId = parameters.get("ledger_id") ?? "";
  const entityId = parameters.get("entity_id") ?? "";
  const entityType = parameters.get("entity_type") ?? "";
  await requireLedgerAccess(database, user.userId, ledgerId, "viewer");
  const tables: Record<string, string> = { ledger: "ledgers", transaction: "transactions", category: "categories", subcategory: "subcategories", account: "accounts", subscription: "recurring_subscriptions" };
  const table = Object.hasOwn(tables, entityType) ? tables[entityType] : undefined;
  if (!table || !entityId) throw new ApiError(400, "INVALID_ENTITY", "同步项目不正确");
  const row = entityType === "transaction"
    ? await database.prepare(`SELECT t.*, c.name AS category_name, a.name AS account_name, u.display_name AS created_by_display_name
        FROM transactions t JOIN categories c ON c.id = t.category_id JOIN accounts a ON a.id = t.account_id
        JOIN users u ON u.id = t.created_by_user_id WHERE t.id = ?1 AND t.ledger_id = ?2`).bind(entityId, ledgerId).first<Record<string, unknown>>()
    : await database.prepare(`SELECT * FROM ${table} WHERE id = ?1 AND ${entityType === "ledger" ? "id" : "ledger_id"} = ?2`).bind(entityId, ledgerId).first<Record<string, unknown>>();
  if (!row) return jsonResponse({ change: null }, context);
  const payload = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/gu, (_, character: string) => character.toUpperCase()), value]));
  if (entityType === "transaction") payload.excludeFromStats = row.exclude_from_stats === 1;
  const deleted = Boolean(row.deleted_at) || row.status === "inactive";
  return jsonResponse({ change: {
    revision: 0, entityType, entityId, entityVersion: row.version, operationType: deleted ? "delete" : "update", payload,
    operationId: `comparison-${context.requestId}`, changedByUserId: user.userId, createdAt: row.updated_at ?? context.now,
  } }, context);
}

async function updateLedgerSettings(
  database: D1Database,
  user: { userId: string; deviceId: string },
  ledgerId: string,
  operation: TransactionOperation,
  requestHash: string,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  if (operation.operationType !== "update" || operation.entityId !== ledgerId) {
    throw new ApiError(400, "INVALID_LEDGER_OPERATION", "账本设置仅支持更新当前账本");
  }
  const monthlyBudgetMinor = requiredInteger(operation.payload, "monthlyBudgetMinor", {
    min: 1,
    max: 1_000_000_000_000,
  });
  const existing = await database.prepare(
    "SELECT id, name, kind, base_currency, version FROM ledgers WHERE id = ?1 AND archived_at IS NULL",
  ).bind(ledgerId).first<{ id: string; name: string; kind: string; base_currency: string; version: number }>();
  if (!existing) throw new ApiError(404, "LEDGER_NOT_FOUND", "账本不存在");
  if (existing.version !== operation.baseVersion) {
    throw new ApiError(409, "VERSION_CONFLICT", "账本设置已在其他设备更新，请同步后重试", {
      currentVersion: existing.version,
    });
  }
  const nextVersion = existing.version + 1;
  const entity = {
    id: ledgerId,
    ledgerId,
    name: existing.name,
    kind: existing.kind,
    baseCurrency: existing.base_currency,
    monthlyBudgetMinor,
    version: nextVersion,
    updatedAt: context.now,
  };
  const result = { operationId: operation.operationId, status: "applied", entity, replayed: false };
  try {
    const batch = await database.batch([
      database.prepare(
        "UPDATE ledgers SET monthly_budget_minor = ?1, version = ?2, updated_at = ?3 WHERE id = ?4 AND version = ?5",
      ).bind(monthlyBudgetMinor, nextVersion, context.now, ledgerId, operation.baseVersion),
      conditionalOperationInsert(database, user, ledgerId, operation, requestHash, result, nextVersion, context.now),
      conditionalChangeInsert(database, user.userId, ledgerId, operation, nextVersion, entity, "ledgers", context.now),
    ]);
    const updateMeta = batch[0].meta as D1WriteMeta;
    if (updateMeta.changes !== 1) throw new ApiError(409, "VERSION_CONFLICT", "账本设置已在其他设备更新，请同步后重试");
  } catch (error) {
    if (error instanceof Error && /constraint|unique/iu.test(error.message)) {
      const replay = await database.prepare(
        "SELECT request_hash, result_json FROM sync_operations WHERE operation_id = ?1",
      ).bind(operation.operationId).first<StoredOperationRow>();
      if (replay) {
        if (replay.request_hash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "operationId 已用于其他请求");
        return { ...(JSON.parse(replay.result_json) as Record<string, unknown>), replayed: true };
      }
    }
    throw error;
  }
  logDebug(context, "sync.ledger-settings.updated", { ledgerId, monthlyBudgetMinor, version: nextVersion });
  return result;
}

async function createTransaction(
  database: D1Database,
  user: { userId: string; deviceId: string; displayName: string },
  ledgerId: string,
  operation: TransactionOperation,
  requestHash: string,
  context: RequestContext,
  shouldNotifyMembers: boolean,
  notificationRuntime?: NotificationRuntime,
): Promise<Record<string, unknown>> {
  const payload = validateTransactionPayload(operation.payload);
  const names = await validateCategoryAndAccount(database, ledgerId, payload);
  const entity = transactionResult(
    operation.entityId, ledgerId, payload, names, user.userId, user.displayName, user.userId, 1, null, context.now,
  );
  const result = { operationId: operation.operationId, status: "applied", entity, replayed: false };
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO transactions
         (id, ledger_id, type, amount_minor, currency, base_amount_minor, exchange_rate_micros,
          exchange_rate_source, exchange_rate_at, subscription_id, subscription_period_key, occurred_at, category_id, category_name,
          subcategory_id, subcategory_name, account_id, account_name, note, exclude_from_stats,
          created_by_user_id, updated_by_user_id, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?21, 1, ?22, ?22)`,
      ).bind(
        operation.entityId, ledgerId, payload.type, payload.amountMinor, payload.currency, payload.baseAmountMinor,
        payload.exchangeRateMicros, payload.exchangeRateSource, payload.exchangeRateAt, payload.subscriptionId,
        payload.subscriptionPeriodKey, payload.occurredAt, payload.categoryId, names.category_name,
        payload.subcategoryId, payload.subcategoryName, payload.accountId, names.account_name, payload.note,
        payload.excludeFromStats ? 1 : 0, user.userId, context.now,
      ),
      operationInsert(database, user, ledgerId, operation, requestHash, result, context.now),
      changeInsert(database, user.userId, ledgerId, operation, 1, entity, context.now),
      ...(shouldNotifyMembers ? [database.prepare(
        `INSERT INTO notification_events
           (id, ledger_id, transaction_id, actor_user_id, title, body, target_url, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8)`,
      ).bind(
        operation.operationId,
        ledgerId,
        operation.entityId,
        user.userId,
        "家庭账本有新账目",
        `${user.displayName}新增了一笔${payload.type === "expense" ? "支出" : "收入"} · ${names.category_name}`,
        `/?ledger=${encodeURIComponent(ledgerId)}&transaction=${encodeURIComponent(operation.entityId)}`,
        context.now,
      )] : []),
    ]);
  } catch (error) {
    if (error instanceof Error && /constraint|unique/iu.test(error.message)) {
      const replay = await database.prepare(
        "SELECT request_hash, result_json FROM sync_operations WHERE operation_id = ?1",
      ).bind(operation.operationId).first<StoredOperationRow>();
      if (replay) {
        if (replay.request_hash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "operationId 已用于其他请求");
        return { ...(JSON.parse(replay.result_json) as Record<string, unknown>), replayed: true };
      }
      throw new ApiError(409, "ENTITY_ALREADY_EXISTS", "账单标识已经存在");
    }
    throw error;
  }
  if (shouldNotifyMembers) {
    scheduleNotificationDelivery(notificationRuntime, context, operation.operationId);
    logDebug(context, "notification.event.created", {
      eventId: operation.operationId,
      ledgerId,
      transactionId: operation.entityId,
    });
  }
  return result;
}

async function mutateTransaction(
  database: D1Database,
  user: { userId: string; deviceId: string; displayName: string },
  ledgerId: string,
  operation: TransactionOperation,
  requestHash: string,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  const existing = await database.prepare(
    `SELECT t.id, t.ledger_id, t.version, t.deleted_at, t.created_by_user_id,
            creator.display_name AS created_by_display_name
     FROM transactions t JOIN users creator ON creator.id = t.created_by_user_id
     WHERE t.id = ?1 AND t.ledger_id = ?2`,
  ).bind(operation.entityId, ledgerId).first<ExistingTransactionRow>();
  if (!existing) throw new ApiError(404, "TRANSACTION_NOT_FOUND", "账单不存在");
  if (existing.version !== operation.baseVersion) {
    throw new ApiError(409, "VERSION_CONFLICT", "账单已在其他设备修改", { serverVersion: existing.version });
  }
  const nextVersion = existing.version + 1;
  let entity: Record<string, unknown>;
  let update: D1PreparedStatement;
  if (operation.operationType === "delete") {
    entity = {
      id: operation.entityId,
      ledgerId,
      createdByUserId: existing.created_by_user_id,
      createdByDisplayName: existing.created_by_display_name,
      version: nextVersion,
      deletedAt: context.now,
    };
    update = database.prepare(
      "UPDATE transactions SET deleted_at = ?1, updated_by_user_id = ?2, version = ?3, updated_at = ?1 WHERE id = ?4 AND ledger_id = ?5 AND version = ?6",
    ).bind(context.now, user.userId, nextVersion, operation.entityId, ledgerId, operation.baseVersion);
  } else {
    const payload = validateTransactionPayload(operation.payload);
    const names = await validateCategoryAndAccount(database, ledgerId, payload);
    entity = transactionResult(
      operation.entityId,
      ledgerId,
      payload,
      names,
      existing.created_by_user_id,
      existing.created_by_display_name,
      user.userId,
      nextVersion,
      null,
      context.now,
    );
    update = database.prepare(
      `UPDATE transactions SET type = ?1, amount_minor = ?2, currency = ?3, base_amount_minor = ?4,
       exchange_rate_micros = ?5, exchange_rate_source = ?6, exchange_rate_at = ?7,
       subscription_id = ?8, subscription_period_key = ?9, occurred_at = ?10,
       category_id = ?11, category_name = ?12, subcategory_id = ?13, subcategory_name = ?14,
       account_id = ?15, account_name = ?16, note = ?17, exclude_from_stats = ?18,
       updated_by_user_id = ?19, version = ?20, updated_at = ?21
       WHERE id = ?22 AND ledger_id = ?23 AND version = ?24 AND deleted_at IS NULL`,
    ).bind(
      payload.type, payload.amountMinor, payload.currency, payload.baseAmountMinor, payload.exchangeRateMicros,
      payload.exchangeRateSource, payload.exchangeRateAt, payload.subscriptionId, payload.subscriptionPeriodKey,
      payload.occurredAt, payload.categoryId, names.category_name, payload.subcategoryId, payload.subcategoryName,
      payload.accountId, names.account_name, payload.note, payload.excludeFromStats ? 1 : 0,
      user.userId, nextVersion, context.now, operation.entityId, ledgerId, operation.baseVersion,
    );
  }
  const result = { operationId: operation.operationId, status: "applied", entity, replayed: false };
  const [updateResult] = await database.batch([
    update,
    database.prepare(
      `INSERT INTO sync_operations
       (operation_id, user_id, device_id, ledger_id, request_hash, entity_type, entity_id, operation_type, result_json, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, 'transaction', ?6, ?7, ?8, ?9
       WHERE EXISTS (SELECT 1 FROM transactions WHERE id = ?6 AND ledger_id = ?4 AND version = ?10)`,
    ).bind(
      operation.operationId, user.userId, user.deviceId, ledgerId, requestHash,
      operation.entityId, operation.operationType, JSON.stringify(result), context.now, nextVersion,
    ),
    database.prepare(
      `INSERT INTO sync_changes
       (ledger_id, entity_type, entity_id, operation_type, entity_version, payload_json, changed_by_user_id, operation_id, created_at)
       SELECT ?1, 'transaction', ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE EXISTS (SELECT 1 FROM transactions WHERE id = ?2 AND ledger_id = ?1 AND version = ?4)`,
    ).bind(
      ledgerId, operation.entityId, operation.operationType, nextVersion,
      JSON.stringify(entity), user.userId, operation.operationId, context.now,
    ),
  ]);
  if (((updateResult.meta as D1WriteMeta).changes ?? 0) !== 1) {
    const server = await database.prepare("SELECT version FROM transactions WHERE id = ?1 AND ledger_id = ?2")
      .bind(operation.entityId, ledgerId).first<{ version: number }>();
    throw new ApiError(409, "VERSION_CONFLICT", "账单已在其他设备修改", { serverVersion: server?.version ?? null });
  }
  return result;
}

interface ValidatedSubscriptionPayload {
  name: string;
  beneficiary: string;
  accountId: string;
  categoryId: string;
  amountMinor: number;
  currency: "CNY" | "USD";
  baseAmountMinor: number;
  exchangeRateMicros: number;
  exchangeRateSource: "fixed" | "manual" | "frankfurter";
  exchangeRateAt: string;
  frequency: "month" | "year";
  interval: number;
  nextChargeOn: string;
  anchorDay: number;
  remindDaysBefore: number;
  status: "active" | "paused" | "cancelled";
  lastGeneratedPeriodKey: string | null;
}

function validateSubscriptionPayload(payload: Record<string, unknown>): ValidatedSubscriptionPayload {
  const currency = requiredString(payload, "currency", { min: 3, max: 3 });
  const source = requiredString(payload, "exchangeRateSource", { min: 3, max: 20 });
  const frequency = requiredString(payload, "frequency", { min: 4, max: 5 });
  const status = requiredString(payload, "status", { min: 6, max: 9 });
  const exchangeRateAt = requiredString(payload, "exchangeRateAt", { min: 20, max: 35 });
  const nextChargeOn = requiredString(payload, "nextChargeOn", { min: 10, max: 10 });
  if (currency !== "CNY" && currency !== "USD") throw new ApiError(400, "UNSUPPORTED_CURRENCY", "当前仅支持人民币和美元");
  if (source !== "fixed" && source !== "manual" && source !== "frankfurter") throw new ApiError(400, "INVALID_EXCHANGE_RATE_SOURCE", "汇率来源不正确");
  if (frequency !== "month" && frequency !== "year") throw new ApiError(400, "INVALID_SUBSCRIPTION_FREQUENCY", "订阅周期不正确");
  if (status !== "active" && status !== "paused" && status !== "cancelled") throw new ApiError(400, "INVALID_SUBSCRIPTION_STATUS", "订阅状态不正确");
  if (!Number.isFinite(Date.parse(exchangeRateAt)) || !/^\d{4}-\d{2}-\d{2}$/u.test(nextChargeOn)) throw new ApiError(400, "INVALID_SUBSCRIPTION_DATE", "订阅日期不正确");
  return {
    name: requiredString(payload, "name", { min: 1, max: 40 }),
    beneficiary: optionalString(payload, "beneficiary", 20),
    accountId: requiredString(payload, "accountId", { min: 8, max: 120, pattern: ID_PATTERN }),
    categoryId: requiredString(payload, "categoryId", { min: 8, max: 120, pattern: ID_PATTERN }),
    amountMinor: requiredInteger(payload, "amountMinor", { min: 1, max: 1_000_000_000_000 }),
    currency,
    baseAmountMinor: requiredInteger(payload, "baseAmountMinor", { min: 1, max: 1_000_000_000_000 }),
    exchangeRateMicros: requiredInteger(payload, "exchangeRateMicros", { min: 1, max: 100_000_000 }),
    exchangeRateSource: source,
    exchangeRateAt: new Date(exchangeRateAt).toISOString(),
    frequency,
    interval: requiredInteger(payload, "interval", { min: 1, max: 24 }),
    nextChargeOn,
    // 旧客户端不会上传 anchorDay，此时以下次扣费日的日作为锚点。
    anchorDay: payload.anchorDay === undefined || payload.anchorDay === null
      ? Number(nextChargeOn.slice(8, 10))
      : requiredInteger(payload, "anchorDay", { min: 1, max: 31 }),
    remindDaysBefore: requiredInteger(payload, "remindDaysBefore", { min: 0, max: 90 }),
    status,
    lastGeneratedPeriodKey: typeof payload.lastGeneratedPeriodKey === "string" ? payload.lastGeneratedPeriodKey : null,
  };
}

function subscriptionResult(id: string, ledgerId: string, payload: ValidatedSubscriptionPayload, version: number, createdAt: string, updatedAt: string): Record<string, unknown> {
  return { id, ledgerId, ...payload, version, createdAt, updatedAt };
}

async function applySubscriptionOperation(
  database: D1Database,
  user: { userId: string; deviceId: string },
  ledgerId: string,
  operation: TransactionOperation,
  requestHash: string,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  const payload = validateSubscriptionPayload(operation.payload);
  await validateCategoryAndAccount(database, ledgerId, {
    type: "expense", amountMinor: payload.amountMinor, currency: payload.currency,
    baseAmountMinor: payload.baseAmountMinor, exchangeRateMicros: payload.exchangeRateMicros,
    exchangeRateSource: payload.exchangeRateSource, exchangeRateAt: payload.exchangeRateAt,
    subscriptionId: null, subscriptionPeriodKey: null, occurredAt: context.now,
    categoryId: payload.categoryId, subcategoryId: null, subcategoryName: "", accountId: payload.accountId,
    note: "", excludeFromStats: false,
  });
  const existing = await database.prepare("SELECT version, created_at FROM recurring_subscriptions WHERE id = ?1 AND ledger_id = ?2")
    .bind(operation.entityId, ledgerId).first<{ version: number; created_at: string }>();
  if (operation.operationType === "create") {
    if (existing || operation.baseVersion !== 0) throw new ApiError(409, "VERSION_CONFLICT", "订阅已经存在");
    const entity = subscriptionResult(operation.entityId, ledgerId, payload, 1, context.now, context.now);
    const result = { operationId: operation.operationId, status: "applied", entity, replayed: false };
    await database.batch([
      database.prepare(
        `INSERT INTO recurring_subscriptions
         (id, ledger_id, name, beneficiary, account_id, category_id, amount_minor, currency,
          base_amount_minor, exchange_rate_micros, exchange_rate_source, exchange_rate_at,
          frequency, interval, next_charge_on, anchor_day, remind_days_before, status, last_generated_period_key,
          version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 1, ?20, ?20)`,
      ).bind(operation.entityId, ledgerId, payload.name, payload.beneficiary, payload.accountId, payload.categoryId,
        payload.amountMinor, payload.currency, payload.baseAmountMinor, payload.exchangeRateMicros, payload.exchangeRateSource,
        payload.exchangeRateAt, payload.frequency, payload.interval, payload.nextChargeOn, payload.anchorDay,
        payload.remindDaysBefore, payload.status, payload.lastGeneratedPeriodKey, context.now),
      operationInsert(database, user, ledgerId, operation, requestHash, result, context.now),
      changeInsert(database, user.userId, ledgerId, operation, 1, entity, context.now),
    ]);
    return result;
  }
  if (!existing) throw new ApiError(404, "SUBSCRIPTION_NOT_FOUND", "订阅不存在");
  if (existing.version !== operation.baseVersion) throw new ApiError(409, "VERSION_CONFLICT", "订阅已在其他设备修改", { serverVersion: existing.version });
  const nextVersion = existing.version + 1;
  const entity = subscriptionResult(operation.entityId, ledgerId, payload, nextVersion, existing.created_at, context.now);
  const result = { operationId: operation.operationId, status: "applied", entity, replayed: false };
  const [updated] = await database.batch([
    database.prepare(
      `UPDATE recurring_subscriptions SET name=?1, beneficiary=?2, account_id=?3, category_id=?4,
       amount_minor=?5, currency=?6, base_amount_minor=?7, exchange_rate_micros=?8,
       exchange_rate_source=?9, exchange_rate_at=?10, frequency=?11, interval=?12,
       next_charge_on=?13, anchor_day=?14, remind_days_before=?15, status=?16, last_generated_period_key=?17,
       version=?18, updated_at=?19 WHERE id=?20 AND ledger_id=?21 AND version=?22`,
    ).bind(payload.name, payload.beneficiary, payload.accountId, payload.categoryId, payload.amountMinor, payload.currency,
      payload.baseAmountMinor, payload.exchangeRateMicros, payload.exchangeRateSource, payload.exchangeRateAt,
      payload.frequency, payload.interval, payload.nextChargeOn, payload.anchorDay, payload.remindDaysBefore,
      payload.status, payload.lastGeneratedPeriodKey, nextVersion, context.now, operation.entityId, ledgerId, operation.baseVersion),
    database.prepare(
      `INSERT INTO sync_operations (operation_id,user_id,device_id,ledger_id,request_hash,entity_type,entity_id,operation_type,result_json,created_at)
       SELECT ?1,?2,?3,?4,?5,'subscription',?6,?7,?8,?9 WHERE EXISTS
       (SELECT 1 FROM recurring_subscriptions WHERE id=?6 AND ledger_id=?4 AND version=?10)`,
    ).bind(operation.operationId, user.userId, user.deviceId, ledgerId, requestHash, operation.entityId, operation.operationType, JSON.stringify(result), context.now, nextVersion),
    database.prepare(
      `INSERT INTO sync_changes (ledger_id,entity_type,entity_id,operation_type,entity_version,payload_json,changed_by_user_id,operation_id,created_at)
       SELECT ?1,'subscription',?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS
       (SELECT 1 FROM recurring_subscriptions WHERE id=?2 AND ledger_id=?1 AND version=?4)`,
    ).bind(ledgerId, operation.entityId, operation.operationType, nextVersion, JSON.stringify(entity), user.userId, operation.operationId, context.now),
  ]);
  if (((updated.meta as D1WriteMeta).changes ?? 0) !== 1) throw new ApiError(409, "VERSION_CONFLICT", "订阅已在其他设备修改");
  return result;
}

interface ExistingCatalogRow {
  id: string;
  version: number;
}

interface ValidatedCategoryPayload {
  type: "expense" | "income";
  name: string;
  icon: string;
  sortOrder: number;
}

interface ValidatedSubcategoryPayload {
  categoryId: string;
  name: string;
  sortOrder: number;
}

interface ValidatedAccountPayload {
  name: string;
  type: "cash" | "bank" | "wallet";
  currency: string;
  openingBalanceMinor: number;
}

async function applyCatalogOperation(
  database: D1Database,
  user: { userId: string; deviceId: string },
  ledgerId: string,
  operation: TransactionOperation,
  requestHash: string,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  if (operation.operationType === "create") {
    if (operation.baseVersion !== 0) throw new ApiError(409, "VERSION_CONFLICT", "新建分类的 baseVersion 必须为 0");
    return createCatalogEntity(database, user, ledgerId, operation, requestHash, context);
  }
  return mutateCatalogEntity(database, user, ledgerId, operation, requestHash, context);
}

async function createCatalogEntity(
  database: D1Database,
  user: { userId: string; deviceId: string },
  ledgerId: string,
  operation: TransactionOperation,
  requestHash: string,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  const isCategory = operation.entityType === "category";
  const isSubcategory = operation.entityType === "subcategory";
  const payload = isCategory
    ? validateCategoryPayload(operation.payload)
    : isSubcategory
      ? validateSubcategoryPayload(operation.payload)
      : validateAccountPayload(operation.payload);
  if (isSubcategory) await requireActiveCategory(database, ledgerId, (payload as ValidatedSubcategoryPayload).categoryId);
  const entity = catalogResult(operation.entityId, ledgerId, operation.entityType, payload, 1, "active", context.now);
  const insert = isCategory
    ? database.prepare(
      `INSERT INTO categories
       (id, ledger_id, type, name, icon, sort_order, status, version, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 1, ?7, ?7)`,
    ).bind(
      operation.entityId,
      ledgerId,
      (payload as ValidatedCategoryPayload).type,
      payload.name,
      (payload as ValidatedCategoryPayload).icon,
      (payload as ValidatedCategoryPayload).sortOrder,
      context.now,
    )
    : isSubcategory
      ? database.prepare(
      `INSERT INTO subcategories
       (id, ledger_id, category_id, name, sort_order, status, version, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'active', 1, ?6, ?6)`,
    ).bind(
      operation.entityId,
      ledgerId,
      (payload as ValidatedSubcategoryPayload).categoryId,
      payload.name,
      (payload as ValidatedSubcategoryPayload).sortOrder,
      context.now,
    )
      : database.prepare(
        `INSERT INTO accounts
         (id, ledger_id, name, type, currency, opening_balance_minor, status, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 1, ?7, ?7)`,
      ).bind(
        operation.entityId,
        ledgerId,
        payload.name,
        (payload as ValidatedAccountPayload).type,
        (payload as ValidatedAccountPayload).currency,
        (payload as ValidatedAccountPayload).openingBalanceMinor,
        context.now,
      );
  const result = { operationId: operation.operationId, status: "applied", entity, replayed: false };
  try {
    await database.batch([
      insert,
      operationInsert(database, user, ledgerId, operation, requestHash, result, context.now),
      changeInsert(database, user.userId, ledgerId, operation, 1, entity, context.now),
    ]);
  } catch (error) {
    if (error instanceof Error && /constraint|unique/iu.test(error.message)) {
      const replay = await database.prepare(
        "SELECT request_hash, result_json FROM sync_operations WHERE operation_id = ?1",
      ).bind(operation.operationId).first<StoredOperationRow>();
      if (replay) {
        if (replay.request_hash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "operationId 已用于其他请求");
        return { ...(JSON.parse(replay.result_json) as Record<string, unknown>), replayed: true };
      }
      throw new ApiError(409, "CATALOG_ALREADY_EXISTS", "分类标识或名称已经存在");
    }
    throw error;
  }
  return result;
}

async function mutateCatalogEntity(
  database: D1Database,
  user: { userId: string; deviceId: string },
  ledgerId: string,
  operation: TransactionOperation,
  requestHash: string,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  const isCategory = operation.entityType === "category";
  const isSubcategory = operation.entityType === "subcategory";
  const table = isCategory ? "categories" : isSubcategory ? "subcategories" : "accounts";
  const existing = await database.prepare(`SELECT id, version FROM ${table} WHERE id = ?1 AND ledger_id = ?2`)
    .bind(operation.entityId, ledgerId).first<ExistingCatalogRow>();
  if (!existing) throw new ApiError(404, "CATALOG_NOT_FOUND", "分类不存在");
  if (existing.version !== operation.baseVersion) {
    throw new ApiError(409, "VERSION_CONFLICT", "分类已在其他设备修改", { serverVersion: existing.version });
  }
  const nextVersion = existing.version + 1;
  const status = operation.operationType === "delete" ? "inactive" : "active";
  let payload: ValidatedCategoryPayload | ValidatedSubcategoryPayload | ValidatedAccountPayload;
  let update: D1PreparedStatement;
  if (operation.operationType === "delete") {
    if (operation.entityType === "account") {
      const activeAccounts = await database.prepare(
        "SELECT COUNT(*) AS count FROM accounts WHERE ledger_id = ?1 AND status = 'active'",
      ).bind(ledgerId).first<{ count: number }>();
      if ((activeAccounts?.count ?? 0) <= 1) throw new ApiError(409, "LAST_ACCOUNT_REQUIRED", "账本至少需要保留一个可用账户");
    }
    payload = isCategory
      ? { type: "expense", name: "", icon: "", sortOrder: 0 }
      : isSubcategory
        ? { categoryId: optionalString(operation.payload, "categoryId", 120), name: "", sortOrder: 0 }
        : { name: "", type: "cash", currency: "CNY", openingBalanceMinor: 0 };
    update = database.prepare(
      `UPDATE ${table} SET status = 'inactive', version = ?1, updated_at = ?2
       WHERE id = ?3 AND ledger_id = ?4 AND version = ?5`,
    ).bind(nextVersion, context.now, operation.entityId, ledgerId, operation.baseVersion);
  } else if (isCategory) {
    payload = validateCategoryPayload(operation.payload);
    update = database.prepare(
      `UPDATE categories SET type = ?1, name = ?2, icon = ?3, sort_order = ?4,
       status = 'active', version = ?5, updated_at = ?6
       WHERE id = ?7 AND ledger_id = ?8 AND version = ?9`,
    ).bind(
      payload.type, payload.name, payload.icon, payload.sortOrder,
      nextVersion, context.now, operation.entityId, ledgerId, operation.baseVersion,
    );
  } else if (isSubcategory) {
    payload = validateSubcategoryPayload(operation.payload);
    await requireActiveCategory(database, ledgerId, payload.categoryId);
    update = database.prepare(
      `UPDATE subcategories SET category_id = ?1, name = ?2, sort_order = ?3,
       status = 'active', version = ?4, updated_at = ?5
       WHERE id = ?6 AND ledger_id = ?7 AND version = ?8`,
    ).bind(
      payload.categoryId, payload.name, payload.sortOrder,
      nextVersion, context.now, operation.entityId, ledgerId, operation.baseVersion,
    );
  } else {
    payload = validateAccountPayload(operation.payload);
    update = database.prepare(
      `UPDATE accounts SET name = ?1, type = ?2, currency = ?3, opening_balance_minor = ?4,
       status = 'active', version = ?5, updated_at = ?6
       WHERE id = ?7 AND ledger_id = ?8 AND version = ?9`,
    ).bind(
      payload.name, payload.type, payload.currency, payload.openingBalanceMinor,
      nextVersion, context.now, operation.entityId, ledgerId, operation.baseVersion,
    );
  }
  const entity = catalogResult(operation.entityId, ledgerId, operation.entityType, payload, nextVersion, status, context.now);
  const result = { operationId: operation.operationId, status: "applied", entity, replayed: false };
  const [updateResult] = await database.batch([
    update,
    conditionalOperationInsert(database, user, ledgerId, operation, requestHash, result, nextVersion, context.now),
    conditionalChangeInsert(database, user.userId, ledgerId, operation, nextVersion, entity, table, context.now),
  ]);
  if (((updateResult.meta as D1WriteMeta).changes ?? 0) !== 1) {
    const server = await database.prepare(`SELECT version FROM ${table} WHERE id = ?1 AND ledger_id = ?2`)
      .bind(operation.entityId, ledgerId).first<{ version: number }>();
    throw new ApiError(409, "VERSION_CONFLICT", "分类已在其他设备修改", { serverVersion: server?.version ?? null });
  }
  return result;
}

function validateCategoryPayload(payload: Record<string, unknown>): ValidatedCategoryPayload {
  const type = requiredString(payload, "type", { min: 1, max: 10 });
  if (type !== "expense" && type !== "income") throw new ApiError(400, "INVALID_CATEGORY_TYPE", "分类类型不正确");
  return {
    type,
    name: requiredString(payload, "name", { min: 1, max: 8 }),
    icon: requiredString(payload, "icon", { min: 1, max: 2 }),
    sortOrder: requiredInteger(payload, "sortOrder", { min: 0, max: 10_000 }),
  };
}

function validateSubcategoryPayload(payload: Record<string, unknown>): ValidatedSubcategoryPayload {
  return {
    categoryId: requiredString(payload, "categoryId", { min: 8, max: 120, pattern: ID_PATTERN }),
    name: requiredString(payload, "name", { min: 1, max: 10 }),
    sortOrder: requiredInteger(payload, "sortOrder", { min: 0, max: 10_000 }),
  };
}

function validateAccountPayload(payload: Record<string, unknown>): ValidatedAccountPayload {
  const type = requiredString(payload, "type", { min: 1, max: 10 });
  if (type !== "cash" && type !== "bank" && type !== "wallet") {
    throw new ApiError(400, "INVALID_ACCOUNT_TYPE", "账户类型不正确");
  }
  return {
    name: requiredString(payload, "name", { min: 1, max: 12 }),
    type,
    currency: requiredString(payload, "currency", { min: 3, max: 3, pattern: ISO_CURRENCY_PATTERN }),
    openingBalanceMinor: requiredInteger(payload, "openingBalanceMinor", { min: -1_000_000_000_000, max: 1_000_000_000_000 }),
  };
}

async function requireActiveCategory(database: D1Database, ledgerId: string, categoryId: string): Promise<void> {
  const category = await database.prepare(
    "SELECT id FROM categories WHERE id = ?1 AND ledger_id = ?2 AND status = 'active'",
  ).bind(categoryId, ledgerId).first<{ id: string }>();
  if (!category) throw new ApiError(400, "INVALID_CATEGORY", "主分类不属于当前账本");
}

function catalogResult(
  id: string,
  ledgerId: string,
  entityType: TransactionOperation["entityType"],
  payload: ValidatedCategoryPayload | ValidatedSubcategoryPayload | ValidatedAccountPayload,
  version: number,
  status: "active" | "inactive",
  updatedAt: string,
): Record<string, unknown> {
  if (entityType === "category") {
    const category = payload as ValidatedCategoryPayload;
    return { id, ledgerId, type: category.type, name: category.name, icon: category.icon, sortOrder: category.sortOrder, status, version, updatedAt };
  }
  if (entityType === "account") {
    const account = payload as ValidatedAccountPayload;
    return {
      id, ledgerId, name: account.name, type: account.type, currency: account.currency,
      openingBalanceMinor: account.openingBalanceMinor, status, version, updatedAt,
    };
  }
  const subcategory = payload as ValidatedSubcategoryPayload;
  return { id, ledgerId, categoryId: subcategory.categoryId, name: subcategory.name, sortOrder: subcategory.sortOrder, status, version, updatedAt };
}

function conditionalOperationInsert(
  database: D1Database,
  user: { userId: string; deviceId: string },
  ledgerId: string,
  operation: TransactionOperation,
  requestHash: string,
  result: Record<string, unknown>,
  nextVersion: number,
  now: string,
): D1PreparedStatement {
  const table = operation.entityType === "category"
    ? "categories"
    : operation.entityType === "subcategory"
      ? "subcategories"
      : operation.entityType === "ledger"
        ? "ledgers"
        : "accounts";
  const ledgerCondition = table === "ledgers"
    ? "id = ?7 AND id = ?4 AND version = ?11"
    : "id = ?7 AND ledger_id = ?4 AND version = ?11";
  return database.prepare(
    `INSERT INTO sync_operations
     (operation_id, user_id, device_id, ledger_id, request_hash, entity_type, entity_id, operation_type, result_json, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
     WHERE EXISTS (SELECT 1 FROM ${table} WHERE ${ledgerCondition})`,
  ).bind(
    operation.operationId, user.userId, user.deviceId, ledgerId, requestHash,
    operation.entityType, operation.entityId, operation.operationType, JSON.stringify(result), now, nextVersion,
  );
}

function conditionalChangeInsert(
  database: D1Database,
  userId: string,
  ledgerId: string,
  operation: TransactionOperation,
  nextVersion: number,
  entity: Record<string, unknown>,
  table: string,
  now: string,
): D1PreparedStatement {
  const ledgerCondition = table === "ledgers"
    ? "id = ?3 AND id = ?1 AND version = ?5"
    : "id = ?3 AND ledger_id = ?1 AND version = ?5";
  return database.prepare(
    `INSERT INTO sync_changes
     (ledger_id, entity_type, entity_id, operation_type, entity_version, payload_json, changed_by_user_id, operation_id, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
     WHERE EXISTS (SELECT 1 FROM ${table} WHERE ${ledgerCondition})`,
  ).bind(
    ledgerId, operation.entityType, operation.entityId, operation.operationType, nextVersion,
    JSON.stringify(entity), userId, operation.operationId, now,
  );
}

async function validateCategoryAndAccount(
  database: D1Database,
  ledgerId: string,
  payload: ValidatedTransactionPayload,
): Promise<CategoryAccountRow> {
  const row = await database.prepare(
    `SELECT c.id AS category_id, c.name AS category_name, c.type AS category_type,
            a.id AS account_id, a.name AS account_name
     FROM categories c JOIN accounts a ON a.id = ?1 AND a.ledger_id = c.ledger_id AND a.status = 'active'
     WHERE c.id = ?2 AND c.ledger_id = ?3 AND c.status = 'active'`,
  ).bind(payload.accountId, payload.categoryId, ledgerId).first<CategoryAccountRow>();
  if (!row) throw new ApiError(400, "INVALID_CATEGORY_OR_ACCOUNT", "分类或账户不属于当前账本");
  if (row.category_type !== payload.type) throw new ApiError(400, "CATEGORY_TYPE_MISMATCH", "分类与账单类型不一致");
  if (payload.subcategoryId) {
    const subcategory = await database.prepare(
      "SELECT name FROM subcategories WHERE id = ?1 AND category_id = ?2 AND ledger_id = ?3 AND status = 'active'",
    ).bind(payload.subcategoryId, payload.categoryId, ledgerId).first<{ name: string }>();
    if (!subcategory) throw new ApiError(400, "INVALID_SUBCATEGORY", "子标签不属于当前分类");
    payload.subcategoryName = subcategory.name;
  } else {
    payload.subcategoryName = "";
  }
  return row;
}

function transactionResult(
  id: string,
  ledgerId: string,
  payload: ValidatedTransactionPayload,
  names: CategoryAccountRow,
  createdByUserId: string,
  createdByDisplayName: string,
  updatedByUserId: string,
  version: number,
  deletedAt: string | null,
  updatedAt: string,
): Record<string, unknown> {
  return {
    id,
    ledgerId,
    type: payload.type,
    amountMinor: payload.amountMinor,
    currency: payload.currency,
    baseAmountMinor: payload.baseAmountMinor,
    exchangeRateMicros: payload.exchangeRateMicros,
    exchangeRateSource: payload.exchangeRateSource,
    exchangeRateAt: payload.exchangeRateAt,
    subscriptionId: payload.subscriptionId,
    subscriptionPeriodKey: payload.subscriptionPeriodKey,
    occurredAt: payload.occurredAt,
    categoryId: payload.categoryId,
    categoryName: names.category_name,
    subcategoryId: payload.subcategoryId,
    subcategoryName: payload.subcategoryName,
    accountId: payload.accountId,
    accountName: names.account_name,
    note: payload.note,
    excludeFromStats: payload.excludeFromStats,
    createdByUserId,
    createdByDisplayName,
    updatedByUserId,
    version,
    deletedAt,
    updatedAt,
  };
}

function operationInsert(
  database: D1Database,
  user: { userId: string; deviceId: string },
  ledgerId: string,
  operation: TransactionOperation,
  requestHash: string,
  result: Record<string, unknown>,
  now: string,
): D1PreparedStatement {
  return database.prepare(
     `INSERT INTO sync_operations
     (operation_id, user_id, device_id, ledger_id, request_hash, entity_type, entity_id, operation_type, result_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).bind(
    operation.operationId, user.userId, user.deviceId, ledgerId, requestHash,
    operation.entityType, operation.entityId, operation.operationType, JSON.stringify(result), now,
  );
}

function changeInsert(
  database: D1Database,
  userId: string,
  ledgerId: string,
  operation: TransactionOperation,
  version: number,
  entity: Record<string, unknown>,
  now: string,
): D1PreparedStatement {
  return database.prepare(
     `INSERT INTO sync_changes
     (ledger_id, entity_type, entity_id, operation_type, entity_version, payload_json, changed_by_user_id, operation_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    ledgerId, operation.entityType, operation.entityId, operation.operationType, version,
    JSON.stringify(entity), userId, operation.operationId, now,
  );
}

function parseSafeQueryInteger(value: string | null, minimum: number, maximum: number, fallback: number): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/u.test(value)) throw new ApiError(400, "INVALID_QUERY", "查询参数必须是整数");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiError(400, "INVALID_QUERY", "查询参数超出范围");
  }
  return parsed;
}
