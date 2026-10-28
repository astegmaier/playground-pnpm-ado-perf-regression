# pnpm 12.8.0: Azure Artifacts dedupe regression

This repository reproduces a slowdown in `pnpm dedupe --lockfile-only` when using an Azure Artifacts (ADO) npm registry. Between **12.7.0 and 12.8.0**, dedupe time against ADO increases from **1.2 s to 14.0 s**, while npmjs stays near **0.4 s**.

## Results

The slowdown column compares ADO with npmjs for the **same pnpm version**.

| pnpm | npmjs | Azure Artifacts | ADO vs npmjs |
|---|---:|---:|---:|
| 12.7.0 | 0.4 s | 1.2 s | 2.7X slower |
| **12.8.0** | **0.4 s** | **14.0 s** | **31.4X slower** |
| 12.16.1 (latest 12.x tested) | 1.9 s | 12.1 s | 6.4X slower |
| 11.28.0 | 2.9 s | 13.5 s | 4.6X slower |
| 11.28.1 | 2.9 s | 15.8 s | 5.4X slower |
| 11.28.9 (latest 11.x tested) | 1.3 s | 16.0 s | 12.5X slower |

The ADO/npmjs gap jumps from **2.7X to 31.4X** in 12.8.0. The latest 12.x tested has not recovered the earlier ADO performance; its smaller ratio also reflects npmjs getting slower. pnpm 11 was already slow before 11.28.1 and does not show the same sharp regression.

## Likely cause

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

The table shows medians of **three runs after a cold-cache warmup**, with cache-file timestamps set ten minutes old before each run. Additional runs with fresh timestamps showed the same regression, so running dedupe again within five minutes does not avoid it. Runs were serial, with registry order alternated.

Times and ratios are rounded to one decimal place; ratios use the unrounded medians. Samples with explicit network retry warnings were replaced, but slow samples without warnings were retained. ADO timings on 12.16.1 varied from 10.2 s to 21.4 s.

[Raw results](results/2026-10-28T16-04-18.180Z.json) preserve all timings and retry warnings. The project's `packageManager` pins 12.8.0, the first affected release.
