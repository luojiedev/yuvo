import assert from "node:assert/strict";
import test from "node:test";
import {
  accountIdForLedger,
  categoryIdForLedger,
  defaultBookkeepingIds,
} from "../lib/ledger-identifiers.ts";

test("keeps legacy identifiers for the default ledger", () => {
  assert.equal(accountIdForLedger(defaultBookkeepingIds.ledgerId), defaultBookkeepingIds.accountId);
  assert.equal(categoryIdForLedger(defaultBookkeepingIds.ledgerId, "category-food"), "category-food");
});

test("namespaces account and category identifiers for additional ledgers", () => {
  assert.equal(accountIdForLedger("ledger-family"), "account-cash:ledger-family");
  assert.equal(categoryIdForLedger("ledger-family", "category-food"), "ledger-family:category-food");
});
