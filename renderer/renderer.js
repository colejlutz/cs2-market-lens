// ─── Marketplace Definitions ───────────────────────────────────────────────────
const MARKETPLACE_DEFS = window.CS2_MARKET_CONFIG;
const STEAM_REFRESH_INTERVAL_MS = MARKETPLACE_DEFS.find(
  (market) => market.id === "steam-community"
).defaultRefreshIntervalMs;

// ─── App State ─────────────────────────────────────────────────────────────────
let enabledMarketplaceIds = new Set(["steam-community"]);
let usePostFeePrice = false;
let lastRawExtracted = [];
let lastResult = null;
let lastProfileInput = "";
let lastRenderedMap = new Map();
let providerErrorIds = new Set();
let providerStateById = new Map();
let appSettings = null;
let currentUiMode = "dashboard";
let dropdownOpen = false;
let activeModalKind = null;
let activePriceModalItemKey = null;
let expandedSettingsMarketplaceIds = new Set();
let refreshTickIntervalId = null;
let refreshCountdownActive = false;
let refreshInProgress = false;
let refreshInProgressIds = new Set();
let refreshFlashUntilById = new Map();
let marketplaceRefreshIntervalMsById = new Map(
  MARKETPLACE_DEFS.map((m) => [m.id, m.defaultRefreshIntervalMs])
);
let marketplaceRefreshRemainingMsById = new Map(
  MARKETPLACE_DEFS.map((m) => [m.id, m.defaultRefreshIntervalMs])
);

let loadingIntervalId = null;
let loadingDotCount = 1;

// ─── DOM References ────────────────────────────────────────────────────────────
const steamIdEl = document.getElementById("steamid");
const pullBtn = document.getElementById("pull");
const statusEl = document.getElementById("status");
const gridEl = document.getElementById("grid");
const emptyStateEl = document.getElementById("emptyState");
const marketplaceBtnEl = document.getElementById("marketplaceBtn");
const marketplaceBtnArrowEl = document.getElementById("marketplaceBtnArrow");
const marketplaceDropdownEl = document.getElementById("marketplaceDropdown");
const marketplaceListEl = document.getElementById("marketplaceList");
const marketplaceMinErrorEl = document.getElementById("marketplaceMinError");
const marketplaceErrorBadgeEl = document.getElementById("marketplaceErrorBadge");
const marketRefreshBarEl = document.getElementById("marketRefreshBar");
const postFeeToggleEl = document.getElementById("postFeeToggle");
const miniModeBtnEl = document.getElementById("miniModeBtn");
const settingsBtnEl = document.getElementById("settingsBtn");
const modalOverlayEl = document.getElementById("modalOverlay");
const modalBodyEl = document.getElementById("modalBody");
const modalTitleEl = document.getElementById("modalTitle");
const modalCloseEl = document.getElementById("modalClose");

// Make absolutely sure the modal overlay is attached directly to the body so it
// behaves like a true window-level layer over the scrolled inventory area.
if (modalOverlayEl && modalOverlayEl.parentElement !== document.body) {
  document.body.appendChild(modalOverlayEl);
}

// ─── Status Helpers ────────────────────────────────────────────────────────────
function setStatusHtml(html) { statusEl.innerHTML = html; }
function setStatusText(text) { statusEl.textContent = text; }

function setStatusReady() {
  setStatusHtml(
    `<span class="statusReady">Please enter Steam User CS2 Inventory to load above</span>`
  );
}

function startLoadingStatus() {
  stopLoadingStatus();
  loadingDotCount = 1;
  const render = () => {
    setStatusHtml(
      `<span class="statusLoading">Pulling Inventory${".".repeat(loadingDotCount)}</span>`
    );
    loadingDotCount = loadingDotCount >= 3 ? 1 : loadingDotCount + 1;
  };
  render();
  loadingIntervalId = setInterval(render, 450);
}

function stopLoadingStatus() {
  if (loadingIntervalId != null) {
    clearInterval(loadingIntervalId);
    loadingIntervalId = null;
  }
}

// ─── Grid / Empty-State Visibility ────────────────────────────────────────────
function showGrid() { gridEl.classList.remove("gridHidden"); }
function hideGrid() { gridEl.classList.add("gridHidden"); }
function showEmptyState() { emptyStateEl.classList.remove("emptyStateHidden"); }
function hideEmptyState() { emptyStateEl.classList.add("emptyStateHidden"); }

// ─── HTML Escape ───────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getMarketplaceDefinition(id) {
  return MARKETPLACE_DEFS.find((market) => market.id === id) || null;
}

function clampRefreshIntervalMs(ms, id = null) {
  const market = getMarketplaceDefinition(id);
  const fallback = market?.defaultRefreshIntervalMs || STEAM_REFRESH_INTERVAL_MS;
  const minimum = market?.minimumRefreshIntervalMs || 1000;
  return Math.max(minimum, Number(ms) || fallback);
}

function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseDurationInput(value, id = null) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    return clampRefreshIntervalMs(Number(raw) * 1000, id);
  }

  const match = raw.match(/^(\d+)\s*:\s*([0-5]?\d)$/);
  if (!match) return null;

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  return clampRefreshIntervalMs((minutes * 60 + seconds) * 1000, id);
}

function getMarketplaceRefreshIntervalMs(id) {
  return clampRefreshIntervalMs(
    marketplaceRefreshIntervalMsById.get(id),
    id
  );
}

function getMarketplaceRefreshRemainingMs(id) {
  const value = Number(marketplaceRefreshRemainingMsById.get(id));
  return Number.isFinite(value) && value >= 0
    ? value
    : getMarketplaceRefreshIntervalMs(id);
}

// ─── Display-Price Computation ─────────────────────────────────────────────────
function computeDisplayPriceForItemByMode(item, postFeeEnabled = usePostFeePrice) {
  const prices = Array.isArray(item.providerPrices) ? item.providerPrices : [];

  const eligible = prices.filter(
    (p) =>
      p &&
      p.success === true &&
      enabledMarketplaceIds.has(p.providerId) &&
      typeof p.priceNumber === "number" &&
      Number.isFinite(p.priceNumber)
  );

  if (!eligible.length) {
    return { priceNumber: null, priceText: "$0.00", providerId: null };
  }

  const adjusted = eligible.map((price) => {
    const marketDef = getMarketplaceDefinition(price.providerId);
    const priceNumber =
      postFeeEnabled && marketDef?.sellerFeeMultiplier
        ? price.priceNumber * marketDef.sellerFeeMultiplier
        : price.priceNumber;
    return { price, priceNumber };
  });
  adjusted.sort((a, b) => a.priceNumber - b.priceNumber);
  const best = adjusted[0];

  return {
    priceNumber: best.priceNumber,
    priceText: `$${best.priceNumber.toFixed(2)}`,
    providerId: best.price.providerId
  };
}

function computeDisplayPriceForItem(item) {
  return computeDisplayPriceForItemByMode(item, usePostFeePrice);
}

