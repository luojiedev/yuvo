"use client";

import { useEffect, useState } from "react";
import type { NetworkSession, RemoteSyncChange } from "../lib/domain";
import { formatMinorAmount } from "../lib/domain";
import { apiRequest } from "../lib/network-api";
import { listSyncIssues, resolveSyncIssue } from "../lib/sync-recovery";
import type { RecoveryChoice, SyncIssue } from "../lib/sync-recovery";

const names = { transaction: "流水", ledger: "预算", category: "分类", subcategory: "子标签", account: "账户", subscription: "订阅" };
const fields: Record<string, string> = { name: "名称", amountMinor: "原币金额", baseAmountMinor: "人民币金额", monthlyBudgetMinor: "月度预算", openingBalanceMinor: "期初余额", categoryName: "分类", accountName: "账户", subcategoryName: "子标签", note: "描述", occurredAt: "发生时间", beneficiary: "使用人", nextChargeOn: "下次扣费日", status: "状态", deletedAt: "删除时间", excludeFromStats: "不参与统计" };

function VersionDetails({ value }: { value: Record<string, unknown> | null }) {
  if (!value) return <p>云端不存在此项目</p>;
  return <dl>{Object.entries(fields).flatMap(([key, label]) => {
    const item = value[key];
    if (item === undefined || item === null || item === "") return [];
    const display = key.endsWith("Minor") && typeof item === "number"
      ? formatMinorAmount(item, key === "amountMinor" ? String(value.currency ?? "CNY") : "CNY")
      : typeof item === "boolean" ? item ? "是" : "否" : String(item);
    return [<div key={key}><dt>{label}</dt><dd>{display}</dd></div>];
  })}</dl>;
}

export function SyncRecovery({ database, session, ledgerId, onClose, onResolved }: {
  database: IDBDatabase; session: NetworkSession; ledgerId: string; onClose: () => void; onResolved: () => Promise<void>;
}) {
  const [issues, setIssues] = useState<SyncIssue[]>([]);
  const [selected, setSelected] = useState<SyncIssue | null>(null);
  const [remote, setRemote] = useState<RemoteSyncChange | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void listSyncIssues(database, ledgerId).then((rows) => { if (active) setIssues(rows); }).catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [database, ledgerId]);

  async function compare(issue: SyncIssue) {
    setSelected(issue); setLoaded(false); setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ ledger_id: ledgerId, entity_type: issue.operation.entityType, entity_id: issue.operation.entityId });
      const response = await apiRequest(`/sync/entity?${query}`, {}, session.token);
      setRemote(response.change as RemoteSyncChange | null); setLoaded(true);
    } catch (reason) {
      console.error("[sync-recovery] cloud comparison failed", { ledgerId, error: reason });
      setError(reason instanceof Error ? reason.message : "无法读取云端版本，请联网后重试");
    } finally { setBusy(false); }
  }

  async function resolve(choice: RecoveryChoice) {
    if (!selected || !loaded || busy) return;
    setBusy(true); setError("");
    try {
      await resolveSyncIssue(database, selected, remote, choice);
      await onResolved();
      setIssues(await listSyncIssues(database, ledgerId)); setSelected(null); setLoaded(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "处理失败，请刷新比较后重试"); }
    finally { setBusy(false); }
  }

  return <div className="ledger-picker-backdrop"><section className="sync-recovery-sheet" role="dialog" aria-modal="true" aria-labelledby="sync-recovery-title">
    <header><h2 id="sync-recovery-title">同步问题</h2><button type="button" disabled={busy} onClick={onClose} aria-label="关闭同步问题">×</button></header>
    <p>处理前会读取云端最新版本。内容填写错误时，请先返回对应页面修改，再重新提交；附件失败可关闭本页后重试同步。</p>
    {issues.length === 0 ? <p>没有需要处理的冲突或失败项目。</p> : issues.map((issue) => <button className="sync-issue-row" type="button" disabled={busy} key={issue.operation.operationId} onClick={() => void compare(issue)}>
      <strong>{names[issue.operation.entityType]} · {String(issue.local.name ?? issue.local.categoryName ?? "待同步项目")}</strong><small>{issue.operation.lastError ?? "需要处理"}</small>
    </button>)}
    {selected ? <article><h3>版本比较</h3><div className="sync-version-columns"><section><h4>本地内容</h4><VersionDetails value={selected.local} /></section><section><h4>云端内容</h4>{loaded ? <VersionDetails value={remote?.payload ?? null} /> : <p>{busy ? "读取中…" : "读取失败，请重新选择项目"}</p>}</section></div>
      <p>采用云端会替换此项目的本地修改；保留副本会新增一笔独立流水，并恢复原流水的云端版本。</p>
      <div className="sync-resolution-actions"><button type="button" disabled={busy || !loaded || (!remote && selected.operation.entityType !== "transaction")} onClick={() => void resolve("remote")}>采用云端</button>
      <button type="button" disabled={busy || !loaded} onClick={() => void resolve("resubmit")}>重新提交本地内容</button>
      {selected.operation.entityType === "transaction" ? <button type="button" disabled={busy || !loaded} onClick={() => void resolve("copy")}>保留本地副本</button> : null}</div>
    </article> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section></div>;
}
