import type { NetworkSession, TransactionImageAttachment } from "./domain";
import { createId } from "./domain";
import { isDemoMode } from "./app-mode";

const API_PREFIX = "/api/v1";
const DEVICE_ID_STORAGE_KEY_PREFIX = "swift-ledger.device-id";

export const defaultLaunchMessage = "记下生活的每一笔，让日常更有条理。";

export class NetworkApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "NetworkApiError";
    this.status = status;
    this.code = code;
  }
}

export interface AccountCredentials {
  username: string;
  password: string;
  displayName?: string;
}

export interface RemoteLedger {
  id: string;
  name: string;
  kind: "private" | "family";
  base_currency: string;
  monthly_budget_minor: number;
  version: number;
  role: "owner" | "admin" | "member" | "viewer";
  member_count: number;
}

export interface SerializedPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export interface ExchangeRateQuote {
  base: "USD";
  quote: "CNY";
  rateMicros: number;
  rateDate: string;
  source: "frankfurter";
  fetchedAt: string;
}

export async function fetchUsdCnyExchangeRate(): Promise<ExchangeRateQuote> {
  const response = await apiRequest("/exchange-rates/USD/CNY", { cache: "no-store" });
  const rateMicros = Number(response.rateMicros);
  if (!Number.isSafeInteger(rateMicros) || rateMicros <= 0) throw new Error("汇率服务返回的数据不正确");
  return {
    base: "USD",
    quote: "CNY",
    rateMicros,
    rateDate: stringValue(response.rateDate),
    source: "frankfurter",
    fetchedAt: stringValue(response.fetchedAt),
  };
}

export function getOrCreateDeviceId(username: string): string {
  const storageKey = `${DEVICE_ID_STORAGE_KEY_PREFIX}.${username.trim().toLowerCase()}`;
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const created = `device-${createId()}`;
    localStorage.setItem(storageKey, created);
    return created;
  } catch (error) {
    console.error("[network] device identifier persistence failed", error);
    return `device-${createId()}`;
  }
}

export async function getBootstrapStatus(): Promise<boolean> {
  const response = await apiRequest("/bootstrap/status");
  return response.initialized === true;
}

export async function fetchLaunchMessage(): Promise<string> {
  const response = await apiRequest(
    `/app/launch-message?request=${encodeURIComponent(createId())}`,
    { cache: "no-store" },
  );
  return stringValue(objectValue(response.message).content, defaultLaunchMessage);
}

export async function bootstrapAccount(
  credentials: Required<AccountCredentials>,
  privateLedgerId: string,
): Promise<{ session: NetworkSession; selectedLedgerId: string }> {
  const deviceId = getOrCreateDeviceId(credentials.username);
  const response = await apiRequest("/bootstrap", {
    method: "POST",
    body: JSON.stringify({ ...credentials, privateLedgerId, deviceId, deviceName: browserDeviceName() }),
  });
  return sessionResult(response, credentials.username, credentials.displayName, deviceId);
}

export async function loginAccount(
  credentials: Pick<AccountCredentials, "username" | "password">,
): Promise<{ session: NetworkSession; selectedLedgerId: string | null }> {
  const deviceId = getOrCreateDeviceId(credentials.username);
  const response = await apiRequest("/auth/login", {
    method: "POST",
    body: JSON.stringify({ ...credentials, deviceId, deviceName: browserDeviceName() }),
  });
  const user = objectValue(response.user);
  return sessionResult(
    response,
    stringValue(user.username),
    stringValue(user.displayName),
    deviceId,
  );
}

export async function acceptAccountInvitation(
  credentials: Required<AccountCredentials>,
  inviteToken: string,
  privateLedgerId: string,
): Promise<{ session: NetworkSession; selectedLedgerId: string }> {
  const deviceId = getOrCreateDeviceId(credentials.username);
  const response = await apiRequest("/invitations/accept", {
    method: "POST",
    body: JSON.stringify({
      ...credentials,
      inviteToken: inviteToken.trim(),
      privateLedgerId,
      deviceId,
      deviceName: browserDeviceName(),
    }),
  });
  return sessionResult(response, credentials.username, credentials.displayName, deviceId);
}

export async function logoutAccount(token: string): Promise<void> {
  await apiRequest("/auth/logout", { method: "POST" }, token);
}

export async function refreshAccountSession(current: NetworkSession): Promise<NetworkSession> {
  const response = await apiRequest("/auth/refresh", { method: "POST" }, current.token);
  return sessionResult(response, current.username, current.displayName, current.deviceId).session;
}

export async function updateAccountDisplayName(token: string, displayName: string): Promise<string> {
  const response = await apiRequest("/me", {
    method: "PUT",
    body: JSON.stringify({ displayName: displayName.trim() }),
  }, token);
  return stringValue(objectValue(response.user).displayName);
}

export async function fetchPushPublicKey(token: string): Promise<string> {
  const response = await apiRequest("/push/configuration", {}, token);
  return stringValue(response.publicKey);
}

export async function saveRemotePushSubscription(
  token: string,
  subscription: SerializedPushSubscription,
): Promise<void> {
  await apiRequest("/push/subscription", {
    method: "PUT",
    body: JSON.stringify({ subscription }),
  }, token);
}

