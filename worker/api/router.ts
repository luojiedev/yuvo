import {
  acceptInvitation,
  bootstrapOwner,
  bootstrapStatus,
  createFamilyLedger,
  createPrivateLedger,
  createInvitation,
  getMe,
  listLedgers,
  login,
  logout,
  refreshSession,
  updateMe,
} from "./account-service";
import { downloadAttachment, uploadAttachment } from "./attachment-service";
import { getExchangeRate } from "./exchange-rate-service";
import { randomLaunchMessage } from "./app-content-service";
import {
  API_PREFIX,
  ApiError,
  createRequestContext,
  errorResponse,
  jsonResponse,
  logDebug,
} from "./http";
import { ledgerSnapshot, pullChanges, pushOperations, readSyncEntity, selectLedger, transactionCreators } from "./sync-service";
import {
  getPushConfiguration,
  removePushSubscription,
  savePushSubscription,
  type NotificationRuntime,
} from "./notification-service";

export type ApiBindings = Pick<
  Env,
  "DB" | "ATTACHMENTS" | "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT"
>;

export async function handleApiRequest(
  request: Request,
  env: ApiBindings,
  notificationRuntime?: NotificationRuntime,
): Promise<Response> {
  const context = createRequestContext();
  const url = new URL(request.url);
  try {
    if (!url.pathname.startsWith(API_PREFIX)) {
      throw new ApiError(404, "NOT_FOUND", "接口不存在");
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "DELETE, GET, POST, PUT, OPTIONS",
          "access-control-allow-origin": url.origin,
          "access-control-max-age": "600",
          vary: "origin",
        },
      });
    }

    logDebug(context, "api.request.started", { method: request.method, path: url.pathname });
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/health`) {
      const database = await env.DB.prepare("SELECT 1 AS healthy").first<{ healthy: number }>();
      return jsonResponse({ status: database?.healthy === 1 ? "ok" : "degraded" }, context);
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/app/launch-message`) {
      return await randomLaunchMessage(env.DB, context);
    }
    if (request.method === "GET" && url.pathname.startsWith(`${API_PREFIX}/exchange-rates/`)) {
      return await getExchangeRate(request, context);
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/bootstrap/status`) {
      return await bootstrapStatus(env.DB, context);
    }
    if (request.method === "POST" && url.pathname === `${API_PREFIX}/bootstrap`) {
      return await bootstrapOwner(request, env.DB, context);
    }
    if (request.method === "POST" && url.pathname === `${API_PREFIX}/auth/login`) {
      return await login(request, env.DB, context);
    }
    if (request.method === "POST" && url.pathname === `${API_PREFIX}/auth/logout`) {
      return await logout(request, env.DB, context);
    }
    if (request.method === "POST" && url.pathname === `${API_PREFIX}/auth/refresh`) {
      return await refreshSession(request, env.DB, context);
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/me`) {
      return await getMe(request, env.DB, context);
    }
    if (request.method === "PUT" && url.pathname === `${API_PREFIX}/me`) {
      return await updateMe(request, env.DB, context);
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/push/configuration`) {
      return await getPushConfiguration(request, env, context);
    }
    if (request.method === "PUT" && url.pathname === `${API_PREFIX}/push/subscription`) {
      return await savePushSubscription(request, env, context);
    }
    if (request.method === "DELETE" && url.pathname === `${API_PREFIX}/push/subscription`) {
      return await removePushSubscription(request, env, context);
    }
    if (request.method === "POST" && url.pathname === `${API_PREFIX}/invitations/accept`) {
      return await acceptInvitation(request, env.DB, context);
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/ledgers`) {
      return await listLedgers(request, env.DB, context);
    }
    if (request.method === "POST" && url.pathname === `${API_PREFIX}/ledgers`) {
      return await createFamilyLedger(request, env.DB, context);
    }
    if (request.method === "POST" && url.pathname === `${API_PREFIX}/ledgers/private`) {
      return await createPrivateLedger(request, env.DB, context);
    }
    if (request.method === "POST" && url.pathname === `${API_PREFIX}/sync/push`) {
      return await pushOperations(request, env.DB, context, notificationRuntime);
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/sync/pull`) {
      return await pullChanges(request, env.DB, context);
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/sync/entity`) {
      return await readSyncEntity(request, env.DB, context);
    }

    const invitationMatch = new RegExp(`^${API_PREFIX}/ledgers/([^/]+)/invitations$`, "u").exec(url.pathname);
    if (request.method === "POST" && invitationMatch) {
      return await createInvitation(request, env.DB, context, decodeURIComponent(invitationMatch[1]));
    }
    const snapshotMatch = new RegExp(`^${API_PREFIX}/ledgers/([^/]+)/snapshot$`, "u").exec(url.pathname);
    if (request.method === "GET" && snapshotMatch) {
      return await ledgerSnapshot(request, env.DB, context, decodeURIComponent(snapshotMatch[1]));
    }
    const transactionCreatorsMatch = new RegExp(`^${API_PREFIX}/ledgers/([^/]+)/transaction-creators$`, "u").exec(url.pathname);
    if (request.method === "GET" && transactionCreatorsMatch) {
      return await transactionCreators(request, env.DB, context, decodeURIComponent(transactionCreatorsMatch[1]));
    }
    const selectMatch = new RegExp(`^${API_PREFIX}/ledgers/([^/]+)/select$`, "u").exec(url.pathname);
    if (request.method === "POST" && selectMatch) {
      return await selectLedger(request, env.DB, context, decodeURIComponent(selectMatch[1]));
    }
    const attachmentContentMatch = new RegExp(`^${API_PREFIX}/attachments/([^/]+)/content$`, "u").exec(url.pathname);
    if (request.method === "GET" && attachmentContentMatch) {
      return await downloadAttachment(request, env.DB, env.ATTACHMENTS, context, decodeURIComponent(attachmentContentMatch[1]));
    }
    const attachmentMatch = new RegExp(`^${API_PREFIX}/attachments/([^/]+)$`, "u").exec(url.pathname);
    if (request.method === "PUT" && attachmentMatch) {
      return await uploadAttachment(request, env.DB, env.ATTACHMENTS, context, decodeURIComponent(attachmentMatch[1]));
    }
    throw new ApiError(404, "NOT_FOUND", "接口不存在");
  } catch (error) {
    return errorResponse(error, context);
  }
}
