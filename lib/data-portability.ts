import type { Account, BookkeepingTransaction, Category, Ledger, Subcategory, Subscription, TransactionImageAttachment } from "./domain";

export const backupFormat = "swift-ledger-backup";
export const backupFormatVersion = 1;
const maxImportBytes = 20 * 1024 * 1024;

export function validateImportFileSize(file: File): void {
  if (file.size <= 0 || file.size > maxImportBytes) throw new Error("导入文件应小于 20 MB");
}

export interface LedgerBackup {
  format: typeof backupFormat;
  formatVersion: typeof backupFormatVersion;
  backupId: string;
  exportedAt: string;
  ledger: Ledger;
  accounts: Account[];
  categories: Category[];
  subcategories: Subcategory[];
  transactions: Array<Omit<BookkeepingTransaction, "images"> & { images: PortableAttachment[] }>;
  subscriptions: Subscription[];
}

interface PortableAttachment extends Omit<TransactionImageAttachment, "blob"> {
  dataUrl?: string;
}

export async function createLedgerBackup(input: {
  backupId: string;
  ledger: Ledger;
  accounts: Account[];
  categories: Category[];
  subcategories: Subcategory[];
  transactions: BookkeepingTransaction[];
  subscriptions: Subscription[];
}): Promise<LedgerBackup> {
  if (input.transactions.some((row) => row.images.some((image) => !image.blob))) {
    throw new Error("部分附件尚未下载，无法生成完整备份。请联网同步后重试。");
  }
  const transactions = await Promise.all(input.transactions.map(async (transaction) => ({
    ...transaction,
    images: await Promise.all(transaction.images.map(async ({ blob, ...attachment }) => ({
      ...attachment,
      dataUrl: blob ? await blobToDataUrl(blob) : undefined,
    }))),
  })));
  const backup: LedgerBackup = {
    format: backupFormat,
    formatVersion: backupFormatVersion,
    backupId: input.backupId,
    exportedAt: new Date().toISOString(),
    ledger: input.ledger,
    accounts: input.accounts,
    categories: input.categories,
    subcategories: input.subcategories,
    transactions,
    subscriptions: input.subscriptions,
  };
  if (new Blob([JSON.stringify(backup)]).size > maxImportBytes) throw new Error("完整备份超过 20 MB，当前版本无法安全导入此大小；请勿将 CSV 视为完整备份。");
  return backup;
}

export async function readLedgerBackup(file: File): Promise<LedgerBackup> {
  validateImportFileSize(file);
  const value = JSON.parse(await file.text()) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("备份文件格式不正确");
  const backup = value as Partial<LedgerBackup>;
  if (backup.format !== backupFormat
    || backup.formatVersion !== backupFormatVersion
    || !backup.ledger
    || typeof backup.backupId !== "string"
    || !Array.isArray(backup.accounts)
    || !Array.isArray(backup.categories)
    || !Array.isArray(backup.subcategories)
    || !Array.isArray(backup.transactions)
    || (backup.subscriptions !== undefined && !Array.isArray(backup.subscriptions))) {
    throw new Error("不支持该备份版本");
  }
  const transactionIds = backup.transactions.map((item) => item.id);
  const subscriptionIds = (backup.subscriptions ?? []).map((item) => item.id);
  if (new Set(transactionIds).size !== transactionIds.length || new Set(subscriptionIds).size !== subscriptionIds.length) {
    throw new Error("备份文件包含重复的数据 ID");
  }
  validateLedgerBackup(backup as LedgerBackup);
  return backup as LedgerBackup;
}

