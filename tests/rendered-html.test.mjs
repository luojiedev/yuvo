import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server renders the bookkeeping launch screen", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>轻记账<\/title>/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /apple-touch-icon\.png/);
  assert.match(html, /apple-touch-startup-image/);
  assert.match(html, /launch-dark-/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /theme-color[^>]+#f4f1eb/);
  assert.match(html, /theme-color[^>]+#101512/);
  assert.match(html, /轻记账正在启动/);
  assert.match(html, /正在打开本地账本/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("uses an in-app amount keypad without a system text keyboard", async () => {
  const [component, css] = await Promise.all([
    readFile(new URL("../app/BookkeepingApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /className="number-keypad"/);
  assert.match(component, /<output aria-label="金额">/);
  assert.match(component, /className="amount-expression"/);
  assert.match(component, /className="category-picker category-grid"/);
  assert.match(component, /className="subtag-section"/);
  assert.match(component, /className="note-composer"/);
  assert.match(component, /className="note-composer-footer"/);
  assert.doesNotMatch(component, /className="image-attachment-section"/);
  assert.match(component, /className="transaction-flags"/);
  assert.match(component, /className="date-trigger"/);
  assert.match(component, /<DateTimePicker/);
  assert.match(component, /className="time-wheel-backdrop"/);
  assert.match(component, /<TimeWheelColumn/);
  assert.doesNotMatch(component, /className="time-selector"/);
  assert.doesNotMatch(component, /className="today-label"/);
  assert.doesNotMatch(component, /className="composer-heading-spacer"/);
  assert.match(component, /className="composer-top-save"/);
  assert.match(component, /className="composer-actions"/);
  assert.match(component, /再记一笔/);
  assert.match(component, /onClick=\{confirmAmountInput\}>确定</);
  assert.match(component, /persistTransaction\(true\)/);
  assert.doesNotMatch(component, /detail-section-heading"><strong>主分类/);
  assert.doesNotMatch(component, /className="detail-section-heading subtag-heading"/);
  assert.doesNotMatch(component, /openSubcategoryEditor/);
  assert.match(component, /className="inline-subtag-input"/);
  assert.match(component, /aria-label="新增子标签"/);
  assert.match(component, /aria-label="删除子标签"/);
  assert.match(component, /removeInlineSubcategory/);
  assert.match(component, /className="subtag-delete-done"/);
  assert.match(component, /setIsDeletingSubcategories\(false\)\}>完成</);
  assert.match(component, /isCategoryManagerEntry\(category\) \? openCategoryManager\(\)/);
  assert.match(component, /function toggleCategoryManageEditing\(\)/);
  assert.match(component, /setIsCategoryManageEditing\(true\)/);
  assert.match(component, /if \(selectedCategory\) openCategoryEditor\(selectedCategory\)/);
  assert.match(component, /onClick=\{toggleCategoryManageEditing\}/);
  assert.match(component, /className="category-manager-sheet"/);
  assert.match(component, /className="category-manager-grid"/);
  assert.match(component, /className="category-icon-options"/);
  assert.match(component, /renderSubcategoryControls\("edit"\)/);
  assert.match(component, /startEditingSubcategory/);
  assert.doesNotMatch(component, />收支分类</);
  assert.doesNotMatch(component, />快速记账</);
  assert.match(component, /onPointerDown=\{startComposerSwipe\}/);
  assert.match(component, /className="ledger-picker-sheet"/);
  assert.match(component, /className="composer-ledger-trigger"/);
  assert.match(component, /className="transaction-day-groups"/);
  assert.match(component, /groupTransactionsByLocalDay/);
  assert.doesNotMatch(component, /className="summary-card"/);
  assert.match(component, /useState<LedgerView>\("flow"\)/);
  assert.match(component, /className="ledger-view-toolbar"/);
  assert.match(component, /setLedgerView\("calendar"\)/);
  assert.match(component, /setLedgerView\("flow"\)/);
  assert.match(component, /className="ledger-calendar-grid"/);
  assert.match(component, /ledgerDailyExpenses/);
  assert.match(component, /<MonthYearPicker/);
  assert.match(component, /function renderSearch\(\)/);
  assert.match(component, /className="transaction-search-screen"/);
  assert.match(component, /体验模式仅保存在本机/);
  assert.match(component, /不会上传到服务器/);
  assert.match(component, /className="search-filter-panel"/);
  assert.match(component, /filterTransactions/);
  assert.match(component, /onClick=\{openSearch\}/);
  assert.match(component, /onClick=\{openLedgerPicker\}/);
  assert.match(component, /activeTab !== "profile"/);
  assert.match(component, /<strong>账本管理<\/strong><small>切换或新建账本<\/small>/);
  const selectLedgerSource = component.match(/async function selectLedger\([\s\S]+?\n  async function handleCreateLedger/)?.[0] ?? "";
  assert.ok(selectLedgerSource, "selectLedger source should be present");
  assert.doesNotMatch(selectLedgerSource, /setActiveTab\("ledger"\)/);
  assert.match(component, /新建本地账本/);
  assert.match(component, /家庭共同记账/);
  assert.match(component, /navigator\.serviceWorker\.register\("\/sw\.js"/);
  assert.match(component, /beforeinstallprompt/);
  assert.match(component, /添加到主屏幕/);
  assert.match(component, /function restartApplication\(\)/);
  assert.doesNotMatch(component, /setIsLaunchVisible\(false\), 1_400/);
  assert.match(component, /syncActiveLedger\(networkSession, activeLedgerId, \{ silent: true \}\)/);
  assert.match(component, /onClick=\{restartApplication\}/);
  assert.match(component, /className=\{`profile-sync-state/);
  assert.match(component, /className="profile-actions"/);
  assert.match(component, /className="profile-sync-button"/);
  assert.doesNotMatch(component, /className=\{`cloud-sync-card/);
  assert.match(component, /家庭与账号/);
  assert.doesNotMatch(component, /className="network-account-actions"/);
  assert.match(component, /offlineStatusLabel/);
  assert.match(component, /localStorage\.setItem\(`\$\{activeLedgerStorageKey\}:\$\{activeStorageScope\(\)\}`/);
  assert.match(component, /需要报销/);
  assert.match(component, /不参与统计/);
  assert.doesNotMatch(component, /className="calculation-hint"/);
  assert.match(component, /className="confirm-key"/);
  assert.match(component, /<OperatorKey primary="\+" alternate="×"/);
  assert.match(component, /<OperatorKey primary="−" alternate="÷"/);
  assert.doesNotMatch(component, /className="operator-strip"/);
  assert.doesNotMatch(component, /aria-label="支出金额"/);
  assert.match(component, /className="currency-trigger"/);
  assert.match(component, /aria-label="美元兑人民币汇率"/);
  assert.match(component, /订阅管理/);
  assert.match(component, /type="date" lang="zh-CN"/);
  assert.match(component, /确认生成扣费流水/);
  assert.match(component, /确认取消订阅/);
  assert.match(component, /subscription-notice/);
  assert.match(component, /isTransactionVisibleOnDate/);
  assert.match(component, /导入与导出/);
  assert.match(component, /label: "我的"/);
  assert.doesNotMatch(component, /label: "设置"|className="ledger-switch"/);
  assert.match(css, /\.number-keypad\s*\{[^}]*margin:\s*auto -16px 0/s);
  assert.match(css, /\.composer-full\s*\{[^}]*padding:[^;]*\s0;/s);
  assert.match(css, /\.amount-expression\s*\{[^}]*height:\s*14px/s);
  assert.match(css, /\.category-picker\.category-grid > div\s*\{[^}]*grid-template-columns:\s*repeat\(5/s);
  assert.match(css, /\.subtag-section\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.note-composer textarea\s*\{[^}]*font-size:\s*16px/s);
  assert.match(css, /\.budget-edit-form input\s*\{[^}]*font-size:\s*16px/s);
  assert.match(css, /\.create-ledger-form input\s*\{[^}]*font-size:\s*16px/s);
  assert.match(css, /\.ledger-kind-select\s*\{[^}]*font-size:\s*16px/s);
  assert.match(css, /\.calendar-grid\s*\{[^}]*grid-template-columns:\s*repeat\(7/s);
  assert.match(css, /\.time-wheel-selection\s*\{[^}]*height:\s*44px/s);
});

test("keeps statistics range controls safe from iOS focus zoom", async () => {
  const [component, css] = await Promise.all([
    readFile(new URL("../app/BookkeepingApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /className="statistics-period-switcher"/);
  assert.match(component, /isStatisticsPeriodPickerOpen \? <MonthYearPicker/);
  assert.match(component, /className="search-date-row"/);
  assert.match(component, /type="date" lang="zh-CN" aria-label="开始日期"/);
  assert.match(component, /type="date" lang="zh-CN" aria-label="结束日期"/);
  assert.match(css, /\.search-date-row input\s*\{[^}]*font-size:\s*16px/s);
  assert.match(css, /\.time-wheel-columns\.year-only\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.statistics-period-switcher > button\s*\{[^}]*min-height:\s*44px/s);
});
