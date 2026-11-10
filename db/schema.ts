import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const appMessages = sqliteTable(
  "app_messages",
  {
    id: text("id").primaryKey(),
    placement: text("placement", { enum: ["launch"] }).notNull(),
    content: text("content").notNull(),
    status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [index("app_messages_placement_status_idx").on(table.placement, table.status, table.sortOrder)],
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_username_unique").on(table.username)],
);

export const systemState = sqliteTable("system_state", {
  id: integer("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id),
  initializedAt: text("initialized_at").notNull(),
});

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("浏览器设备"),
    lastSelectedLedgerId: text("last_selected_ledger_id"),
    lastSeenAt: text("last_seen_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("devices_user_id_idx").on(table.userId)],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    expirationTime: integer("expiration_time"),
    revokedAt: text("revoked_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("push_subscriptions_endpoint_unique").on(table.endpoint),
    index("push_subscriptions_user_device_idx").on(table.userId, table.deviceId, table.revokedAt),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const ledgers = sqliteTable(
  "ledgers",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    kind: text("kind", { enum: ["private", "family"] }).notNull(),
    name: text("name").notNull(),
    baseCurrency: text("base_currency").notNull().default("CNY"),
    monthlyBudgetMinor: integer("monthly_budget_minor").notNull().default(300000),
    version: integer("version").notNull().default(1),
    archivedAt: text("archived_at"),
    ...timestamps,
  },
  (table) => [index("ledgers_owner_user_id_idx").on(table.ownerUserId)],
);

export const ledgerMembers = sqliteTable(
  "ledger_members",
  {
    ledgerId: text("ledger_id").notNull().references(() => ledgers.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] }).notNull(),
    status: text("status", { enum: ["active", "removed"] }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.ledgerId, table.userId] }),
    index("ledger_members_user_id_idx").on(table.userId, table.status),
  ],
);

export const ledgerInvitations = sqliteTable(
  "ledger_invitations",
  {
    id: text("id").primaryKey(),
    ledgerId: text("ledger_id").notNull().references(() => ledgers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    role: text("role", { enum: ["admin", "member", "viewer"] }).notNull().default("admin"),
    status: text("status", { enum: ["pending", "accepted", "revoked", "expired"] }).notNull().default("pending"),
    invitedByUserId: text("invited_by_user_id").notNull().references(() => users.id),
    acceptedByUserId: text("accepted_by_user_id").references(() => users.id),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("ledger_invitations_token_hash_unique").on(table.tokenHash),
    index("ledger_invitations_ledger_id_idx").on(table.ledgerId, table.status),
  ],
);

export const invitationAcceptances = sqliteTable("invitation_acceptances", {
  invitationId: text("invitation_id").primaryKey().references(() => ledgerInvitations.id, { onDelete: "cascade" }),
  acceptedByUserId: text("accepted_by_user_id").notNull(),
  acceptedAt: text("accepted_at").notNull(),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    ledgerId: text("ledger_id").notNull().references(() => ledgers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type", { enum: ["cash", "bank", "wallet"] }).notNull(),
    currency: text("currency").notNull().default("CNY"),
    openingBalanceMinor: integer("opening_balance_minor").notNull().default(0),
    status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [index("accounts_ledger_id_idx").on(table.ledgerId, table.status)],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    ledgerId: text("ledger_id").notNull().references(() => ledgers.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["expense", "income"] }).notNull(),
    name: text("name").notNull(),
    icon: text("icon").notNull(),
    sortOrder: integer("sort_order").notNull(),
    status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("categories_ledger_id_idx").on(table.ledgerId, table.type, table.status),
    uniqueIndex("categories_ledger_name_unique").on(table.ledgerId, table.type, table.name),
  ],
);

export const subcategories = sqliteTable(
  "subcategories",
  {
    id: text("id").primaryKey(),
    ledgerId: text("ledger_id").notNull().references(() => ledgers.id, { onDelete: "cascade" }),
    categoryId: text("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull(),
    status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("subcategories_ledger_id_idx").on(table.ledgerId, table.categoryId, table.status),
    uniqueIndex("subcategories_category_name_unique").on(table.categoryId, table.name),
  ],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    ledgerId: text("ledger_id").notNull().references(() => ledgers.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["expense", "income"] }).notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    baseAmountMinor: integer("base_amount_minor").notNull(),
    exchangeRateMicros: integer("exchange_rate_micros").notNull().default(1_000_000),
    exchangeRateSource: text("exchange_rate_source", { enum: ["fixed", "manual", "frankfurter"] }).notNull().default("fixed"),
    exchangeRateAt: text("exchange_rate_at").notNull(),
    subscriptionId: text("subscription_id"),
    subscriptionPeriodKey: text("subscription_period_key"),
    occurredAt: text("occurred_at").notNull(),
    categoryId: text("category_id").notNull().references(() => categories.id),
    categoryName: text("category_name").notNull(),
    subcategoryId: text("subcategory_id").references(() => subcategories.id),
    subcategoryName: text("subcategory_name").notNull().default(""),
    accountId: text("account_id").notNull().references(() => accounts.id),
    accountName: text("account_name").notNull(),
    note: text("note").notNull().default(""),
    excludeFromStats: integer("exclude_from_stats", { mode: "boolean" }).notNull().default(false),
    createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
    updatedByUserId: text("updated_by_user_id").notNull().references(() => users.id),
    version: integer("version").notNull().default(1),
    deletedAt: text("deleted_at"),
    ...timestamps,
  },
  (table) => [
    index("transactions_ledger_occurred_at_idx").on(table.ledgerId, table.occurredAt),
    index("transactions_ledger_category_idx").on(table.ledgerId, table.categoryId),
    index("transactions_ledger_account_idx").on(table.ledgerId, table.accountId),
    uniqueIndex("transactions_subscription_period_unique").on(table.subscriptionId, table.subscriptionPeriodKey),
  ],
);