export function validateLedgerBackup(backup: LedgerBackup): void {
  const requireText = (value: unknown, label: string, max = 120) => {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`备份${label}不正确`);
  };
  const positive = (value: unknown, label: string, max = 1_000_000_000_000) => {
    if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > max) throw new Error(`备份${label}不正确`);
  };
  const date = (value: unknown) => { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("备份日期不正确"); };
  requireText(backup.ledger.id, "账本标识");
  if (backup.ledger.monthlyBudgetMinor !== undefined) positive(backup.ledger.monthlyBudgetMinor, "预算");
  const collections = [backup.accounts, backup.categories, backup.subcategories, backup.subscriptions ?? [], backup.transactions];
  for (const collection of collections) {
    const seen = new Set<string>();
    for (const row of collection) {
      if (!row || typeof row !== "object") throw new Error("备份项目格式不正确");
      requireText(row.id, "项目标识");
      if (row.ledgerId !== backup.ledger.id || seen.has(row.id)) throw new Error("备份项目的账本归属或标识不正确");
      seen.add(row.id);
    }
  }
  const accounts = new Map(backup.accounts.map((row) => [row.id, row]));
  const categories = new Map(backup.categories.map((row) => [row.id, row]));
  const subcategories = new Map(backup.subcategories.map((row) => [row.id, row]));
  const subscriptions = new Set((backup.subscriptions ?? []).map((row) => row.id));
  const categoryNames = backup.categories.map((row) => JSON.stringify([row.type, row.name]));
  const subcategoryNames = backup.subcategories.map((row) => JSON.stringify([row.categoryId, row.name]));
  if (new Set(categoryNames).size !== categoryNames.length || new Set(subcategoryNames).size !== subcategoryNames.length) throw new Error("备份包含同名分类或子标签，无法确定恢复关联");
  for (const row of [...backup.accounts, ...backup.categories, ...backup.subcategories]) {
    requireText(row.name, "分类或账户名称", "categoryId" in row ? 10 : "icon" in row ? 8 : 12);
    if (row.status !== "active" && row.status !== "inactive") throw new Error("备份分类或账户状态不正确");
  }
  for (const row of backup.accounts) {
    if (!["cash", "bank", "wallet"].includes(row.type) || !Number.isSafeInteger(row.openingBalanceMinor) || !/^[A-Z]{3}$/u.test(row.currency)) throw new Error("备份账户格式不正确");
  }
  for (const row of backup.categories) {
    if (!["expense", "income"].includes(row.type) || !Number.isSafeInteger(row.sortOrder)) throw new Error("备份分类格式不正确");
  }
  for (const row of backup.subcategories) {
    if (!categories.has(row.categoryId) || !Number.isSafeInteger(row.sortOrder)) throw new Error("备份缺少子标签对应的分类");
  }
  const validateMoney = (row: LedgerBackup["transactions"][number] | Subscription) => {
    positive(row.amountMinor, "金额");
    if (!["CNY", "USD"].includes(row.currency)) throw new Error("备份币种不支持");
    if (row.currency === "USD" || row.baseAmountMinor !== undefined) positive(row.baseAmountMinor, "人民币金额");
    if (row.currency === "USD" || row.exchangeRateMicros !== undefined) positive(row.exchangeRateMicros, "汇率", 100_000_000);
    if (row.exchangeRateSource !== undefined && !["fixed", "manual", "frankfurter"].includes(row.exchangeRateSource)) throw new Error("备份汇率来源不正确");
    if (!accounts.has(row.accountId) || !categories.has(row.categoryId)) throw new Error("备份缺少流水或订阅关联的账户、分类，无法完整恢复");
  };
  for (const row of backup.subscriptions ?? []) {
    validateMoney(row); requireText(row.name, "订阅名称", 40); date(row.nextChargeOn);
    if (!["month", "year"].includes(row.frequency) || !["active", "paused", "cancelled"].includes(row.status) || !Number.isSafeInteger(row.interval) || row.interval < 1 || row.interval > 24) throw new Error("备份订阅周期不正确");
  }
  const imageIds = new Set<string>();
  for (const row of backup.transactions) {
    validateMoney(row); date(row.occurredAt);
    if (!["expense", "income"].includes(row.type) || categories.get(row.categoryId)?.type !== row.type) throw new Error("备份流水分类与收支类型不匹配");
    if (row.subcategoryId && subcategories.get(row.subcategoryId)?.categoryId !== row.categoryId) throw new Error("备份缺少流水关联的子标签");
    if (row.subscriptionId && !subscriptions.has(row.subscriptionId)) throw new Error("备份缺少流水关联的订阅");
    if (!Array.isArray(row.images) || row.images.length > 3) throw new Error("备份附件数量不正确");
    for (const image of row.images) {
      requireText(image.id, "附件标识");
      if (imageIds.has(image.id)) throw new Error("备份附件标识重复");
      imageIds.add(image.id);
      if (typeof image.dataUrl !== "string" || !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+$/iu.test(image.dataUrl)) throw new Error("备份附件内容缺失或格式不正确");
      if (!image.type?.startsWith("image/") || !Number.isSafeInteger(image.size) || image.size <= 0 || image.size > 12 * 1024 * 1024) throw new Error("备份附件大小或类型不正确");
    }
  }
}

