const crypto = require("crypto");

const PROVIDER_ID = "csfloat";
const CACHE_TTL_MS = 60 * 1000;
const DEFAULT_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const RATE_LIMIT_HEADER_NAMES = [
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset"
];

// TODO: When history support exists, persist compact price snapshots only,
// never bulk CSFloat listing payloads.
let minInterRequestDelayMs = 750;
let lastRequestTime = 0;
let fetchQueue = Promise.resolve();
let backoffUntil = 0;
let consecutiveRateLimits = 0;
let latestRateLimitHeaders = {};
const runPriceCache = new Map();
const rejectedKeyFingerprints = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildListingSearchUrl(marketHashName, limit = 10) {
  const params = new URLSearchParams({
    market_hash_name: String(marketHashName || "").trim(),
    sort_by: "lowest_price",
    limit: String(limit),
    type: "buy_now"
  });

  return `https://csfloat.com/api/v1/listings?${params}`;
}

function buildExternalUrl(marketHashName, listingId = null) {
  if (listingId) {
    return `https://csfloat.com/item/${encodeURIComponent(String(listingId))}`;
  }

  const params = new URLSearchParams({
    market_hash_name: String(marketHashName || "").trim()
  });
  return `https://csfloat.com/search?${params}`;
}

function keyFingerprint(apiKey) {
  return crypto
    .createHash("sha256")
    .update(String(apiKey || ""))
    .digest("hex")
    .slice(0, 16);
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
    console.info("[CSFloat] Rate-limit headers:", headers);
  }
}

function formatUsd(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : null;
}

function buildEmptyResult(error, source, extra = {}) {
  return {
    providerId: PROVIDER_ID,
    providerName: "CSFloat",
    success: false,
    available: false,
    priceNumber: null,
    priceText: null,
    currency: 1,
    source,
    listingId: null,
    totalCount: null,
    externalUrl: null,
    lowestRawCents: null,
    rateLimitHeaders: latestRateLimitHeaders,
    retryAt: backoffUntil || null,
    raw: null,
    httpStatus: null,
    error,
    ...extra
  };
}

function parseRetryAfterMs(headers) {
  const value = headers["retry-after"];
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(1000, seconds * 1000);
  }

  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(1000, time - Date.now()) : null;
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

function isActiveBuyNowListing(listing) {
  if (!listing || !Number.isFinite(Number(listing.price)) || Number(listing.price) <= 0) {
    return false;
  }

  const state = String(listing.state || listing.status || "").toLowerCase();
  return !["sold", "deleted", "cancelled", "canceled", "withdrawn", "inactive"].includes(state);
}

function getListings(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.listings)) return json.listings;
  return [];
}

async function queuedFetch(url, apiKey) {
  const execute = async () => {
    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < minInterRequestDelayMs) {
      await sleep(minInterRequestDelayMs - elapsed);
    }

    lastRequestTime = Date.now();
    return fetch(url, {
      headers: {
        Authorization: apiKey,
        Accept: "application/json,text/plain,*/*"
      },
      redirect: "follow"
    });
  };

  const operation = fetchQueue.then(execute, execute);
  fetchQueue = operation.catch(() => undefined);
  return operation;
}

