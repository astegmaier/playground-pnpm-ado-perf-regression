import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const seed = await fs.readFile(path.join(root, 'pnpm-lock.yaml'))
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const feeds = {
  npmjs: 'https://registry.npmjs.org/',
  ado: 'https://ms-feed-12.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/',
}
const startedAt = new Date().toISOString()
const output = path.join(root, 'results', `${startedAt.replaceAll(':', '-')}.json`)
await fs.mkdir(path.dirname(output), { recursive: true })

async function get(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`${response.status}: ${url}`)
  return response
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 240000, maxBuffer: 20 * 1024 * 1024, ...options,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

async function cacheFiles(directory) {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await cacheFiles(filename))
    else if (entry.isFile()) files.push(filename)
  }
  return files
}

const metadata = await (await get('https://registry.npmjs.org/pnpm')).json()
const latest11 = metadata['dist-tags']['latest-11']
const latest12 = metadata['dist-tags']['latest-12']
if (!/^11\.\d+\.\d+$/.test(latest11) || !/^12\.\d+\.\d+$/.test(latest12)) {
  throw new Error('Missing or unexpected latest-11/latest-12 dist-tags')
}
const versions = [...new Set(['11.28.0', '11.28.1', latest11, '12.7.0', '12.8.0', latest12])]
const results = {
  startedAt, node: process.version, platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0].model, availableParallelism: os.availableParallelism(),
  command: 'dedupe --lockfile-only', minimumReleaseAge: 0,
  dependenciesSha256: sha256(JSON.stringify({ dependencies: manifest.dependencies, devDependencies: manifest.devDependencies })),
  seedLockfileSha256: sha256(seed), feeds, versions,
  latest11, latest12, publishedAt: Object.fromEntries(versions.map(v => [v, metadata.time[v]])),
  binaries: {}, headers: {}, runs: [],
}
const save = () => fs.writeFile(output, JSON.stringify(results, null, 2) + '\n')

for (const [feed, registry] of Object.entries(feeds)) {
  const response = await get(`${registry}source-map`, { Accept: 'application/vnd.npm.install-v1+json' })
  results.headers[feed] = {
    url: response.url, status: response.status, checkedAt: new Date().toISOString(),
    cacheControl: response.headers.get('cache-control'), etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    bytes: (await response.arrayBuffer()).byteLength,
  }
}
await save()