export async function restoreAttachment(attachment: PortableAttachment): Promise<TransactionImageAttachment> {
  const { dataUrl, ...metadata } = attachment;
  if (dataUrl && !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+$/iu.test(dataUrl)) throw new Error("备份附件格式不正确");
  const blob = dataUrl ? await (await fetch(dataUrl)).blob() : undefined;
  if (blob && (blob.size !== metadata.size || blob.type !== metadata.type)) throw new Error("备份附件内容与元数据不一致");
  return { ...metadata, blob, status: blob ? "pending" : metadata.status };
}

const csvHeaders = ["流水ID", "发生时间", "类型", "原币金额", "币种", "汇率", "人民币结算金额", "主分类", "子标签", "账户", "描述", "不参与统计", "记录人"] as const;

export function exportTransactionsCsv(transactions: BookkeepingTransaction[]): string {
  const rows = transactions.map((item) => [
    item.id,
    item.occurredAt,
    item.type === "income" ? "收入" : "支出",
    (item.amountMinor / 100).toFixed(2),
    item.currency,
    ((item.exchangeRateMicros ?? 1_000_000) / 1_000_000).toFixed(6),
    ((item.baseAmountMinor ?? item.amountMinor) / 100).toFixed(2),
    item.categoryName,
    item.subcategoryName,
    item.accountName,
    item.note,
    item.excludeFromStats ? "是" : "否",
    item.createdByDisplayName ?? "本机用户",
  ]);
  return `\uFEFF${[csvHeaders, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

export interface CsvTransactionRow {
  sourceId: string;
  occurredAt: string;
  type: "expense" | "income";
  amountMinor: number;
  currency: "CNY" | "USD";
  exchangeRateMicros: number;
  baseAmountMinor: number;
  categoryName: string;
  subcategoryName: string;
  accountName: string;
  note: string;
  excludeFromStats: boolean;
}

export function parseTransactionsCsv(text: string): CsvTransactionRow[] {
  const rows = parseCsv(text.replace(/^\uFEFF/u, ""));
  if (rows.length < 2 || csvHeaders.some((header, index) => rows[0][index] !== header)) throw new Error("CSV 表头与知余格式不一致");
  return rows.slice(1).filter((row) => row.some(Boolean)).map((row, index) => {
    const amountMinor = decimalToMinor(row[3]);
    const baseAmountMinor = decimalToMinor(row[6]);
    const exchangeRateMicros = Math.round(Number(row[5]) * 1_000_000);
    if (!Number.isFinite(Date.parse(row[1])) || !amountMinor || !baseAmountMinor || !Number.isSafeInteger(exchangeRateMicros) || exchangeRateMicros <= 0) {
      throw new Error(`CSV 第 ${index + 2} 行的时间、金额或汇率不正确`);
    }
    return {
      sourceId: row[0] || String(index + 1), occurredAt: new Date(row[1]).toISOString(),
      type: row[2] === "收入" ? "income" : "expense", amountMinor,
      currency: row[4] === "USD" ? "USD" : "CNY", exchangeRateMicros, baseAmountMinor,
      categoryName: row[7], subcategoryName: row[8], accountName: row[9], note: row[10], excludeFromStats: row[11] === "是",
    };
  });
}

export async function fileFingerprint(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decimalToMinor(value: string): number | null {
  if (!/^-?\d+(?:\.\d{1,2})?$/u.test(value)) return null;
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) && result > 0 ? (negative ? -result : result) : null;
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") { row.push(cell); cell = ""; }
    else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += character;
  }
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  if (quoted) throw new Error("CSV 引号没有闭合");
  return rows;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return `data:${blob.type};base64,${btoa(chunks.join(""))}`;
}
