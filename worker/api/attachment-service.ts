import { supportedImageTypes } from "../../lib/image-attachments";
import { authenticate, requireLedgerAccess } from "./auth";
import {
  ApiError,
  jsonResponse,
  logDebug,
  logError,
  requiredString,
  type RequestContext,
} from "./http";

const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9:._-]{8,120}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

interface AttachmentRow {
  id: string;
  ledger_id: string;
  transaction_id: string;
  object_key: string;
  name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export async function uploadAttachment(
  request: Request,
  database: D1Database,
  bucket: R2Bucket,
  context: RequestContext,
  attachmentId: string,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    throw new ApiError(400, "INVALID_ATTACHMENT_ID", "附件标识不正确");
  }
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  const ledgerId = requiredString(query, "ledgerId", { min: 8, max: 120, pattern: ATTACHMENT_ID_PATTERN });
  const transactionId = requiredString(query, "transactionId", { min: 8, max: 120, pattern: ATTACHMENT_ID_PATTERN });
  const name = requiredString(query, "name", { min: 1, max: 120 });
  const sha256 = requiredString(query, "sha256", { min: 64, max: 64, pattern: SHA256_PATTERN });
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const sizeBytes = Number(request.headers.get("content-length") ?? "");
  if (!supportedImageTypes.has(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_ATTACHMENT_TYPE", "当前图片格式不支持");
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new ApiError(413, "ATTACHMENT_TOO_LARGE", "单张图片不能超过 12MB");
  }
  if (!request.body) throw new ApiError(400, "ATTACHMENT_BODY_REQUIRED", "图片内容不能为空");
  await requireLedgerAccess(database, user.userId, ledgerId, "member");

  const existing = await attachmentById(database, attachmentId);
  if (existing) {
    await request.body.cancel("attachment already uploaded");
    assertSameAttachment(existing, { ledgerId, transactionId, name, contentType, sizeBytes, sha256 });
    logDebug(context, "attachment.upload.replayed", { attachmentId, ledgerId, transactionId });
    return jsonResponse({ attachment: attachmentPayload(existing), replayed: true }, context);
  }

  const transaction = await database.prepare(
    "SELECT id FROM transactions WHERE id = ?1 AND ledger_id = ?2 AND deleted_at IS NULL",
  ).bind(transactionId, ledgerId).first<{ id: string }>();
  if (!transaction) throw new ApiError(404, "TRANSACTION_NOT_FOUND", "图片关联的账单不存在");

  const objectKey = `${ledgerId}/${transactionId}/${attachmentId}`;
  try {
    await bucket.put(objectKey, request.body, {
      httpMetadata: { contentType },
      customMetadata: { attachmentId, ledgerId, transactionId },
      sha256,
    });
  } catch (error) {
    logError(context, "attachment.upload.r2_failed", error instanceof Error ? error.message : "unknown", {
      attachmentId,
      ledgerId,
      transactionId,
    });
    throw new ApiError(400, "ATTACHMENT_CHECKSUM_MISMATCH", "图片内容校验失败");
  }

  const payload = { id: attachmentId, ledgerId, transactionId, name, type: contentType, size: sizeBytes, sha256 };
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO transaction_attachments
         (id, ledger_id, transaction_id, object_key, name, content_type, size_bytes, sha256, created_by_user_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(attachmentId, ledgerId, transactionId, objectKey, name, contentType, sizeBytes, sha256, user.userId, context.now),
      database.prepare(
        `INSERT INTO sync_changes
         (ledger_id, entity_type, entity_id, operation_type, entity_version, payload_json,
          changed_by_user_id, operation_id, created_at)
         VALUES (?1, 'attachment', ?2, 'create', 1, ?3, ?4, ?5, ?6)`,
      ).bind(ledgerId, attachmentId, JSON.stringify(payload), user.userId, `attachment-${attachmentId}`, context.now),
    ]);
  } catch (error) {
    const replay = await attachmentById(database, attachmentId);
    if (!replay) throw error;
    assertSameAttachment(replay, { ledgerId, transactionId, name, contentType, sizeBytes, sha256 });
    return jsonResponse({ attachment: attachmentPayload(replay), replayed: true }, context);
  }
  logDebug(context, "attachment.upload.completed", { attachmentId, ledgerId, transactionId, sizeBytes });
  return jsonResponse({ attachment: payload, replayed: false }, context, 201);
}

export async function downloadAttachment(
  request: Request,
  database: D1Database,
  bucket: R2Bucket,
  context: RequestContext,
  attachmentId: string,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    throw new ApiError(400, "INVALID_ATTACHMENT_ID", "附件标识不正确");
  }
  const attachment = await attachmentById(database, attachmentId);
  if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "图片不存在");
  await requireLedgerAccess(database, user.userId, attachment.ledger_id, "viewer");
  const object = await bucket.get(attachment.object_key);
  if (!object?.body) throw new ApiError(404, "ATTACHMENT_CONTENT_MISSING", "图片内容不存在");
  logDebug(context, "attachment.download.completed", {
    attachmentId,
    ledgerId: attachment.ledger_id,
    transactionId: attachment.transaction_id,
  });
  return new Response(object.body, {
    headers: {
      "cache-control": "private, max-age=86400, immutable",
      "content-length": String(attachment.size_bytes),
      "content-type": attachment.content_type,
      etag: object.httpEtag,
      "x-content-type-options": "nosniff",
      "x-request-id": context.requestId,
    },
  });
}

async function attachmentById(database: D1Database, attachmentId: string): Promise<AttachmentRow | null> {
  return database.prepare(
    `SELECT id, ledger_id, transaction_id, object_key, name, content_type, size_bytes, sha256, created_at
     FROM transaction_attachments WHERE id = ?1`,
  ).bind(attachmentId).first<AttachmentRow>();
}

function assertSameAttachment(
  existing: AttachmentRow,
  input: { ledgerId: string; transactionId: string; name: string; contentType: string; sizeBytes: number; sha256: string },
): void {
  if (existing.ledger_id !== input.ledgerId || existing.transaction_id !== input.transactionId ||
      existing.name !== input.name || existing.content_type !== input.contentType ||
      existing.size_bytes !== input.sizeBytes || existing.sha256 !== input.sha256) {
    throw new ApiError(409, "ATTACHMENT_ID_REUSED", "附件标识已用于其他图片");
  }
}

function attachmentPayload(row: AttachmentRow): Record<string, unknown> {
  return {
    id: row.id,
    ledgerId: row.ledger_id,
    transactionId: row.transaction_id,
    name: row.name,
    type: row.content_type,
    size: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}
