# Dependency and build maintenance, 15 October 2026

Implements review finding S8 and the build-time Google Fonts dependency.
These changes are ready for review but the patched dependency installation
has not been validated in this environment.

## Changes

| Package | Previous declared version | New pinned version |
| --- | --- | --- |
| Next.js | 16.2.10 | 16.4.1 |
| eslint-config-next | 16.2.10 | 16.4.1 |
| React and react-dom | 19.2.4 | 19.3.1 |
| MCP SDK | ^1.0.0, locked 1.30.0 | 1.32.1 |
| PGlite, development only | absent | 0.5.10 |

Both lockfiles contain registry tarball URLs and integrity hashes. Cached
registry metadata was used because registry requests currently return HTTP
503. The root lockfile was missing @emnapi/core and @emnapi/runtime entries;
those entries were restored from the cached registry metadata before npm
regenerated the lockfile. MCP package entries were similarly updated from
cached metadata and npm validated the resulting dependency tree.

Affected transitive packages were updated within their existing major
versions: baseline-browser-mapping 2.11.28, postcss 8.5.30, source-map-js
1.2.2, fast-uri 3.1.8, hono 4.13.13, ip-address 10.7.4, proxy-addr 2.0.8
and qs 6.16.0. Next's new tree also selects sharp 0.35.5. No automated
major-version downgrade or blanket audit fix was applied.

The previously recorded production audit advisory ranges no longer match
any package versions in the target lockfiles. This is a comparison against
the saved advisory data, not a fresh audit or proof that all advisories
are fixed. The SDK OAuth-client issue is not proven reachable through this
application's stdio server, and several Next issues depend on specific
hosting or image-processing paths. These prerequisites do not justify
keeping outdated packages.

## Fonts

`app/layout.tsx` now uses `next/font/local`. The original Hanken Grotesk,
Spectral and Geist Mono Latin font files are committed in `app/fonts`, with
copyright notices, SIL Open Font License 1.1 and SHA-256 checksums. They are
unmodified copies of the app's existing downloaded font assets. Font family
variables and weights remain the same. Other character sets use system
fallbacks. Production compilation no longer needs Google Fonts access.

## Validation and remaining gate

- Both target lockfiles pass `npm ci --dry-run --offline` consistency checks.
- Real clean `npm ci` runs were attempted in empty temporary projects with
  the committed manifests and lockfiles. The registry returned HTTP 503 for
  required artifacts, including scheduler 0.28.0 and qs 6.16.0. Neither clean
  installation completed. Offline attempts also fail because these new
  artifacts are absent from the cache.
- Fresh `npm audit --omit=dev` also returned HTTP 503. No clean-audit claim
  is made.
- The final integration production build passed using the existing installed
  Next 16.2.10, including local fonts, TypeScript checking and page generation.
  The earlier intermediate dispatcher type error was resolved. See the
  [final integration results](../CLAUDE_HANDOFF_2026-10-15.md#final-integration-results).
- MCP compilation passed using the existing installed SDK 1.30.0. This does
  not establish compatibility with the target SDK 1.32.1.
- For local SQL regression tests, the exact already-cached PGlite 0.5.10
  package was copied into root `node_modules`. It is also declared and
  locked as a dev dependency so normal installation supplies it. PGlite is
  PostgreSQL 18, whereas deployed Supabase is configured for PostgreSQL 17;
  synthetic SQL tests do not replace Supabase integration tests.

Before deployment, use a working npm registry connection and run:

```sh
npm ci
npm --prefix mcp-server ci
npm audit --omit=dev
npm --prefix mcp-server audit --omit=dev
npm run lint
npx tsc --noEmit
node --test scripts/*.test.ts
npm run build
npm --prefix mcp-server run build
```

Run production builds with the intended environment configuration. Review
any newly reported advisories and execute the authenticated smoke tests
before deploying. Do not use `--package-lock=false` as the standard setup
path now that lockfile consistency has been repaired. Nothing was deployed.
