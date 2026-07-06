const assert = require("node:assert/strict");
const test = require("node:test");

const dmarket = require("../priceProviders/dmarket");
const { priceInventoryItems } = require("../services/pricingService");

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      }
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}

test("buildMarketItemsUrl creates a price-sorted public DMarket CS2 lookup", () => {
  const url = new URL(
    dmarket._test.buildMarketItemsUrl("AK-47 | Redline (Field-Tested)", 10)
  );

  assert.equal(url.origin, "https://api.dmarket.com");
  assert.equal(url.pathname, "/exchange/v1/market/items");
  assert.equal(url.searchParams.get("gameId"), "a8db");
  assert.equal(url.searchParams.get("title"), "AK-47 | Redline (Field-Tested)");
  assert.equal(url.searchParams.get("currency"), "USD");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(url.searchParams.get("offset"), "0");
  assert.equal(url.searchParams.get("orderBy"), "price");
  assert.equal(url.searchParams.get("orderDir"), "asc");
});

test("DMarket reads price.USD cents, ignores prefix-only matches, and uses no auth", async () => {
  const originalFetch = global.fetch;
  let request = null;
  dmarket._test.reset();
  dmarket._test.setRequestDelayForTests(0);

  global.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse(
      {
        objects: [
          {
            itemId: "wrong-cheapest",
            title: "StatTrak\u2122 AK-47 | Redline (Field-Tested)",
            status: "active",
            price: { USD: "100" }
          },
          {
            itemId: "chosen",
            title: "AK-47 | Redline (Field-Tested)",
            status: "active",
            price: { USD: "2979" }
          }
        ]
      },
      200,
      { "x-ratelimit-remaining-second": "4" }
    );
  };

  try {
    const result = await dmarket.testConnection();

    assert.equal(request.options.headers.Authorization, undefined);
    assert.equal(result.success, true);
    assert.equal(result.authUsed, false);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.lowestRawCents, 2979);
    assert.equal(result.priceNumber, 29.79);
    assert.equal(result.parsedRawPriceField, "price.USD=2979");
    assert.equal(result.listingId, "chosen");
    assert.match(result.externalUrl, /^https:\/\/dmarket\.com\//);
    assert.equal(result.rateLimitHeaders["x-ratelimit-remaining-second"], "4");
    assert.equal(result.raw, null);
  } finally {
    global.fetch = originalFetch;
    dmarket._test.reset();
  }
});

test("DMarket handles alternate cent fields and pauses requests after HTTP 429", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  dmarket._test.reset();
  dmarket._test.setRequestDelayForTests(0);

  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse({
        objects: [
          {
            title: "First",
            status: "active",
            instantPrice: { USD: "450" }
          }
        ]
      });
    }
    return jsonResponse({}, 429, { "ratelimit-reset": "120" });
  };

  try {
    const alternate = await dmarket._test.requestPrice("First", {
      forceRefresh: true
    });
    assert.equal(alternate.priceNumber, 4.5);
    assert.equal(alternate.parsedRawPriceField, "instantPrice.USD=450");

    const limited = await dmarket._test.requestPrice("Second", {
      forceRefresh: true
    });
    assert.match(limited.error, /429/);
    assert.ok(dmarket.getRuntimeStatus().pausedUntil > Date.now());

    const paused = await dmarket._test.requestPrice("Third", {
      forceRefresh: true
    });
    assert.match(paused.error, /paused/);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
    dmarket._test.reset();
  }
});

test("DMarket defers the next request when response headers report no remaining capacity", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  dmarket._test.reset();
  dmarket._test.setRequestDelayForTests(0);

  global.fetch = async () => {
    calls += 1;
    return jsonResponse(
      {
        objects: [
          { title: "First", status: "active", price: { USD: "100" } }
        ]
      },
      200,
      {
        "x-ratelimit-remaining-second": "0",
        "ratelimit-reset": "30"
      }
    );
  };

  try {
    const first = await dmarket._test.requestPrice("First", {
      forceRefresh: true
    });
    assert.equal(first.success, true);

    const paused = await dmarket._test.requestPrice("Second", {
      forceRefresh: true
    });
    assert.match(paused.error, /paused/);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
    dmarket._test.reset();
  }
});

test("DMarket-only refresh merges its current quote with existing market quotes", async () => {
  const originalFetch = global.fetch;
  dmarket._test.reset();
  dmarket._test.setRequestDelayForTests(0);

  global.fetch = async () =>
    jsonResponse({
      objects: [
        {
          title: "AK-47 | Redline (Field-Tested)",
          status: "active",
          price: { USD: "900" }
        }
      ]
    });

  try {
    const [priced] = await priceInventoryItems(
      [
        {
          market_hash_name: "AK-47 | Redline (Field-Tested)",
          marketable: 1,
          providerPrices: [
            {
              providerId: "steam-community",
              providerName: "Steam Community Market",
              success: true,
              priceNumber: 10,
              priceText: "$10.00"
            }
          ]
        }
      ],
      {
        providerIds: ["dmarket"],
        currency: 1,
        concurrency: 1,
        forceRefresh: true
      }
    );

    assert.equal(priced.providerPrices.length, 2);
    assert.equal(priced.bestPriceProviderId, "dmarket");
    assert.equal(priced.bestPrice, 9);
  } finally {
    global.fetch = originalFetch;
    dmarket._test.reset();
  }
});
