const fs = require("fs");
const path = require("path");
const marketConfig = require("../marketConfig");

const SETTINGS_FILENAME = "settings.json";
const steamConfig = marketConfig.find((market) => market.id === "steam-community");
const csfloatConfig = marketConfig.find((market) => market.id === "csfloat");
const dmarketConfig = marketConfig.find((market) => market.id === "dmarket");
const DEFAULT_STEAM_REFRESH_INTERVAL_MS = steamConfig.defaultRefreshIntervalMs;
const MIN_CSFLOAT_REFRESH_INTERVAL_MS = csfloatConfig.minimumRefreshIntervalMs;
const DEFAULT_CSFLOAT_REFRESH_INTERVAL_MS = csfloatConfig.defaultRefreshIntervalMs;
const MIN_DMARKET_REFRESH_INTERVAL_MS = dmarketConfig.minimumRefreshIntervalMs;
const DEFAULT_DMARKET_REFRESH_INTERVAL_MS = dmarketConfig.defaultRefreshIntervalMs;
const DEFAULT_DMARKET_SELLER_FEE_PERCENT = dmarketConfig.defaultSellerFeePercent;
const SECRET_KEYS = ["csfloatApiKey", "steamWebApiKey"];

function normalizeRefreshIntervalMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CSFLOAT_REFRESH_INTERVAL_MS;
  }

  return Math.max(MIN_CSFLOAT_REFRESH_INTERVAL_MS, Math.round(parsed));
}

function normalizeSteamRefreshIntervalMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_STEAM_REFRESH_INTERVAL_MS;
  }

  return Math.max(steamConfig.minimumRefreshIntervalMs, Math.round(parsed));
}

function normalizeDmarketRefreshIntervalMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DMARKET_REFRESH_INTERVAL_MS;
  }

  return Math.max(MIN_DMARKET_REFRESH_INTERVAL_MS, Math.round(parsed));
}

function normalizeDmarketSellerFeePercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DMARKET_SELLER_FEE_PERCENT;
  }

  return Math.min(100, Math.max(0, parsed));
}

function normalizeMiniWindowBounds(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const width = Number(value.width);
  const height = Number(value.height);
  const normalized = {
    width: Number.isFinite(width) ? Math.max(280, Math.round(width)) : 340,
    height: Number.isFinite(height) ? Math.max(175, Math.round(height)) : 220
  };
  const x = Number(value.x);
  const y = Number(value.y);

  if (Number.isFinite(x)) normalized.x = Math.round(x);
  if (Number.isFinite(y)) normalized.y = Math.round(y);
  return normalized;
}

class SettingsStore {
  constructor({ baseDir, safeStorageApi, fsApi = fs }) {
    this.filePath = path.join(baseDir, SETTINGS_FILENAME);
    this.safeStorageApi = safeStorageApi;
    this.fsApi = fsApi;
    this.data = null;
  }

  canSecurelyStoreSecrets() {
    try {
      return Boolean(
        this.safeStorageApi &&
        this.safeStorageApi.isEncryptionAvailable() &&
        typeof this.safeStorageApi.encryptString === "function" &&
        typeof this.safeStorageApi.decryptString === "function"
      );
    } catch (_error) {
      return false;
    }
  }

  load() {
    if (this.data) {
      return this.data;
    }

    try {
      const parsed = JSON.parse(this.fsApi.readFileSync(this.filePath, "utf8"));
      this.data = parsed && typeof parsed === "object" ? parsed : {};
    } catch (_error) {
      this.data = {};
    }

    this.data.version = 1;
    this.data.preferences = this.data.preferences || {};
    this.data.secrets = this.data.secrets || {};
    this.data.preferences.steamCommunityRefreshIntervalMs =
      normalizeSteamRefreshIntervalMs(
        this.data.preferences.steamCommunityRefreshIntervalMs
      );
    this.data.preferences.csfloatRefreshIntervalMs = normalizeRefreshIntervalMs(
      this.data.preferences.csfloatRefreshIntervalMs
    );
    this.data.preferences.dmarketRefreshIntervalMs =
      normalizeDmarketRefreshIntervalMs(
        this.data.preferences.dmarketRefreshIntervalMs
      );
    this.data.preferences.dmarketSellerFeePercent =
      normalizeDmarketSellerFeePercent(
        this.data.preferences.dmarketSellerFeePercent
      );
    this.data.preferences.miniWindowBounds = normalizeMiniWindowBounds(
      this.data.preferences.miniWindowBounds
    );
    return this.data;
  }

  save() {
    const settings = this.load();
    this.fsApi.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fsApi.writeFileSync(
      this.filePath,
      JSON.stringify(settings, null, 2),
      "utf8"
    );
  }

  hasSecret(key) {
    const record = this.load().secrets[key];
    return Boolean(record && record.encryptedValue);
  }

