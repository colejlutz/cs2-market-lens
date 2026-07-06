const provider = {
  id: "template",
  displayName: "Template Price Provider",
  status: "template",

  canHandleItem(item) {
    return Boolean(item && item.market_hash_name);
  },

  buildLookupContext(item) {
    return {
      marketHashName: item?.market_hash_name || null,
      itemName: item?.name || null,
      steamId64: item?.steamId64 || null
    };
  },

  async getPriceData(item, options = {}) {
    const context = this.buildLookupContext(item);

    return {
      providerId: this.id,
      providerName: this.displayName,
      success: false,
      live: false,
      price: null,
      currency: options.currency || "USD",
      url: null,
      lastUpdated: null,
      error: "Template provider only. Replace this file with real provider logic.",
      context
    };
  },

  normalizePriceResult(rawResult) {
    return {
      providerId: rawResult?.providerId || this.id,
      providerName: rawResult?.providerName || this.displayName,
      success: Boolean(rawResult?.success),
      live: Boolean(rawResult?.live),
      price: rawResult?.price ?? null,
      currency: rawResult?.currency || "USD",
      url: rawResult?.url || null,
      lastUpdated: rawResult?.lastUpdated || null,
      error: rawResult?.error || null,
      context: rawResult?.context || null
    };
  }
};

module.exports = provider;