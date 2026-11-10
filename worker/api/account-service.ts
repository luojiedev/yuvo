import { authenticate, prepareNewSession, requireLedgerAccess, sessionInsertStatement } from "./auth";
import { defaultLedgerStatements } from "./defaults";
import {
  ApiError,
  asObject,
  jsonResponse,
  logDebug,
  optionalString,
  readJsonBody,
  requiredString,
  type RequestContext,
} from "./http";
import {
  assertOpaqueToken,
  assertPassword,
  createOpaqueToken,
  createPasswordDigest,
  hashCanonicalValue,
  hashToken,
  normalizeUsername,
  verifyPassword,
} from "./security";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9:._-]+$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9:._-]+$/u;

interface UserCredentialRow {
  id: string;
  username: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  status: "active" | "disabled";
}

interface InvitationRow {
  id: string;
  ledger_id: string;
  ledger_name: string;
  role: "admin" | "member" | "viewer";
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  accepted_by_user_id: string | null;
}

interface StoredOperationRow {
  request_hash: string;
  result_json: string;
}

function deviceIdFrom(object: Record<string, unknown>): string {
  return requiredString(object, "deviceId", { min: 8, max: 80, pattern: DEVICE_ID_PATTERN });
}

function operationIdFrom(object: Record<string, unknown>): string {
  return requiredString(object, "operationId", { min: 16, max: 100, pattern: OPERATION_ID_PATTERN });
}

function displayNameFrom(object: Record<string, unknown>): string {
  return requiredString(object, "displayName", { min: 1, max: 40 });
}

function optionalEntityId(object: Record<string, unknown>, key: string): string | null {
  if (object[key] === undefined || object[key] === null || object[key] === "") return null;
  return requiredString(object, key, { min: 8, max: 120, pattern: OPERATION_ID_PATTERN });
}

function credentialInput(object: Record<string, unknown>) {
  return {
    username: normalizeUsername(requiredString(object, "username", { min: 3, max: 40 })),
    password: assertPassword(requiredString(object, "password", { min: 10, max: 128 })),
    displayName: displayNameFrom(object),
    deviceId: deviceIdFrom(object),
    deviceName: optionalString(object, "deviceName", 40, "浏览器设备") || "浏览器设备",
  };
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/iu.test(error.message);
}

export async function bootstrapStatus(database: D1Database, context: RequestContext): Promise<Response> {
  const row = await database.prepare("SELECT owner_user_id FROM system_state WHERE id = 1").first<{ owner_user_id: string }>();
  return jsonResponse({ initialized: Boolean(row) }, context);
}