function enrichItems(rawItems, postFeeEnabled = usePostFeePrice) {
  return rawItems.map((item) => {
    const { priceNumber, priceText, providerId } = computeDisplayPriceForItemByMode(item, postFeeEnabled);
    return {
      ...item,
      bestPrice: priceNumber,
      bestPriceText: priceText,
      bestPriceProviderId: providerId
    };
  });
}

// ─── Provider Error Tracking ───────────────────────────────────────────────────
function updateProviderErrors(rawItems) {
  providerErrorIds.clear();
  for (const item of rawItems) {
    for (const p of item.providerPrices || []) {
      if (p && p.success !== true && p.providerId) {
        providerErrorIds.add(p.providerId);
      }
    }
  }

  const hasActiveErrors = [...providerErrorIds].some((id) =>
    enabledMarketplaceIds.has(id)
  );
  marketplaceErrorBadgeEl.classList.toggle("hidden", !hasActiveErrors);

  if (dropdownOpen) renderMarketplaceList();
}

// ─── Marketplace Dropdown ──────────────────────────────────────────────────────
function getMarketplaceRateLimitRemaining(id) {
  const headers = providerStateById.get(id)?.rateLimitHeaders || {};
  const remaining =
    headers["x-ratelimit-remaining-second"] ??
    headers["ratelimit-remaining"] ??
    headers["x-ratelimit-remaining"];

  return remaining == null || remaining === "" ? "--" : String(remaining);
}

function renderMarketplaceList() {
  marketplaceListEl.innerHTML = MARKETPLACE_DEFS.map((m) => {
    const checked = enabledMarketplaceIds.has(m.id) ? "checked" : "";
    const hasError = providerErrorIds.has(m.id);
    const nameClass = hasError
      ? "marketplaceRowName marketplaceRowError"
      : "marketplaceRowName";
    const errorBadge = hasError
      ? `<span class="marketplaceRowErrorBadge">!</span>`
      : "";
    const remainingTime = refreshInProgressIds.has(m.id)
      ? "refreshing"
      : formatDurationMs(getMarketplaceRefreshRemainingMs(m.id));
    const rateLimitRemaining = getMarketplaceRateLimitRemaining(m.id);

    return `
      <div class="marketplaceRow">
        <label class="marketplaceCheckWrap" title="Enable ${escapeHtml(m.name)}">
          <input type="checkbox" class="marketplaceCheck" data-id="${escapeHtml(m.id)}" ${checked} />
        </label>
        <img class="marketplaceRowLogo" src="${escapeHtml(m.logoPath)}" alt="${escapeHtml(m.name)}" />
        <div class="marketplaceInfo">
          <span class="${nameClass}">${escapeHtml(m.name)}</span>
          <span class="marketplaceTimerWrap">
            <span class="marketplaceTimerRemaining">${escapeHtml(remainingTime)}</span>
          </span>
        </div>
        <div class="marketplaceRowAside">
          <span class="marketplaceRateRemaining" title="Rate-limit requests remaining from latest response">Remaining: ${escapeHtml(rateLimitRemaining)}</span>
          ${errorBadge}
        </div>
      </div>
    `;
  }).join("");
}

function renderMarketplaceRefreshBar() {
  if (!lastRawExtracted.length) {
    marketRefreshBarEl.classList.add("hidden");
    marketRefreshBarEl.innerHTML = "";
    return;
  }

  const chips = MARKETPLACE_DEFS.map((m) => {
    const remaining = refreshInProgressIds.has(m.id)
      ? "refreshing"
      : formatDurationMs(getMarketplaceRefreshRemainingMs(m.id));
    const flashRefresh = (refreshFlashUntilById.get(m.id) || 0) > Date.now();

    return `
      <div class="marketRefreshChip${enabledMarketplaceIds.has(m.id) ? "" : " marketRefreshChipMuted"}">
        <img class="marketRefreshLogo" src="${escapeHtml(m.logoPath)}" alt="${escapeHtml(m.name)}" />
        <span class="marketRefreshName">${escapeHtml(m.name)}</span>
        <span class="marketRefreshRemaining">${escapeHtml(remaining)}</span>
        ${flashRefresh ? `<span class="marketRefreshIcon" aria-hidden="true">↻</span>` : ""}
      </div>
    `;
  }).join("");

  marketRefreshBarEl.innerHTML = `<div class="marketRefreshInner">${chips}</div>`;
  marketRefreshBarEl.classList.remove("hidden");
}

function syncRefreshUi() {
  renderMarketplaceRefreshBar();
  if (dropdownOpen) renderMarketplaceList();
}

function applyProviderStates(states) {
  providerStateById = new Map(
    (Array.isArray(states) ? states : []).map((state) => [state.id, state])
  );

  for (const market of MARKETPLACE_DEFS) {
    const state = providerStateById.get(market.id);
    if (Number(state?.pausedUntil) > Date.now()) {
      marketplaceRefreshRemainingMsById.set(
        market.id,
        Math.max(
          getMarketplaceRefreshRemainingMs(market.id),
          Number(state.pausedUntil) - Date.now()
        )
      );
    }
  }
}

function resetRefreshCountdowns(ids = MARKETPLACE_DEFS.map((market) => market.id)) {
  const selectedIds = new Set(ids);
  for (const m of MARKETPLACE_DEFS) {
    if (!selectedIds.has(m.id)) continue;
    const intervalMs = getMarketplaceRefreshIntervalMs(m.id);
    marketplaceRefreshRemainingMsById.set(m.id, intervalMs);
  }
  syncRefreshUi();
}

function stopRefreshCountdown() {
  refreshCountdownActive = false;
  if (refreshTickIntervalId != null) {
    clearInterval(refreshTickIntervalId);
    refreshTickIntervalId = null;
  }
}

function tickRefreshCountdowns() {
  if (!refreshCountdownActive || refreshInProgress || !lastRawExtracted.length) {
    syncRefreshUi();
    return;
  }

  for (const m of MARKETPLACE_DEFS) {
    if (!enabledMarketplaceIds.has(m.id)) continue;
    const nextRemaining = Math.max(0, getMarketplaceRefreshRemainingMs(m.id) - 1000);
    marketplaceRefreshRemainingMsById.set(m.id, nextRemaining);
  }

  syncRefreshUi();
}

function startRefreshCountdown(resetCounters = true) {
  stopRefreshCountdown();
  if (!lastRawExtracted.length) {
    syncRefreshUi();
    return;
  }

  refreshCountdownActive = true;
  if (resetCounters) resetRefreshCountdowns();
  refreshTickIntervalId = setInterval(tickRefreshCountdowns, 1000);
}

function openDropdown() {
  dropdownOpen = true;
  renderMarketplaceList();
  marketplaceDropdownEl.classList.remove("hidden");
  marketplaceBtnArrowEl.classList.add("open");
}

function closeDropdown() {
  dropdownOpen = false;
  marketplaceDropdownEl.classList.add("hidden");
  marketplaceMinErrorEl.classList.add("hidden");
  marketplaceBtnArrowEl.classList.remove("open");
}

function toggleDropdown() {
  if (dropdownOpen) closeDropdown();
  else openDropdown();
}

