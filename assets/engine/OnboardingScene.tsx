import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'
import { ModalActionBar, ModalHeader } from '@/components/square/Modal'
import { Blackout } from '@/components/square/Blackout'
import { APPEAR, BEAT, DURATION, FEEDBACK, SCENE, WINDOW, ZOOM, cssEase, ease } from './motion'
import { compile, stateAt, stepAt } from './story'
import type { Cue, HotState, Story, Timeline } from './story'
import './onboarding.css'

/**
 * Onboarding / Scene — проигрыватель сценария.
 *
 * Внутри — настоящие компоненты Square на холсте 480×320, показанном
 * в масштабе 0.75. Поэтому бренд в сцене соблюдается сам: кнопка нажимается
 * своим pressed, поле фокусируется своей обводкой, окно появляется своей
 * анимацией — ничего не рисуется заново.
 *
 * Время — одни часы на requestAnimationFrame. Из них выводятся и состояние
 * сцены (свёртка событий до момента t), и путь курсора, и hovered/pressed
 * у цели. Отсюда три свойства, ради которых так сделано:
 * - часы стоят, пока вкладка скрыта, — вернувшись, человек видит сцену
 *   с того же места, а не финал;
 * - `prefers-reduced-motion` показывает финальный кадр без движения —
 *   это та же свёртка, только сразу до конца;
 * - сброс перед повтором точный: состояние — функция времени, а не
 *   накопленный `useState`.
 */

interface SceneContextValue {
  hot: { target: string; state: HotState } | null
  focus: string | null
  /** Ложь, пока сцена сбрасывается или движение выключено: появления без анимации. */
  animate: boolean
  /**
   * Время цикла при выгрузке в SVG, мс; в живой сцене — `null`. По нему
   * `SceneAppear` и `SceneWindow` знают, когда появились или ушли, и проходят
   * свои фазы без таймеров: выгрузка снимает их на нужных моментах.
   */
  clock: number | null
  /** Точка последнего нажатия, px холста: из неё вырастает окно сцены. */
  press: Point | null
}

const SceneContext = createContext<SceneContextValue>({
  hot: null,
  focus: null,
  animate: false,
  clock: null,
  press: null,
})

/**
 * Центрирование по итоговому кадру. Сцена с `ScenePlane center` раскладывается
 * под содержимое финального кадра — его рисуют один раз невидимым слоем
 * и меряют высоту группы. Поэтому кнопка с самого начала стоит там, где
 * она окажется, когда под ней появится ответ, и группа не едет.
 */
interface CenterContextValue {
  measuring: boolean
  finalHeight: number | null
  report: (height: number) => void
  request: () => void
}

const CenterContext = createContext<CenterContextValue>({
  measuring: false,
  finalHeight: null,
  report: () => {},
  request: () => {},
})

/**
 * Подмена чисел движения — ТОЛЬКО для страницы сравнения вариантов
 * анимации. В сценах её нет и быть не должно: правило «у сцены нет своих
 * чисел» остаётся, вариант, который выберут, переносится в motion.ts.
 */
export interface MotionPreview {
  /** CSS-переменные `--onb-*` поверх motion.ts. */
  vars?: CSSProperties
  /** Кривая пути курсора: доля пути по доле времени. */
  cursor?: (p: number) => number
  /** Сколько живёт уходящая строка и уходящее окно, мс. */
  itemExit?: number
  windowExit?: number
}

const MotionPreviewContext = createContext<MotionPreview | null>(null)

export function SceneMotionPreview({ preview, children }: { preview: MotionPreview; children: ReactNode }) {
  return <MotionPreviewContext.Provider value={preview}>{children}</MotionPreviewContext.Provider>
}

/** Цели внутри строки `SceneAppear` — по ним строка узнаёт, что нажали в ней. */
const ItemContext = createContext<Set<string> | null>(null)

