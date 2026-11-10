import type { RequestContext } from "./http";
import { ApiError, logDebug } from "./http";
import { bearerToken, createOpaqueToken, hashToken } from "./security";

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthenticatedUser {
  userId: string;
  username: string;
  displayName: string;
  sessionId: string;
  deviceId: string;
}

interface AuthenticatedUserRow {
  user_id: string;
  username: string;
  display_name: string;
  session_id: string;
  device_id: string;
}

export interface NewSession {
  sessionId: string;
  token: string;
  tokenHash: string;
  expiresAt: string;
}

export async function prepareNewSession(now: string): Promise<NewSession> {
  const token = createOpaqueToken();
  return {
    sessionId: crypto.randomUUID(),
    token,
    tokenHash: await hashToken(token),
    expiresAt: new Date(new Date(now).getTime() + SESSION_DURATION_MS).toISOString(),
  };
}

export function sessionInsertStatement(
  database: D1Database,
  input: { userId: string; deviceId: string; session: NewSession; now: string },
): D1PreparedStatement {
  return database.prepare(
    "INSERT INTO sessions (id, user_id, device_id, token_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(
    input.session.sessionId,
    input.userId,
    input.deviceId,
    input.session.tokenHash,
    input.session.expiresAt,
    input.now,
  );
}

export async function authenticate(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<AuthenticatedUser> {
  const tokenHash = await hashToken(bearerToken(request));
  const row = await database.prepare(
    `SELECT s.id AS session_id, s.user_id, s.device_id, u.username, u.display_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id
     WHERE s.token_hash = ?1
       AND s.revoked_at IS NULL
       AND s.expires_at > ?2
       AND u.status = 'active'
       AND d.revoked_at IS NULL`,
  ).bind(tokenHash, context.now).first<AuthenticatedUserRow>();
  if (!row) throw new ApiError(401, "INVALID_SESSION", "登录已失效，请重新登录");

  logDebug(context, "auth.session.validated", { userId: row.user_id, deviceId: row.device_id });
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    sessionId: row.session_id,
    deviceId: row.device_id,
  };
}

type LedgerRole = "owner" | "admin" | "member" | "viewer";

interface LedgerAccessRow {
  ledger_id: string;
  kind: "private" | "family";
  role: LedgerRole;
}

const ROLE_LEVEL: Record<LedgerRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

export async function requireLedgerAccess(
  database: D1Database,
  userId: string,
  ledgerId: string,
  minimumRole: LedgerRole,
): Promise<LedgerAccessRow> {
  const row = await database.prepare(
    `SELECT l.id AS ledger_id, l.kind, lm.role
     FROM ledger_members lm
     JOIN ledgers l ON l.id = lm.ledger_id
     WHERE lm.ledger_id = ?1 AND lm.user_id = ?2
       AND lm.status = 'active' AND l.archived_at IS NULL`,
  ).bind(ledgerId, userId).first<LedgerAccessRow>();
  if (!row) throw new ApiError(403, "LEDGER_ACCESS_DENIED", "无权访问该账本");
  if (ROLE_LEVEL[row.role] < ROLE_LEVEL[minimumRole]) {
    throw new ApiError(403, "LEDGER_ROLE_DENIED", "当前成员权限不足");
  }
  return row;
}
