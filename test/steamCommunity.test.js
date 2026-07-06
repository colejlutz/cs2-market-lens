const assert = require("node:assert/strict");
const test = require("node:test");

const steamCommunity = require("../priceProviders/steamCommunity");
const { priceInventoryItems } = require("../services/pricingService");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() {
      return JSON.stringify(body);
    }
  };
}

test("buildPriceOverviewUrl safely encodes CS2 market_hash_name variants", () => {
  const names = [
    "AK-47 | Redline (Field-Tested)",
    "StatTrak™ M4A1-S | Cyrex (Factory New)",
    "Souvenir AWP | Dragon Lore (Minimal Wear)",
    "Sticker | Team Liquid | Katowice 2019",
    "M4A4 | 龍王 (Dragon King) (Field-Tested)"
  ];

  for (const name of names) {
    const url = new URL(steamCommunity._test.buildPriceOverviewUrl(name, 1));

    assert.equal(url.pathname, "/market/priceoverview/");
    assert.equal(url.searchParams.get("appid"), "730");
    assert.equal(url.searchParams.get("currency"), "1");
    assert.equal(url.searchParams.get("market_hash_name"), name);
  }
});

test("priceInventoryItems skips non-marketable items and dedupes duplicate names", async () => {
  const originalFetch = global.fetch;
  const requestedUrls = [];
  steamCommunity._test.reset();
  steamCommunity._test.setRequestDelayForTests(0);

  global.fetch = async (url) => {
    requestedUrls.push(url);
    return jsonResponse({
      success: true,
      lowest_price: "$12.34",
      median_price: "$12.00",
      volume: "1,234"
    });
  };

  try {
    const priced = await priceInventoryItems(
      [
        {
          assetid: "1",
          market_hash_name: "AK-47 | Redline (Field-Tested)",
          marketable: 1
        },
        {
          assetid: "2",
          market_hash_name: "AK-47 | Redline (Field-Tested)",
          marketable: 1
        },
        {
          assetid: "3",
          market_hash_name: "Souvenir AWP | Dragon Lore (Minimal Wear)",
          marketable: 0
        }
      ],
      { currency: 1, concurrency: 1, providerIds: ["steam-community"] }
    );

    assert.equal(requestedUrls.length, 1);
    assert.equal(priced[0].bestPrice, 12.34);
    assert.equal(priced[1].bestPrice, 12.34);
    assert.equal(priced[2].bestPrice, null);
  } finally {
    global.fetch = originalFetch;
    steamCommunity._test.reset();
  }
});

test("getSteamMarketPrice caches repeated market_hash_name lookups during a run", async () => {
  const originalFetch = global.fetch;
  let fetchCount = 0;
  steamCommunity._test.reset();
  steamCommunity._test.setRequestDelayForTests(0);

  global.fetch = async () => {
    fetchCount += 1;
    return jsonResponse({
      success: true,
      lowest_price: "$1.50",
      volume: "2"
    });
  };

  try {
    await steamCommunity._test.getSteamMarketPrice("StatTrak™ USP-S | Ticket to Hell (Field-Tested)", 1);
    await steamCommunity._test.getSteamMarketPrice("StatTrak™ USP-S | Ticket to Hell (Field-Tested)", 1);

    assert.equal(fetchCount, 1);
  } finally {
    global.fetch = originalFetch;
    steamCommunity._test.reset();
  }
});

test("getPricesForInventory catches Steam 403 and 429 without aborting the batch", async () => {
  const originalFetch = global.fetch;
  const statuses = [403, 429, 200];
  steamCommunity._test.reset();
  steamCommunity._test.setRequestDelayForTests(0);
  steamCommunity._test.setRetryDelaysForTests([]);

  global.fetch = async () => {
    const status = statuses.shift();
    if (status !== 200) {
      return jsonResponse({ success: false }, status);
    }

    return jsonResponse({
      success: true,
      lowest_price: "$0.03",
      volume: "9"
    });
  };

  try {
    const prices = await steamCommunity._test.getPricesForInventory(
      [
        { market_hash_name: "Sticker | One", marketable: 1 },
        { market_hash_name: "Sticker | Two", marketable: 1 },
        { market_hash_name: "Sticker | Three", marketable: 1 }
      ],
      1
    );

    assert.match(prices["Sticker | One"].error, /403/);
    assert.match(prices["Sticker | Two"].error, /429/);
    assert.equal(prices["Sticker | Three"].success, true);
  } finally {
    global.fetch = originalFetch;
    steamCommunity._test.reset();
  }
});
