const templatePriceProvider = require("./templatePriceProvider");
const steamCommunityProvider = require("./steamCommunity");
const csfloatProvider = require("./csfloat");
const dmarketProvider = require("./dmarket");

function getEnabledPriceProviders() {
  return [
    steamCommunityProvider,
    csfloatProvider,
    dmarketProvider,
    templatePriceProvider
  ];
}

module.exports = {
  getEnabledPriceProviders
};
