import { ApiError } from "./http";

export const PASSWORD_ITERATIONS = 100_000;
const TOKEN_BYTES = 32;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

interface TimingSafeSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(a: BufferSource, b: BufferSource): boolean;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ApiError(400, "INVALID_TOKEN", "令牌格式不正确");
  }
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function createOpaqueToken(): string {
  return bytesToBase64Url(randomBytes(TOKEN_BYTES));
}

export function assertOpaqueToken(value: string): string {
  const bytes = base64UrlToBytes(value);
  if (bytes.byteLength !== TOKEN_BYTES) throw new ApiError(400, "INVALID_TOKEN", "令牌格式不正确");
  return value;
}

export function normalizeUsername(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 40 || !USERNAME_PATTERN.test(normalized)) {
    throw new ApiError(400, "INVALID_USERNAME", "用户名需为 3-40 位小写字母、数字、点、横线或下划线");
  }
  return normalized;
}

export function assertPassword(value: string): string {
  if (value.length < 10 || value.length > 128) {
    throw new ApiError(400, "INVALID_PASSWORD", "密码长度需为 10-128 位");
  }
  return value;
}

export async function createPasswordDigest(password: string): Promise<{ salt: string; hash: string }> {
  const saltBytes = randomBytes(16);
  return { salt: bytesToBase64Url(saltBytes), hash: await derivePasswordHash(password, saltBytes) };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const saltBytes = base64UrlToBytes(salt);
  const actualBytes = base64UrlToBytes(await derivePasswordHash(password, saltBytes));
  const expectedBytes = base64UrlToBytes(expectedHash);
  if (actualBytes.byteLength !== expectedBytes.byteLength) return false;
  const subtle = crypto.subtle as TimingSafeSubtleCrypto;
  return subtle.timingSafeEqual(Uint8Array.from(actualBytes).buffer, Uint8Array.from(expectedBytes).buffer);
}

async function derivePasswordHash(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(salt).buffer, iterations: PASSWORD_ITERATIONS },
    key,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function hashCanonicalValue(value: unknown): Promise<string> {
  return hashToken(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ApiError(400, "INVALID_NUMBER", "数字格式不正确");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new ApiError(400, "INVALID_VALUE", "请求包含不支持的数据类型");
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
  if (!match) throw new ApiError(401, "AUTH_REQUIRED", "请先登录");
  return match[1];
}