marketplaceListEl.addEventListener("change", async (e) => {
  const checkbox = e.target.closest(".marketplaceCheck");
  if (!checkbox) return;

  const id = checkbox.dataset.id;

  if (!checkbox.checked) {
    if (enabledMarketplaceIds.size <= 1) {
      checkbox.checked = true;
      marketplaceMinErrorEl.classList.remove("hidden");
      clearTimeout(marketplaceMinErrorEl._hideTimer);
      marketplaceMinErrorEl._hideTimer = setTimeout(() => {
        marketplaceMinErrorEl.classList.add("hidden");
      }, 2500);
      return;
    }
    enabledMarketplaceIds.delete(id);
  } else {
    marketplaceMinErrorEl.classList.add("hidden");
    enabledMarketplaceIds.add(id);
  }

  updateProviderErrors(lastRawExtracted);
  syncRefreshUi();
  if (lastRawExtracted.length) {
    refreshDisplay();
  }

  const refreshIds = checkbox.checked && lastRawExtracted.length ? [id] : [];
  try {
    await window.cs2.setTrackedProviders([...enabledMarketplaceIds], refreshIds);
  } catch (_error) {
    // Provider errors are displayed when the main process next returns state.
  }
});

marketplaceBtnEl.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleDropdown();
});

document.addEventListener("click", (e) => {
  if (
    dropdownOpen &&
    !marketplaceDropdownEl.contains(e.target) &&
    !marketplaceBtnEl.contains(e.target)
  ) {
    closeDropdown();
  }
});

// ─── Price Breakdown Modal ─────────────────────────────────────────────────────
function buildMarketplaceUrl(providerId, marketHashName, providerPrice = null) {
  if (!marketHashName) return null;

  if (providerId === "steam-community") {
    return `https://steamcommunity.com/market/listings/730/${encodeURIComponent(marketHashName)}`;
  }

  if (providerId === "csfloat") {
    if (/^https:\/\/csfloat\.com\//i.test(String(providerPrice?.externalUrl || ""))) {
      return providerPrice.externalUrl;
    }

    if (providerPrice?.listingId) {
      return `https://csfloat.com/item/${encodeURIComponent(providerPrice.listingId)}`;
    }

    return `https://csfloat.com/search?market_hash_name=${encodeURIComponent(marketHashName)}`;
  }

  if (providerId === "dmarket") {
    if (/^https:\/\/(?:www\.)?dmarket\.com\//i.test(String(providerPrice?.externalUrl || ""))) {
      return providerPrice.externalUrl;
    }

    return `https://dmarket.com/ingame-items/item-list/csgo-skins?title=${encodeURIComponent(marketHashName)}`;
  }

  return null;
}

function showModal(title, bodyHtml, kind = "generic") {
  activeModalKind = kind;
  if (kind !== "prices") activePriceModalItemKey = null;
  modalTitleEl.textContent = title;
  modalBodyEl.innerHTML = bodyHtml;

  document.body.classList.add("modalOpen");
  modalOverlayEl.classList.remove("hidden");

  requestAnimationFrame(() => {
    modalCloseEl.focus();
  });
}

function openPriceModal(item) {
  activePriceModalItemKey = String(item?.market_hash_name || "").trim().toLowerCase();
  modalTitleEl.textContent = getDisplayName(item);

  const marketHashName = String(item?.market_hash_name || "").trim();

  const rows = MARKETPLACE_DEFS.map((m) => {
    const providerPrice = (item.providerPrices || []).find(
      (p) => p?.providerId === m.id
    );
    const isEnabled = enabledMarketplaceIds.has(m.id);
    let priceDisplay;
    let isError = false;
    let errorMsg = "";

    if (
      !providerPrice ||
      providerPrice.success !== true ||
      typeof providerPrice.priceNumber !== "number" ||
      !Number.isFinite(providerPrice.priceNumber)
    ) {
      isError = true;
      errorMsg = providerPrice?.error || "No data available";
      priceDisplay = "N/A";
    } else {
      let priceNum = providerPrice.priceNumber;
      if (usePostFeePrice && m.sellerFeeMultiplier) {
        priceNum = priceNum * m.sellerFeeMultiplier;
      }
      priceDisplay = `$${priceNum.toFixed(2)}`;
    }

    const marketUrl =
      !isError || m.id === "csfloat"
        ? buildMarketplaceUrl(m.id, marketHashName, providerPrice)
        : null;
    const rowClass = [
      "modalPriceRow",
      !isEnabled ? "modalRowDisabled" : "",
      marketUrl ? "modalPriceRowLink" : ""
    ].filter(Boolean).join(" ");
    const nameClass = isError ? "modalProviderName modalProviderNameError" : "modalProviderName";
    const priceClass = isError ? "modalPrice modalPriceError" : "modalPrice";

    return `
      <div
        class="${rowClass}"
        ${marketUrl ? `data-market-url="${escapeHtml(marketUrl)}" role="button" tabindex="0" title="Open ${escapeHtml(m.name)} listing"` : ""}
      >
        <img class="modalProviderLogo" src="${escapeHtml(m.logoPath)}" alt="${escapeHtml(m.name)}" />
        <span class="${nameClass}">${escapeHtml(m.name)}</span>
        <span class="${priceClass}" title="${isError ? escapeHtml(errorMsg) : ""}">${escapeHtml(priceDisplay)}</span>
        ${!isEnabled ? `<span class="modalDisabledTag">(disabled)</span>` : ""}
      </div>
    `;
  }).join("");

  const feeNote = usePostFeePrice
    ? `<div class="modalFeeNote">⚠ Post-fee prices shown are estimates based on approximate marketplace fee rates.</div>`
    : "";

  showModal(getDisplayName(item), rows + feeNote, "prices");
}

function getSettingsIntervalValue(settings, id) {
  if (id === "steam-community") {
    return settings?.steamCommunityRefreshIntervalMs;
  }
  if (id === "csfloat") {
    return settings?.csfloatRefreshIntervalMs;
  }
  if (id === "dmarket") {
    return settings?.dmarketRefreshIntervalMs;
  }
  return getMarketplaceRefreshIntervalMs(id);
}

