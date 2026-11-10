"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Account, BookkeepingTransaction, Category, ExchangeRateSource, Ledger, NetworkSession, Subcategory, Subscription, SupportedCurrency, TransactionImageAttachment } from "../lib/domain";
import { convertToBaseAmountMinor, createId, formatMinorAmount, formatTransactionCategory, groupTransactionsByLocalDay, isTransactionVisibleOnDate, transactionBaseAmountMinor } from "../lib/domain";
import {
  calculatorExpression,
  initialCalculatorState,
  inputDecimal,
  inputDigit,
  minorToInput,
  removeLastDigit,
  resolveCalculator,
  selectOperator,
} from "../lib/calculator";
import type { MathOperator } from "../lib/calculator";
import { maxImagesPerTransaction, validateImageCandidates } from "../lib/image-attachments";
import { beginEdgeSwipe, edgeSwipeOffset, shouldFinishEdgeSwipe } from "../lib/edge-swipe";
import type { EdgeSwipeState } from "../lib/edge-swipe";
import {
  buildMonthGrid,
  formatDateLabel,
  formatMonthTitle,
  formatTime,
  isSameLocalDay,
  remainingDaysInLocalMonth,
  startOfLocalMonth,
  withSelectedDate,
  withSelectedTime,
} from "../lib/date-time";
import { createLongPressController } from "../lib/long-press";
import type { LongPressController } from "../lib/long-press";
import { dailyExpenseTotalsForMonth, localDateKey, summarizeTransactionsForMonth } from "../lib/ledger-calendar";
import {
  accountIdForLedger,
  countUnsyncedOperations,
  createLedger,
  createTransaction,
  defaultBookkeepingIds,
  deactivateAccount,
  deleteTransaction,
  deleteSubcategory,
  ensureDefaultData,
  ensureOfflineLedgerUsesUniqueId,
  getNetworkSession,
  importRemoteLedgerSnapshot,
  listAccounts,
  listCategories,
  listLedgers,
  listSubcategories,
  listSubscriptions,
  listTransactions,
  markLedgerAsNetworkBound,
  openBookkeepingDatabase,
  saveCategory,
  saveAccount,
  saveNetworkSession,
  saveSubcategory,
  saveSubscription,
  cancelSubscription,
  updateLocalCreatorDisplayName,
  updateLedgerMonthlyBudget,
  updateTransaction,
} from "../lib/local-database";
import {
  apiRequest,
  acceptAccountInvitation,
  bootstrapAccount,
  createRemoteFamilyLedger,
  createRemoteInvitation,
  defaultLaunchMessage,
  fetchLaunchMessage,
  fetchUsdCnyExchangeRate,
  fetchPushPublicKey,
  fetchRemoteLedgerSnapshot,
  fetchRemoteLedgers,
  getBootstrapStatus,
  loginAccount,
  logoutAccount,
  removeRemotePushSubscription,
  refreshAccountSession,
  saveRemotePushSubscription,
  updateAccountDisplayName,
} from "../lib/network-api";
import { synchronizeAccount } from "../lib/sync-engine";
import { SyncRecovery } from "./SyncRecovery";
import { ViewContext } from "../lib/view-context";
import { activeStorageKey, activeStorageScope, activateAccountDatabase, lockAccountDatabase, openAccountDatabase, openActiveAccountDatabase } from "../lib/account-storage";
import { guestTransferKey, transferGuestLedgers } from "../lib/guest-transfer";
import { inspectLegacyData, legacyMigrationMessage, migrateLegacyData, selectLegacyMigrationSession } from "../lib/legacy-migration";
import { advanceSubscriptionDate } from "../lib/subscription-schedule";
import { OperationTimeoutError, withOperationTimeout } from "../lib/operation-timeout";
import { amountInputToMinor, filterTransactions, transactionCreatorKey } from "../lib/transaction-search";
import type { TransactionSearchScope, TransactionSearchStatsMode, TransactionSearchTimeRange } from "../lib/transaction-search";
import { summarizeStatistics } from "../lib/statistics";
import type { StatisticsDimension, StatisticsFlow, StatisticsPeriod } from "../lib/statistics";
import {
  beginTransactionSwipe,
  moveTransactionSwipe as transactionSwipeMovement,
  shouldOpenTransactionActions,
} from "../lib/transaction-swipe";
import type { TransactionSwipeState } from "../lib/transaction-swipe";
import { exportTransactionsCsv, fileFingerprint, parseTransactionsCsv, readLedgerBackup, validateImportFileSize } from "../lib/data-portability";
import { exportLedgerBackup, restoreLedgerBackup } from "../lib/backup-restore";

type AppTab = "ledger" | "statistics" | "budget" | "profile";
type LedgerView = "flow" | "calendar";
type SubscriptionAction = { kind: "charge" | "cancel"; subscription: Subscription };
type EntryType = "expense" | "income";
type TransactionFlag = "reimbursable" | "recurring" | "excludeFromStats" | "private";
type PwaStatus = "development" | "checking" | "ready" | "unsupported" | "failed";
type AccountMode = "login" | "invite";
type SyncStatus = "idle" | "syncing" | "synced" | "error";
type PushNotificationStatus = "unsupported" | "disabled" | "blocked" | "enabled" | "loading" | "error";
type StartupStage = "open_local_database" | "prepare_local_database" | "read_local_account" | "read_local_ledgers" | "read_local_entries";

interface TransactionSearchDraft {
  query: string;
  scope: TransactionSearchScope;
  timeRange: TransactionSearchTimeRange;
  type: "all" | EntryType;
  minimumAmount: string;
  maximumAmount: string;
  currency: string;
  categoryId: string;
  accountId: string;
  creatorKey: string;
  statsMode: TransactionSearchStatsMode;
  customStartDate: string;
  customEndDate: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const transactionFlags: ReadonlyArray<{ id: TransactionFlag; label: string }> = [
  { id: "reimbursable", label: "需要报销" },
  { id: "recurring", label: "周期账单" },
  { id: "excludeFromStats", label: "不参与统计" },
  { id: "private", label: "私密账单" },
];

const navigation: Array<{ id: AppTab; label: string; icon: string }> = [
  { id: "ledger", label: "流水", icon: "⌂" },
  { id: "statistics", label: "统计", icon: "▥" },
  { id: "budget", label: "预算", icon: "◎" },
  { id: "profile", label: "我的", icon: "人" },
];

const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];
const hours = Array.from({ length: 24 }, (_, index) => index);
const minutes = Array.from({ length: 60 }, (_, index) => index);
const activeLedgerStorageKey = "swift-ledger.active-ledger-id";
const startupStepTimeoutMs = 8_000;
const exchangeRateStorageKey = "swift-ledger.exchange-rate.USD-CNY";

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob((value + padding).replace(/-/gu, "+").replace(/_/gu, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function serializedPushSubscription(subscription: PushSubscription) {
  const value = subscription.toJSON();
  if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth) {
    throw new Error("浏览器返回的通知订阅不完整");
  }
  return {
    endpoint: value.endpoint,
    expirationTime: value.expirationTime ?? null,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
  };
}
const defaultTransactionSearchDraft: TransactionSearchDraft = {
  query: "",
  scope: "all",
  timeRange: "all",
  type: "all",
  minimumAmount: "",
  maximumAmount: "",
  currency: "",
  categoryId: "",
  accountId: "",
  creatorKey: "",
  statsMode: "all",
  customStartDate: "",
  customEndDate: "",
};
const accountStorageKey = (ledgerId: string) => `swift-ledger.active-account-id:${ledgerId}`;
const categoryIconOptions = ["餐", "行", "医", "购", "投", "家", "旅", "礼", "学", "宠", "车", "衣", "数", "娱", "健", "美", "薪", "奖", "财", "其"];

function isCategoryManagerEntry(category: Category): boolean {
  return category.id === "category-custom"
    || category.id.endsWith(":category-custom")
    || category.id.startsWith("category-manager:");
}

function formatCalendarExpense(amountMinor: number): string {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100);
}

function formatStatisticsChange(currentMinor: number, previousMinor: number, period: StatisticsPeriod): string {
  const comparisonPeriod = period === "month" ? "上月" : "上年";
  if (previousMinor === 0) return currentMinor === 0 ? `与${comparisonPeriod}持平` : `${comparisonPeriod}无记录`;
  const changePercent = Math.round(((currentMinor - previousMinor) / previousMinor) * 1_000) / 10;
  const sign = changePercent > 0 ? "+" : "";
  return `较${comparisonPeriod} ${sign}${changePercent}%`;
}

function statisticsChangeTone(currentMinor: number, previousMinor: number, flow: StatisticsFlow): string {
  if (currentMinor === previousMinor || previousMinor === 0) return "neutral";
  const isFavorable = flow === "income" ? currentMinor > previousMinor : currentMinor < previousMinor;
  return isFavorable ? "favorable" : "unfavorable";
}

function formatStatisticsAmountChange(currentMinor: number, previousMinor: number, period: StatisticsPeriod): string {
  const comparisonPeriod = period === "month" ? "上月" : "上年";
  const differenceMinor = currentMinor - previousMinor;
  if (differenceMinor === 0) return `与${comparisonPeriod}持平`;
  return `较${comparisonPeriod} ${differenceMinor > 0 ? "+" : "-"}${formatMinorAmount(Math.abs(differenceMinor))}`;
}

function amountPreviewMinor(display: string): number | null {
  if (!/^\d+(?:\.\d{0,2})?$/u.test(display)) return null;
  const [whole, fraction = ""] = display.split(".");
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3]);
}

function downloadFile(filename: string, content: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function readRememberedLedgerId(): string | null {
  try {
    return localStorage.getItem(`${activeLedgerStorageKey}:${activeStorageScope()}`);
  } catch (error) {
    console.error("[bookkeeping] failed to read active ledger preference", error);
    return null;
  }
}

function rememberLedgerId(ledgerId: string) {
  try {
    localStorage.setItem(`${activeLedgerStorageKey}:${activeStorageScope()}`, ledgerId);
    console.debug("[bookkeeping] active ledger preference saved", { ledgerId });
  } catch (error) {
    console.error("[bookkeeping] failed to save active ledger preference", error);
  }
}

function readRememberedAccountId(ledgerId: string): string | null {
  try {
    return localStorage.getItem(`${accountStorageKey(ledgerId)}:${activeStorageScope()}`);
  } catch (error) {
    console.error("[bookkeeping] failed to read account preference", error);
    return null;
  }
}

function rememberAccountId(ledgerId: string, accountId: string) {
  try {
    localStorage.setItem(`${accountStorageKey(ledgerId)}:${activeStorageScope()}`, accountId);
  } catch (error) {
    console.error("[bookkeeping] failed to save account preference", error);
  }
}

function preferredAccountId(accountRows: Account[], ledgerId: string): string {
  const remembered = readRememberedAccountId(ledgerId);
  return accountRows.find((account) => account.id === remembered)?.id ?? accountRows[0]?.id ?? "";
}

function TimeWheelColumn({ values, value, unit, onChange }: {
  values: number[];
  value: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const selectedIndex = values.indexOf(value);
    if (wheelRef.current && selectedIndex >= 0) wheelRef.current.scrollTop = selectedIndex * 44;
  }, [value, values]);

  useEffect(() => () => {
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
  }, []);

  function settleWheel() {
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      const wheel = wheelRef.current;
      if (!wheel) return;
      const nextIndex = Math.max(0, Math.min(values.length - 1, Math.round(wheel.scrollTop / 44)));
      onChange(values[nextIndex]);
      wheel.scrollTo({ top: nextIndex * 44, behavior: "smooth" });
    }, 90);
  }

  return (
    <div className="time-wheel-column" ref={wheelRef} onScroll={settleWheel}>
      <span className="time-wheel-spacer" aria-hidden="true" />
      {values.map((item) => (
        <button key={item} className={value === item ? "selected" : ""} type="button" aria-pressed={value === item} onClick={() => onChange(item)}>
          {String(item).padStart(2, "0")}{value === item ? <small>{unit}</small> : null}
        </button>
      ))}
      <span className="time-wheel-spacer" aria-hidden="true" />
    </div>
  );
}

