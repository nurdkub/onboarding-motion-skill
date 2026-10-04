import { APPEAR, BEAT, DURATION, FEEDBACK, SCENE, cssEase } from './motion'
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

const SKIP = /^(inset-block|inset-inline|margin-block|margin-inline|padding-block|padding-inline|border-block|border-inline|block-size|inline-size|min-block-size|min-inline-size|max-block-size|max-inline-size|overflow-block|overflow-inline|contain-intrinsic|border-start|border-end|scroll-margin|scroll-padding|transition|animation|will-change|cursor|pointer-events|user-select|-webkit-user-select|caret-color|-webkit-tap-highlight-color|outline|scroll|overscroll|touch-action|-webkit-user-drag|interactivity|view-transition|anchor|position-anchor|position-try|math|interpolate-size|field-sizing|zoom|app-region|-webkit-print|print|speak|hyphenate|ruby|text-size-adjust|-webkit-text-size-adjust|row-rule|column-rule|-webkit-locale|text-rendering|-webkit-font-smoothing)/

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
/** Место в стиле, куда скрипт выгрузки кладёт урезанные шрифты. */
export const FONTS_MARK = '/*@onb-fonts*/'

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

/**
 * Сжатие стиля: четыре стороны рамки, поля и скругления — в одно свойство,
 * `box-sizing: border-box` — общим правилом (как у Tailwind), `min-*: auto` —
 * умолчание. Так правила снимков легче вдвое, а вид тот же.
 */
const SIDES = ['top', 'right', 'bottom', 'left'] as const
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const

