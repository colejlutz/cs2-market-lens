const assert = require("node:assert/strict");
const test = require("node:test");

const csfloat = require("../priceProviders/csfloat");
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

test("buildListingSearchUrl creates the CSFloat buy_now lowest price lookup", () => {
  const url = new URL(
    csfloat._test.buildListingSearchUrl("AK-47 | Redline (Field-Tested)", 5)
  );

  assert.equal(url.origin, "https://csfloat.com");
  assert.equal(url.pathname, "/api/v1/listings");
  assert.equal(url.searchParams.get("market_hash_name"), "AK-47 | Redline (Field-Tested)");
  assert.equal(url.searchParams.get("sort_by"), "lowest_price");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(url.searchParams.get("type"), "buy_now");
});

test("CSFloat sends the saved key as Authorization and converts listing cents to USD", async () => {
  const originalFetch = global.fetch;
  let request = null;
  csfloat._test.reset();
  csfloat._test.setRequestDelayForTests(0);

  global.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse(
      [
        { id: "expensive", price: 1299 },
        { id: "lowest", price: 1050 }
      ],
      200,
      { "x-ratelimit-remaining": "99" }
    );
  };

  try {
    const result = await csfloat.testConnection("secret-api-key");

    assert.equal(request.options.headers.Authorization, "secret-api-key");
    assert.equal(new URL(request.url).searchParams.get("limit"), "5");
    assert.equal(result.success, true);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.lowestRawCents, 1050);
    assert.equal(result.priceNumber, 10.5);
    assert.equal(result.listingId, "lowest");
    assert.equal(result.externalUrl, "https://csfloat.com/item/lowest");
    assert.equal(result.rateLimitHeaders["x-ratelimit-remaining"], "99");
    assert.equal(result.raw, null);
  } finally {
    global.fetch = originalFetch;
    csfloat._test.reset();
  }
});

test("CSFloat reports unauthenticated listing search and backs off after HTTP 429", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  csfloat._test.reset();
  csfloat._test.setRequestDelayForTests(0);

  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse(
        { code: 1, message: "You need to be logged in to search listings" },
        200
      );
    }
    return jsonResponse({}, 429, { "retry-after": "120" });
  };

  try {
    const notLoggedIn = await csfloat._test.requestPrice("First", "bad-key", {
      forceRefresh: true
    });
    assert.match(notLoggedIn.error, /logged in/);
    assert.equal(notLoggedIn.httpStatus, 200);

    const rejectedAgain = await csfloat._test.requestPrice("Another", "bad-key", {
      forceRefresh: true
    });
    assert.match(rejectedAgain.error, /rejected/);
    assert.equal(calls, 1);

    const limited = await csfloat._test.requestPrice("Second", "key", {
      forceRefresh: true
    });
    assert.match(limited.error, /429/);
    assert.ok(csfloat.getRuntimeStatus().pausedUntil > Date.now());

    const paused = await csfloat._test.requestPrice("Third", "key", {
      forceRefresh: true
    });
    assert.match(paused.error, /paused/);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
    csfloat._test.reset();
  }
});

test("CSFloat-only refresh merges its updated quote with an existing Steam quote", async () => {
  const originalFetch = global.fetch;
  csfloat._test.reset();
  csfloat._test.setRequestDelayForTests(0);

  global.fetch = async () => jsonResponse([{ id: "csfloat-low", price: 900 }]);

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
        providerIds: ["csfloat"],
        csfloatApiKey: "saved-key",
        currency: 1,
        concurrency: 1,
        forceRefresh: true
      }
    );

    assert.equal(priced.providerPrices.length, 2);
    assert.equal(priced.bestPriceProviderId, "csfloat");
    assert.equal(priced.bestPrice, 9);
  } finally {
    global.fetch = originalFetch;
    csfloat._test.reset();
  }
});
