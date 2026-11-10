import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultLedgerStatements } from "../worker/api/defaults";
import { createRequestContext } from "../worker/api/http";
import { deliverNotificationEvent } from "../worker/api/notification-service";
import { handleApiRequest } from "../worker/api/router";
import { SNAPSHOT_TRANSACTION_LIMIT } from "../worker/api/sync-service";
import { PASSWORD_ITERATIONS } from "../worker/api/security";

const BASE_URL = "https://bookkeeping.test/api/v1";

function request(
  path: string,
  options: { method?: string; token?: string; body?: Record<string, unknown> } = {},
): Request {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body) headers.set("content-type", "application/json");
  return new Request(`${BASE_URL}${path}`, {
    method: options.method ?? (options.body ? "POST" : "GET"),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function api(
  path: string,
  options: { method?: string; token?: string; body?: Record<string, unknown> } = {},
): Promise<{ response: Response; json: Record<string, unknown> }> {
  const response = await handleApiRequest(request(path, options), env);
  const json = await response.json<Record<string, unknown>>();
  return { response, json };
}

async function resetDatabase(): Promise<void> {
  const objects = await env.ATTACHMENTS.list();
  await Promise.all(objects.objects.map((object) => env.ATTACHMENTS.delete(object.key)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notification_deliveries"),
    env.DB.prepare("DELETE FROM notification_events"),
    env.DB.prepare("DELETE FROM push_subscriptions"),
    env.DB.prepare("DELETE FROM sync_changes"),
    env.DB.prepare("DELETE FROM sync_operations"),
    env.DB.prepare("DELETE FROM transaction_attachments"),
    env.DB.prepare("DELETE FROM transactions"),
    env.DB.prepare("DELETE FROM recurring_subscriptions"),
    env.DB.prepare("DELETE FROM subcategories"),
    env.DB.prepare("DELETE FROM categories"),
    env.DB.prepare("DELETE FROM accounts"),
    env.DB.prepare("DELETE FROM invitation_acceptances"),
    env.DB.prepare("DELETE FROM ledger_invitations"),
    env.DB.prepare("DELETE FROM ledger_members"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM devices"),
    env.DB.prepare("DELETE FROM ledgers"),
    env.DB.prepare("DELETE FROM system_state"),
    env.DB.prepare("DELETE FROM users"),
  ]);
}

function field<T>(object: Record<string, unknown>, key: string): T {
  return object[key] as T;
}

describe("network API", () => {
  beforeEach(resetDatabase);

  it("returns a random active launch message from D1", async () => {
    const result = await api("/app/launch-message");
    const message = field<Record<string, unknown>>(result.json, "message");

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect([
      "记下生活的每一笔，让日常更有条理。",
      "认真记录日常，从容安排生活。",
    ]).toContain(message.content);
  });

  it("keeps PBKDF2 within the Cloudflare Workers runtime limit", () => {
    expect(PASSWORD_ITERATIONS).toBeGreaterThan(0);
    expect(PASSWORD_ITERATIONS).toBeLessThanOrEqual(100_000);
  });

  it("keeps owner bootstrap within the free-tier D1 query limit", () => {
    const defaultStatements = defaultLedgerStatements(env.DB, {
      ledgerId: "ledger-default",
      ownerUserId: "user-owner",
      name: "我的账本",
      kind: "private",
      now: new Date().toISOString(),
    });

    const bootstrapStatementCount = defaultStatements.length + 4;
    expect(bootstrapStatementCount).toBeLessThanOrEqual(50);
  });

  it("completes owner bootstrap, invitation, private isolation and idempotent sync", async () => {
    const initialStatus = await api("/bootstrap/status");
    expect(initialStatus.response.status).toBe(200);
    expect(initialStatus.json.initialized).toBe(false);

    const bootstrap = await api("/bootstrap", {
      body: {
        username: "owner",
        password: "owner-password-2026",
        displayName: "测试用户",
        deviceId: "device-owner-0001",
        deviceName: "Owner iPhone",
        privateLedgerId: "ledger-default",
      },
    });
    expect(bootstrap.response.status).toBe(201);
    const ownerSession = field<Record<string, unknown>>(bootstrap.json, "session");
    const ownerToken = field<string>(ownerSession, "token");
    const ownerPrivateLedgerId = field<string>(bootstrap.json, "selectedLedgerId");
    const localLedgerId = "ledger-local-private-sync";
    expect((await api("/ledgers/private", { body: { ledgerId: localLedgerId, name: "本机私人账本" } })).response.status).toBe(401);
    const localRegistration = await api("/ledgers/private", { token: ownerToken, body: { ledgerId: localLedgerId, name: "本机私人账本" } });
    expect(localRegistration.response.status).toBe(201);
    expect(field<Record<string, unknown>>(localRegistration.json, "ledger").kind).toBe("private");
    expect((await api("/ledgers/private", { token: ownerToken, body: { ledgerId: localLedgerId, name: "本机私人账本" } })).response.status).toBe(200);
    expect((await api("/ledgers/private", { token: ownerToken, body: { ledgerId: ownerPrivateLedgerId, name: "日常账本" } })).response.status).toBe(200);
    const localOperation = { operationId: "operation-local-private-sync-01", entityType: "transaction", entityId: "transaction-local-private-01", operationType: "create", baseVersion: 0,
      payload: { type: "expense", amountMinor: 1234, currency: "CNY", occurredAt: new Date().toISOString(), accountId: `account-cash:${localLedgerId}`, categoryId: `${localLedgerId}:category-food`, note: "本机账目" } };
    const localPush = { ledgerId: localLedgerId, deviceId: "device-owner-0001", operations: [localOperation] };
    const firstLocalPush = await api("/sync/push", { token: ownerToken, body: localPush });
    expect(field<Array<Record<string, unknown>>>(firstLocalPush.json, "results")[0].status).toBe("applied");
    expect((await api("/sync/push", { token: ownerToken, body: localPush })).response.status).toBe(200);
    const localSnapshot = await api(`/ledgers/${localLedgerId}/snapshot`, { token: ownerToken });
    expect(field<unknown[]>(localSnapshot.json, "transactions")).toHaveLength(1);
    expect(ownerPrivateLedgerId).toBe("ledger-default");
    const ownerSnapshot = await api(`/ledgers/${ownerPrivateLedgerId}/snapshot`, { token: ownerToken });
    const ownerCategories = field<Array<Record<string, unknown>>>(ownerSnapshot.json, "categories");
    expect(ownerCategories.some((category) => category.id === "category-food")).toBe(true);
    const lastAccountDelete = await api("/sync/push", {
      token: ownerToken,
      body: {
        ledgerId: ownerPrivateLedgerId,
        deviceId: "device-owner-0001",
        operations: [{
          operationId: "operation-delete-last-account-01",
          entityType: "account",
          operationType: "delete",
          entityId: "account-cash",
          baseVersion: 1,
          payload: {},
        }],
      },
    });
    expect(field<Array<Record<string, unknown>>>(lastAccountDelete.json, "results")[0].status).toBe("conflict");

    const duplicateBootstrap = await api("/bootstrap", {
      body: {
        username: "another-owner",
        password: "another-password-2026",
        displayName: "重复用户",
        deviceId: "device-owner-0002",
      },
    });
    expect(duplicateBootstrap.response.status).toBe(409);

    const familyOperationId = "operation-create-family-0001";
    const family = await api("/ledgers", {
      token: ownerToken,
      body: { name: "家庭账本", ledgerId: "ledger-family-0001", operationId: familyOperationId },
    });
    expect(family.response.status).toBe(201);
    const familyLedger = field<Record<string, unknown>>(family.json, "ledger");
    const familyLedgerId = field<string>(familyLedger, "id");

    const replayedFamily = await api("/ledgers", {
      token: ownerToken,
      body: { name: "家庭账本", ledgerId: "ledger-family-0001", operationId: familyOperationId },
    });
    expect(replayedFamily.response.status).toBe(200);
    expect(replayedFamily.json.replayed).toBe(true);
    expect(field<Record<string, unknown>>(replayedFamily.json, "ledger").id).toBe(familyLedgerId);

    const inviteToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const invite = await api(`/ledgers/${familyLedgerId}/invitations`, {
      token: ownerToken,
      body: {
        operationId: "operation-create-invite-0001",
        inviteToken,
        role: "admin",
        expiresInHours: 72,
      },
    });
    expect(invite.response.status).toBe(201);
    expect(invite.json.inviteToken).toBe(inviteToken);

    const conflictingPrivateLedger = await api("/invitations/accept", {
      body: {
        inviteToken,
        username: "wife",
        password: "wife-password-2026",
        displayName: "家庭成员",
        deviceId: "device-wife-0001",
        deviceName: "Wife iPhone",
        privateLedgerId: "ledger-default",
      },
    });
    expect(conflictingPrivateLedger.response.status).toBe(409);
    expect(field<Record<string, unknown>>(conflictingPrivateLedger.json, "error").code).toBe("PRIVATE_LEDGER_ID_CONFLICT");

    const wifePrivateLedgerId = "ledger-11111111-1111-4111-8111-111111111111";
    const accepted = await api("/invitations/accept", {
      body: {
        inviteToken,
        username: "wife",
        password: "wife-password-2026",
        displayName: "家庭成员",
        deviceId: "device-wife-0001",
        deviceName: "Wife iPhone",
        privateLedgerId: wifePrivateLedgerId,
      },
    });
    expect(accepted.response.status).toBe(201);
    const wifeSession = field<Record<string, unknown>>(accepted.json, "session");
    const wifeToken = field<string>(wifeSession, "token");
    expect((await api("/ledgers/private", { token: wifeToken, body: { ledgerId: localLedgerId, name: "试图接管" } })).response.status).toBe(409);
    expect((await api(`/ledgers/${localLedgerId}/snapshot`, { token: wifeToken })).response.status).toBe(403);
    expect((await api("/ledgers/private", { token: ownerToken, body: { ledgerId: familyLedgerId, name: "不能转为私人" } })).response.status).toBe(409);
    expect(accepted.json.selectedLedgerId).toBe(familyLedgerId);
    expect(accepted.json.privateLedgerId).toBe(wifePrivateLedgerId);
    const forbiddenComparison = await api(`/sync/entity?ledger_id=${ownerPrivateLedgerId}&entity_type=account&entity_id=account-cash`, { token: wifeToken });
    expect(forbiddenComparison.response.status).toBe(403);
    const accountComparison = await api(`/sync/entity?ledger_id=${ownerPrivateLedgerId}&entity_type=account&entity_id=account-cash`, { token: ownerToken });
    expect(accountComparison.response.status).toBe(200);
    expect(field<Record<string, unknown>>(accountComparison.json, "change")).toMatchObject({ entityType: "account", entityVersion: 1, payload: { openingBalanceMinor: 0 } });
    const missingComparison = await api(`/sync/entity?ledger_id=${ownerPrivateLedgerId}&entity_type=transaction&entity_id=missing-transaction`, { token: ownerToken });
    expect(missingComparison.json.change).toBeNull();
    const invalidComparison = await api(`/sync/entity?ledger_id=${ownerPrivateLedgerId}&entity_type=users&entity_id=account-cash`, { token: ownerToken });
    expect(invalidComparison.response.status).toBe(400);

    const pushConfiguration = await api("/push/configuration", { token: wifeToken });
    expect(pushConfiguration.response.status).toBe(200);
    expect(pushConfiguration.json.publicKey).toBe("test-vapid-public-key");
    const pushEndpoint = "https://push.example.test/subscriptions/device-wife-0001";
    const savedPushSubscription = await api("/push/subscription", {
      method: "PUT",
      token: wifeToken,
      body: {
        subscription: {
          endpoint: pushEndpoint,
          expirationTime: null,
          keys: {
            p256dh: "A".repeat(88),
            auth: "B".repeat(24),
          },
        },
      },
    });
    expect(savedPushSubscription.response.status).toBe(200);
    expect(savedPushSubscription.json.subscribed).toBe(true);

    const wifeLedgers = await api("/ledgers", { token: wifeToken });
    expect(wifeLedgers.response.status).toBe(200);
    const wifeLedgerRows = field<Array<Record<string, unknown>>>(wifeLedgers.json, "ledgers");
    expect(wifeLedgerRows).toHaveLength(2);
    expect(wifeLedgerRows.find((ledger) => ledger.id === familyLedgerId)?.role).toBe("admin");

    const privateAccess = await api(`/ledgers/${ownerPrivateLedgerId}/snapshot`, { token: wifeToken });
    expect(privateAccess.response.status).toBe(403);

    const snapshot = await api(`/ledgers/${familyLedgerId}/snapshot`, { token: ownerToken });
    expect(snapshot.response.status).toBe(200);
    const categories = field<Array<Record<string, unknown>>>(snapshot.json, "categories");
    const accounts = field<Array<Record<string, unknown>>>(snapshot.json, "accounts");
    expect(accounts).toHaveLength(1);
    const foodCategory = categories.find((category) => category.name === "餐饮");
    expect(foodCategory).toBeTruthy();

    const budgetOperation = {
      operationId: "operation-update-ledger-budget-0001",
      entityType: "ledger",
      operationType: "update",
      entityId: familyLedgerId,
      baseVersion: 1,
      payload: { monthlyBudgetMinor: 520_000 },
    };
    const budgetPush = await api("/sync/push", {
      token: ownerToken,
      body: { ledgerId: familyLedgerId, deviceId: "device-owner-0001", operations: [budgetOperation] },
    });
    expect(field<Array<Record<string, unknown>>>(budgetPush.json, "results")[0]).toMatchObject({
      status: "applied",
      replayed: false,
    });
    const budgetReplay = await api("/sync/push", {
      token: ownerToken,
      body: { ledgerId: familyLedgerId, deviceId: "device-owner-0001", operations: [budgetOperation] },
    });
    expect(field<Array<Record<string, unknown>>>(budgetReplay.json, "results")[0].replayed).toBe(true);
    const budgetSnapshot = await api(`/ledgers/${familyLedgerId}/snapshot`, { token: wifeToken });
    expect(field<Record<string, unknown>>(budgetSnapshot.json, "ledger").monthly_budget_minor).toBe(520_000);

    const customCategoryOperation = {
      operationId: "operation-create-category-0001",
      entityType: "category",
      operationType: "create",
      entityId: `${familyLedgerId}:category-pet`,
      baseVersion: 0,
      payload: { type: "expense", name: "宠物", icon: "宠", sortOrder: 20, status: "active" },
    };
    const categoryPush = await api("/sync/push", {
      token: ownerToken,
      body: { ledgerId: familyLedgerId, deviceId: "device-owner-0001", operations: [customCategoryOperation] },
    });
    expect(field<Array<Record<string, unknown>>>(categoryPush.json, "results")[0].status).toBe("applied");
    const categoryReplay = await api("/sync/push", {
      token: ownerToken,
      body: { ledgerId: familyLedgerId, deviceId: "device-owner-0001", operations: [customCategoryOperation] },
    });
    expect(field<Array<Record<string, unknown>>>(categoryReplay.json, "results")[0].replayed).toBe(true);

    const customSubcategoryOperation = {
      operationId: "operation-create-subcategory-0001",
      entityType: "subcategory",
      operationType: "create",
      entityId: `${familyLedgerId}:category-pet:subtag-food`,
      baseVersion: 0,
      payload: { categoryId: customCategoryOperation.entityId, name: "猫粮", sortOrder: 1, status: "active" },
    };
    const subcategoryPush = await api("/sync/push", {
      token: wifeToken,
      body: { ledgerId: familyLedgerId, deviceId: "device-wife-0001", operations: [customSubcategoryOperation] },
    });
    expect(field<Array<Record<string, unknown>>>(subcategoryPush.json, "results")[0].status).toBe("applied");
    const subcategoryDelete = await api("/sync/push", {
      token: wifeToken,
      body: {
        ledgerId: familyLedgerId,
        deviceId: "device-wife-0001",
        operations: [{
          ...customSubcategoryOperation,
          operationId: "operation-delete-subcategory-0001",
          operationType: "delete",
          baseVersion: 1,
          payload: { categoryId: customCategoryOperation.entityId },
        }],
      },
    });
    expect(field<Array<Record<string, unknown>>>(subcategoryDelete.json, "results")[0].status).toBe("applied");

    const accountOperation = {
      operationId: "operation-create-account-0001",
      entityType: "account",
      operationType: "create",
      entityId: `${familyLedgerId}:account-wallet`,
      baseVersion: 0,
      payload: { name: "家庭钱包", type: "wallet", currency: "CNY", openingBalanceMinor: 0, status: "active" },
    };
    const accountPush = await api("/sync/push", {
      token: wifeToken,
      body: { ledgerId: familyLedgerId, deviceId: "device-wife-0001", operations: [accountOperation] },
    });
    expect(field<Array<Record<string, unknown>>>(accountPush.json, "results")[0].status).toBe("applied");
    const accountUpdate = await api("/sync/push", {
      token: ownerToken,
      body: {
        ledgerId: familyLedgerId,
        deviceId: "device-owner-0001",
        operations: [{
          ...accountOperation,
          operationId: "operation-update-account-0001",
          operationType: "update",
          baseVersion: 1,
          payload: { ...accountOperation.payload, name: "共同钱包" },
        }],
      },
    });
    expect(field<Array<Record<string, unknown>>>(accountUpdate.json, "results")[0].status).toBe("applied");
    const transactionPayload = {
      type: "expense",
      amountMinor: 1560,
      currency: "CNY",
      occurredAt: "2026-07-16T10:00:00.000Z",
      categoryId: foodCategory?.id,
      accountId: accountOperation.entityId,
      note: "午餐",
      excludeFromStats: false,
    };
    const createOperation = {
      operationId: "operation-create-transaction-0001",
      entityType: "transaction",
      operationType: "create",
      entityId: "transaction-family-0001",
      baseVersion: 0,
      payload: transactionPayload,
    };
    const pushed = await api("/sync/push", {
      token: ownerToken,
      body: { ledgerId: familyLedgerId, deviceId: "device-owner-0001", operations: [createOperation] },
    });
    expect(pushed.response.status).toBe(200);
    expect(field<Array<Record<string, unknown>>>(pushed.json, "results")[0].status).toBe("applied");

    const replayedPush = await api("/sync/push", {
      token: ownerToken,
      body: { ledgerId: familyLedgerId, deviceId: "device-owner-0001", operations: [createOperation] },
    });
    expect(field<Array<Record<string, unknown>>>(replayedPush.json, "results")[0].replayed).toBe(true);
    const transactionCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM transactions WHERE ledger_id = ?1")
      .bind(familyLedgerId).first<{ count: number }>();
    expect(transactionCount?.count).toBe(1);
    const notificationEvents = await env.DB.prepare(
      "SELECT id, title, body, status FROM notification_events WHERE transaction_id = ?1",
    ).bind(createOperation.entityId).all<{ id: string; title: string; body: string; status: string }>();
    expect(notificationEvents.results).toEqual([{
      id: createOperation.operationId,
      title: "家庭账本有新账目",
      body: "测试用户新增了一笔支出 · 餐饮",
      status: "pending",
    }]);
    const deliveredPayloads: Array<Record<string, unknown>> = [];
    await deliverNotificationEvent(env, createRequestContext(), createOperation.operationId, async (subscription, payload) => {
      deliveredPayloads.push({ subscription, payload });
      return true;
    });
    expect(deliveredPayloads).toHaveLength(1);
    expect(field<Record<string, unknown>>(deliveredPayloads[0], "subscription").endpoint).toBe(pushEndpoint);
    expect(field<Record<string, unknown>>(deliveredPayloads[0], "payload").url).toBe(
      `/?ledger=${familyLedgerId}&transaction=${createOperation.entityId}`,
    );
    const sentDelivery = await env.DB.prepare(
      "SELECT status FROM notification_deliveries WHERE event_id = ?1",
    ).bind(createOperation.operationId).first<{ status: string }>();
    expect(sentDelivery?.status).toBe("sent");

    const conflictingUpdate = await api("/sync/push", {
      token: ownerToken,
      body: {
        ledgerId: familyLedgerId,
        deviceId: "device-owner-0001",
        operations: [{
          ...createOperation,
          operationId: "operation-update-conflict-0001",
          operationType: "update",
          baseVersion: 0,
        }],
      },
    });
    expect(field<Array<Record<string, unknown>>>(conflictingUpdate.json, "results")[0].status).toBe("conflict");
    const comparison = await api(`/sync/entity?ledger_id=${familyLedgerId}&entity_type=transaction&entity_id=${createOperation.entityId}`, { token: ownerToken });
    expect(comparison.response.status).toBe(200);
    expect(field<Record<string, unknown>>(comparison.json, "change")).toMatchObject({ entityType: "transaction", entityVersion: 1, payload: { categoryName: expect.any(String), accountName: expect.any(String), excludeFromStats: false } });

    const update = await api("/sync/push", {
      token: wifeToken,
      body: {
        ledgerId: familyLedgerId,
        deviceId: "device-wife-0001",
        operations: [{
          ...createOperation,
          operationId: "operation-update-transaction-0001",
          operationType: "update",
          baseVersion: 1,
          payload: { ...transactionPayload, amountMinor: 1680 },
        }],
      },
    });
    expect(field<Array<Record<string, unknown>>>(update.json, "results")[0].status).toBe("applied");

    const subscriptionOperation = {
      operationId: "operation-create-subscription-0001",
      entityType: "subscription",
      operationType: "create",
      entityId: "subscription-apple-music-0001",
      baseVersion: 0,
      payload: {
        name: "Apple Music", beneficiary: "孩子", accountId: accountOperation.entityId,
        categoryId: foodCategory?.id, amountMinor: 1099, currency: "USD", baseAmountMinor: 7913,
        exchangeRateMicros: 7_200_000, exchangeRateSource: "frankfurter",
        exchangeRateAt: "2026-07-20T00:00:00.000Z", frequency: "month", interval: 1,
        nextChargeOn: "2026-08-20", remindDaysBefore: 3, status: "active", lastGeneratedPeriodKey: null,
      },
    };
    const subscriptionPush = await api("/sync/push", {
      token: wifeToken,
      body: { ledgerId: familyLedgerId, deviceId: "device-wife-0001", operations: [subscriptionOperation] },
    });
    expect(field<Array<Record<string, unknown>>>(subscriptionPush.json, "results")[0].status).toBe("applied");
    const subscriptionReplay = await api("/sync/push", {
      token: wifeToken,
      body: { ledgerId: familyLedgerId, deviceId: "device-wife-0001", operations: [subscriptionOperation] },
    });
    expect(field<Array<Record<string, unknown>>>(subscriptionReplay.json, "results")[0].replayed).toBe(true);
    const subscriptionSnapshot = await api(`/ledgers/${familyLedgerId}/snapshot`, { token: ownerToken });
    expect(field<Array<Record<string, unknown>>>(subscriptionSnapshot.json, "subscriptions")).toHaveLength(1);
    // 旧客户端不上传 anchorDay：服务端以下次扣费日的日作为锚点。
    expect(field<Array<Record<string, unknown>>>(subscriptionSnapshot.json, "subscriptions")[0].anchor_day).toBe(20);
    const anchoredUpdate = await api("/sync/push", {
      token: wifeToken,
      body: {
        ledgerId: familyLedgerId,
        deviceId: "device-wife-0001",
        operations: [{
          ...subscriptionOperation,
          operationId: "operation-update-subscription-0001",
          operationType: "update",
          baseVersion: 1,
          payload: { ...subscriptionOperation.payload, nextChargeOn: "2026-09-30", anchorDay: 31 },
        }],
      },
    });
    expect(field<Array<Record<string, unknown>>>(anchoredUpdate.json, "results")[0].status).toBe("applied");
    const anchoredSnapshot = await api(`/ledgers/${familyLedgerId}/snapshot`, { token: ownerToken });
    expect(field<Array<Record<string, unknown>>>(anchoredSnapshot.json, "subscriptions")[0].anchor_day).toBe(31);
    const invalidAnchor = await api("/sync/push", {
      token: wifeToken,
      body: {
        ledgerId: familyLedgerId,
        deviceId: "device-wife-0001",
        operations: [{
          ...subscriptionOperation,
          operationId: "operation-invalid-anchor-0001",
          operationType: "update",
          baseVersion: 2,
          payload: { ...subscriptionOperation.payload, anchorDay: 32 },
        }],
      },
    });
    expect(field<Array<Record<string, unknown>>>(invalidAnchor.json, "results")[0].status).toBe("failed");

    const attachmentId = "attachment-family-0001";
    const attachmentBytes = new TextEncoder().encode("test image bytes");
    const attachmentHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", attachmentBytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const attachmentPath = `/attachments/${attachmentId}?${new URLSearchParams({
      ledgerId: familyLedgerId,
      transactionId: "transaction-family-0001",
      name: "家庭小票.png",
      sha256: attachmentHash,
    })}`;
    const upload = async () => handleApiRequest(new Request(`${BASE_URL}${attachmentPath}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-length": String(attachmentBytes.byteLength),
        "content-type": "image/png",
      },
      body: attachmentBytes,
    }), env);
    const uploaded = await upload();
    expect(uploaded.status).toBe(201);
    const replayedUpload = await upload();
    expect(replayedUpload.status).toBe(200);
    expect((await replayedUpload.json<Record<string, unknown>>()).replayed).toBe(true);
    const attachmentCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM transaction_attachments WHERE ledger_id = ?1")
      .bind(familyLedgerId).first<{ count: number }>();
    expect(attachmentCount?.count).toBe(1);
    const downloaded = await handleApiRequest(request(`/attachments/${attachmentId}/content`, { token: wifeToken }), env);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(attachmentBytes);
    const attachmentSnapshot = await api(`/ledgers/${familyLedgerId}/snapshot`, { token: wifeToken });
    expect(field<Array<Record<string, unknown>>>(attachmentSnapshot.json, "attachments")).toHaveLength(1);

    const updatedProfile = await api("/me", {
      method: "PUT",
      token: ownerToken,
      body: { displayName: "更新后的测试用户" },
    });
    expect(updatedProfile.response.status).toBe(200);
    expect(field<Record<string, unknown>>(updatedProfile.json, "user").displayName).toBe("更新后的测试用户");
    const creators = await api(`/ledgers/${familyLedgerId}/transaction-creators`, { token: wifeToken });
    expect(field<Array<Record<string, unknown>>>(creators.json, "creators")).toContainEqual({
      transactionId: "transaction-family-0001",
      userId: field<Record<string, unknown>>(bootstrap.json, "user").id,
      displayName: "更新后的测试用户",
    });
    const renamedSnapshot = await api(`/ledgers/${familyLedgerId}/snapshot`, { token: wifeToken });
    expect(field<Array<Record<string, unknown>>>(renamedSnapshot.json, "transactions")[0].created_by_display_name)
      .toBe("更新后的测试用户");

    const pull = await api(`/sync/pull?ledger_id=${familyLedgerId}&after_revision=0`, { token: wifeToken });
    expect(pull.response.status).toBe(200);
    const changes = field<Array<Record<string, unknown>>>(pull.json, "changes");
    const transactionChanges = changes.filter((change) => change.entityType === "transaction");
    expect(transactionChanges).toHaveLength(2);
    expect(transactionChanges.map((change) => change.operationType)).toEqual(["create", "update"]);
    expect(changes.filter((change) => change.entityType === "category")).toHaveLength(1);
    expect(changes.filter((change) => change.entityType === "subcategory")).toHaveLength(2);
    expect(changes.filter((change) => change.entityType === "account")).toHaveLength(2);
    expect(changes.filter((change) => change.entityType === "attachment")).toHaveLength(1);
    expect(changes.filter((change) => change.entityType === "profile")).toHaveLength(1);

    const refreshedSession = await api("/auth/refresh", { method: "POST", token: wifeToken });
    expect(refreshedSession.response.status).toBe(200);
    const refreshedToken = field<string>(field<Record<string, unknown>>(refreshedSession.json, "session"), "token");
    expect((await api("/me", { token: wifeToken })).response.status).toBe(401);
    expect((await api("/me", { token: refreshedToken })).response.status).toBe(200);

    const removedPushSubscription = await api("/push/subscription", {
      method: "DELETE",
      token: refreshedToken,
      body: { endpoint: pushEndpoint },
    });
    expect(removedPushSubscription.json.subscribed).toBe(false);
    const revokedSubscription = await env.DB.prepare(
      "SELECT revoked_at FROM push_subscriptions WHERE endpoint = ?1",
    ).bind(pushEndpoint).first<{ revoked_at: string | null }>();
    expect(revokedSubscription?.revoked_at).not.toBeNull();

    const acceptReplay = await api("/invitations/accept", {
      body: {
        inviteToken,
        username: "wife",
        password: "wife-password-2026",
        displayName: "家庭成员",
        deviceId: "device-wife-0001",
      },
    });
    expect(acceptReplay.response.status).toBe(200);
    expect(acceptReplay.json.replayed).toBe(true);
  });
  it("does not claim a complete snapshot when the ledger exceeds the snapshot transaction limit", async () => {
    const bootstrap = await api("/bootstrap", {
      body: {
        username: "bulk-owner",
        password: "bulk-owner-password-2026",
        displayName: "大账本",
        deviceId: "device-bulk-0001",
        deviceName: "Bulk device",
        privateLedgerId: "ledger-bulk",
      },
    });
    const token = field<string>(field<Record<string, unknown>>(bootstrap.json, "session"), "token");
    const user = await env.DB.prepare("SELECT id FROM users WHERE username = 'bulk-owner'").first<{ id: string }>();
    const category = await env.DB.prepare(
      "SELECT id, name FROM categories WHERE ledger_id = 'ledger-bulk' AND type = 'expense' LIMIT 1",
    ).first<{ id: string; name: string }>();
    const account = await env.DB.prepare(
      "SELECT id, name FROM accounts WHERE ledger_id = 'ledger-bulk' LIMIT 1",
    ).first<{ id: string; name: string }>();

    const insertTransactions = (count: number) => env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?1)
       INSERT INTO transactions
         (id, ledger_id, type, amount_minor, currency, base_amount_minor, exchange_rate_at, occurred_at,
          category_id, category_name, account_id, account_name, created_by_user_id, updated_by_user_id,
          created_at, updated_at)
       SELECT 'transaction-bulk-' || n, 'ledger-bulk', 'expense', 100, 'CNY', 100,
              '2026-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || n || ' minutes'),
              ?3, ?4, ?5, ?6, ?2, ?2,
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
       FROM seq`,
    ).bind(count, user?.id, category?.id, category?.name, account?.id, account?.name).run();

    await insertTransactions(SNAPSHOT_TRANSACTION_LIMIT);
    await env.DB.prepare(
      `INSERT INTO sync_changes
       (ledger_id, entity_type, entity_id, operation_type, entity_version, payload_json, changed_by_user_id, operation_id, created_at)
       VALUES ('ledger-bulk', 'transaction', 'transaction-bulk-1', 'create', 1, '{}', ?1, 'operation-bulk-change-01', '2026-01-01T00:00:00.000Z')`,
    ).bind(user?.id).run();

    const complete = await api("/ledgers/ledger-bulk/snapshot", { token });
    expect(complete.json.truncated).toBe(false);
    expect(field<unknown[]>(complete.json, "transactions")).toHaveLength(SNAPSHOT_TRANSACTION_LIMIT);
    expect(complete.json.revision).toBeGreaterThan(0);

    await env.DB.prepare(
      `INSERT INTO transactions
       (id, ledger_id, type, amount_minor, currency, base_amount_minor, exchange_rate_at, occurred_at,
        category_id, category_name, account_id, account_name, created_by_user_id, updated_by_user_id,
        created_at, updated_at)
       VALUES ('transaction-bulk-extra', 'ledger-bulk', 'expense', 100, 'CNY', 100, '2026-01-01T00:00:00.000Z',
               '2025-01-01T00:00:00.000Z', ?2, ?3, ?4, ?5, ?1, ?1,
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).bind(user?.id, category?.id, category?.name, account?.id, account?.name).run();

    const truncated = await api("/ledgers/ledger-bulk/snapshot", { token });
    expect(truncated.json.truncated).toBe(true);
    expect(field<unknown[]>(truncated.json, "transactions")).toHaveLength(SNAPSHOT_TRANSACTION_LIMIT);
    // revision 为 0，客户端会从头增量拉取，不会把不完整的快照当作最新状态。
    expect(truncated.json.revision).toBe(0);
  });
});
