import { jsonResponse, logDebug } from "./http";
import type { RequestContext } from "./http";

interface AppMessageRow {
  id: string;
  content: string;
}

export async function randomLaunchMessage(
  database: D1Database,
  context: RequestContext,
): Promise<Response> {
  const message = await database.prepare(
    `SELECT id, content
       FROM app_messages
      WHERE placement = ? AND status = ?
      ORDER BY RANDOM()
      LIMIT 1`,
  ).bind("launch", "active").first<AppMessageRow>();

  logDebug(context, "app.launch_message.selected", { messageId: message?.id ?? null });
  return jsonResponse({ message }, context);
}
