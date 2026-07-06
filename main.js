const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  safeStorage,
  Tray,
  Menu,
  nativeImage
} = require("electron");
const path = require("path");
const { resolveSteamIdentifier, fetchAllInventory } = require("./steamApi");
const { extractItems } = require("./inventoryExtractor");
const { getEnabledPriceProviders } = require("./priceProviders");
const { priceInventoryItems } = require("./services/pricingService");
const { SettingsStore } = require("./services/settingsStore");
const marketConfig = require("./marketConfig");

const DEFAULT_ENABLED_PROVIDERS = ["steam-community"];
const VALID_UI_MODES = new Set(["dashboard", "mini", "backgroundOnly"]);

let settingsStore = null;
let mainWindow = null;
let miniWindow = null;
let tray = null;
let uiMode = "dashboard";
let isQuitting = false;
let miniBoundsSaveTimer = null;
let trackingTickTimer = null;

const trackingRuntime = {
  result: null,
  enabledProviderIds: [...DEFAULT_ENABLED_PROVIDERS],
  nextRefreshAtById: new Map(),
  lastUpdatedAt: null,
  latestAlert: null,
  topMover: null,
  paused: false,
  refreshInProgress: false,
  refreshingProviderIds: []
};

function getSettingsStore() {
  if (!settingsStore) {
    throw new Error("Settings are not initialized yet.");
  }
  return settingsStore;
}

function getProviderStates() {
  return getEnabledPriceProviders()
    .filter((provider) => typeof provider.getRuntimeStatus === "function")
    .map((provider) => provider.getRuntimeStatus());
}

function getPricingOptions(extraOptions = {}) {
  const store = getSettingsStore();
  return {
    currency: 1,
    country: "US",
    concurrency: 1,
    csfloatApiKey: store.getSecret("csfloatApiKey"),
    steamWebApiKey: store.getSecret("steamWebApiKey"),
    ...extraOptions
  };
}

function sendToWindow(window, channel, payload) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

function getMarketDefinition(id) {
  return marketConfig.find((market) => market.id === id) || null;
}

function sanitizeProviderIds(ids) {
  const configuredIds = new Set(marketConfig.map((market) => market.id));
  const selected = (Array.isArray(ids) ? ids : [])
    .map((id) => String(id))
    .filter((id) => configuredIds.has(id));
  return selected.length ? [...new Set(selected)] : [...DEFAULT_ENABLED_PROVIDERS];
}

function getProviderRefreshIntervalMs(id) {
  const settings = getSettingsStore().getRendererSettings();
  if (id === "steam-community") return settings.steamCommunityRefreshIntervalMs;
  if (id === "csfloat") return settings.csfloatRefreshIntervalMs;
  if (id === "dmarket") return settings.dmarketRefreshIntervalMs;
  return getMarketDefinition(id)?.defaultRefreshIntervalMs || 5 * 60 * 1000;
}

function resetProviderSchedule(ids = trackingRuntime.enabledProviderIds) {
  const selected = new Set(ids);
  const now = Date.now();
  for (const id of trackingRuntime.enabledProviderIds) {
    if (selected.has(id) || !trackingRuntime.nextRefreshAtById.has(id)) {
      trackingRuntime.nextRefreshAtById.set(
        id,
        now + getProviderRefreshIntervalMs(id)
      );
    }
  }
  for (const id of [...trackingRuntime.nextRefreshAtById.keys()]) {
    if (!trackingRuntime.enabledProviderIds.includes(id)) {
      trackingRuntime.nextRefreshAtById.delete(id);
    }
  }
}

function getEnabledBestPrice(item) {
  const values = (Array.isArray(item?.providerPrices) ? item.providerPrices : [])
    .filter(
      (price) =>
        trackingRuntime.enabledProviderIds.includes(price?.providerId) &&
        price?.success === true &&
        Number.isFinite(Number(price.priceNumber))
    )
    .map((price) => Number(price.priceNumber));
  return values.length ? Math.min(...values) : null;
}

