const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeInventoryItems } = require("../inventoryExtractor");

test("normalizeInventoryItems joins descriptions by classid_instanceid", () => {
  const items = normalizeInventoryItems({
    assets: [
      { assetid: "1", classid: "10", instanceid: "20" },
      { assetid: "2", classid: "10", instanceid: "21" }
    ],
    descriptions: [
      {
        classid: "10",
        instanceid: "21",
        market_hash_name: "Wrong item for first asset",
        name: "Wrong",
        marketable: 1
      },
      {
        classid: "10",
        instanceid: "20",
        market_hash_name: "AK-47 | Redline (Field-Tested)",
        name: "AK-47 | Redline",
        type: "Covert Rifle",
        tradable: 1,
        marketable: 1,
        icon_url: "apps/730/icons/econ/default_generated.png"
      }
    ]
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].market_hash_name, "AK-47 | Redline (Field-Tested)");
  assert.equal(items[0].type, "Covert Rifle");
  assert.equal(
    items[0].icon_url,
    "https://community.cloudflare.steamstatic.com/economy/image/apps/730/icons/econ/default_generated.png"
  );
});

test("extractItems keeps Zeus x27 skins tagged as equipment plus weapon_taser", () => {
  const { extractItems } = require("../inventoryExtractor");

  const items = extractItems({
    assets: [{ assetid: "45361533365", classid: "7993038457", instanceid: "188530139" }],
    descriptions: [
      {
        classid: "7993038457",
        instanceid: "188530139",
        name: "Zeus x27 | Tosai",
        market_hash_name: "Zeus x27 | Tosai (Field-Tested)",
        type: "Restricted Equipment",
        tradable: 1,
        marketable: 1,
        tags: [
          {
            category: "Type",
            internal_name: "CSGO_Type_Equipment",
            localized_tag_name: "Equipment"
          },
          {
            category: "Weapon",
            internal_name: "weapon_taser",
            localized_tag_name: "Zeus x27"
          }
        ]
      }
    ]
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "weapon");
  assert.equal(items[0].market_hash_name, "Zeus x27 | Tosai (Field-Tested)");
});
