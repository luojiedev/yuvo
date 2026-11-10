import { sendPushNotification } from "@mmmike/web-push/send";
import { authenticate } from "./auth";
import {
  ApiError,
  asObject,
  jsonResponse,
  logDebug,
  logError,
  readJsonBody,
  requiredString,
  type RequestContext,
} from "./http";

type PushBindings = Pick<Env, "DB" | "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">;
type PushSender = typeof sendPushNotification;

export interface NotificationRuntime {
  bindings: PushBindings;
  waitUntil(promise: Promise<unknown>): void;
}

interface NotificationEventRow {
  id: string;
  title: string;
  body: string;
  target_url: string;
}

interface PendingDeliveryRow {
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface SubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

const HTTPS_PROTOCOL = "https:";

function parseSubscription(value: unknown): SubscriptionInput {
  const object = asObject(value);
  const endpoint = requiredString(object, "endpoint", { min: 20, max: 2048 });
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new ApiError(400, "INVALID_PUSH_ENDPOINT", "通知订阅地址格式不正确");
  }
  if (endpointUrl.protocol !== HTTPS_PROTOCOL) {
    throw new ApiError(400, "INVALID_PUSH_ENDPOINT", "通知订阅地址必须使用 HTTPS");
  }
  const keys = asObject(object.keys);
  const expirationTimeValue = object.expirationTime;
  if (expirationTimeValue !== undefined && expirationTimeValue !== null
    && (!Number.isSafeInteger(expirationTimeValue) || (expirationTimeValue as number) < 0)) {
    throw new ApiError(400, "INVALID_PUSH_EXPIRATION", "通知订阅过期时间格式不正确");
  }
  return {
    endpoint: endpointUrl.toString(),
    expirationTime: typeof expirationTimeValue === "number" ? expirationTimeValue : null,
    keys: {
      p256dh: requiredString(keys, "p256dh", { min: 40, max: 256 }),
      auth: requiredString(keys, "auth", { min: 8, max: 128 }),
    },
  };
}

export async function getPushConfiguration(
  request: Request,
  bindings: PushBindings,
  context: RequestContext,
): Promise<Response> {
  const user = await authenticate(request, bindings.DB, context);
  logDebug(context, "notification.configuration.read", { userId: user.userId, deviceId: user.deviceId });
  return jsonResponse({ publicKey: bindings.VAPID_PUBLIC_KEY }, context);
}

export async function savePushSubscription(
  request: Request,
  bindings: PushBindings,
  context: RequestContext,
): Promise<Response> {
  const user = await authenticate(request, bindings.DB, context);
  const object = asObject(await readJsonBody(request));
  const subscription = parseSubscription(object.subscription);
  const subscriptionId = crypto.randomUUID();
  await bindings.DB.prepare(
    `INSERT INTO push_subscriptions
       (id, user_id, device_id, endpoint, p256dh, auth, expiration_time, revoked_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       device_id = excluded.device_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       expiration_time = excluded.expiration_time,
       revoked_at = NULL,
       updated_at = excluded.updated_at`,
  ).bind(
    subscriptionId,
    user.userId,
    user.deviceId,
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
    subscription.expirationTime,
    context.now,
  ).run();
  logDebug(context, "notification.subscription.saved", { userId: user.userId, deviceId: user.deviceId });
  return jsonResponse({ subscribed: true }, context);
}

export async function removePushSubscription(
  request: Request,
  bindings: PushBindings,
  context: RequestContext,
): Promise<Response> {
  const user = await authenticate(request, bindings.DB, context);
  const object = asObject(await readJsonBody(request));
  const endpoint = requiredString(object, "endpoint", { min: 20, max: 2048 });
  await bindings.DB.prepare(
    `UPDATE push_subscriptions SET revoked_at = ?1, updated_at = ?1
     WHERE endpoint = ?2 AND user_id = ?3 AND device_id = ?4 AND revoked_at IS NULL`,
  ).bind(context.now, endpoint, user.userId, user.deviceId).run();
  logDebug(context, "notification.subscription.removed", { userId: user.userId, deviceId: user.deviceId });
  return jsonResponse({ subscribed: false }, context);
}

export function scheduleNotificationDelivery(
  runtime: NotificationRuntime | undefined,
  context: RequestContext,
  eventId: string,
): void {
  if (!runtime) return;
  runtime.waitUntil(deliverNotificationEvent(runtime.bindings, context, eventId).catch((error) => {
    logError(context, "notification.delivery.unhandled", error instanceof Error ? error.message : "unknown error", { eventId });
  }));
}