export async function bootstrapOwner(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const object = asObject(await readJsonBody(request));
  const credentials = credentialInput(object);
  const password = await createPasswordDigest(credentials.password);
  const session = await prepareNewSession(context.now);
  const userId = crypto.randomUUID();
  const ledgerId = optionalEntityId(object, "privateLedgerId") ?? crypto.randomUUID();

  try {
    await database.batch([
      database.prepare(
        "INSERT INTO users (id, username, display_name, password_salt, password_hash, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)",
      ).bind(userId, credentials.username, credentials.displayName, password.salt, password.hash, context.now),
      database.prepare(
        "INSERT INTO system_state (id, owner_user_id, initialized_at) VALUES (1, ?1, ?2)",
      ).bind(userId, context.now),
      database.prepare(
        "INSERT INTO devices (id, user_id, name, last_selected_ledger_id, last_seen_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
      ).bind(credentials.deviceId, userId, credentials.deviceName, ledgerId, context.now),
      ...defaultLedgerStatements(database, {
        ledgerId,
        ownerUserId: userId,
        name: "我的账本",
        kind: "private",
        now: context.now,
      }),
      sessionInsertStatement(database, { userId, deviceId: credentials.deviceId, session, now: context.now }),
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ApiError(409, "ALREADY_INITIALIZED", "系统已经完成初始化，请直接登录");
    }
    throw error;
  }

  logDebug(context, "account.owner.bootstrapped", { userId, ledgerId, deviceId: credentials.deviceId });
  return jsonResponse(
    {
      user: { id: userId, username: credentials.username, displayName: credentials.displayName },
      session: { token: session.token, expiresAt: session.expiresAt, deviceId: credentials.deviceId },
      selectedLedgerId: ledgerId,
    },
    context,
    201,
  );
}

export async function login(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const object = asObject(await readJsonBody(request));
  const username = normalizeUsername(requiredString(object, "username", { min: 3, max: 40 }));
  const password = assertPassword(requiredString(object, "password", { min: 10, max: 128 }));
  const deviceId = deviceIdFrom(object);
  const deviceName = optionalString(object, "deviceName", 40, "浏览器设备") || "浏览器设备";
  const user = await database.prepare(
    "SELECT id, username, display_name, password_salt, password_hash, status FROM users WHERE username = ?1",
  ).bind(username).first<UserCredentialRow>();
  if (!user || user.status !== "active" || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "用户名或密码不正确");
  }

  const existingDevice = await database.prepare("SELECT user_id FROM devices WHERE id = ?1").bind(deviceId).first<{ user_id: string }>();
  if (existingDevice && existingDevice.user_id !== user.id) {
    throw new ApiError(409, "DEVICE_ID_CONFLICT", "设备标识已被其他账号使用，请重新生成设备标识");
  }
  const session = await prepareNewSession(context.now);
  const statements = existingDevice
    ? [
        database.prepare(
          "UPDATE devices SET name = ?1, last_seen_at = ?2, revoked_at = NULL WHERE id = ?3 AND user_id = ?4",
        ).bind(deviceName, context.now, deviceId, user.id),
      ]
    : [
        database.prepare(
          "INSERT INTO devices (id, user_id, name, last_seen_at, created_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        ).bind(deviceId, user.id, deviceName, context.now),
      ];
  statements.push(sessionInsertStatement(database, { userId: user.id, deviceId, session, now: context.now }));
  await database.batch(statements);

  const selected = await database.prepare(
    `SELECT COALESCE(
       (SELECT last_selected_ledger_id FROM devices WHERE id = ?1),
       (SELECT l.id FROM ledgers l JOIN ledger_members lm ON lm.ledger_id = l.id
        WHERE lm.user_id = ?2 AND lm.status = 'active' AND l.kind = 'private' LIMIT 1)
     ) AS ledger_id`,
  ).bind(deviceId, user.id).first<{ ledger_id: string | null }>();
  logDebug(context, "auth.login.succeeded", { userId: user.id, deviceId });
  return jsonResponse({
    user: { id: user.id, username: user.username, displayName: user.display_name },
    session: { token: session.token, expiresAt: session.expiresAt, deviceId },
    selectedLedgerId: selected?.ledger_id ?? null,
  }, context);
}

export async function logout(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  await database.batch([
    database.prepare("UPDATE sessions SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL")
      .bind(context.now, user.sessionId),
    database.prepare(
      `UPDATE push_subscriptions SET revoked_at = ?1, updated_at = ?1
       WHERE user_id = ?2 AND device_id = ?3 AND revoked_at IS NULL`,
    ).bind(context.now, user.userId, user.deviceId),
  ]);
  logDebug(context, "auth.logout.succeeded", { userId: user.userId, sessionId: user.sessionId });
  return jsonResponse({ success: true }, context);
}

export async function refreshSession(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  const session = await prepareNewSession(context.now);
  await database.batch([
    database.prepare("UPDATE sessions SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL")
      .bind(context.now, user.sessionId),
    sessionInsertStatement(database, { userId: user.userId, deviceId: user.deviceId, session, now: context.now }),
    database.prepare("UPDATE devices SET last_seen_at = ?1 WHERE id = ?2 AND user_id = ?3")
      .bind(context.now, user.deviceId, user.userId),
  ]);
  logDebug(context, "auth.session.refreshed", { userId: user.userId, deviceId: user.deviceId });
  return jsonResponse({
    user: { id: user.userId, username: user.username, displayName: user.displayName },
    session: { token: session.token, expiresAt: session.expiresAt, deviceId: user.deviceId },
  }, context);
}

export async function getMe(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  return jsonResponse({
    user: { id: user.userId, username: user.username, displayName: user.displayName },
    deviceId: user.deviceId,
  }, context);
}

export async function updateMe(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  const object = asObject(await readJsonBody(request));
  const displayName = displayNameFrom(object);
  if (displayName === user.displayName) {
    return jsonResponse({ user: { id: user.userId, username: user.username, displayName } }, context);
  }

  const operationPrefix = `profile-${crypto.randomUUID()}`;
  const payload = JSON.stringify({ userId: user.userId, displayName });
  await database.batch([
    database.prepare("UPDATE users SET display_name = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(displayName, context.now, user.userId),
    database.prepare(
      `INSERT INTO sync_changes
       (ledger_id, entity_type, entity_id, operation_type, entity_version, payload_json,
        changed_by_user_id, operation_id, created_at)
       SELECT lm.ledger_id, 'profile', ?1, 'update', 1, ?2, ?1, ?3 || ':' || lm.ledger_id, ?4
       FROM ledger_members lm WHERE lm.user_id = ?1 AND lm.status = 'active'`,
    ).bind(user.userId, payload, operationPrefix, context.now),
  ]);
  logDebug(context, "account.profile.updated", { userId: user.userId, displayName });
  return jsonResponse({ user: { id: user.userId, username: user.username, displayName } }, context);
}

export async function listLedgers(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  const rows = await database.prepare(
    `SELECT l.id, l.name, l.kind, l.base_currency, l.monthly_budget_minor, l.version, lm.role, l.updated_at,
            (SELECT COUNT(*) FROM ledger_members active_members
             WHERE active_members.ledger_id = l.id AND active_members.status = 'active') AS member_count
     FROM ledger_members lm
     JOIN ledgers l ON l.id = lm.ledger_id
     WHERE lm.user_id = ?1 AND lm.status = 'active' AND l.archived_at IS NULL
     ORDER BY CASE l.kind WHEN 'family' THEN 0 ELSE 1 END, l.updated_at DESC`,
  ).bind(user.userId).all();
  return jsonResponse({ ledgers: rows.results }, context);
}

export async function createPrivateLedger(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  const object = asObject(await readJsonBody(request));
  const name = requiredString(object, "name", { min: 1, max: 20 });
  const ledgerId = requiredString(object, "ledgerId", { min: 8, max: 120, pattern: OPERATION_ID_PATTERN });
  // The client-generated ledger ID is the idempotency key, including when bootstrap created it.
  const existingResponse = async (): Promise<Response | null> => {
    const existing = await database.prepare("SELECT id, name, kind, owner_user_id FROM ledgers WHERE id = ?1")
      .bind(ledgerId).first<{ id: string; name: string; kind: string; owner_user_id: string }>();
    if (!existing) return null;
    if (existing.owner_user_id !== user.userId || existing.kind !== "private") {
      throw new ApiError(409, "LEDGER_OWNERSHIP_CONFLICT", "此账本不能绑定到当前账号，本机数据已保留");
    }
    logDebug(context, "ledger.private.registration.replayed", { userId: user.userId, ledgerId });
    return jsonResponse({ ledger: { id: existing.id, name: existing.name, kind: "private", role: "owner" } }, context);
  };
  const existing = await existingResponse();
  if (existing) return existing;
  try {
    await database.batch(defaultLedgerStatements(database, { ledgerId, ownerUserId: user.userId, name, kind: "private", now: context.now }));
  } catch (error) {
    if (isConstraintError(error)) {
      const replay = await existingResponse();
      if (replay) return replay;
    }
    throw error;
  }
  logDebug(context, "ledger.private.created", { userId: user.userId, ledgerId });
  return jsonResponse({ ledger: { id: ledgerId, name, kind: "private", role: "owner" } }, context, 201);
}

export async function createFamilyLedger(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  const object = asObject(await readJsonBody(request));
  const name = requiredString(object, "name", { min: 1, max: 30 });
  const operationId = operationIdFrom(object);
  const ledgerId = requiredString(object, "ledgerId", { min: 8, max: 120, pattern: OPERATION_ID_PATTERN });
  const requestHash = await hashCanonicalValue({ operationId, name, ledgerId });
  const existing = await database.prepare(
    "SELECT request_hash, result_json FROM sync_operations WHERE operation_id = ?1",
  ).bind(operationId).first<StoredOperationRow>();
  if (existing) return storedOperationResponse(existing, requestHash, context);

  const result = { ledger: { id: ledgerId, name, kind: "family", role: "owner" } };
  try {
    await database.batch([
      ...defaultLedgerStatements(database, { ledgerId, ownerUserId: user.userId, name, kind: "family", now: context.now }),
      database.prepare(
        "INSERT INTO sync_operations (operation_id, user_id, device_id, ledger_id, request_hash, entity_type, entity_id, operation_type, result_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'ledger', ?4, 'create', ?6, ?7)",
      ).bind(operationId, user.userId, user.deviceId, ledgerId, requestHash, JSON.stringify(result), context.now),
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      const replay = await database.prepare(
        "SELECT request_hash, result_json FROM sync_operations WHERE operation_id = ?1",
      ).bind(operationId).first<StoredOperationRow>();
      if (replay) return storedOperationResponse(replay, requestHash, context);
    }
    throw error;
  }
  logDebug(context, "ledger.family.created", { userId: user.userId, ledgerId, operationId });
  return jsonResponse(result, context, 201);
}

export async function createInvitation(
  request: Request,
  database: D1Database,
  context: RequestContext,
  ledgerId: string,
): Promise<Response> {
  const user = await authenticate(request, database, context);
  const access = await requireLedgerAccess(database, user.userId, ledgerId, "admin");
  if (access.kind !== "family") throw new ApiError(400, "PRIVATE_LEDGER_INVITE_DENIED", "私人账本不能邀请成员");
  const object = asObject(await readJsonBody(request));
  const operationId = operationIdFrom(object);
  const inviteToken = assertOpaqueToken(requiredString(object, "inviteToken", { min: 43, max: 43 }));
  const roleValue = optionalString(object, "role", 10, "admin");
  if (!(["admin", "member", "viewer"] as const).includes(roleValue as "admin" | "member" | "viewer")) {
    throw new ApiError(400, "INVALID_ROLE", "邀请角色不正确");
  }
  const role = roleValue as "admin" | "member" | "viewer";
  const expiresInHoursValue = object.expiresInHours ?? 72;
  if (!Number.isSafeInteger(expiresInHoursValue) || (expiresInHoursValue as number) < 1 || (expiresInHoursValue as number) > 168) {
    throw new ApiError(400, "INVALID_EXPIRY", "邀请有效期需为 1-168 小时");
  }
  const expiresAt = new Date(new Date(context.now).getTime() + (expiresInHoursValue as number) * 60 * 60 * 1000).toISOString();
  const requestHash = await hashCanonicalValue({ operationId, inviteToken, role, expiresInHours: expiresInHoursValue });
  const existing = await database.prepare(
    "SELECT request_hash, result_json FROM sync_operations WHERE operation_id = ?1",
  ).bind(operationId).first<StoredOperationRow>();
  if (existing) return storedOperationResponse(existing, requestHash, context, { inviteToken });

  const invitationId = crypto.randomUUID();
  const tokenHash = await hashToken(inviteToken);
  const storedResult = { invitation: { id: invitationId, ledgerId, role, expiresAt } };
  try {
    await database.batch([
      database.prepare(
        "INSERT INTO ledger_invitations (id, ledger_id, token_hash, role, status, invited_by_user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7)",
      ).bind(invitationId, ledgerId, tokenHash, role, user.userId, expiresAt, context.now),
      database.prepare(
        "INSERT INTO sync_operations (operation_id, user_id, device_id, ledger_id, request_hash, entity_type, entity_id, operation_type, result_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'invitation', ?6, 'create', ?7, ?8)",
      ).bind(operationId, user.userId, user.deviceId, ledgerId, requestHash, invitationId, JSON.stringify(storedResult), context.now),
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      const replay = await database.prepare(
        "SELECT request_hash, result_json FROM sync_operations WHERE operation_id = ?1",
      ).bind(operationId).first<StoredOperationRow>();
      if (replay) return storedOperationResponse(replay, requestHash, context, { inviteToken });
      throw new ApiError(409, "INVITATION_TOKEN_CONFLICT", "邀请令牌已经使用，请重新生成");
    }
    throw error;
  }
  logDebug(context, "ledger.invitation.created", { userId: user.userId, ledgerId, invitationId, role });
  return jsonResponse({ ...storedResult, inviteToken }, context, 201);
}

export async function acceptInvitation(
  request: Request,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const object = asObject(await readJsonBody(request));
  const inviteToken = assertOpaqueToken(requiredString(object, "inviteToken", { min: 43, max: 43 }));
  const credentials = credentialInput(object);
  const tokenHash = await hashToken(inviteToken);
  const invitation = await database.prepare(
    `SELECT i.id, i.ledger_id, l.name AS ledger_name, i.role, i.status, i.expires_at, i.accepted_by_user_id
     FROM ledger_invitations i JOIN ledgers l ON l.id = i.ledger_id WHERE i.token_hash = ?1`,
  ).bind(tokenHash).first<InvitationRow>();
  if (!invitation || invitation.status === "revoked") {
    throw new ApiError(404, "INVITATION_NOT_FOUND", "邀请不存在或已撤销");
  }
  if (invitation.expires_at <= context.now && invitation.status === "pending") {
    await database.prepare("UPDATE ledger_invitations SET status = 'expired' WHERE id = ?1 AND status = 'pending'")
      .bind(invitation.id).run();
    throw new ApiError(410, "INVITATION_EXPIRED", "邀请已经过期");
  }
  if (invitation.status === "expired") throw new ApiError(410, "INVITATION_EXPIRED", "邀请已经过期");

  if (invitation.status === "accepted") {
    return replayAcceptedInvitation(credentials, invitation, database, context);
  }

  const existingUser = await database.prepare(
    "SELECT id, username, display_name, password_salt, password_hash, status FROM users WHERE username = ?1",
  ).bind(credentials.username).first<UserCredentialRow>();
  if (existingUser) throw new ApiError(409, "USERNAME_TAKEN", "用户名已存在，请登录后再接受邀请");

  const userId = crypto.randomUUID();
  const privateLedgerId = optionalEntityId(object, "privateLedgerId") ?? crypto.randomUUID();
  const [existingDevice, existingPrivateLedger] = await Promise.all([
    database.prepare("SELECT user_id FROM devices WHERE id = ?1")
      .bind(credentials.deviceId).first<{ user_id: string }>(),
    database.prepare("SELECT owner_user_id FROM ledgers WHERE id = ?1")
      .bind(privateLedgerId).first<{ owner_user_id: string }>(),
  ]);
  if (existingDevice) {
    throw new ApiError(409, "DEVICE_ID_CONFLICT", "设备标识已被其他账号使用", { conflictField: "deviceId" });
  }
  if (existingPrivateLedger) {
    throw new ApiError(409, "PRIVATE_LEDGER_ID_CONFLICT", "本地账本标识已被使用，请刷新页面后重试", {
      conflictField: "privateLedgerId",
    });
  }
  const password = await createPasswordDigest(credentials.password);
  const session = await prepareNewSession(context.now);
  try {
    await database.batch([
      database.prepare(
        "INSERT INTO invitation_acceptances (invitation_id, accepted_by_user_id, accepted_at) VALUES (?1, ?2, ?3)",
      ).bind(invitation.id, userId, context.now),
      database.prepare(
        "INSERT INTO users (id, username, display_name, password_salt, password_hash, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)",
      ).bind(userId, credentials.username, credentials.displayName, password.salt, password.hash, context.now),
      database.prepare(
        "INSERT INTO devices (id, user_id, name, last_selected_ledger_id, last_seen_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
      ).bind(credentials.deviceId, userId, credentials.deviceName, invitation.ledger_id, context.now),
      ...defaultLedgerStatements(database, {
        ledgerId: privateLedgerId,
        ownerUserId: userId,
        name: "我的账本",
        kind: "private",
        now: context.now,
      }),
      database.prepare(
        "INSERT INTO ledger_members (ledger_id, user_id, role, status, version, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', 1, ?4, ?4)",
      ).bind(invitation.ledger_id, userId, invitation.role, context.now),
      database.prepare(
        "UPDATE ledger_invitations SET status = 'accepted', accepted_by_user_id = ?1, accepted_at = ?2 WHERE id = ?3 AND status = 'pending'",
      ).bind(userId, context.now, invitation.id),
      sessionInsertStatement(database, { userId, deviceId: credentials.deviceId, session, now: context.now }),
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      const refreshed = await database.prepare(
        `SELECT i.id, i.ledger_id, l.name AS ledger_name, i.role, i.status, i.expires_at, i.accepted_by_user_id
         FROM ledger_invitations i JOIN ledgers l ON l.id = i.ledger_id WHERE i.id = ?1`,
      ).bind(invitation.id).first<InvitationRow>();
      if (refreshed?.status === "accepted") return replayAcceptedInvitation(credentials, refreshed, database, context);
      const [conflictingUser, conflictingDevice, conflictingPrivateLedger] = await Promise.all([
        database.prepare("SELECT id FROM users WHERE username = ?1")
          .bind(credentials.username).first<{ id: string }>(),
        database.prepare("SELECT user_id FROM devices WHERE id = ?1")
          .bind(credentials.deviceId).first<{ user_id: string }>(),
        database.prepare("SELECT owner_user_id FROM ledgers WHERE id = ?1")
          .bind(privateLedgerId).first<{ owner_user_id: string }>(),
      ]);
      if (conflictingUser) throw new ApiError(409, "USERNAME_TAKEN", "用户名已存在，请登录后再接受邀请");
      if (conflictingDevice) {
        throw new ApiError(409, "DEVICE_ID_CONFLICT", "设备标识已被其他账号使用", { conflictField: "deviceId" });
      }
      if (conflictingPrivateLedger) {
        throw new ApiError(409, "PRIVATE_LEDGER_ID_CONFLICT", "本地账本标识已被使用，请刷新页面后重试", {
          conflictField: "privateLedgerId",
        });
      }
      throw new ApiError(409, "REGISTRATION_CONFLICT", "注册信息发生冲突，请重试");
    }
    throw error;
  }

  logDebug(context, "ledger.invitation.accepted", { userId, ledgerId: invitation.ledger_id, invitationId: invitation.id });
  return jsonResponse({
    user: { id: userId, username: credentials.username, displayName: credentials.displayName },
    session: { token: session.token, expiresAt: session.expiresAt, deviceId: credentials.deviceId },
    selectedLedgerId: invitation.ledger_id,
    privateLedgerId,
    joinedLedger: { id: invitation.ledger_id, name: invitation.ledger_name, role: invitation.role },
    replayed: false,
  }, context, 201);
}

async function replayAcceptedInvitation(
  credentials: ReturnType<typeof credentialInput>,
  invitation: InvitationRow,
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const user = await database.prepare(
    "SELECT id, username, display_name, password_salt, password_hash, status FROM users WHERE username = ?1",
  ).bind(credentials.username).first<UserCredentialRow>();
  if (!user || user.id !== invitation.accepted_by_user_id ||
      !(await verifyPassword(credentials.password, user.password_salt, user.password_hash))) {
    throw new ApiError(409, "INVITATION_ALREADY_ACCEPTED", "邀请已经被其他账号接受");
  }
  const device = await database.prepare("SELECT user_id FROM devices WHERE id = ?1").bind(credentials.deviceId).first<{ user_id: string }>();
  if (device && device.user_id !== user.id) throw new ApiError(409, "DEVICE_ID_CONFLICT", "设备标识已被其他账号使用");
  const session = await prepareNewSession(context.now);
  const statements = device
    ? [database.prepare("UPDATE devices SET name = ?1, last_selected_ledger_id = ?2, last_seen_at = ?3, revoked_at = NULL WHERE id = ?4 AND user_id = ?5")
        .bind(credentials.deviceName, invitation.ledger_id, context.now, credentials.deviceId, user.id)]
    : [database.prepare("INSERT INTO devices (id, user_id, name, last_selected_ledger_id, last_seen_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)")
        .bind(credentials.deviceId, user.id, credentials.deviceName, invitation.ledger_id, context.now)];
  statements.push(sessionInsertStatement(database, { userId: user.id, deviceId: credentials.deviceId, session, now: context.now }));
  await database.batch(statements);
  return jsonResponse({
    user: { id: user.id, username: user.username, displayName: user.display_name },
    session: { token: session.token, expiresAt: session.expiresAt, deviceId: credentials.deviceId },
    selectedLedgerId: invitation.ledger_id,
    joinedLedger: { id: invitation.ledger_id, name: invitation.ledger_name, role: invitation.role },
    replayed: true,
  }, context);
}

function storedOperationResponse(
  existing: StoredOperationRow,
  requestHash: string,
  context: RequestContext,
  extra: Record<string, unknown> = {},
): Response {
  if (existing.request_hash !== requestHash) {
    throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "operationId 已用于其他请求");
  }
  const parsed = JSON.parse(existing.result_json) as Record<string, unknown>;
  return jsonResponse({ ...parsed, ...extra, replayed: true }, context);
}

export function newInvitationToken(): string {
  return createOpaqueToken();
}