function renderMarketplaceSettingsDetails(market, settings) {
  if (market.id === "csfloat") {
    const keyState = settings.csfloatApiKeyConfigured ? "Saved securely" : "Not configured";
    return `
      <label class="settingsField">
        <span>CSFloat API Key</span>
        <input class="settingsInput" id="csfloatApiKeyInput" type="password" autocomplete="off" placeholder="${escapeHtml(keyState)}" />
        <small>Create this key from your CSFloat profile Developer tab.</small>
      </label>
      <div class="settingsActions settingsInlineActions">
        <button class="settingsActionBtn" data-settings-action="clear-csfloat">Clear CSFloat Key</button>
        <button class="settingsActionBtn" data-settings-action="test-csfloat">Test CSFloat Connection</button>
      </div>
      <div class="settingsTestHint">Saving a key does not start requests. Enable CSFloat in the marketplace menu to load live prices, or use the test button for one item.</div>
    `;
  }

  if (market.id === "steam-community") {
    const keyState = settings.steamWebApiKeyConfigured ? "Saved securely" : "Not configured";
    return `
      <label class="settingsField">
        <span>Steam Web API Key (optional)</span>
        <input class="settingsInput" id="steamWebApiKeyInput" type="password" autocomplete="off" placeholder="${escapeHtml(keyState)}" />
        <small>Stored for optional Steam API support; existing Steam Market loading remains in use.</small>
      </label>
      <div class="settingsActions settingsInlineActions">
        <button class="settingsActionBtn" data-settings-action="clear-steam">Clear Steam Key</button>
      </div>
    `;
  }

  if (market.id === "dmarket") {
    const feePercent = Number.isFinite(Number(settings.dmarketSellerFeePercent))
      ? Number(settings.dmarketSellerFeePercent)
      : Number(market.defaultSellerFeePercent || 2);
    return `
      <label class="settingsField">
        <span>Estimated Seller Fee (%)</span>
        <input class="settingsInput" id="dmarketSellerFeePercentInput" type="number" min="0" max="100" step="0.01" value="${escapeHtml(String(feePercent))}" />
        <small>DMarket fees may vary by item. 2% is an editable estimate for post-fee display.</small>
      </label>
      <div class="settingsActions settingsInlineActions">
        <button class="settingsActionBtn" data-settings-action="test-dmarket">Test DMarket Connection</button>
      </div>
      <div class="settingsTestHint">Save fee changes before testing. Public current-price lookup does not require DMarket API keys. Enable DMarket in the marketplace menu to load live prices.</div>
    `;
  }

  return `<div class="settingsMarketEmpty">No additional provider settings are available.</div>`;
}

function renderMarketplaceSettingsPanel(market, settings) {
  const expanded = expandedSettingsMarketplaceIds.has(market.id);
  const interval = formatDurationMs(
    getSettingsIntervalValue(settings, market.id) ||
      getMarketplaceRefreshIntervalMs(market.id)
  );

  return `
    <section class="settingsMarket">
      <div class="settingsMarketHeader">
        <button
          type="button"
          class="settingsMarketToggle"
          data-settings-action="toggle-market"
          data-market-id="${escapeHtml(market.id)}"
          aria-expanded="${expanded ? "true" : "false"}"
        >
          <img class="settingsMarketLogo" src="${escapeHtml(market.logoPath)}" alt="" />
          <span class="settingsMarketName">${escapeHtml(market.name)}</span>
          <span class="settingsMarketArrow${expanded ? " open" : ""}" aria-hidden="true">&#9660;</span>
        </button>
        <input
          class="settingsMarketIntervalInput"
          data-market-refresh-input="${escapeHtml(market.id)}"
          type="text"
          value="${escapeHtml(interval)}"
          aria-label="${escapeHtml(market.name)} refresh interval in minutes and seconds"
          title="Refresh interval (mm:ss or seconds)"
        />
      </div>
      <div
        class="settingsMarketPanel${expanded ? "" : " hidden"}"
        data-settings-market-panel="${escapeHtml(market.id)}"
      >
        ${renderMarketplaceSettingsDetails(market, settings)}
      </div>
    </section>
  `;
}

function renderSettingsModal(feedbackHtml = "") {
  const settings = appSettings || {};
  const storageNote = settings.secureStorageAvailable === false
    ? `<div class="settingsFeedback settingsFeedbackError">Secure local storage is unavailable. API keys cannot be saved.</div>`
    : "";
  const marketPanels = MARKETPLACE_DEFS.map((market) =>
    renderMarketplaceSettingsPanel(market, settings)
  ).join("");

  modalBodyEl.innerHTML = `
    <div class="settingsModalBody">
      <div class="settingsIntro">API tokens are encrypted by Electron secure storage and are never shown after saving. No passwords are used or stored.</div>
      ${storageNote}
      <div class="settingsRateLimitWarning">
        Enabled marketplaces request live prices for tracked items on their timer. Disable CSFloat or DMarket in the marketplace menu to stop its API requests. CSFloat and DMarket intervals are limited to at least 01:00.
      </div>
      <div class="settingsMarketList">${marketPanels}</div>
      <div class="settingsActions">
        <button class="settingsActionBtn settingsPrimaryBtn" data-settings-action="save">Save Settings</button>
      </div>
      <div id="settingsFeedback">${feedbackHtml}</div>
    </div>
  `;
}

function toggleSettingsMarketplacePanel(id) {
  const panel = modalBodyEl.querySelector(`[data-settings-market-panel="${id}"]`);
  const toggle = modalBodyEl.querySelector(`[data-market-id="${id}"]`);
  const arrow = toggle?.querySelector(".settingsMarketArrow");
  if (!panel || !toggle) return;

  const shouldOpen = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !shouldOpen);
  arrow?.classList.toggle("open", shouldOpen);
  toggle.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) expandedSettingsMarketplaceIds.add(id);
  else expandedSettingsMarketplaceIds.delete(id);
}

function applyAppSettings(settings) {
  appSettings = settings;
  for (const market of MARKETPLACE_DEFS) {
    const previousInterval = getMarketplaceRefreshIntervalMs(market.id);
    const interval = clampRefreshIntervalMs(
      getSettingsIntervalValue(settings, market.id),
      market.id
    );
    marketplaceRefreshIntervalMsById.set(market.id, interval);
    if (previousInterval !== interval) {
      marketplaceRefreshRemainingMsById.set(market.id, interval);
    }
  }
  const dmarket = getMarketplaceDefinition("dmarket");
  if (dmarket) {
    const dmarketFeePercent = Number(settings?.dmarketSellerFeePercent);
    const safeFeePercent = Number.isFinite(dmarketFeePercent)
      ? Math.min(100, Math.max(0, dmarketFeePercent))
      : Number(dmarket.defaultSellerFeePercent || 2);
    dmarket.sellerFeeMultiplier = 1 - safeFeePercent / 100;
  }

  syncRefreshUi();
}

async function loadAppSettings() {
  const settings = await window.cs2.getSettings();
  applyAppSettings(settings);
  return settings;
}

async function openSettingsModal() {
  expandedSettingsMarketplaceIds.clear();
  showModal(
    "Settings",
    `<div class="settingsModalBody">Loading settings...</div>`,
    "settings"
  );

  try {
    await loadAppSettings();
    if (activeModalKind === "settings") renderSettingsModal();
  } catch (error) {
    if (activeModalKind === "settings") {
      renderSettingsModal(
        `<div class="settingsFeedback settingsFeedbackError">${escapeHtml(error?.message || String(error))}</div>`
      );
    }
  }
}