export async function deliverNotificationEvent(
  bindings: PushBindings,
  context: RequestContext,
  eventId: string,
  sendPush: PushSender = sendPushNotification,
): Promise<void> {
  const event = await bindings.DB.prepare(
    "SELECT id, title, body, target_url FROM notification_events WHERE id = ?1",
  ).bind(eventId).first<NotificationEventRow>();
  if (!event) {
    logError(context, "notification.event.missing", "通知事件不存在", { eventId });
    return;
  }

  await bindings.DB.prepare(
    `INSERT OR IGNORE INTO notification_deliveries (event_id, subscription_id, status, updated_at)
     SELECT e.id, ps.id, 'pending', ?2
     FROM notification_events e
     JOIN ledger_members lm ON lm.ledger_id = e.ledger_id
       AND lm.status = 'active' AND lm.user_id <> e.actor_user_id
     JOIN push_subscriptions ps ON ps.user_id = lm.user_id AND ps.revoked_at IS NULL
     WHERE e.id = ?1`,
  ).bind(eventId, context.now).run();

  const pending = await bindings.DB.prepare(
    `SELECT d.subscription_id, ps.endpoint, ps.p256dh, ps.auth
     FROM notification_deliveries d
     JOIN push_subscriptions ps ON ps.id = d.subscription_id AND ps.revoked_at IS NULL
     WHERE d.event_id = ?1 AND d.status = 'pending'`,
  ).bind(eventId).all<PendingDeliveryRow>();

  let failureCount = 0;
  for (let offset = 0; offset < pending.results.length; offset += 8) {
    const results = await Promise.all(pending.results.slice(offset, offset + 8).map((delivery) => (
      deliverToSubscription(bindings, context, event, delivery, sendPush)
    )));
    failureCount += results.filter((delivered) => !delivered).length;
  }

  const completedAt = new Date().toISOString();
  await bindings.DB.prepare(
    `UPDATE notification_events
     SET status = ?1, attempt_count = attempt_count + 1, completed_at = ?2, updated_at = ?2
     WHERE id = ?3`,
  ).bind(failureCount > 0 ? "partial_failure" : "completed", completedAt, eventId).run();
  logDebug(context, "notification.delivery.completed", {
    eventId,
    deliveryCount: pending.results.length,
    failureCount,
  });
}

async function deliverToSubscription(
  bindings: PushBindings,
  context: RequestContext,
  event: NotificationEventRow,
  delivery: PendingDeliveryRow,
  sendPush: PushSender,
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    const delivered = await sendPush(
      { endpoint: delivery.endpoint, keys: { p256dh: delivery.p256dh, auth: delivery.auth } },
      { title: event.title, body: event.body, url: event.target_url, tag: event.id },
      {
        publicKey: bindings.VAPID_PUBLIC_KEY,
        privateKey: bindings.VAPID_PRIVATE_KEY,
        subject: bindings.VAPID_SUBJECT,
      },
      {
        ttl: 60 * 60,
        logger: {
          debug: (message, data) => logDebug(context, "notification.push.debug", {
            eventId: event.id,
            message,
            status: data?.status,
            statusText: data?.statusText,
          }),
        },
      },
    );
    if (delivered) {
      await bindings.DB.prepare(
        `UPDATE notification_deliveries
         SET status = 'sent', sent_at = ?1, last_error = NULL, updated_at = ?1
         WHERE event_id = ?2 AND subscription_id = ?3`,
      ).bind(now, event.id, delivery.subscription_id).run();
      return true;
    }
    await bindings.DB.batch([
      bindings.DB.prepare(
        "UPDATE push_subscriptions SET revoked_at = ?1, updated_at = ?1 WHERE id = ?2",
      ).bind(now, delivery.subscription_id),
      bindings.DB.prepare(
        `UPDATE notification_deliveries SET status = 'invalid', last_error = 'subscription expired', updated_at = ?1
         WHERE event_id = ?2 AND subscription_id = ?3`,
      ).bind(now, event.id, delivery.subscription_id),
    ]);
    return false;
  } catch (error) {
    const message = (error instanceof Error ? error.message : "push delivery failed").slice(0, 500);
    await bindings.DB.prepare(
      `UPDATE notification_deliveries SET status = 'failed', last_error = ?1, updated_at = ?2
       WHERE event_id = ?3 AND subscription_id = ?4`,
    ).bind(message, now, event.id, delivery.subscription_id).run();
    logError(context, "notification.push.failed", message, { eventId: event.id, subscriptionId: delivery.subscription_id });
    return false;
  }
}