function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = () => setReduced(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * Числа из motion.ts, отданные в CSS переменными: у onboarding.css своих
 * длительностей и кривых нет, иначе источников правды стало бы два.
 */
const MOTION_VARS = {
  '--onb-enter-duration': `${APPEAR.enter}ms`,
  '--onb-exit-duration': `${APPEAR.exit}ms`,
  '--onb-highlight-duration': `${APPEAR.highlight}ms`,
  '--onb-offset': `${APPEAR.offset}px`,
  '--onb-ease-enter': cssEase('enter'),
  '--onb-ease-exit': cssEase('exit'),
  '--onb-press-duration': `${BEAT.press}ms`,
  '--onb-pop-duration': `${FEEDBACK.pop}ms`,
  '--onb-pop-scale': String(FEEDBACK.popScale),
  '--onb-row-duration': `${FEEDBACK.rowHighlight}ms`,
  '--onb-ease-move': cssEase('move'),
  '--onb-window-duration': `${WINDOW.enter}ms`,
  '--onb-caret-blink': `${BEAT.caretBlink}ms`,
  '--onb-collapse-duration': `${APPEAR.collapse}ms`,
  '--onb-window-easing-spring': WINDOW.easing,
  '--onb-window-scale': String(WINDOW.scale),
  '--onb-window-exit': `${WINDOW.exit}ms`,
  '--onb-window-easing': WINDOW.easing,
} as CSSProperties

type Phase = 'play' | 'out' | 'in'

export interface OnboardingSceneProps<S> {
  story: Story<S>
  /** Разметка сцены по её состоянию. Только компоненты Square и примитивы `Scene*`. */
  children: (state: S) => ReactNode
}

export function OnboardingScene<S>({ story, children }: OnboardingSceneProps<S>) {
  const timeline = useMemo(() => compile(story), [story])
  useEffect(() => {
    if (import.meta.env.DEV) timeline.warnings.forEach((w) => console.warn(`[onboarding] ${w}`))
  }, [timeline])
  const reduced = usePrefersReducedMotion()
  const preview = useContext(MotionPreviewContext)
  const broken = import.meta.env.DEV && timeline.problems.length > 0
  const still = reduced || broken
  // Страница выгрузки в SVG ставит флаг до монтирования — читаем его здесь, а не при загрузке модуля.
  const [exporting] = useState(isExporting)

  const [step, setStep] = useState(() => (still ? timeline.events.length : 0))
  const [hot, setHot] = useState<SceneContextValue['hot']>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('play')
  const [clock, setClock] = useState<number | null>(null)
  const [press, setPress] = useState<Point | null>(null)
  const [cue, setCue] = useState<Cue | null>(null)

  const canvasRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const rippleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (still) {
      setStep(timeline.events.length)
      setHot(null)
      setFocus(null)
      setPhase('play')
      return
    }
    const setters = { setStep, setHot, setFocus, setPhase, setClock, setPress, setCue }
    // Выгрузка в SVG ведёт время сама: часы не идут, сцена отдаёт перемотку.
    const cursorEase = preview?.cursor ?? ((p: number) => ease('move', p))
    if (exporting) return registerForExport(timeline, canvasRef, cursorRef, rippleRef, setters, cursorEase)
    return runClock(timeline, canvasRef, cursorRef, rippleRef, setters, cursorEase)
  }, [timeline, still, preview])

  const state = useMemo(() => stateAt(story, timeline, step), [story, timeline, step])
  const finalState = useMemo(() => stateAt(story, timeline, timeline.events.length), [story, timeline])
  const [wantFinal, setWantFinal] = useState(false)
  const [finalHeight, setFinalHeight] = useState<number | null>(null)
  const center = useMemo<CenterContextValue>(
    () => ({ measuring: false, finalHeight, report: () => {}, request: () => setWantFinal(true) }),
    [finalHeight],
  )
  const measure = useMemo<CenterContextValue>(
    () => ({ measuring: true, finalHeight: null, report: setFinalHeight, request: () => {} }),
    [],
  )
  const still_ = useMemo<SceneContextValue>(() => ({ hot: null, focus: null, animate: false, clock: null, press: null }), [])
  const context = useMemo<SceneContextValue>(
    () => ({
      hot,
      focus,
      animate: !still && !exporting && phase === 'play',
      clock: exporting ? clock : null,
      press,
    }),
    [hot, focus, still, phase, clock, press],
  )

  const fade: CSSProperties =
    phase === 'out'
      ? { opacity: 0, transition: `opacity ${BEAT.fadeOut}ms ${cssEase('exit')}` }
      : { opacity: 1, transition: `opacity ${BEAT.fadeIn}ms ${cssEase('enter')}` }

  return (
    <div
      className="OnbScene"
      style={{
        inlineSize: SCENE.width * SCENE.scale,
        blockSize: SCENE.height * SCENE.scale,
        ...MOTION_VARS,
        ...preview?.vars,
      }}
      aria-hidden="true"
    >
      <div
        ref={canvasRef}
        className="OnbScene__canvas"
        style={{ inlineSize: SCENE.width, blockSize: SCENE.height, scale: String(SCENE.scale), ...fade }}
        inert
      >
        <SceneContext.Provider value={context}>
          <CenterContext.Provider value={center}>{children(state)}</CenterContext.Provider>
        </SceneContext.Provider>
        {wantFinal && (
          <div className="OnbScene__measure" aria-hidden="true">
            <SceneContext.Provider value={still_}>
              <CenterContext.Provider value={measure}>{children(finalState)}</CenterContext.Provider>
            </SceneContext.Provider>
          </div>
        )}
        {!still && <div ref={rippleRef} className="OnbScene__ripple" />}
        {!still && <div className="OnbScene__ghost" />}
        {!still && cue && (
          <div key={cue.start} className="OnbScene__cue" data-kind={cue.kind}>
            {cue.kind === 'key' && (
              <span className="OnbScene__keys">
                {cue.label?.split('+').map((k) => (
                  <span key={k} className="OnbScene__key body-lStrong">
                    {k === 'Shift' && (
                      // Знак ⇧: контур стрелки — широкий наконечник и узкая ножка,
                      // как на клавише. Глифа нет ни в Roboto, ни в material-icons.
                      <svg className="OnbScene__shiftSvg" viewBox="0 0 16 16" aria-hidden="true">
                        <path
                          d="M8 1.5 14.5 8.5H11V14.5H5V8.5H1.5Z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                    {k}
                  </span>
                ))}
              </span>
            )}
            {cue.kind === 'right' && (
              <span className="OnbScene__mouse">
                <span className="OnbScene__mouseButton" />
              </span>
            )}
            {cue.kind === 'wheel' && (
              <span className="OnbScene__mouse" data-wheel="">
                <span className="OnbScene__mouseWheel" />
              </span>
            )}
          </div>
        )}
        {!still && <SceneCursor ref={cursorRef} />}
      </div>

      {broken && (
        <div className="OnbScene__problems">
          <b>Сцена не играет — нарушены потолки motion.ts</b>
          {timeline.problems.map((problem) => (
            <span key={problem}>{problem}</span>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── часы ──────────────────────────────────────────────────────────────── */

interface Setters {
  setStep: (n: number) => void
  setHot: (hot: SceneContextValue['hot']) => void
  setFocus: (target: string | null) => void
  setPhase: (phase: Phase) => void
  setClock: (t: number | null) => void
  setPress: (point: Point) => void
  setCue: (cue: Cue | null) => void
}

type Point = { x: number; y: number }

/**
 * Один кадр сцены в момент t цикла: состояние, цель под курсором, фокус, фаза,
 * курсор и круг нажатия. Его зовут и живые часы, и перемотка выгрузки в SVG —
 * поэтому SVG проигрывает ровно то же, что сцена в продукте.
 */
export interface FrameInfo {
  pos: Point
  pressed: boolean
  drop: { x: number; y: number; scale: number; opacity: number } | null
}

function createFrame<S>(
  timeline: Timeline<S>,
  canvasRef: React.RefObject<HTMLDivElement | null>,
  cursorRef: React.RefObject<HTMLDivElement | null>,
  rippleRef: React.RefObject<HTMLDivElement | null>,
  set: Setters,
  cursorEase: (p: number) => number = (p) => ease('move', p),
) {
  /** Куда ведёт каждый путь курсора в этом цикле. Меряется один раз, при старте пути. */
  let resolved: (Point | null)[] = []
  let origins: Point[] = []
  let prev = { step: -1, hot: '', focus: '', phase: '' }
  let dropAt: { start: number; x: number; y: number } | null = null
  let pressedAt = -1
  let cueAt: number | null = null
  let dragAt: number | null = null
  let clickedAt = -1
  let clickedField: string | null = null
  let lastT = Infinity

  const measure = (target: string): Point | null => {
    const canvas = canvasRef.current
    const node = canvas?.querySelector(`[data-scene-target="${CSS.escape(target)}"]`)
    if (!canvas || !node) {
      if (import.meta.env.DEV) console.warn(`[onboarding] цель «${target}» не найдена в сцене`)
      return null
    }
    // Точка прицела: у цели может быть своя часть, куда нажимают (`aim`) —
    // сам переключатель, а не середина подписи.
    const aim = (node as HTMLElement).dataset.sceneAim
    const c = canvas.getBoundingClientRect()
    // Поле ввода: курсор нажимает у начала текста, а не в середину — там
    // появится каретка, и глаз увидит её прямо у острия (решение 06.10.2026).
    const field = !aim && node.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]), textarea')
    if (field) {
      const f = field.getBoundingClientRect()
      return {
        x: (f.left + Math.min(28 * SCENE.scale, f.width / 4) - c.left) / SCENE.scale,
        y: (f.top + f.height / 2 - c.top) / SCENE.scale,
      }
    }
    const r = ((aim && node.querySelector(aim)) || node).getBoundingClientRect()
    return {
      x: (r.left + r.width / 2 - c.left) / SCENE.scale,
      y: (r.top + r.height / 2 - c.top) / SCENE.scale,
    }
  }

  /**
   * Цель под курсором в точке `p` — самая мелкая из накрывающих. По ней
   * наведение идёт за курсором по пути, как у настоящей мыши: строка списка,
   * над которой курсор проезжает, подсвечивается и гаснет.
   */
  const targetAt = (p: Point): string | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const c = canvas.getBoundingClientRect()
    let best: { id: string; area: number } | null = null
    canvas.querySelectorAll<HTMLElement>('[data-scene-target]').forEach((node) => {
      const r = node.getBoundingClientRect()
      const left = (r.left - c.left) / SCENE.scale
      const top = (r.top - c.top) / SCENE.scale
      const w = r.width / SCENE.scale
      const h = r.height / SCENE.scale
      if (p.x < left || p.x > left + w || p.y < top || p.y > top + h) return
      if (!best || w * h < best.area) best = { id: node.dataset.sceneTarget!, area: w * h }
    })
    return (best as { id: string } | null)?.id ?? null
  }

  return (t: number): FrameInfo => {
    // Новый цикл (или перемотка назад) — пути курсора меряются заново.
    if (t < lastT) {
      resolved = []
      origins = []
    }
    lastT = t

    const resetAt = timeline.total + BEAT.fadeOut
    const playing = t < timeline.total

    const step = t < resetAt ? stepAt(timeline, t) : 0
    const phase: Phase = playing ? 'play' : t < resetAt ? 'out' : 'in'
    const timed = playing ? timeline.hots.find((h) => h.start <= t && t < h.end) : undefined
    // Фокус: по сценарию печати — или от клика по полю: нажали в поле — в нём
    // каретка, пока не нажали куда-то ещё.
    const typed = playing ? timeline.focuses.find((f) => f.start <= t && t < f.end) : undefined
    const lastHit = playing
      ? timeline.hots.findLast((h) => h.state === 'pressed' && h.start + BEAT.press <= t)
      : undefined
    if (lastHit && lastHit.start !== clickedAt) {
      clickedAt = lastHit.start
      const node = canvasRef.current?.querySelector(`[data-scene-target="${CSS.escape(lastHit.target)}"]`)
      clickedField = node?.querySelector('input:not([type=checkbox]):not([type=radio]), textarea') ? lastHit.target : null
    }
    if (!lastHit) clickedField = null
    const focus = typed ?? (clickedField ? { target: clickedField } : undefined)

    if (step !== prev.step) set.setStep(step)
    const focusKey = focus?.target ?? ''
    if (focusKey !== prev.focus) set.setFocus(focus?.target ?? null)
    if (phase !== prev.phase) set.setPhase(phase)
    prev = { ...prev, step, focus: focusKey, phase }

    // Курсор: последовательно проходим пути, начавшиеся к моменту t.
    let pos: Point = { ...SCENE.cursorStart }
    if (t < resetAt) {
      timeline.moves.forEach((move, i) => {
        if (move.start > t) return
        if (resolved[i] === undefined) {
          origins[i] = pos
          resolved[i] = measure(move.target)
        }
        const to = resolved[i] ?? origins[i]
        const k = cursorEase(Math.min(1, (t - move.start) / (move.end - move.start)))
        pos = { x: origins[i].x + (to.x - origins[i].x) * k, y: origins[i].y + (to.y - origins[i].y) * k }
      })
    }
    // Наведение: по сценарию (наведение, нажатие, отпускание) — а между ними
    // за курсором, на что он сейчас наехал.
    const passing = !timed && playing && t >= BEAT.leadIn ? targetAt(pos) : null
    const hot = timed ?? (passing ? { target: passing, state: 'hovered' as const } : undefined)
    const hotKey = hot ? `${hot.target}:${hot.state}` : ''
    if (hotKey !== prev.hot) set.setHot(hot ? { target: hot.target, state: hot.state } : null)
    prev.hot = hotKey

    // Точка последнего нажатия — для окна, которое из неё вырастает. Берётся
    // цель пути, а не курсор сейчас: перемотка выгрузки может попасть в момент,
    // когда курсор уже едет к следующей цели.
    const lastPress = playing
      ? timeline.hots.findLast((h) => h.state === 'pressed' && h.start <= t)
      : undefined
    if (lastPress && lastPress.start !== pressedAt) {
      const i = timeline.moves.findLastIndex((m) => m.start <= lastPress.start)
      const point = i >= 0 ? (resolved[i] ?? origins[i]) : null
      if (point) {
        pressedAt = lastPress.start
        set.setPress(point)
      }
    }

    const pressed = hot?.state === 'pressed'
    const shape = playing ? timeline.shapes.find((sh) => sh.start <= t && t < sh.end)?.shape : undefined
    if (cursorRef.current) {
      if (cursorRef.current.dataset.shape !== shape) {
        if (shape) cursorRef.current.dataset.shape = shape
        else delete cursorRef.current.dataset.shape
      }
      cursorRef.current.style.transform = `translate(${pos.x}px, ${pos.y}px) scale(${pressed ? SCENE.cursorPress : 1})`
    }

    // Круг нажатия: от начала нажатия расходится и гаснет. Он длиннее такта
    // нажатия, поэтому центр — точка нажатия, запомненная один раз, а не
    // текущая точка курсора, который к концу круга уже в пути.
    const press = playing
      ? timeline.hots.findLast(
          (h) => h.state === 'pressed' && h.start <= t && t < h.start + FEEDBACK.drop,
        )
      : undefined
    if (press && dropAt?.start !== press.start) dropAt = { start: press.start, ...pos }
    let drop: FrameInfo['drop'] = null
    if (press && dropAt) {
      const p = (t - press.start) / FEEDBACK.drop
      // Гаснет по `move`: заметен в начале, без резкого обрыва в конце.
      drop = {
        x: dropAt.x,
        y: dropAt.y,
        scale: 1 + (FEEDBACK.dropScale - 1) * ease('enter', p),
        opacity: FEEDBACK.dropOpacity * (1 - ease('move', p)),
      }
    }
    // Перенос: у курсора — копия источника, сам источник бледнеет.
    const drag = playing ? timeline.drags.find((d) => d.start <= t && t < d.end) : undefined
    const canvasEl = canvasRef.current
    const ghost = canvasEl?.querySelector<HTMLElement>('.OnbScene__ghost')
    if (ghost && canvasEl) {
      if ((drag?.start ?? null) !== dragAt) {
        dragAt = drag?.start ?? null
        canvasEl.querySelectorAll('[data-dragging]').forEach((n) => n.removeAttribute('data-dragging'))
        ghost.replaceChildren()
        const source = drag && canvasEl.querySelector<HTMLElement>(`[data-scene-target="${CSS.escape(drag.from)}"]`)
        if (source) {
          const copy = source.cloneNode(true) as HTMLElement
          copy.removeAttribute('data-scene-target')
          copy.removeAttribute('data-demo-state')
          copy.querySelectorAll('[data-scene-target]').forEach((n) => n.removeAttribute('data-scene-target'))
          ghost.style.inlineSize = `${source.offsetWidth}px`
          ghost.append(copy)
          source.setAttribute('data-dragging', '')
        }
      }
      ghost.toggleAttribute('data-active', Boolean(drag))
      if (drag) ghost.style.transform = `translate(${pos.x}px, ${pos.y}px)`
    }

    // Значок у курсора: клавиша или мышь. Едет вместе с курсором; с момента
    // нажатия клавиша и правая кнопка показаны нажатыми.
    const cue = playing ? timeline.cues.find((c) => c.start <= t && t < c.end) : undefined
    if ((cue?.start ?? null) !== cueAt) {
      cueAt = cue?.start ?? null
      set.setCue(cue ?? null)
    }
    const cueEl = canvasRef.current?.querySelector<HTMLElement>('.OnbScene__cue')
    if (cueEl && cue) {
      cueEl.style.transform = `translate(${pos.x}px, ${pos.y}px)`
      cueEl.toggleAttribute('data-pressed', t >= cue.press)
      cueEl.querySelectorAll('.OnbScene__key').forEach((k, i) => {
        k.toggleAttribute('data-pressed', t >= (cue.presses?.[i] ?? cue.press))
      })
      // Уход значка — последние `APPEAR.exit` его отрезка.
      cueEl.toggleAttribute('data-leaving', t >= cue.end - APPEAR.exit)
    }

    if (rippleRef.current) {
      if (drop) {
        rippleRef.current.style.transform = `translate(${drop.x}px, ${drop.y}px) scale(${drop.scale})`
        rippleRef.current.style.opacity = String(drop.opacity)
      } else {
        rippleRef.current.style.opacity = '0'
      }
    }
    return { pos, pressed, drop }
  }
}

function runClock<S>(
  timeline: Timeline<S>,
  canvasRef: React.RefObject<HTMLDivElement | null>,
  cursorRef: React.RefObject<HTMLDivElement | null>,
  rippleRef: React.RefObject<HTMLDivElement | null>,
  set: Setters,
  cursorEase?: (p: number) => number,
) {
  const frameAt = createFrame(timeline, canvasRef, cursorRef, rippleRef, set, cursorEase)
  let elapsed = 0
  let last = performance.now()
  let frame = 0

  const tick = (now: number) => {
    // Шаг кадра ограничен: после скрытой вкладки или подвисания сцена
    // продолжает с места, а не прыгает вперёд.
    elapsed += Math.min(now - last, 100)
    last = now
    frameAt(elapsed % timeline.loop)
    frame = requestAnimationFrame(tick)
  }

  const onVisibility = () => {
    // Часы стоят, пока вкладку не видно.
    if (document.hidden) cancelAnimationFrame(frame)
    else {
      last = performance.now()
      frame = requestAnimationFrame(tick)
    }
  }

  frame = requestAnimationFrame(tick)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    cancelAnimationFrame(frame)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

/* ── выгрузка в SVG ────────────────────────────────────────────────────────
 * Страница выгрузки ставит `window.__ONB_EXPORT__ = true` до монтирования
 * сцены. Тогда часы не идут, а сцена кладёт в `window.__onbScenes` перемотку:
 * `seek(t)` синхронно рисует кадр в момент t (flushSync), и выгрузка снимает
 * разметку. Код выгрузки — `svgExport.ts`.
 */
export interface SceneController {
  timeline: Timeline<unknown>
  canvas: HTMLDivElement | null
  seek: (t: number) => FrameInfo
}

function isExporting() {
  return Boolean((window as unknown as { __ONB_EXPORT__?: boolean }).__ONB_EXPORT__)
}

function registerForExport<S>(
  timeline: Timeline<S>,
  canvasRef: React.RefObject<HTMLDivElement | null>,
  cursorRef: React.RefObject<HTMLDivElement | null>,
  rippleRef: React.RefObject<HTMLDivElement | null>,
  set: Setters,
  cursorEase?: (p: number) => number,
) {
  const frameAt = createFrame(timeline, canvasRef, cursorRef, rippleRef, set, cursorEase)
  const controller: SceneController = {
    timeline: timeline as Timeline<unknown>,
    get canvas() {
      return canvasRef.current
    },
    seek: (t) => {
      let info!: FrameInfo
      flushSync(() => {
        set.setClock(t)
        info = frameAt(t)
      })
      return info
    },
  }
  const w = window as unknown as { __onbScenes?: SceneController[] }
  w.__onbScenes = [...(w.__onbScenes ?? []), controller]
  return () => {
    w.__onbScenes = (w.__onbScenes ?? []).filter((c) => c !== controller)
  }
}

/* ── курсор ────────────────────────────────────────────────────────────────
 * Нейтральный кружок, а не стрелка (решение 01.10.2026): стрелка в миниатюре
 * читается как настоящий курсор человека и спорит с ним, а кружок — как
 * указатель сцены. Центр кружка — точка касания. Вид — в onboarding.css.
 */
function SceneCursor({ ref }: { ref: React.Ref<HTMLDivElement> }) {
  return <div ref={ref} className="OnbScene__cursor" />
}

/* ── примитивы разметки сцены ──────────────────────────────────────────── */

export interface SceneTargetProps {
  /** Имя цели, на которое ссылаются шаги `click`, `type`, `point`. */
  id: string
  /** `inline` — цель в строке (иконка у подписи), по умолчанию блок. */
  inline?: boolean
  /**
   * Куда внутри цели нажимает курсор — CSS-селектор части компонента
   * (`.SwitchButton__icon`). Наведение и нажатие при этом показывает весь
   * компонент: состояние стоит на цели целиком.
   */
  aim?: string
  children: ReactNode
}

/**
 * Цель действия. Состояние под курсором включается витринным крючком
 * `data-demo-state` — тем же, каким стенды показывают hovered и pressed.
 * В прототипах крючок запрещён (там состояния настоящие); сцена — это
 * демонстрация, как стенд, и это единственное разрешённое место.
 */
export function SceneTarget({ id, inline = false, aim, children }: SceneTargetProps) {
  const { hot, focus } = useContext(SceneContext)
  const { measuring } = useContext(CenterContext)
  useContext(ItemContext)?.add(id)
  // `released` для компонента — тот же hovered: курсор ещё стоит на цели.
  // Поле в фокусе остаётся в фокусе, даже когда курсор над ним: каретку
  // наведение не гасит, как и в настоящем поле.
  const pressedHere = hot?.target === id && hot.state === 'pressed'
  const state =
    focus === id && !pressedHere
      ? 'focused'
      : hot?.target === id
        ? hot.state === 'released'
          ? 'hovered'
          : hot.state
        : undefined
  const ref = useRef<HTMLDivElement>(null)
  const caretRef = useRef<HTMLSpanElement>(null)
  const [typedValue, setTypedValue] = useState('')
  // Каретка: у поля в фокусе — мигающая черта в конце текста. Меряется по
  // раскладке: начало текста поля плюс ширина набранного его же шрифтом.
  useLayoutEffect(() => {
    const caret = caretRef.current
    const input = ref.current?.querySelector<HTMLInputElement>('input:not([type=checkbox]):not([type=radio]), textarea')
    if (!caret || !input || !ref.current) return
    const cs = getComputedStyle(input)
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    let left = 0
    let top = 0
    for (let n: HTMLElement | null = input; n && n !== ref.current; n = n.offsetParent as HTMLElement | null) {
      left += n.offsetLeft
      top += n.offsetTop
    }
    const size = parseFloat(cs.fontSize) * 1.25
    caret.style.insetInlineStart = `${left + parseFloat(cs.paddingLeft) + ctx.measureText(input.value).width}px`
    caret.style.insetBlockStart = `${top + (input.offsetHeight - size) / 2}px`
    caret.style.blockSize = `${size}px`
    if (input.value !== typedValue) setTypedValue(input.value)
  })
  return (
    <div
      ref={ref}
      className="OnbScene__target"
      data-inline={inline ? '' : undefined}
      data-scene-target={measuring ? undefined : id}
      data-scene-aim={measuring ? undefined : aim}
      data-demo-state={state}
    >
      {children}
      {/* key — перезапуск мигания: после каждого символа каретка видна сразу, как в поле. */}
      {state === 'focused' && <span key={typedValue} ref={caretRef} className="OnbScene__caret" />}
    </div>
  )
}

/**
 * Отдаление: пока `out`, содержимое уменьшается так, чтобы целиком войти
 * в холст по высоте, — для того, что выше сцены (календарь). Высота меряется
 * по раскладке (offset), а не по экрану: на неё не влияют ни сам масштаб,
 * ни анимации появления внутри. Точка масштаба — верх по центру: поле, от
 * которого всё раскрылось, остаётся на месте.
 */
export function SceneZoom({ out, children }: { out: boolean; children: ReactNode }) {
  const { animate } = useContext(SceneContext)
  const ref = useRef<HTMLDivElement>(null)
  const [k, setK] = useState(1)

  // Пересчёт на каждой отрисовке: содержимое внутри может смениться (зона
  // загрузки → загруженный файл), и масштаб должен пойти за ним. Состояние
  // меняется только при заметной разнице — иначе цикл отрисовок.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !out) {
      if (k !== 1) setK(1)
      return
    }
    // Низ содержимого в координатах раскладки — с выпадающими (absolute) частями.
    let bottom = el.offsetHeight
    el.querySelectorAll<HTMLElement>('*').forEach((n) => {
      let top = 0
      let node: HTMLElement | null = n
      while (node && node !== el) {
        top += node.offsetTop
        node = node.offsetParent as HTMLElement | null
      }
      if (node === el) bottom = Math.max(bottom, top + n.offsetHeight)
    })
    // Сверху у содержимого поле плоскости — снизу оставляем такое же.
    let top = 0
    for (let n: HTMLElement | null = el; n && !n.classList.contains('OnbScene__canvas'); n = n.offsetParent as HTMLElement | null) {
      top += n.offsetTop
    }
    const next = Math.min(1, (SCENE.height - 2 * top) / bottom)
    if (Math.abs(next - k) > 0.005) setK(next)
  })

  return (
    <div
      ref={ref}
      style={{
        position: 'relative',
        transform: k === 1 ? undefined : `scale(${k})`,
        transformOrigin: 'top center',
        transition: animate ? `transform ${ZOOM.duration}ms ${cssEase('move')}` : undefined,
      }}
    >
      {children}
    </div>
  )
}

/** Фон сцены — белая плоскость на слое `background/neutral/subtle-1`, как экран в миниатюре. */
export function ScenePlane({ center = false, children }: { center?: boolean; children: ReactNode }) {
  return (
    <div className="OnbScene__plane" data-center={center ? '' : undefined}>
      {center ? <SceneCentered>{children}</SceneCentered> : children}
    </div>
  )
}

/**
 * Содержимое по центру сцены по вертикали (решения 06.10.2026): в сцене
 * с малым содержимым оно не висит наверху над пустотой — и не едет, когда
 * под кнопкой появляется ответ. Группа держит высоту итогового кадра
 * (её меряет невидимый слой с финальным состоянием), и по центру стоит
 * именно она: кнопка с начала чуть выше середины, ответ ложится под неё.
 */
function SceneCentered({ children }: { children: ReactNode }) {
  const { measuring, finalHeight, report, request } = useContext(CenterContext)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!measuring) request()
  }, [measuring, request])
  useLayoutEffect(() => {
    if (measuring && ref.current) report(ref.current.offsetHeight)
  })
  return (
    <div ref={ref} className="OnbScene__centered" style={!measuring && finalHeight ? { minBlockSize: finalHeight } : undefined}>
      {children}
    </div>
  )
}