async function saveSettingsFromModal() {
  const csfloatKey = document.getElementById("csfloatApiKeyInput")?.value.trim() || "";
  const steamKey = document.getElementById("steamWebApiKeyInput")?.value.trim() || "";
  const dmarketFeeValue = document.getElementById("dmarketSellerFeePercentInput")?.value || "";
  const refreshIntervals = new Map();

  for (const market of MARKETPLACE_DEFS) {
    const input = modalBodyEl.querySelector(
      `[data-market-refresh-input="${market.id}"]`
    );
    const interval = parseDurationInput(input?.value || "", market.id);
    if (interval == null) {
      expandedSettingsMarketplaceIds.add(market.id);
      renderSettingsModal(
        `<div class="settingsFeedback settingsFeedbackError">Enter a valid ${escapeHtml(market.name)} interval such as 05:05 or 305.</div>`
      );
      return;
    }
    refreshIntervals.set(market.id, interval);
  }

  const dmarketFeePercent = Number(dmarketFeeValue);
  if (!Number.isFinite(dmarketFeePercent) || dmarketFeePercent < 0 || dmarketFeePercent > 100) {
    expandedSettingsMarketplaceIds.add("dmarket");
    renderSettingsModal(
      `<div class="settingsFeedback settingsFeedbackError">Enter a valid DMarket seller fee percentage from 0 to 100.</div>`
    );
    return;
  }

  const updates = {
    steamCommunityRefreshIntervalMs: refreshIntervals.get("steam-community"),
    csfloatRefreshIntervalMs: refreshIntervals.get("csfloat"),
    dmarketRefreshIntervalMs: refreshIntervals.get("dmarket"),
    dmarketSellerFeePercent
  };
  if (csfloatKey) updates.csfloatApiKey = csfloatKey;
  if (steamKey) updates.steamWebApiKey = steamKey;

  try {
    const settings = await window.cs2.saveSettings(updates);
    applyAppSettings(settings);
    renderSettingsModal(
      `<div class="settingsFeedback settingsFeedbackSuccess">Settings saved securely.</div>`
    );
    if (lastRawExtracted.length) {
      refreshDisplay();
    }
  } catch (error) {
    renderSettingsModal(
      `<div class="settingsFeedback settingsFeedbackError">${escapeHtml(error?.message || String(error))}</div>`
    );
  }
}

async function clearSecretFromModal(secretName) {
  const updates =
    secretName === "csfloat"
      ? { clearCsfloatApiKey: true }
      : { clearSteamWebApiKey: true };
  try {
    const settings = await window.cs2.saveSettings(updates);
    applyAppSettings(settings);
    if (secretName === "csfloat") {
      enabledMarketplaceIds.delete("csfloat");
      if (!enabledMarketplaceIds.size) enabledMarketplaceIds.add("steam-community");
      if (lastRawExtracted.length) refreshDisplay();
    }
    renderSettingsModal(
      `<div class="settingsFeedback settingsFeedbackSuccess">${escapeHtml(secretName === "csfloat" ? "CSFloat" : "Steam")} API key cleared.</div>`
    );
  } catch (error) {
    renderSettingsModal(
      `<div class="settingsFeedback settingsFeedbackError">${escapeHtml(error?.message || String(error))}</div>`
    );
  }
}

async function testCsfloatConnectionFromModal() {
  const feedbackEl = document.getElementById("settingsFeedback");
  if (feedbackEl) {
    feedbackEl.innerHTML = `<div class="settingsFeedback">Testing AK-47 | Redline (Field-Tested)...</div>`;
  }

  try {
    const result = await window.cs2.testCsfloatConnection();
    const message =
      result.success && result.listingAvailable
        ? `Connection succeeded. Lowest ask ${formatCurrency(result.usdPrice)} (${result.lowestRawCents} cents), post-fee ${formatCurrency(result.postFeeUsdPrice)}.`
        : result.success
          ? "Connection succeeded, but no active buy_now listing was returned for the test item."
          : result.error || "CSFloat connection test failed.";
    if (feedbackEl) {
      feedbackEl.innerHTML = `<div class="settingsFeedback ${result.success ? "settingsFeedbackSuccess" : "settingsFeedbackError"}">${escapeHtml(message)}</div>`;
    }
  } catch (error) {
    if (feedbackEl) {
      feedbackEl.innerHTML = `<div class="settingsFeedback settingsFeedbackError">${escapeHtml(error?.message || String(error))}</div>`;
    }
  }
}

async function testDmarketConnectionFromModal() {
  const feedbackEl = document.getElementById("settingsFeedback");
  if (feedbackEl) {
    feedbackEl.innerHTML = `<div class="settingsFeedback">Testing DMarket for AK-47 | Redline (Field-Tested)...</div>`;
  }

  try {
    const result = await window.cs2.testDmarketConnection();
    const message = result.success
      ? `Connection succeeded without authentication. Lowest ask ${formatCurrency(result.usdPrice)} (${result.lowestRawCents} cents), post-fee estimate ${formatCurrency(result.postFeeUsdPrice)}.`
      : result.error || "DMarket connection test failed.";
    if (feedbackEl) {
      feedbackEl.innerHTML = `<div class="settingsFeedback ${result.success ? "settingsFeedbackSuccess" : "settingsFeedbackError"}">${escapeHtml(message)}</div>`;
    }
  } catch (error) {
    if (feedbackEl) {
      feedbackEl.innerHTML = `<div class="settingsFeedback settingsFeedbackError">${escapeHtml(error?.message || String(error))}</div>`;
    }
  }
}

function closeModal() {
  activeModalKind = null;
  activePriceModalItemKey = null;
  modalOverlayEl.classList.add("hidden");
  document.body.classList.remove("modalOpen");
  modalBodyEl.innerHTML = "";
}

modalCloseEl.addEventListener("click", closeModal);

modalOverlayEl.addEventListener("click", (e) => {
  if (e.target === modalOverlayEl) closeModal();
});

modalBodyEl.addEventListener("click", (e) => {
  if (activeModalKind === "settings") {
    const action = e.target.closest("[data-settings-action]")?.dataset.settingsAction;
    if (action === "toggle-market") {
      toggleSettingsMarketplacePanel(
        e.target.closest("[data-market-id]")?.dataset.marketId
      );
    }
    if (action === "save") saveSettingsFromModal();
    if (action === "test-csfloat") testCsfloatConnectionFromModal();
    if (action === "test-dmarket") testDmarketConnectionFromModal();
    if (action === "clear-csfloat") clearSecretFromModal("csfloat");
    if (action === "clear-steam") clearSecretFromModal("steam");
    return;
  }

  if (activeModalKind !== "prices") return;

  const row = e.target.closest(".modalPriceRowLink");
  if (!row) return;

  const url = row.dataset.marketUrl;
  if (url) window.cs2.openExternal(url);
});

modalBodyEl.addEventListener("keydown", (e) => {
  if (activeModalKind !== "prices") return;

  if (e.key !== "Enter" && e.key !== " ") return;

  const row = e.target.closest(".modalPriceRowLink");
  if (!row) return;

  e.preventDefault();
  const url = row.dataset.marketUrl;
  if (url) window.cs2.openExternal(url);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalOverlayEl.classList.contains("hidden")) {
    closeModal();
  }
});

// ─── Post-Fee Toggle ───────────────────────────────────────────────────────────
postFeeToggleEl.addEventListener("change", () => {
  usePostFeePrice = postFeeToggleEl.checked;
  if (lastRawExtracted.length) refreshDisplay();
});

