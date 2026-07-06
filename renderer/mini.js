const trackedItemsEl = document.getElementById("trackedItems");
const portfolioValueEl = document.getElementById("portfolioValue");
const latestAlertEl = document.getElementById("latestAlert");
const topMoverEl = document.getElementById("topMover");
const lastUpdatedEl = document.getElementById("lastUpdated");
const providerStatusEl = document.getElementById("providerStatus");
const trackingStateEl = document.getElementById("trackingState");
const pauseTrackingBtn = document.getElementById("pauseTracking");

function formatMoney(value) {
  return Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : "--";
}

function formatUpdated(value) {
  if (!value) return "Not loaded";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatTopMover(mover) {
  if (!mover) return "No movement yet";
  const delta = Number(mover.delta);
  const sign = delta >= 0 ? "+" : "-";
  const percent = Number.isFinite(Number(mover.percent))
    ? ` (${sign}${Math.abs(Number(mover.percent)).toFixed(1)}%)`
    : "";
  return `${mover.marketHashName} ${sign}$${Math.abs(delta).toFixed(2)}${percent}`;
}

function formatProviderStatus(summary) {
  const now = Date.now();
  if (!Array.isArray(summary.providers) || !summary.providers.length) {
    return "No providers enabled";
  }
  return summary.providers.map((provider) => {
    if (Number(provider.pausedUntil) > now) return `${provider.name} paused`;
    if (summary.refreshingProviderIds?.includes(provider.id)) return `${provider.name} updating`;
    return provider.name;
  }).join(", ");
}

function renderSummary(summary) {
  const hasTracking = Boolean(summary?.hasTracking);
  trackedItemsEl.textContent = hasTracking ? String(summary.trackedItems) : "--";
  portfolioValueEl.textContent = hasTracking
    ? formatMoney(summary.portfolioValue)
    : "--";
  latestAlertEl.textContent = summary?.latestAlert || "No alert engine configured";
  topMoverEl.textContent = formatTopMover(summary?.topMover);
  lastUpdatedEl.textContent = formatUpdated(summary?.lastUpdatedAt);
  providerStatusEl.textContent = formatProviderStatus(summary || {});
  const paused = Boolean(summary?.paused);
  trackingStateEl.textContent = paused ? "PAUSED" : hasTracking ? "TRACKING" : "READY";
  trackingStateEl.classList.toggle("paused", paused);
  pauseTrackingBtn.textContent = paused ? "Resume" : "Pause";
}

document.getElementById("openDashboard").addEventListener("click", () => {
  window.appWindow.exitMiniMode();
});

pauseTrackingBtn.addEventListener("click", async () => {
  renderSummary(await window.cs2.toggleTrackingPaused());
});

document.getElementById("hideMini").addEventListener("click", () => {
  window.appWindow.hideMini();
});

window.cs2.onTrackingSummary(renderSummary);
window.cs2.getTrackingSummary().then(renderSummary).catch(() => {});