type AppearPhase = 'shown' | 'entering' | 'exiting' | 'hidden'

function useAppear(show: boolean, exitMs: number = APPEAR.exit): { phase: AppearPhase; at: number | undefined } {
  const { animate, clock } = useContext(SceneContext)
  const [phase, setPhase] = useState<AppearPhase>(show ? 'shown' : 'hidden')
  // Выгрузка в SVG: смена `show` запоминается со временем, фаза — функция
  // возраста смены. Перемотка назад (новый цикл) — сброс без анимации:
  // при повторе элементы встают на место сразу, как в живой сцене.
  const flip = useRef({ show, at: -Infinity, last: -Infinity })

  useEffect(() => {
    if (!animate) {
      setPhase(show ? 'shown' : 'hidden')
      return
    }
    if (show) {
      setPhase((p) => (p === 'shown' ? p : 'entering'))
      return
    }
    setPhase((p) => (p === 'hidden' ? p : 'exiting'))
    const timer = window.setTimeout(() => setPhase('hidden'), exitMs)
    return () => window.clearTimeout(timer)
  }, [show, animate, exitMs])

  if (clock !== null) {
    const f = flip.current
    if (clock < f.last) Object.assign(f, { show, at: -Infinity })
    else if (f.show !== show) Object.assign(f, { show, at: clock })
    f.last = clock
    // Как в живой сцене: появившийся элемент остаётся в фазе `entering`
    // (на ней держится подсветка результата), ушедший живёт `APPEAR.exit`.
    const appeared = Number.isFinite(f.at)
    const p: AppearPhase = show
      ? appeared
        ? 'entering'
        : 'shown'
      : clock - f.at < exitMs
        ? 'exiting'
        : 'hidden'
    return { phase: p, at: Number.isFinite(f.at) ? f.at : undefined }
  }
  return { phase, at: undefined }
}

