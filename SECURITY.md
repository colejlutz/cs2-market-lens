# Security Policy

## Supported Versions

Security fixes will be applied to the latest published version of CS2 Market
Lens. Pre-release builds may change without backward-compatibility guarantees.

## Reporting a Vulnerability

Please report security issues privately through GitHub's private vulnerability
reporting feature once it is enabled for this repository. Do not include API
keys, access tokens, account details, or other secrets in a public issue.

If private vulnerability reporting is unavailable, contact the repository
owner privately before disclosing technical details.

## Credential Handling

The application does not request marketplace passwords. Optional API keys are
stored using Electron `safeStorage` when operating-system encryption is
available and are not intentionally written to project files or logs.
