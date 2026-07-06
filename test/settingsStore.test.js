const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SettingsStore,
  DEFAULT_STEAM_REFRESH_INTERVAL_MS,
  DEFAULT_DMARKET_SELLER_FEE_PERCENT,
  MIN_CSFLOAT_REFRESH_INTERVAL_MS,
  MIN_DMARKET_REFRESH_INTERVAL_MS
} = require("../services/settingsStore");

function createMemoryFs() {
  let savedText = null;
  return {
    readFileSync() {
      if (savedText == null) throw new Error("missing");
      return savedText;
    },
    mkdirSync() {},
    writeFileSync(_path, value) {
      savedText = value;
    },
    getSavedText() {
      return savedText;
    }
  };
}

test("SettingsStore encrypts API keys and clamps the CSFloat refresh preference", () => {
  const fsApi = createMemoryFs();
  const safeStorageApi = {
    isEncryptionAvailable() {
      return true;
    },
    encryptString(text) {
      return Buffer.from(`encrypted:${text}`, "utf8");
    },
    decryptString(buffer) {
      return buffer.toString("utf8").replace(/^encrypted:/, "");
    }
  };
  const store = new SettingsStore({
    baseDir: "settings-test",
    safeStorageApi,
    fsApi
  });

  const result = store.update({
    csfloatApiKey: "csfloat-secret",
    steamWebApiKey: "steam-secret",
    steamCommunityRefreshIntervalMs: 420000,
    csfloatRefreshIntervalMs: 1000,
    dmarketRefreshIntervalMs: 1000,
    dmarketSellerFeePercent: 7.5
  });

  assert.equal(result.csfloatApiKeyConfigured, true);
  assert.equal(result.steamWebApiKeyConfigured, true);
  assert.equal(result.steamCommunityRefreshIntervalMs, 420000);
  assert.equal(result.csfloatRefreshIntervalMs, MIN_CSFLOAT_REFRESH_INTERVAL_MS);
  assert.equal(result.dmarketRefreshIntervalMs, MIN_DMARKET_REFRESH_INTERVAL_MS);
  assert.equal(result.dmarketSellerFeePercent, 7.5);
  assert.equal(store.getSecret("csfloatApiKey"), "csfloat-secret");
  assert.doesNotMatch(fsApi.getSavedText(), /csfloat-secret/);
  assert.doesNotMatch(fsApi.getSavedText(), /steam-secret/);

  store.setMiniWindowBounds({ x: 12.3, y: 18.8, width: 200, height: 100 });
  assert.deepEqual(store.getMiniWindowBounds(), {
    x: 12,
    y: 19,
    width: 280,
    height: 175
  });
});

test("SettingsStore supplies the Steam default interval when it has not been configured", () => {
  const store = new SettingsStore({
    baseDir: "settings-test",
    safeStorageApi: null,
    fsApi: createMemoryFs()
  });

  assert.equal(
    store.getRendererSettings().steamCommunityRefreshIntervalMs,
    DEFAULT_STEAM_REFRESH_INTERVAL_MS
  );
  assert.equal(
    store.getRendererSettings().dmarketSellerFeePercent,
    DEFAULT_DMARKET_SELLER_FEE_PERCENT
  );
});
