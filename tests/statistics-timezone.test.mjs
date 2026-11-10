import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const statisticsModuleUrl = new URL("../lib/statistics.ts", import.meta.url).href;
const transactionInstant = "2026-06-30T16:30:00.000Z";

function summariesInTimezone(timezone) {
  const script = `
    import { summarizeStatistics } from ${JSON.stringify(statisticsModuleUrl)};
    const transaction = {
      id: "timezone-boundary", operationId: "operation", ledgerId: "ledger", type: "expense",
      amountMinor: 100, currency: "CNY", occurredAt: ${JSON.stringify(transactionInstant)},
      categoryId: "food", categoryName: "餐饮", subcategoryId: null, subcategoryName: "",
      accountId: "cash", accountName: "现金", note: "", images: [], excludeFromStats: false,
      version: 1, createdAt: ${JSON.stringify(transactionInstant)}, deletedAt: null,
    };
    const summarize = (monthIndex) => summarizeStatistics([transaction], {
      period: "month", anchor: new Date(2026, monthIndex, 1), visibleOnDate: new Date(2026, 6, 15, 12),
      flow: "expense", dimension: "category",
    }).expenseMinor;
    process.stdout.write(JSON.stringify({ june: summarize(5), july: summarize(6) }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: timezone },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("assigns a boundary instant according to each device's local timezone", () => {
  assert.deepEqual(summariesInTimezone("Asia/Shanghai"), { june: 0, july: 100 });
  assert.deepEqual(summariesInTimezone("America/Los_Angeles"), { june: 100, july: 0 });
});