export interface SceneAppearProps {
  show: boolean
  /**
   * `item` — строка списка, чип, сообщение: проявляется со сдвигом 4px.
   * `result` — то, ради чего сцена: появляется так же и коротко подсвечивается
   * акцентом, чтобы глаз нашёл, куда смотреть. `result` в сцене один.
   */
  kind?: 'item' | 'result'
  /**
   * Подсветка строки под курсором, как у строки `Table`. Выключается там, где
   * у компонента своё наведение и серой строки в ДС нет (переключатель);
   * отклик при отпускании остаётся.
   */
  highlight?: boolean
  children: ReactNode
}

/**
 * Появление и уход элемента в сцене. Длительности и кривые — `APPEAR`
 * из motion.ts; своих у элемента нет. При первом показе сцены и при
 * сбросе перед повтором анимации нет — элемент просто стоит на месте.
 */
export function SceneAppear({ show, kind = 'item', highlight = true, children }: SceneAppearProps) {
  // Уход — затухание, затем схлопывание: соседи подъезжают на место строки.
  const preview = useContext(MotionPreviewContext)
  const { phase, at } = useAppear(show, (preview?.itemExit ?? APPEAR.exit) + APPEAR.collapse)
  const { hot } = useContext(SceneContext)
  const targets = useRef(new Set<string>()).current
  if (phase === 'hidden') return null
  // Отклик строки: в ней только что отпустили цель. Сидит на внутренней
  // обёртке — `transform` внешней занят анимацией появления.
  const inRow = kind === 'item' && !!hot && targets.has(hot.target)
  const pop = inRow && hot?.state === 'released'
  // Подсветка строки — как у строки `Table` в ДС: наведение и нажатие, без
  // постоянного фона у отмеченной.
  const rowState = inRow && highlight ? (hot?.state === 'pressed' ? 'pressed' : 'hovered') : undefined
  return (
    <div className="OnbScene__appear" data-kind={kind} data-phase={phase} data-at={at}>
      <ItemContext.Provider value={targets}>
        <div
          className="OnbScene__pop"
          data-pop={pop ? '' : undefined}
          data-row-state={rowState}
        >
          {children}
        </div>
      </ItemContext.Provider>
    </div>
  )
}

