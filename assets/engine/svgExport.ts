import { APPEAR, BEAT, DURATION, FEEDBACK, cssEase } from './motion'
import type { FrameInfo, SceneController } from './OnboardingScene'

/**
 * Выгрузка онбординг-сцены в самостоятельный анимированный SVG.
 *
 * Сцена в продукте живёт на настоящих компонентах Square; SVG — её запись
 * для мест, где компонентов нет: документация, сайт, письмо, передача фронту.
 * Записывается не видео, а разметка: сцена перематывается движком
 * (`SceneController.seek`) по ключевым моментам сценария, на каждом снимается
 * DOM с вычисленными стилями. Снимки лежат в одном <foreignObject> и сменяют
 * друг друга CSS-анимацией; курсор и круг нажатия — векторные круги поверх,
 * их путь снят с тех же часов, что ведут сцену. Поэтому SVG проигрывает ровно
 * то, что сцена: тот же такт, те же кривые, тот же цикл.
 *
 * Стили не копируются целиком: у каждого элемента берутся только свойства,
 * отличные от умолчания его тега (и от родителя — у наследуемых), одинаковые
 * наборы сводятся в общие классы. Иконки Material рисуются в PNG через canvas:
 * шрифт иконок в SVG не встраивается — он весит больше всей сцены.
 *
 * Движение внутри снимков — тоже как в сцене (05.10.2026): строки появляются
 * со сдвигом и уходят затуханием, окно и меню — родной анимацией накладок ДС,
 * результат вспыхивает акцентом, строка подрастает при нажатии, наведение
 * перетекает за `duration/fast`. Шрифты текста встраиваются — только те
 * начертания и подмножества, буквы которых есть в сцене: без них SVG
 * показывал Arial и выглядел чужим.
 */

const SKIP = /^(inset-block|inset-inline|margin-block|margin-inline|padding-block|padding-inline|border-block|border-inline|block-size|inline-size|min-block-size|min-inline-size|max-block-size|max-inline-size|overflow-block|overflow-inline|contain-intrinsic|border-start|border-end|scroll-margin|scroll-padding|transition|animation|will-change|cursor|pointer-events|user-select|-webkit-user-select|caret-color|-webkit-tap-highlight-color|outline|scroll|overscroll|touch-action|-webkit-user-drag|interactivity|view-transition|anchor|position-anchor|position-try|math|interpolate-size|field-sizing|zoom|app-region|-webkit-print|print|speak|hyphenate|ruby|text-size-adjust|-webkit-text-size-adjust)/

const INHERITED = new Set([
  'color', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant',
  'font-feature-settings', 'font-kerning', 'font-optical-sizing', 'font-variation-settings',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent', 'text-transform',
  'white-space', 'white-space-collapse', 'text-wrap', 'text-wrap-mode', 'visibility', 'direction',
  'writing-mode', 'list-style-type', 'list-style-position', 'list-style-image', 'text-rendering',
  '-webkit-font-smoothing', 'font-synthesis', 'tab-size', 'word-break', 'overflow-wrap',
  'text-shadow', 'quotes', 'hyphens', 'text-emphasis-color', '-webkit-text-fill-color',
  '-webkit-text-stroke-color', 'paint-order', 'fill', 'stroke', 'stroke-width',
])

const CURRENT_COLOR = /^(border-(top|right|bottom|left)-color|outline-color|text-decoration-color|column-rule-color|text-emphasis-color|-webkit-text-fill-color|-webkit-text-stroke-color)$/

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'
const SAMPLE_MS = 1000 / 30

interface Built {
  rules: Map<string, string>
  icons: Map<string, string>
  /** Анимации внутри снимков: ключ — что и когда, значение — имя класса. */
  anims: Map<string, string>
  animCss: string[]
  /** Какие буквы каким начертанием набраны: `семейство|вес|стиль` → символы. */
  glyphs: Map<string, Set<string>>
}

const EPS = 0.5

export async function exportSceneSvg(root: HTMLElement, ctrl: SceneController) {
  const kill = document.createElement('style')
  kill.textContent =
    '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}'
  document.head.append(kill)
  try {
    return await build(root, ctrl)
  } finally {
    kill.remove()
  }
}