async function requestPrice(marketHashName, apiKey, options = {}) {
  const normalizedName = String(marketHashName || "").trim();
  const normalizedKey = String(apiKey || "").trim();
  const limit = Math.max(1, Number(options.limit) || 10);

  if (!normalizedName) {
    return buildEmptyResult("Missing market_hash_name.", "validation_error");
  }

  if (!normalizedKey) {
    return buildEmptyResult(
      "Missing CSFloat API key. Add one in Settings.",
      "missing_api_key"
    );
  }

  const fingerprint = keyFingerprint(normalizedKey);
  if (rejectedKeyFingerprints.has(fingerprint)) {
    return buildEmptyResult(
      "CSFloat API key was rejected. Update it in Settings and try again.",
      "invalid_api_key"
    );
  }

  if (!options.ignoreBackoff && backoffUntil > Date.now()) {
    const seconds = Math.ceil((backoffUntil - Date.now()) / 1000);
    return buildEmptyResult(
      `CSFloat refresh paused after rate limiting. Retry in ${seconds} seconds.`,
      "rate_limit_backoff"
    );
  }

  const cacheKey = `${fingerprint}:${normalizedName}`;
  const cached = runPriceCache.get(cacheKey);
  if (
    !options.forceRefresh &&
    cached &&
    Date.now() - cached.cachedAt < CACHE_TTL_MS
  ) {
    return cached.result;
  }

  const url = buildListingSearchUrl(normalizedName, limit);
  let response;

  try {
    response = await queuedFetch(url, normalizedKey);
  } catch (error) {
    return buildEmptyResult(
      `CSFloat request failed: ${error?.message || String(error)}`,
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
      `CSFloat listings returned 429. Rate limited by CSFloat. Refresh paused for ${Math.ceil(pauseMs / 1000)} seconds.`,
      "rate_limit",
      { httpStatus: response.status }
    );
  }

  if (response.status === 401 || response.status === 403) {
    rejectedKeyFingerprints.add(fingerprint);
    return buildEmptyResult(
      `CSFloat listings returned HTTP ${response.status}. API key may be invalid.`,
      "invalid_api_key",
      { httpStatus: response.status }
    );
  }

  if (!response.ok) {
    return buildEmptyResult(
      `CSFloat listings failed with HTTP ${response.status} ${response.statusText || ""}: ${text.slice(0, 240)}`.trim(),
      "request_error",
      { httpStatus: response.status }
    );
  }

  if (json && json.code === 1 && json.message) {
    rejectedKeyFingerprints.add(fingerprint);
    return buildEmptyResult(`CSFloat listings: ${json.message}`, "invalid_api_key", {
      httpStatus: response.status
    });
  }

  if (!json) {
    return buildEmptyResult(
      `CSFloat listings returned non-JSON content: ${text.slice(0, 240)}`,
      "request_error",
      { httpStatus: response.status }
    );
  }

  consecutiveRateLimits = 0;
  backoffUntil = 0;
  const listings = getListings(json)
    .filter(isActiveBuyNowListing)
    .sort((a, b) => Number(a.price) - Number(b.price));
  const listing = listings[0];

  if (!listing) {
    return buildEmptyResult("No active buy_now listings available.", "no_listings", {
      authWorked: true,
      httpStatus: response.status
    });
  }

  const cents = Number(listing.price);
  const dollars = cents / 100;
  const listingId = listing.id || listing.listing_id || null;
  const result = {
    providerId: PROVIDER_ID,
    providerName: "CSFloat",
    success: true,
    available: true,
    authWorked: true,
    priceNumber: dollars,
    priceText: formatUsd(dollars),
    currency: 1,
    source: "listings",
    listingId,
    totalCount: listings.length,
    externalUrl: buildExternalUrl(normalizedName, listingId),
    lowestRawCents: cents,
    rateLimitHeaders: latestRateLimitHeaders,
    retryAt: null,
    raw: null,
    httpStatus: response.status,
    error: null
  };

  runPriceCache.set(cacheKey, { cachedAt: Date.now(), result });
  return result;
}

const provider = {
  id: PROVIDER_ID,
  displayName: "CSFloat",
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

    return requestPrice(
      item?.market_hash_name,
      options.csfloatApiKey,
      options
    );
  },

  normalizePriceResult(rawResult) {
    return {
      providerId: rawResult?.providerId || this.id,
      providerName: rawResult?.providerName || this.displayName,
      success: Boolean(rawResult?.success),
      available: Boolean(rawResult?.available),
      authWorked: Boolean(rawResult?.authWorked),
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
      rateLimitHeaders: rawResult?.rateLimitHeaders || {},
      retryAt: rawResult?.retryAt || null,
      httpStatus: rawResult?.httpStatus ?? null,
      error: rawResult?.error || null,
      raw: null
    };
  },

  async testConnection(apiKey) {
    const marketHashName = "AK-47 | Redline (Field-Tested)";
    const result = await requestPrice(marketHashName, apiKey, {
      limit: 5,
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
    rejectedKeyFingerprints.clear();
    backoffUntil = 0;
    consecutiveRateLimits = 0;
    latestRateLimitHeaders = {};
  },

  _test: {
    buildListingSearchUrl,
    buildExternalUrl,
    requestPrice,
    runPriceCache,
    setRequestDelayForTests(ms) {
      minInterRequestDelayMs = Number(ms) || 0;
    },
    reset() {
      runPriceCache.clear();
      rejectedKeyFingerprints.clear();
      minInterRequestDelayMs = 750;
      lastRequestTime = 0;
      fetchQueue = Promise.resolve();
      backoffUntil = 0;
      consecutiveRateLimits = 0;
      latestRateLimitHeaders = {};
    }
  }
};

module.exports = provider;
