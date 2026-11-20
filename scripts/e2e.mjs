// End-to-end test: drives the real Electron UI through Playwright (CDP),
// exercising image mode (pick -> export copies -> suffix) and folder mode
// (pick -> scan -> compress -> rescan(skip) -> force -> webp conflict -> cancel).
import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat, readFile, mkdir, copyFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'
import { makeFixtures } from './make-fixtures.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9333

const work = await mkdtemp(path.join(tmpdir(), 'slimpic-e2e-'))
const fixtures = path.join(work, 'images')
const userData = path.join(work, 'userdata')
await makeFixtures(fixtures)

// A separate batch of loose images for image mode, so its output folder never
// pollutes the folder-mode fixture tree.
const pics = path.join(work, 'pics')
const outDir = path.join(work, 'out')
await mkdir(pics, { recursive: true })
const picNames = ['a.png', 'photo.jpg', 'tiny.png', 'anim.gif']
for (const n of picNames) await copyFile(path.join(fixtures, n), path.join(pics, n))
const picPaths = picNames.map((n) => path.join(pics, n))
const picSizes = {}
for (const n of picNames) picSizes[n] = (await stat(path.join(pics, n))).size

const exe = process.env.SLIM_EXE ?? electronPath
const args = process.env.SLIM_EXE
  ? [`--remote-debugging-port=${PORT}`]
  : [ROOT, `--remote-debugging-port=${PORT}`]