async function build(root: HTMLElement, ctrl: SceneController) {
  const T = ctrl.timeline
  const loop = T.loop
  const resetAt = T.total + BEAT.fadeOut
  await document.fonts.ready

  // ── умолчания тегов: в пустом iframe, где нет стилей полигона ──────────
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
  document.body.append(frame)
  const idoc = frame.contentDocument!
  const props = Array.from(getComputedStyle(document.body)).filter((p) => !p.startsWith('--') && !SKIP.test(p))
  const defaults = new Map<string, Record<string, string>>()
  const defaultsFor = (el: Element, pseudo?: string) => {
    const key = `${el.namespaceURI}|${el.localName}|${pseudo ?? ''}`
    let d = defaults.get(key)
    if (!d) {
      const probe = idoc.createElementNS(el.namespaceURI ?? XHTML_NS, el.localName)
      ;(el.namespaceURI === SVG_NS ? idoc.body.appendChild(idoc.createElementNS(SVG_NS, 'svg')) : idoc.body).append(probe)
      const cs = idoc.defaultView!.getComputedStyle(probe, pseudo)
      d = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]))
      defaults.set(key, d)
      probe.remove()
    }
    return d
  }

  const built: Built = { rules: new Map(), icons: new Map(), anims: new Map(), animCss: [], glyphs: new Map() }
  const pct = (t: number) => `${+((Math.max(0, Math.min(loop, t)) / loop) * 100).toFixed(4)}%`

  /**
   * Анимация, привязанная к моменту цикла: все снимки, где лежит элемент,
   * получают один класс, поэтому движение не рвётся на смене снимка.
   */
  const animClass = (key: string, frames: () => string, extra = '') => {
    let name = built.anims.get(key)
    if (!name) {
      name = `a${built.anims.size.toString(36)}`
      built.anims.set(key, name)
      built.animCss.push(`.${name}{animation:k${name} ${loop}ms linear infinite${extra ? ';' + extra : ''}}@keyframes k${name}{${frames()}}`)
    }
    return name
  }
  /** Переход `from → to` за `dur` мс с момента `at`, до и после — стоит. */
  const span = (at: number, dur: number, from: string, to: string, ease: string) =>
    `0%{${from}}${pct(at)}{${from};animation-timing-function:${ease}}${pct(at + dur)}{${to}}100%{${to}}`

  const noteGlyphs = (cs: CSSStyleDeclaration, text: string) => {
    if (!text.trim() || /Material Icons/.test(cs.fontFamily)) return
    const family = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '')
    const key = `${family}|${cs.fontWeight}|${cs.fontStyle}`
    let set = built.glyphs.get(key)
    if (!set) built.glyphs.set(key, (set = new Set()))
    for (const ch of text) set.add(ch)
  }
  const classFor = (css: string) => {
    let name = built.rules.get(css)
    if (!name) {
      name = `c${built.rules.size.toString(36)}`
      built.rules.set(css, name)
    }
    return name
  }

  /**
   * Нужен ли элементу явный размер: снимаем ширину (высоту) и смотрим, сдвинулся
   * ли бокс. Не сдвинулся — размер даёт раскладка, и в SVG он сложится сам.
   */
  const needsSize = (el: Element, axis: 'width' | 'height') => {
    if (!(el instanceof HTMLElement) || el.namespaceURI !== XHTML_NS) return true
    const before = el.getBoundingClientRect()[axis]
    const keep = el.style.getPropertyValue(axis)
    const prio = el.style.getPropertyPriority(axis)
    el.style.setProperty(axis, 'auto', 'important')
    const after = el.getBoundingClientRect()[axis]
    if (keep) el.style.setProperty(axis, keep, prio)
    else el.style.removeProperty(axis)
    return Math.abs(before - after) > 0.5
  }

  const short = (v: string) =>
    v
      .replace(/rgba?\((\d+), (\d+), (\d+)\)/g, (_, r, g, b) =>
        '#' + [r, g, b].map((n: string) => Number(n).toString(16).padStart(2, '0')).join(''),
      )
      .replace(/\b0px\b/g, '0')

  const styleOf = (el: Element, parent: CSSStyleDeclaration | null, pseudo?: string) => {
    const cs = getComputedStyle(el, pseudo)
    const d = defaultsFor(el, pseudo)
    const color = cs.getPropertyValue('color')
    const transformed = cs.getPropertyValue('transform') !== 'none' || cs.getPropertyValue('scale') !== 'none'
    const out: string[] = []
    for (const p of props) {
      let v = cs.getPropertyValue(p)
      if (v === d[p] && !(p === 'transform-origin' && transformed)) continue
      if (!pseudo && parent && INHERITED.has(p) && v === parent.getPropertyValue(p)) continue
      // У этих свойств умолчание — currentColor: совпали с цветом текста — писать
      // незачем. Фон сюда не входит: его умолчание прозрачное, и совпадение с
      // цветом текста случайно (так пропал тёмный фон Alert).
      if (CURRENT_COLOR.test(p) && v === color) continue
      // Рамка нулевой толщины: её цвет и стиль ничего не рисуют.
      const side = p.match(/^border-(top|right|bottom|left)-(color|style)$/)
      if (side && cs.getPropertyValue(`border-${side[1]}-width`) === '0px') continue
      // Точка масштаба нужна всегда, когда элемент трансформирован: у пустого
      // элемента-образца она «0px 0px» и совпадает с умолчанием только на вид.
      if ((p === 'transform-origin' || p === 'perspective-origin') && !transformed) continue
      if (p === 'transform-origin' && transformed) {
        out.push(`${p}:${short(v)}`)
        continue
      }
      if (!pseudo && (p === 'width' || p === 'height') && !needsSize(el, p)) continue
      out.push(`${p}:${short(v)}`)
    }
    return { cs, css: out.join(';') }
  }

  const iconUrl = (el: HTMLElement, cs: CSSStyleDeclaration) => {
    // Размер — в CSS-пикселях раскладки, а не на экране: сцена уменьшена до 0,75.
    const r = { width: el.offsetWidth, height: el.offsetHeight }
    const key = `${el.textContent}|${cs.color}|${cs.fontSize}|${r.width}x${r.height}`
    let url = built.icons.get(key)
    if (!url) {
      const k = 3
      const c = document.createElement('canvas')
      c.width = Math.ceil(r.width * k)
      c.height = Math.ceil(r.height * k)
      const g = c.getContext('2d')!
      g.scale(k, k)
      g.font = `${cs.fontSize} "${cs.fontFamily.split(',')[0].replace(/"/g, '')}"`
      g.fillStyle = cs.color
      g.textBaseline = 'middle'
      g.textAlign = 'center'
      g.fillText(el.textContent ?? '', r.width / 2, r.height / 2)
      url = c.toDataURL('image/png')
      built.icons.set(key, url)
    }
    return url
  }

  /**
   * Встроенный значок (галочка Checkbox, StatusIcon) повторяется в каждом
   * снимке. Он уходит в картинку класса — тогда в файле он один раз, а в
   * снимках остаётся пустой span с этим классом.
   */
  const svgIcon = (el: SVGSVGElement, parent: CSSStyleDeclaration | null) => {
    const { cs, css } = styleOf(el, parent)
    const r = el.getBoundingClientRect()
    // Цвета значка заданы переменными (fill="var(--sti-mark)") — в SVG их нет:
    // подставляем вычисленные fill и stroke каждому узлу.
    const copy = el.cloneNode(true) as SVGSVGElement
    const src = [el, ...el.querySelectorAll('*')]
    const dst = [copy, ...copy.querySelectorAll('*')]
    src.forEach((node, i) => {
      const ncs = getComputedStyle(node)
      const out = dst[i]
      out.removeAttribute('class')
      out.removeAttribute('style')
      out.removeAttribute('focusable')
      out.removeAttribute('aria-hidden')
      if (i > 0) {
        out.setAttribute('fill', ncs.fill)
        out.setAttribute('stroke', ncs.stroke)
        if (ncs.opacity !== '1') out.setAttribute('opacity', ncs.opacity)
      }
    })
    const markup = new XMLSerializer().serializeToString(copy).replace(/currentColor/g, cs.color)
    const url = `data:image/svg+xml,${encodeURIComponent(markup)}`
    const span = document.createElementNS(XHTML_NS, 'span')
    span.setAttribute(
      'class',
      classFor(
        `${css};display:inline-block;width:${r.width}px;height:${r.height}px;background:url("${url}") center/100% 100% no-repeat`,
      ),
    )
    return span
  }

  /** Снимок узла: клон без лишних атрибутов, стиль — классом. `skip` — узел, который не снимать. */
  let skipNode: Element | null = null
  const snap = (el: Element, parent: CSSStyleDeclaration | null): Node | null => {
    if (el === skipNode) return null
    if (el instanceof HTMLElement) {
      if (el.matches('.OnbScene__cursor, .OnbScene__ripple, .OnbScene__problems')) return null
      if (getComputedStyle(el).display === 'none') return null
    }
    if (el instanceof SVGSVGElement && el.parentElement?.namespaceURI === XHTML_NS) return svgIcon(el, parent)
    const isSvg = el.namespaceURI === SVG_NS
    const clone = document.createElementNS(el.namespaceURI ?? XHTML_NS, el.localName)
    const { cs, css } = styleOf(el, parent)
    let rule = css

    if (isSvg) {
      for (const a of Array.from(el.attributes)) {
        if (a.name === 'class' || a.name === 'style' || a.name.startsWith('data-') || a.name.startsWith('aria-')) continue
        clone.setAttribute(a.name, a.value.includes('var(') ? '' : a.value)
      }
    } else if (el instanceof HTMLInputElement) {
      for (const a of ['type', 'placeholder']) if (el.hasAttribute(a)) clone.setAttribute(a, el.getAttribute(a)!)
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) clone.setAttribute('checked', '')
      } else {
        clone.setAttribute('value', el.value)
        noteGlyphs(cs, el.value || el.placeholder)
      }
      const ph = getComputedStyle(el, '::placeholder').color
      rule += `|ph:${ph}`
    } else if (el instanceof HTMLImageElement) {
      clone.setAttribute('src', el.currentSrc || el.src)
    }

    // Иконка Material — глиф шрифта, которого в SVG не будет: рисуем картинкой.
    const isIcon = el instanceof HTMLElement && /Material Icons/.test(cs.fontFamily) && el.children.length === 0
    if (isIcon) {
      const h = el as HTMLElement
      // Глифа в SVG нет — ширину давал он, поэтому размер задаётся явно.
      rule += `;display:inline-block;width:${h.offsetWidth}px;height:${h.offsetHeight}px;background:url(${iconUrl(h, cs)}) center/100% 100% no-repeat;color:transparent`
    }

    // Текст, который в сцене умещался в одну строку, не переносится и в SVG:
    // без Roboto подставляется шрифт шире, и подпись иначе рвётся на две строки.
    if (el instanceof HTMLElement && !isIcon && [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)))
      if (tops.size === 1 && cs.whiteSpace !== 'nowrap') rule += ';white-space:nowrap'
    }

    // Подсветка результата — псевдоэлемент с анимацией: снимается отдельным слоем ниже.
    const isAppear = el instanceof HTMLElement && el.classList.contains('OnbScene__appear')
    for (const pseudo of ['::before', '::after']) {
      if (isAppear) continue
      const content = getComputedStyle(el, pseudo).content
      if (content && content !== 'none' && content !== 'normal') rule += `|${pseudo}{${styleOf(el, null, pseudo).css}}`
    }
    const classes = rule ? [classFor(rule)] : []
    const motion = el instanceof HTMLElement ? motionOf(el) : null
    if (motion) classes.push(motion)
    if (classes.length) clone.setAttribute('class', classes.join(' '))
    if (isAppear) {
      const h = el as HTMLElement
      const at = Number(h.dataset.at)
      if (h.dataset.kind === 'result' && h.dataset.phase === 'entering' && Number.isFinite(at)) {
        const bg = getComputedStyle(h, '::after').backgroundColor
        const flash = document.createElementNS(XHTML_NS, 'span')
        flash.setAttribute(
          'class',
          animClass(
            `flash:${at}`,
            () =>
              `0%{opacity:1}${pct(at + APPEAR.enter)}{opacity:1;animation-timing-function:${cssEase('enter')}}${pct(at + APPEAR.enter + APPEAR.highlight)}{opacity:0}100%{opacity:0}`,
            `position:absolute;left:0;top:0;right:0;bottom:0;background:${bg};mix-blend-mode:multiply;pointer-events:none`,
          ),
        )
        clone.append(flash)
      }
    }

    if (isIcon) return clone
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        noteGlyphs(cs, child.textContent ?? '')
        clone.append(child.textContent ?? '')
      }
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const c = snap(child as Element, cs)
        if (c) clone.append(c)
      }
    }
    return clone
  }

  /**
   * Движение элемента в момент снимка `now`:
   * - строка и результат (`SceneAppear`) — появление со сдвигом, уход затуханием;
   * - окно сцены (`SceneWindow`) — затемнение уходит затуханием;
   * - накладки ДС (`sq-appear`: окно, меню) — родная анимация появления;
   * - строка, в которой отпустили цель, — подрастание.
   */
  let now = 0
  const appearedAt = new WeakMap<Element, number>()
  const motionOf = (el: HTMLElement): string | null => {
    const at = Number(el.dataset.at)
    const phase = el.dataset.phase
    if (el.classList.contains('OnbScene__appear') && Number.isFinite(at)) {
      if (phase === 'entering') {
        const off = APPEAR.offset
        return animClass(`enter:${at}`, () =>
          span(at, APPEAR.enter, `opacity:0;transform:translate3d(0,-${off}px,0)`, 'opacity:1;transform:none', cssEase('enter')),
        )
      }
      if (phase === 'exiting') {
        return animClass(`exit:${at}`, () => span(at, APPEAR.exit, 'opacity:1', 'opacity:0', cssEase('exit')))
      }
    }
    if (el.classList.contains('OnbScene__blackout') && phase === 'exiting' && Number.isFinite(at)) {
      return animClass(`exit:${at}`, () => span(at, APPEAR.exit, 'opacity:1', 'opacity:0', cssEase('exit')))
    }
    if (el.classList.contains('sq-appear')) {
      const since = appearedAt.get(el)
      if (since === undefined) return null
      const cs = getComputedStyle(el)
      const v = (n: string) => cs.getPropertyValue(n).trim()
      const dur = parseFloat(v('--sq-appear-duration')) || DURATION.fast
      const easing = v('--sq-appear-easing') || cssEase('enter')
      const from = `opacity:0;transform:translate3d(${v('--sq-appear-x') || 0},${v('--sq-appear-y') || 0},0) scale(${v('--sq-appear-scale') || 1})`
      return animClass(`sq:${since}:${from}:${dur}`, () => span(since, dur, from, 'opacity:1;transform:none', easing))
    }
    if (el.classList.contains('OnbScene__pop') && el.hasAttribute('data-pop')) {
      const hot = T.hots.find((h) => h.state === 'released' && h.start <= now && now < h.end)
      if (!hot) return null
      const s0 = hot.start
      const d = FEEDBACK.pop
      const mv = cssEase('move')
      return animClass(
        `pop:${s0}`,
        () =>
          `0%{transform:none}${pct(s0)}{transform:scale(1);animation-timing-function:${mv}}${pct(s0 + d * 0.4)}{transform:scale(${FEEDBACK.popScale});animation-timing-function:${mv}}${pct(s0 + d)}{transform:none}100%{transform:none}`,
        'transform-origin:50% 50%',
      )
    }
    return null
  }

  /**
   * Когда появилась каждая накладка `sq-appear`: впервые замеченная в снимке —
   * появилась в этот момент. Ключ — путь от холста: React держит те же узлы,
   * но путь надёжнее. Накладки, стоявшие с начала цикла, не анимируются.
   */
  let seenBefore = new Map<string, number>()
  const pathOf = (el: Element, top: Element) => {
    const parts: string[] = []
    for (let n: Element | null = el; n && n !== top; n = n.parentElement) {
      parts.push(`${n.localName}${n.parentElement ? Array.prototype.indexOf.call(n.parentElement.children, n) : ''}`)
    }
    return parts.join('/')
  }
  const trackAppear = (top: Element, t: number, first: boolean) => {
    const seen = new Map<string, number>()
    top.querySelectorAll('.sq-appear').forEach((el) => {
      const key = pathOf(el, top)
      const since = seenBefore.get(key) ?? (first ? -1 : t)
      seen.set(key, since)
      if (since >= 0) appearedAt.set(el, since)
    })
    seenBefore = seen
  }

  // Меняется только холст сцены: рамка подсказки и текст под сценой — один
  // общий слой, в снимках — только холст. Это и вес, и поведение продукта:
  // перед повтором гаснет миниатюра, а не вся подсказка.
  const serializer = new XMLSerializer()
  const canvasEl = ctrl.canvas!
  const sceneEl = canvasEl.parentElement!
  // Родителя у холста в SVG нет — наследуемые свойства (шрифт, цвет) пишутся ему явно.
  const snapshot = () => serializer.serializeToString(snap(canvasEl, null) as Element)

  // ── ключевые моменты: каждое событие, наведение, нажатие, фокус ──────────
  const marks = new Set<number>([0])
  T.events.forEach((e) => (marks.add(e.at), marks.add(e.at + APPEAR.exit)))
  T.hots.forEach((h) => (marks.add(h.start), marks.add(h.end)))
  T.focuses.forEach((f) => (marks.add(f.start), marks.add(f.end)))
  const times = [...marks].filter((t) => t < T.total).sort((a, b) => a - b)

  const shots: string[] = []
  const segments: { shot: number; start: number; end: number; cut: boolean }[] = []
  // Смена состояния и уход строки — резкая, как в сцене (движение даёт сам
  // элемент); наведение и нажатие перетекают, как переход цвета у компонентов.
  const cuts = new Set<number>([0])
  T.events.forEach((e) => (cuts.add(e.at), cuts.add(e.at + APPEAR.exit)))
  ctrl.seek(loop - 1) // сброс кешей пути курсора: следующая перемотка — назад
  for (let i = 0; i < times.length; i++) {
    ctrl.seek(times[i] + 0.5)
    now = times[i] + 0.5
    trackAppear(canvasEl, times[i], i === 0)
    const html = snapshot()
    let id = shots.indexOf(html)
    if (id === -1) id = shots.push(html) - 1
    const start = times[i]
    const end = i + 1 < times.length ? times[i + 1] : resetAt
    const last = segments[segments.length - 1]
    if (last && last.shot === id) last.end = end
    else segments.push({ shot: id, start, end, cut: cuts.has(start) })
  }
  // Хвост цикла: после затухания сцена встаёт в начало.
  const first = segments[0].shot
  segments.push({ shot: first, start: resetAt, end: loop, cut: true })

  // ── путь курсора и круг нажатия: те же часы, шаг 1/30 с ──────────────────
  const canvas = ctrl.canvas!
  const rr = root.getBoundingClientRect()
  const cr = canvas.getBoundingClientRect()
  const k = cr.width / 480
  const ox = cr.left - rr.left
  const oy = cr.top - rr.top
  const samples: { t: number; f: FrameInfo }[] = []
  ctrl.seek(loop - 1)
  for (let t = 0; t < resetAt; t += SAMPLE_MS) samples.push({ t, f: ctrl.seek(t) })
  samples.push({ t: resetAt, f: samples[samples.length - 1].f })
  const cursorEl = canvas.querySelector('.OnbScene__cursor') as HTMLElement
  const ccs = getComputedStyle(cursorEl)
  const sr = sceneEl.getBoundingClientRect()
  const sx = sr.left - rr.left
  const sy = sr.top - rr.top

  // Общий слой: подсказка целиком, холст снят (его место держит сам блок сцены).
  ctrl.seek(0)
  skipNode = canvasEl
  const base = serializer.serializeToString(snap(root, null) as Element)
  skipNode = null

  const W = Math.ceil(rr.width)
  const H = Math.ceil(rr.height)
  const FADE = FEEDBACK.rowHighlight

  // Видимость снимков. Входящий лежит выше (z-index 2) и при наведении
  // проявляется за `duration/fast` поверх уходящего — так в SVG выглядит
  // переход цвета; при смене состояния снимок встаёт сразу.
  const shotRules = shots.map((_, id) => {
    const pts: [number, number, number][] = []
    segments.forEach((s, i) => {
      if (s.shot !== id) return
      // Короткий отрезок (нажатие — 100 мс) успевает проявиться только за свою длину.
      const fadeIn = s.cut ? 0 : Math.min(FADE, s.end - s.start - 2 * EPS)
      if (s.start <= 0) pts.push([0, 1, 2])
      else pts.push([s.start - EPS, 0, 1], [s.start, 0, 2], [s.start + fadeIn, 1, 2])
      const next = segments[i + 1]
      // Уходящий снимок держится под входящим, пока тот проявляется, но не
      // дольше, чем до своего следующего появления.
      const again = segments.slice(i + 1).find((x) => x.shot === id)
      const hold = Math.min(next ? Math.min(FADE, next.end - next.start) : 0, again ? again.start - s.end - 3 * EPS : Infinity)
      if (!next) pts.push([loop, 1, 2])
      else if (next.cut || hold <= 0) pts.push([s.end - EPS, 1, 2], [s.end, 0, 1])
      else pts.push([s.end - EPS, 1, 2], [s.end, 1, 1], [s.end + hold, 1, 1], [s.end + hold + EPS, 0, 1])
    })
    if (pts[0][0] > 0) pts.unshift([0, 0, 1])
    if (pts[pts.length - 1][0] < loop) pts.push([loop, 0, 1])
    const body = pts.map(([t, o, z]) => `${pct(t)}{opacity:${o};z-index:${z}}`).join('')
    return `.s${id}{animation:k${id} ${loop}ms linear infinite}@keyframes k${id}{${body}}`
  })

  const tr = (x: number, y: number, s: number) =>
    `translate(${(ox + x * k).toFixed(1)}px,${(oy + y * k).toFixed(1)}px) scale(${s})`
  const cursorKf: string[] = []
  const dropKf: string[] = []
  let prevC = ''
  let prevD = ''
  samples.forEach(({ t, f }, i) => {
    const c = tr(f.pos.x, f.pos.y, f.pressed ? 0.85 : 1)
    const isLast = i === samples.length - 1
    if (c !== prevC || isLast) cursorKf.push(`${pct(t)}{transform:${c}}`)
    prevC = c
    const d = f.drop ? `transform:${tr(f.drop.x, f.drop.y, f.drop.scale)};opacity:${f.drop.opacity.toFixed(3)}` : 'opacity:0'
    if (d !== prevD || isLast) dropKf.push(`${pct(t)}{${d}}`)
    prevD = d
  })
  cursorKf.push(`${pct(resetAt + 1)}{transform:${tr(samples[0].f.pos.x, samples[0].f.pos.y, 1)}}`, `100%{transform:${tr(samples[0].f.pos.x, samples[0].f.pos.y, 1)}}`)
  dropKf.push('100%{opacity:0}')

  const allKf = `0%{opacity:1}${pct(T.total)}{opacity:1;animation-timing-function:${cssEase('exit')}}${pct(resetAt)}{opacity:0;animation-timing-function:${cssEase('enter')}}${pct(resetAt + BEAT.fadeIn)}{opacity:1}100%{opacity:1}`

  const cssRules = [...built.rules.entries()].map(([rule, name]) => {
    const [main, ...extra] = rule.split('|')
    let out = main ? `.${name}{${main}}` : ''
    extra.forEach((x) => {
      if (x.startsWith('ph:')) out += `.${name}::placeholder{color:${x.slice(3)}}`
      else {
        const m = x.match(/^(::[a-z]+)\{([\s\S]*)\}$/)
        if (m) out += `.${name}${m[1]}{${m[2]}}`
      }
    })
    return out
  })

  const r = 10 * k
  const style = [
    '.f{position:absolute;left:0;top:0;opacity:0}',
    `.all{animation:ka ${loop}ms linear infinite}@keyframes ka{${allKf}}`,
    ...shotRules,
    ...built.animCss,
    `#cu{animation:kc ${loop}ms linear infinite}@keyframes kc{${cursorKf.join('')}}`,
    `#ri{opacity:0;animation:kd ${loop}ms linear infinite}@keyframes kd{${dropKf.join('')}}`,
    '@media (prefers-reduced-motion:reduce){.f,#cu,#ri,.all{animation:none}.fin{opacity:1}#cu,#ri{display:none}}',
    ...cssRules,
  ].join('')

  // Финальный кадр для «уменьшить движение» — последний снимок перед затуханием.
  const finalShot = segments[segments.length - 2].shot
  const frames = shots
    .map((html, id) => `<div class="f s${id}${id === finalShot ? ' fin' : ''}">${html}</div>`)
    .join('')
  const stage = `<div class="all" style="position:absolute;z-index:100;left:${sx}px;top:${sy}px;width:${sr.width}px;height:${sr.height}px;overflow:hidden">${frames}</div>`

  const svg =
    `<svg xmlns="${SVG_NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<style><![CDATA[${await embedFonts(built.glyphs)}${style}]]></style>` +
    `<defs><clipPath id="sc"><rect x="${(sr.left - rr.left).toFixed(2)}" y="${(sr.top - rr.top).toFixed(2)}" width="${sr.width.toFixed(2)}" height="${sr.height.toFixed(2)}"/></clipPath></defs>` +
    `<foreignObject width="${W}" height="${H}"><div xmlns="${XHTML_NS}" style="position:relative;width:${W}px;height:${H}px">${base}${stage}</div></foreignObject>` +
    `<g class="all" clip-path="url(#sc)"><circle id="ri" r="${r.toFixed(2)}" fill="${ccs.backgroundColor}"/>` +
    `<circle id="cu" r="${(r - k).toFixed(2)}" fill="${ccs.backgroundColor}" opacity="0.8" stroke="${ccs.borderTopColor}" stroke-width="${(2 * k).toFixed(2)}"/></g></svg>`

  frame.remove()
  return { svg, shots: shots.length, segments: segments.length, bytes: new Blob([svg]).size }
}