export interface SceneWindowProps {
  open: boolean
  label: string
  /** Имя цели на крестике шапки — для шага «закрыть окно». */
  closeTarget?: string
  actions?: ReactNode
  children: ReactNode
}

/**
 * Модалка в сцене. `Modal` из ДС не подходит сам: он выносит окно порталом
 * в `body` и затемняет весь вьюпорт. Здесь тот же каркас — `Blackout`,
 * `ModalHeader`, `ModalActionBar` и класс окна `Modal`, — но в границах
 * холста. Появление — та же анимация накладок ДС, но окно вырастает из точки
 * нажатия пружиной (`WINDOW` в motion.ts); уход — `APPEAR.exit`.
 */
export function SceneWindow({ open, label, closeTarget, actions, children }: SceneWindowProps) {
  const preview = useContext(MotionPreviewContext)
  const { phase, at } = useAppear(open, preview?.windowExit ?? WINDOW.exit)
  const { press } = useContext(SceneContext)
  const windowRef = useRef<HTMLDivElement>(null)

  // Окно растёт из точки нажатия и при закрытии сжимается в неё же: точка
  // масштаба — нажатие, открывшее окно, в координатах окна. Ставится один раз,
  // при появлении, — нажатие на крестик точку не сдвигает. До первого кадра,
  // иначе окно дёрнется от центра; offset не видит масштаба — меряется раскладка.
  useLayoutEffect(() => {
    const el = windowRef.current
    if (!el || !press || phase !== 'entering') return
    el.style.setProperty('--sq-appear-origin', `${press.x - el.offsetLeft}px ${press.y - el.offsetTop}px`)
  }, [phase])

  if (phase === 'hidden') return null
  return (
    <Blackout className="OnbScene__blackout" data-phase={phase} data-at={at}>
      <div ref={windowRef} className="Modal sq-appear sq-appear--dialog OnbScene__window" data-width="extraSmall">
        {closeTarget ? (
          <SceneTarget id={closeTarget} aim=".ModalNavigationButton">
            <ModalHeader label={label} onClose={() => {}} />
          </SceneTarget>
        ) : (
          <ModalHeader label={label} onClose={() => {}} />
        )}
        <div className="Modal__content">{children}</div>
        {actions && <ModalActionBar>{actions}</ModalActionBar>}
      </div>
    </Blackout>
  )
}

