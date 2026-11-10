export const API_PREFIX = "/api/v1";
const MAX_JSON_BODY_BYTES = 256 * 1024;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface RequestContext {
  requestId: string;
  now: string;
}

export function createRequestContext(): RequestContext {
  return { requestId: crypto.randomUUID(), now: new Date().toISOString() };
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "请求内容过大");
  }
  if (!request.body) throw new ApiError(400, "BODY_REQUIRED", "请求内容不能为空");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      await reader.cancel("payload too large");
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "请求内容过大");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求内容不是有效的 JSON");
  }
}

export function jsonResponse(
  payload: Record<string, unknown>,
  context: RequestContext,
  status = 200,
): Response {
  return Response.json(
    { ...payload, requestId: context.requestId },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
        "x-request-id": context.requestId,
      },
    },
  );
}

export function errorResponse(error: unknown, context: RequestContext): Response {
  if (error instanceof ApiError) {
    logError(context, error.code, error.message, { status: error.status, ...error.details });
    return jsonResponse(
      { error: { code: error.code, message: error.message, details: error.details ?? null } },
      context,
      error.status,
    );
  }

  const message = error instanceof Error ? error.message : "unknown error";
  logError(context, "INTERNAL_ERROR", message);
  return jsonResponse(
    { error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试" } },
    context,
    500,
  );
}

export function logDebug(
  context: RequestContext,
  event: string,
  data: Record<string, unknown> = {},
): void {
  console.debug(JSON.stringify({ level: "debug", event, requestId: context.requestId, ...data }));
}

export function logError(
  context: RequestContext,
  event: string,
  message: string,
  data: Record<string, unknown> = {},
): void {
  console.error(JSON.stringify({ level: "error", event, requestId: context.requestId, message, ...data }));
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "请求内容格式不正确");
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  object: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  const value = object[key];
  if (typeof value !== "string") throw new ApiError(400, "INVALID_FIELD", `${key} 格式不正确`);
  const normalized = value.trim();
  const min = options.min ?? 1;
  if (normalized.length < min || (options.max !== undefined && normalized.length > options.max)) {
    throw new ApiError(400, "INVALID_FIELD", `${key} 长度不正确`);
  }
  if (options.pattern && !options.pattern.test(normalized)) {
    throw new ApiError(400, "INVALID_FIELD", `${key} 格式不正确`);
  }
  return normalized;
}

export function optionalString(
  object: Record<string, unknown>,
  key: string,
  max: number,
  fallback = "",
): string {
  const value = object[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.trim().length > max) {
    throw new ApiError(400, "INVALID_FIELD", `${key} 格式不正确`);
  }
  return value.trim();
}

export function requiredInteger(
  object: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number {
  const value = object[key];
  if (!Number.isSafeInteger(value)) throw new ApiError(400, "INVALID_FIELD", `${key} 必须是整数`);
  const numberValue = value as number;
  if ((options.min !== undefined && numberValue < options.min) ||
      (options.max !== undefined && numberValue > options.max)) {
    throw new ApiError(400, "INVALID_FIELD", `${key} 超出允许范围`);
  }
  return numberValue;
}

export function optionalBoolean(object: Record<string, unknown>, key: string): boolean {
  const value = object[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new ApiError(400, "INVALID_FIELD", `${key} 必须是布尔值`);
  return value;
}