function getPortfolioValue(items) {
  return (Array.isArray(items) ? items : []).reduce((total, item) => {
    const price = getEnabledBestPrice(item);
    const amount = Math.max(1, Number(item?.amount || 1));
    return Number.isFinite(price) ? total + price * amount : total;
  }, 0);
}

function findTopMover(previousItems, currentItems) {
  const previousPrices = new Map();
  for (const item of Array.isArray(previousItems) ? previousItems : []) {
    const price = getEnabledBestPrice(item);
    const name = String(item?.market_hash_name || "").trim();
    if (name && Number.isFinite(price) && !previousPrices.has(name)) {
      previousPrices.set(name, price);
    }
  }

  let topMover = null;
  for (const item of Array.isArray(currentItems) ? currentItems : []) {
    const name = String(item?.market_hash_name || "").trim();
    const current = getEnabledBestPrice(item);
    const previous = previousPrices.get(name);
    if (!name || !Number.isFinite(current) || !Number.isFinite(previous)) continue;

    const delta = current - previous;
    if (delta === 0) continue;
    if (!topMover || Math.abs(delta) > Math.abs(topMover.delta)) {
      topMover = {
        marketHashName: name,
        delta,
        percent: previous > 0 ? (delta / previous) * 100 : null
      };
    }
  }
  return topMover;
}

function getTrackingSummary() {
  const items = trackingRuntime.result?.extracted || [];
  const providerStates = new Map(
    getProviderStates().map((state) => [state.id, state])
  );
  return {
    uiMode,
    paused: trackingRuntime.paused,
    hasTracking: Boolean(trackingRuntime.result),
    trackedItems: items.reduce(
      (count, item) => count + Math.max(1, Number(item?.amount || 1)),
      0
    ),
    portfolioValue: trackingRuntime.result ? getPortfolioValue(items) : null,
    latestAlert: trackingRuntime.latestAlert,
    topMover: trackingRuntime.topMover,
    lastUpdatedAt: trackingRuntime.lastUpdatedAt,
    refreshingProviderIds: [...trackingRuntime.refreshingProviderIds],
    providers: trackingRuntime.enabledProviderIds.map((id) => {
      const state = providerStates.get(id);
      return {
        id,
        name: getMarketDefinition(id)?.name || id,
        pausedUntil: state?.pausedUntil || null,
        rateLimitHeaders: state?.rateLimitHeaders || {}
      };
    })
  };
}

function getTrackingState(refreshedProviderIds = []) {
  return {
    result: trackingRuntime.result,
    enabledProviderIds: [...trackingRuntime.enabledProviderIds],
    paused: trackingRuntime.paused,
    lastUpdatedAt: trackingRuntime.lastUpdatedAt,
    refreshedProviderIds,
    nextRefreshAtById: Object.fromEntries(trackingRuntime.nextRefreshAtById)
  };
}

function broadcastTrackingSummary() {
  sendToWindow(miniWindow, "tracking:summary", getTrackingSummary());
}

function broadcastTrackingUpdate(refreshedProviderIds = []) {
  if (uiMode === "dashboard" && mainWindow?.isVisible()) {
    sendToWindow(mainWindow, "tracking:updated", getTrackingState(refreshedProviderIds));
  }
  broadcastTrackingSummary();
}

function emitUiModeChanged() {
  const state = { mode: uiMode, trackingPaused: trackingRuntime.paused };
  sendToWindow(mainWindow, "appWindow:uiModeChanged", state);
  sendToWindow(miniWindow, "appWindow:uiModeChanged", state);
  broadcastTrackingSummary();
}

function setUiMode(mode) {
  if (!VALID_UI_MODES.has(mode)) return;
  uiMode = mode;
  emitUiModeChanged();
}

function applyWindowsAcrylic(window) {
  if (
    process.platform === "win32" &&
    typeof window.setBackgroundMaterial === "function"
  ) {
    try {
      window.setBackgroundMaterial("acrylic");
    } catch (_error) {
      // Ignore unsupported Windows builds.
    }
  }
}

