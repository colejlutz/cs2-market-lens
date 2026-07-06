const fs = require("fs");
const path = require("path");

const PRICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PRICE_CACHE_PATH = path.join(__dirname, "..", ".cache", "steam-price-cache.json");

function buildHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    Accept: "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Connection: "close"
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPriceOverviewUrl(marketHashName, currency = 1) {
  const params = new URLSearchParams({
    appid: "730",
    currency: String(currency),
    market_hash_name: marketHashName
  });

  return `https://steamcommunity.com/market/priceoverview/?${params}`;
}

function buildHttpError(status, statusText, bodyText) {
  let message = `Steam market priceoverview failed with HTTP ${status}`;

  if (status === 403) {
    message = "Steam market priceoverview returned 403. Steam may be blocking the request.";
  } else if (status === 429) {
    message = "Steam market priceoverview returned 429. Rate limited by Steam.";
  }

  const error = new Error(
    `${message}${statusText ? ` ${statusText}` : ""}: ${String(bodyText || "").slice(0, 240)}`.trim()
  );
  error.status = status;
  return error;
}

function isRateLimitError(error) {
  return Number(error?.status) === 429;
}

function parseUsdText(text) {
  if (!text || typeof text !== "string") return null;

  const match = text.replace(/,/g, "").match(/[\d]+\.?\d*/);
  if (!match) return null;

  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return `$${value.toFixed(2)}`;
}

function parseVolume(value) {
  const normalized = String(value || "").replace(/,/g, "");
  return Number.isFinite(Number(normalized)) && normalized
    ? Number(normalized)
    : null;
}

let minInterRequestDelayMs = 1000;
let rateLimitRetryDelaysMs = [2000, 6000, 12000];

let lastRequestTime = 0;
const runPriceCache = new Map();
let persistentPriceCache = null;
let persistentCacheEnabled = true;

function loadPersistentPriceCache() {
  if (!persistentCacheEnabled) {
    return {};
  }

  if (persistentPriceCache) {
    return persistentPriceCache;
  }

  try {
    const text = fs.readFileSync(PRICE_CACHE_PATH, "utf8");
    const parsed = JSON.parse(text);
    persistentPriceCache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    persistentPriceCache = {};
  }

  return persistentPriceCache;
}

function savePersistentPriceCache() {
  if (!persistentCacheEnabled || !persistentPriceCache) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(PRICE_CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      PRICE_CACHE_PATH,
      JSON.stringify(persistentPriceCache, null, 2),
      "utf8"
    );
  } catch (_error) {
    // Disk cache is a speed optimization only. Pricing should still work.
  }
}

function getCachedPrice(cacheKey) {
  if (runPriceCache.has(cacheKey)) {
    return runPriceCache.get(cacheKey);
  }

  const persistent = loadPersistentPriceCache();
  const cached = persistent[cacheKey];

  if (
    cached &&
    cached.result &&
    Date.now() - Number(cached.cachedAt || 0) < PRICE_CACHE_TTL_MS
  ) {
    runPriceCache.set(cacheKey, cached.result);
    return cached.result;
  }

  return null;
}

function setCachedPrice(cacheKey, result) {
  runPriceCache.set(cacheKey, result);

  if (result && result.success === true && result.available === true) {
    const persistent = loadPersistentPriceCache();
    persistent[cacheKey] = {
      cachedAt: Date.now(),
      result
    };
    savePersistentPriceCache();
  }
}

async function throttledFetch(url) {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < minInterRequestDelayMs) {
    await sleep(minInterRequestDelayMs - elapsed);
  }

  lastRequestTime = Date.now();

  const response = await fetch(url, {
    headers: buildHeaders(),
    redirect: "follow"
  });

  const text = await response.text().catch(() => "");

  if (!response.ok) {
    throw buildHttpError(response.status, response.statusText, text);
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    const error = new Error(
      `Steam market priceoverview returned non-JSON content: ${text.slice(0, 240)}`
    );
    error.status = response.status;
    throw error;
  }
}