const scratch = await fs.mkdtemp(path.join(os.homedir(), 'projects', 'pnpm-ado-regression-'))
console.log(`Scratch: ${scratch}\nResults: ${output}\nVersions: ${versions.join(', ')}`)
try {
  for (const version of versions) {
    const packageName = version.startsWith('12.') ? `@pnpm/exe.${process.platform}-${process.arch}` : 'pnpm'
    const release = await (await get(`https://registry.npmjs.org/${packageName}/${version}`)).json()
    const bytes = Buffer.from(await (await get(release.dist.tarball)).arrayBuffer())
    const [algorithm, expected] = release.dist.integrity.split('-')
    if (crypto.createHash(algorithm).update(bytes).digest('base64') !== expected) {
      throw new Error(`Integrity mismatch: ${packageName}@${version}`)
    }
    const directory = path.join(scratch, 'binaries', version)
    await fs.mkdir(directory, { recursive: true })
    const archive = path.join(directory, 'package.tgz')
    await fs.writeFile(archive, bytes)
    execute('tar', ['-xzf', archive, '-C', directory])
    await fs.unlink(archive)
    const executable = version.startsWith('12.')
      ? [path.join(directory, 'package', 'pnpm')]
      : [process.execPath, path.join(directory, 'package', 'bin', 'pnpm.mjs')]
    const check = execute(executable[0], [...executable.slice(1), '--version'], { cwd: scratch })
    if (check.stdout.trim() !== version) throw new Error(`Wrong executable version: ${check.stdout}`)
    results.binaries[version] = { packageName, source: release.dist.tarball, integrity: release.dist.integrity }
    await save()

    const orderedFeeds = versions.indexOf(version) % 2 ? ['ado', 'npmjs'] : ['npmjs', 'ado']
    const directories = {}
    for (const feed of orderedFeeds) {
      const directory = path.join(scratch, `${version}-${feed}`)
      directories[feed] = directory
      await fs.mkdir(path.join(directory, 'cache'), { recursive: true })
      await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ ...manifest, packageManager: `pnpm@${version}` }, null, 2) + '\n')
      await fs.writeFile(path.join(directory, '.npmrc'), [
        `registry=${feeds[feed]}`, `store-dir=${directory}/store`, `cache-dir=${directory}/cache`,
        'minimum-release-age=0', 'manage-package-manager-versions=false',
        'offline=false', 'prefer-offline=false',
        'update-notifier=false', 'verify-deps-before-run=false', '',
      ].join('\n'))
      await fs.writeFile(path.join(directory, 'pnpm-workspace.yaml'), [
        "packages: ['.']", 'minimumReleaseAge: 0',
        ...(version.startsWith('11.') ? ['managePackageManagerVersions: false'] : []),
        'updateNotifier: false', 'verifyDepsBeforeRun: false',
        `storeDir: ${directory}/store`, `cacheDir: ${directory}/cache`, '',
      ].join('\n'))
    }

    async function run(feed, cacheState, iteration) {
      const directory = directories[feed]
      await fs.writeFile(path.join(directory, 'pnpm-lock.yaml'), seed)
      const files = await cacheFiles(path.join(directory, 'cache'))
      if (cacheState !== 'warmup' && files.length === 0) throw new Error(`Empty warm cache: ${directory}`)
      const time = new Date(Date.now() - (cacheState === 'aged' ? 600000 : 0))
      for (const file of files) await fs.utimes(file, time, time)
      const before = performance.now()
      const proc = spawnSync(executable[0], [...executable.slice(1), 'dedupe', '--lockfile-only'], {
        cwd: directory, encoding: 'utf8', timeout: 240000, maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env, CI: 'true', NO_COLOR: '1',
          npm_config_userconfig: path.join(directory, '.npmrc'),
          npm_config_manage_package_manager_versions: 'false', npm_config_minimum_release_age: '0',
        },
      })
      const seconds = Number(((performance.now() - before) / 1000).toFixed(3))
      const text = `${proc.stdout ?? ''}${proc.stderr ?? ''}`
      const retryWarnings = text.split('\n').filter(line => /will retry|retrying|retry in \d/i.test(line))
      const row = {
        version, feed, cacheState, iteration, seconds, exitCode: proc.status,
        signal: proc.signal, cacheFiles: files.length, retryWarnings,
        outputLockfileSha256: sha256(await fs.readFile(path.join(directory, 'pnpm-lock.yaml'))),
      }
      results.runs.push(row)
      await save()
      console.log(JSON.stringify(row))
      if (proc.error || proc.status !== 0) {
        throw new Error(`Failed ${version}/${feed}/${cacheState}: ${proc.error ?? ''}\n${text}`)
      }
      return retryWarnings.length === 0
    }

    for (const feed of orderedFeeds) await run(feed, 'warmup', 0)
    for (const cacheState of ['immediate', 'aged']) {
      const accepted = { npmjs: 0, ado: 0 }
      for (let iteration = 1; Math.min(...Object.values(accepted)) < 3; iteration++) {
        if (iteration > 10) throw new Error(`Too many retry-affected samples: ${version}/${cacheState}`)
        const order = iteration % 2 ? orderedFeeds : [...orderedFeeds].reverse()
        for (const feed of order) {
          if (accepted[feed] < 3 && await run(feed, cacheState, iteration)) accepted[feed]++
        }
      }
    }
  }
  results.finishedAt = new Date().toISOString()
  await save()
  console.log(`Complete: ${output}`)
} finally {
  await fs.rm(scratch, { recursive: true, force: true })
  console.log(`Removed scratch: ${scratch}`)
}