settingsBtnEl.addEventListener("click", openSettingsModal);
miniModeBtnEl.addEventListener("click", () => {
  window.appWindow.enterMiniMode();
});

// ─── Cosmetics Helpers ─────────────────────────────────────────────────────────
function getAppliedCosmetics(it) {
  const stickersRich = Array.isArray(it?.stickers)
    ? it.stickers
        .map((s) => ({ name: s?.name ?? null, image: s?.image ?? null }))
        .filter((s) => s.name || s.image)
    : [];

  const charmRich =
    it?.charm && (it.charm.name || it.charm.image)
      ? { name: it.charm.name ?? null, image: it.charm.image ?? null }
      : null;

  const stickersNamesOnly = Array.isArray(it?.applied_stickers)
    ? it.applied_stickers
        .map((name) => ({ name, image: null }))
        .filter((s) => s.name)
    : [];

  return {
    stickers: stickersRich.length > 0 ? stickersRich : stickersNamesOnly,
    charm: charmRich ?? null
  };
}

// ─── Price Helpers ─────────────────────────────────────────────────────────────
function getNumericPrice(it) {
  if (typeof it?.displayTotalPrice === "number" && Number.isFinite(it.displayTotalPrice)) {
    return it.displayTotalPrice;
  }
  if (typeof it?.bestPrice === "number" && Number.isFinite(it.bestPrice)) {
    return it.bestPrice;
  }
  if (typeof it?.price === "number" && Number.isFinite(it.price)) {
    return it.price;
  }
  const textPrice = it?.bestPriceText || it?.price || "";
  if (typeof textPrice === "string") {
    const match = textPrice.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    if (match) {
      const parsed = Number(match[0]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function formatCurrency(value) {
  return `$${(Number(value) || 0).toFixed(2)}`;
}

function formatSignedCurrency(value) {
  const amount = Math.abs(Number(value) || 0).toFixed(2);
  return `${value < 0 ? "-" : "+"}$${amount}`;
}

function getPlaceholderPrice(it) {
  if (it?.isCondensedDuplicate === true && Number(it.duplicateCount || 1) > 1) {
    const qty = Number(it.duplicateCount || 1);
    const unit = Number(it.unitDisplayPrice || 0);
    const total = Number(it.displayTotalPrice || 0);
    return {
      mult: `${qty} x ${formatCurrency(unit)} =`,
      total: formatCurrency(total)
    };
  }
  return { mult: null, total: it?.bestPriceText || it?.price || "$0.00" };
}

function getDisplayName(it) {
  const fullName = String(it?.market_hash_name || it?.name || "").trim();
  const exterior = String(it?.exterior || "").trim();
  if (!fullName) return "";
  if (!exterior) return fullName;
  const suffix = ` (${exterior})`;
  return fullName.endsWith(suffix)
    ? fullName.slice(0, -suffix.length).trim()
    : fullName;
}

function isPlainDefaultWeaponName(name) {
  const normalized = String(name || "").trim();
  if (!normalized || normalized.includes(" | ")) {
    return false;
  }

  return new Set([
    "AK-47",
    "AUG",
    "AWP",
    "CZ75-Auto",
    "Desert Eagle",
    "Dual Berettas",
    "FAMAS",
    "Five-SeveN",
    "G3SG1",
    "Galil AR",
    "Glock-18",
    "M249",
    "M4A1-S",
    "M4A4",
    "MAC-10",
    "MAG-7",
    "MP5-SD",
    "MP7",
    "MP9",
    "Negev",
    "Nova",
    "P2000",
    "P250",
    "P90",
    "PP-Bizon",
    "R8 Revolver",
    "Sawed-Off",
    "SCAR-20",
    "SG 553",
    "SSG 08",
    "Tec-9",
    "UMP-45",
    "USP-S",
    "XM1014",
    "Zeus x27"
  ]).has(normalized);
}

function shouldDisplayInventoryItem(item) {
  if (!item) return false;

  if (item.hiddenFromDisplay === true) {
    return false;
  }

  const hasAppliedCosmetics =
    (Array.isArray(item.applied_stickers) && item.applied_stickers.length > 0) ||
    (Array.isArray(item.stickers) && item.stickers.length > 0) ||
    Boolean(item.charm);

  const isUntradableDefaultWeaponWithCosmetics =
    String(item.kind || "").toLowerCase() === "weapon" &&
    isPlainDefaultWeaponName(item.market_hash_name || item.name || "") &&
    hasAppliedCosmetics &&
    (!Boolean(item.tradable) || !Boolean(item.marketable));

  return !isUntradableDefaultWeaponWithCosmetics;
}

// ─── Card Sub-Renderers ────────────────────────────────────────────────────────
function renderCharmOverlay(charm) {
  if (!charm || !charm.image) return "";
  const title = escapeHtml(charm.name || "Charm");
  return `
    <div class="charmOverlay" title="${title}">
      <img class="charmOverlayImg" src="${escapeHtml(charm.image)}" alt="${title}" loading="lazy" />
    </div>
  `;
}

function renderDuplicateBadge(it) {
  if (!it?.isCondensedDuplicate || Number(it?.duplicateCount || 1) <= 1) return "";
  return `
    <div class="duplicateBadge" title="${escapeHtml(String(it.duplicateCount))} duplicates">
      x${escapeHtml(String(it.duplicateCount))}
    </div>
  `;
}

function renderStickerColumn(stickers) {
  if (!stickers || stickers.length === 0) return "";
  return `
    <div class="stickerRail">
      ${stickers.slice(0, 5).map((sticker) => {
        const title = escapeHtml(sticker.name || "Sticker");
        if (sticker.image) {
          return `
            <div class="stickerSlot" title="${title}">
              <img class="stickerRailImg" src="${escapeHtml(sticker.image)}" alt="${title}" loading="lazy" />
            </div>
          `;
        }
        return `
          <div class="stickerSlot stickerSlotText" title="${title}">
            <span class="stickerFallbackText">${title}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function hasWearData(it) { return it?.wear_float != null || it?.exterior; }
function hasPatternData(it) { return it?.pattern_template != null; }
function isUniquelyTrackedItem(it) { return hasWearData(it) || hasPatternData(it); }
function shouldCondenseDuplicates(it) { return !isUniquelyTrackedItem(it); }

function buildCondenseKey(it) {
  return [
    String(it?.market_hash_name || ""),
    String(it?.kind || ""),
    String(it?.collection || ""),
    String(it?.rarity || ""),
    String(it?.quality || ""),
    String(it?.type_name || "")
  ].join("||");
}

function renderMetadata(it) {
  const collection = String(it?.collection || "").trim();
  const exterior = String(it?.exterior || "").trim();
  const collectionClass = /\bagents?\b/i.test(collection)
    ? "conditionRow collectionRow agentCollectionRow"
    : "conditionRow collectionRow";

  if (hasWearData(it) || hasPatternData(it)) {
    return `
      <div class="conditionRow">${escapeHtml(exterior || "—")}</div>
      <div class="detailsBlock">
        <div class="rowCentered subtleRow">
          <span>Float: ${it.wear_float != null ? Number(it.wear_float).toFixed(6) : "—"}</span>
          <span>Pattern: ${it.pattern_template != null ? it.pattern_template : "—"}</span>
        </div>
      </div>
    `;
  }

  if (collection) {
    return `
      <div class="${collectionClass}">${escapeHtml(collection)}</div>
      <div class="detailsBlock detailsSpacer"></div>
    `;
  }

  return `
    <div class="conditionRow">${escapeHtml(it.type_name || "—")}</div>
    <div class="detailsBlock detailsSpacer"></div>
  `;
}

function getRarityClass(it) {
  const rarity = String(it?.rarity || "").toLowerCase();
  const quality = String(it?.quality || "").toLowerCase();
  const typeName = String(it?.type_name || "").toLowerCase();
  const marketHashName = String(it?.market_hash_name || "").toLowerCase();
  const weaponInternal = String(it?.weapon_internal || "").toLowerCase();
  const kind = String(it?.kind || "").toLowerCase();
  const combined = `${rarity} ${quality} ${typeName}`.trim();

  const isKnife =
    weaponInternal.includes("knife") ||
    [
      "knife","bayonet","karambit","butterfly","flip knife","gut knife",
      "m9 bayonet","huntsman knife","falchion knife","bowie knife",
      "shadow daggers","navaja knife","stiletto knife","ursus knife",
      "talon knife","skeleton knife","survival knife","paracord knife",
      "nomad knife","kukri knife","★"
    ].some((s) => marketHashName.includes(s));

  const isGlove = kind === "glove" || marketHashName.includes("glove");

  if (isKnife || isGlove) return "rarity-gold";
  if (combined.includes("consumer") || combined.includes("common") || combined.includes("base grade")) return "rarity-grey";
  if (combined.includes("industrial") || combined.includes("uncommon")) return "rarity-light-blue";
  if (combined.includes("mil-spec") || combined.includes("mil spec") || combined.includes("high grade") || combined.includes("distinguished")) return "rarity-blue";
  if (combined.includes("restricted") || combined.includes("remarkable") || combined.includes("exceptional")) return "rarity-purple";
  if (combined.includes("classified") || combined.includes("exotic") || combined.includes("superior")) return "rarity-pink";
  if (combined.includes("covert") || combined.includes("contraband") || combined.includes("extraordinary") || combined.includes("master")) return "rarity-red";
  return "rarity-default";
}

// ─── Price Field Renderer ──────────────────────────────────────────────────────
function renderPriceField(it) {
  const { mult, total } = getPlaceholderPrice(it);
  const providerId = it.bestPriceProviderId;
  const marketDef = getMarketplaceDefinition(providerId);
  const providerPrice = (it.providerPrices || []).find(
    (price) => price?.providerId === providerId
  );
  const itemKey = String(it.market_hash_name || "").trim().toLowerCase();
  const marketHashName = String(it.market_hash_name || "").trim();
  const marketUrl = buildMarketplaceUrl(providerId, marketHashName, providerPrice);

  const multHtml = `<div class="priceMult${mult ? "" : " priceMultEmpty"}">${mult ? escapeHtml(mult) : "&nbsp;"}</div>`;

  const logoHtml = marketDef && marketUrl
    ? `<img
        class="priceProviderLogo priceProviderLogoLink"
        src="${escapeHtml(marketDef.logoPath)}"
        alt="${escapeHtml(marketDef.name)}"
        title="View on ${escapeHtml(marketDef.name)}"
        data-market-url="${escapeHtml(marketUrl)}"
        loading="lazy"
      />`
    : "";

  return `
    <div class="priceField">
      ${multHtml}
      <div class="priceDivider"></div>
      <div class="priceRow">
        <span class="priceValue">${escapeHtml(total)}</span>
        ${logoHtml}
        <button class="infoBtn" data-item-key="${escapeHtml(itemKey)}" title="View marketplace prices">ⓘ</button>
      </div>
    </div>
  `;
}

// ─── Item Deduplication ────────────────────────────────────────────────────────
function condenseDuplicateItems(items) {
  const condensed = [];
  const grouped = new Map();

  for (const item of items) {
    if (item?.hiddenFromDisplay === true) continue;

    if (!shouldCondenseDuplicates(item)) {
      condensed.push({
        ...item,
        duplicateCount: Number(item?.amount || 1),
        unitDisplayPrice: getNumericPrice(item),
        displayTotalPrice: getNumericPrice(item),
        isCondensedDuplicate: false
      });
      continue;
    }

    const key = buildCondenseKey(item);
    const qty = Math.max(1, Number(item?.amount || 1));
    const unitPrice = getNumericPrice(item);

    if (!grouped.has(key)) {
      grouped.set(key, {
        ...item,
        duplicateCount: qty,
        unitDisplayPrice: unitPrice,
        displayTotalPrice: unitPrice * qty,
        isCondensedDuplicate: true
      });
    } else {
      const existing = grouped.get(key);
      existing.duplicateCount += qty;
      existing.displayTotalPrice += unitPrice * qty;
    }
  }

  condensed.push(...grouped.values());
  return condensed;
}

// ─── Status Building ───────────────────────────────────────────────────────────
function getInventoryTotal(items) {
  return items.reduce((sum, item) => sum + getNumericPrice(item), 0);
}

function getCondensedItemsForPricingMode(rawItems, postFeeEnabled) {
  return condenseDuplicateItems(
    enrichItems(rawItems.filter(shouldDisplayInventoryItem), postFeeEnabled)
  );
}

function getVisibleItemQuantity(items) {
  return items.reduce(
    (sum, item) => sum + Math.max(1, Number(item?.duplicateCount || item?.amount || 1)),
    0
  );
}

function getMissingPriceCount(items) {
  return items.reduce((sum, item) => {
    const hasPrice =
      typeof item?.displayTotalPrice === "number"
        ? item.displayTotalPrice > 0
        : getNumericPrice(item) > 0;
    return sum + (hasPrice ? 0 : 1);
  }, 0);
}

function buildStatusMessage(result, profileInput, visibleItems) {
  const totalValue = getInventoryTotal(visibleItems);
  const preFeeTotal = getInventoryTotal(getCondensedItemsForPricingMode(lastRawExtracted, false));
  const postFeeDifference = totalValue - preFeeTotal;
  const visibleQty = getVisibleItemQuantity(visibleItems);
  const visibleTiles = visibleItems.length;
  const missingPrices = getMissingPriceCount(visibleItems);
  const displayUser =
    result?.displayName || result?.vanityName || result?.steamId64 || profileInput;
  const feeTag = usePostFeePrice
    ? ` <span style="color:var(--status-orange);font-size:10px">(post-fee est.)</span><span class="statusDelta">(${escapeHtml(formatSignedCurrency(postFeeDifference))})</span>`
    : "";

  return `
    <div class="statusLine">
      <span class="statusLead">Steam User </span>
      <span class="statusBlue">${escapeHtml(displayUser)}</span>
      <span class="statusLead">'s inventory successfully loaded: </span>
      <span class="statusOrange">Items Displayed = ${escapeHtml(String(visibleQty))}</span>
      <span class="statusLead"> | Tiles = ${escapeHtml(String(visibleTiles))}</span>
      <span class="statusLead"> | Missing Prices = ${escapeHtml(String(missingPrices))}</span>
    </div>
    <div class="statusLine">
      <span class="statusTotal">Total Inventory Value = ${escapeHtml(formatCurrency(totalValue))}</span>${feeTag}
    </div>
  `;
}

function buildNotFoundMessage(profileInput) {
  return `<span class="statusError">Cannot find Steam User ${escapeHtml(profileInput)}! Try again.</span>`;
}

function isNotFoundError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("not found") ||
    msg.includes("could not resolve") ||
    msg.includes("unable to understand") ||
    msg.includes("specified profile could not be found")
  );
}

// ─── Grid Renderer ─────────────────────────────────────────────────────────────
function renderItems(items) {
  gridEl.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const it of items) {
    const card = document.createElement("div");
    card.className = `card ${getRarityClass(it)}`;

    const imgUrl = it.image_url || "";
    const title = getDisplayName(it);
    const { stickers, charm } = getAppliedCosmetics(it);

    card.innerHTML = `
      <div class="thumb">
        ${renderStickerColumn(stickers)}
        <div class="thumbMain">
          ${imgUrl
            ? `<img src="${escapeHtml(imgUrl)}" loading="lazy" />`
            : `<div class="noImg">No image</div>`}
        </div>
        ${renderDuplicateBadge(it)}
        ${renderCharmOverlay(charm)}
      </div>
      <div class="meta">
        <div class="metaContent">
          <div class="nameCentered">${escapeHtml(title)}</div>
          ${renderMetadata(it)}
        </div>
        ${renderPriceField(it)}
      </div>
    `;

    fragment.appendChild(card);
  }

  gridEl.appendChild(fragment);
}

// ─── Grid Click Delegation ─────────────────────────────────────────────────────
gridEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".infoBtn");
  if (btn) {
    const key = btn.dataset.itemKey;
    const item = lastRenderedMap.get(key);
    if (item) openPriceModal(item);
    return;
  }

  const logo = e.target.closest(".priceProviderLogoLink");
  if (logo) {
    const url = logo.dataset.marketUrl;
    if (url) window.cs2.openExternal(url);
  }
});

