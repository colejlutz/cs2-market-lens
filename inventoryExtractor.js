function tagMap(desc) {
  const out = {};
  const tags = desc.tags || [];

  for (const tag of tags) {
    if (tag && tag.category) {
      out[tag.category] = tag;
    }
  }

  return out;
}

const WEAPON_TYPE_INTERNAL_PREFIXES = new Set([
  "CSGO_Type_Rifle",
  "CSGO_Type_Pistol",
  "CSGO_Type_SniperRifle",
  "CSGO_Type_SMG",
  "CSGO_Type_Shotgun",
  "CSGO_Type_Machinegun",
  "CSGO_Type_Knife"
]);

function classifyItem(desc) {
  const tm = tagMap(desc);
  const typeInternal =
    tm.Type && tm.Type.internal_name ? tm.Type.internal_name : "";

  const weaponInternalEarly =
    tm.Weapon && tm.Weapon.internal_name ? tm.Weapon.internal_name : "";

  if (
    typeInternal === "CSGO_Type_C4" ||
    weaponInternalEarly === "weapon_c4" ||
    (desc.market_hash_name || desc.market_name) === "C4 Explosive"
  ) {
    return null;
  }

  if (typeInternal === "Type_Hands") return "glove";
  if (typeInternal === "Type_CustomPlayer") return "agent";

  if (
    typeInternal.includes("Sticker") ||
    typeInternal === "CSGO_Type_Sticker" ||
    typeInternal === "CSGO_Tool_Sticker"
  ) {
    return "sticker";
  }

  if (
    typeInternal === "CSGO_Type_WeaponCase" ||
    typeInternal === "CSGO_Type_Container" ||
    typeInternal === "CSGO_Type_Case"
  ) {
    return "case";
  }

  const market = desc.market_hash_name || desc.market_name || "";
  if (
    (market.includes("Case") ||
      market.includes("Capsule") ||
      market.includes("Container") ||
      market.includes("Crate") ||
      market.includes("Package")) &&
    !market.includes(" | ")
  ) {
    return "case";
  }

  if (WEAPON_TYPE_INTERNAL_PREFIXES.has(typeInternal)) return "weapon";

  const weaponInternal =
    tm.Weapon && tm.Weapon.internal_name ? tm.Weapon.internal_name : "";
  if (
    typeInternal === "CSGO_Type_Equipment" &&
    weaponInternal === "weapon_taser"
  ) {
    return "weapon";
  }

  if (weaponInternal.startsWith("weapon_")) return "weapon";

  return null;
}

function getDescField(desc, name) {
  const entries = desc.descriptions || [];

  for (const entry of entries) {
    if (entry && entry.name === name) {
      return entry.value || "";
    }
  }

  return "";
}

function getDescValue(desc, fieldName) {
  const entries = desc?.descriptions || [];

  for (const entry of entries) {
    if (entry?.name === fieldName) {
      return entry.value;
    }
  }

  return null;
}

function parseAppliedFromHtml(html, kind) {
  if (!html || typeof html !== "string") return [];

  const imgTags = html.match(/<img\s+[^>]*>/gi) || [];
  const out = [];

  for (const tag of imgTags) {
    const src = tag.match(/src="([^"]+)"/i)?.[1] ?? null;
    const title = tag.match(/title="([^"]+)"/i)?.[1] ?? null;

    let name = null;
    if (title) {
      const prefix = new RegExp(`^${kind}:\\s*`, "i");
      name = title.replace(prefix, "").trim();
    }

    if (src || name) {
      out.push({
        name: name || kind,
        image: src || null
      });
    }
  }

  return out;
}