/* ── перемещение, панели, экраны ─────────────────────────────────────── */

/**
 * Прокрутка: содержимое сдвигается на `offset` px вверх за такт `BEAT.scroll`
 * по кривой `move` — столько же, сколько крутится колесо у курсора (`scroll`).
 * Сам блок обрезает то, что ниже, — как область прокрутки на экране.
 */
export function SceneScroll({ offset, children }: { offset: number; children: ReactNode }) {
  const { animate } = useContext(SceneContext)
  return (
    <div style={{ flex: 1, minBlockSize: 0, overflow: 'hidden' }}>
      <div
        style={{
          transform: offset ? `translateY(${-offset}px)` : undefined,
          transition: animate ? `transform ${BEAT.scroll}ms ${cssEase('move')}` : undefined,
        }}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * Ширина, которую тянут за край (`resize`): меняется за путь курсора с грузом
 * (`BEAT.dragMove`) по той же кривой `move`, поэтому край едет вместе с курсором.
 */
export function SceneResize({ width, children }: { width: number; children: ReactNode }) {
  const { animate } = useContext(SceneContext)
  return (
    <div
      style={{
        position: 'relative',
        flex: 'none',
        inlineSize: width,
        transition: animate ? `inline-size ${BEAT.dragMove}ms ${cssEase('move')}` : undefined,
      }}
    >
      {children}
    </div>
  )
}

/**
 * Боковая панель: въезжает справа и сдвигает экран влево за край, не сжимая
 * его, — ширина основной части остаётся прежней (решения 06.10.2026: панель
 * не накрывает содержимое и не сужает его). Основная часть — `children`,
 * панель — `panel`. Сдвиг — `duration/standard` по `enter`, обратно —
 * `APPEAR.exit` по `exit`.
 */
export function ScenePanel({ open, panel, children }: { open: boolean; panel: ReactNode; children: ReactNode }) {
  const { animate } = useContext(SceneContext)
  const width = SCENE.width / 2
  return (
    <div
      className="OnbScene__panelRow"
      style={{
        transform: open ? `translateX(${-width}px)` : undefined,
        transition: animate
          ? open
            ? `transform ${DURATION.standard}ms ${cssEase('enter')}`
            : `transform ${APPEAR.exit}ms ${cssEase('exit')}`
          : undefined,
      }}
    >
      <div className="OnbScene__panelMain" style={{ inlineSize: SCENE.width }}>
        {children}
      </div>
      <div className="OnbScene__panel" style={{ inlineSize: width }}>
        {panel}
      </div>
    </div>
  )
}

/**
 * Смена экрана: новый въезжает справа, прежний уходит влево — «перешли
 * дальше», как навигация вглубь. Экраны лежат слоями друг на друге.
 */
export function SceneScreens({ current, screens }: { current: string; screens: Record<string, ReactNode> }) {
  return (
    <div className="OnbScene__screens">
      {Object.entries(screens).map(([key, screen]) => (
        <SceneScreen key={key} show={key === current}>
          {screen}
        </SceneScreen>
      ))}
    </div>
  )
}

function SceneScreen({ show, children }: { show: boolean; children: ReactNode }) {
  const { phase } = useAppear(show)
  if (phase === 'hidden') return null
  return (
    <div className="OnbScene__screen" data-phase={phase}>
      {children}
    </div>
  )
}

/**
 * Список, строки которого меняются местами (сортировка): каждая строка едет
 * со старого места на новое, а не перескакивает. Порядок задаёт сцена —
 * `items` в новом порядке; движение — `APPEAR.reorder` по кривой `move`.
 * Приём FLIP: после перестановки строка ставится сдвигом на старое место
 * и отпускается к нулю.
 */
export function SceneReorder({ items }: { items: { key: string; node: ReactNode }[] }) {
  const { animate } = useContext(SceneContext)
  const refs = useRef(new Map<string, HTMLDivElement>())
  const tops = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    refs.current.forEach((el, key) => {
      const before = tops.current.get(key)
      const now = el.offsetTop
      tops.current.set(key, now)
      if (!animate || before === undefined || before === now) return
      el.style.transition = 'none'
      el.style.transform = `translateY(${before - now}px)`
      void el.offsetHeight
      el.style.transition = `transform ${APPEAR.reorder}ms ${cssEase('move')}`
      el.style.transform = ''
    })
  })
  return (
    <div style={{ position: 'relative' }}>
      {items.map(({ key, node }) => (
        <div
          key={key}
          ref={(el) => {
            if (el) refs.current.set(key, el)
            else refs.current.delete(key)
          }}
          style={{ position: 'relative', background: 'var(--colors-surface-onColor-neutral-primary)' }}
        >
          {node}
        </div>
      ))}
    </div>
  )
}