function compress(list: string[]) {
  const m = new Map(list.map((d) => {
    const i = d.indexOf(':')
    return [d.slice(0, i), d.slice(i + 1)] as [string, string]
  }))
  const take = (k: string) => {
    const v = m.get(k)
    m.delete(k)
    return v
  }
  const extra: string[] = []
  for (const box of ['padding', 'margin']) {
    const v = SIDES.map((sd) => take(`${box}-${sd}`))
    if (v.some(Boolean)) extra.push(`${box}:${v.map((x) => x ?? '0').join(' ')}`)
  }
  const r = CORNERS.map((c) => take(`border-${c}-radius`))
  if (r.some(Boolean)) extra.push(`border-radius:${r.map((x) => x ?? '0').join(' ')}`)
  const sides = SIDES.map((sd) => {
    const w = take(`border-${sd}-width`)
    const st = take(`border-${sd}-style`)
    const c = take(`border-${sd}-color`)
    return w ? `${w} ${st ?? 'solid'}${c ? ' ' + c : ''}` : null
  })
  if (sides.every((x) => x && x === sides[0])) extra.push(`border:${sides[0]}`)
  else sides.forEach((x, i) => x && extra.push(`border-${SIDES[i]}:${x}`))
  if (m.get('box-sizing') === 'border-box') m.delete('box-sizing')
  for (const k of ['min-width', 'min-height']) if (m.get(k) === 'auto') m.delete(k)
  if (m.get('text-wrap-mode') === 'wrap') m.delete('text-wrap-mode')
  return [...[...m].map(([k, v]) => `${k}:${v}`), ...extra].join(';')
}

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
      .replace(/(\d+\.\d\d)\d+px/g, '$1px')
      .replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/g, '#$1$2$3')

  const styleOf = (el: Element, parent: CSSStyleDeclaration | null, pseudo?: string) => {
    const cs = getComputedStyle(el, pseudo)
    const d = defaultsFor(el, pseudo)
    const color = cs.getPropertyValue('color')
    const transformed = cs.getPropertyValue('transform') !== 'none' || cs.getPropertyValue('scale') !== 'none'
    const out: string[] = []
    for (const p of props) {
      const v = cs.getPropertyValue(p)
      // Общее правило снимков — border-box; у кого content-box, пишется явно.
      if (p === 'box-sizing') {
        if (v === 'content-box') out.push('box-sizing:content-box')
        continue
      }
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
    return { cs, css: compress(out) }
  }

  const iconUrl = (el: HTMLElement, cs: CSSStyleDeclaration) => {
    // Размер — в CSS-пикселях раскладки, а не на экране: сцена уменьшена до 0,75.
    const r = { width: el.offsetWidth, height: el.offsetHeight }
    const key = `${el.textContent}|${cs.color}|${cs.fontSize}|${r.width}x${r.height}`
    let url = built.icons.get(key)
    if (!url) {
      // Двойная плотность: сцена и так уменьшена до 0,75, тройная не видна глазу, а весит вдвое больше.
      const k = 2
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
  type Box = { x: number; y: number; w: number; h: number }
  /** Узел снимка → исходный элемент и его место на холсте (px холста) в момент снимка. */
  const origin = new WeakMap<Node, Element>()
  const rects = new WeakMap<Node, Box>()
  let canvasBox: DOMRect | null = null
  const snap = (el: Element, parent: CSSStyleDeclaration | null): Node | null => {
    if (el === skipNode) return null
    if (el instanceof HTMLElement) {
      if (el.matches('.OnbScene__cursor, .OnbScene__ripple, .OnbScene__problems')) return null
      if (getComputedStyle(el).display === 'none') return null
    }
    if (el instanceof SVGSVGElement && el.parentElement?.namespaceURI === XHTML_NS) return svgIcon(el, parent)
    const isSvg = el.namespaceURI === SVG_NS
    const clone = document.createElementNS(el.namespaceURI ?? XHTML_NS, el.localName)
    origin.set(clone, el)
    if (el instanceof HTMLElement && canvasBox) {
      const r = el.getBoundingClientRect()
      const kk = canvasBox.width / SCENE.width
      rects.set(clone, { x: (r.left - canvasBox.left) / kk, y: (r.top - canvasBox.top) / kk, w: r.width / kk, h: r.height / kk })
    }
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
  const snapshot = () => {
    canvasBox = canvasEl.getBoundingClientRect()
    const tree = snap(canvasEl, null) as Element
    canvasBox = null
    return tree
  }

  /**
   * Заплатка вместо снимка (05.10.2026, ради бюджета 100 КБ): наведение,
   * нажатие, галочка, буква в поле меняют один узел, а снимок целиком весит
   * килобайты. Отличие от опорного снимка ищется по дереву, и если оно
   * собирается в одно поддерево заметно меньше снимка, в файл идёт только
   * оно — поверх опорного, на своём месте холста и на фоне, который под ним.
   */
  const pathTo = (node: Node, top: Node) => {
    const path: number[] = []
    for (let n: Node = node; n !== top; n = n.parentNode!) path.unshift(Array.prototype.indexOf.call(n.parentNode!.childNodes, n))
    return path
  }
  const follow = (top: Node, path: number[]) => path.reduce<Node | undefined>((n, i) => n?.childNodes[i], top)
  const diffRoots = (a: Node, b: Node, out: Node[]) => {
    if (a.isEqualNode(b)) return
    const shallowSame =
      a.nodeType === b.nodeType &&
      a.nodeName === b.nodeName &&
      a.childNodes.length === b.childNodes.length &&
      (!(a instanceof Element) || [...a.attributes].every((x) => (b as Element).getAttribute(x.name) === x.value) && a.attributes.length === (b as Element).attributes.length)
    if (!shallowSame || a.nodeType === Node.TEXT_NODE) {
      out.push(b.nodeType === Node.ELEMENT_NODE ? b : b.parentNode!)
      return
    }
    a.childNodes.forEach((c, i) => diffRoots(c, b.childNodes[i], out))
  }
  const commonRoot = (nodes: Node[], top: Node) => {
    const paths = nodes.map((n) => pathTo(n, top))
    const common: number[] = []
    for (let i = 0; paths.every((p) => i < p.length && p[i] === paths[0][i]); i++) common.push(paths[0][i])
    let node = follow(top, common)
    // Корнем заплатки может быть только элемент разметки со своим местом на холсте.
    while (node && node !== top && !(node instanceof HTMLElement && rects.has(node))) node = node.parentNode!
    return node && node !== top ? (node as HTMLElement) : null
  }
  const moving = (el: Element) => {
    // Предок в движении (появление, уход) — заплатка отстала бы от него.
    for (let n: Element | null = el; n && n !== canvasEl; n = n.parentElement) {
      const h = n as HTMLElement
      const at = Number(h.dataset?.at)
      const busy = h.dataset?.kind === 'result' ? APPEAR.enter + APPEAR.highlight : APPEAR.enter
      if (Number.isFinite(at) && now - at < busy) return true
      const since = appearedAt.get(n)
      if (since !== undefined && now - since < DURATION.slow) return true
    }
    return false
  }
  const backdrop = (el: Element) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return short(bg)
      if (n === canvasEl) break
    }
    return '#fff'
  }
  const makePatch = (base: Element, tree: Element): string | null => {
    const roots: Node[] = []
    diffRoots(base, tree, roots)
    if (!roots.length) return null
    const node = commonRoot(roots, tree)
    if (!node) return null
    // Вне заплатки ничего не должно сдвинуться: окно по центру меняет место,
    // когда в нём меньше строк, — тогда отличие не только в поддереве.
    const still = (a: Node, b2: Node): boolean => {
      if (b2 === node) return true
      const ra = rects.get(a)
      const rb = rects.get(b2)
      if (ra && rb && (Math.abs(ra.x - rb.x) > 0.5 || Math.abs(ra.y - rb.y) > 0.5 || Math.abs(ra.w - rb.w) > 0.5 || Math.abs(ra.h - rb.h) > 0.5)) return false
      if (a.childNodes.length !== b2.childNodes.length) return false
      return [...b2.childNodes].every((c, i) => still(a.childNodes[i], c))
    }
    if (!still(base, tree)) return null
    const el = origin.get(node)
    const r = rects.get(node)
    const b = rects.get(follow(base, pathTo(node, tree)) as Node)
    if (!el || !r || moving(el)) return null
    const box = b
      ? { x: Math.min(r.x, b.x), y: Math.min(r.y, b.y), w: Math.max(r.x + r.w, b.x + b.w) - Math.min(r.x, b.x), h: Math.max(r.y + r.h, b.y + b.h) - Math.min(r.y, b.y) }
      : r
    // Заплатка лежит поверх всего снимка: если узел накрыт накладкой (окно,
    // затемнение, меню), она вылезла бы над ней — тогда снимок целиком.
    const kk = canvasEl.getBoundingClientRect().width / SCENE.width
    const cb = canvasEl.getBoundingClientRect()
    const covered = [...canvasEl.querySelectorAll('.sq-appear, .OnbScene__blackout')].some((o) => {
      if (o.contains(el) || el.contains(o)) return false
      const q = o.getBoundingClientRect()
      const ox = (q.left - cb.left) / kk
      const oy = (q.top - cb.top) / kk
      return ox < box.x + box.w && box.x < ox + q.width / kk && oy < box.y + box.h && box.y < oy + q.height / kk
    })
    if (covered) return null
    const ownNode = snap(el, null) as Element
    // Место узла уже задано обёрткой — его внешние поля сдвинули бы его второй раз.
    ownNode.setAttribute('style', 'margin:0')
    const own = serializer.serializeToString(ownNode)
    const n2 = (v: number) => +v.toFixed(2)
    return (
      `<div class="${tree.getAttribute('class') ?? ''}">` +
      `<div style="position:absolute;left:${n2(box.x)}px;top:${n2(box.y)}px;width:${n2(box.w)}px;height:${n2(box.h)}px;background:${backdrop(el)}">` +
      `<div style="position:absolute;left:${n2(r.x - box.x)}px;top:${n2(r.y - box.y)}px;width:${n2(r.w)}px;height:${n2(r.h)}px">${own}</div></div></div>`
    )
  }

  // ── ключевые моменты: каждое событие, наведение, нажатие, фокус ──────────
  const marks = new Set<number>([0])
  T.events.forEach((e) => (marks.add(e.at), marks.add(e.at + APPEAR.exit)))
  T.hots.forEach((h) => (marks.add(h.start), marks.add(h.end)))
  T.focuses.forEach((f) => (marks.add(f.start), marks.add(f.end)))
  const times = [...marks].filter((t) => t < T.total).sort((a, b) => a - b)

  const shots: { html: string; base: number | null }[] = []
  const segments: { shot: number; start: number; end: number; cut: boolean }[] = []
  // Смена состояния и уход строки — резкая, как в сцене (движение даёт сам
  // элемент); наведение и нажатие перетекают, как переход цвета у компонентов.
  const cuts = new Set<number>([0])
  T.events.forEach((e) => (cuts.add(e.at), cuts.add(e.at + APPEAR.exit)))
  let baseTree: Element | null = null
  let baseId = -1
  ctrl.seek(loop - 1) // сброс кешей пути курсора: следующая перемотка — назад
  for (let i = 0; i < times.length; i++) {
    ctrl.seek(times[i] + 0.5)
    now = times[i] + 0.5
    trackAppear(canvasEl, times[i], i === 0)
    const tree = snapshot()
    const html = serializer.serializeToString(tree)
    let id = shots.findIndex((x) => x.base === null && x.html === html)
    if (id === -1 && baseTree) {
      const patch = makePatch(baseTree, tree)
      if (patch && patch.length < html.length * 0.5) {
        id = shots.findIndex((x) => x.base === baseId && x.html === patch)
        if (id === -1) id = shots.push({ html: patch, base: baseId }) - 1
      }
    }
    if (id === -1) id = shots.push({ html, base: null }) - 1
    if (shots[id].base === null) {
      baseTree = tree
      baseId = id
    }
    const start = times[i]
    const end = i + 1 < times.length ? times[i + 1] : resetAt
    const last = segments[segments.length - 1]
    if (last && last.shot === id) last.end = end
    else segments.push({ shot: id, start, end, cut: cuts.has(start) })
  }
  // Хвост цикла: после затухания сцена встаёт в начало.
  const first = segments[0].shot
  segments.push({ shot: first, start: resetAt, end: loop, cut: true })

  // ── путь курсора и круг нажатия: точки снимаются с тех же часов ──────────
  const canvas = ctrl.canvas!
  const rr = root.getBoundingClientRect()
  const cr = canvas.getBoundingClientRect()
  const k = cr.width / 480
  const ox = cr.left - rr.left
  const oy = cr.top - rr.top
  // Курсор движется по прямой с кривой `move`, круг нажатия — по `enter`
  // и `move`: в CSS это те же cubic-bezier, поэтому достаточно опорных точек
  // (начало и конец каждого пути, каждое нажатие), а не кадров 30 раз в секунду.
  // Перемотка — строго вперёд: так движок меряет цели путей один раз, как в живой сцене.
  // Цель пути меряется по разметке предыдущего кадра (как в живой сцене, где
  // кадры идут часто), поэтому перед началом пути — кадр с актуальной разметкой.
  const wanted = [
    0,
    ...T.moves.flatMap((m) => [m.start - EPS, m.start + EPS, m.end]),
    ...T.hots.filter((h) => h.state === 'pressed').map((h) => h.start + EPS),
  ]
  const posAt = new Map<number, FrameInfo['pos']>()
  ctrl.seek(loop - 1)
  for (const t of [...new Set(wanted)].sort((a, b) => a - b)) posAt.set(t, ctrl.seek(t).pos)
  const start = posAt.get(0)!
  const legs = T.moves.map((m) => ({ ...m, to: posAt.get(m.end)! }))
  const presses = T.hots.filter((h) => h.state === 'pressed').map((h) => ({ ...h, pos: posAt.get(h.start + EPS)! }))
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

  // Опорные снимки видны и под своими заплатками: их отрезки сливаются.
  const baseOf = (id: number) => shots[id].base ?? id
  const baseSegs: typeof segments = []
  segments.forEach((sg) => {
    const last = baseSegs[baseSegs.length - 1]
    if (last && last.shot === baseOf(sg.shot)) last.end = sg.end
    else baseSegs.push({ ...sg, shot: baseOf(sg.shot) })
  })
  const keyframes = (id: number, list: typeof segments, lo: number, hi: number, isPatch: boolean) => {
    const pts: [number, number, number][] = []
    list.forEach((sg, i) => {
      if (sg.shot !== id) return
      // Короткий отрезок (нажатие — 100 мс) успевает проявиться только за свою длину.
      const fadeIn = sg.cut ? 0 : Math.min(FADE, sg.end - sg.start - 2 * EPS)
      // Опорный снимок, пока проявляется, лежит выше всего (z 5): под ним
      // держится всё уходящее, в том числе заплатки прежнего опорного.
      const top = isPatch ? hi : 5
      if (sg.start <= 0) pts.push([0, 1, hi])
      else if (fadeIn > 0) pts.push([sg.start - EPS, 0, lo], [sg.start, 0, top], [sg.start + fadeIn, 1, top], [sg.start + fadeIn + EPS, 1, hi])
      else pts.push([sg.start - EPS, 0, lo], [sg.start, 1, hi])
      const next = list[i + 1]
      if (!next) {
        pts.push([loop, 1, hi])
        return
      }
      const span = next.end - next.start
      // Заплатка уходит на свой опорный снимок — гаснет поверх него.
      if (isPatch && !next.cut && next.shot === shots[id].base) {
        const out = Math.min(FADE, span)
        pts.push([sg.end - EPS, 1, hi], [sg.end, 1, lo], [sg.end + out, 0, lo])
        return
      }
      // Уходящий держится под входящим, пока тот проявляется, но не дольше,
      // чем до своего следующего появления.
      const again = list.slice(i + 1).find((x) => x.shot === id)
      const hold = Math.min(Math.min(FADE, span), again ? again.start - sg.end - 3 * EPS : Infinity)
      if (next.cut || hold <= 0) pts.push([sg.end - EPS, 1, hi], [sg.end, 0, lo])
      else pts.push([sg.end - EPS, 1, hi], [sg.end, 1, lo], [sg.end + hold, 1, lo], [sg.end + hold + EPS, 0, lo])
    })
    if (pts[0][0] > 0) pts.unshift([0, 0, lo])
    if (pts[pts.length - 1][0] < loop) pts.push([loop, 0, lo])
    const body = pts.map(([t, o, z]) => `${pct(t)}{opacity:${o};z-index:${z}}`).join('')
    return `.s${id}{animation:k${id} ${loop}ms linear infinite}@keyframes k${id}{${body}}`
  }
  // Видимость снимков. Входящий лежит выше и при наведении проявляется за
  // `duration/fast` поверх уходящего — так в SVG выглядит переход цвета; при
  // смене состояния снимок встаёт сразу. Заплатки — слоем выше опорных.
  const shotRules = shots.map((sh, id) =>
    sh.base === null ? keyframes(id, baseSegs, 1, 2, false) : keyframes(id, segments, 3, 4, true),
  )

  const tr = (x: number, y: number, s: number) =>
    `translate(${(ox + x * k).toFixed(1)}px,${(oy + y * k).toFixed(1)}px) scale(${s})`
  // Точки курсора: [время, x, y, масштаб, кривая до следующей точки].
  const pts: [number, number, number, number, string?][] = [[0, start.x, start.y, 1]]
  let pos = start
  const events: { t: number; kind: 'move' | 'press'; i: number }[] = [
    ...legs.map((_, i) => ({ t: legs[i].start, kind: 'move' as const, i })),
    ...presses.map((_, i) => ({ t: presses[i].start, kind: 'press' as const, i })),
  ].sort((a, b) => a.t - b.t)
  for (const e of events) {
    if (e.kind === 'move') {
      const l = legs[e.i]
      pts.push([l.start, pos.x, pos.y, 1, cssEase('move')], [l.end, l.to.x, l.to.y, 1])
      pos = l.to
    } else {
      const p = presses[e.i]
      pts.push([p.start - EPS, pos.x, pos.y, 1], [p.start, pos.x, pos.y, SCENE.cursorPress], [p.end - EPS, pos.x, pos.y, SCENE.cursorPress], [p.end, pos.x, pos.y, 1])
    }
  }
  pts.push([resetAt, pos.x, pos.y, 1], [resetAt + EPS, start.x, start.y, 1], [loop, start.x, start.y, 1])
  const cursorKf = pts.map(([t, x, y, sc, e]) => `${pct(t)}{transform:${tr(x, y, sc)}${e ? `;animation-timing-function:${e}` : ''}}`)

  // Круг нажатия: внешний слой гаснет по `move`, внутренний расходится по `enter`.
  const dropOp: string[] = ['0%{opacity:0}']
  const dropTr: string[] = []
  presses.forEach((p) => {
    const end = p.start + FEEDBACK.drop
    dropOp.push(`${pct(p.start - EPS)}{opacity:0}`, `${pct(p.start)}{opacity:${FEEDBACK.dropOpacity};animation-timing-function:${cssEase('move')}}`, `${pct(end)}{opacity:0}`)
    dropTr.push(
      `${pct(p.start - EPS)}{transform:${tr(p.pos.x, p.pos.y, 1)}}`,
      `${pct(p.start)}{transform:${tr(p.pos.x, p.pos.y, 1)};animation-timing-function:${cssEase('enter')}}`,
      `${pct(end)}{transform:${tr(p.pos.x, p.pos.y, FEEDBACK.dropScale)}}`,
    )
  })
  dropOp.push('100%{opacity:0}')

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
    '*{box-sizing:border-box}.f{position:absolute;left:0;top:0;opacity:0}',
    `.all{animation:ka ${loop}ms linear infinite}@keyframes ka{${allKf}}`,
    ...shotRules,
    ...built.animCss,
    `#cu{animation:kc ${loop}ms linear infinite}@keyframes kc{${cursorKf.join('')}}`,
    `#rio{opacity:0;animation:kd ${loop}ms linear infinite}@keyframes kd{${dropOp.join('')}}`,
    `#ri{animation:ke ${loop}ms linear infinite}@keyframes ke{${dropTr.join('')}}`,
    '@media (prefers-reduced-motion:reduce){.f,#cu,#ri,#rio,.all{animation:none}.fin{opacity:1}#cu,#rio{display:none}}',
    ...cssRules,
  ].join('')

  // Финальный кадр для «уменьшить движение» — последний снимок перед затуханием.
  const finalShot = segments[segments.length - 2].shot
  const fin = new Set([finalShot, baseOf(finalShot)])
  const frames = shots
    .map((sh, id) => `<div class="f s${id}${fin.has(id) ? ' fin' : ''}">${sh.html}</div>`)
    .join('')
  const stage = `<div class="all" style="position:absolute;z-index:100;left:${sx}px;top:${sy}px;width:${sr.width}px;height:${sr.height}px;overflow:hidden">${frames}</div>`

  const svg =
    `<svg xmlns="${SVG_NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<style><![CDATA[${FONTS_MARK}${style}]]></style>` +
    `<defs><clipPath id="sc"><rect x="${(sr.left - rr.left).toFixed(2)}" y="${(sr.top - rr.top).toFixed(2)}" width="${sr.width.toFixed(2)}" height="${sr.height.toFixed(2)}"/></clipPath></defs>` +
    `<foreignObject width="${W}" height="${H}"><div xmlns="${XHTML_NS}" style="position:relative;width:${W}px;height:${H}px">${base}${stage}</div></foreignObject>` +
    `<g class="all" clip-path="url(#sc)"><g id="rio"><circle id="ri" r="${r.toFixed(2)}" fill="${ccs.backgroundColor}"/></g>` +
    `<circle id="cu" r="${(r - k).toFixed(2)}" fill="${ccs.backgroundColor}" opacity="0.8" stroke="${ccs.borderTopColor}" stroke-width="${(2 * k).toFixed(2)}"/></g></svg>`

  frame.remove()
  return {
    svg,
    fonts: fontFaces(built.glyphs),
    shots: shots.filter((x) => x.base === null).length,
    patches: shots.filter((x) => x.base !== null).length,
    segments: segments.length,
  }
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

/**
 * Какие файлы шрифтов нужны сцене и какие буквы из каждого: скрипт выгрузки
 * скачивает их, урезает до этих букв и кладёт в SVG на место `FONTS_MARK`.
 * Урезанный шрифт весит единицы килобайт вместо десятков.
 */
export interface FontFaceNeed {
  family: string
  weight: string
  style: string
  range: string
  url: string
  text: string
}

function fontFaces(glyphs: Map<string, Set<string>>): FontFaceNeed[] {
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
  const out: FontFaceNeed[] = []
  for (const [key, chars] of glyphs) {
    const [family, weight, style] = key.split('|')
    for (const { rule, base } of faces) {
      const fam = rule.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '')
      if (fam !== family) continue
      if (!weightFits(rule.style.getPropertyValue('font-weight') || '400', weight)) continue
      if ((rule.style.getPropertyValue('font-style') || 'normal') !== style) continue
      const range = rule.style.getPropertyValue('unicode-range')
      const ranges = parseRanges(range)
      const text = [...chars].filter((c) => ranges.some(([a, b]) => a <= c.codePointAt(0)! && c.codePointAt(0)! <= b)).join('')
      if (!text) continue
      const src = rule.style.getPropertyValue('src')
      const m = src.match(/url\(\s*["']?([^"')]+)["']?\s*\)\s*format\(\s*["']?woff2/) ?? src.match(/url\(\s*["']?([^"')]+)["']?\s*\)/)
      if (!m) continue
      out.push({ family: fam, weight, style, range, url: new URL(m[1], base).href, text })
    }
  }
  return out
}
