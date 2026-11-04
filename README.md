# pnpm 12.8.0: Azure Artifacts dedupe regression

This repository reproduces a slowdown in `pnpm dedupe --lockfile-only` when using an Azure Artifacts (ADO) npm registry. Between **12.7.0 and 12.8.0**, dedupe time against ADO increases from **1.2 s to 14.0 s**, while npmjs stays near **0.4 s**.

## Results

The slowdown column compares ADO with npmjs for the **same pnpm version**.

| pnpm | npmjs | Azure Artifacts | ADO vs npmjs |
|---|---:|---:|---:|
| 12.7.0 | 0.4 s | 1.2 s | 2.7X slower |
| **12.8.0** | **0.4 s** | **14.0 s** | **31.4X slower** |
| 12.16.1 (latest 12.x tested) | 1.9 s | 12.1 s | 6.4X slower |
| 11.23.0 | 1.2 s | 3.6 s | 2.9X slower |
| 11.24.0 | 1.2 s | 2.7 s | 2.2X slower |
| 11.25.0 | 1.4 s | 2.5 s | 1.8X slower |
| 11.26.0 | 1.4 s | 2.9 s | 2.1X slower |
| **11.27.0** | **1.5 s** | **2.4 s** | **1.6X slower** |
| **11.27.1** | **3.6 s** | **13.3 s** | **3.7X slower** |
| 11.28.0 | 3.3 s | 13.1 s | 3.9X slower |
| 11.28.1 | 2.9 s | 15.8 s | 5.4X slower |
| 11.28.9 (latest 11.x tested) | 1.3 s | 16.0 s | 12.5X slower |

The ADO/npmjs gap jumps from **2.7X to 31.4X** in 12.8.0. The latest 12.x tested has not recovered the earlier ADO performance; its smaller ratio also reflects npmjs getting slower.

pnpm 11 has a separate, earlier regression at **11.27.0 to 11.27.1**: ADO becomes **5.5X slower** in absolute time, before the cache-control change in 11.28.1.

The 11.23.0 recheck remains fast, but does **not** exactly reproduce the historical 1.4 s npmjs / 2.7 s ADO result (2.0X). Today's ADO median is about 32% higher, with a 2.9X gap. Absolute timings vary, but that does not explain the much larger release-boundary jump.

## pnpm 11.27.1: lockfile preferences disable a cache shortcut

[pnpm/pnpm#15180: converge after direct dependency bumps](https://github.com/pnpm/pnpm/pull/15180) first shipped in [11.27.1](https://github.com/pnpm/pnpm/releases/tag/v11.27.1), released September 20, 2026. It changes dedupe's lockfile preference weight from **1,000,000 to 1**.

The stable-range metadata-cache shortcut introduced by [pnpm/pnpm#13980](https://github.com/pnpm/pnpm/pull/13980) requires a lockfile preference weight of [at least 1,000,000](https://github.com/pnpm/pnpm/blob/v11.27.1/pnpm11/resolving/npm-resolver/src/pickPackageFromMeta.ts#L238-L257). Lowering the weight disables that shortcut during dedupe, increasing registry metadata work. This change affects the TypeScript pnpm 11 implementation, not pnpm 12.

Restoring only the old weight in an isolated 11.27.1 build brought ADO back from **14.0 s to 3.8 s**, confirming the mechanism. This is a diagnostic, not a proposed fix: simply reverting the weight risks reintroducing the dedupe correctness bug that pnpm/pnpm#15180 fixed.

## pnpm 12.8.0 / 11.28.1: cache-control change

[pnpm/pnpm#15722: refetch registry metadata when caching is forbidden](https://github.com/pnpm/pnpm/pull/15722) first shipped in [12.8.0](https://github.com/pnpm/pnpm/releases/tag/v12.8.0) and [11.28.1](https://github.com/pnpm/pnpm/releases/tag/v11.28.1), both released September 28, 2026.

ADO returns **`Cache-Control: no-cache` without an ETag** for package metadata (a "packument"). This change marks that metadata as uncacheable and bypasses pnpm's on-disk cache shortcuts during normal online resolution, fetching the metadata again even when the cache is warm. npmjs instead returns `Cache-Control: public, max-age=300` and an ETag.

The same releases include [pnpm/pnpm#15879](https://github.com/pnpm/pnpm/pull/15879), which reuses ETag-less metadata for five minutes. That optimization excludes metadata marked uncacheable, so it does not help this ADO feed.

The release boundary and cache behavior point to pnpm/pnpm#15722, but this is not an isolated bisect of that PR; other changes shipped in the same releases.

### Inspect the ADO response

This public feed requires no authentication. Download a packument, discard its body, and display the relevant response headers:

```sh
curl -fsS -D - -o /dev/null \
  -H 'Accept: application/vnd.npm.install-v1+json' \
  'https://ms-feed-12.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/source-map' \
  | grep -Ei '^(HTTP/|cache-control:|etag:|last-modified:)'
```

Observed October 28, 2026:

```text
HTTP/2 200
cache-control: no-cache
```

There was no `ETag` or `Last-Modified` response header.

## Methodology

Measured October 28, 2026, on macOS arm64, Apple M5 Max, Node.js 24.16.0. The latest versions were selected from npm's `latest-11` and `latest-12` dist-tags on that date.

Timed the wall-clock duration of:

```sh
pnpm dedupe --lockfile-only
```

Each version/registry combination used the checked-in dependency manifest and the same starting lockfile, restored before every invocation, with its own metadata cache and initially empty store. The exact pnpm version was verified and matched the fixture's `packageManager`. No dependencies were installed; `minimumReleaseAge` was zero, and neither `offline` nor `preferOffline` was enabled.

The table shows medians of **at least three runs after a cold-cache warmup**, with cache-file timestamps set ten minutes old before each run. The 11.23.0 and 11.27.1 rows include all six retained samples per registry, combining the bisection and confirmation runs. All seven stable releases from 11.23.0 through 11.28.0 were measured, including releases skipped by the binary search. The 11.28.0 row replaces an earlier measurement with this fresh bisection result.

For the pnpm 12 regression, additional runs with fresh timestamps showed the same slowdown, so running dedupe again within five minutes does not avoid it. Runs were serial, with registry order alternated.

The isolated 11.27.1 diagnostic changed only the lockfile preference weight and used three runs per registry, interleaved with stock 11.27.1 and 11.23.0 rechecks. Stock and modified builds produced identical output lockfiles for each registry. The number of metadata cache files rewritten fell from 1,099 to 11; these are filesystem observations, not HTTP request counts.

Times and ratios are rounded to one decimal place; ratios use the unrounded medians. Samples with explicit network retry warnings were replaced, but slow samples without warnings were retained. ADO timings on 12.16.1 varied from 10.2 s to 21.4 s.

The project's `packageManager` pins 12.8.0, the first pnpm 12 release affected by the cache-control regression.