function parseStickersFromHtml(stickerInfoHtml) {
  if (!stickerInfoHtml) return [];

  const titles = [...stickerInfoHtml.matchAll(/title="Sticker:\s*([^"]+)"/g)]
    .map((match) => (match[1] || "").trim())
    .filter(Boolean);

  if (titles.length) return titles;

  const fallbackMatch = stickerInfoHtml.match(/Sticker:\s*([^<]+)/);
  if (fallbackMatch && fallbackMatch[1]) {
    return fallbackMatch[1]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return [];
}

function buildFloatAndPatternMaps(inv) {
  const floatMap = new Map();
  const patternMap = new Map();

  const assetPropertyEntries = inv.asset_properties || [];
  for (const entry of assetPropertyEntries) {
    const assetid = String(entry.assetid || "");
    const properties = entry.asset_properties || [];

    for (const property of properties) {
      if (!property || !property.name) continue;

      if (property.name === "Wear Rating" && property.float_value != null) {
        const value = Number(property.float_value);
        if (!Number.isNaN(value)) {
          floatMap.set(assetid, value);
        }
      }

      if (property.name === "Pattern Template" && property.int_value != null) {
        const value = Number(property.int_value);
        if (!Number.isNaN(value)) {
          patternMap.set(assetid, Math.trunc(value));
        }
      }
    }
  }

  return { floatMap, patternMap };
}

function iconUrlToImageUrl(iconUrl, width = 330, height = 192) {
  if (!iconUrl) return null;

  return `https://community.cloudflare.steamstatic.com/economy/image/${iconUrl}/${width}x${height}?allow_animated=1`;
}

function iconUrlToSteamCdnUrl(iconUrl) {
  if (!iconUrl) return null;

  return `https://community.cloudflare.steamstatic.com/economy/image/${iconUrl}`;
}

function normalizeInventoryItems(inventory) {
  const descMap = new Map();

  for (const desc of inventory?.descriptions || []) {
    descMap.set(`${String(desc.classid)}_${String(desc.instanceid)}`, desc);
  }

  return (inventory?.assets || [])
    .map((asset) => {
      const desc = descMap.get(
        `${String(asset.classid)}_${String(asset.instanceid)}`
      );

      if (!desc) return null;

      return {
        assetid: String(asset.assetid || ""),
        classid: String(asset.classid || ""),
        instanceid: String(asset.instanceid || ""),
        market_hash_name: desc.market_hash_name || null,
        name: desc.name || null,
        type: desc.type || null,
        tradable: desc.tradable ?? null,
        marketable: desc.marketable ?? null,
        icon_url: iconUrlToSteamCdnUrl(desc.icon_url)
      };
    })
    .filter(Boolean);
}

function extractItems(inv) {
  const assets = inv.assets || [];
  const descriptions = inv.descriptions || [];

  const descMap = new Map();
  for (const description of descriptions) {
    const key = `${String(description.classid)}_${String(description.instanceid)}`;
    descMap.set(key, description);
  }

  const { floatMap, patternMap } = buildFloatAndPatternMaps(inv);
  const out = [];

  for (const asset of assets) {
    const key = `${String(asset.classid)}_${String(asset.instanceid)}`;
    const description = descMap.get(key);
    if (!description) continue;

    const kind = classifyItem(description);
    if (!kind) continue;

    const tm = tagMap(description);
    const assetid = String(asset.assetid || "");

    const stickerInfo = getDescField(description, "sticker_info");
    const appliedStickers = parseStickersFromHtml(stickerInfo);

    const stickerHtml = getDescValue(description, "sticker_info");
    const keychainHtml = getDescValue(description, "keychain_info");

    const stickers = parseAppliedFromHtml(stickerHtml, "Sticker");
    const charms = parseAppliedFromHtml(keychainHtml, "Charm");

    out.push({
      assetid,
      classid: String(asset.classid || ""),
      instanceid: String(asset.instanceid || ""),
      amount: Number(asset.amount || 1),
      kind,
      name: String(description.name || ""),
      market_hash_name: String(
        description.market_hash_name || description.market_name || ""
      ),
      type: String(description.type || ""),
      type_name: String(description.type || ""),
      tradable: description.tradable ?? null,
      marketable: description.marketable ?? null,
      market_tradable_restriction:
        description.market_tradable_restriction ?? null,
      market_marketable_restriction:
        description.market_marketable_restriction ?? null,
      cooldown_days:
        description.market_tradable_restriction ??
        description.market_marketable_restriction ??
        null,
      raw_icon_url: description.icon_url ?? null,
      icon_url: iconUrlToSteamCdnUrl(description.icon_url),
      image_url: iconUrlToImageUrl(description.icon_url),
      weapon_internal:
        tm.Weapon && tm.Weapon.internal_name ? tm.Weapon.internal_name : null,
      weapon_name:
        tm.Weapon && tm.Weapon.localized_tag_name
          ? tm.Weapon.localized_tag_name
          : null,
      exterior:
        tm.Exterior && tm.Exterior.localized_tag_name
          ? tm.Exterior.localized_tag_name
          : null,
      rarity:
        tm.Rarity && tm.Rarity.localized_tag_name
          ? tm.Rarity.localized_tag_name
          : null,
      quality:
        tm.Quality && tm.Quality.localized_tag_name
          ? tm.Quality.localized_tag_name
          : null,
      collection:
        tm.ItemSet && tm.ItemSet.localized_tag_name
          ? tm.ItemSet.localized_tag_name
          : null,
      wear_float: floatMap.has(assetid) ? floatMap.get(assetid) : null,
      pattern_template: patternMap.has(assetid)
        ? patternMap.get(assetid)
        : null,
      stickers: stickers.length ? stickers : null,
      charm: charms.length ? charms[0] : null,
      applied_stickers: appliedStickers.length ? appliedStickers : null
    });
  }

  return out;
}

module.exports = {
  normalizeInventoryItems,
  extractItems
};
