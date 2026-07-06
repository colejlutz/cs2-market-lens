const PROVIDER_ID = "dmarket";
const CACHE_TTL_MS = 60 * 1000;
const DEFAULT_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const RATE_LIMIT_HEADER_NAMES = [
  "retry-after",
  "x-ratelimit-limit-second",
  "x-ratelimit-remaining-second",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset"
];

// DMarket public market-items requests are throttled below the published
// unauthenticated ceiling. TODO: Store only compact snapshots if history is added.
let minInterRequestDelayMs = 1000;
let lastRequestTime = 0;
let fetchQueue = Promise.resolve();
let backoffUntil = 0;
let consecutiveRateLimits = 0;
let latestRateLimitHeaders = {};
const runPriceCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMarketItemsUrl(marketHashName, limit = 10) {
  const params = new URLSearchParams({
    gameId: "a8db",
    title: String(marketHashName || "").trim(),
    currency: "USD",
    limit: String(limit),
    offset: "0",
    orderBy: "price",
    orderDir: "asc"
  });

  return `https://api.dmarket.com/exchange/v1/market/items?${params}`;
}

function buildExternalUrl(marketHashName) {
  const params = new URLSearchParams({
    title: String(marketHashName || "").trim()
  });
  return `https://dmarket.com/ingame-items/item-list/csgo-skins?${params}`;
}

function collectRateLimitHeaders(response) {
  const headers = {};
  if (!response?.headers || typeof response.headers.get !== "function") {
    return headers;
  }

  for (const name of RATE_LIMIT_HEADER_NAMES) {
    const value = response.headers.get(name);
    if (value != null && value !== "") {
      headers[name] = value;
    }
  }

  return headers;
}

function logRateLimitHeaders(headers) {
  if (Object.keys(headers).length) {
    console.info("[DMarket] Rate-limit headers:", headers);
  }
}

function formatUsd(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : null;
}

function parseCentsValue(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractPriceCents(item) {
  const candidates = [
    { path: "price.USD", value: item?.price?.USD },
    { path: "price.amount", value: item?.price?.amount },
    { path: "instantPrice.USD", value: item?.instantPrice?.USD },
    { path: "price", value: item?.price },
    { path: "minPrice", value: item?.minPrice }
  ];

  for (const candidate of candidates) {
    const cents = parseCentsValue(candidate.value);
    if (cents != null) {
      return { cents, path: candidate.path, value: candidate.value };
    }
  }

  return null;
}

function buildEmptyResult(error, source, extra = {}) {
  return {
    providerId: PROVIDER_ID,
    providerName: "DMarket",
    success: false,
    available: false,
    authUsed: false,
    priceNumber: null,
    priceText: null,
    currency: 1,
    source,
    listingId: null,
    totalCount: null,
    externalUrl: null,
    lowestRawCents: null,
    parsedRawPriceField: null,
    rateLimitHeaders: latestRateLimitHeaders,
    retryAt: backoffUntil || null,
    httpStatus: null,
    raw: null,
    error,
    ...extra
  };
}

function parseRetryAfterMs(headers) {
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(1000, seconds * 1000);
    }
  }

  const reset = Number(headers["ratelimit-reset"]);
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
}

function registerRateLimit(headers) {
  consecutiveRateLimits += 1;
  const exponentialBackoff = Math.min(
    MAX_BACKOFF_MS,
    DEFAULT_BACKOFF_MS * (2 ** (consecutiveRateLimits - 1))
  );
  const backoffMs = Math.max(parseRetryAfterMs(headers) || 0, exponentialBackoff);
  backoffUntil = Date.now() + backoffMs;
  return backoffMs;
}

function pauseIfLimitExhausted(headers) {
  const remaining = Number(
    headers["x-ratelimit-remaining-second"] ?? headers["ratelimit-remaining"]
  );
  if (remaining !== 0) return;

  const pauseMs = Math.max(1000, parseRetryAfterMs(headers) || 1000);
  backoffUntil = Math.max(backoffUntil, Date.now() + pauseMs);
}

async function queuedFetch(url) {
  const execute = async () => {
    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < minInterRequestDelayMs) {
      await sleep(minInterRequestDelayMs - elapsed);
    }

    lastRequestTime = Date.now();
    return fetch(url, {
      headers: { Accept: "application/json,text/plain,*/*" },
      redirect: "follow"
    });
  };

  const operation = fetchQueue.then(execute, execute);
  fetchQueue = operation.catch(() => undefined);
  return operation;
}

function isExactActiveListing(listing, marketHashName) {
  return (
    String(listing?.title || "").trim() === marketHashName &&
    String(listing?.status || "active").toLowerCase() === "active" &&
    extractPriceCents(listing) != null
  );
}