function sharedWebPreferences() {
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  };
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: "#00000000",
    transparent: true,
    frame: false,
    resizable: true,
    webPreferences: sharedWebPreferences()
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  applyWindowsAcrylic(mainWindow);
  mainWindow.webContents.on("did-finish-load", () => {
    emitUiModeChanged();
    if (trackingRuntime.result) {
      sendToWindow(mainWindow, "tracking:updated", getTrackingState());
    }
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (!miniWindow?.isVisible()) setUiMode("backgroundOnly");
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

function saveMiniWindowBoundsSoon() {
  clearTimeout(miniBoundsSaveTimer);
  miniBoundsSaveTimer = setTimeout(() => {
    if (!miniWindow || miniWindow.isDestroyed()) return;
    getSettingsStore().setMiniWindowBounds(miniWindow.getBounds());
  }, 180);
}

function createMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) return miniWindow;

  const savedBounds = getSettingsStore().getMiniWindowBounds() || {
    width: 340,
    height: 220
  };
  miniWindow = new BrowserWindow({
    ...savedBounds,
    width: savedBounds.width,
    height: savedBounds.height,
    minWidth: 280,
    minHeight: 175,
    backgroundColor: "#0c1320",
    transparent: true,
    frame: false,
    show: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: false,
    webPreferences: sharedWebPreferences()
  });

  miniWindow.loadFile(path.join(__dirname, "renderer", "mini.html"));
  applyWindowsAcrylic(miniWindow);
  miniWindow.webContents.on("did-finish-load", () => {
    emitUiModeChanged();
  });
  miniWindow.on("move", saveMiniWindowBoundsSoon);
  miniWindow.on("resize", saveMiniWindowBoundsSoon);
  miniWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    miniWindow.hide();
    if (!mainWindow?.isVisible()) setUiMode("backgroundOnly");
  });
  miniWindow.on("closed", () => {
    miniWindow = null;
  });
  return miniWindow;
}

function enterMiniMode() {
  const widget = createMiniWindow();
  mainWindow?.hide();
  widget.show();
  widget.focus();
  setUiMode("mini");
}

function exitMiniMode() {
  miniWindow?.hide();
  const dashboard = createMainWindow();
  dashboard.show();
  dashboard.focus();
  setUiMode("dashboard");
}

