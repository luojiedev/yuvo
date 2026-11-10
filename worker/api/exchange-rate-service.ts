import { ApiError, jsonResponse, logDebug, logError, type RequestContext } from "./http";

const SUPPORTED = new Set(["CNY", "USD"]);
const UPSTREAM_TIMEOUT_MS = 4_000;

interface FrankfurterRate {
  date?: unknown;
  base?: unknown;
  quote?: unknown;
  rate?: unknown;
}

export async function getExchangeRate(request: Request, context: RequestContext): Promise<Response> {
  const url = new URL(request.url);
  const match = /\/exchange-rates\/([A-Z]{3})\/([A-Z]{3})$/u.exec(url.pathname);
  if (!match || !SUPPORTED.has(match[1]) || !SUPPORTED.has(match[2]) || match[1] === match[2]) {
    throw new ApiError(400, "UNSUPPORTED_CURRENCY_PAIR", "当前仅支持 USD 与 CNY 的汇率");
  }
  const [base, quote] = [match[1], match[2]];
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: "GET" });
  const exchangeRateCache = await caches.open("exchange-rates");
  try {
    const cached = await exchangeRateCache.match(cacheKey);
    if (cached) return cached;
  } catch (error) {
    logError(context, "exchange-rate.cache.read-failed", error instanceof Error ? error.message : "cache read failed", { base, quote });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`https://api.frankfurter.dev/v2/rate/${base}/${quote}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    logError(context, "exchange-rate.upstream.failed", error instanceof Error ? error.message : "upstream request failed", { base, quote });
    throw new ApiError(503, "EXCHANGE_RATE_UNAVAILABLE", "暂时无法获取参考汇率，请稍后重试或手动输入");
  } finally {
    clearTimeout(timeout);
  }
  if (!upstream.ok) {
    logError(context, "exchange-rate.upstream.rejected", `status ${upstream.status}`, { base, quote });
    throw new ApiError(503, "EXCHANGE_RATE_UNAVAILABLE", "暂时无法获取参考汇率，请稍后重试或手动输入");
  }
  const contentLength = Number(upstream.headers.get("content-length") ?? 0);
  if (contentLength > 16_384) throw new ApiError(502, "INVALID_EXCHANGE_RATE_RESPONSE", "汇率服务响应异常");
  const value = await upstream.json<FrankfurterRate>();
  const rate = typeof value.rate === "number" ? value.rate : Number.NaN;
  const rateMicros = Math.round(rate * 1_000_000);
  if (!Number.isSafeInteger(rateMicros) || rateMicros <= 0 || value.base !== base || value.quote !== quote || typeof value.date !== "string") {
    throw new ApiError(502, "INVALID_EXCHANGE_RATE_RESPONSE", "汇率服务响应异常");
  }
  const response = jsonResponse({
    base,
    quote,
    rateMicros,
    rateDate: value.date,
    source: "frankfurter",
    fetchedAt: context.now,
  }, context);
  response.headers.set("cache-control", "public, max-age=21600");
  try {
    await exchangeRateCache.put(cacheKey, response.clone());
  } catch (error) {
    logError(context, "exchange-rate.cache.write-failed", error instanceof Error ? error.message : "cache write failed", { base, quote });
  }
  logDebug(context, "exchange-rate.fetched", { base, quote, rateDate: value.date });
  return response;
}
