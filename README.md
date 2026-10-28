# pnpm 12.8.0: Azure Artifacts dedupe regression

This playground isolates the warm-cache `pnpm dedupe --lockfile-only` slowdown between **12.7.0 and 12.8.0** against a public Azure Artifacts (ADO) npm feed. It uses the dependency fixture from [playground-pnpm-ado-benchmarks](https://github.com/astegmaier/playground-pnpm-ado-benchmarks), with npmjs as the control.

**Confirmed October 28, 2026:** the aged-cache ADO median rises from **1.151 s to 14.045 s (12.2x)**, while npmjs stays near 0.4 s. The latest 12.x release, **12.16.1**, still takes **12.112 s** against ADO in this fixture.

The matching change in pnpm 11 first shipped in **11.28.1**. The first affected releases, [11.28.1](https://github.com/pnpm/pnpm/releases/tag/v11.28.1) and [12.8.0](https://github.com/pnpm/pnpm/releases/tag/v12.8.0), were published on **September 28, 2026**. Both include [pnpm/pnpm#15722: refetch registry metadata when caching is forbidden](https://github.com/pnpm/pnpm/pull/15722). Its merge commit is absent from 11.28.0 and 12.7.0 and present in 11.28.1 and 12.8.0.

| Branch | Immediately before the change | First release with the change | Latest tested, October 28, 2026 |
|---|---|---|---|
| 11.x | 11.28.0 | 11.28.1 | 11.28.9 |
| 12.x | 12.7.0 | 12.8.0 | 12.16.1 |

The latest versions were resolved from npm's `latest-11` and `latest-12` dist-tags on the measurement date; both were published on October 27, 2026.

## Results

Measured October 28, 2026, on macOS arm64, Apple M5 Max, 18 available CPU cores, Node.js 24.16.0. All numbers are **median wall-clock seconds**, lower is better. Each cell has three successful samples without explicit retry warnings, after a separate cold-cache warmup.

| pnpm | npmjs, fresh cache | ADO, fresh cache | npmjs, aged cache | ADO, aged cache |
|---|---:|---:|---:|---:|
| 11.28.0 | 3.751 | 13.613 | 2.907 | 13.482 |
| 11.28.1 | 2.822 | 15.724 | 2.938 | 15.837 |
| 11.28.9 (latest 11.x) | 1.308 | 16.908 | 1.285 | 16.019 |
| 12.7.0 | 0.438 | 1.154 | 0.428 | 1.151 |
| 12.8.0 | 0.669 | 13.446 | 0.447 | 14.045 |
| 12.16.1 (latest 12.x) | 1.813 | 11.161 | 1.903 | 12.112 |

**12.7.0 to 12.8.0:** ADO slows **11.7x with fresh metadata** and **12.2x with aged metadata**. The similar fresh/aged results show that rerunning within five minutes does not avoid the regression.

**11.28.0 to 11.28.1:** ADO's aged-cache median increases about **17.5%**, not an order of magnitude: 11.28.0 was already slow. The change first shipped in 11.28.1, but this fixture does not show the same dramatic before/after cliff on pnpm 11.

**Latest releases:** neither restores the 12.7.0 ADO performance. Latest 12.x is still **10.5x** slower than 12.7.0 in the aged-cache case. Its ADO samples also vary substantially, from 10.170 to 21.441 s; all are retained because none logged an explicit retry. The npmjs timings in 12.16.1 are also higher than in 12.8.0, so that later version is not a pure measurement of the ADO-specific change.

<details>
<summary>Individual samples in seconds</summary>

| pnpm | Cache condition | npmjs | ADO |
|---|---|---|---|
| 11.28.0 | Fresh | 3.751 / 4.326 / 3.639 | 12.858 / 13.613 / 13.980 |
| 11.28.0 | Aged | 3.052 / 2.715 / 2.907 | 13.482 / 13.016 / 13.746 |
| 11.28.1 | Fresh | 2.822 / 3.079 / 2.776 | 15.879 / 15.558 / 15.724 |
| 11.28.1 | Aged | 3.034 / 2.938 / 2.796 | 16.094 / 15.837 / 15.471 |
| 11.28.9 | Fresh | 1.264 / 1.338 / 1.308 | 17.229 / 16.908 / 14.901 |
| 11.28.9 | Aged | 1.251 / 1.285 / 1.308 | 16.019 / 16.062 / 15.336 |
| 12.7.0 | Fresh | 0.438 / 0.535 / 0.436 | 0.826 / 1.154 / 1.360 |
| 12.7.0 | Aged | 0.405 / 0.451 / 0.428 | 1.355 / 0.701 / 1.151 |
| 12.8.0 | Fresh | 0.698 / 0.669 / 0.403 | 13.446 / 13.367 / 14.998 |
| 12.8.0 | Aged | 0.417 / 0.447 / 0.476 | 14.045 / 13.457 / 18.443 |
| 12.16.1 | Fresh | 1.813 / 1.854 / 1.800 | 18.461 / 11.161 / 11.095 |
| 12.16.1 | Aged | 1.903 / 1.819 / 1.937 | 10.170 / 21.441 / 12.112 |

</details>

[Raw results](results/2026-10-28T16-04-18.180Z.json) contain **89 invocations**: 12 warmups, 72 retained timed samples, and five additional timed samples excluded from medians because they explicitly logged retries. The excluded ADO fresh-cache samples were 40.426 s on 11.28.0, and 26.026 / 25.158 / 25.052 / 25.089 s on 11.28.9, with connection resets, HTTP 429s, or HTTP 503s. Each affected group received replacements. No slow sample was removed merely for being slow.

## Why this feed is affected

The feed returns **`Cache-Control: no-cache` without an ETag** for package metadata (a "packument"). PR [pnpm/pnpm#15722](https://github.com/pnpm/pnpm/pull/15722/files) records an `uncacheable: true` flag for responses with `no-cache`, `no-store`, or `max-age=0`. Subsequent normal online resolution bypasses those on-disk metadata entries and refetches them rather than taking the cached exact-version or stable-range shortcut. A warm metadata cache therefore no longer makes this workload cheap.

This is pnpm's response to the header, not a claim that the HTTP `no-cache` directive prohibits storing responses. The change intentionally prioritizes seeing newly published versions over pnpm's previous reuse behavior.

The same releases also include [pnpm/pnpm#15879](https://github.com/pnpm/pnpm/pull/15879), which reuses ETag-less metadata for five minutes. **That shortcut excludes metadata marked uncacheable**, so it does not help this ADO feed, even when dedupes run seconds apart. The fresh/aged measurements above check both sides of that window. npmjs instead supplies an ETag and `Cache-Control: public, max-age=300`.

The release boundary, response headers, and source-level cache gate strongly implicate pnpm/pnpm#15722. These are released-version comparisons, not isolated cherry-pick or bisect builds; other changes shipped in the same releases.

### Inspect the actual response headers

This is a **GET**, not a HEAD request; the metadata body is downloaded but discarded. The feed is public and requires no credentials.

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

There was no `ETag` or `Last-Modified` response header. For comparison:

```sh
curl -fsS -D - -o /dev/null \
  -H 'Accept: application/vnd.npm.install-v1+json' \
  'https://registry.npmjs.org/source-map' \
  | grep -Ei '^(HTTP/|cache-control:|etag:|last-modified:)'
```

The npmjs response included `Cache-Control: public, max-age=300`, an ETag, and `Last-Modified`. The abbreviated npmjs body was 46,258 bytes versus 165,953 bytes from ADO for this package, so repeated full metadata downloads are not equivalent in cost.

## Reproduce the benchmark

Run with Node.js 24 and `tar` available; no dependency installation or ADO authentication is needed:

```sh
node benchmark.mjs
```

The runner always tests 11.28.0, 11.28.1, 12.7.0, and 12.8.0, plus the latest stable versions on the 11.x and 12.x dist-tags at run time. It downloads the pnpm 11 Node CLI and the platform-specific pnpm 12 native executable, verifies each tarball's integrity and executable version, and invokes those binaries directly. Each fixture's `packageManager` is set to the version under test, preventing the root project's 12.8.0 pin from selecting the wrong version.

The runner:

- Uses the same manifest and seed lockfile for every invocation, restoring the lockfile before warmups and measurements so an earlier dedupe cannot make the next input easier.
- Isolates the project, metadata cache, and initially empty store per version and registry. No `node_modules` is installed; this measures lockfile dedupe, not tarball installation.
- Sets `minimumReleaseAge: 0`, uses normal online resolution, and does not enable `offline` or `preferOffline`.
- Performs one cold-cache warmup per version/registry (excluded from the summary), then collects at least **three successful, explicit-retry-free timings per registry and cache-age condition**.
- Runs cases serially and alternates registry order. External wall time includes pnpm startup, resolution, and lockfile writing, but excludes downloads, setup, and cache timestamp changes.
- Sets cache-file mtimes to the current time before each **fresh** invocation, or ten minutes ago before each **aged** invocation. Bodies and recorded response headers are retained; only timestamps change.
- Retains retry-affected samples and warnings in the JSON but replaces them for the median. Slow samples without explicit retry warnings are retained.
- Saves timestamped JSON under `results/`, including every timing, output lockfile hashes, executable integrity, current dist-tags, environment, and live header probes.
- Creates temporary fixtures under `~/projects/pnpm-ado-regression-*` and explicitly removes its own temporary directory when finished, including on an error.

The checked-in lockfile deliberately uses the compatible v9 seed format so both pnpm 11 and 12 can read it. Its SHA-256 is `2fd1e39f5936125ea757d517d2c15893fdd22e54dd49813143e2495cbb5a52d6`. The root `packageManager` pins the first affected release, 12.8.0, for manual reproduction; the automated matrix does not modify the root manifest or lockfile.