async function fetchPriceOverviewJson(url) {
  let lastError = null;

  for (let attempt = 0; attempt <= rateLimitRetryDelaysMs.length; attempt += 1) {
    if (attempt > 0) {
      await sleep(rateLimitRetryDelaysMs[attempt - 1]);
    }

    try {
      return await throttledFetch(url);
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt >= rateLimitRetryDelaysMs.length) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function getSteamMarketPrice(marketHashName, currency = 1) {
  const normalizedName = String(marketHashName || "").trim();
  const normalizedCurrency = Number(currency || 1);

  if (!normalizedName) {
    throw new Error("Missing market_hash_name.");
  }

  const cacheKey = `${normalizedCurrency}:${normalizedName}`;
  const cachedPrice = getCachedPrice(cacheKey);
  if (cachedPrice) {
    return cachedPrice;
  }

  const url = buildPriceOverviewUrl(normalizedName, normalizedCurrency);
  const json = await fetchPriceOverviewJson(url);
  const priceText = json.lowest_price || json.median_price || null;
  const priceNumber = parseUsdText(priceText);

  const result = {
    market_hash_name: normalizedName,
    source: "price-overview",
    success: Boolean(json.success),
    available: Boolean(json.success && priceNumber),
    priceNumber,
    priceText: priceNumber ? formatUsd(priceNumber) : null,
    currency: normalizedCurrency,
    volume: parseVolume(json.volume),
    lowestPriceText: json.lowest_price || null,
    medianPriceText: json.median_price || null,
    listingId: null,
    totalCount: parseVolume(json.volume),
    raw: json,
    error: null
  };

  setCachedPrice(cacheKey, result);
  return result;
}

async function getPricesForInventory(items, currency = 1) {
  const names = [
    ...new Set(
      (Array.isArray(items) ? items : [])
        .filter(
          (item) =>
            Number(item?.marketable) === 1 &&
            String(item?.market_hash_name || "").trim()
        )
        .map((item) => String(item.market_hash_name).trim())
    )
  ];

  const prices = {};

  for (const name of names) {
    try {
      prices[name] = await getSteamMarketPrice(name, currency);
    } catch (error) {
      prices[name] = {
        market_hash_name: name,
        success: false,
        error: error?.message || String(error)
      };
    }
  }

  return prices;
}

function buildEmptyResult(provider, currency, error, source = "price-overview") {
  return {
    providerId: provider.id,
    providerName: provider.displayName,
    success: false,
    available: false,
    priceNumber: null,
    priceText: null,
    currency,
    volume: null,
    lowestPriceText: null,
    medianPriceText: null,
    source,
    listingId: null,
    totalCount: null,
    raw: null,
    error
  };
}

const provider = {
  id: "steam-community",
  displayName: "Steam Community Market",
  status: "active",

  canHandleItem(item) {
    return (
      Number(item?.marketable) === 1 &&
      Boolean(String(item?.market_hash_name || "").trim())
    );
  },

  async getPriceData(item, options = {}) {
    const marketHashName = String(item?.market_hash_name || "").trim();
    const currency = Number(options.currency || 1);

    if (!marketHashName) {
      return buildEmptyResult(this, currency, "Missing market_hash_name.");
    }

    if (Number(item?.marketable) !== 1) {
      return buildEmptyResult(this, currency, "Item is not marketable.");
    }

    try {
      const result = await getSteamMarketPrice(marketHashName, currency);
      return {
        providerId: this.id,
        providerName: this.displayName,
        ...result
      };
    } catch (error) {
      return buildEmptyResult(
        this,
        currency,
        error?.message || String(error),
        isRateLimitError(error) ? "rate_limit" : "request_error"
      );
    }
  },

  normalizePriceResult(rawResult) {
    return {
      providerId: rawResult?.providerId || this.id,
      providerName: rawResult?.providerName || this.displayName,
      success: Boolean(rawResult?.success),
      available: Boolean(rawResult?.available),
      priceNumber:
        typeof rawResult?.priceNumber === "number" &&
        Number.isFinite(rawResult.priceNumber)
          ? rawResult.priceNumber
          : null,
      priceText: rawResult?.priceText || null,
      currency: rawResult?.currency || 1,
      volume: rawResult?.volume || null,
      lowestPriceText: rawResult?.lowestPriceText || null,
      medianPriceText: rawResult?.medianPriceText || null,
      listingId: rawResult?.listingId || null,
      totalCount:
        typeof rawResult?.totalCount === "number" &&
        Number.isFinite(rawResult.totalCount)
          ? rawResult.totalCount
          : null,
      source: rawResult?.source || null,
      error: rawResult?.error || null,
      raw: rawResult?.raw || null
    };
  },

  _test: {
    buildPriceOverviewUrl,
    getSteamMarketPrice,
    getPricesForInventory,
    runPriceCache,
    setRequestDelayForTests(ms) {
      minInterRequestDelayMs = Number(ms) || 0;
    },
    setRetryDelaysForTests(delays) {
      rateLimitRetryDelaysMs = Array.isArray(delays) ? delays : [];
    },
    reset() {
      runPriceCache.clear();
      lastRequestTime = 0;
      minInterRequestDelayMs = 1000;
      rateLimitRetryDelaysMs = [2000, 6000, 12000];
      persistentPriceCache = {};
      persistentCacheEnabled = false;
    }
  }
};

module.exports = provider;