async function requestPrice(marketHashName, options = {}) {
  const normalizedName = String(marketHashName || "").trim();
  const limit = Math.max(1, Number(options.limit) || 10);

  if (!normalizedName) {
    return buildEmptyResult("Missing market_hash_name.", "validation_error");
  }

  if (!options.ignoreBackoff && backoffUntil > Date.now()) {
    const seconds = Math.ceil((backoffUntil - Date.now()) / 1000);
    return buildEmptyResult(
      `DMarket refresh paused after rate limiting. Retry in ${seconds} seconds.`,
      "rate_limit_backoff"
    );
  }

  const cached = runPriceCache.get(normalizedName);
  if (
    !options.forceRefresh &&
    cached &&
    Date.now() - cached.cachedAt < CACHE_TTL_MS
  ) {
    return cached.result;
  }

  const url = buildMarketItemsUrl(normalizedName, limit);
  let response;
  try {
    response = await queuedFetch(url);
  } catch (error) {
    return buildEmptyResult(
      `DMarket request failed: ${error?.message || String(error)}`,
      "request_error"
    );
  }

  latestRateLimitHeaders = collectRateLimitHeaders(response);
  logRateLimitHeaders(latestRateLimitHeaders);

  const text = await response.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_error) {
    json = null;
  }

  if (response.status === 429) {
    const pauseMs = registerRateLimit(latestRateLimitHeaders);
    return buildEmptyResult(
      `DMarket market items returned 429. Rate limited by DMarket. Refresh paused for ${Math.ceil(pauseMs / 1000)} seconds.`,
      "rate_limit",
      { httpStatus: response.status }
    );
  }

  if (response.status === 401 || response.status === 403) {
    return buildEmptyResult(
      `DMarket market items returned HTTP ${response.status}.`,
      "authorization_error",
      { httpStatus: response.status }
    );
  }

  if (!response.ok) {
    return buildEmptyResult(
      `DMarket market items failed with HTTP ${response.status} ${response.statusText || ""}: ${text.slice(0, 240)}`.trim(),
      "request_error",
      { httpStatus: response.status }
    );
  }

  if (!json) {
    return buildEmptyResult(
      `DMarket market items returned non-JSON content: ${text.slice(0, 240)}`,
      "request_error",
      { httpStatus: response.status }
    );
  }

  consecutiveRateLimits = 0;
  backoffUntil = 0;
  pauseIfLimitExhausted(latestRateLimitHeaders);
  const listings = (Array.isArray(json.objects) ? json.objects : [])
    .filter((listing) => isExactActiveListing(listing, normalizedName))
    .map((listing) => ({ listing, price: extractPriceCents(listing) }))
    .sort((a, b) => a.price.cents - b.price.cents);
  const selected = listings[0];

  if (!selected) {
    return buildEmptyResult("No active exact-match listings available.", "no_listings", {
      authUsed: false,
      httpStatus: response.status
    });
  }

  const priceNumber = selected.price.cents / 100;
  const listingId =
    selected.listing.itemId ||
    selected.listing.offerId ||
    selected.listing.extra?.offerId ||
    null;
  const result = {
    providerId: PROVIDER_ID,
    providerName: "DMarket",
    success: true,
    available: true,
    authUsed: false,
    priceNumber,
    priceText: formatUsd(priceNumber),
    currency: 1,
    source: "dmarket",
    listingId,
    totalCount: listings.length,
    externalUrl: buildExternalUrl(normalizedName),
    lowestRawCents: selected.price.cents,
    parsedRawPriceField: `${selected.price.path}=${selected.price.value}`,
    rateLimitHeaders: latestRateLimitHeaders,
    retryAt: null,
    httpStatus: response.status,
    raw: null,
    error: null
  };

  runPriceCache.set(normalizedName, { cachedAt: Date.now(), result });
  return result;
}

const provider = {
  id: PROVIDER_ID,
  displayName: "DMarket",
  status: "active",

  canHandleItem(item) {
    return (
      Number(item?.marketable) === 1 &&
      Boolean(String(item?.market_hash_name || "").trim())
    );
  },

  async getPriceData(item, options = {}) {
    if (Number(item?.marketable) !== 1) {
      return buildEmptyResult("Item is not marketable.", "validation_error");
    }
    return requestPrice(item?.market_hash_name, options);
  },

  normalizePriceResult(rawResult) {
    return {
      providerId: rawResult?.providerId || this.id,
      providerName: rawResult?.providerName || this.displayName,
      success: Boolean(rawResult?.success),
      available: Boolean(rawResult?.available),
      authUsed: Boolean(rawResult?.authUsed),
      priceNumber:
        typeof rawResult?.priceNumber === "number" &&
        Number.isFinite(rawResult.priceNumber)
          ? rawResult.priceNumber
          : null,
      priceText: rawResult?.priceText || null,
      currency: rawResult?.currency || 1,
      source: rawResult?.source || null,
      listingId: rawResult?.listingId || null,
      totalCount:
        typeof rawResult?.totalCount === "number" &&
        Number.isFinite(rawResult.totalCount)
          ? rawResult.totalCount
          : null,
      externalUrl: rawResult?.externalUrl || null,
      lowestRawCents: rawResult?.lowestRawCents ?? null,
      parsedRawPriceField: rawResult?.parsedRawPriceField || null,
      rateLimitHeaders: rawResult?.rateLimitHeaders || {},
      retryAt: rawResult?.retryAt || null,
      httpStatus: rawResult?.httpStatus ?? null,
      error: rawResult?.error || null,
      raw: null
    };
  },

  async testConnection() {
    const result = await requestPrice("AK-47 | Redline (Field-Tested)", {
      limit: 10,
      forceRefresh: true,
      ignoreBackoff: true
    });
    return this.normalizePriceResult(result);
  },

  getRuntimeStatus() {
    return {
      id: this.id,
      pausedUntil: backoffUntil > Date.now() ? backoffUntil : null,
      rateLimitHeaders: latestRateLimitHeaders
    };
  },

  clearCacheAndBackoff() {
    runPriceCache.clear();
    backoffUntil = 0;
    consecutiveRateLimits = 0;
    latestRateLimitHeaders = {};
  },

  _test: {
    buildMarketItemsUrl,
    buildExternalUrl,
    extractPriceCents,
    requestPrice,
    runPriceCache,
    setRequestDelayForTests(ms) {
      minInterRequestDelayMs = Number(ms) || 0;
    },
    reset() {
      runPriceCache.clear();
      minInterRequestDelayMs = 1000;
      lastRequestTime = 0;
      fetchQueue = Promise.resolve();
      backoffUntil = 0;
      consecutiveRateLimits = 0;
      latestRateLimitHeaders = {};
    }
  }
};

module.exports = provider;
