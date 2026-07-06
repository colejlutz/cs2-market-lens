const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildInventoryUrl,
  fetchCs2Inventory,
  INVENTORY_PAGE_SIZE
} = require("../steamApi");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type"
          ? "application/json"
          : "";
      }
    },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}

test("buildInventoryUrl uses the stable CS2 inventory endpoint and count 2500", () => {
  const url = new URL(buildInventoryUrl("76561198000000000"));

  assert.equal(url.origin, "https://steamcommunity.com");
  assert.equal(url.pathname, "/inventory/76561198000000000/730/2");
  assert.equal(url.searchParams.get("l"), "english");
  assert.equal(url.searchParams.get("count"), String(INVENTORY_PAGE_SIZE));
  assert.equal(Number(url.searchParams.get("count")) <= 2500, true);
});

test("fetchCs2Inventory follows more_items pagination with start_assetid", async () => {
  const originalFetch = global.fetch;
  const requestedUrls = [];

  global.fetch = async (url) => {
    requestedUrls.push(url);

    if (requestedUrls.length === 1) {
      return jsonResponse({
        success: 1,
        more_items: true,
        last_assetid: "asset-2",
        assets: [{ assetid: "asset-1", classid: "class-a", instanceid: "0" }],
        descriptions: [{ classid: "class-a", instanceid: "0", name: "A" }]
      });
    }

    return jsonResponse({
      success: 1,
      more_items: false,
      assets: [{ assetid: "asset-2", classid: "class-b", instanceid: "0" }],
      descriptions: [{ classid: "class-b", instanceid: "0", name: "B" }]
    });
  };

  try {
    const inventory = await fetchCs2Inventory("76561198000000000", 0);

    assert.equal(inventory.assets.length, 2);
    assert.equal(inventory.descriptions.length, 2);
    assert.equal(new URL(requestedUrls[1]).searchParams.get("start_assetid"), "asset-2");
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchCs2Inventory reports Steam 403 and 429 clearly", async () => {
  const originalFetch = global.fetch;

  try {
    global.fetch = async () => jsonResponse({ success: false }, 403);
    await assert.rejects(
      () => fetchCs2Inventory("76561198000000000", 0),
      /returned 403/
    );

    global.fetch = async () => jsonResponse({ success: false }, 429);
    await assert.rejects(
      () => fetchCs2Inventory("76561198000000000", 0),
      /returned 429/
    );
  } finally {
    global.fetch = originalFetch;
  }
});