export const recurringSubscriptions = sqliteTable(
  "recurring_subscriptions",
  {
    id: text("id").primaryKey(),
    ledgerId: text("ledger_id").notNull().references(() => ledgers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    beneficiary: text("beneficiary").notNull().default(""),
    accountId: text("account_id").notNull().references(() => accounts.id),
    categoryId: text("category_id").notNull().references(() => categories.id),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    baseAmountMinor: integer("base_amount_minor").notNull(),
    exchangeRateMicros: integer("exchange_rate_micros").notNull(),
    exchangeRateSource: text("exchange_rate_source", { enum: ["fixed", "manual", "frankfurter"] }).notNull(),
    exchangeRateAt: text("exchange_rate_at").notNull(),
    frequency: text("frequency", { enum: ["month", "year"] }).notNull(),
    interval: integer("interval").notNull().default(1),
    nextChargeOn: text("next_charge_on").notNull(),
    anchorDay: integer("anchor_day"),
    remindDaysBefore: integer("remind_days_before").notNull().default(3),
    status: text("status", { enum: ["active", "paused", "cancelled"] }).notNull().default("active"),
    lastGeneratedPeriodKey: text("last_generated_period_key"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [index("recurring_subscriptions_ledger_status_idx").on(table.ledgerId, table.status, table.nextChargeOn)],
);

export const transactionAttachments = sqliteTable(
  "transaction_attachments",
  {
    id: text("id").primaryKey(),
    ledgerId: text("ledger_id").notNull().references(() => ledgers.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull().references(() => transactions.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("transaction_attachments_object_key_unique").on(table.objectKey),
    index("transaction_attachments_transaction_id_idx").on(table.transactionId, table.createdAt),
    index("transaction_attachments_ledger_id_idx").on(table.ledgerId, table.createdAt),
  ],
);

export const syncOperations = sqliteTable(
  "sync_operations",
  {
    operationId: text("operation_id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    deviceId: text("device_id").notNull().references(() => devices.id),
    ledgerId: text("ledger_id").notNull().references(() => ledgers.id, { onDelete: "cascade" }),
    requestHash: text("request_hash").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    operationType: text("operation_type").notNull(),
    resultJson: text("result_json").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("sync_operations_ledger_id_idx").on(table.ledgerId, table.createdAt)],
);

export const syncChanges = sqliteTable(
  "sync_changes",
  {
    revision: integer("revision").primaryKey({ autoIncrement: true }),
    ledgerId: text("ledger_id").notNull().references(() => ledgers.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    operationType: text("operation_type").notNull(),
    entityVersion: integer("entity_version").notNull(),
    payloadJson: text("payload_json").notNull(),
    changedByUserId: text("changed_by_user_id").notNull().references(() => users.id),
    operationId: text("operation_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("sync_changes_ledger_revision_idx").on(table.ledgerId, table.revision),
    uniqueIndex("sync_changes_operation_unique").on(table.operationId),
  ],
);

export const notificationEvents = sqliteTable(
  "notification_events",
  {
    id: text("id").primaryKey(),
    ledgerId: text("ledger_id").notNull().references(() => ledgers.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull().references(() => transactions.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull().references(() => users.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    targetUrl: text("target_url").notNull(),
    status: text("status", { enum: ["pending", "completed", "partial_failure"] }).notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("notification_events_status_idx").on(table.status, table.createdAt)],
);

export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    eventId: text("event_id").notNull().references(() => notificationEvents.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id").notNull().references(() => pushSubscriptions.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "sent", "failed", "invalid"] }).notNull().default("pending"),
    lastError: text("last_error"),
    sentAt: text("sent_at"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.subscriptionId] }),
    index("notification_deliveries_status_idx").on(table.status, table.updatedAt),
  ],
);