function hideMini() {
  miniWindow?.hide();
  if (!mainWindow?.isVisible()) setUiMode("backgroundOnly");
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Dashboard", click: exitMiniMode },
      { label: "Show Mini Tracker", click: enterMiniMode },
      {
        label: trackingRuntime.paused ? "Resume Tracking" : "Pause Tracking",
        click: toggleTrackingPaused
      },
      { type: "separator" },
      {
        label: "Quit",
        click() {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function createTray() {
  if (tray) return;
  const image = nativeImage
    .createFromPath(path.join(__dirname, "iconcs2.png"))
    .resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip("CS2 Market Lens");
  tray.on("double-click", exitMiniMode);
  refreshTrayMenu();
}

function toggleTrackingPaused() {
  trackingRuntime.paused = !trackingRuntime.paused;
  if (!trackingRuntime.paused) {
    resetProviderSchedule();
  }
  refreshTrayMenu();
  emitUiModeChanged();
  broadcastTrackingSummary();
  return getTrackingSummary();
}

async function refreshTrackedProviders(providerIds, { trackMovement = true } = {}) {
  const requested = sanitizeProviderIds(providerIds).filter((id) =>
    trackingRuntime.enabledProviderIds.includes(id)
  );
  if (
    !requested.length ||
    !trackingRuntime.result ||
    trackingRuntime.paused ||
    trackingRuntime.refreshInProgress
  ) {
    return getTrackingState();
  }

  trackingRuntime.refreshInProgress = true;
  trackingRuntime.refreshingProviderIds = [...requested];
  broadcastTrackingSummary();
  const previousItems = trackingRuntime.result.extracted || [];

  try {
    const pricedExtracted = await priceInventoryItems(
      previousItems,
      getPricingOptions({
        providerIds: requested,
        forceRefresh: true
      })
    );
    trackingRuntime.topMover = trackMovement
      ? findTopMover(previousItems, pricedExtracted)
      : trackingRuntime.topMover;
    trackingRuntime.lastUpdatedAt = Date.now();
    trackingRuntime.result = {
      ...trackingRuntime.result,
      extracted: pricedExtracted,
      providerStates: getProviderStates()
    };
    resetProviderSchedule(requested);
    broadcastTrackingUpdate(requested);
  } catch (error) {
    console.error("[Tracking] Price refresh failed:", error?.message || String(error));
    resetProviderSchedule(requested);
    broadcastTrackingSummary();
  } finally {
    trackingRuntime.refreshInProgress = false;
    trackingRuntime.refreshingProviderIds = [];
    broadcastTrackingSummary();
  }

  return getTrackingState(requested);
}

function startTrackingScheduler() {
  if (trackingTickTimer) clearInterval(trackingTickTimer);
  trackingTickTimer = setInterval(() => {
    if (
      trackingRuntime.paused ||
      trackingRuntime.refreshInProgress ||
      !trackingRuntime.result
    ) {
      return;
    }
    const now = Date.now();
    const dueIds = trackingRuntime.enabledProviderIds.filter(
      (id) => Number(trackingRuntime.nextRefreshAtById.get(id)) <= now
    );
    if (dueIds.length) {
      refreshTrackedProviders(dueIds);
    }
  }, 1000);
}

app.whenReady().then(() => {
  settingsStore = new SettingsStore({
    baseDir: app.getPath("userData"),
    safeStorageApi: safeStorage
  });
  createMainWindow();
  createTray();
  startTrackingScheduler();

  app.on("activate", () => {
    exitMiniMode();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (settingsStore && miniWindow && !miniWindow.isDestroyed()) {
    settingsStore.setMiniWindowBounds(miniWindow.getBounds());
  }
});

app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});

ipcMain.handle("appWindow:enterMiniMode", () => {
  enterMiniMode();
  return { mode: uiMode };
});

ipcMain.handle("appWindow:exitMiniMode", () => {
  exitMiniMode();
  return { mode: uiMode };
});

ipcMain.handle("appWindow:hideMini", () => {
  hideMini();
  return { mode: uiMode };
});

ipcMain.handle("appWindow:quitApp", () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle("tracking:getState", () => getTrackingState());
ipcMain.handle("tracking:getSummary", () => getTrackingSummary());
ipcMain.handle("tracking:togglePaused", () => toggleTrackingPaused());
ipcMain.handle("tracking:setProviders", async (_event, providerIds, refreshIds) => {
  trackingRuntime.enabledProviderIds = sanitizeProviderIds(providerIds);
  resetProviderSchedule();
  broadcastTrackingSummary();
  const requestedRefreshIds = (Array.isArray(refreshIds) ? refreshIds : []).filter(
    (id) => trackingRuntime.enabledProviderIds.includes(String(id))
  );
  if (requestedRefreshIds.length && trackingRuntime.result) {
    return refreshTrackedProviders(requestedRefreshIds, { trackMovement: false });
  }
  return getTrackingState();
});

// Opens a URL in the user's default external browser.
// Only https: URLs are permitted; file:// and javascript: are blocked.
ipcMain.handle("shell:openExternal", async (_event, url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") return;
  await shell.openExternal(url);
});

ipcMain.handle("settings:get", async () => {
  return getSettingsStore().getRendererSettings();
});

ipcMain.handle("settings:save", async (_event, updates) => {
  const result = getSettingsStore().update(updates);
  const csfloatProvider = getEnabledPriceProviders().find(
    (provider) => provider.id === "csfloat"
  );
  if (
    csfloatProvider &&
    typeof csfloatProvider.clearCacheAndBackoff === "function" &&
    (String(updates?.csfloatApiKey || "").trim() || updates?.clearCsfloatApiKey === true)
  ) {
    csfloatProvider.clearCacheAndBackoff();
  }
  resetProviderSchedule();
  broadcastTrackingSummary();
  return result;
});

ipcMain.handle("cs2:testCsfloatConnection", async () => {
  const csfloatProvider = getEnabledPriceProviders().find(
    (provider) => provider.id === "csfloat"
  );
  const apiKey = getSettingsStore().getSecret("csfloatApiKey");

  if (!csfloatProvider || typeof csfloatProvider.testConnection !== "function") {
    throw new Error("CSFloat provider is unavailable.");
  }

  const result = await csfloatProvider.testConnection(apiKey);
  const csfloatMarket = marketConfig.find((market) => market.id === "csfloat");
  const summary = {
    httpStatus: result.httpStatus ?? null,
    httpAuthWorked: result.authWorked === true,
    success: result.authWorked === true,
    listingAvailable: result.success === true,
    error: result.error || null,
    lowestRawCents: result.lowestRawCents ?? null,
    usdPrice: result.priceNumber ?? null,
    postFeeUsdPrice:
      typeof result.priceNumber === "number"
        ? result.priceNumber * csfloatMarket.sellerFeeMultiplier
        : null,
    listingId: result.listingId || null,
    externalUrl: result.externalUrl || null,
    rateLimitHeaders: result.rateLimitHeaders || {}
  };
  console.info("[CSFloat Test] AK-47 | Redline (Field-Tested):", summary);
  broadcastTrackingSummary();
  return summary;
});

ipcMain.handle("cs2:testDmarketConnection", async () => {
  const dmarketProvider = getEnabledPriceProviders().find(
    (provider) => provider.id === "dmarket"
  );
  if (!dmarketProvider || typeof dmarketProvider.testConnection !== "function") {
    throw new Error("DMarket provider is unavailable.");
  }

  const result = await dmarketProvider.testConnection();
  const settings = getSettingsStore().getRendererSettings();
  const sellerFeeMultiplier = 1 - settings.dmarketSellerFeePercent / 100;
  const summary = {
    httpStatus: result.httpStatus ?? null,
    authUsed: result.authUsed === true,
    success: result.success === true,
    error: result.error || null,
    parsedRawPriceField: result.parsedRawPriceField || null,
    lowestRawCents: result.lowestRawCents ?? null,
    usdPrice: result.priceNumber ?? null,
    postFeeUsdPrice:
      typeof result.priceNumber === "number"
        ? result.priceNumber * sellerFeeMultiplier
        : null,
    listingId: result.listingId || null,
    externalUrl: result.externalUrl || null,
    rateLimitHeaders: result.rateLimitHeaders || {}
  };
  console.info("[DMarket Test] AK-47 | Redline (Field-Tested):", summary);
  broadcastTrackingSummary();
  return summary;
});

ipcMain.handle("cs2:pullInventory", async (_event, userInput, providerIds) => {
  const selectedProviderIds = sanitizeProviderIds(providerIds);
  const resolvedProfile = await resolveSteamIdentifier(userInput);
  const rawInventory = await fetchAllInventory(resolvedProfile.steamId64);
  const extracted = extractItems(rawInventory);

  const pricedExtracted = await priceInventoryItems(
    extracted,
    getPricingOptions({ providerIds: selectedProviderIds })
  );

  const priceProviders = getEnabledPriceProviders();
  const result = {
    requestedProfile: String(userInput || "").trim(),
    steamId64: resolvedProfile.steamId64,
    inputType: resolvedProfile.inputType,
    vanityName: resolvedProfile.vanityName,
    displayName: resolvedProfile.displayName,
    totalAssets: rawInventory.assets?.length || 0,
    extractedCount: extracted.length,
    extracted: pricedExtracted,
    providerStates: getProviderStates(),
    priceProviders: priceProviders.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      status: provider.status
    }))
  };

  trackingRuntime.result = result;
  trackingRuntime.enabledProviderIds = selectedProviderIds;
  trackingRuntime.topMover = null;
  trackingRuntime.lastUpdatedAt = Date.now();
  resetProviderSchedule();
  broadcastTrackingSummary();
  return result;
});