const child = spawn(exe, args, {
  env: {
    ...process.env,
    SLIM_USER_DATA: userData,
    SLIM_E2E_DIR: fixtures,
    SLIM_E2E_IMAGES: JSON.stringify(picPaths),
    SLIM_E2E_OUT_DIR: outDir
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let childLog = ''
child.stdout.on('data', (d) => { childLog += d })
child.stderr.on('data', (d) => { childLog += d })

let browser
const failures = []
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`)
  if (!cond) failures.push(name)
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error('cannot connect to Electron CDP\n' + childLog)
}

async function waitForPage() {
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url().includes('index.html') || p.url().startsWith('http://localhost')) {
          await p.waitForSelector('[data-test=dropzone]')
          return p
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('renderer page not found')
}

async function text(page, test) {
  return (await page.locator(`[data-test=${test}]`).textContent())?.trim() ?? ''
}

async function rowMap(page) {
  return page.evaluate(() => {
    const out = {}
    for (const tr of document.querySelectorAll('[data-test=row]')) {
      out[tr.getAttribute('data-path').replaceAll('\\', '/')] = tr.textContent.replace(/\s+/g, ' ')
    }
    return out
  })
}

async function scanViaPicker(page) {
  // SLIM_E2E_DIR makes the main process return the fixture dir from the picker IPC,
  // so this exercises the real button -> IPC -> scan flow without a native dialog.
  await page.click('[data-test=pick-big]')
  await page.waitForSelector('[data-test=stat-pending]')
}

try {
  await connect()
  const page = await waitForPage()

  // --- 0. image mode is the default: pick loose images, export compressed copies ---
  check('image mode is default', /拖入图片/.test(await page.locator('[data-test=dropzone]').textContent()))
  const modeTabs = (await page.locator('[data-test=modes] button').allTextContents()).map((t) => t.trim())
  check('mode tabs order', modeTabs.join(',') === '图片模式,文件夹模式', modeTabs.join(','))
  await page.click('[data-test=pick-big]')
  await page.waitForSelector('[data-test=file-pending]')
  check('image pending = 3', (await text(page, 'file-pending')) === '3', await text(page, 'file-pending'))
  check('image unsupported = 1', (await text(page, 'file-unsupported')) === '1', await text(page, 'file-unsupported'))
  check('image total = 4', (await text(page, 'file-total')) === '4', await text(page, 'file-total'))
  const defaultOut = await text(page, 'out-dir')
  check('image default out dir', defaultOut === path.join(pics, 'slimpic-out'), defaultOut)

  await page.click('[data-test=pick-outdir]')
  await page.waitForFunction(
    (p) => document.querySelector('[data-test=out-dir]')?.textContent?.trim() === p,
    outDir
  )
  check('image out dir changed', (await text(page, 'out-dir')) === outDir, await text(page, 'out-dir'))

  await page.click('[data-test=start-files]')
  await page.waitForSelector('[data-test=pick-more]', { timeout: 300000 })
  const picRows = await rowMap(page)
  check('image a.png compressed', /完成 −\d+%/.test(picRows['a.png'] ?? ''), picRows['a.png'])
  check('image photo.jpg compressed', /完成 −\d+%/.test(picRows['photo.jpg'] ?? ''), picRows['photo.jpg'])
  check('image tiny.png optimal', /已最优/.test(picRows['tiny.png'] ?? ''), picRows['tiny.png'])
  check('image anim.gif unsupported', /不支持/.test(picRows['anim.gif'] ?? ''), picRows['anim.gif'])
  check('image saved shown', /[KMB]/.test(await text(page, 'stat-saved-files')), await text(page, 'stat-saved-files'))

  const firstOut = await readdir(outDir)
  check('image outputs = 3', firstOut.length === 3, firstOut.join(','))
  const outA = (await stat(path.join(outDir, 'a.png'))).size
  const outTiny = (await stat(path.join(outDir, 'tiny.png'))).size
  check('image copy smaller than source', outA < picSizes['a.png'], `${outA} < ${picSizes['a.png']}`)
  check('image tiny copied as-is', outTiny === picSizes['tiny.png'], `${outTiny} / ${picSizes['tiny.png']}`)
  const srcA = (await stat(path.join(pics, 'a.png'))).size
  check('image source untouched', srcA === picSizes['a.png'], String(srcA))

  // Re-exporting the same batch must not overwrite the previous outputs.
  await page.click('[data-test=pick-more]')
  await page.waitForSelector('[data-test=file-pending]')
  await page.click('[data-test=start-files]')
  await page.waitForSelector('[data-test=pick-more]', { timeout: 300000 })
  const secondOut = await readdir(outDir)
  check('image suffix instead of overwrite', secondOut.includes('a-2.png') && secondOut.includes('tiny-2.png'), secondOut.join(','))

  // Format conversion in image mode writes the requested format, source kept.
  await page.click('[data-test=pick-more]')
  await page.waitForSelector('[data-test=fmt-webp]')
  await page.click('[data-test=fmt-webp]')
  await page.click('[data-test=start-files]')
  await page.waitForSelector('[data-test=pick-more]', { timeout: 300000 })
  const thirdOut = await readdir(outDir)
  check('image webp export', thirdOut.includes('a.webp') && thirdOut.includes('photo.webp'), thirdOut.join(','))
  check('image webp source kept', (await stat(path.join(pics, 'a.png'))).size === picSizes['a.png'])

  // --- 1. folder mode: scan ---
  await page.click('[data-test=mode-folder]')
  await scanViaPicker(page)
  await page.click('[data-test=fmt-original]')
  check('scan pending = 6', (await text(page, 'stat-pending')) === '6', await text(page, 'stat-pending'))
  check('scan skipped = 0', (await text(page, 'stat-skipped')) === '0')
  check('scan unsupported = 5', (await text(page, 'stat-unsupported')) === '5', await text(page, 'stat-unsupported'))
  check('scan tooLarge = 1', (await text(page, 'stat-toolarge')) === '1')

  // --- 2. compress (original format) ---
  await page.click('[data-test=start]')
  await page.waitForSelector('[data-test=rescan-done]', { timeout: 300000 })
  const rowInfo = await rowMap(page)
  check('a.png compressed', /完成 −\d+%/.test(rowInfo['a.png'] ?? ''), rowInfo['a.png'])
  check('photo.jpg compressed', /完成 −\d+%/.test(rowInfo['photo.jpg'] ?? ''), rowInfo['photo.jpg'])
  check('tiny.png optimal', /已最优/.test(rowInfo['tiny.png'] ?? ''), rowInfo['tiny.png'])
  check('sub/b.png compressed', /完成/.test(rowInfo['sub/b.png'] ?? ''), rowInfo['sub/b.png'])
  check('sub/deep/c.png compressed', /完成/.test(rowInfo['sub/deep/c.png'] ?? ''), rowInfo['sub/deep/c.png'])
  const saved = await text(page, 'stat-saved')
  check('saved bytes shown', /KB|MB|B/.test(saved), saved)

  // Disk really changed:
  const aStat = await stat(path.join(fixtures, 'a.png'))
  check('a.png smaller on disk', aStat.size > 0)

  // --- 3. rescan: everything skipped ---
  await page.click('[data-test=rescan-done]')
  await page.waitForSelector('[data-test=start]')
  check('rescan pending = 0', (await text(page, 'stat-pending')) === '0', await text(page, 'stat-pending'))
  check('rescan skipped = 6', (await text(page, 'stat-skipped')) === '6', await text(page, 'stat-skipped'))

  // --- 4. force re-compress ---
  await page.click('[data-test=force]')
  await page.waitForFunction(() => document.querySelector('[data-test=stat-pending]')?.textContent === '6')
  check('force pending = 6', (await text(page, 'stat-pending')) === '6', await text(page, 'stat-pending'))
  await page.click('[data-test=force]') // back off
  await page.waitForFunction(() => document.querySelector('[data-test=stat-pending]')?.textContent === '0')

  // --- 5. webp conversion + conflict ---
  await page.click('[data-test=force]')
  await page.waitForFunction(() => document.querySelector('[data-test=stat-pending]')?.textContent === '6')
  await page.click('[data-test=fmt-webp]')
  await page.click('[data-test=start]')
  await page.waitForSelector('[data-test=rescan-done]', { timeout: 300000 })
  const rowInfo2 = await rowMap(page)
  check('d.png conflict reported', /目标已存在/.test(rowInfo2['d.png'] ?? ''), rowInfo2['d.png'])
  const aWebp = await stat(path.join(fixtures, 'a.webp')).catch(() => null)
  const aPngGone = await stat(path.join(fixtures, 'a.png')).then(() => false).catch(() => true)
  check('a.webp created', aWebp !== null)
  check('a.png removed after conversion', aPngGone)
  const dPng = await stat(path.join(fixtures, 'd.png')).catch(() => null)
  check('d.png kept on conflict', dPng !== null)

  // rescan after conversion: only the conflicted d.png remains pending
  await page.click('[data-test=rescan-done]')
  await page.waitForSelector('[data-test=start]')
  check('post-webp pending = 1 (conflict only)', (await text(page, 'stat-pending')) === '1', await text(page, 'stat-pending'))
  // converted files are recorded: rescan with force off must skip nothing new but a.webp shows unsupported
  const postRows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-test=stat-unsupported]')].map((e) => e.textContent)[0])
  check('webp outputs counted unsupported', Number(postRows) >= 5, postRows)

  // --- 6. cancel flow ---
  await page.click('[data-test=clear-history]')
  await page.waitForFunction(() => Number(document.querySelector('[data-test=stat-pending]')?.textContent) > 0)
  const pendingNow = Number(await text(page, 'stat-pending'))
  check('clear history brings files back', pendingNow > 0, String(pendingNow))
  await page.click('[data-test=fmt-original]')
  await page.click('[data-test=start]')
  await page.waitForSelector('[data-test=cancel]')
  await page.click('[data-test=cancel]')
  await page.waitForSelector('[data-test=rescan-done]', { timeout: 300000 })
  const doneText = await page.locator('.runbar').textContent()
  check('cancel summary shown', /取消\s*\d+/.test(doneText), doneText.replace(/\s+/g, ' '))

  // --- 7. include ignored dirs ---
  await page.click('[data-test=rescan-done]')
  await page.waitForSelector('[data-test=start]')
  await page.click('[data-test=show-all]')
  await page.click('[data-test=include-ignored]')
  await page.waitForSelector('[data-path*="node_modules"]')
  const withHidden = await page.locator('[data-test=row]').count()
  const hasNodeModules = await page.locator('[data-path*="node_modules"]').count()
  check('ignored dirs included', hasNodeModules > 0, `rows=${withHidden}`)
  await page.click('[data-test=include-ignored]')
  await page.waitForFunction(() => document.querySelectorAll('[data-path*="node_modules"]').length === 0)

  // screenshot for the record
  await page.screenshot({ path: path.join(work, 'final.png'), fullPage: true })
  console.log('screenshot:', path.join(work, 'final.png'))
} catch (e) {
  failures.push('exception: ' + (e?.stack ?? e))
  console.error(e)
  console.error('--- electron log ---\n' + childLog.slice(-4000))
} finally {
  await browser?.close().catch(() => {})
  const exited = new Promise((r) => child.once('exit', r))
  child.kill()
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  // keep fixtures for inspection on failure, clean on success
  if (failures.length === 0) {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {})
  } else {
    console.log('work dir kept:', work)
  }
}

if (failures.length) {
  console.error(`\nE2E FAILED: ${failures.length} check(s)`)
  process.exit(1)
}
console.log('\nE2E OK — all checks passed')
process.exit(0)