// ─── Refresh Display ───────────────────────────────────────────────────────────
function refreshDisplay() {
  const visibleRawItems = lastRawExtracted.filter(shouldDisplayInventoryItem);
  const enriched = enrichItems(visibleRawItems);
  const condensed = condenseDuplicateItems(enriched);

  const sorted = [...condensed].sort((a, b) => {
    const diff = getNumericPrice(b) - getNumericPrice(a);
    if (diff !== 0) return diff;
    return (a.market_hash_name || a.name || "").localeCompare(
      b.market_hash_name || b.name || ""
    );
  });

  lastRenderedMap.clear();
  for (const item of sorted) {
    const key = String(item.market_hash_name || "").trim().toLowerCase();
    if (key) lastRenderedMap.set(key, item);
  }

  if (lastResult) {
    setStatusHtml(buildStatusMessage(lastResult, lastProfileInput, sorted));
  }

  renderItems(sorted);
  renderMarketplaceRefreshBar();
  if (activeModalKind === "prices" && activePriceModalItemKey) {
    const activeItem = lastRenderedMap.get(activePriceModalItemKey);
    if (activeItem) openPriceModal(activeItem);
  }
}

// ─── Pull Inventory ────────────────────────────────────────────────────────────
function applyTrackingStateFromMain(state) {
  if (!state?.result || !Array.isArray(state.result.extracted)) return;

  lastResult = state.result;
  lastProfileInput = state.result.requestedProfile || lastProfileInput;
  lastRawExtracted = state.result.extracted;
  if (Array.isArray(state.enabledProviderIds) && state.enabledProviderIds.length) {
    enabledMarketplaceIds = new Set(state.enabledProviderIds);
  }
  for (const [id, timestamp] of Object.entries(state.nextRefreshAtById || {})) {
    marketplaceRefreshRemainingMsById.set(
      id,
      Math.max(0, Number(timestamp) - Date.now())
    );
  }
  for (const id of state.refreshedProviderIds || []) {
    refreshFlashUntilById.set(id, Date.now() + 1600);
  }

  applyProviderStates(state.result.providerStates);
  updateProviderErrors(lastRawExtracted);
  hideEmptyState();
  showGrid();
  refreshDisplay();
  syncRefreshUi();
}

