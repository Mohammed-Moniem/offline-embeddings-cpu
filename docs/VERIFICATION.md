# Release verification

The acceptance target is the complete extracted platform ZIP. Passing source tests alone does not establish an offline or portable release.

## Source and model checks

On each target build runner:

```sh
npm ci
node scripts/audit-dependencies.mjs
npm test
npm run fetch:model
node scripts/verify.mjs --output dist/source-verification.json
node scripts/bundle.mjs --output dist
```

Unit tests exercise update/delete consistency, unchanged-document caching, model identity checks, collection filtering, and parameter validation. The real-model verifier checks actual 384-dimensional normalized vectors and meaningful retrieval using BGE's configured pooling/prompt policy. It also checks persistence and mutations rather than reporting a successful model load as sufficient.

## Exact-archive checks

For macOS Apple Silicon:

```sh
node scripts/verify-bundle.mjs \
  --archive dist/offline-embeddings-cpu-1.0.0-darwin-arm64.zip \
  --output dist/verification-darwin-arm64.json
```

For Windows x64 on an isolated administrator-enabled test runner:

```bat
node scripts/verify-bundle.mjs --archive dist/offline-embeddings-cpu-1.0.0-win32-x64.zip --output dist/verification-win32-x64.json --firewall
```

The verifier extracts into a new path containing spaces, uses only the bundled Node executable, supplies empty external caches and a restricted PATH, applies OS-level network denial, and tests the extracted package. It must also establish that an attempted network connection fails. A missing or ineffective network-denial mechanism is a verification failure, not a silently skipped check.

The report records the archive hash, platform/architecture, Node version, test results, and timing/memory measurements. On Windows it also verifies each loaded Microsoft CRT DLL against the bundle manifest's approved file location and SHA-256, rejecting accidental reliance on a preinstalled system copy. These timings describe that runner, not the user's corporate laptop. The release workflow waits for both target jobs to pass before publishing assets.

## Destination check

The tested runner does not reproduce every corporate endpoint restriction. After transfer, run `doctor` and `demo` with the network unavailable and under the normal user account. The installation may be read-only; its database directory must be writable. Test a representative authorized document set before replacing an existing retrieval path.

If any runtime dependency is unavailable, document it in the report and resolve it before calling the package complete. Do not substitute an installer/bootstrapper or source-only archive for the promised ready-to-run package.