/* ── шрифты ────────────────────────────────────────────────────────────────
 * Встраиваются начертания, которыми в сцене набран текст, и только те файлы
 * подмножеств (`unicode-range`), где есть его буквы: кириллица и латиница
 * Roboto — это несколько файлов по 12–22 КБ, а не вся гарнитура. Иконки
 * Material не встраиваются — они уже картинки.
 */
type Range = [number, number]

function parseRanges(value: string): Range[] {
  if (!value) return [[0, 0x10ffff]]
  return value.split(',').map((part) => {
    const x = part.trim().replace(/^U\+/i, '')
    if (x.includes('?')) return [parseInt(x.replace(/\?/g, '0'), 16), parseInt(x.replace(/\?/g, 'F'), 16)]
    const [a, b] = x.split('-')
    return [parseInt(a, 16), parseInt(b ?? a, 16)]
  })
}

function weightFits(rule: string, weight: string) {
  const w = Number(weight)
  const [a, b] = rule.split(/\s+/).map((n) => (n === 'normal' ? 400 : n === 'bold' ? 700 : Number(n)))
  return b === undefined || Number.isNaN(b) ? a === w : a <= w && w <= b
}

async function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function embedFonts(glyphs: Map<string, Set<string>>) {
  const faces: { rule: CSSFontFaceRule; base: string }[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const r of Array.from(rules)) if (r instanceof CSSFontFaceRule) faces.push({ rule: r, base: sheet.href ?? location.href })
  }
  const out: string[] = []
  const done = new Set<string>()
  for (const [key, chars] of glyphs) {
    const [family, weight, style] = key.split('|')
    const codes = [...chars].map((c) => c.codePointAt(0)!)
    for (const { rule, base } of faces) {
      const fam = rule.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '')
      if (fam !== family) continue
      if (!weightFits(rule.style.getPropertyValue('font-weight') || '400', weight)) continue
      if ((rule.style.getPropertyValue('font-style') || 'normal') !== style) continue
      const range = rule.style.getPropertyValue('unicode-range')
      const ranges = parseRanges(range)
      if (!codes.some((c) => ranges.some(([a, b]) => a <= c && c <= b))) continue
      const src = rule.style.getPropertyValue('src')
      const m = src.match(/url\(\s*["']?([^"')]+)["']?\s*\)\s*format\(\s*["']?woff2/) ?? src.match(/url\(\s*["']?([^"')]+)["']?\s*\)/)
      if (!m) continue
      const url = new URL(m[1], base).href
      if (done.has(`${fam}|${weight}|${url}`)) continue
      done.add(`${fam}|${weight}|${url}`)
      try {
        const data = m[1].startsWith('data:') ? m[1] : `data:font/woff2;base64,${await toBase64(await (await fetch(url)).arrayBuffer())}`
        const format = /woff2/.test(m[0]) || m[1].includes('woff2') ? 'woff2' : /\.ttf/.test(m[1]) ? 'truetype' : 'woff'
        out.push(
          `@font-face{font-family:"${fam}";font-weight:${weight};font-style:${style};${range ? `unicode-range:${range};` : ''}src:url(${data}) format("${format}")}`,
        )
      } catch {
        // Не скачался файл — текст наберётся запасным шрифтом из стека.
      }
    }
  }
  return out.join('')
}