/**
 * Смена значения на месте — статус документа, число в счётчике: прежнее
 * уезжает вверх и гаснет, новое приходит снизу, и блок коротко подпрыгивает
 * пружиной окна. Изменение могло случиться вдали от курсора, его нужно
 * заметить (NN/g). `swapKey` — что считать сменой; содержимое — `children`.
 */
export function SceneSwap({ swapKey, children }: { swapKey: string | number; children: ReactNode }) {
  const { animate } = useContext(SceneContext)
  const prev = useRef<{ key: string | number; node: ReactNode }>({ key: swapKey, node: children })
  const [old, setOld] = useState<ReactNode | null>(null)
  useLayoutEffect(() => {
    if (prev.current.key === swapKey) {
      prev.current.node = children
      return
    }
    setOld(animate ? prev.current.node : null)
    prev.current = { key: swapKey, node: children }
  })
  // key — перезапуск анимаций на каждой смене; прежнее значение живёт в ref.
  return (
    <span className="OnbScene__swap" key={String(swapKey)} data-changed={old !== null ? '' : undefined}>
      {old !== null && <span className="OnbScene__swapOld">{old}</span>}
      <span className="OnbScene__swapNew">{children}</span>
    </span>
  )
}

/** Число в счётчике или бейдже — `SceneSwap` по самому числу. */
export function SceneCounter({ value }: { value: number | string }) {
  return <SceneSwap swapKey={value}>{value}</SceneSwap>
}

