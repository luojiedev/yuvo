import { describe, expect, it } from "vitest";
import { exportTransactionsCsv, parseTransactionsCsv } from "../lib/data-portability";
import type { BookkeepingTransaction } from "../lib/domain";

describe("data portability", () => {
  it("round-trips CNY settlement fields through CSV", () => {
    const transaction: BookkeepingTransaction = {
      id: "transaction-usd", operationId: "operation-usd", ledgerId: "ledger-test", type: "expense",
      amountMinor: 1000, currency: "USD", baseAmountMinor: 7200, exchangeRateMicros: 7_200_000,
      exchangeRateSource: "frankfurter", exchangeRateAt: "2026-07-20T00:00:00.000Z",
      occurredAt: "2026-07-20T08:00:00.000Z", categoryId: "category-food", categoryName: "餐饮",
      subcategoryId: null, subcategoryName: "", accountId: "account-card", accountName: "银行卡",
      note: "Apple Music", images: [], excludeFromStats: false, version: 1,
      createdAt: "2026-07-20T08:00:00.000Z", deletedAt: null,
    };
    const parsed = parseTransactionsCsv(exportTransactionsCsv([transaction]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ amountMinor: 1000, currency: "USD", exchangeRateMicros: 7_200_000, baseAmountMinor: 7200 });
  });

  it("neutralizes spreadsheet formulas in exported text", () => {
    const csv = exportTransactionsCsv([{
      id: "transaction", operationId: "operation", ledgerId: "ledger", type: "expense", amountMinor: 100,
      currency: "CNY", occurredAt: "2026-07-20T08:00:00.000Z", categoryId: "category", categoryName: "其他",
      subcategoryId: null, subcategoryName: "", accountId: "account", accountName: "现金", note: "=1+1",
      images: [], excludeFromStats: false, version: 1, createdAt: "2026-07-20T08:00:00.000Z", deletedAt: null,
    }]);
    expect(csv).toContain("'=1+1");
  });
});
