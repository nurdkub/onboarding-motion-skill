/**
 * Выгрузка онбординг-сцены в самостоятельный анимированный SVG.
 *
 *   npm run export:svg -- <слаг прототипа>      — одна сцена (можно часть слага)
 *   npm run export:svg                          — все сцены, у которых есть onboardingTip
 *   npm run export:svg -- <слаг> --url=http://localhost:5174
 *
 * Нужен запущенный дев-сервер (`npm run dev`). Скрипт открывает страницу
 * `/#/onboarding-export?scene=<слаг>` в браузере на Chromium без окна (Chrome,
 * Edge, Яндекс, Chromium, Brave — что найдётся), зовёт там
 * `window.__onbExportSvg()` и пишет результат в `export/onboarding/<слаг>.svg`.
 * Вся механика выгрузки — `src/shared/onboarding/svgExport.ts`.
 *
 * Браузер запускается с отдельным временным профилем: профиль человека
 * не трогается. Протокол — CDP через встроенный WebSocket Node, без пакетов.
 *
 * Шрифт текста встраивается урезанным до букв сцены — пакетом `subset-font`
 * (harfbuzz в WebAssembly, devDependency): Roboto целиком — 130 КБ, урезанный —
 * единицы килобайт, и SVG укладывается в 100 КБ. Пакета нет — шрифт не
 * встраивается, текст набирается шрифтом смотрящего (скрипт предупредит).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'export', 'onboarding')
const BUDGET_KB = 100

const args = process.argv.slice(2)
const urlArg = args.find((a) => a.startsWith('--url='))
const BASE = (urlArg ? urlArg.slice(6) : 'http://localhost:5173').replace(/\/$/, '')
const wanted = args.filter((a) => !a.startsWith('--'))

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Yandex.app/Contents/MacOS/Yandex',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  `${process.env.LOCALAPPDATA}/Yandex/YandexBrowser/Application/browser.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]
const browserPath = process.env.CHROME_PATH || BROWSERS.find((p) => p && existsSync(p))
if (!browserPath) {
  console.error('Не нашёл браузер на Chromium. Укажите путь: CHROME_PATH=… npm run export:svg')
  process.exit(1)
}

// Сцены — папки прототипов, где в scene.tsx есть onboardingTip.
const protoDir = join(ROOT, 'src', 'prototypes')
const all = readdirSync(protoDir).filter((d) => {
  const f = join(protoDir, d, 'scene.tsx')
  return existsSync(f) && /export const onboardingTip/.test(String(readFileSafe(f)))
})
function readFileSafe(f) {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}
const slugs = wanted.length ? all.filter((s) => wanted.some((w) => s.includes(w))) : all
if (!slugs.length) {
  console.error(`Сцены не найдены. Есть: ${all.join(', ') || 'ни одной'}`)
  process.exit(1)
}

try {
  await fetch(BASE)
} catch {
  console.error(`Дев-сервер не отвечает на ${BASE}. Запустите npm run dev или передайте --url=…`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const port = 9400 + Math.floor(Math.random() * 400)
const profile = mkdtempSync(join(tmpdir(), 'onb-svg-'))
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=800,800',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let wsUrl
for (let i = 0; i < 80 && !wsUrl; i++) {
  await sleep(250)
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch {}
}
if (!wsUrl) {
  browser.kill()
  console.error('Браузер не ответил по протоколу отладки')
  process.exit(1)
}

const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const evaluate = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'ошибка в странице')
  return r.result?.result?.value
}

let subsetFont = null
try {
  subsetFont = (await import('subset-font')).default
} catch {
  console.warn('Пакета subset-font нет — шрифт не встроится. Поставьте: npm i -D subset-font')
}

/** Урезанные шрифты сцены — блок @font-face на место метки в стиле SVG. */
async function fontCss(fonts) {
  if (!subsetFont) return ''
  const out = []
  for (const f of fonts) {
    try {
      const buf = Buffer.from(await (await fetch(f.url)).arrayBuffer())
      const cut = await subsetFont(buf, f.text, { targetFormat: 'woff2' })
      out.push(
        `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:${f.style};` +
          (f.range ? `unicode-range:${f.range};` : '') +
          `src:url(data:font/woff2;base64,${cut.toString('base64')}) format("woff2")}`,
      )
    } catch (e) {
      console.warn(`Шрифт ${f.family} ${f.weight} не встроен: ${e.message}`)
    }
  }
  return out.join('')
}

await send('Page.enable')
await send('Runtime.enable')
mkdirSync(OUT, { recursive: true })

let failed = false
for (const slug of slugs) {
  try {
    await send('Page.navigate', { url: `${BASE}/#/onboarding-export?scene=${slug}` })
    await sleep(500)
    await send('Page.reload', { ignoreCache: true })
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      if (await evaluate('!!window.__onbExportSvg && !!(window.__onbScenes||[]).length')) break
    }
    await evaluate('document.fonts.ready.then(() => true)', true)
    const r = await evaluate('window.__onbExportSvg().then((r) => ({ svg: r.svg, fonts: r.fonts, shots: r.shots, patches: r.patches }))', true)
    const svg = r.svg.replace('/*@onb-fonts*/', await fontCss(r.fonts))
    const file = join(OUT, `${slug}.svg`)
    writeFileSync(file, svg)
    const kb = Buffer.byteLength(svg) / 1024
    console.log(`${slug}.svg — ${kb.toFixed(1)} КБ, снимков ${r.shots}, заплаток ${r.patches}${kb > BUDGET_KB ? `  ⚠ больше ${BUDGET_KB} КБ` : ''}`)
  } catch (e) {
    failed = true
    console.error(`${slug}: ${e.message}`)
  }
}

ws.close()
browser.kill()
await sleep(300)
try {
  rmSync(profile, { recursive: true, force: true })
} catch {}
console.log(`Готово: ${OUT}`)
process.exit(failed ? 1 : 0)