export async function removeRemotePushSubscription(token: string, endpoint: string): Promise<void> {
  await apiRequest("/push/subscription", {
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  }, token);
}

export async function fetchRemoteLedgers(token: string, signal?: AbortSignal): Promise<RemoteLedger[]> {
  const response = await apiRequest("/ledgers", { signal }, token);
  return Array.isArray(response.ledgers) ? response.ledgers as RemoteLedger[] : [];
}

export async function fetchRemoteLedgerSnapshot(
  token: string,
  ledgerId: string,
): Promise<Record<string, unknown>> {
  const snapshot = await apiRequest(`/ledgers/${encodeURIComponent(ledgerId)}/snapshot`, {}, token);
  const attachments = Array.isArray(snapshot.attachments)
    ? snapshot.attachments.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    : [];
  for (let index = 0; index < attachments.length; index += 4) {
    await Promise.all(attachments.slice(index, index + 4).map(async (attachment) => {
      const id = stringValue(attachment.id);
      if (!id) return;
      try {
        attachment.blob = await downloadAttachmentBlob(token, id);
      } catch (error) {
        console.error("[network] snapshot attachment download failed", { attachmentId: id, error });
      }
    }));
  }
  return snapshot;
}

export async function uploadTransactionAttachment(
  token: string,
  ledgerId: string,
  transactionId: string,
  attachment: TransactionImageAttachment & { blob: Blob },
): Promise<void> {
  const sha256 = await sha256Hex(await attachment.blob.arrayBuffer());
  const query = new URLSearchParams({
    ledgerId,
    transactionId,
    name: attachment.name,
    sha256,
  });
  const response = await rawApiRequest(
    `/attachments/${encodeURIComponent(attachment.id)}?${query.toString()}`,
    {
      method: "PUT",
      headers: { "content-type": attachment.type },
      body: attachment.blob,
    },
    token,
  );
  await response.json();
}

export async function downloadAttachmentBlob(token: string, attachmentId: string): Promise<Blob> {
  const response = await rawApiRequest(
    `/attachments/${encodeURIComponent(attachmentId)}/content`,
    {},
    token,
  );
  return response.blob();
}

export async function createRemoteFamilyLedger(
  token: string,
  input: { ledgerId: string; name: string; operationId: string },
): Promise<RemoteLedger> {
  const response = await apiRequest("/ledgers", { method: "POST", body: JSON.stringify(input) }, token);
  return response.ledger as RemoteLedger;
}

export async function registerRemotePrivateLedger(token: string, ledger: { id: string; name: string }): Promise<void> {
  await apiRequest("/ledgers/private", { method: "POST", body: JSON.stringify({ ledgerId: ledger.id, name: ledger.name }) }, token);
}

export async function createRemoteInvitation(
  token: string,
  ledgerId: string,
): Promise<{ inviteToken: string; expiresAt: string }> {
  const inviteToken = randomToken();
  const response = await apiRequest(`/ledgers/${encodeURIComponent(ledgerId)}/invitations`, {
    method: "POST",
    body: JSON.stringify({
      operationId: createId(),
      inviteToken,
      role: "admin",
      expiresInHours: 72,
    }),
  }, token);
  const invitation = objectValue(response.invitation);
  return { inviteToken, expiresAt: stringValue(invitation.expiresAt) };
}

export async function apiRequest(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  const response = await rawApiRequest(path, { ...init, headers }, token);
  const payload = await response.json() as Record<string, unknown>;
  return payload;
}

async function rawApiRequest(path: string, init: RequestInit, token?: string): Promise<Response> {
  if (isDemoMode) {
    console.debug("[network] cloud request skipped in local-only demo", { path });
    throw new NetworkApiError(0, "DEMO_LOCAL_ONLY", "在线体验仅使用本机数据；云同步和自动汇率请自行部署后使用。");
  }
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, { ...init, headers });
  } catch (error) {
    console.error("[network] request failed", { path, error });
    throw new NetworkApiError(0, "NETWORK_UNAVAILABLE", "网络不可用，数据会在恢复联网后自动同步");
  }
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json() as Record<string, unknown>
      : {};
    const error = objectValue(payload.error);
    throw new NetworkApiError(response.status, stringValue(error.code, "REQUEST_FAILED"), stringValue(error.message, "请求失败"));
  }
  return response;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sessionResult(
  response: Record<string, unknown>,
  username: string,
  displayName: string,
  deviceId: string,
): { session: NetworkSession; selectedLedgerId: string } {
  const user = objectValue(response.user);
  const session = objectValue(response.session);
  return {
    session: {
      key: "current",
      token: stringValue(session.token),
      expiresAt: stringValue(session.expiresAt),
      userId: stringValue(user.id),
      username: stringValue(user.username, username),
      displayName: stringValue(user.displayName, displayName),
      deviceId,
    },
    selectedLedgerId: stringValue(response.selectedLedgerId),
  };
}

function browserDeviceName(): string {
  if (typeof navigator === "undefined") return "浏览器设备";
  if (/iPhone|iPad/iu.test(navigator.userAgent)) return "iPhone / iPad";
  if (/Android/iu.test(navigator.userAgent)) return "Android 设备";
  return "浏览器设备";
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
