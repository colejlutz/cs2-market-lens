const CS2_APPID = 730;
const CS2_CONTEXTID = 2;
const INVENTORY_PAGE_SIZE = 2500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildInventoryUrl(steamId64, startAssetId = null) {
  const params = new URLSearchParams({
    l: "english",
    count: String(INVENTORY_PAGE_SIZE)
  });

  if (startAssetId) {
    params.set("start_assetid", String(startAssetId));
  }

  return `https://steamcommunity.com/inventory/${steamId64}/${CS2_APPID}/${CS2_CONTEXTID}?${params}`;
}

function buildBaseInventoryUrl(steamId64) {
  return buildInventoryUrl(steamId64);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200)}`
    );
  }

  return await response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "application/json,text/plain,*/*"
    },
    redirect: "follow"
  });

  if (response.status === 400) {
    throw new Error("Steam inventory returned 400. SteamID64 may be invalid or the inventory request was malformed.");
  }

  if (response.status === 403) {
    throw new Error("Steam inventory returned 403. Inventory may be private, SteamID64 may be invalid, or Steam may be blocking the request.");
  }

  if (response.status === 429) {
    throw new Error("Steam inventory returned 429. Rate limited by Steam.");
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(
      `Steam inventory request failed with HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200)}`
    );
    error.code = response.status;
    throw error;
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    const error = new Error(
      `Steam returned non-JSON response (likely rate limit / private inventory). Status ${response.status}. Body: ${text.slice(
        0,
        200
      )}`
    );
    error.code = response.status || 429;
    throw error;
  }

  return await response.json();
}

function normalizeSteamInput(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("Enter a SteamID64, vanity name, or Steam community profile URL.");
  }

  const profilesMatch = raw.match(/steamcommunity\.com\/profiles\/(\d{16,20})/i);
  if (profilesMatch) {
    return {
      kind: "steamId64",
      value: profilesMatch[1],
      original: raw
    };
  }

  if (/^\d{16,20}$/.test(raw)) {
    return {
      kind: "steamId64",
      value: raw,
      original: raw
    };
  }

  const vanityUrlMatch = raw.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
  if (vanityUrlMatch) {
    return {
      kind: "vanity",
      value: vanityUrlMatch[1],
      original: raw
    };
  }

  const cleanedVanity = raw
    .replace(/^https?:\/\//i, "")
    .replace(/^steamcommunity\.com\/id\//i, "")
    .replace(/^@/, "")
    .replace(/^\/+|\/+$/g, "")
    .split(/[?#]/)[0]
    .trim();

  if (!cleanedVanity) {
    throw new Error("Unable to understand that Steam profile input.");
  }

  return {
    kind: "vanity",
    value: cleanedVanity,
    original: raw
  };
}

function parseSteamProfileXml(xmlText) {
  if (!xmlText || typeof xmlText !== "string") {
    return {
      steamId64: null,
      displayName: null
    };
  }

  if (/The specified profile could not be found\./i.test(xmlText)) {
    return {
      steamId64: null,
      displayName: null
    };
  }

  const steamId64Match =
    xmlText.match(/<steamID64><!\[CDATA\[(\d{16,20})\]\]><\/steamID64>/i) ||
    xmlText.match(/<steamID64>(\d{16,20})<\/steamID64>/i);

  const displayNameMatch =
    xmlText.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/i) ||
    xmlText.match(/<steamID>(.*?)<\/steamID>/i);

  return {
    steamId64: steamId64Match ? steamId64Match[1] : null,
    displayName: displayNameMatch ? displayNameMatch[1].trim() : null
  };
}

async function fetchProfileInfoByVanity(vanityName) {
  const encodedName = encodeURIComponent(String(vanityName || "").trim());
  if (!encodedName) {
    throw new Error("Steam vanity name is empty.");
  }

  const xmlUrl = `https://steamcommunity.com/id/${encodedName}/?xml=1`;
  const xmlText = await fetchText(xmlUrl);
  const parsed = parseSteamProfileXml(xmlText);

  if (!parsed.steamId64) {
    throw new Error(`Steam profile "${vanityName}" was not found.`);
  }

  return parsed;
}

async function fetchProfileInfoBySteamId64(steamId64) {
  const normalizedId = String(steamId64 || "").trim();
  if (!/^\d{16,20}$/.test(normalizedId)) {
    throw new Error("Invalid SteamID64.");
  }

  const xmlUrl = `https://steamcommunity.com/profiles/${normalizedId}/?xml=1`;
  const xmlText = await fetchText(xmlUrl);
  const parsed = parseSteamProfileXml(xmlText);

  if (!parsed.steamId64) {
    throw new Error(`Steam profile "${steamId64}" was not found.`);
  }

  return parsed;
}

async function resolveSteamIdentifier(input) {
  const normalized = normalizeSteamInput(input);

  if (normalized.kind === "steamId64") {
    const profileInfo = await fetchProfileInfoBySteamId64(normalized.value);

    return {
      steamId64: profileInfo.steamId64,
      inputType: "steamId64",
      inputValue: normalized.original,
      vanityName: null,
      displayName: profileInfo.displayName || null
    };
  }

  const profileInfo = await fetchProfileInfoByVanity(normalized.value);

  return {
    steamId64: profileInfo.steamId64,
    inputType: "vanity",
    inputValue: normalized.original,
    vanityName: normalized.value,
    displayName: profileInfo.displayName || null
  };
}

async function fetchCs2Inventory(steamId64, sleepMs = 3000) {
  const allAssets = [];
  const descriptionMap = new Map();
  const allAssetProperties = [];

  let startAssetId = null;

  while (true) {
    const url = buildInventoryUrl(steamId64, startAssetId);
    const data = await fetchJson(url);

    if (!data || (data.success !== 1 && data.success !== true)) {
      throw new Error(
        `Steam inventory response was not successful: ${JSON.stringify(data)}`
      );
    }

    const assets = data.assets || [];
    const descriptions = data.descriptions || [];
    const assetProperties = data.asset_properties || [];

    for (const asset of assets) {
      allAssets.push(asset);
    }

    for (const description of descriptions) {
      const key = `${String(description.classid)}_${String(description.instanceid)}`;
      descriptionMap.set(key, description);
    }

    for (const assetProperty of assetProperties) {
      allAssetProperties.push(assetProperty);
    }

    const hasMore = Boolean(data.more_items);
    const lastAssetId = data.last_assetid ? String(data.last_assetid) : null;

    if (hasMore && lastAssetId) {
      startAssetId = lastAssetId;
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      continue;
    }

    break;
  }

  return {
    success: 1,
    assets: allAssets,
    descriptions: Array.from(descriptionMap.values()),
    asset_properties: allAssetProperties
  };
}

async function fetchAllInventory(steamId64, sleepMs = 3000) {
  return fetchCs2Inventory(steamId64, sleepMs);
}

module.exports = {
  CS2_APPID,
  CS2_CONTEXTID,
  INVENTORY_PAGE_SIZE,
  buildInventoryUrl,
  buildBaseInventoryUrl,
  fetchText,
  fetchJson,
  normalizeSteamInput,
  resolveSteamIdentifier,
  fetchCs2Inventory,
  fetchAllInventory
};
