#!/usr/bin/env node
/**
 * Sync @dedel.alex/keycloak-admin-client-cjs versions with
 * @keycloak/keycloak-admin-client.
 *
 * Usage:
 *   node scripts/sync.mjs              # publish all missing stable versions
 *   node scripts/sync.mjs --dry-run    # list what would be published
 *   node scripts/sync.mjs --latest     # only the newest missing version
 *   node scripts/sync.mjs --from 26.2.0
 *   node scripts/sync.mjs --no-git     # skip commit/tag (CI publish-only)
 *   node scripts/sync.mjs --no-publish # build + version bump only
 */

import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const pkgPath = join(root, 'package.json')

const UPSTREAM = '@keycloak/keycloak-admin-client'
const PACKAGE = '@dedel.alex/keycloak-admin-client-cjs'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const latestOnly = args.has('--latest')
const noGit = args.has('--no-git')
const noPublish = args.has('--no-publish')
const fromIdx = process.argv.indexOf('--from')
const fromVersion = fromIdx >= 0 ? process.argv[fromIdx + 1] : null

function run(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: root,
    encoding: 'utf8',
    stdio: opts.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...opts,
  })
}

function runCapture(cmd) {
  return execFileSync('bash', ['-lc', cmd], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
}

function parseSemver(v) {
  const [major, minor, patch] = v.split('.').map(Number)
  return { major, minor, patch, raw: v }
}

function cmpSemver(a, b) {
  const A = parseSemver(a)
  const B = parseSemver(b)
  if (A.major !== B.major) return A.major - B.major
  if (A.minor !== B.minor) return A.minor - B.minor
  return A.patch - B.patch
}

function isStable(v) {
  return /^\d+\.\d+\.\d+$/.test(v)
}

function npmViewJson(spec, field = 'versions') {
  const out = runCapture(`npm view ${spec} ${field} --json`)
  return JSON.parse(out)
}

function readPkg() {
  return JSON.parse(readFileSync(pkgPath, 'utf8'))
}

function writePkg(pkg) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

function setVersion(version) {
  const pkg = readPkg()
  pkg.version = version
  pkg.dependencies[UPSTREAM] = version
  writePkg(pkg)
}

function releaseOne(version, previousVersion) {
  console.log(`\n=== Releasing ${PACKAGE}@${version} ===`)

  if (dryRun) {
    console.log(`[dry-run] would install ${UPSTREAM}@${version}, build, publish`)
    return
  }

  setVersion(version)
  // Upstream >=26.6 may run a broken postinstall (pnpm/wireit); we only need the package files.
  run(
    `npm install ${UPSTREAM}@${version} --save-exact --no-fund --no-audit --ignore-scripts`,
  )
  // Re-pin exact versions in case npm rewrote ranges
  setVersion(version)
  run('npm run build')

  // Smoke check: CJS export must exist
  runCapture(
    `node -e "const m=require('./dist/index.js'); if (typeof m.KeycloakAdminClient !== 'function') process.exit(1)"`,
  )

  if (!noPublish) {
    run('npm publish --access public')
  }

  if (!noGit) {
    const tag = `v${version}`
    const tagExists =
      runCapture(`git tag -l "${tag}"`) === tag ||
      runCapture(`git rev-parse -q --verify "refs/tags/${tag}" || true`).length > 0

    if (tagExists) {
      console.log(`git tag ${tag} already exists — skipping commit/tag`)
    } else {
      run('git add package.json package-lock.json')
      const from = previousVersion ? ` from ${previousVersion}` : ''
      const msg = `chore(deps): bump ${UPSTREAM}${from} to ${version}`
      run(`git commit -m "${msg}"`)
      run(`git tag -a "${tag}" -m "${tag}"`)
    }
  }

  console.log(`✓ ${PACKAGE}@${version}`)
}

function main() {
  console.log(`Fetching versions for ${UPSTREAM} and ${PACKAGE}...`)
  const upstreamVersions = npmViewJson(UPSTREAM)
    .filter(isStable)
    .sort(cmpSemver)

  let published = []
  try {
    published = npmViewJson(PACKAGE)
  } catch {
    published = []
  }
  const publishedSet = new Set(published)

  let missing = upstreamVersions.filter((v) => !publishedSet.has(v))

  if (fromVersion) {
    missing = missing.filter((v) => cmpSemver(v, fromVersion) >= 0)
  } else {
    // Default: only versions after the last published one (avoid ancient history)
    const lastPublished = [...published].filter(isStable).sort(cmpSemver).at(-1)
    if (lastPublished) {
      missing = missing.filter((v) => cmpSemver(v, lastPublished) > 0)
    }
  }

  if (latestOnly && missing.length) {
    missing = [missing.at(-1)]
  }

  if (!missing.length) {
    console.log('Already up to date — nothing to publish.')
    return
  }

  console.log(`Versions to release (${missing.length}):`)
  console.log(missing.join(', '))

  let previous = readPkg().version
  for (const version of missing) {
    releaseOne(version, previous)
    previous = version
  }

  if (!dryRun && !noGit) {
    console.log('\nDone. Push with: git push --follow-tags')
  }
}

main()