function MonthYearPicker({ value, mode = "month", maximum, onCancel, onConfirm }: {
  value: Date;
  mode?: StatisticsPeriod;
  maximum?: Date;
  onCancel: () => void;
  onConfirm: (value: Date) => void;
}) {
  const currentYear = new Date().getFullYear();
  const maximumYear = maximum?.getFullYear() ?? currentYear + 10;
  const years = useMemo(
    () => Array.from({ length: Math.max(1, maximumYear - (currentYear - 20) + 1) }, (_, index) => currentYear - 20 + index),
    [currentYear, maximumYear],
  );
  const [draftYear, setDraftYear] = useState(value.getFullYear());
  const [draftMonth, setDraftMonth] = useState(value.getMonth() + 1);
  const monthValues = useMemo(() => Array.from({ length: maximum && draftYear === maximum.getFullYear() ? maximum.getMonth() + 1 : 12 }, (_, index) => index + 1), [draftYear, maximum]);

  function selectDraftYear(year: number) {
    setDraftYear(year);
    if (mode === "month" && maximum && year === maximum.getFullYear() && draftMonth > maximum.getMonth() + 1) {
      setDraftMonth(maximum.getMonth() + 1);
    }
  }

  return (
    <div className="time-wheel-backdrop" role="presentation" onClick={onCancel}>
      <div className="time-wheel-layout month-year-wheel-layout" onClick={(event) => event.stopPropagation()}>
        <div className="month-year-picker-actions">
          <button type="button" onClick={onCancel}>取消</button>
          <strong>{mode === "year" ? "选择年份" : "选择年月"}</strong>
          <button type="button" onClick={() => onConfirm(new Date(draftYear, mode === "year" ? 0 : draftMonth - 1, 1))}>完成</button>
        </div>
        <section className="time-wheel-sheet" role="dialog" aria-modal="true" aria-label={mode === "year" ? "选择年份" : "选择年月"}>
          <div className="time-wheel-selection" aria-hidden="true" />
          <div className={`time-wheel-columns ${mode === "year" ? "year-only" : ""}`}>
            <TimeWheelColumn values={years} value={draftYear} unit="年" onChange={selectDraftYear} />
            {mode === "month" ? <TimeWheelColumn values={monthValues} value={draftMonth} unit="月" onChange={setDraftMonth} /> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function TimeWheelPicker({ value, onCancel, onConfirm }: {
  value: Date;
  onCancel: () => void;
  onConfirm: (value: Date) => void;
}) {
  const [draft, setDraft] = useState(() => new Date(value));

  return (
    <div className="time-wheel-backdrop" role="presentation" onClick={onCancel}>
      <div className="time-wheel-layout" onClick={(event) => event.stopPropagation()}>
        <div className="time-wheel-actions">
          <button className="time-wheel-cancel" type="button" aria-label="取消选择时间" onClick={onCancel}>×</button>
          <button className="time-wheel-done" type="button" onClick={() => onConfirm(draft)}>完成</button>
        </div>
        <section className="time-wheel-sheet" role="dialog" aria-modal="true" aria-label="选择时间">
          <div className="time-wheel-selection" aria-hidden="true" />
          <div className="time-wheel-columns">
            <TimeWheelColumn values={hours} value={draft.getHours()} unit="小时" onChange={(hour) => setDraft((current) => withSelectedTime(current, hour, current.getMinutes()))} />
            <TimeWheelColumn values={minutes} value={draft.getMinutes()} unit="分钟" onChange={(minute) => setDraft((current) => withSelectedTime(current, current.getHours(), minute))} />
          </div>
        </section>
      </div>
    </div>
  );
}

function DateTimePicker({ value, onCancel, onConfirm }: {
  value: Date;
  onCancel: () => void;
  onConfirm: (value: Date) => void;
}) {
  const [draft, setDraft] = useState(() => new Date(value));
  const [visibleMonth, setVisibleMonth] = useState(() => startOfLocalMonth(value));
  const [isTimeOpen, setIsTimeOpen] = useState(false);
  const today = new Date();
  const calendarDays = buildMonthGrid(visibleMonth);

  function selectDate(date: Date) {
    setDraft((current) => withSelectedDate(current, date));
    if (date.getMonth() !== visibleMonth.getMonth() || date.getFullYear() !== visibleMonth.getFullYear()) {
      setVisibleMonth(startOfLocalMonth(date));
    }
  }

  function moveMonth(offset: number) {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  function returnToToday() {
    const now = new Date();
    setDraft(now);
    setVisibleMonth(startOfLocalMonth(now));
  }

  return (
    <div className="date-picker-backdrop" role="presentation">
      <section className="date-picker-sheet" role="dialog" aria-modal="true" aria-labelledby="date-picker-title">
        <header className="date-picker-heading">
          <button type="button" onClick={onCancel}>取消</button>
          <h2 id="date-picker-title">选择日期</h2>
          <button className="date-confirm" type="button" onClick={() => onConfirm(draft)}>确定</button>
        </header>
        <div className="date-toolbar">
          <button className="time-trigger" type="button" aria-expanded={isTimeOpen} onClick={() => setIsTimeOpen((current) => !current)}>
            <span>时间</span><strong>{formatTime(draft)}</strong>
          </button>
          <div className="month-switcher">
            <button type="button" aria-label="上个月" onClick={() => moveMonth(-1)}>‹</button>
            <strong>{formatMonthTitle(visibleMonth)}</strong>
            <button type="button" aria-label="下个月" onClick={() => moveMonth(1)}>›</button>
          </div>
          <button className="today-button" type="button" onClick={returnToToday}>回到今天</button>
        </div>
        <div className="calendar-weekdays" aria-hidden="true">
          {weekdayLabels.map((weekday) => <span key={weekday}>{weekday}</span>)}
        </div>
        <div className="calendar-grid" aria-label={formatMonthTitle(visibleMonth)}>
          {calendarDays.map(({ date, belongsToMonth }) => {
            const isSelected = isSameLocalDay(date, draft);
            const isToday = isSameLocalDay(date, today);
            return (
              <button
                key={`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`}
                className={`${belongsToMonth ? "" : "outside"}${isSelected ? " selected" : ""}${isToday ? " today" : ""}`}
                type="button"
                aria-label={`${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`}
                aria-pressed={isSelected}
                aria-current={isToday ? "date" : undefined}
                onClick={() => selectDate(date)}
              >{date.getDate()}</button>
            );
          })}
        </div>
      </section>
      {isTimeOpen ? (
        <TimeWheelPicker
          value={draft}
          onCancel={() => setIsTimeOpen(false)}
          onConfirm={(time) => {
            setDraft(time);
            setIsTimeOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function OperatorKey({
  primary,
  alternate,
  onSelect,
}: {
  primary: MathOperator;
  alternate: MathOperator;
  onSelect: (operator: MathOperator) => void;
}) {
  const selectRef = useRef(onSelect);
  const controllerRef = useRef<LongPressController | null>(null);

  useEffect(() => {
    selectRef.current = onSelect;
  }, [onSelect]);
  useEffect(() => {
    const controller = createLongPressController({
      onShortPress: () => selectRef.current(primary),
      onLongPress: () => {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate(20);
        }
        selectRef.current(alternate);
      },
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [alternate, primary]);

  return (
    <button
      className="operator-key"
      type="button"
      aria-label={`${primary === "+" ? "加" : "减"}，长按${alternate === "×" ? "乘" : "除"}`}
      onPointerDown={(event) => {
        if (event.button === 0) controllerRef.current?.start();
      }}
      onPointerUp={() => controllerRef.current?.finish()}
      onPointerCancel={() => controllerRef.current?.cancel()}
      onPointerLeave={() => controllerRef.current?.cancel()}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => {
        if (event.detail === 0) onSelect(primary);
      }}
    >
      <small aria-hidden="true">{alternate}</small>
      <strong aria-hidden="true">{primary}</strong>
    </button>
  );
}

function BlobAttachmentImage({ blob, alt }: { blob: Blob; alt: string }) {
  const [source] = useState(() => URL.createObjectURL(blob));

  useEffect(() => {
    return () => {
      URL.revokeObjectURL(source);
    };
  }, [source]);

  // Blob URLs come from the user's local IndexedDB and cannot use a framework image loader.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={source} alt={alt} />;
}

function AttachmentImage({ image, alt }: { image: TransactionImageAttachment; alt: string }) {
  if (!image.blob) return <span className="attachment-placeholder" role="img" aria-label={`${alt}等待下载`}>图</span>;
  return <BlobAttachmentImage key={`${image.id}:${image.blob.size}`} blob={image.blob} alt={alt} />;
}

const startupStageLabels: Record<StartupStage, string> = {
  open_local_database: "正在打开本地账本",
  prepare_local_database: "正在检查本地数据",
  read_local_account: "正在读取账号信息",
  read_local_ledgers: "正在读取本地账本",
  read_local_entries: "正在载入本地流水",
};

function startupFailureMessage(error: unknown): string {
  if (error instanceof OperationTimeoutError) {
    if (error.operation === "open_local_database") {
      return "手机的本地存储暂时没有响应。账本数据不会被清除，请重新尝试。";
    }
    return "读取本地账本超时。账本数据仍保存在手机中，请重新尝试。";
  }
  if (error instanceof Error && error.message.includes("被其他页面阻止")) {
    return "另一个轻记账窗口正在占用旧版账本，请关闭其他窗口后重新尝试。";
  }
  return "暂时无法打开本地账本。账本数据不会被清除，请重新尝试。";
}

function AppLaunchBrand() {
  return <div className="app-launch-brand" aria-hidden="true"><i /><i /><i /><i /></div>;
}

function AppLaunchScreen({ message, status }: { message: string; status: string }) {
  return (
    <main className="app-launch-screen" aria-live="polite" aria-label="轻记账正在启动">
      <AppLaunchBrand />
      <h1>轻记账</h1>
      <p className="app-launch-message">{message}</p>
      <small>{status}</small>
      <span className="app-launch-progress" aria-hidden="true"><i /><i /><i /></span>
    </main>
  );
}

function AppStartupRecovery({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="app-startup-recovery" role="alert">
      <AppLaunchBrand />
      <p className="app-startup-eyebrow">本地账本暂时休息了一下</p>
      <h1>没有丢失任何记录</h1>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>重新尝试</button>
      <small>如果仍然无法进入，请彻底关闭轻记账后重新打开。</small>
    </main>
  );
}

export function BookkeepingApp() {
  const databaseRef = useRef<IDBDatabase | null>(null);
  const operationIdRef = useRef(createId());
  const isApplyingUpdateRef = useRef(false);
  const [transactions, setTransactions] = useState<BookkeepingTransaction[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [subcategories, setSubcategories] = useState<Subcategory[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(defaultBookkeepingIds.accountId);
  const [activeLedgerId, setActiveLedgerId] = useState<string>(defaultBookkeepingIds.ledgerId);
  const [activeTab, setActiveTab] = useState<AppTab>("ledger");
  const [ledgerView, setLedgerView] = useState<LedgerView>("flow");
  const [ledgerMonth, setLedgerMonth] = useState(() => startOfLocalMonth(new Date()));
  const [transactionVisibilityDate, setTransactionVisibilityDate] = useState(() => new Date());
  const [isLedgerMonthPickerOpen, setIsLedgerMonthPickerOpen] = useState(false);
  const [statisticsPeriod, setStatisticsPeriod] = useState<StatisticsPeriod>("month");
  const [statisticsAnchor, setStatisticsAnchor] = useState(() => startOfLocalMonth(new Date()));
  const [statisticsFlow, setStatisticsFlow] = useState<StatisticsFlow>("expense");
  const [statisticsDimension, setStatisticsDimension] = useState<StatisticsDimension>("category");
  const [isStatisticsPeriodPickerOpen, setIsStatisticsPeriodPickerOpen] = useState(false);
  const [ledgerNotice, setLedgerNotice] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isLaunchVisible, setIsLaunchVisible] = useState(true);
  const [launchMessage, setLaunchMessage] = useState(defaultLaunchMessage);
  const [launchStatus, setLaunchStatus] = useState(startupStageLabels.open_local_database);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isAmountConfirmed, setIsAmountConfirmed] = useState(false);
  const [entryType, setEntryType] = useState<EntryType>("expense");
  const [entryCurrency, setEntryCurrency] = useState<SupportedCurrency>("CNY");
  const [exchangeRateDraft, setExchangeRateDraft] = useState("7.20");
  const [exchangeRateSource, setExchangeRateSource] = useState<ExchangeRateSource>("fixed");
  const [exchangeRateAt, setExchangeRateAt] = useState(() => new Date().toISOString());
  const [isExchangeRateLoading, setIsExchangeRateLoading] = useState(false);
  const [calculator, setCalculator] = useState(initialCalculatorState);
  const [categoryId, setCategoryId] = useState("category-food");
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState("");
  const [note, setNote] = useState("");
  const [selectedImages, setSelectedImages] = useState<TransactionImageAttachment[]>([]);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const inlineSubcategoryInputRef = useRef<HTMLInputElement | null>(null);
  const isSubcategoryMutationRunningRef = useRef(false);
  const composerSwipeRef = useRef<EdgeSwipeState | null>(null);
  const transactionDetailSwipeRef = useRef<EdgeSwipeState | null>(null);
  const searchSwipeRef = useRef<EdgeSwipeState | null>(null);
  const transactionSwipeRef = useRef<TransactionSwipeState | null>(null);
  const suppressTransactionClickRef = useRef(false);
  const [swipedTransactionId, setSwipedTransactionId] = useState<string | null>(null);
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<TransactionImageAttachment | null>(null);
  const [editingTransactionId, setEditingTransactionId] = useState<string | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isSearchFilterOpen, setIsSearchFilterOpen] = useState(true);
  const [searchDraft, setSearchDraft] = useState<TransactionSearchDraft>(defaultTransactionSearchDraft);
  const [selectedFlags, setSelectedFlags] = useState<Set<TransactionFlag>>(() => new Set());
  const [occurredAt, setOccurredAt] = useState(() => new Date());
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [isLedgerPickerOpen, setIsLedgerPickerOpen] = useState(false);
  const [isCreatingLedger, setIsCreatingLedger] = useState(false);
  const [ledgerNameDraft, setLedgerNameDraft] = useState("");
  const [ledgerKindDraft, setLedgerKindDraft] = useState<"private" | "family">("private");
  const [includeGuestLedgers, setIncludeGuestLedgers] = useState(true);
  const [isTransferringGuestLedgers, setIsTransferringGuestLedgers] = useState(false);
  const [isBudgetEditing, setIsBudgetEditing] = useState(false);
  const [isBudgetSaving, setIsBudgetSaving] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState("");
  const [budgetError, setBudgetError] = useState("");
  const [isCategoryEditorOpen, setIsCategoryEditorOpen] = useState(false);
  const [isCategoryManageEditing, setIsCategoryManageEditing] = useState(false);
  const [isCategoryFormOpen, setIsCategoryFormOpen] = useState(false);
  const [categoryEditingId, setCategoryEditingId] = useState<string | null>(null);
  const [categoryNameDraft, setCategoryNameDraft] = useState("");
  const [categoryIconDraft, setCategoryIconDraft] = useState("");
  const [subcategoryNameDraft, setSubcategoryNameDraft] = useState("");
  const [inlineSubcategoryEditingId, setInlineSubcategoryEditingId] = useState<string | null>(null);
  const [isAddingSubcategory, setIsAddingSubcategory] = useState(false);
  const [isDeletingSubcategories, setIsDeletingSubcategories] = useState(false);
  const [isAccountManagerOpen, setIsAccountManagerOpen] = useState(false);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [isSubscriptionManagerOpen, setIsSubscriptionManagerOpen] = useState(false);
  const [subscriptionEditingId, setSubscriptionEditingId] = useState<string | null>(null);
  const [subscriptionNameDraft, setSubscriptionNameDraft] = useState("");
  const [subscriptionBeneficiaryDraft, setSubscriptionBeneficiaryDraft] = useState("");
  const [subscriptionAmountDraft, setSubscriptionAmountDraft] = useState("");
  const [subscriptionCurrencyDraft, setSubscriptionCurrencyDraft] = useState<SupportedCurrency>("CNY");
  const [subscriptionRateDraft, setSubscriptionRateDraft] = useState("1.00");
  const [subscriptionRateSource, setSubscriptionRateSource] = useState<ExchangeRateSource>("fixed");
  const [subscriptionRateAt, setSubscriptionRateAt] = useState(() => new Date().toISOString());
  const [subscriptionCategoryIdDraft, setSubscriptionCategoryIdDraft] = useState("");
  const [subscriptionFrequencyDraft, setSubscriptionFrequencyDraft] = useState<Subscription["frequency"]>("month");
  const [subscriptionNextChargeDraft, setSubscriptionNextChargeDraft] = useState("");
  const [isSubscriptionSaving, setIsSubscriptionSaving] = useState(false);
  const [pendingSubscriptionAction, setPendingSubscriptionAction] = useState<SubscriptionAction | null>(null);
  const [subscriptionNotice, setSubscriptionNotice] = useState("");
  const [isDataPortabilityOpen, setIsDataPortabilityOpen] = useState(false);
  const [dataPortabilityStatus, setDataPortabilityStatus] = useState("");
  const [isDataPortabilityBusy, setIsDataPortabilityBusy] = useState(false);
  const dataImportInputRef = useRef<HTMLInputElement | null>(null);
  const [accountEditingId, setAccountEditingId] = useState<string | null>(null);
  const [accountNameDraft, setAccountNameDraft] = useState("");
  const [accountTypeDraft, setAccountTypeDraft] = useState<Account["type"]>("cash");
  const [errorMessage, setErrorMessage] = useState("");
  const [pwaStatus, setPwaStatus] = useState<PwaStatus>(() => process.env.NODE_ENV === "production" ? "checking" : "development");
  const [isOnline, setIsOnline] = useState(true);
  const [isInstalled, setIsInstalled] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [waitingServiceWorker, setWaitingServiceWorker] = useState<ServiceWorker | null>(null);
  const [isInstallGuideOpen, setIsInstallGuideOpen] = useState(false);
  const [networkSession, setNetworkSession] = useState<NetworkSession | null>(null);
  const [isNetworkInitialized, setIsNetworkInitialized] = useState<boolean | null>(null);
  const [accountMode, setAccountMode] = useState<AccountMode>("login");
  const [accountUsername, setAccountUsername] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [accountDisplayName, setAccountDisplayName] = useState("");
  const [accountInviteToken, setAccountInviteToken] = useState("");
  const [isAccountSubmitting, setIsAccountSubmitting] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [isProfileEditing, setIsProfileEditing] = useState(false);
  const [isProfileSaving, setIsProfileSaving] = useState(false);
  const [profileDisplayNameDraft, setProfileDisplayNameDraft] = useState("");
  const [latestInvite, setLatestInvite] = useState<{ token: string; expiresAt: string } | null>(null);
  const [pushNotificationStatus, setPushNotificationStatus] = useState<PushNotificationStatus>("disabled");
  const syncRunningRef = useRef(false);
  const legacyMigrationRunningRef = useRef(false);
  const legacyMigrationScheduledRef = useRef(false);
  const [legacyNotice, setLegacyNotice] = useState("");
  const [isLegacyMigrating, setIsLegacyMigrating] = useState(false);
  const [legacyCheckRevision, setLegacyCheckRevision] = useState(0);
  const viewContextRef = useRef(new ViewContext());
  const recoveryOpenRef = useRef(false);
  const [recoveryDatabase, setRecoveryDatabase] = useState<IDBDatabase | null>(null);
  const sessionRefreshRunningRef = useRef(false);
  const notificationTargetRef = useRef<{ ledgerId: string; transactionId: string } | null>(null);

  const syncActiveLedger = useCallback(async (
    session: NetworkSession | null = networkSession,
    ledgerId = activeLedgerId,
    options: { silent?: boolean } = {},
  ) => {
    const database = databaseRef.current;
    if (!database || !session || !navigator.onLine || syncRunningRef.current || recoveryOpenRef.current || legacyMigrationRunningRef.current || legacyMigrationScheduledRef.current) return;
    const isCurrent = viewContextRef.current.capture();
    syncRunningRef.current = true;
    if (!options.silent) setSyncStatus("syncing");
    try {
      const report = await synchronizeAccount(database, session);
      if (!isCurrent() || databaseRef.current !== database) return;
      const [ledgerRows, transactionRows, categoryRows, subcategoryRows, accountRows, subscriptionRows] = await Promise.all([
        listLedgers(database),
        listTransactions(database, ledgerId),
        listCategories(database, ledgerId),
        listSubcategories(database, ledgerId),
        listAccounts(database, ledgerId),
        listSubscriptions(database, ledgerId),
      ]);
      if (!isCurrent() || databaseRef.current !== database) return;
      setLedgers(ledgerRows);
      setTransactions(transactionRows);
      setCategories(categoryRows);
      setSubcategories(subcategoryRows);
      setAccounts(accountRows);
      setSubscriptions(subscriptionRows);
      setSelectedAccountId((current) => accountRows.some((account) => account.id === current) ? current : preferredAccountId(accountRows, ledgerId));
      const remaining = await countUnsyncedOperations(database);
      if (!isCurrent() || databaseRef.current !== database) return;
      setUnsyncedCount(remaining);
      setSyncStatus(report.failed > 0 || report.conflicts > 0 ? "error" : remaining > 0 ? "idle" : "synced");
      setLastSyncedAt(new Date());
      console.debug("[bookkeeping] active ledger synchronized", { ledgerId, silent: Boolean(options.silent), ...report });
    } catch (error) {
      console.error("[bookkeeping] active ledger synchronization failed", error);
      if (!isCurrent() || databaseRef.current !== database) return;
      const remaining = await countUnsyncedOperations(database);
      if (!isCurrent()) return;
      setUnsyncedCount(remaining);
      setSyncStatus("error");
    } finally {
      syncRunningRef.current = false;
    }
  }, [activeLedgerId, networkSession]);

  useEffect(() => {
    const notificationParameters = new URLSearchParams(window.location.search);
    const viewContext = viewContextRef.current;
    const notificationLedgerId = notificationParameters.get("ledger");
    const notificationTransactionId = notificationParameters.get("transaction");
    if (notificationLedgerId && notificationTransactionId) {
      notificationTargetRef.current = {
        ledgerId: notificationLedgerId,
        transactionId: notificationTransactionId,
      };
    }
    queueMicrotask(() => {
      setIsOnline(navigator.onLine);
      setIsInstalled(window.matchMedia("(display-mode: standalone)").matches
        || (navigator as Navigator & { standalone?: boolean }).standalone === true);
    });
    let isActive = true;

    async function startupStep<T>(stage: StartupStage, operation: () => Promise<T>): Promise<T> {
      const startedAt = performance.now();
      queueMicrotask(() => {
        if (isActive) setLaunchStatus(startupStageLabels[stage]);
      });
      console.debug("[bookkeeping] startup stage started", { stage });
      try {
        const result = await withOperationTimeout(operation(), stage, startupStepTimeoutMs);
        console.debug("[bookkeeping] startup stage completed", {
          stage,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return result;
      } catch (error) {
        console.error("[bookkeeping] startup stage failed", {
          stage,
          durationMs: Math.round(performance.now() - startedAt),
          error,
        });
        throw error;
      }
    }

    async function initialize() {
      let openedDatabase: IDBDatabase | null = null;
      try {
        const database = await startupStep("open_local_database", openActiveAccountDatabase);
        openedDatabase = database;
        await startupStep("prepare_local_database", () => ensureDefaultData(database));
        const [savedSession, pendingCount, legacy] = await startupStep("read_local_account", () => Promise.all([
          getNetworkSession(database),
          countUnsyncedOperations(database),
          inspectLegacyData(),
        ]));
        let ledgerRows = await startupStep("read_local_ledgers", () => listLedgers(database));
        if (savedSession && ledgerRows.some((ledger) => ledger.id === defaultBookkeepingIds.ledgerId)) {
          await startupStep("prepare_local_database", () => markLedgerAsNetworkBound(database, defaultBookkeepingIds.ledgerId));
          ledgerRows = await startupStep("read_local_ledgers", () => listLedgers(database));
        }
        const rememberedLedgerId = notificationTargetRef.current?.ledgerId ?? readRememberedLedgerId();
        const initialLedger = ledgerRows.find((ledger) => ledger.id === rememberedLedgerId)
          ?? ledgerRows.find((ledger) => ledger.id === defaultBookkeepingIds.ledgerId)
          ?? ledgerRows[0];
        const [rows, categoryRows, subcategoryRows, accountRows] = initialLedger ? await startupStep("read_local_entries", () => Promise.all([
          listTransactions(database, initialLedger.id),
          listCategories(database, initialLedger.id),
          listSubcategories(database, initialLedger.id),
          listAccounts(database, initialLedger.id),
        ])) : [[], [], [], []];
        if (isActive) {
          databaseRef.current = database;
          openedDatabase = null;
          setLedgers(ledgerRows);
          if (initialLedger) {
            setActiveLedgerId(initialLedger.id);
            rememberLedgerId(initialLedger.id);
          }
          setTransactions(rows);
          setCategories(categoryRows);
          setSubcategories(subcategoryRows);
          setAccounts(accountRows);
          setSelectedAccountId(initialLedger ? preferredAccountId(accountRows, initialLedger.id) : "");
          setNetworkSession(savedSession);
          if (legacy.hasLegacyData) setLegacyNotice("发现旧版数据，原始副本已保留并锁定；联网验证账号后会自动检查可迁移内容。");
          setUnsyncedCount(pendingCount);
          const firstExpenseCategory = categoryRows.find((category) => category.type === "expense");
          if (firstExpenseCategory) setCategoryId(firstExpenseCategory.id);
        } else {
          database.close();
        }
      } catch (error) {
        console.error("[bookkeeping] local storage initialization failed", error);
        openedDatabase?.close();
        if (isActive) setStartupError(startupFailureMessage(error));
      } finally {
        if (isActive) {
          setIsLoading(false);
          setIsLaunchVisible(false);
        }
      }
    }

    void initialize();
    void fetchLaunchMessage().then((message) => {
      if (isActive) setLaunchMessage(message);
    }).catch((error) => {
      console.debug("[bookkeeping] remote launch message unavailable", error);
    });
    void getBootstrapStatus().then(setIsNetworkInitialized).catch((error) => {
      console.debug("[network] bootstrap status unavailable", error);
    });
    return () => {
      isActive = false;
      viewContext.invalidate();
      databaseRef.current?.close();
    };
  }, [startupAttempt]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === activeStorageKey || (event.key === guestTransferKey && !networkSession)) {
        viewContextRef.current.invalidate();
        window.location.reload();
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [networkSession]);

  function retryStartup() {
    databaseRef.current?.close();
    databaseRef.current = null;
    setStartupError(null);
    setIsLoading(true);
    setIsLaunchVisible(true);
    setLaunchStatus(startupStageLabels.open_local_database);
    setStartupAttempt((current) => current + 1);
    console.debug("[bookkeeping] local storage startup retry requested", { nextAttempt: startupAttempt + 1 });
  }

  const checkLegacyMigration = useCallback(async () => {
    if (isLoading || legacyMigrationRunningRef.current || isAccountSubmitting) return;
    if (syncRunningRef.current || recoveryOpenRef.current) {
      queueMicrotask(() => setLegacyNotice("正在同步或处理冲突，请稍后重新检查旧数据；原始副本仍保留。"));
      return;
    }
    legacyMigrationRunningRef.current = true;
    const isCurrent = viewContextRef.current.capture();
    const expectedScope = localStorage.getItem(activeStorageKey);
    let target: IDBDatabase | null = null;
    try {
      const legacy = await inspectLegacyData();
      if (!legacy.hasLegacyData) { if (isCurrent()) setLegacyNotice(""); return; }
      const candidate = selectLegacyMigrationSession(networkSession, legacy.session, expectedScope);
      if (!navigator.onLine || !candidate) {
        if (isCurrent()) setLegacyNotice("旧版数据已保留并锁定。请联网登录原账号后重新检查，未确认的数据不会显示或上传。");
        return;
      }
      if (!isCurrent()) return;
      setIsLegacyMigrating(true);
      setLegacyNotice("正在核验并迁移旧账本，原始副本会保留…");
      target = await openAccountDatabase(candidate.userId);
      const report = await migrateLegacyData(target, candidate);
      if (!isCurrent() || localStorage.getItem(activeStorageKey) !== expectedScope) return;
      setLegacyNotice(legacyMigrationMessage(report));
      if (!networkSession) {
        const remoteLedgers = await fetchRemoteLedgers(candidate.token, AbortSignal.timeout(10_000));
        const existing = new Set((await listLedgers(target)).map((ledger) => ledger.id));
        for (const remote of remoteLedgers) {
          if (existing.has(remote.id)) continue;
          const snapshot = await apiRequest(`/ledgers/${encodeURIComponent(remote.id)}/snapshot`, { signal: AbortSignal.timeout(10_000) }, candidate.token);
          await importRemoteLedgerSnapshot(target, snapshot, remote.role);
        }
        if (!isCurrent() || localStorage.getItem(activeStorageKey) !== expectedScope) return;
        await activateAccountDatabase(target, candidate);
        window.location.reload();
      } else if (report.migratedLedgers > 0) {
        window.location.reload();
      }
    } catch (error) {
      console.error("[legacy-migration] account migration deferred", { error });
      if (isCurrent()) setLegacyNotice(`${error instanceof Error ? error.message : "暂时无法迁移"}。旧数据仍保留并锁定，可稍后重试。`);
    } finally {
      target?.close();
      legacyMigrationRunningRef.current = false;
      setIsLegacyMigrating(false);
      if (isCurrent()) setLegacyCheckRevision((revision) => revision + 1);
    }
  }, [isLoading, isAccountSubmitting, networkSession]);

  useEffect(() => {
    let active = true;
    legacyMigrationScheduledRef.current = true;
    queueMicrotask(() => {
      if (!active) return;
      legacyMigrationScheduledRef.current = false;
      void checkLegacyMigration();
    });
    return () => { active = false; legacyMigrationScheduledRef.current = false; };
  }, [checkLegacyMigration, isOnline]);

  useEffect(() => {
    if (!isOnline || !networkSession || !databaseRef.current) return;
    void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
  }, [activeLedgerId, isOnline, networkSession, syncActiveLedger, unsyncedCount, legacyCheckRevision]);

  useEffect(() => {
    const target = notificationTargetRef.current;
    if (!target || target.ledgerId !== activeLedgerId) return;
    if (!transactions.some((transaction) => transaction.id === target.transactionId)) return;
    setActiveTab("ledger");
    setSelectedTransactionId(target.transactionId);
    notificationTargetRef.current = null;
    const url = new URL(window.location.href);
    url.searchParams.delete("ledger");
    url.searchParams.delete("transaction");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    console.debug("[notification] target transaction opened", target);
  }, [activeLedgerId, transactions]);

  useEffect(() => {
    let isActive = true;
    if (!networkSession) {
      queueMicrotask(() => setPushNotificationStatus("disabled"));
      return () => { isActive = false; };
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      queueMicrotask(() => setPushNotificationStatus("unsupported"));
      return () => { isActive = false; };
    }
    void navigator.serviceWorker.ready.then(async (registration) => {
      const subscription = await registration.pushManager.getSubscription();
      if (!isActive) return;
      if (Notification.permission === "denied") {
        setPushNotificationStatus("blocked");
        return;
      }
      setPushNotificationStatus(subscription ? "enabled" : "disabled");
      if (subscription && isOnline) {
        await saveRemotePushSubscription(networkSession.token, serializedPushSubscription(subscription));
        console.debug("[notification] existing subscription synchronized", { userId: networkSession.userId });
      }
    }).catch((error) => {
      if (isActive) setPushNotificationStatus("error");
      console.error("[notification] subscription state check failed", error);
    });
    return () => { isActive = false; };
  }, [isOnline, networkSession]);

  useEffect(() => {
    const database = databaseRef.current;
    if (!database || !networkSession || !isOnline || sessionRefreshRunningRef.current) return;
    const remainingMs = new Date(networkSession.expiresAt).getTime() - Date.now();
    if (remainingMs > 7 * 24 * 60 * 60 * 1000) return;
    if (remainingMs <= 0) {
      viewContextRef.current.invalidate();
      void lockAccountDatabase(database).then(() => window.location.reload());
      return;
    }
    sessionRefreshRunningRef.current = true;
    const isCurrent = viewContextRef.current.capture();
    void refreshAccountSession(networkSession)
      .then(async (refreshed) => {
        if (!isCurrent()) return;
        await saveNetworkSession(database, refreshed);
        if (!isCurrent()) return;
        setNetworkSession(refreshed);
        console.debug("[bookkeeping] network session refreshed", { userId: refreshed.userId });
      })
      .catch((error) => console.error("[bookkeeping] network session refresh failed", error))
      .finally(() => {
        sessionRefreshRunningRef.current = false;
      });
  }, [isOnline, networkSession]);

  useEffect(() => {
    if (!isOnline || !networkSession) return;
    const requestForegroundSync = () => {
      if (document.visibilityState === "visible") void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
    };
    const handleVisibility = () => requestForegroundSync();
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", requestForegroundSync);
    window.addEventListener("pageshow", requestForegroundSync);
    const interval = window.setInterval(requestForegroundSync, 15_000);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", requestForegroundSync);
      window.removeEventListener("pageshow", requestForegroundSync);
      window.clearInterval(interval);
    };
  }, [activeLedgerId, isOnline, networkSession, syncActiveLedger]);

  useEffect(() => {
    if (isAddingSubcategory) inlineSubcategoryInputRef.current?.focus();
  }, [isAddingSubcategory]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
      console.debug("[pwa] install prompt is available");
    };
    const handleInstalled = () => {
      setIsInstalled(true);
      setInstallPrompt(null);
      console.debug("[pwa] application installed");
    };
    const handleControllerChange = () => {
      if (isApplyingUpdateRef.current) window.location.reload();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    navigator.serviceWorker?.addEventListener("controllerchange", handleControllerChange);

    if (process.env.NODE_ENV !== "production") {
      console.debug("[pwa] service worker registration skipped in development");
    } else if (!("serviceWorker" in navigator)) {
      queueMicrotask(() => setPwaStatus("unsupported"));
      console.error("[pwa] service worker is unavailable in this browser context");
    } else {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((registration) => {
        const observeWaitingWorker = () => {
          if (registration.waiting) {
            setWaitingServiceWorker(registration.waiting);
            console.debug("[pwa] application update is ready");
          }
        };
        observeWaitingWorker();
        registration.addEventListener("updatefound", () => {
          const installingWorker = registration.installing;
          installingWorker?.addEventListener("statechange", () => {
            if (installingWorker.state === "installed" && navigator.serviceWorker.controller) observeWaitingWorker();
          });
        });
        return navigator.serviceWorker.ready;
      }).then(() => {
        setPwaStatus("ready");
        console.debug("[pwa] offline application shell is ready");
      }).catch((error) => {
        setPwaStatus("failed");
        console.error("[pwa] service worker registration failed", error);
      });
    }

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
      navigator.serviceWorker?.removeEventListener("controllerchange", handleControllerChange);
    };
  }, []);

  useEffect(() => {
    const refreshVisibleDate = () => {
      const now = new Date();
      setTransactionVisibilityDate((current) => localDateKey(current) === localDateKey(now) ? current : now);
    };
    const timer = window.setInterval(refreshVisibleDate, 60_000);
    document.addEventListener("visibilitychange", refreshVisibleDate);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisibleDate);
    };
  }, []);

  const currentMonth = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
  }).format(transactionVisibilityDate);

  const visibleTransactions = useMemo(
    () => transactions.filter((item) => isTransactionVisibleOnDate(item, transactionVisibilityDate)),
    [transactionVisibilityDate, transactions],
  );

  const monthlySummary = useMemo(
    () => summarizeTransactionsForMonth(transactions, transactionVisibilityDate, transactionVisibilityDate),
    [transactionVisibilityDate, transactions],
  );
  const monthlyExpenseMinor = monthlySummary.expenseMinor;
  const monthlyIncomeMinor = monthlySummary.incomeMinor;
  useEffect(() => {
    console.debug("[bookkeeping] current-month summary recalculated", {
      ledgerId: activeLedgerId,
      month: formatMonthTitle(transactionVisibilityDate),
      expenseMinor: monthlyExpenseMinor,
      incomeMinor: monthlyIncomeMinor,
    });
  }, [activeLedgerId, monthlyExpenseMinor, monthlyIncomeMinor, transactionVisibilityDate]);
  const statisticsSummary = useMemo(
    () => summarizeStatistics(transactions, {
      period: statisticsPeriod,
      anchor: statisticsAnchor,
      visibleOnDate: transactionVisibilityDate,
      flow: statisticsFlow,
      dimension: statisticsDimension,
    }),
    [statisticsAnchor, statisticsDimension, statisticsFlow, statisticsPeriod, transactionVisibilityDate, transactions],
  );
  useEffect(() => {
    console.debug("[bookkeeping] statistics summary recalculated", {
      ledgerId: activeLedgerId,
      period: statisticsPeriod,
      startDate: statisticsSummary.startDate,
      endDate: statisticsSummary.endDate,
      flow: statisticsFlow,
      dimension: statisticsDimension,
      expenseMinor: statisticsSummary.expenseMinor,
      incomeMinor: statisticsSummary.incomeMinor,
    });
  }, [activeLedgerId, statisticsDimension, statisticsFlow, statisticsPeriod, statisticsSummary.endDate, statisticsSummary.expenseMinor, statisticsSummary.incomeMinor, statisticsSummary.startDate]);
  const transactionDayGroups = useMemo(
    () => groupTransactionsByLocalDay(visibleTransactions),
    [visibleTransactions],
  );
  const searchResults = useMemo(() => filterTransactions(transactions, {
    query: searchDraft.query,
    scope: searchDraft.scope,
    timeRange: searchDraft.timeRange,
    type: searchDraft.type,
    minimumAmountMinor: amountInputToMinor(searchDraft.minimumAmount),
    maximumAmountMinor: amountInputToMinor(searchDraft.maximumAmount),
    currency: searchDraft.currency,
    categoryId: searchDraft.categoryId,
    accountId: searchDraft.accountId,
    creatorKey: searchDraft.creatorKey,
    statsMode: searchDraft.statsMode,
    customStartDate: searchDraft.customStartDate,
    customEndDate: searchDraft.customEndDate,
  }), [searchDraft, transactions]);
  const searchDayGroups = useMemo(() => groupTransactionsByLocalDay(searchResults), [searchResults]);
  const searchCurrencies = useMemo(() => [...new Set(transactions.map((transaction) => transaction.currency))].sort(), [transactions]);
  const searchCreators = useMemo(() => {
    const creators = new Map<string, string>();
    transactions.forEach((transaction) => creators.set(
      transactionCreatorKey(transaction),
      transaction.createdByDisplayName ?? "本机用户",
    ));
    return [...creators.entries()].map(([key, label]) => ({ key, label }));
  }, [transactions]);
  const searchMinimumMinor = amountInputToMinor(searchDraft.minimumAmount);
  const searchMaximumMinor = amountInputToMinor(searchDraft.maximumAmount);
  const hasInvalidSearchAmount = searchMinimumMinor !== null && searchMaximumMinor !== null && searchMinimumMinor > searchMaximumMinor;
  const hasInvalidSearchDate = searchDraft.timeRange === "custom"
    && (!searchDraft.customStartDate || !searchDraft.customEndDate || searchDraft.customStartDate > searchDraft.customEndDate);
  const ledgerCalendarDays = useMemo(() => buildMonthGrid(ledgerMonth), [ledgerMonth]);
  const ledgerDailyExpenses = useMemo(
    () => dailyExpenseTotalsForMonth(visibleTransactions, ledgerMonth),
    [ledgerMonth, visibleTransactions],
  );

  const manageableCategories = categories.filter((category) => category.type === entryType && !isCategoryManagerEntry(category));
  const activeCategories: Category[] = [
    ...manageableCategories,
    {
      id: `category-manager:${activeLedgerId}:${entryType}`,
      ledgerId: activeLedgerId,
      type: entryType,
      name: "自定义",
      icon: "+",
      sortOrder: Number.MAX_SAFE_INTEGER,
      status: "active",
      version: 1,
    },
  ];
  const activeSubcategories = subcategories.filter((subcategory) => subcategory.categoryId === categoryId);
  const selectedSubcategory = subcategories.find((subcategory) => subcategory.id === selectedSubcategoryId);
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? accounts[0];
  const composerAmountMinor = amountPreviewMinor(calculator.display);
  const composerExchangeRateMicros = entryCurrency === "CNY" ? 1_000_000 : Math.round(Number(exchangeRateDraft) * 1_000_000);
  const composerBasePreviewMinor = composerAmountMinor && Number.isSafeInteger(composerExchangeRateMicros) && composerExchangeRateMicros > 0
    ? Math.round((composerAmountMinor * composerExchangeRateMicros) / 1_000_000)
    : null;
  const activeLedger = ledgers.find((ledger) => ledger.id === activeLedgerId);
  const selectedTransaction = transactions.find((transaction) => transaction.id === selectedTransactionId) ?? null;
  const canManageLedgerSettings = activeLedger?.role === "owner" || activeLedger?.role === "admin" || !networkSession;
  const canMutateTransactions = activeLedger?.role !== "viewer" || !networkSession;
  const activeLedgerName = activeLedger?.name ?? "日常账本";
  const offlineStatusLabel = !isOnline
    ? "当前离线"
    : pwaStatus === "ready"
      ? "离线可用"
      : pwaStatus === "development"
        ? "开发预览"
        : pwaStatus === "failed"
          ? "离线初始化失败"
          : pwaStatus === "unsupported"
            ? "需要 HTTPS"
            : "准备离线资源";
  const installationLabel = isInstalled ? "已安装" : installPrompt ? "可以安装" : "安装说明";
  const pushNotificationLabel = pushNotificationStatus === "enabled"
    ? "已开启"
    : pushNotificationStatus === "loading"
      ? "处理中"
      : pushNotificationStatus === "blocked"
        ? "已被系统阻止"
        : pushNotificationStatus === "unsupported"
          ? "当前浏览器不支持"
          : pushNotificationStatus === "error"
            ? "设置失败"
            : "未开启";
  const networkStatusLabel = !networkSession
    ? "未登录"
    : !isOnline
      ? `离线 · ${unsyncedCount} 笔待同步`
      : syncStatus === "syncing"
        ? "正在同步"
        : syncStatus === "error"
          ? `${unsyncedCount} 笔需要处理`
          : unsyncedCount > 0
            ? `${unsyncedCount} 笔待同步`
            : "云端已同步";
  const lastSyncLabel = lastSyncedAt
    ? `上次检查 ${lastSyncedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : "等待首次检查";
  const budgetMinor = activeLedger?.monthlyBudgetMinor ?? 300_000;
  const budgetPercent = Math.min(100, Math.round((monthlyExpenseMinor / budgetMinor) * 100));
  const dailyBudgetMinor = Math.max(0, budgetMinor - monthlyExpenseMinor) / remainingDaysInLocalMonth(transactionVisibilityDate);

  function updateSearchDraft<Key extends keyof TransactionSearchDraft>(key: Key, value: TransactionSearchDraft[Key]) {
    setSearchDraft((current) => ({ ...current, [key]: value }));
  }

  function openSearch() {
    setLedgerNotice("");
    setSwipedTransactionId(null);
    setIsSearchOpen(true);
    console.debug("[bookkeeping] transaction search opened", { ledgerId: activeLedgerId });
  }

  function closeSearch() {
    setIsSearchOpen(false);
    setSwipedTransactionId(null);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (hasInvalidSearchAmount || hasInvalidSearchDate) return;
    (document.activeElement as HTMLElement | null)?.blur();
    setIsSearchFilterOpen(false);
    console.debug("[bookkeeping] transaction search submitted", {
      ledgerId: activeLedgerId,
      resultCount: searchResults.length,
      scope: searchDraft.scope,
      timeRange: searchDraft.timeRange,
    });
  }

  function resetSearch() {
    setSearchDraft(defaultTransactionSearchDraft);
    setSwipedTransactionId(null);
    console.debug("[bookkeeping] transaction search filters reset", { ledgerId: activeLedgerId });
  }

  function moveStatisticsPeriod(offset: number) {
    setStatisticsAnchor((current) => {
      const next = statisticsPeriod === "month"
        ? new Date(current.getFullYear(), current.getMonth() + offset, 1)
        : new Date(current.getFullYear() + offset, current.getMonth(), 1);
      console.debug("[bookkeeping] statistics period moved", {
        ledgerId: activeLedgerId,
        period: statisticsPeriod,
        direction: offset,
        year: next.getFullYear(),
        month: next.getMonth() + 1,
      });
      return next;
    });
  }

  function openStatisticsBreakdown(itemKey: string, itemLabel: string) {
    const dimensionFilters = statisticsDimension === "category"
      ? { categoryId: itemKey, accountId: "", creatorKey: "" }
      : statisticsDimension === "account"
        ? { categoryId: "", accountId: itemKey, creatorKey: "" }
        : { categoryId: "", accountId: "", creatorKey: itemKey };
    setSearchDraft({
      ...defaultTransactionSearchDraft,
      ...dimensionFilters,
      timeRange: "custom",
      type: statisticsFlow,
      statsMode: "included",
      customStartDate: statisticsSummary.startDate,
      customEndDate: statisticsSummary.endDate,
    });
    setIsSearchFilterOpen(false);
    setSwipedTransactionId(null);
    setIsSearchOpen(true);
    console.debug("[bookkeeping] statistics breakdown opened", {
      ledgerId: activeLedgerId,
      period: statisticsPeriod,
      dimension: statisticsDimension,
      itemKey,
      itemLabel,
      flow: statisticsFlow,
      startDate: statisticsSummary.startDate,
      endDate: statisticsSummary.endDate,
    });
  }

  function resetSearchSwipe(target: HTMLElement) {
    searchSwipeRef.current = null;
    target.classList.remove("swiping");
    target.style.setProperty("--search-swipe-offset", "0px");
  }

  async function selectEntryCurrency(currency: SupportedCurrency) {
    setEntryCurrency(currency);
    if (currency === "CNY") {
      setExchangeRateDraft("1.00");
      setExchangeRateSource("fixed");
      setExchangeRateAt(new Date().toISOString());
      return;
    }
    setIsExchangeRateLoading(true);
    try {
      const quote = await fetchUsdCnyExchangeRate();
      const rate = (quote.rateMicros / 1_000_000).toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
      setExchangeRateDraft(rate);
      setExchangeRateSource("frankfurter");
      setExchangeRateAt(quote.fetchedAt);
      localStorage.setItem(exchangeRateStorageKey, JSON.stringify({ rate, fetchedAt: quote.fetchedAt }));
      console.debug("[bookkeeping] exchange rate loaded", { pair: "USD/CNY", rateDate: quote.rateDate });
    } catch (error) {
      console.error("[bookkeeping] exchange rate load failed", error);
      try {
        const cached = JSON.parse(localStorage.getItem(exchangeRateStorageKey) ?? "null") as { rate?: unknown; fetchedAt?: unknown } | null;
        if (cached && typeof cached.rate === "string") {
          setExchangeRateDraft(cached.rate);
          setExchangeRateSource("frankfurter");
          setExchangeRateAt(typeof cached.fetchedAt === "string" ? cached.fetchedAt : new Date().toISOString());
        } else {
          setExchangeRateSource("manual");
          setErrorMessage("自动汇率暂不可用，请输入本次实际汇率");
        }
      } catch {
        setExchangeRateSource("manual");
        setErrorMessage("自动汇率暂不可用，请输入本次实际汇率");
      }
    } finally {
      setIsExchangeRateLoading(false);
    }
  }

  function startSearchSwipe(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const swipe = beginEdgeSwipe(event.clientX, event.clientY, event.timeStamp);
    if (!swipe) return;
    searchSwipeRef.current = swipe;
    event.currentTarget.classList.add("swiping");
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveSearchSwipe(event: React.PointerEvent<HTMLElement>) {
    const swipe = searchSwipeRef.current;
    if (!swipe) return;
    const offset = Math.min(event.currentTarget.clientWidth, edgeSwipeOffset(swipe, event.clientX, event.clientY));
    event.currentTarget.style.setProperty("--search-swipe-offset", `${offset}px`);
  }

  function finishSearchSwipe(event: React.PointerEvent<HTMLElement>) {
    const swipe = searchSwipeRef.current;
    if (!swipe) return;
    const shouldClose = shouldFinishEdgeSwipe(swipe, event.clientX, event.clientY, event.timeStamp);
    resetSearchSwipe(event.currentTarget);
    if (shouldClose) closeSearch();
  }

  function openComposer() {
    const defaultExpenseCategory = categories.find((category) => category.type === "expense");
    setEntryType("expense");
    if (defaultExpenseCategory) setCategoryId(defaultExpenseCategory.id);
    setCalculator(initialCalculatorState);
    setEntryCurrency("CNY");
    setExchangeRateDraft("1.00");
    setExchangeRateSource("fixed");
    setExchangeRateAt(new Date().toISOString());
    setOccurredAt(new Date());
    setIsDatePickerOpen(false);
    setSelectedSubcategoryId("");
    setNote("");
    setSelectedImages([]);
    setSelectedFlags(new Set());
    setIsAddingSubcategory(false);
    setIsDeletingSubcategories(false);
    setIsAmountConfirmed(false);
    setErrorMessage("");
    setEditingTransactionId(null);
    setIsComposerOpen(true);
  }

  function openTransactionEditor(item: BookkeepingTransaction) {
    setEntryType(item.type);
    setCalculator({ ...initialCalculatorState, display: minorToInput(item.amountMinor) });
    setEntryCurrency(item.currency === "USD" ? "USD" : "CNY");
    setExchangeRateDraft(((item.exchangeRateMicros ?? 1_000_000) / 1_000_000).toFixed(4).replace(/0+$/u, "").replace(/\.$/u, ""));
    setExchangeRateSource(item.exchangeRateSource ?? "fixed");
    setExchangeRateAt(item.exchangeRateAt ?? item.createdAt);
    setOccurredAt(new Date(item.occurredAt));
    setCategoryId(item.categoryId);
    setSelectedSubcategoryId(item.subcategoryId ?? "");
    setSelectedAccountId(item.accountId);
    setNote(item.note);
    setSelectedImages(item.images);
    setSelectedFlags(new Set([
      ...(item.isReimbursable ? ["reimbursable" as const] : []),
      ...(item.isRecurring ? ["recurring" as const] : []),
      ...(item.excludeFromStats ? ["excludeFromStats" as const] : []),
      ...(item.isPrivate ? ["private" as const] : []),
    ]));
    setIsAmountConfirmed(true);
    setIsDatePickerOpen(false);
    setEditingTransactionId(item.id);
    setErrorMessage("");
    closeTransactionDetails();
    setSwipedTransactionId(null);
    setIsComposerOpen(true);
    console.debug("[bookkeeping] transaction editor opened", { transactionId: item.id, version: item.version });
  }

  function startTransactionSwipe(event: React.PointerEvent<HTMLButtonElement>, transactionId: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    transactionSwipeRef.current = beginTransactionSwipe(
      transactionId,
      event.clientX,
      event.clientY,
      swipedTransactionId === transactionId,
    );
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveTransactionSwipe(event: React.PointerEvent<HTMLButtonElement>) {
    const swipe = transactionSwipeRef.current;
    if (!swipe) return;
    const movement = transactionSwipeMovement(swipe, event.clientX, event.clientY);
    transactionSwipeRef.current = movement.state;
    if (!movement.isHorizontal) return;
    event.currentTarget.style.setProperty("--transaction-swipe-offset", `${movement.offset}px`);
  }

  function finishTransactionSwipe(event: React.PointerEvent<HTMLButtonElement>) {
    const swipe = transactionSwipeRef.current;
    if (!swipe) return;
    event.currentTarget.style.removeProperty("--transaction-swipe-offset");
    const wasHorizontal = swipe.axis === "horizontal";
    suppressTransactionClickRef.current = wasHorizontal;
    if (wasHorizontal) {
      window.setTimeout(() => { suppressTransactionClickRef.current = false; }, 250);
      setSwipedTransactionId(shouldOpenTransactionActions(swipe, event.clientX) ? swipe.id : null);
    }
    transactionSwipeRef.current = null;
  }

  function cancelTransactionSwipe(event: React.PointerEvent<HTMLButtonElement>) {
    event.currentTarget.style.removeProperty("--transaction-swipe-offset");
    transactionSwipeRef.current = null;
  }

  function openTransactionDetails(item: BookkeepingTransaction) {
    if (suppressTransactionClickRef.current) {
      suppressTransactionClickRef.current = false;
      return;
    }
    if (swipedTransactionId === item.id) {
      setSwipedTransactionId(null);
      return;
    }
    setSelectedTransactionId(item.id);
    console.debug("[bookkeeping] transaction details opened", { transactionId: item.id });
  }

  async function handleDeleteTransaction(item: BookkeepingTransaction) {
    const database = databaseRef.current;
    if (!database || !window.confirm(`确定删除这笔${item.type === "income" ? "收入" : "支出"}吗？`)) return;
    setIsSaving(true);
    setErrorMessage("");
    try {
      await deleteTransaction(database, item.id, createId());
      setTransactions(await listTransactions(database, activeLedgerId));
      setUnsyncedCount(await countUnsyncedOperations(database));
      closeTransactionDetails();
      setSwipedTransactionId(null);
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
      console.debug("[bookkeeping] transaction deletion queued", { transactionId: item.id });
    } catch (error) {
      console.error("[bookkeeping] transaction deletion failed", error);
      setErrorMessage(error instanceof Error ? error.message : "删除失败，请稍后重试。");
    } finally {
      setIsSaving(false);
    }
  }

  async function requestAppInstallation() {
    if (isInstalled) return;
    if (!installPrompt) {
      setIsInstallGuideOpen(true);
      return;
    }
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      console.debug("[pwa] install prompt completed", { outcome: choice.outcome });
      if (choice.outcome === "accepted") setInstallPrompt(null);
    } catch (error) {
      console.error("[pwa] install prompt failed", error);
      setIsInstallGuideOpen(true);
    }
  }

  function applyApplicationUpdate() {
    if (!waitingServiceWorker) return;
    isApplyingUpdateRef.current = true;
    waitingServiceWorker.postMessage({ type: "SKIP_WAITING" });
    console.debug("[pwa] application update requested");
  }

  function restartApplication() {
    console.debug("[pwa] application restart requested", { hasPendingUpdate: Boolean(waitingServiceWorker) });
    databaseRef.current?.close();
    databaseRef.current = null;
    if (waitingServiceWorker) {
      isApplyingUpdateRef.current = true;
      waitingServiceWorker.postMessage({ type: "SKIP_WAITING" });
      window.setTimeout(() => window.location.reload(), 1_500);
      return;
    }
    window.location.reload();
  }

  function closeTransactionDetails() {
    setSelectedTransactionId(null);
    setPreviewAttachment(null);
  }

  function resetTransactionDetailSwipe(target: HTMLElement) {
    transactionDetailSwipeRef.current = null;
    target.classList.remove("swiping");
    target.style.setProperty("--detail-swipe-offset", "0px");
  }

  function startTransactionDetailSwipe(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const swipe = beginEdgeSwipe(event.clientX, event.clientY, event.timeStamp);
    if (!swipe) return;
    transactionDetailSwipeRef.current = swipe;
    event.currentTarget.classList.add("swiping");
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveTransactionDetailSwipe(event: React.PointerEvent<HTMLElement>) {
    const swipe = transactionDetailSwipeRef.current;
    if (!swipe) return;
    const offset = Math.min(event.currentTarget.clientWidth, edgeSwipeOffset(swipe, event.clientX, event.clientY));
    event.currentTarget.style.setProperty("--detail-swipe-offset", `${offset}px`);
  }

  function finishTransactionDetailSwipe(event: React.PointerEvent<HTMLElement>) {
    const swipe = transactionDetailSwipeRef.current;
    if (!swipe) return;
    const shouldClose = shouldFinishEdgeSwipe(swipe, event.clientX, event.clientY, event.timeStamp);
    resetTransactionDetailSwipe(event.currentTarget);
    if (shouldClose) {
      closeTransactionDetails();
      console.debug("[bookkeeping] transaction details closed with edge swipe");
    }
  }

  function resetComposerSwipe(target: HTMLElement) {
    composerSwipeRef.current = null;
    target.classList.remove("swiping");
    target.style.setProperty("--swipe-offset", "0px");
  }

  function startComposerSwipe(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const swipe = beginEdgeSwipe(event.clientX, event.clientY, event.timeStamp);
    if (!swipe) return;
    composerSwipeRef.current = swipe;
    event.currentTarget.classList.add("swiping");
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveComposerSwipe(event: React.PointerEvent<HTMLElement>) {
    const swipe = composerSwipeRef.current;
    if (!swipe) return;
    const offset = Math.min(event.currentTarget.clientWidth, edgeSwipeOffset(swipe, event.clientX, event.clientY));
    event.currentTarget.style.setProperty("--swipe-offset", `${offset}px`);
  }

  function finishComposerSwipe(event: React.PointerEvent<HTMLElement>) {
    const swipe = composerSwipeRef.current;
    if (!swipe) return;
    const shouldClose = shouldFinishEdgeSwipe(swipe, event.clientX, event.clientY, event.timeStamp);
    resetComposerSwipe(event.currentTarget);
    if (shouldClose) {
      setIsComposerOpen(false);
      console.debug("[bookkeeping] composer closed with edge swipe");
    }
  }

  function openLedgerPicker() {
    setLedgerNameDraft("");
    setErrorMessage("");
    setIsLedgerPickerOpen(true);
  }

  async function selectLedger(ledgerId: string) {
    const database = databaseRef.current;
    if (!database || ledgerId === activeLedgerId) {
      setIsLedgerPickerOpen(false);
      return;
    }
    viewContextRef.current.invalidate();
    const isCurrent = viewContextRef.current.capture();
    setIsLoading(true);
    setErrorMessage("");
    try {
      const [rows, categoryRows, subcategoryRows, accountRows, subscriptionRows] = await Promise.all([
        listTransactions(database, ledgerId),
        listCategories(database, ledgerId),
        listSubcategories(database, ledgerId),
        listAccounts(database, ledgerId),
        listSubscriptions(database, ledgerId),
      ]);
      if (!isCurrent()) return;
      setActiveLedgerId(ledgerId);
      setTransactions(rows);
      setCategories(categoryRows);
      setSubcategories(subcategoryRows);
      setAccounts(accountRows);
      setSubscriptions(subscriptionRows);
      setSyncStatus("idle");
      setSelectedAccountId(preferredAccountId(accountRows, ledgerId));
      const firstExpenseCategory = categoryRows.find((category) => category.type === "expense");
      if (firstExpenseCategory) setCategoryId(firstExpenseCategory.id);
      setEntryType("expense");
      setSelectedSubcategoryId("");
      operationIdRef.current = createId();
      rememberLedgerId(ledgerId);
      setIsLedgerPickerOpen(false);
      console.debug("[bookkeeping] active ledger changed", { ledgerId, activeTab, composerOpen: isComposerOpen });
    } catch (error) {
      console.error("[bookkeeping] ledger switch failed", error);
      if (isCurrent()) setErrorMessage("切换账本失败，请稍后重试。");
    } finally {
      if (isCurrent()) setIsLoading(false);
    }
  }

  async function handleCreateLedger(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const database = databaseRef.current;
    if (!database || isCreatingLedger) return;
    viewContextRef.current.invalidate();
    setIsCreatingLedger(true);
    setErrorMessage("");
    try {
      const ledgerId = `ledger-${createId()}`;
      const isFamily = Boolean(networkSession) && ledgerKindDraft === "family";
      if (isFamily && !isOnline) throw new Error("创建家庭共享账本时需要联网");
      if (networkSession && isFamily) {
        await createRemoteFamilyLedger(networkSession.token, {
          ledgerId,
          name: ledgerNameDraft,
          operationId: createId(),
        });
      }
      const ledger = await createLedger(database, ledgerNameDraft, {
        id: ledgerId,
        kind: isFamily ? "family" : "private",
        role: "owner",
      });
      if (isFamily) await markLedgerAsNetworkBound(database, ledger.id);
      setLedgers((current) => [...current, ledger]);
      setActiveLedgerId(ledger.id);
      setTransactions([]);
      setSubscriptions([]);
      const [categoryRows, subcategoryRows, accountRows] = await Promise.all([
        listCategories(database, ledger.id),
        listSubcategories(database, ledger.id),
        listAccounts(database, ledger.id),
      ]);
      setCategories(categoryRows);
      setSubcategories(subcategoryRows);
      setAccounts(accountRows);
      setSelectedAccountId(preferredAccountId(accountRows, ledger.id));
      const firstExpenseCategory = categoryRows.find((category) => category.type === "expense");
      if (firstExpenseCategory) setCategoryId(firstExpenseCategory.id);
      operationIdRef.current = createId();
      rememberLedgerId(ledger.id);
      setLedgerNameDraft("");
      setActiveTab("ledger");
      setIsLedgerPickerOpen(false);
    } catch (error) {
      console.error("[bookkeeping] ledger creation failed", error);
      setErrorMessage(error instanceof Error ? error.message : "创建账本失败");
    } finally {
      setIsCreatingLedger(false);
    }
  }

  async function handleNetworkAccountSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const database = databaseRef.current;
    if (!database || isAccountSubmitting) return;
    setIsAccountSubmitting(true);
    viewContextRef.current.invalidate();
    setErrorMessage("");
    try {
      const credentials = {
        username: accountUsername,
        password: accountPassword,
        displayName: accountDisplayName || accountUsername,
      };
      const isCreatingAccount = isNetworkInitialized === false || accountMode === "invite";
      const privateLedgerId = isCreatingAccount
        ? await ensureOfflineLedgerUsesUniqueId(database, activeLedgerId)
        : activeLedgerId;
      if (privateLedgerId !== activeLedgerId) {
        const [ledgerRows, rows, categoryRows, subcategoryRows, accountRows] = await Promise.all([
          listLedgers(database),
          listTransactions(database, privateLedgerId),
          listCategories(database, privateLedgerId),
          listSubcategories(database, privateLedgerId),
          listAccounts(database, privateLedgerId),
        ]);
        setLedgers(ledgerRows);
        setActiveLedgerId(privateLedgerId);
        setTransactions(rows);
        setCategories(categoryRows);
        setSubcategories(subcategoryRows);
        setAccounts(accountRows);
        setSelectedAccountId(preferredAccountId(accountRows, privateLedgerId));
        setCategoryId(categoryRows.find((category) => category.type === "expense")?.id ?? "");
        rememberLedgerId(privateLedgerId);
      }
      const result = isNetworkInitialized === false
        ? await bootstrapAccount(credentials, privateLedgerId)
        : accountMode === "invite"
          ? await acceptAccountInvitation(credentials, accountInviteToken, privateLedgerId)
          : await loginAccount(credentials);
      // Authentication has succeeded even if a later local transfer needs retrying.
      setIsNetworkInitialized(true);
      setAccountMode("login");
      const accountDatabase = await openAccountDatabase(result.session.userId);
      try {
        const migration = await migrateLegacyData(accountDatabase, result.session);
        setLegacyNotice(legacyMigrationMessage(migration));
        const remoteLedgers = await fetchRemoteLedgers(result.session.token);
        if (isCreatingAccount || includeGuestLedgers) await transferGuestLedgers(database, accountDatabase, result.session, isCreatingAccount ? privateLedgerId : undefined);
        const existingLedgerIds = new Set((await listLedgers(accountDatabase)).map((ledger) => ledger.id));
        for (const remoteLedger of remoteLedgers) {
          if (existingLedgerIds.has(remoteLedger.id)) continue;
          const snapshot = await fetchRemoteLedgerSnapshot(result.session.token, remoteLedger.id);
          await importRemoteLedgerSnapshot(accountDatabase, snapshot, remoteLedger.role);
        }
        const refreshedLedgers = await listLedgers(accountDatabase);
        const targetLedgerId = refreshedLedgers.some((ledger) => ledger.id === result.selectedLedgerId)
          ? result.selectedLedgerId
          : refreshedLedgers.some((ledger) => ledger.id === activeLedgerId)
            ? activeLedgerId
            : refreshedLedgers[0]?.id;
        await activateAccountDatabase(accountDatabase, result.session);
        if (targetLedgerId) rememberLedgerId(targetLedgerId);
        console.debug("[bookkeeping] network account connected", { userId: result.session.userId });
        window.location.reload();
      } finally { accountDatabase.close(); }
    } catch (error) {
      console.error("[bookkeeping] network account connection failed", error);
      setErrorMessage(error instanceof Error ? error.message : "账号连接失败");
    } finally {
      setIsAccountSubmitting(false);
    }
  }

  async function handleTransferGuestLedgers() {
    const database = databaseRef.current;
    if (!database || !networkSession || isTransferringGuestLedgers) return;
    setIsTransferringGuestLedgers(true);
    setErrorMessage("");
    viewContextRef.current.invalidate();
    const isCurrent = viewContextRef.current.capture();
    let guest: IDBDatabase | undefined;
    try {
      guest = await openBookkeepingDatabase("guest-v1");
      const count = await transferGuestLedgers(guest, database, networkSession);
      const [rows, pending] = await Promise.all([listLedgers(database), countUnsyncedOperations(database)]);
      if (!isCurrent() || databaseRef.current !== database) return;
      setLedgers(rows);
      setUnsyncedCount(pending);
      setErrorMessage(count > 0 ? `已接入 ${count} 个本机账本，联网后同步全部内容` : "没有待接入的本机账本；已移交的账本保留在所属账号中");
      if (navigator.onLine) void syncActiveLedger();
    } catch (error) {
      console.error("[bookkeeping] guest ledger transfer failed", error);
      if (!isCurrent() || databaseRef.current !== database) return;
      setErrorMessage(error instanceof Error ? error.message : "本机账本接入失败，请重试");
    } finally {
      guest?.close();
      setIsTransferringGuestLedgers(false);
    }
  }

  async function handleNetworkLogout() {
    const database = databaseRef.current;
    if (!database || !networkSession) return;
    viewContextRef.current.invalidate();
    setIsLoading(true);
    setErrorMessage("");
    try {
      await lockAccountDatabase(database);
      if (navigator.onLine) await logoutAccount(networkSession.token);
    } catch (error) {
      console.error("[bookkeeping] remote logout failed", error);
    } finally {
      window.location.reload();
    }
  }

  async function togglePushNotifications() {
    if (!networkSession || pushNotificationStatus === "loading") return;
    setErrorMessage("");
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setPushNotificationStatus("unsupported");
      setErrorMessage("当前浏览器不支持系统通知");
      return;
    }
    if (!navigator.onLine) {
      setErrorMessage("请联网后设置系统通知");
      return;
    }
    if (!isInstalled && /iPad|iPhone|iPod/u.test(navigator.userAgent)) {
      setIsInstallGuideOpen(true);
      setErrorMessage("iPhone 或 iPad 需要先将应用添加到主屏幕");
      return;
    }

    setPushNotificationStatus("loading");
    try {
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription();
      if (current) {
        await removeRemotePushSubscription(networkSession.token, current.endpoint);
        await current.unsubscribe();
        setPushNotificationStatus("disabled");
        console.debug("[notification] push notifications disabled", { userId: networkSession.userId });
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushNotificationStatus(permission === "denied" ? "blocked" : "disabled");
        return;
      }
      const publicKey = await fetchPushPublicKey(networkSession.token);
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      try {
        await saveRemotePushSubscription(networkSession.token, serializedPushSubscription(subscription));
      } catch (error) {
        await subscription.unsubscribe();
        throw error;
      }
      setPushNotificationStatus("enabled");
      console.debug("[notification] push notifications enabled", { userId: networkSession.userId });
    } catch (error) {
      setPushNotificationStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "通知设置失败，请稍后重试");
      console.error("[notification] push notification toggle failed", error);
    }
  }

  async function handleCreateInvitation() {
    if (!networkSession || activeLedger?.kind !== "family") return;
    setErrorMessage("");
    try {
      const invitation = await createRemoteInvitation(networkSession.token, activeLedgerId);
      setLatestInvite({ token: invitation.inviteToken, expiresAt: invitation.expiresAt });
    } catch (error) {
      console.error("[bookkeeping] invitation creation failed", error);
      setErrorMessage(error instanceof Error ? error.message : "创建邀请失败");
    }
  }

  function openAccountManager(account?: Account) {
    setAccountEditingId(account?.id ?? null);
    setAccountNameDraft(account?.name ?? "");
    setAccountTypeDraft(account?.type ?? "cash");
    setErrorMessage("");
    setIsAccountManagerOpen(true);
  }

  async function handleSaveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const database = databaseRef.current;
    if (!database || !canManageLedgerSettings) return;
    try {
      const saved = await saveAccount(database, {
        id: accountEditingId ?? undefined,
        ledgerId: activeLedgerId,
        name: accountNameDraft,
        type: accountTypeDraft,
      });
      const accountRows = await listAccounts(database, activeLedgerId);
      setAccounts(accountRows);
      setSelectedAccountId(saved.id);
      rememberAccountId(activeLedgerId, saved.id);
      setAccountEditingId(saved.id);
      setAccountNameDraft(saved.name);
      setUnsyncedCount(await countUnsyncedOperations(database));
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
      console.debug("[bookkeeping] account saved", { accountId: saved.id, ledgerId: activeLedgerId });
    } catch (error) {
      console.error("[bookkeeping] account save failed", error);
      setErrorMessage(error instanceof Error ? error.message : "保存账户失败");
    }
  }

  async function handleDeactivateAccount(account: Account) {
    const database = databaseRef.current;
    if (!database || !canManageLedgerSettings || accounts.length <= 1) return;
    try {
      await deactivateAccount(database, account.id, activeLedgerId);
      const accountRows = await listAccounts(database, activeLedgerId);
      setAccounts(accountRows);
      if (selectedAccountId === account.id) {
        const fallbackAccountId = accountRows[0]?.id ?? "";
        setSelectedAccountId(fallbackAccountId);
        if (fallbackAccountId) rememberAccountId(activeLedgerId, fallbackAccountId);
      }
      if (accountEditingId === account.id) {
        setAccountEditingId(null);
        setAccountNameDraft("");
      }
      setUnsyncedCount(await countUnsyncedOperations(database));
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
      console.debug("[bookkeeping] account deactivated", { accountId: account.id, ledgerId: activeLedgerId });
    } catch (error) {
      console.error("[bookkeeping] account deactivation failed", error);
      setErrorMessage(error instanceof Error ? error.message : "停用账户失败");
    }
  }

  function selectEntryType(type: EntryType) {
    setEntryType(type);
    const firstCategory = categories.find((category) => category.type === type);
    if (firstCategory) setCategoryId(firstCategory.id);
    setSelectedSubcategoryId("");
    setIsAddingSubcategory(false);
    setIsDeletingSubcategories(false);
    confirmAmountInput();
  }

  function selectCategory(id: string) {
    setCategoryId(id);
    setSelectedSubcategoryId("");
    setIsAddingSubcategory(false);
    setIsDeletingSubcategories(false);
    confirmAmountInput();
  }

  function selectSubcategory(id: string) {
    setSelectedSubcategoryId(selectedSubcategoryId === id ? "" : id);
    confirmAmountInput();
  }

  function toggleTransactionFlag(flag: TransactionFlag) {
    setSelectedFlags((current) => {
      const next = new Set(current);
      if (next.has(flag)) next.delete(flag);
      else next.add(flag);
      return next;
    });
  }

  function appendDigit(digit: string) {
    setErrorMessage("");
    setCalculator((current) => inputDigit(current, digit));
  }

  function appendDecimal() {
    setCalculator((current) => inputDecimal(current));
  }

  function backspace() {
    setCalculator((current) => removeLastDigit(current));
  }

  function chooseOperator(operator: MathOperator) {
    try {
      setCalculator(selectOperator(calculator, operator));
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "金额计算失败");
    }
  }

  function handleImageSelection(files: FileList | null) {
    if (!files) return;
    setErrorMessage("");
    const candidates = Array.from(files);
    const validationError = validateImageCandidates(selectedImages, candidates);
    if (validationError) {
      setErrorMessage(validationError);
      console.error("[bookkeeping] rejected image attachments", { count: candidates.length, reason: validationError });
      return;
    }
    setSelectedImages((current) => [
      ...current,
      ...candidates.map((file) => ({ id: createId(), name: file.name, type: file.type, size: file.size, blob: file })),
    ]);
    if (imageInputRef.current) imageInputRef.current.value = "";
    console.debug("[bookkeeping] image attachments selected", { count: candidates.length });
  }

  function closeCategoryManager() {
    setIsCategoryEditorOpen(false);
    setIsCategoryManageEditing(false);
    setIsCategoryFormOpen(false);
    setIsAddingSubcategory(false);
    setIsDeletingSubcategories(false);
    setInlineSubcategoryEditingId(null);
  }

  function openCategoryManager() {
    const selectedCategory = manageableCategories.find((category) => category.id === categoryId) ?? manageableCategories[0];
    setIsCategoryManageEditing(true);
    if (selectedCategory) openCategoryEditor(selectedCategory);
    else setIsCategoryFormOpen(false);
    setIsCategoryEditorOpen(true);
    confirmAmountInput();
  }

  function toggleCategoryManageEditing() {
    if (isCategoryManageEditing) {
      setIsCategoryManageEditing(false);
      setIsCategoryFormOpen(false);
      setIsAddingSubcategory(false);
      setIsDeletingSubcategories(false);
      setInlineSubcategoryEditingId(null);
      return;
    }
    const selectedCategory = manageableCategories.find((category) => category.id === categoryId) ?? manageableCategories[0];
    setIsCategoryManageEditing(true);
    if (selectedCategory) openCategoryEditor(selectedCategory);
  }

  function openCategoryEditor(category?: Category) {
    setCategoryEditingId(category?.id ?? null);
    setCategoryNameDraft(category?.name ?? "");
    setCategoryIconDraft(category?.icon ?? "");
    if (category) {
      setCategoryId(category.id);
      setSelectedSubcategoryId("");
    }
    setIsAddingSubcategory(false);
    setIsDeletingSubcategories(false);
    setInlineSubcategoryEditingId(null);
    setErrorMessage("");
    setIsCategoryFormOpen(true);
  }

  async function handleSaveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const database = databaseRef.current;
    if (!database) return;
    try {
      const saved = await saveCategory(database, {
        id: categoryEditingId ?? undefined,
        ledgerId: activeLedgerId,
        type: entryType,
        name: categoryNameDraft,
        icon: categoryIconDraft,
      });
      setCategories(await listCategories(database, activeLedgerId));
      setCategoryId(saved.id);
      setSelectedSubcategoryId("");
      setCategoryEditingId(saved.id);
      setCategoryNameDraft(saved.name);
      setCategoryIconDraft(saved.icon);
      setIsCategoryFormOpen(true);
      setUnsyncedCount(await countUnsyncedOperations(database));
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
      console.debug("[bookkeeping] category editor saved", { categoryId: saved.id });
    } catch (error) {
      console.error("[bookkeeping] category save failed", error);
      setErrorMessage(error instanceof Error ? error.message : "保存分类失败");
    }
  }

  function startAddingSubcategory() {
    setInlineSubcategoryEditingId(null);
    setSubcategoryNameDraft("");
    setIsDeletingSubcategories(false);
    setIsAddingSubcategory(true);
    confirmAmountInput();
  }

  function startEditingSubcategory(subcategory: Subcategory) {
    setInlineSubcategoryEditingId(subcategory.id);
    setSubcategoryNameDraft(subcategory.name);
    setIsDeletingSubcategories(false);
    setIsAddingSubcategory(true);
    confirmAmountInput();
  }

  async function saveInlineSubcategory() {
    const database = databaseRef.current;
    const name = subcategoryNameDraft.trim();
    if (!database || !categoryId || isSubcategoryMutationRunningRef.current) return;
    if (!name) {
      setIsAddingSubcategory(false);
      setInlineSubcategoryEditingId(null);
      return;
    }
    isSubcategoryMutationRunningRef.current = true;
    try {
      const saved = await saveSubcategory(database, {
        id: inlineSubcategoryEditingId ?? undefined,
        ledgerId: activeLedgerId,
        categoryId,
        name,
      });
      setSubcategories(await listSubcategories(database, activeLedgerId));
      setSelectedSubcategoryId(saved.id);
      setSubcategoryNameDraft("");
      setIsAddingSubcategory(false);
      setInlineSubcategoryEditingId(null);
      setUnsyncedCount(await countUnsyncedOperations(database));
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
      console.debug("[bookkeeping] inline subcategory saved", { subcategoryId: saved.id });
    } catch (error) {
      console.error("[bookkeeping] inline subcategory save failed", error);
      setErrorMessage(error instanceof Error ? error.message : "保存子标签失败");
      inlineSubcategoryInputRef.current?.focus();
    } finally {
      isSubcategoryMutationRunningRef.current = false;
    }
  }

  async function removeInlineSubcategory(subcategory: Subcategory) {
    const database = databaseRef.current;
    if (!database || isSubcategoryMutationRunningRef.current) return;
    isSubcategoryMutationRunningRef.current = true;
    setErrorMessage("");
    try {
      await deleteSubcategory(database, {
        id: subcategory.id,
        ledgerId: activeLedgerId,
        categoryId,
      });
      setSubcategories(await listSubcategories(database, activeLedgerId));
      if (selectedSubcategoryId === subcategory.id) setSelectedSubcategoryId("");
      if (inlineSubcategoryEditingId === subcategory.id) {
        setInlineSubcategoryEditingId(null);
        setIsAddingSubcategory(false);
      }
      setUnsyncedCount(await countUnsyncedOperations(database));
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
      console.debug("[bookkeeping] inline subcategory deleted", { subcategoryId: subcategory.id });
    } catch (error) {
      console.error("[bookkeeping] inline subcategory delete failed", error);
      setErrorMessage(error instanceof Error ? error.message : "删除子标签失败");
    } finally {
      isSubcategoryMutationRunningRef.current = false;
    }
  }

  function selectCategoryManagerType(type: EntryType) {
    selectEntryType(type);
    setIsCategoryFormOpen(false);
    setCategoryEditingId(null);
    setIsAddingSubcategory(false);
    setIsDeletingSubcategories(false);
    setInlineSubcategoryEditingId(null);
  }

  function renderSubcategoryControls(mode: "select" | "edit") {
    return (
      <section className="subtag-section" aria-label={mode === "edit" ? "编辑子标签" : "子标签"}>
        {activeSubcategories.map((subcategory) => {
          const isSelected = mode === "select" && selectedSubcategoryId === subcategory.id;
          const actionLabel = isDeletingSubcategories
            ? `删除子标签${subcategory.name}`
            : mode === "edit"
              ? `编辑子标签${subcategory.name}`
              : `选择子标签${subcategory.name}`;
          return (
            <button key={subcategory.id} className={`${isSelected ? "selected" : ""} ${isDeletingSubcategories ? "deleting" : ""}`} type="button" aria-pressed={!isDeletingSubcategories && isSelected} aria-label={actionLabel} onClick={() => isDeletingSubcategories ? void removeInlineSubcategory(subcategory) : mode === "edit" ? startEditingSubcategory(subcategory) : selectSubcategory(subcategory.id)}>
              {isDeletingSubcategories ? <span className="subtag-delete-mark" aria-hidden="true">×</span> : null}{subcategory.name}
            </button>
          );
        })}
        {isAddingSubcategory ? <input ref={inlineSubcategoryInputRef} className="inline-subtag-input" value={subcategoryNameDraft} maxLength={10} aria-label={inlineSubcategoryEditingId ? "编辑子标签名称" : "新子标签名称"} onChange={(event) => setSubcategoryNameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveInlineSubcategory(); } else if (event.key === "Escape") { setIsAddingSubcategory(false); setInlineSubcategoryEditingId(null); } }} onBlur={() => void saveInlineSubcategory()} /> : null}
        {!isAddingSubcategory && !isDeletingSubcategories ? <button className="subtag-control" type="button" aria-label="新增子标签" onClick={startAddingSubcategory}>＋</button> : null}
        {!isAddingSubcategory && !isDeletingSubcategories && activeSubcategories.length > 0 ? <button className="subtag-control" type="button" aria-label="删除子标签" onClick={() => { setIsDeletingSubcategories(true); confirmAmountInput(); }}>−</button> : null}
        {isDeletingSubcategories ? <button className="subtag-delete-done" type="button" onClick={() => setIsDeletingSubcategories(false)}>完成</button> : null}
      </section>
    );
  }

  function confirmAmountInput() {
    try {
      const amountMinor = resolveCalculator(calculator);
      const exchangeRateMicros = entryCurrency === "CNY" ? 1_000_000 : Math.round(Number(exchangeRateDraft) * 1_000_000);
      const baseAmountMinor = convertToBaseAmountMinor(amountMinor, exchangeRateMicros);
      setCalculator({ ...initialCalculatorState, display: minorToInput(amountMinor) });
      setIsAmountConfirmed(true);
      setErrorMessage("");
      console.debug("[bookkeeping] amount input confirmed", { amountMinor, baseAmountMinor, currency: entryCurrency });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "请检查金额");
    }
  }

  async function persistTransaction(continueEntry: boolean) {
    const database = databaseRef.current;
    if (!database || isSaving) return;

    setIsSaving(true);
    setErrorMessage("");
    try {
      const amountMinor = resolveCalculator(calculator);
      const exchangeRateMicros = entryCurrency === "CNY" ? 1_000_000 : Math.round(Number(exchangeRateDraft) * 1_000_000);
      const baseAmountMinor = convertToBaseAmountMinor(amountMinor, exchangeRateMicros);
      const selectedCategory = activeCategories.find((item) => item.id === categoryId) ?? activeCategories[0];
      const transactionInput = {
        operationId: operationIdRef.current,
        ledgerId: activeLedgerId,
        type: entryType,
        amountMinor,
        currency: entryCurrency,
        baseAmountMinor,
        exchangeRateMicros,
        exchangeRateSource: entryCurrency === "CNY" ? "fixed" as const : exchangeRateSource,
        exchangeRateAt,
        occurredAt: occurredAt.toISOString(),
        categoryId: selectedCategory.id,
        categoryName: selectedCategory.name,
        subcategoryId: selectedSubcategory?.id ?? null,
        subcategoryName: selectedSubcategory?.name ?? "",
        accountId: selectedAccount?.id ?? accountIdForLedger(activeLedgerId),
        accountName: selectedAccount?.name ?? "现金",
        note,
        images: selectedImages,
        excludeFromStats: selectedFlags.has("excludeFromStats"),
        isReimbursable: selectedFlags.has("reimbursable"),
        isRecurring: selectedFlags.has("recurring"),
        isPrivate: selectedFlags.has("private"),
        createdByUserId: networkSession?.userId,
        createdByDisplayName: networkSession?.displayName ?? "本机用户",
      };
      if (editingTransactionId) {
        await updateTransaction(database, editingTransactionId, transactionInput);
      } else {
        await createTransaction(database, transactionInput);
      }
      setTransactions(await listTransactions(database, activeLedgerId));
      setUnsyncedCount(await countUnsyncedOperations(database));
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
      operationIdRef.current = createId();
      if (continueEntry && !editingTransactionId) {
        setCalculator(initialCalculatorState);
        setOccurredAt(new Date());
        setSelectedSubcategoryId("");
        setNote("");
        setSelectedImages([]);
        setSelectedFlags(new Set());
        setIsAmountConfirmed(false);
        console.debug("[bookkeeping] transaction saved and composer reset for next entry");
      } else {
        setCalculator({ ...initialCalculatorState, display: minorToInput(amountMinor) });
        setIsComposerOpen(false);
        setActiveTab("ledger");
        setEditingTransactionId(null);
        console.debug("[bookkeeping] transaction saved and ledger opened", { editing: Boolean(editingTransactionId) });
      }
    } catch (error) {
      console.error("[bookkeeping] transaction save failed", error);
      setErrorMessage(error instanceof Error ? error.message : "保存失败，请稍后重试。");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleProfileDisplayNameSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const database = databaseRef.current;
    const displayName = profileDisplayNameDraft.trim();
    if (!database || !networkSession || !displayName || isProfileSaving) return;
    setIsProfileSaving(true);
    setErrorMessage("");
    try {
      const savedDisplayName = await updateAccountDisplayName(networkSession.token, displayName);
      const updatedSession = { ...networkSession, displayName: savedDisplayName };
      await Promise.all([
        saveNetworkSession(database, updatedSession),
        updateLocalCreatorDisplayName(database, networkSession.userId, savedDisplayName),
      ]);
      setNetworkSession(updatedSession);
      setTransactions(await listTransactions(database, activeLedgerId));
      setIsProfileEditing(false);
      console.debug("[bookkeeping] profile display name updated", { userId: networkSession.userId });
    } catch (error) {
      console.error("[bookkeeping] profile display name update failed", error);
      setErrorMessage(error instanceof Error ? error.message : "显示名称修改失败，请稍后重试。");
    } finally {
      setIsProfileSaving(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await persistTransaction(false);
  }

  function renderTransactionGroups(groups: ReturnType<typeof groupTransactionsByLocalDay>, idPrefix = "ledger") {
    return (
      <div className="transaction-day-groups">
        {groups.map((group) => (
          <section className="transaction-day-group" key={group.key} aria-labelledby={`${idPrefix}-day-${group.key}`}>
            <header>
              <h2 id={`${idPrefix}-day-${group.key}`}>{group.label}</h2>
              <p>
                {group.incomeMinor > 0 ? <span>收入 {formatMinorAmount(group.incomeMinor)}</span> : null}
                {group.expenseMinor > 0 ? <span>支出 {formatMinorAmount(group.expenseMinor)}</span> : null}
              </p>
            </header>
            <ul className="transaction-list">
              {group.transactions.map((item) => (
                <li className={`transaction-swipe-row ${swipedTransactionId === item.id ? "swiped" : ""}`} key={item.id}>
                  {canMutateTransactions ? <span className="transaction-swipe-actions" aria-hidden={swipedTransactionId !== item.id}>
                    <button className="transaction-edit-action" type="button" tabIndex={swipedTransactionId === item.id ? 0 : -1} onClick={() => openTransactionEditor(item)}>编辑</button>
                    <button className="transaction-delete-action" type="button" tabIndex={swipedTransactionId === item.id ? 0 : -1} onClick={() => void handleDeleteTransaction(item)}>删除</button>
                  </span> : null}
                  <button
                    className="transaction-list-item"
                    type="button"
                    onClick={() => openTransactionDetails(item)}
                    onPointerDown={canMutateTransactions ? (event) => startTransactionSwipe(event, item.id) : undefined}
                    onPointerMove={canMutateTransactions ? moveTransactionSwipe : undefined}
                    onPointerUp={canMutateTransactions ? finishTransactionSwipe : undefined}
                    onPointerCancel={canMutateTransactions ? cancelTransactionSwipe : undefined}
                  >
                    <span className="category-badge" aria-hidden="true">
                      {categories.find((category) => category.id === item.categoryId || item.categoryId.endsWith(`:${category.id}`))?.icon ?? "记"}
                    </span>
                    <span className="transaction-copy">
                      <strong>{formatTransactionCategory(item.categoryName, item.subcategoryName)}</strong>
                      <small>{item.note ? `${item.note} · ` : ""}{item.accountName} · {new Date(item.occurredAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>
                      <small className="transaction-recorder">{item.createdByDisplayName ?? "本机用户"}记录</small>
                    </span>
                    <span className="transaction-amount-column">
                      <b className={item.type === "income" ? "income-amount" : "expense-amount"}>{item.type === "income" ? "+" : "-"}{formatMinorAmount(item.amountMinor, item.currency)}</b>
                      {item.currency !== "CNY" ? <small>约 {formatMinorAmount(transactionBaseAmountMinor(item))}</small> : null}
                      {item.images.length > 0 ? <small className="transaction-attachment-indicator" aria-label={`${item.images.length} 个附件`}>附件 {item.images.length}</small> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  function renderSearch() {
    return (
      <section
        className="transaction-search-screen"
        aria-label="账单搜索"
        onPointerDown={startSearchSwipe}
        onPointerMove={moveSearchSwipe}
        onPointerUp={finishSearchSwipe}
        onPointerCancel={(event) => resetSearchSwipe(event.currentTarget)}
      >
        <header className="transaction-search-header">
          <button className="screen-back-button" type="button" aria-label="返回流水" onClick={closeSearch}>‹</button>
          <h1>账单搜索</h1>
          <span aria-hidden="true" />
        </header>
        <form className="transaction-search-form" onSubmit={submitSearch}>
          <div className="transaction-search-bar">
            <select value={searchDraft.scope} aria-label="搜索范围" onChange={(event) => updateSearchDraft("scope", event.target.value as TransactionSearchScope)}>
              <option value="all">全部</option>
              <option value="category">分类</option>
              <option value="note">描述</option>
              <option value="account">账户</option>
              <option value="creator">记录人</option>
            </select>
            <input value={searchDraft.query} type="search" enterKeyHint="search" autoFocus placeholder="输入搜索关键词" aria-label="搜索关键词" onChange={(event) => updateSearchDraft("query", event.target.value)} />
            <button type="submit" disabled={hasInvalidSearchAmount || hasInvalidSearchDate}><span aria-hidden="true">⌕</span>搜索</button>
          </div>
          <button className="search-filter-toggle" type="button" aria-expanded={isSearchFilterOpen} onClick={() => setIsSearchFilterOpen((current) => !current)}><span aria-hidden="true">{isSearchFilterOpen ? "⌃" : "⌄"}</span>{isSearchFilterOpen ? "收起筛选" : "展开筛选"}</button>
          {isSearchFilterOpen ? (
            <div className="search-filter-panel">
              <label><span>时间</span><select value={searchDraft.timeRange} onChange={(event) => updateSearchDraft("timeRange", event.target.value as TransactionSearchTimeRange)}><option value="all">全部时间</option><option value="7d">最近七天</option><option value="30d">最近三十天</option><option value="90d">最近九十天</option><option value="month">本月</option><option value="custom">指定区间</option></select></label>
              {searchDraft.timeRange === "custom" ? <div className="search-date-row"><span>日期区间</span><div><input type="date" lang="zh-CN" aria-label="开始日期" value={searchDraft.customStartDate} onChange={(event) => updateSearchDraft("customStartDate", event.target.value)} /><i aria-hidden="true">—</i><input type="date" lang="zh-CN" aria-label="结束日期" value={searchDraft.customEndDate} onChange={(event) => updateSearchDraft("customEndDate", event.target.value)} /></div>{hasInvalidSearchDate ? <small role="alert">请选择有效的开始和结束日期</small> : null}</div> : null}
              <label><span>账单类型</span><select value={searchDraft.type} onChange={(event) => updateSearchDraft("type", event.target.value as TransactionSearchDraft["type"])}><option value="all">全部</option><option value="expense">支出</option><option value="income">收入</option></select></label>
              <div className="search-amount-row"><span>金额区间</span><div><input value={searchDraft.minimumAmount} type="number" min="0" step="0.01" placeholder="最小金额" aria-label="最小金额" onChange={(event) => updateSearchDraft("minimumAmount", event.target.value)} /><i aria-hidden="true">—</i><input value={searchDraft.maximumAmount} type="number" min="0" step="0.01" placeholder="最大金额" aria-label="最大金额" onChange={(event) => updateSearchDraft("maximumAmount", event.target.value)} /></div>{hasInvalidSearchAmount ? <small role="alert">最小金额不能大于最大金额</small> : null}</div>
              <label><span>分类</span><select value={searchDraft.categoryId} onChange={(event) => updateSearchDraft("categoryId", event.target.value)}><option value="">全部</option>{categories.filter((category) => !isCategoryManagerEntry(category)).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label>
              <label><span>币种</span><select value={searchDraft.currency} onChange={(event) => updateSearchDraft("currency", event.target.value)}><option value="">全部</option>{searchCurrencies.map((currency) => <option value={currency} key={currency}>{currency}</option>)}</select></label>
              <label><span>账户</span><select value={searchDraft.accountId} onChange={(event) => updateSearchDraft("accountId", event.target.value)}><option value="">全部</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
              <label><span>记录成员</span><select value={searchDraft.creatorKey} onChange={(event) => updateSearchDraft("creatorKey", event.target.value)}><option value="">全部</option>{searchCreators.map((creator) => <option value={creator.key} key={creator.key}>{creator.label}</option>)}</select></label>
              <label><span>参与统计</span><select value={searchDraft.statsMode} onChange={(event) => updateSearchDraft("statsMode", event.target.value as TransactionSearchStatsMode)}><option value="all">全部</option><option value="included">参与统计</option><option value="excluded">不参与统计</option></select></label>
              <div className="search-filter-actions"><button type="button" onClick={resetSearch}>重置</button><button type="submit" disabled={hasInvalidSearchAmount || hasInvalidSearchDate}>确定</button></div>
            </div>
          ) : null}
        </form>
        <section className="transaction-search-results" aria-labelledby="search-results-title">
          <header><div><p>当前账本</p><h2 id="search-results-title">搜索结果</h2></div><span>{searchResults.length} 笔</span></header>
          {searchResults.length > 0 ? renderTransactionGroups(searchDayGroups, "search") : <div className="search-empty"><span aria-hidden="true">⌕</span><h3>没有找到相关账目</h3><p>换个关键词，或放宽筛选条件后再试。</p><button type="button" onClick={resetSearch}>重置筛选</button></div>}
        </section>
      </section>
    );
  }

  function renderLedger() {
    return (
      <>
        <section className="ledger-view-toolbar" aria-label="流水展示方式">
          <div className="ledger-view-buttons">
            <button className={ledgerView === "flow" ? "active" : ""} type="button" aria-pressed={ledgerView === "flow"} onClick={() => { setLedgerView("flow"); setLedgerNotice(""); }}><span aria-hidden="true">☷</span><small>流水</small></button>
            <button className={ledgerView === "calendar" ? "active" : ""} type="button" aria-pressed={ledgerView === "calendar"} onClick={() => { setLedgerView("calendar"); setLedgerNotice(""); }}><span aria-hidden="true">▣</span><small>日历</small></button>
          </div>
          {ledgerView === "calendar" ? <button className="ledger-month-trigger" type="button" aria-label={`选择年月，当前${formatMonthTitle(ledgerMonth)}`} onClick={() => setIsLedgerMonthPickerOpen(true)}><small>{ledgerMonth.getFullYear()}年</small><strong>{ledgerMonth.getMonth() + 1}月</strong><span aria-hidden="true">⌄</span></button> : <div className="ledger-view-title"><small>默认视图</small><strong>流水</strong></div>}
          <button className="ledger-search-placeholder" type="button" onClick={openSearch}><span aria-hidden="true">⌕</span><small>搜索</small></button>
        </section>
        {ledgerNotice ? <p className="ledger-notice" role="status">{ledgerNotice}</p> : null}
        {ledgerView === "calendar" ? (
          <section className="ledger-calendar-panel" aria-labelledby="ledger-calendar-heading">
            <h1 id="ledger-calendar-heading" className="visually-hidden-heading">{formatMonthTitle(ledgerMonth)}每日支出</h1>
            <div className="ledger-calendar-weekdays">{weekdayLabels.map((label) => <span key={label}>{label}</span>)}</div>
            <div className="ledger-calendar-grid">
              {ledgerCalendarDays.map((day) => {
                const expenseMinor = day.belongsToMonth ? ledgerDailyExpenses.get(localDateKey(day.date)) ?? 0 : 0;
                const isToday = isSameLocalDay(day.date, new Date());
                return <div key={localDateKey(day.date)} className={`${day.belongsToMonth ? "" : "outside"} ${isToday ? "today" : ""}`}><strong>{day.date.getDate()}</strong><small>{expenseMinor > 0 ? formatCalendarExpense(expenseMinor) : ""}</small></div>;
              })}
            </div>
          </section>
        ) : <section className="transaction-section ledger-flow-section" aria-labelledby="transaction-heading">
          <div className="section-heading"><div><p>按天展示</p><h1 id="transaction-heading">账目流水</h1></div><span className="record-count">{visibleTransactions.length} 笔</span></div>
          {isLoading ? (
            <div className="empty-state" aria-live="polite">正在读取本地账本…</div>
          ) : visibleTransactions.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon" aria-hidden="true">记</span>
              <h2>{transactions.length > 0 ? "暂无已发生流水" : "从第一笔开始"}</h2>
              <p>{transactions.length > 0 ? "未来日期的流水将在对应日期当天自动显示。" : "未登录时保存在当前设备；登录后会自动同步到云端。"}</p>
              <button type="button" onClick={openComposer}>{transactions.length > 0 ? "继续记一笔" : "记一笔支出"}</button>
            </div>
          ) : renderTransactionGroups(transactionDayGroups)}
        </section>}
      </>
    );
  }

  function renderStatistics() {
    const periodTitle = statisticsPeriod === "month"
      ? formatMonthTitle(statisticsAnchor)
      : `${statisticsAnchor.getFullYear()}年`;
    const currentPeriodStart = statisticsPeriod === "month"
      ? new Date(transactionVisibilityDate.getFullYear(), transactionVisibilityDate.getMonth(), 1)
      : new Date(transactionVisibilityDate.getFullYear(), 0, 1);
    const selectedPeriodStart = statisticsPeriod === "month"
      ? new Date(statisticsAnchor.getFullYear(), statisticsAnchor.getMonth(), 1)
      : new Date(statisticsAnchor.getFullYear(), 0, 1);
    const canMoveForward = selectedPeriodStart < currentPeriodStart;
    const trendValues = statisticsSummary.trend.map((bucket) => statisticsFlow === "expense" ? bucket.expenseMinor : bucket.incomeMinor);
    const trendMaximum = Math.max(1, ...trendValues);
    const flowLabel = statisticsFlow === "expense" ? "支出" : "收入";
    const dimensionLabel = statisticsDimension === "category" ? "分类" : statisticsDimension === "account" ? "账户" : "成员";
    const statisticsBudgetMinor = budgetMinor * (statisticsPeriod === "year" ? 12 : 1);
    const statisticsBudgetPercent = statisticsBudgetMinor > 0
      ? Math.round((statisticsSummary.expenseMinor / statisticsBudgetMinor) * 100)
      : 0;
    const forecastExpenseMinor = statisticsSummary.forecastExpenseMinor;
    const forecastDifferenceMinor = forecastExpenseMinor === null ? null : forecastExpenseMinor - statisticsBudgetMinor;
    const balanceMinor = statisticsSummary.incomeMinor - statisticsSummary.expenseMinor;
    const previousBalanceMinor = statisticsSummary.previousIncomeMinor - statisticsSummary.previousExpenseMinor;

    return (
      <section className="page-panel statistics-page">
        <div className="page-title statistics-title"><div><p>人民币结算口径</p><h1>收支统计</h1></div><button type="button" onClick={() => { setStatisticsAnchor(startOfLocalMonth(transactionVisibilityDate)); console.debug("[bookkeeping] statistics returned to current period", { ledgerId: activeLedgerId, period: statisticsPeriod }); }}>回到本期</button></div>
        <div className="statistics-period-tabs" role="group" aria-label="统计周期">
          <button className={statisticsPeriod === "month" ? "selected" : ""} type="button" aria-pressed={statisticsPeriod === "month"} onClick={() => setStatisticsPeriod("month")}>月度</button>
          <button className={statisticsPeriod === "year" ? "selected" : ""} type="button" aria-pressed={statisticsPeriod === "year"} onClick={() => setStatisticsPeriod("year")}>年度</button>
        </div>
        <div className="statistics-period-switcher">
          <button type="button" aria-label={statisticsPeriod === "month" ? "上个月" : "上一年"} onClick={() => moveStatisticsPeriod(-1)}>‹</button>
          <button className="statistics-period-trigger" type="button" aria-label={`选择统计周期，当前${periodTitle}`} onClick={() => setIsStatisticsPeriodPickerOpen(true)}><strong>{periodTitle}</strong><span aria-hidden="true">⌄</span></button>
          <button type="button" disabled={!canMoveForward} aria-label={statisticsPeriod === "month" ? "下个月" : "下一年"} onClick={() => moveStatisticsPeriod(1)}>›</button>
        </div>
        <div className="stat-grid">
          <article><span>收入</span><strong className="positive-text">{formatMinorAmount(statisticsSummary.incomeMinor)}</strong><small className={statisticsChangeTone(statisticsSummary.incomeMinor, statisticsSummary.previousIncomeMinor, "income")}>{formatStatisticsChange(statisticsSummary.incomeMinor, statisticsSummary.previousIncomeMinor, statisticsPeriod)}</small></article>
          <article><span>支出</span><strong>{formatMinorAmount(statisticsSummary.expenseMinor)}</strong><small className={statisticsChangeTone(statisticsSummary.expenseMinor, statisticsSummary.previousExpenseMinor, "expense")}>{formatStatisticsChange(statisticsSummary.expenseMinor, statisticsSummary.previousExpenseMinor, statisticsPeriod)}</small></article>
          <article className="wide"><span>结余</span><strong className={balanceMinor >= 0 ? "positive-text" : ""}>{formatMinorAmount(balanceMinor)}</strong><small>{formatStatisticsAmountChange(balanceMinor, previousBalanceMinor, statisticsPeriod)}</small></article>
        </div>
        <div className="statistics-flow-tabs" role="group" aria-label="趋势与排行类型">
          <button className={statisticsFlow === "expense" ? "selected" : ""} type="button" aria-pressed={statisticsFlow === "expense"} onClick={() => setStatisticsFlow("expense")}>支出分析</button>
          <button className={statisticsFlow === "income" ? "selected" : ""} type="button" aria-pressed={statisticsFlow === "income"} onClick={() => setStatisticsFlow("income")}>收入分析</button>
        </div>
        <article className="statistics-card statistics-trend-card">
          <header><div><p>{periodTitle}</p><h2>{flowLabel}趋势</h2></div><strong>{formatMinorAmount(statisticsFlow === "expense" ? statisticsSummary.expenseMinor : statisticsSummary.incomeMinor)}</strong></header>
          {trendValues.every((value) => value === 0) ? <p className="muted-copy">这个周期还没有参与统计的{flowLabel}。</p> : (
            <ol className={`statistics-trend ${statisticsPeriod} ${statisticsFlow}`} aria-label={`${periodTitle}${flowLabel}趋势`}>
              {statisticsSummary.trend.map((bucket, index) => {
                const value = trendValues[index];
                const showLabel = statisticsPeriod === "year" || index === 0 || (index + 1) % 5 === 0 || index === statisticsSummary.trend.length - 1;
                return <li key={bucket.key} aria-label={`${bucket.label}${flowLabel}${formatMinorAmount(value)}`}><span><i style={{ height: value > 0 ? `${Math.max(5, Math.round((value / trendMaximum) * 100))}%` : "0%" }} /></span><small>{showLabel ? bucket.label : ""}</small></li>;
              })}
            </ol>
          )}
        </article>
        <article className="statistics-card statistics-budget-card">
          <header><div><p>{statisticsPeriod === "month" ? "月度预算" : "年度预算折算"}</p><h2>预算执行</h2></div><strong>{statisticsBudgetPercent}%</strong></header>
          <div className="statistics-budget-progress" role="progressbar" aria-label="预算使用比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, statisticsBudgetPercent)}><i style={{ width: `${Math.min(100, statisticsBudgetPercent)}%` }} /></div>
          <div className="statistics-budget-values"><span>已用 <b>{formatMinorAmount(statisticsSummary.expenseMinor)}</b></span><span>预算 <b>{formatMinorAmount(statisticsBudgetMinor)}</b></span></div>
          {forecastExpenseMinor === null ? <p className="muted-copy">未来周期暂不生成支出预测。</p> : <div className={`statistics-forecast ${forecastDifferenceMinor !== null && forecastDifferenceMinor > 0 ? "over" : ""}`}><span>{statisticsSummary.isCurrentPeriod ? `预计${statisticsPeriod === "month" ? "月末" : "年末"}` : "周期实际"}</span><strong>{formatMinorAmount(forecastExpenseMinor)}</strong><small>{forecastDifferenceMinor !== null && forecastDifferenceMinor > 0 ? `预计超出预算 ${formatMinorAmount(forecastDifferenceMinor)}` : `预计剩余预算 ${formatMinorAmount(Math.max(0, -(forecastDifferenceMinor ?? 0)))}`}</small></div>}
        </article>
        <article className={`statistics-card statistics-breakdown-card ${statisticsFlow}`}>
          <header><div><p>点击条目查看流水</p><h2>{flowLabel}{dimensionLabel}排行</h2></div><span>{statisticsSummary.breakdown.length} 项</span></header>
          <div className="statistics-dimension-tabs" role="group" aria-label="统计维度">
            {(["category", "account", "creator"] as const).map((dimension) => <button key={dimension} className={statisticsDimension === dimension ? "selected" : ""} type="button" aria-pressed={statisticsDimension === dimension} onClick={() => setStatisticsDimension(dimension)}>{dimension === "category" ? "分类" : dimension === "account" ? "账户" : "成员"}</button>)}
          </div>
          {statisticsSummary.breakdown.length === 0 ? <p className="muted-copy">记账后，这里会展示{flowLabel}{dimensionLabel}占比。</p> : <div className="statistics-ranking">{statisticsSummary.breakdown.map((item, index) => (
            <button type="button" key={item.key} onClick={() => openStatisticsBreakdown(item.key, item.label)}>
              <span className="statistics-rank" aria-hidden="true">{index + 1}</span>
              <span className="statistics-ranking-copy"><strong>{item.label}</strong><small>{item.count} 笔 · {Math.round(item.share * 100)}%</small><i><b style={{ width: `${Math.max(4, Math.round(item.share * 100))}%` }} /></i></span>
              <span className="statistics-ranking-amount"><b>{formatMinorAmount(item.amountMinor)}</b><small aria-hidden="true">›</small></span>
            </button>
          ))}</div>}
        </article>
      </section>
    );
  }

  function openBudgetEditor() {
    setBudgetDraft((budgetMinor / 100).toFixed(2));
    setBudgetError("");
    setIsBudgetEditing(true);
    console.debug("[bookkeeping] monthly budget editor opened", { ledgerId: activeLedgerId, budgetMinor });
  }

  async function saveMonthlyBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const database = databaseRef.current;
    const amountMinor = amountInputToMinor(budgetDraft);
    if (!database) return;
    if (amountMinor === null || amountMinor <= 0) {
      setBudgetError("请输入大于 0 的预算金额");
      return;
    }
    setIsBudgetSaving(true);
    setBudgetError("");
    try {
      await updateLedgerMonthlyBudget(database, activeLedgerId, amountMinor);
      setLedgers(await listLedgers(database));
      setUnsyncedCount(await countUnsyncedOperations(database));
      setIsBudgetEditing(false);
      console.debug("[bookkeeping] monthly budget saved locally", { ledgerId: activeLedgerId, amountMinor });
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
    } catch (error) {
      console.error("[bookkeeping] monthly budget save failed", { ledgerId: activeLedgerId, error });
      setBudgetError(error instanceof Error ? error.message : "预算保存失败，请重试");
    } finally {
      setIsBudgetSaving(false);
    }
  }

  function renderBudget() {
    return (
      <section className="page-panel">
        <div className="page-title"><p>{currentMonth}</p><h1>月度预算</h1></div>
        <article className="budget-card">
          <div className="budget-ring" style={{ "--budget-progress": `${budgetPercent * 3.6}deg` } as React.CSSProperties}>
            <span>{budgetPercent}%</span>
          </div>
          <div className="budget-card-copy"><span>本月预算</span><strong>{formatMinorAmount(budgetMinor)}</strong><small>剩余 {formatMinorAmount(Math.max(0, budgetMinor - monthlyExpenseMinor))}</small>{canManageLedgerSettings ? <button className="budget-edit-button" type="button" onClick={openBudgetEditor}>修改预算</button> : null}</div>
        </article>
        {isBudgetEditing ? (
          <form className="budget-edit-form" onSubmit={saveMonthlyBudget}>
            <label><span>月度预算（元）</span><input type="number" min="0.01" max="10000000000" step="0.01" autoFocus value={budgetDraft} onChange={(event) => setBudgetDraft(event.target.value)} /></label>
            {budgetError ? <p role="alert">{budgetError}</p> : null}
            <div><button type="button" onClick={() => { setIsBudgetEditing(false); setBudgetError(""); }}>取消</button><button type="submit" disabled={isBudgetSaving}>{isBudgetSaving ? "保存中" : "保存"}</button></div>
          </form>
        ) : null}
        <div className="info-list">
          <div><span>已使用</span><b>{formatMinorAmount(monthlyExpenseMinor)}</b></div>
          <div><span>日均可用</span><b>{formatMinorAmount(dailyBudgetMinor)}</b></div>
          <div><span>状态</span><b className="positive-text">{budgetPercent < 80 ? "预算充足" : "注意控制"}</b></div>
        </div>
        <button className="primary-action" type="button" onClick={openComposer}>继续记一笔</button>
      </section>
    );
  }

  async function openSubscriptionManager() {
    const database = databaseRef.current;
    if (!database) return;
    setSubscriptions(await listSubscriptions(database, activeLedgerId));
    setSubscriptionEditingId(null);
    setSubscriptionNameDraft("");
    setSubscriptionBeneficiaryDraft("");
    setSubscriptionAmountDraft("");
    setSubscriptionCurrencyDraft("CNY");
    setSubscriptionRateDraft("1.00");
    setSubscriptionRateSource("fixed");
    setSubscriptionRateAt(new Date().toISOString());
    setSubscriptionCategoryIdDraft(categories.find((category) => category.type === "expense" && !isCategoryManagerEntry(category))?.id ?? "");
    setSubscriptionFrequencyDraft("month");
    setSubscriptionNextChargeDraft(new Date().toISOString().slice(0, 10));
    setPendingSubscriptionAction(null);
    setSubscriptionNotice("");
    setErrorMessage("");
    setIsSubscriptionManagerOpen(true);
  }

  function closeSubscriptionManager() {
    setPendingSubscriptionAction(null);
    setIsSubscriptionManagerOpen(false);
  }

  async function selectSubscriptionCurrency(currency: SupportedCurrency) {
    setSubscriptionCurrencyDraft(currency);
    setErrorMessage("");
    if (currency === "CNY") {
      setSubscriptionRateDraft("1.00");
      setSubscriptionRateSource("fixed");
      setSubscriptionRateAt(new Date().toISOString());
      return;
    }
    try {
      const quote = await fetchUsdCnyExchangeRate();
      setSubscriptionRateDraft((quote.rateMicros / 1_000_000).toFixed(4));
      setSubscriptionRateSource("frankfurter");
      setSubscriptionRateAt(quote.fetchedAt);
    } catch (error) {
      console.error("[bookkeeping] subscription exchange rate load failed", error);
      try {
        const cached = JSON.parse(localStorage.getItem(exchangeRateStorageKey) ?? "null") as { rate?: unknown; fetchedAt?: unknown } | null;
        if (cached && typeof cached.rate === "string") {
          setSubscriptionRateDraft(cached.rate);
          setSubscriptionRateSource("frankfurter");
          setSubscriptionRateAt(typeof cached.fetchedAt === "string" ? cached.fetchedAt : new Date().toISOString());
          return;
        }
      } catch (cacheError) {
        console.error("[bookkeeping] cached subscription exchange rate invalid", cacheError);
      }
      setSubscriptionRateSource("manual");
      setSubscriptionRateAt(new Date().toISOString());
      setErrorMessage("自动汇率暂不可用，请输入订阅实际汇率");
    }
  }

  function editSubscription(item: Subscription) {
    setSubscriptionEditingId(item.id);
    setSubscriptionNameDraft(item.name);
    setSubscriptionBeneficiaryDraft(item.beneficiary);
    setSubscriptionAmountDraft((item.amountMinor / 100).toFixed(2));
    setSubscriptionCurrencyDraft(item.currency);
    setSubscriptionRateDraft((item.exchangeRateMicros / 1_000_000).toFixed(4).replace(/0+$/u, "").replace(/\.$/u, ""));
    setSubscriptionRateSource(item.exchangeRateSource);
    setSubscriptionRateAt(item.exchangeRateAt);
    setSubscriptionCategoryIdDraft(item.categoryId);
    setSubscriptionFrequencyDraft(item.frequency);
    setSubscriptionNextChargeDraft(item.nextChargeOn);
  }

  async function saveSubscriptionDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const database = databaseRef.current;
    const amountMinor = amountInputToMinor(subscriptionAmountDraft);
    const account = selectedAccount ?? accounts[0];
    const category = categories.find((item) => item.id === subscriptionCategoryIdDraft && item.type === "expense" && !isCategoryManagerEntry(item));
    if (!database || isSubscriptionSaving) return;
    const rateMicros = subscriptionCurrencyDraft === "CNY" ? 1_000_000 : Math.round(Number(subscriptionRateDraft) * 1_000_000);
    if (!subscriptionNameDraft.trim() || !amountMinor || !account || !category || !Number.isSafeInteger(rateMicros) || rateMicros <= 0 || !isValidLocalDate(subscriptionNextChargeDraft)) {
      setErrorMessage("请检查服务名、金额、汇率和扣费日期");
      return;
    }
    setIsSubscriptionSaving(true);
    setErrorMessage("");
    try {
      const existing = subscriptions.find((item) => item.id === subscriptionEditingId);
      await saveSubscription(database, {
        id: existing?.id,
        ledgerId: activeLedgerId,
        name: subscriptionNameDraft.trim(),
        beneficiary: subscriptionBeneficiaryDraft.trim(),
        accountId: existing?.accountId ?? account.id,
        categoryId: category.id,
        amountMinor,
        currency: subscriptionCurrencyDraft,
        baseAmountMinor: convertToBaseAmountMinor(amountMinor, rateMicros),
        exchangeRateMicros: rateMicros,
        exchangeRateSource: subscriptionCurrencyDraft === "CNY" ? "fixed" : subscriptionRateSource,
        exchangeRateAt: subscriptionRateAt,
        frequency: subscriptionFrequencyDraft,
        interval: existing?.interval ?? 1,
        nextChargeOn: subscriptionNextChargeDraft,
        remindDaysBefore: existing?.remindDaysBefore ?? 3,
        status: existing?.status === "cancelled" ? "active" : existing?.status ?? "active",
        lastGeneratedPeriodKey: existing?.lastGeneratedPeriodKey ?? null,
      });
      setSubscriptions(await listSubscriptions(database, activeLedgerId));
      setSubscriptionEditingId(null);
      setSubscriptionNameDraft("");
      setSubscriptionAmountDraft("");
      setSubscriptionNotice(existing ? `已更新订阅：${subscriptionNameDraft.trim()}` : `已添加订阅：${subscriptionNameDraft.trim()}`);
      setUnsyncedCount(await countUnsyncedOperations(database));
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
      console.debug("[bookkeeping] subscription saved", { ledgerId: activeLedgerId, subscriptionId: existing?.id ?? "new" });
    } catch (error) {
      console.error("[bookkeeping] subscription save failed", error);
      setErrorMessage(error instanceof Error ? error.message : "订阅保存失败");
    } finally {
      setIsSubscriptionSaving(false);
    }
  }

  async function confirmSubscriptionCharge(item: Subscription) {
    const database = databaseRef.current;
    const account = accounts.find((value) => value.id === item.accountId);
    const category = categories.find((value) => value.id === item.categoryId);
    if (!database || !account || !category || isSubscriptionSaving) return;
    setIsSubscriptionSaving(true);
    setErrorMessage("");
    const periodKey = item.nextChargeOn;
    try {
      await createTransaction(database, {
        transactionId: `transaction-${item.id}-${periodKey}`,
        operationId: `subscription-charge-${item.id}-${periodKey}`,
        ledgerId: item.ledgerId,
        type: "expense",
        amountMinor: item.amountMinor,
        currency: item.currency,
        baseAmountMinor: item.baseAmountMinor,
        exchangeRateMicros: item.exchangeRateMicros,
        exchangeRateSource: item.exchangeRateSource,
        exchangeRateAt: item.exchangeRateAt,
        subscriptionId: item.id,
        subscriptionPeriodKey: periodKey,
        occurredAt: new Date(`${periodKey}T12:00:00`).toISOString(),
        categoryId: category.id,
        categoryName: category.name,
        accountId: account.id,
        accountName: account.name,
        note: `${item.name}${item.beneficiary ? ` · ${item.beneficiary}` : ""}`,
        createdByUserId: networkSession?.userId,
        createdByDisplayName: networkSession?.displayName ?? "本机用户",
      });
      await saveSubscription(database, {
        ...item,
        id: item.id,
        nextChargeOn: advanceSubscriptionDate(item.nextChargeOn, item.frequency, item.interval, item.anchorDay),
        anchorDay: item.anchorDay,
        lastGeneratedPeriodKey: periodKey,
      });
      setSubscriptions(await listSubscriptions(database, activeLedgerId));
      setTransactions(await listTransactions(database, activeLedgerId));
      setUnsyncedCount(await countUnsyncedOperations(database));
      setSubscriptionNotice(`已添加 ${item.name} 的 ${periodKey} 扣费流水${isTransactionVisibleOnDate({ occurredAt: `${periodKey}T12:00:00` }) ? "" : "，将在扣费日当天显示"}`);
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
      console.debug("[bookkeeping] subscription charge confirmed", { subscriptionId: item.id, periodKey });
    } catch (error) {
      console.error("[bookkeeping] subscription charge failed", error);
      setErrorMessage(error instanceof Error ? error.message : "生成订阅流水失败");
    } finally {
      setIsSubscriptionSaving(false);
    }
  }

  async function handleCancelSubscription(item: Subscription) {
    const database = databaseRef.current;
    if (!database || isSubscriptionSaving) return;
    setIsSubscriptionSaving(true);
    setErrorMessage("");
    try {
      await cancelSubscription(database, item.id);
      setSubscriptions(await listSubscriptions(database, activeLedgerId));
      setUnsyncedCount(await countUnsyncedOperations(database));
      setSubscriptionNotice(`已取消订阅：${item.name}，历史流水不会删除`);
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
      console.debug("[bookkeeping] subscription cancelled", { ledgerId: activeLedgerId, subscriptionId: item.id });
    } catch (error) {
      console.error("[bookkeeping] subscription cancel failed", { ledgerId: activeLedgerId, subscriptionId: item.id, error });
      setErrorMessage(error instanceof Error ? error.message : "取消订阅失败");
    } finally {
      setIsSubscriptionSaving(false);
    }
  }

  async function exportCurrentLedgerBackup() {
    const ledger = activeLedger;
    const database = databaseRef.current;
    if (!ledger || !database || isDataPortabilityBusy) return;
    setIsDataPortabilityBusy(true);
    try {
      const backup = await exportLedgerBackup(database, ledger.id);
      downloadFile(`轻记账-${ledger.name}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup), "application/json;charset=utf-8");
      setDataPortabilityStatus(`已导出 ${backup.transactions.length} 笔流水、${backup.subscriptions.length} 项订阅及全部账户、分类和附件`);
      console.debug("[bookkeeping] ledger backup exported", { ledgerId: ledger.id, transactionCount: transactions.length, subscriptionCount: subscriptions.length });
    } catch (error) {
      console.error("[bookkeeping] ledger backup export failed", error);
      setDataPortabilityStatus(error instanceof Error ? error.message : "备份导出失败");
    } finally {
      setIsDataPortabilityBusy(false);
    }
  }

  async function openDataPortability() {
    const database = databaseRef.current;
    if (!database) return;
    setSubscriptions(await listSubscriptions(database, activeLedgerId));
    setDataPortabilityStatus("");
    setIsDataPortabilityOpen(true);
  }

  function openSyncRecovery() {
    if (syncRunningRef.current) {
      setErrorMessage("正在同步，请稍后打开同步问题");
      return;
    }
    recoveryOpenRef.current = true;
    setRecoveryDatabase(databaseRef.current);
  }

  async function refreshRecoveredLedger() {
    const database = databaseRef.current;
    if (!database) return;
    const isCurrent = viewContextRef.current.capture();
    const [ledgerRows, rows, categoryRows, subcategoryRows, accountRows, subscriptionRows, pending] = await Promise.all([
      listLedgers(database), listTransactions(database, activeLedgerId), listCategories(database, activeLedgerId),
      listSubcategories(database, activeLedgerId), listAccounts(database, activeLedgerId), listSubscriptions(database, activeLedgerId), countUnsyncedOperations(database),
    ]);
    if (!isCurrent()) return;
    setLedgers(ledgerRows); setTransactions(rows); setCategories(categoryRows); setSubcategories(subcategoryRows);
    setAccounts(accountRows); setSubscriptions(subscriptionRows); setUnsyncedCount(pending); setSyncStatus(pending ? "idle" : "synced");
  }

  function exportCurrentLedgerCsv() {
    downloadFile(`轻记账-${activeLedgerName}-流水.csv`, exportTransactionsCsv(transactions), "text/csv;charset=utf-8");
    setDataPortabilityStatus(`已导出 ${transactions.length} 笔流水 CSV`);
    console.debug("[bookkeeping] transaction CSV exported", { ledgerId: activeLedgerId, transactionCount: transactions.length });
  }

  async function importDataFile(file: File) {
    const database = databaseRef.current;
    if (!database || isDataPortabilityBusy) return;
    setIsDataPortabilityBusy(true);
    setDataPortabilityStatus("正在校验并导入…");
    try {
      validateImportFileSize(file);
      let imported = 0;
      let skipped = 0;
      const existingIds = new Set(transactions.map((item) => item.id));
      const accountByName = new Map(accounts.map((item) => [item.name, item]));
      const categoryByName = new Map(categories.filter((item) => !isCategoryManagerEntry(item)).map((item) => [`${item.type}:${item.name}`, item]));
      if (file.name.toLowerCase().endsWith(".csv")) {
        const fingerprint = await fileFingerprint(file);
        const rows = parseTransactionsCsv(await file.text());
        const preparedRows = rows.map((row, index) => {
          const category = categoryByName.get(`${row.type}:${row.categoryName}`);
          const account = accountByName.get(row.accountName) ?? accounts[0];
          if (!category || !account) throw new Error(`CSV 第 ${index + 2} 行找不到分类或账户`);
          return { row, index, category, account };
        });
        for (const { row, index, category, account } of preparedRows) {
          const transactionId = `csv-${fingerprint.slice(0, 24)}-${index + 1}`;
          if (existingIds.has(transactionId)) { skipped += 1; continue; }
          await createTransaction(database, {
            transactionId, operationId: `csv-import-${fingerprint.slice(0, 32)}-${index + 1}`,
            ledgerId: activeLedgerId, type: row.type, amountMinor: row.amountMinor, currency: row.currency,
            baseAmountMinor: row.baseAmountMinor, exchangeRateMicros: row.exchangeRateMicros,
            exchangeRateSource: row.currency === "CNY" ? "fixed" : "manual", exchangeRateAt: row.occurredAt,
            occurredAt: row.occurredAt, categoryId: category.id, categoryName: category.name,
            subcategoryName: row.subcategoryName, accountId: account.id, accountName: account.name,
            note: row.note, excludeFromStats: row.excludeFromStats,
            createdByUserId: networkSession?.userId, createdByDisplayName: networkSession?.displayName ?? "导入",
          });
          imported += 1;
        }
      } else {
        const backup = await readLedgerBackup(file);
        const result = await restoreLedgerBackup(database, activeLedgerId, backup);
        imported = result.imported; skipped = result.skipped;
        await refreshRecoveredLedger();
      }
      setTransactions(await listTransactions(database, activeLedgerId));
      setSubscriptions(await listSubscriptions(database, activeLedgerId));
      setUnsyncedCount(await countUnsyncedOperations(database));
      setDataPortabilityStatus(`导入完成：新增 ${imported} 项，跳过 ${skipped} 项`);
      if (networkSession && navigator.onLine) void syncActiveLedger(networkSession, activeLedgerId, { silent: true });
      console.debug("[bookkeeping] data import completed", { ledgerId: activeLedgerId, imported, skipped, fileType: file.name.split(".").at(-1) });
    } catch (error) {
      console.error("[bookkeeping] data import failed", error);
      setDataPortabilityStatus(error instanceof Error ? error.message : "导入失败");
    } finally {
      setIsDataPortabilityBusy(false);
      if (dataImportInputRef.current) dataImportInputRef.current.value = "";
    }
  }

  function renderProfile() {
    return (
      <section className="page-panel">
        <div className="page-title"><p>个人中心</p><h1>我的</h1></div>
        <div className="profile-hero">
          <div className="profile-identity"><span className="profile-avatar">{networkSession?.displayName.slice(0, 1) || "我"}</span><div><strong>{networkSession?.displayName ?? "本机用户"}</strong><small>{networkSession ? `@${networkSession.username}` : "本地可用 · 登录后跨设备同步"}</small>{networkSession ? <small className={`profile-sync-state ${!isOnline ? "offline" : syncStatus}`} title={lastSyncLabel}><i aria-hidden="true" />{networkStatusLabel}</small> : null}</div></div>
          {networkSession ? <div className="profile-actions"><button className="profile-edit-button" type="button" onClick={() => { if (!isProfileEditing) setProfileDisplayNameDraft(networkSession.displayName); setIsProfileEditing((current) => !current); }}>{isProfileEditing ? "取消" : "修改名称"}</button><button className="profile-sync-button" type="button" disabled={!isOnline || syncStatus === "syncing"} onClick={() => void syncActiveLedger()}>{!isOnline ? "当前离线" : syncStatus === "syncing" ? "同步中" : syncStatus === "error" ? "重试同步" : "立即同步"}</button></div> : null}
          {networkSession && isProfileEditing ? (
            <form className="profile-name-form" onSubmit={handleProfileDisplayNameSave}>
              <input value={profileDisplayNameDraft} maxLength={40} aria-label="新的显示名称" onChange={(event) => setProfileDisplayNameDraft(event.target.value)} />
              <button type="submit" disabled={isProfileSaving || !profileDisplayNameDraft.trim()}>{isProfileSaving ? "保存中" : "保存"}</button>
            </form>
          ) : null}
        </div>
        {!networkSession ? <h2 className="settings-group-title">网络账号</h2> : null}
        {networkSession ? (
          <>
            <h2 className="settings-group-title">家庭与账号</h2>
            <div className="settings-list account-action-list">
              {activeLedger?.kind === "family" ? <button type="button" onClick={() => void handleCreateInvitation()}><span><i>邀</i><span className="settings-row-copy"><strong>邀请家庭成员</strong><small>生成新的家庭邀请令牌</small></span></span><b>›</b></button> : null}
              <button type="button" disabled={pushNotificationStatus === "loading"} onClick={() => void togglePushNotifications()}><span><i>通</i><span className="settings-row-copy"><strong>账本消息通知</strong><small>其他成员新增账目时发送系统通知</small></span></span><b>{pushNotificationLabel} ›</b></button>
              <button className="account-logout-row" type="button" onClick={() => void handleNetworkLogout()}><span><i>退</i><span className="settings-row-copy"><strong>退出网络账号</strong><small>本机账本数据仍会保留</small></span></span><b>›</b></button>
            </div>
            {latestInvite ? <div className="invitation-result"><strong>家庭邀请令牌</strong><code>{latestInvite.token}</code><small>{new Date(latestInvite.expiresAt).toLocaleString("zh-CN")} 前有效</small><button type="button" onClick={() => void navigator.clipboard?.writeText(latestInvite.token)}>复制令牌</button></div> : null}
          </>
        ) : (
          <form className="network-account-form" onSubmit={handleNetworkAccountSubmit}>
            <aside className="local-data-notice" aria-label="体验模式数据说明"><strong>体验模式仅保存在本机</strong><span>为了保护数据安全，未登录用户不启用网络同步；账本数据只保存在当前设备，不会上传到服务器。清理浏览器数据或更换设备前，请先导出备份。</span></aside>
            <p>{isNetworkInitialized === false ? "创建首个所有者账号，现有本机账本会成为你的私人账本。" : accountMode === "invite" ? "使用家庭邀请令牌创建自己的账号。" : "登录后同步私人账本与家庭账本。"}</p>
            <input value={accountUsername} autoCapitalize="none" autoCorrect="off" maxLength={40} placeholder="用户名" aria-label="用户名" onChange={(event) => setAccountUsername(event.target.value)} />
            {(isNetworkInitialized === false || accountMode === "invite") ? <input value={accountDisplayName} maxLength={40} placeholder="显示名称" aria-label="显示名称" onChange={(event) => setAccountDisplayName(event.target.value)} /> : null}
            {isNetworkInitialized !== false && accountMode === "invite" ? <input value={accountInviteToken} autoCapitalize="none" autoCorrect="off" maxLength={43} placeholder="家庭邀请令牌" aria-label="家庭邀请令牌" onChange={(event) => setAccountInviteToken(event.target.value)} /> : null}
            <input value={accountPassword} type="password" minLength={10} maxLength={128} placeholder="密码（至少 10 位）" aria-label="密码" onChange={(event) => setAccountPassword(event.target.value)} />
            {isNetworkInitialized !== false && accountMode === "login" ? <label className="guest-transfer-choice"><input type="checkbox" checked={includeGuestLedgers} onChange={(event) => setIncludeGuestLedgers(event.target.checked)} /><span>将本机账本及全部账目同步到此账号，仅自己可见</span></label> : null}
            <p>接入后请登录所属账号继续记账。归属不明的旧数据保持锁定，不会自动接入。</p>
            <button type="submit" disabled={isAccountSubmitting || !accountUsername.trim() || accountPassword.length < 10 || (accountMode === "invite" && !accountInviteToken.trim())}>{isAccountSubmitting ? "处理中" : isNetworkInitialized === false ? "创建并开始同步" : accountMode === "invite" ? "接受邀请并创建账号" : "登录"}</button>
            {isNetworkInitialized !== false ? <button className="account-mode-toggle" type="button" onClick={() => setAccountMode((current) => current === "login" ? "invite" : "login")}>{accountMode === "login" ? "我有家庭邀请令牌" : "返回已有账号登录"}</button> : null}
          </form>
        )}
        <h2 className="settings-group-title">账本与记账</h2>
        <div className="settings-list">
          <button type="button" onClick={openLedgerPicker}><span><i>账</i><span className="settings-row-copy"><strong>账本管理</strong><small>切换或新建账本</small></span></span><b>{activeLedgerName} ›</b></button>
          <button type="button" onClick={() => openAccountManager()}><span><i>户</i>账户管理</span><b>{accounts.length} 个 ›</b></button>
          <button type="button" onClick={() => void openSubscriptionManager()}><span><i>订</i><span className="settings-row-copy"><strong>订阅管理</strong><small>管理周期扣费与使用人</small></span></span><b>›</b></button>
        </div>
        <h2 className="settings-group-title">数据与设置</h2>
        <div className="settings-list">
          {networkSession ? <button type="button" onClick={openSyncRecovery}><span><i>同</i><span className="settings-row-copy"><strong>同步问题</strong><small>比较版本并处理失败项目</small></span></span><b>›</b></button> : null}
          <div><span><i>币</i>默认币种</span><b>CNY 人民币</b></div>
          <button type="button" onClick={() => void openDataPortability()}><span><i>备</i><span className="settings-row-copy"><strong>导入与导出</strong><small>当前账本 JSON 备份与流水 CSV</small></span></span><b>›</b></button>
          <div><span><i>隐</i>隐私与本地存储</span><b>{networkSession ? "本地 + 云端" : "仅本机"}</b></div>
        </div>
        <h2 className="settings-group-title">离线应用</h2>
        <div className="settings-list">
          <button type="button" onClick={() => void requestAppInstallation()} disabled={isInstalled}><span><i>装</i>添加到主屏幕</span><b>{installationLabel}{isInstalled ? "" : " ›"}</b></button>
          <div><span><i>离</i>离线状态</span><b>{offlineStatusLabel}</b></div>
          {waitingServiceWorker ? <button type="button" onClick={applyApplicationUpdate}><span><i>更</i>应用更新</span><b>立即更新 ›</b></button> : null}
          <button type="button" onClick={restartApplication}><span><i>启</i><span className="settings-row-copy"><strong>重新启动应用</strong><small>不会清除账本或登录状态</small></span></span><b>›</b></button>
        </div>
        <p className="pwa-note">所有记账先写入本机；断网时可以继续保存，恢复网络或再次打开应用后自动幂等同步。</p>
        <p className="storage-note">尚未同步的账目只存在当前设备，请在清理浏览器数据前确认待同步数量为 0。</p>
      </section>
    );
  }

  if (startupError) return <AppStartupRecovery message={startupError} onRetry={retryStartup} />;
  if (isLoading || isLaunchVisible) return <AppLaunchScreen message={launchMessage} status={launchStatus} />;
  if (isLegacyMigrating) return <AppLaunchScreen message="正在迁移旧账本，原始数据会保留" status="正在核验账号与本地数据，请稍候" />;

  return (
    <main className="app-shell">
      {activeTab !== "profile" ? (
        <header className="topbar">
          <button className="ledger-current" type="button" aria-label={`切换账本，当前${activeLedgerName}`} onClick={openLedgerPicker}>
            <span className="ledger-mark" aria-hidden="true">账</span>
            <span><small>当前账本</small><strong>{activeLedgerName}</strong></span>
            <span className="ledger-chevron" aria-hidden="true">⌄</span>
          </button>
          <span className={`local-badge ${!isOnline ? "offline" : ""}`}>{offlineStatusLabel}</span>
        </header>
      ) : null}

      {errorMessage && !isComposerOpen ? <p className="error-banner" role="alert">{errorMessage}</p> : null}
      {legacyNotice ? <aside className="legacy-migration-notice" role="status"><p>{legacyNotice}</p><button type="button" onClick={() => { if (!networkSession) setActiveTab("profile"); void checkLegacyMigration(); }}>检查旧数据</button></aside> : null}
      {activeTab === "ledger" ? renderLedger() : null}
      {activeTab === "statistics" ? renderStatistics() : null}
      {activeTab === "budget" ? renderBudget() : null}
      {activeTab === "profile" ? renderProfile() : null}

      <nav className="bottom-nav" aria-label="主要导航">
        {navigation.map((item) => (
          <button key={item.id} className={activeTab === item.id ? "active" : ""} type="button" onClick={() => setActiveTab(item.id)} aria-current={activeTab === item.id ? "page" : undefined}>
            <span aria-hidden="true">{item.icon}</span>{item.label}
          </button>
        ))}
      </nav>
      <button className="floating-add" type="button" aria-label="新增账单" onClick={openComposer}>＋</button>

      {isSearchOpen ? renderSearch() : null}

      {isLedgerPickerOpen ? (
        <div className="ledger-picker-backdrop" role="presentation" onClick={() => setIsLedgerPickerOpen(false)}>
          <section className="ledger-picker-sheet" role="dialog" aria-modal="true" aria-labelledby="ledger-picker-title" onClick={(event) => event.stopPropagation()}>
            <header><div><p>{networkSession ? "私人和家庭" : "本机账本"}</p><h2 id="ledger-picker-title">选择账本</h2></div><button type="button" aria-label="关闭账本选择" onClick={() => setIsLedgerPickerOpen(false)}>×</button></header>
            <div className="ledger-options" role="listbox" aria-label="已有账本">
              {ledgers.map((ledger) => (
                <button key={ledger.id} className={ledger.id === activeLedgerId ? "selected" : ""} type="button" role="option" aria-selected={ledger.id === activeLedgerId} onClick={() => void selectLedger(ledger.id)}>
                  <span className="ledger-option-icon" aria-hidden="true">账</span>
                  <span><strong>{ledger.name}</strong><small>{ledger.id === activeLedgerId ? "当前使用" : "点击切换"}</small></span>
                  <b aria-hidden="true">{ledger.id === activeLedgerId ? "✓" : "›"}</b>
                </button>
              ))}
            </div>
            <form className="create-ledger-form" onSubmit={handleCreateLedger}>
              <label htmlFor="new-ledger-name">{networkSession ? ledgerKindDraft === "family" ? "新建家庭共享账本" : "新建私人账本" : "新建本地账本"}</label>
              {networkSession ? <select className="ledger-kind-select" aria-label="新账本类型" value={ledgerKindDraft} onChange={(event) => setLedgerKindDraft(event.target.value as "private" | "family")}><option value="private">私人账本 · 仅自己可见，自动同步</option><option value="family">家庭共享账本 · 可邀请成员</option></select> : null}
              <div><input id="new-ledger-name" value={ledgerNameDraft} maxLength={20} placeholder="例如：家庭账本" onChange={(event) => setLedgerNameDraft(event.target.value)} /><button type="submit" disabled={isCreatingLedger || !ledgerNameDraft.trim()}>{isCreatingLedger ? "创建中" : "创建"}</button></div>
            </form>
            {networkSession ? <button className="guest-transfer-button" type="button" disabled={isTransferringGuestLedgers} onClick={() => void handleTransferGuestLedgers()}>{isTransferringGuestLedgers ? "正在接入本机账本…" : "接入本机账本及全部账目（仅自己可见）"}</button> : null}
            {errorMessage ? <p className="ledger-picker-error" role="alert">{errorMessage}</p> : null}
            <div className="shared-ledger-placeholder"><span aria-hidden="true">家</span><div><strong>家庭共同记账</strong><small>{networkSession ? "创建家庭账本后，可在个人中心生成邀请令牌" : "登录网络账号后可创建和共享家庭账本"}</small></div><b>{networkSession ? "已开放" : "需登录"}</b></div>
          </section>
        </div>
      ) : null}

      {isSubscriptionManagerOpen ? (
        <div className="ledger-picker-backdrop" role="presentation" onClick={closeSubscriptionManager}>
          <section className="subscription-manager-sheet" role="dialog" aria-modal="true" aria-labelledby="subscription-manager-title" onClick={(event) => event.stopPropagation()}>
            <header><div><p>{activeLedgerName}</p><h2 id="subscription-manager-title">订阅管理</h2></div><button type="button" aria-label="关闭订阅管理" onClick={closeSubscriptionManager}>×</button></header>
            <div className="subscription-summary"><span>有效订阅</span><strong>{subscriptions.filter((item) => item.status === "active").length} 项</strong><small>月度预计 {formatMinorAmount(subscriptions.filter((item) => item.status === "active" && item.frequency === "month").reduce((total, item) => total + item.baseAmountMinor / item.interval, 0))}</small></div>
            {subscriptionNotice ? <p className="subscription-notice" role="status"><strong>操作成功</strong><span>{subscriptionNotice}</span></p> : null}
            <div className="subscription-list">
              {subscriptions.length === 0 ? <p>还没有订阅，先添加 Apple Music、Fitness+ 等周期服务。</p> : subscriptions.map((item) => (
                <article key={item.id} className={item.status !== "active" ? "inactive" : ""}>
                  <div><strong>{item.name}</strong><small>{categories.find((category) => category.id === item.categoryId)?.name ?? "分类已停用"} · {item.beneficiary || "未填写使用人"} · 下次 {item.nextChargeOn}</small><span>{formatMinorAmount(item.amountMinor, item.currency)}{item.currency !== "CNY" ? ` · 约 ${formatMinorAmount(item.baseAmountMinor)}` : ""}</span></div>
                  <div><button type="button" onClick={() => editSubscription(item)}>编辑</button>{item.status === "active" ? <button type="button" disabled={isSubscriptionSaving} onClick={() => { setSubscriptionNotice(""); setPendingSubscriptionAction({ kind: "charge", subscription: item }); }}>确认扣费</button> : null}<button type="button" disabled={item.status === "cancelled" || isSubscriptionSaving} onClick={() => { setSubscriptionNotice(""); setPendingSubscriptionAction({ kind: "cancel", subscription: item }); }}>取消订阅</button></div>
                </article>
              ))}
            </div>
            <form className="subscription-form" onSubmit={saveSubscriptionDraft}>
              <h3>{subscriptionEditingId ? "编辑订阅" : "添加订阅"}</h3>
              <label><span>服务名称</span><input value={subscriptionNameDraft} maxLength={40} required placeholder="例如 Apple Music" onChange={(event) => setSubscriptionNameDraft(event.target.value)} /></label>
              <label><span>使用人</span><input value={subscriptionBeneficiaryDraft} maxLength={20} placeholder="例如 孩子、我、全家" onChange={(event) => setSubscriptionBeneficiaryDraft(event.target.value)} /></label>
              <label><span>支出分类</span><select required value={subscriptionCategoryIdDraft} onChange={(event) => setSubscriptionCategoryIdDraft(event.target.value)}>{categories.filter((category) => category.type === "expense" && !isCategoryManagerEntry(category)).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
              <div className="subscription-form-row"><label><span>金额</span><input value={subscriptionAmountDraft} inputMode="decimal" required placeholder="0.00" onChange={(event) => setSubscriptionAmountDraft(event.target.value)} /></label><label><span>币种</span><select value={subscriptionCurrencyDraft} onChange={(event) => void selectSubscriptionCurrency(event.target.value as SupportedCurrency)}><option value="CNY">人民币</option><option value="USD">美元</option></select></label></div>
              {subscriptionCurrencyDraft === "USD" ? <label><span>美元兑人民币汇率</span><input value={subscriptionRateDraft} inputMode="decimal" required onChange={(event) => { setSubscriptionRateDraft(event.target.value); setSubscriptionRateSource("manual"); setSubscriptionRateAt(new Date().toISOString()); }} /></label> : null}
              <div className="subscription-form-row"><label><span>扣费周期</span><select value={subscriptionFrequencyDraft} onChange={(event) => setSubscriptionFrequencyDraft(event.target.value as Subscription["frequency"])}><option value="month">每月</option><option value="year">每年</option></select></label><label><span>下次扣费日</span><input type="date" lang="zh-CN" required value={subscriptionNextChargeDraft} onChange={(event) => setSubscriptionNextChargeDraft(event.target.value)} /></label></div>
              {errorMessage ? <p role="alert">{errorMessage}</p> : null}
              <button type="submit" disabled={isSubscriptionSaving}>{isSubscriptionSaving ? "保存中" : subscriptionEditingId ? "保存修改" : "添加订阅"}</button>
            </form>
          </section>
        </div>
      ) : null}

      {pendingSubscriptionAction ? (
        <div className="subscription-confirm-backdrop" role="presentation" onClick={() => setPendingSubscriptionAction(null)}>
          <section className="subscription-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="subscription-confirm-title" onClick={(event) => event.stopPropagation()}>
            <span className="subscription-confirm-icon" aria-hidden="true">{pendingSubscriptionAction.kind === "charge" ? "账" : "停"}</span>
            <h2 id="subscription-confirm-title">{pendingSubscriptionAction.kind === "charge" ? "确认生成扣费流水？" : "确认取消订阅？"}</h2>
            <p>{pendingSubscriptionAction.kind === "charge"
              ? `将为“${pendingSubscriptionAction.subscription.name}”生成 ${pendingSubscriptionAction.subscription.nextChargeOn} 的 ${formatMinorAmount(pendingSubscriptionAction.subscription.amountMinor, pendingSubscriptionAction.subscription.currency)} 流水。未来日期的流水会在当天显示。`
              : `取消“${pendingSubscriptionAction.subscription.name}”后将不再继续扣费，已经生成的历史流水不会删除。`}</p>
            <div><button type="button" onClick={() => setPendingSubscriptionAction(null)}>暂不操作</button><button className={pendingSubscriptionAction.kind === "cancel" ? "danger" : "primary"} type="button" disabled={isSubscriptionSaving} onClick={() => { const action = pendingSubscriptionAction; setPendingSubscriptionAction(null); if (action.kind === "charge") void confirmSubscriptionCharge(action.subscription); else void handleCancelSubscription(action.subscription); }}>{pendingSubscriptionAction.kind === "charge" ? "确认添加流水" : "确认取消订阅"}</button></div>
          </section>
        </div>
      ) : null}

      {recoveryDatabase && networkSession ? <SyncRecovery key={`${networkSession.userId}:${activeLedgerId}`} database={recoveryDatabase} session={networkSession} ledgerId={activeLedgerId} onResolved={refreshRecoveredLedger} onClose={() => {
        recoveryOpenRef.current = false; setRecoveryDatabase(null); void syncActiveLedger();
      }} /> : null}

      {isDataPortabilityOpen ? (
        <div className="ledger-picker-backdrop" role="presentation" onClick={() => setIsDataPortabilityOpen(false)}>
          <section className="data-portability-sheet" role="dialog" aria-modal="true" aria-labelledby="data-portability-title" onClick={(event) => event.stopPropagation()}>
            <header><div><p>{activeLedgerName}</p><h2 id="data-portability-title">导入与导出</h2></div><button type="button" aria-label="关闭导入与导出" onClick={() => setIsDataPortabilityOpen(false)}>×</button></header>
            <article><span aria-hidden="true">全</span><div><strong>账本完整备份</strong><small>包含预算、全部账户和分类、流水、订阅及附件。附件未下载齐时会提示补齐。</small></div><button type="button" disabled={isDataPortabilityBusy} onClick={() => void exportCurrentLedgerBackup()}>导出 JSON</button></article>
            <article><span aria-hidden="true">表</span><div><strong>流水 CSV</strong><small>适合使用 Excel 或 Numbers 查看和编辑，不包含附件与订阅。</small></div><button type="button" disabled={isDataPortabilityBusy} onClick={exportCurrentLedgerCsv}>导出 CSV</button></article>
            <article><span aria-hidden="true">入</span><div><strong>导入数据</strong><small>JSON 恢复到当前账本，保留当前账本名称与成员，恢复备份中的预算和配置。已有流水不覆盖；同名分类和账户会匹配更新。</small></div><button type="button" disabled={isDataPortabilityBusy || !canManageLedgerSettings} onClick={() => dataImportInputRef.current?.click()}>选择文件</button></article>
            <input ref={dataImportInputRef} className="visually-hidden-input" type="file" accept="application/json,.json,text/csv,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importDataFile(file); }} />
            {dataPortabilityStatus ? <p className="data-portability-status" role="status">{dataPortabilityStatus}</p> : null}
            <p className="data-portability-note">JSON 完整校验后一次性保存，失败会全部回滚；重复导入跳过已恢复项目。登录状态、密码、邀请令牌和通知地址不会被导出。</p>
          </section>
        </div>
      ) : null}

      {selectedTransaction ? (
        <div className="transaction-detail-backdrop" role="presentation">
          <section
            className="transaction-detail"
            role="dialog"
            aria-modal="true"
            aria-labelledby="transaction-detail-title"
            onPointerDown={startTransactionDetailSwipe}
            onPointerMove={moveTransactionDetailSwipe}
            onPointerUp={finishTransactionDetailSwipe}
            onPointerCancel={(event) => resetTransactionDetailSwipe(event.currentTarget)}
          >
            <header>
              <button className="screen-back-button" type="button" aria-label="返回流水" onClick={closeTransactionDetails}>‹</button>
              <h2 id="transaction-detail-title">{selectedTransaction.type === "income" ? "收入" : "支出"}</h2>
              <span>
                {canMutateTransactions ? <button type="button" aria-label="删除这笔账单" disabled={isSaving} onClick={() => void handleDeleteTransaction(selectedTransaction)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg></button> : null}
                {canMutateTransactions ? <button type="button" aria-label="编辑这笔账单" onClick={() => openTransactionEditor(selectedTransaction)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Zm9.5-13.5 4 4M13 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-8" /></svg></button> : null}
              </span>
            </header>
            <div className="transaction-detail-content">
              <time>{new Date(selectedTransaction.occurredAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })}</time>
              <div className="transaction-detail-category"><span className="category-badge" aria-hidden="true">{categories.find((category) => category.id === selectedTransaction.categoryId || selectedTransaction.categoryId.endsWith(`:${category.id}`))?.icon ?? "记"}</span><strong>{selectedTransaction.categoryName}</strong></div>
              <strong className={selectedTransaction.type === "income" ? "transaction-detail-amount income" : "transaction-detail-amount"}>{selectedTransaction.type === "income" ? "+" : "-"}{formatMinorAmount(selectedTransaction.amountMinor, selectedTransaction.currency)}</strong>
              {selectedTransaction.currency !== "CNY" ? <p className="transaction-detail-settlement">按汇率 {((selectedTransaction.exchangeRateMicros ?? 1_000_000) / 1_000_000).toFixed(4)} · 结算 {formatMinorAmount(transactionBaseAmountMinor(selectedTransaction))}</p> : null}
              <p className="transaction-detail-recorder">记录人：{selectedTransaction.createdByDisplayName ?? "本机用户"}</p>
              <div className="transaction-detail-fields">
                {selectedTransaction.subcategoryName ? <span>{selectedTransaction.subcategoryName}</span> : null}
                <dl><div><dt>账户</dt><dd>{selectedTransaction.accountName}</dd></div>{selectedTransaction.note ? <div><dt>备注</dt><dd>{selectedTransaction.note}</dd></div> : null}</dl>
                {selectedTransaction.images.length > 0 ? <div className="transaction-detail-images">{selectedTransaction.images.map((image, index) => <button type="button" key={image.id} disabled={!image.blob} aria-label={image.blob ? `放大查看账单图片 ${index + 1}` : `账单图片 ${index + 1} 等待下载`} onClick={() => image.blob && setPreviewAttachment(image)}><AttachmentImage image={image} alt={`账单图片 ${index + 1}`} /></button>)}</div> : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {previewAttachment ? (
        <div className="attachment-preview-backdrop" role="presentation" onClick={() => setPreviewAttachment(null)}>
          <section className="attachment-preview" role="dialog" aria-modal="true" aria-label="附件大图预览" onClick={(event) => event.stopPropagation()}>
            <button className="attachment-preview-close" type="button" aria-label="关闭附件预览" onClick={() => setPreviewAttachment(null)}>×</button>
            <AttachmentImage image={previewAttachment} alt="账单附件大图" />
          </section>
        </div>
      ) : null}

      {isComposerOpen ? (
        <div className="sheet-backdrop" role="presentation">
          <section
            className="composer-sheet composer-full"
            role="dialog"
            aria-modal="true"
            aria-labelledby="composer-title"
            onPointerDown={startComposerSwipe}
            onPointerMove={moveComposerSwipe}
            onPointerUp={finishComposerSwipe}
            onPointerCancel={(event) => resetComposerSwipe(event.currentTarget)}
          >
            <div className="composer-heading">
              <button className="screen-back-button" type="button" aria-label="关闭" onClick={() => { setIsComposerOpen(false); setEditingTransactionId(null); }}>‹</button>
              <button className="composer-ledger-trigger" type="button" disabled={Boolean(editingTransactionId)} aria-label={editingTransactionId ? "修改账单" : `切换账本，当前${activeLedgerName}`} onClick={openLedgerPicker}>
                <span><h2 id="composer-title">{editingTransactionId ? "修改账单" : activeLedgerName}</h2></span>
                {!editingTransactionId ? <span aria-hidden="true">⌄</span> : null}
              </button>
              <button className="composer-top-save" type="button" disabled={isSaving} onClick={() => void persistTransaction(false)}>{isSaving ? "保存中" : "保存"}</button>
            </div>
            <form className={isAmountConfirmed ? "amount-confirmed" : ""} onSubmit={handleSubmit}>
              <div className="entry-tabs" role="tablist" aria-label="账单类型">
                <button className={entryType === "expense" ? "active" : ""} type="button" onClick={() => selectEntryType("expense")}>支出</button>
                <button className={entryType === "income" ? "active" : ""} type="button" onClick={() => selectEntryType("income")}>收入</button>
                <button type="button" disabled>转账</button>
              </div>
              <div className="amount-display" aria-live="polite">
                <button className="currency-trigger" type="button" disabled={isExchangeRateLoading} aria-label={`切换币种，当前${entryCurrency}`} onClick={() => void selectEntryCurrency(entryCurrency === "CNY" ? "USD" : "CNY")}>{isExchangeRateLoading ? "…" : entryCurrency}</button>
                <button className="amount-value" type="button" aria-label="修改金额" onClick={() => setIsAmountConfirmed(false)}>
                  <output aria-label="金额">{calculator.display}</output>
                  <small className="amount-expression">{calculatorExpression(calculator)}</small>
                </button>
                {entryCurrency === "USD" ? <label className="exchange-rate-field"><span>1 USD =</span><input value={exchangeRateDraft} inputMode="decimal" aria-label="美元兑人民币汇率" onChange={(event) => { setExchangeRateDraft(event.target.value); setExchangeRateSource("manual"); setExchangeRateAt(new Date().toISOString()); }} /><span>CNY</span><small>{composerBasePreviewMinor ? `约 ${formatMinorAmount(composerBasePreviewMinor)}` : "请输入汇率"}</small></label> : null}
                <button className="amount-clear" type="button" onClick={() => { setCalculator(initialCalculatorState); setIsAmountConfirmed(false); }} aria-label="清空金额">×</button>
                <button className="date-trigger" type="button" aria-label={`选择日期时间，当前${formatDateLabel(occurredAt)} ${formatTime(occurredAt)}`} onClick={() => setIsDatePickerOpen(true)}>
                  <span aria-hidden="true">▣</span>
                  <span><strong>{formatDateLabel(occurredAt)}</strong><small>{formatTime(occurredAt)}</small></span>
                </button>
              </div>
              <div className="entry-details">
                <fieldset className="category-picker category-grid">
                  <legend>选择主分类</legend>
                  <div>
                    {activeCategories.map((category) => (
                      <label key={category.id} className={categoryId === category.id ? "selected" : ""}>
                        <input type="radio" name="category" value={category.id} checked={categoryId === category.id} onChange={() => isCategoryManagerEntry(category) ? openCategoryManager() : selectCategory(category.id)} />
                        <span aria-hidden="true">{category.icon}</span>{category.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <button type="button" className="account-row" onClick={() => openAccountManager(selectedAccount)}><span>{entryType === "expense" ? "支出账户" : "收入账户"}</span><strong>{selectedAccount?.name ?? "请选择"} ›</strong></button>
                {renderSubcategoryControls("select")}
                <section className="note-section" aria-labelledby="note-heading">
                  <div className="note-heading"><strong id="note-heading">描述与图片</strong><span>{networkSession ? "自动安全同步" : "登录后同步"}</span></div>
                  <input ref={imageInputRef} className="visually-hidden-input" type="file" accept="image/*" multiple onChange={(event) => handleImageSelection(event.target.files)} />
                  <div className="note-composer">
                    <textarea value={note} maxLength={150} rows={3} placeholder="描述这笔账单…" onChange={(event) => setNote(event.target.value)} />
                    <div className="note-composer-footer">
                      <div className="image-attachment-grid">
                        {selectedImages.map((image, index) => (
                          <figure key={image.id}>
                            <AttachmentImage image={image} alt={`待保存图片 ${index + 1}`} />
                            <button type="button" aria-label={`移除图片 ${index + 1}`} onClick={() => setSelectedImages((current) => current.filter((item) => item.id !== image.id))}>×</button>
                          </figure>
                        ))}
                        {selectedImages.length < maxImagesPerTransaction ? <button className="add-image-button" type="button" aria-label="选择账单图片" onClick={() => imageInputRef.current?.click()}><span aria-hidden="true">▧</span><small>图片</small></button> : null}
                      </div>
                      <span className="note-count">{note.length}/150</span>
                    </div>
                  </div>
                </section>
                <section className="transaction-flags" aria-label="账单属性">
                  {transactionFlags.map((flag) => (
                    <button key={flag.id} className={selectedFlags.has(flag.id) ? "selected" : ""} type="button" aria-pressed={selectedFlags.has(flag.id)} onClick={() => toggleTransactionFlag(flag.id)}>{flag.label}</button>
                  ))}
                </section>
              </div>
              {errorMessage ? <p className="keypad-error" role="alert">{errorMessage}</p> : null}
              {!isAmountConfirmed ? <div className="number-keypad" aria-label="金额键盘">
                {["7", "8", "9"].map((digit) => <button key={digit} type="button" onClick={() => appendDigit(digit)}>{digit}</button>)}
                <button type="button" onClick={backspace} aria-label="退格">⌫</button>
                {["4", "5", "6"].map((digit) => <button key={digit} type="button" onClick={() => appendDigit(digit)}>{digit}</button>)}
                <OperatorKey primary="+" alternate="×" onSelect={chooseOperator} />
                {["1", "2", "3"].map((digit) => <button key={digit} type="button" onClick={() => appendDigit(digit)}>{digit}</button>)}
                <button className="confirm-key" type="button" onClick={confirmAmountInput}>确定</button>
                <OperatorKey primary="−" alternate="÷" onSelect={chooseOperator} />
                <button type="button" onClick={() => appendDigit("0")}>0</button>
                <button type="button" onClick={appendDecimal}>.</button>
              </div> : (
                <div className="composer-actions" aria-label="保存操作">
                  {editingTransactionId
                    ? <button type="button" disabled={isSaving} onClick={() => { setIsComposerOpen(false); setEditingTransactionId(null); }}>取消修改</button>
                    : <button type="button" disabled={isSaving} onClick={() => void persistTransaction(true)}>{isSaving ? "保存中" : "再记一笔"}</button>}
                  <button type="submit" disabled={isSaving}>{isSaving ? "保存中" : editingTransactionId ? "保存修改" : "保存"}</button>
                </div>
              )}
            </form>
          </section>
        </div>
      ) : null}
      {isAccountManagerOpen ? (
        <div className="account-manager-backdrop" role="presentation" onClick={() => setIsAccountManagerOpen(false)}>
          <section className="account-manager-sheet" role="dialog" aria-modal="true" aria-labelledby="account-manager-title" onClick={(event) => event.stopPropagation()}>
            <header><div><small>{activeLedgerName}</small><h2 id="account-manager-title">选择与管理账户</h2></div><button type="button" aria-label="关闭账户管理" onClick={() => setIsAccountManagerOpen(false)}>×</button></header>
            <div className="account-manager-list">
              {accounts.map((account) => (
                <div key={account.id} className={account.id === selectedAccountId ? "selected" : ""}>
                  <button type="button" onClick={() => { setSelectedAccountId(account.id); rememberAccountId(activeLedgerId, account.id); setIsAccountManagerOpen(false); }}>
                    <span aria-hidden="true">{account.type === "bank" ? "卡" : account.type === "wallet" ? "包" : "现"}</span>
                    <strong>{account.name}</strong><small>{account.type === "bank" ? "银行卡" : account.type === "wallet" ? "电子钱包" : "现金"}</small>
                  </button>
                  {canManageLedgerSettings ? <button type="button" aria-label={`编辑${account.name}`} onClick={() => openAccountManager(account)}>编辑</button> : null}
                  {canManageLedgerSettings && accounts.length > 1 ? <button type="button" aria-label={`停用${account.name}`} onClick={() => void handleDeactivateAccount(account)}>停用</button> : null}
                </div>
              ))}
            </div>
            {canManageLedgerSettings ? <form className="account-manager-form" onSubmit={handleSaveAccount}>
              <strong>{accountEditingId ? "编辑账户" : "新增账户"}</strong>
              <input value={accountNameDraft} maxLength={12} placeholder="账户名称，例如：工资卡" aria-label="账户名称" onChange={(event) => setAccountNameDraft(event.target.value)} />
              <div role="group" aria-label="账户类型">
                {(["cash", "bank", "wallet"] as const).map((type) => <button key={type} className={accountTypeDraft === type ? "selected" : ""} type="button" onClick={() => setAccountTypeDraft(type)}>{type === "cash" ? "现金" : type === "bank" ? "银行卡" : "电子钱包"}</button>)}
              </div>
              <button type="submit" disabled={!accountNameDraft.trim()}>{accountEditingId ? "保存修改" : "新增账户"}</button>
              {accountEditingId ? <button type="button" onClick={() => { setAccountEditingId(null); setAccountNameDraft(""); setAccountTypeDraft("cash"); }}>新增另一个账户</button> : null}
            </form> : <p className="account-manager-readonly">当前为普通成员，只能选择账户。</p>}
          </section>
        </div>
      ) : null}
      {isCategoryEditorOpen ? (
        <div className="category-manager-backdrop" role="presentation">
          <section className="category-manager-sheet" role="dialog" aria-modal="true" aria-labelledby="category-editor-title">
            <header className="category-manager-header">
              <button type="button" aria-label="关闭分类管理" onClick={closeCategoryManager}>‹</button>
              <div><small>{activeLedgerName}</small><h2 id="category-editor-title">分类管理</h2></div>
              <div className="category-manager-actions">
                <button type="button" onClick={toggleCategoryManageEditing}>{isCategoryManageEditing ? "完成" : "编辑"}</button>
                <button type="button" onClick={() => openCategoryEditor()}>新增</button>
              </div>
            </header>
            <div className="editor-type-tabs">
              <button className={entryType === "expense" ? "selected" : ""} type="button" onClick={() => selectCategoryManagerType("expense")}>支出</button>
              <button className={entryType === "income" ? "selected" : ""} type="button" onClick={() => selectCategoryManagerType("income")}>收入</button>
            </div>
            <div className="category-manager-grid">
              {manageableCategories.map((category) => (
                <button key={category.id} className={categoryId === category.id ? "selected" : ""} type="button" onClick={() => { if (isCategoryManageEditing) openCategoryEditor(category); else { selectCategory(category.id); closeCategoryManager(); } }}>
                  <span aria-hidden="true">{category.icon}</span><strong>{category.name}</strong>{isCategoryManageEditing ? <small aria-hidden="true">✎</small> : null}
                </button>
              ))}
            </div>
            {isCategoryFormOpen ? <form className="category-manager-form" onSubmit={handleSaveCategory}>
              <div className="category-form-heading"><strong>{categoryEditingId ? "编辑分类" : "新增分类"}</strong><button type="button" aria-label="关闭分类编辑" onClick={() => { setIsCategoryFormOpen(false); setIsAddingSubcategory(false); setIsDeletingSubcategories(false); }}>×</button></div>
              <div className="category-form-fields"><input id="category-icon" aria-label="分类图标文字" value={categoryIconDraft} maxLength={1} placeholder="图" onChange={(event) => setCategoryIconDraft(event.target.value)} /><input id="category-name" aria-label="分类名称" value={categoryNameDraft} maxLength={8} placeholder="分类名称" onChange={(event) => setCategoryNameDraft(event.target.value)} /></div>
              <div className="category-icon-options" aria-label="选择分类图标">{categoryIconOptions.map((icon) => <button key={icon} className={categoryIconDraft === icon ? "selected" : ""} type="button" aria-label={`使用图标${icon}`} onClick={() => setCategoryIconDraft(icon)}>{icon}</button>)}</div>
              <button className="editor-save" type="submit">{categoryEditingId ? "保存分类" : "新增分类"}</button>
              {categoryEditingId ? <div className="category-subtag-editor"><div><strong>编辑子标签</strong><small>点击标签可修改名称</small></div>{renderSubcategoryControls("edit")}</div> : null}
            </form> : null}
            {errorMessage ? <p className="editor-error" role="alert">{errorMessage}</p> : null}
          </section>
        </div>
      ) : null}
      {isInstallGuideOpen ? (
        <div className="install-guide-backdrop" role="presentation" onClick={() => setIsInstallGuideOpen(false)}>
          <section className="install-guide-sheet" role="dialog" aria-modal="true" aria-labelledby="install-guide-title" onClick={(event) => event.stopPropagation()}>
            <header><span aria-hidden="true">装</span><div><p>离线应用</p><h2 id="install-guide-title">添加轻记账到主屏幕</h2></div></header>
            {pwaStatus === "development" || pwaStatus === "unsupported" ? (
              <p className="install-warning">当前局域网开发地址不是 HTTPS，iPhone 不允许在此地址安装 Service Worker。请使用发布后的 HTTPS 地址完成安装。</p>
            ) : null}
            <ol>
              <li><b>1</b><span>在 iPhone 的 Safari 中打开轻记账 HTTPS 地址。</span></li>
              <li><b>2</b><span>点击浏览器底部的“分享”按钮。</span></li>
              <li><b>3</b><span>选择“添加到主屏幕”，然后点击“添加”。</span></li>
              <li><b>4</b><span>保持联网并打开一次桌面图标，看到“离线可用”后即可断网使用。</span></li>
            </ol>
            <button type="button" onClick={() => setIsInstallGuideOpen(false)}>知道了</button>
          </section>
        </div>
      ) : null}
      {isLedgerMonthPickerOpen ? <MonthYearPicker value={ledgerMonth} onCancel={() => setIsLedgerMonthPickerOpen(false)} onConfirm={(value) => { setLedgerMonth(value); setIsLedgerMonthPickerOpen(false); }} /> : null}
      {isStatisticsPeriodPickerOpen ? <MonthYearPicker value={statisticsAnchor} mode={statisticsPeriod} maximum={transactionVisibilityDate} onCancel={() => setIsStatisticsPeriodPickerOpen(false)} onConfirm={(value) => { setStatisticsAnchor(statisticsPeriod === "year" ? new Date(value.getFullYear(), statisticsAnchor.getMonth(), 1) : value); setIsStatisticsPeriodPickerOpen(false); console.debug("[bookkeeping] statistics period selected", { ledgerId: activeLedgerId, period: statisticsPeriod, year: value.getFullYear(), month: value.getMonth() + 1 }); }} /> : null}
      {isComposerOpen && isDatePickerOpen ? (
        <DateTimePicker
          value={occurredAt}
          onCancel={() => setIsDatePickerOpen(false)}
          onConfirm={(value) => {
            setOccurredAt(value);
            setIsDatePickerOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}