/**
 * Заполнение слева направо, как загрузка: акцентная полоса растёт поверх
 * содержимого (линия между шагами, дорожка прогресса), пока `full`.
 * За `APPEAR.reorder` по кривой `move` — укладывается в такт ответа.
 */
export function SceneFill({ full, className, children }: { full: boolean; className?: string; children?: ReactNode }) {
  const { animate } = useContext(SceneContext)
  return (
    <span className={['OnbScene__fill', className].filter(Boolean).join(' ')}>
      {children}
      <span
        className="OnbScene__fillBar"
        style={{
          inlineSize: full ? '100%' : 0,
          transition: animate ? `inline-size ${APPEAR.reorder}ms ${cssEase('move')}` : undefined,
        }}
      />
    </span>
  )
}

/**
 * Короткое подрастание при смене состояния — как отклик строки в 1.2,
 * только заметнее: шаг, который загорелся, чуть увеличивается и садится.
 * `popKey` — что считать сменой.
 */
export function ScenePop({ popKey, children }: { popKey: string | number; children: ReactNode }) {
  const { animate } = useContext(SceneContext)
  const first = useRef(popKey)
  const changed = animate && first.current !== popKey
  return (
    <span key={String(popKey)} className="OnbScene__popOnce" data-pop={changed ? '' : undefined}>
      {children}
    </span>
  )
}
