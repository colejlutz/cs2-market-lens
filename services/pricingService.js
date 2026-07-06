const { getEnabledPriceProviders } = require("../priceProviders");

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const runners = [];
  const safeLimit = Math.max(1, Number(limit) || 1);

  for (let i = 0; i < Math.min(safeLimit, items.length); i += 1) {
    runners.push(runner());
  }

  await Promise.all(runners);
  return results;
}

function chooseBestPrice(providerResults) {
  const successful = providerResults.filter(
    (result) =>
      result &&
      result.success === true &&
      typeof result.priceNumber === "number" &&
      Number.isFinite(result.priceNumber)
  );

  if (!successful.length) {
    return null;
  }

  successful.sort((a, b) => a.priceNumber - b.priceNumber);
  return successful[0];
}

function mergeProviderPrices(existingResults, newResults, selectedProviderIds) {
  if (!selectedProviderIds) {
    return newResults;
  }

  const retained = (Array.isArray(existingResults) ? existingResults : []).filter(
    (result) => !selectedProviderIds.has(result?.providerId)
  );
  return [...retained, ...newResults];
}

async function priceSingleItem(item, providers, options) {
  const providerResults = [];

  for (const provider of providers) {
    if (!provider || provider.status !== "active") {
      continue;
    }

    if (!provider.canHandleItem(item)) {
      continue;
    }

    try {
      const rawResult = await provider.getPriceData(item, options);

      // Wrap normalizePriceResult separately so a buggy provider normalization
      // can't abort the entire pricing pass — just record the failure and move on.
      let normalized;
      try {
        normalized = provider.normalizePriceResult(rawResult);
      } catch (normalizeError) {
        providerResults.push({
          providerId: provider.id,
          providerName: provider.displayName,
          success: false,
          available: false,
          priceNumber: null,
          priceText: null,
          currency: options.currency || 1,
          error: `normalizePriceResult threw: ${normalizeError?.message || String(normalizeError)}`
        });
        continue;
      }

      providerResults.push(normalized);

      // NOTE: No early break here. We query ALL active providers so that the
      // renderer has a full set of prices to display in the marketplace
      // breakdown modal and to re-evaluate when the user enables/disables
      // individual marketplaces or toggles the post-fee price mode.

    } catch (error) {
      providerResults.push({
        providerId: provider.id,
        providerName: provider.displayName,
        success: false,
        available: false,
        priceNumber: null,
        priceText: null,
        currency: options.currency || 1,
        error: error?.message || String(error)
      });
    }
  }

  const best = chooseBestPrice(providerResults);

  return {
    providerPrices: providerResults,
    bestPrice: best ? best.priceNumber : null,
    bestPriceText: best ? best.priceText : "$0.00",
    bestPriceProviderId: best ? best.providerId : null,
    bestPriceProviderName: best ? best.providerName : null
  };
}

function getItemKey(item) {
  return String(item?.market_hash_name || "")
    .trim();
}

function isPlainDefaultWeaponName(name) {
  const normalized = String(name || "").trim();
  if (!normalized) {
    return false;
  }

  if (normalized.includes(" | ")) {
    return false;
  }

  return new Set([
    "AK-47",
    "AUG",
    "AWP",
    "CZ75-Auto",
    "Desert Eagle",
    "Dual Berettas",
    "FAMAS",
    "Five-SeveN",
    "G3SG1",
    "Galil AR",
    "Glock-18",
    "M249",
    "M4A1-S",
    "M4A4",
    "MAC-10",
    "MAG-7",
    "MP5-SD",
    "MP7",
    "MP9",
    "Negev",
    "Nova",
    "P2000",
    "P250",
    "P90",
    "PP-Bizon",
    "R8 Revolver",
    "Sawed-Off",
    "SCAR-20",
    "SG 553",
    "SSG 08",
    "Tec-9",
    "UMP-45",
    "USP-S",
    "XM1014",
    "Zeus x27"
  ]).has(normalized);
}

function shouldLookupMarketPrice(item) {
  if (!item) {
    return false;
  }

  const marketHashName = String(item.market_hash_name || "").trim();
  if (!marketHashName) {
    return false;
  }

  return Number(item.marketable) === 1;
}

function buildUnpricedItem(item) {
  return {
    ...item,
    providerPrices: [],
    bestPrice: null,
    bestPriceText: "$0.00",
    bestPriceProviderId: null,
    bestPriceProviderName: null
  };
}

function getRepresentativeScore(item) {
  if (!item) {
    return -1;
  }

  let score = 0;

  // FIX: Steam sends marketable as 1/0, not true/false.
  if (Boolean(item.marketable)) {
    score += 100;
  }

  if (shouldLookupMarketPrice(item)) {
    score += 10;
  }

  if (String(item.market_hash_name || "").includes(" | ")) {
    score += 5;
  }

  if (!Array.isArray(item.applied_stickers) || item.applied_stickers.length === 0) {
    score += 1;
  }

  if (!item.charm) {
    score += 1;
  }

  return score;
}

async function priceInventoryItems(items, options = {}) {
  const selectedProviderIds = Array.isArray(options.providerIds)
    ? new Set(options.providerIds.map((id) => String(id)))
    : null;
  const providers = getEnabledPriceProviders().filter(
    (provider) =>
      provider &&
      provider.status === "active" &&
      (!selectedProviderIds || selectedProviderIds.has(provider.id))
  );
  const concurrency = Math.max(1, Number(options.concurrency) || 1);

  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  if (!providers.length && !selectedProviderIds) {
    return items.map((item) => buildUnpricedItem(item));
  }

  if (!providers.length) {
    return items;
  }

  const uniqueItemsByKey = new Map();

  for (const item of items) {
    if (!shouldLookupMarketPrice(item)) {
      continue;
    }

    const itemKey = getItemKey(item);
    if (!itemKey) {
      continue;
    }

    const existing = uniqueItemsByKey.get(itemKey);

    if (!existing || getRepresentativeScore(item) > getRepresentativeScore(existing)) {
      uniqueItemsByKey.set(itemKey, item);
    }
  }

  const uniqueEntries = Array.from(uniqueItemsByKey.entries());
  const pricedEntries = await runWithConcurrency(
    uniqueEntries,
    concurrency,
    async ([itemKey, item]) => {
      const priced = await priceSingleItem(item, providers, options);
      return [itemKey, priced];
    }
  );

  const pricedByKey = new Map(pricedEntries);

  return items.map((item) => {
    if (!shouldLookupMarketPrice(item)) {
      return buildUnpricedItem(item);
    }

    const itemKey = getItemKey(item);
    const priced = pricedByKey.get(itemKey);

    if (!priced) {
      return selectedProviderIds ? item : buildUnpricedItem(item);
    }

    const providerPrices = mergeProviderPrices(
      item.providerPrices,
      priced.providerPrices,
      selectedProviderIds
    );
    const best = chooseBestPrice(providerPrices);

    return {
      ...item,
      providerPrices,
      bestPrice: best ? best.priceNumber : null,
      bestPriceText: best ? best.priceText : "$0.00",
      bestPriceProviderId: best ? best.providerId : null,
      bestPriceProviderName: best ? best.providerName : null
    };
  });
}

module.exports = {
  priceInventoryItems
};
