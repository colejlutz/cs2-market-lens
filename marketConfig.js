(function exposeMarketConfig(root, factory) {
  const markets = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = markets;
  }

  if (root) {
    root.CS2_MARKET_CONFIG = markets;
  }
})(typeof window !== "undefined" ? window : null, function createMarketConfig() {
  const steamRefreshIntervalMs = (5 * 60 + 5) * 1000;
  const csfloatMinimumRefreshIntervalMs = 60 * 1000;
  const dmarketMinimumRefreshIntervalMs = 60 * 1000;

  return [
    {
      id: "steam-community",
      name: "Steam",
      logoPath: "../marketicons/steamlogo.png",
      sellerFeeMultiplier: 1 / 1.15,
      minimumRefreshIntervalMs: 1000,
      defaultRefreshIntervalMs: steamRefreshIntervalMs
    },
    {
      id: "csfloat",
      name: "CSFloat",
      logoPath: "../marketicons/csfloat.svg",
      sellerFeeMultiplier: 0.98,
      minimumRefreshIntervalMs: csfloatMinimumRefreshIntervalMs,
      defaultRefreshIntervalMs: Math.max(
        csfloatMinimumRefreshIntervalMs,
        steamRefreshIntervalMs
      )
    },
    {
      id: "dmarket",
      name: "DMarket",
      logoPath: "../marketicons/dmarket.png",
      sellerFeeMultiplier: 0.98,
      defaultSellerFeePercent: 2,
      sellerFeeConfigurable: true,
      minimumRefreshIntervalMs: dmarketMinimumRefreshIntervalMs,
      defaultRefreshIntervalMs: Math.max(
        dmarketMinimumRefreshIntervalMs,
        steamRefreshIntervalMs
      )
    }
  ];
});
