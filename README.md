# pnpm dedupe: registry metadata regressions

`pnpm dedupe --lockfile-only` has distinct npmjs and Azure Artifacts (ADO) slowdowns.

Times are median seconds; **ADO/npmjs** compares same-version registries, not versions against baselines.

## pnpm 11.x

| pnpm | npmjs | ADO | ADO/npmjs | Change |
|---|---:|---:|---:|---|
| 11.27.0 | 1.3 s | 2.4 s | 1.8X | |
| **11.27.1** | **3.0 s** | **13.7 s** | **4.5X** | Lower lockfile weights disable a metadata-cache shortcut, slowing both registries: [1](#1-lockfile-preferences-disable-cache-reuse) |
| 11.28.0 | 2.8 s | 13.4 s | 4.7X | |
| **11.28.1** | 2.8 s | **15.7 s** | **5.7X** | Honor `no-cache`: refetch ADO metadata instead of reusing it, further slowing ADO: [2](#2-no-cache-responses-bypass-metadata-shortcuts) |
| 11.28.6 | 2.9 s | 16.4 s | 5.7X | |
| **11.28.7** | **1.2 s** | 16.9 s | 14.2X | New version-dominance proof restores npmjs cache reuse and speed; ADO stays slow: [3](#3-cache-reuse-restored-for-npmjs) |
| 11.28.9 | 1.2 s | 16.3 s | 14.0X | |

## pnpm 12.x

| pnpm | npmjs | ADO | ADO/npmjs | Change |
|---|---:|---:|---:|---|
| 12.7.0 | 0.5 s | 0.9 s | 1.6X | |
| **12.8.0** | 0.5 s | **14.2 s** | **28.5X** | Honor `no-cache`: refetch ADO metadata instead of reusing it, sharply slowing ADO: [2](#2-no-cache-responses-bypass-metadata-shortcuts) |
| 12.15.0 | 0.5 s | 14.4 s | 29.3X | |
| **12.16.0** | **2.0 s** | 14.4 s | 7.3X | Refresh metadata during dedupe: npmjs now revalidates cached responses, adding network round trips: [4](#4-online-dedupe-refreshes-metadata) |
| 12.16.1 | 1.8 s | 14.3 s | 8.0X | |

## Causes and recovery

### 1. Lockfile preferences disable cache reuse

[pnpm/pnpm#15180](https://github.com/pnpm/pnpm/pull/15180) (**11.27.1**) lowers dedupe's lockfile preference weight from 1,000,000 to 1, disabling the weight-gated metadata shortcut. Restoring only the weight reduces npmjs **3.0 s to 1.2 s**, ADO **13.7 s to 2.6 s**. This diagnostic reverses a correctness fix; it is not a recommended workaround.

### 2. `no-cache` responses bypass metadata shortcuts

[pnpm/pnpm#15722](https://github.com/pnpm/pnpm/pull/15722) (**11.28.1 / 12.8.0**) blocks online metadata shortcuts for `no-cache` responses. ADO returns `no-cache` without ETag/Last-Modified, forcing full fetches; npmjs provides cacheable metadata and validators. Cause 1 already slowed ADO on 11.x.

Clearing only 11.28.1's uncacheable flag reduces ADO **15.7 s to 13.8 s**. [pnpm/pnpm#15879](https://github.com/pnpm/pnpm/pull/15879)'s five-minute optimization excludes uncacheable responses; fresh-cache probes retain the slowdown.

### 3. Cache reuse restored for npmjs

[pnpm/pnpm#17090](https://github.com/pnpm/pnpm/pull/17090) (**11.28.7**) replaces the weight threshold with proof that a preferred version must win, restoring cache reuse. Disabling only that proof increases npmjs **1.2 s to 2.8 s**. ADO's `no-cache` restriction remains.

### 4. Online dedupe refreshes metadata

[pnpm/pnpm#17215](https://github.com/pnpm/pnpm/pull/17215) (**12.16.0**) deliberately refreshes metadata during online dedupe, including deprecation notices. npmjs `304 Not Modified` responses still require round trips; ADO already fetched metadata. `--prefer-offline` reduces npmjs to **0.2 s** but changes freshness semantics.

## Methodology

Three successful, serial runs per version/registry after warmup: Apple M5 Max/macOS arm64, Node.js 24.16.0; verified published pnpm 11 JavaScript/pnpm 12 native binaries; isolated caches/stores; identical checked-in manifest/starting lockfile restored each run; cache timestamps aged ten minutes; `minimumReleaseAge: 0`; offline options disabled. Ratios use unrounded medians. Explicit network-retry runs were replaced; other slow runs retained. Live timings vary.

pnpm 11 controls isolate code changes; pnpm 12 attribution uses release boundaries, source and network-policy controls, not an isolated Rust revert. Diagnostics preserve corresponding version/registry output lockfiles, not equality across releases. The fixture pins 12.8.0; select exact table versions and `https://registry.npmjs.org/` or the public ADO registry below.

Inspect ADO headers without authentication:

```sh
curl -fsS -D - -o /dev/null \
  -H 'Accept: application/vnd.npm.install-v1+json' \
  'https://ms-feed-12.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/source-map' \
  | grep -Ei '^(HTTP/|cache-control:|etag:|last-modified:)'
```
