# CS2 Market Lens

CS2 Market Lens is a local-first Electron desktop application for loading a
Counter-Strike 2 inventory, comparing current marketplace prices, and
estimating its total value.

The current version focuses on fast inventory valuation. It supports Steam
Community Market, CSFloat, and DMarket pricing while keeping provider
credentials and application settings on the user's computer.

## Current Features

- Loads a public CS2 inventory from a Steam profile or SteamID64.
- Compares current prices across enabled marketplace providers.
- Supports Steam Community Market, CSFloat, and DMarket.
- Recalculates the cheapest enabled marketplace for each item.
- Shows estimated seller proceeds using provider-specific fee settings.
- Uses provider queues, caches, refresh intervals, and rate-limit backoff.
- Stores optional API keys with Electron's encrypted `safeStorage` API.
- Includes full dashboard, mini tracker, tray, and background-only UI modes.
- Keeps recurring provider scheduling in the Electron main process.

## Screenshots

Project screenshots will be added before the first public release.

## Requirements

- Windows 10 or Windows 11 for the currently targeted desktop experience.
- Node.js and npm when running from source.
- A public Steam inventory.
- A CSFloat API key when CSFloat pricing is enabled.

DMarket current-price requests are currently public and do not require account
credentials. A Steam Web API key is optional; the existing Steam inventory and
market-loading path remains available without account login.

## Run From Source

```powershell
npm ci
npm start
```

Run the automated tests with:

```powershell
npm test
```

## API-Key Privacy

CS2 Market Lens never asks for or stores Steam, CSFloat, or DMarket passwords.
Optional API keys are persisted through Electron `safeStorage` when encryption
is available. Secrets, local settings, caches, and future local database files
are excluded from the repository.

Marketplace requests are sent directly from the application to their
respective providers. Users are responsible for following each provider's API
terms and rate limits.

## Project Structure

```text
priceProviders/   Marketplace-specific price integrations
renderer/         Dashboard and mini-tracker interfaces
services/         Pricing orchestration and local settings
test/             Node.js automated tests
main.js           Electron windows, tray, IPC, and background scheduler
preload.js        Narrow renderer-to-main API bridge
steamApi.js       Steam profile and inventory loading
```

## Roadmap

The following features are planned but are not implemented yet:

- SQL-backed compact price history
- Configurable price and portfolio alerts
- Portfolio movement and profit/loss tracking
- Historical charts and marketplace analysis tools
- Signed Windows installers and an automated release workflow

## Release Status

There is not yet an official downloadable installer. When releases begin,
Windows installers will be published through the repository's **Releases**
page rather than committed to the source tree.

## Disclaimer

This project is not affiliated with or endorsed by Valve Corporation, Steam,
CSFloat, or DMarket. Counter-Strike, Steam, and marketplace names and logos are
the property of their respective owners. Prices and post-fee values are
estimates and may differ from completed transactions.

## License

No open-source license has been selected yet. Until a license is added, normal
copyright restrictions apply.