  getSecret(key) {
    const record = this.load().secrets[key];
    if (!record || !record.encryptedValue || !this.canSecurelyStoreSecrets()) {
      return "";
    }

    try {
      return this.safeStorageApi.decryptString(
        Buffer.from(record.encryptedValue, "base64")
      );
    } catch (_error) {
      return "";
    }
  }

  setSecret(key, value) {
    if (!SECRET_KEYS.includes(key)) {
      throw new Error("Unknown secret setting.");
    }

    const normalized = String(value || "").trim();
    if (!normalized) {
      return false;
    }

    if (!this.canSecurelyStoreSecrets()) {
      throw new Error(
        "Secure local storage is unavailable. The API key was not saved."
      );
    }

    const encrypted = this.safeStorageApi.encryptString(normalized);
    this.load().secrets[key] = {
      encryptedValue: encrypted.toString("base64")
    };
    return true;
  }

  clearSecret(key) {
    if (!SECRET_KEYS.includes(key)) {
      throw new Error("Unknown secret setting.");
    }

    const settings = this.load();
    const existed = Boolean(settings.secrets[key]);
    delete settings.secrets[key];
    return existed;
  }

  update(updates = {}) {
    let changed = false;

    if (updates.steamCommunityRefreshIntervalMs != null) {
      this.load().preferences.steamCommunityRefreshIntervalMs =
        normalizeSteamRefreshIntervalMs(updates.steamCommunityRefreshIntervalMs);
      changed = true;
    }

    if (updates.csfloatRefreshIntervalMs != null) {
      this.load().preferences.csfloatRefreshIntervalMs = normalizeRefreshIntervalMs(
        updates.csfloatRefreshIntervalMs
      );
      changed = true;
    }

    if (updates.dmarketRefreshIntervalMs != null) {
      this.load().preferences.dmarketRefreshIntervalMs =
        normalizeDmarketRefreshIntervalMs(updates.dmarketRefreshIntervalMs);
      changed = true;
    }

    if (updates.dmarketSellerFeePercent != null) {
      this.load().preferences.dmarketSellerFeePercent =
        normalizeDmarketSellerFeePercent(updates.dmarketSellerFeePercent);
      changed = true;
    }

    for (const key of SECRET_KEYS) {
      const clearKey = `clear${key[0].toUpperCase()}${key.slice(1)}`;
      if (updates[clearKey] === true) {
        changed = this.clearSecret(key) || changed;
      } else if (String(updates[key] || "").trim()) {
        changed = this.setSecret(key, updates[key]) || changed;
      }
    }

    if (changed) {
      this.save();
    }

    return this.getRendererSettings();
  }

  getMiniWindowBounds() {
    return normalizeMiniWindowBounds(this.load().preferences.miniWindowBounds);
  }

  setMiniWindowBounds(bounds) {
    const normalized = normalizeMiniWindowBounds(bounds);
    if (!normalized) return;
    this.load().preferences.miniWindowBounds = normalized;
    this.save();
  }

  getRendererSettings() {
    const settings = this.load();
    return {
      secureStorageAvailable: this.canSecurelyStoreSecrets(),
      csfloatApiKeyConfigured:
        this.canSecurelyStoreSecrets() && this.hasSecret("csfloatApiKey"),
      steamWebApiKeyConfigured:
        this.canSecurelyStoreSecrets() && this.hasSecret("steamWebApiKey"),
      steamCommunityRefreshIntervalMs: normalizeSteamRefreshIntervalMs(
        settings.preferences.steamCommunityRefreshIntervalMs
      ),
      csfloatRefreshIntervalMs: normalizeRefreshIntervalMs(
        settings.preferences.csfloatRefreshIntervalMs
      ),
      dmarketRefreshIntervalMs: normalizeDmarketRefreshIntervalMs(
        settings.preferences.dmarketRefreshIntervalMs
      ),
      dmarketSellerFeePercent: normalizeDmarketSellerFeePercent(
        settings.preferences.dmarketSellerFeePercent
      )
    };
  }
}

module.exports = {
  SettingsStore,
  DEFAULT_STEAM_REFRESH_INTERVAL_MS,
  DEFAULT_CSFLOAT_REFRESH_INTERVAL_MS,
  DEFAULT_DMARKET_REFRESH_INTERVAL_MS,
  DEFAULT_DMARKET_SELLER_FEE_PERCENT,
  MIN_CSFLOAT_REFRESH_INTERVAL_MS,
  MIN_DMARKET_REFRESH_INTERVAL_MS,
  normalizeRefreshIntervalMs,
  normalizeSteamRefreshIntervalMs,
  normalizeDmarketRefreshIntervalMs,
  normalizeDmarketSellerFeePercent,
  normalizeMiniWindowBounds
};