async function pullInventory() {
  const profileInput = steamIdEl.value.trim();
  if (!profileInput) {
    setStatusText("Enter a SteamID or SteamID64 first.");
    return;
  }

  stopRefreshCountdown();
  pullBtn.disabled = true;
  startLoadingStatus();

  try {
    const result = await window.cs2.pullInventory(
      profileInput,
      [...enabledMarketplaceIds]
    );
    stopLoadingStatus();
    if (currentUiMode !== "dashboard") {
      return;
    }

    lastResult = result;
    lastProfileInput = profileInput;
    lastRawExtracted = Array.isArray(result?.extracted) ? result.extracted : [];

    applyProviderStates(result?.providerStates);
    updateProviderErrors(lastRawExtracted);

    hideEmptyState();
    showGrid();
    refreshDisplay();
    startRefreshCountdown();
    applyProviderStates(result?.providerStates);
    syncRefreshUi();
  } catch (err) {
    stopLoadingStatus();
    stopRefreshCountdown();
    lastRawExtracted = [];
    renderMarketplaceRefreshBar();

    if (isNotFoundError(err)) {
      setStatusHtml(buildNotFoundMessage(profileInput));
    } else {
      setStatusText(`Error: ${err?.message || String(err)}`);
    }

    showEmptyState();
    showGrid();
    gridEl.innerHTML = "";
  } finally {
    pullBtn.disabled = false;
  }
}

// ─── Top-Level Event Listeners ─────────────────────────────────────────────────
pullBtn.addEventListener("click", pullInventory);

steamIdEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") pullInventory();
});

window.cs2.onTrackingUpdated((state) => {
  if (currentUiMode === "dashboard") {
    applyTrackingStateFromMain(state);
  }
});

window.appWindow.onUiModeChanged((state) => {
  currentUiMode = state?.mode || "dashboard";
  if (currentUiMode !== "dashboard") {
    stopRefreshCountdown();
    return;
  }

  window.cs2.getTrackingState().then((trackingState) => {
    applyTrackingStateFromMain(trackingState);
    if (lastRawExtracted.length) startRefreshCountdown(false);
  }).catch(() => {});
});

// ─── Initial State ─────────────────────────────────────────────────────────────
hideGrid();
showEmptyState();
setStatusReady();
renderMarketplaceRefreshBar();
loadAppSettings().catch(() => {});
