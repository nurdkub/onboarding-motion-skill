import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ModalActionBar, ModalHeader } from '@/components/square/Modal'
import { Blackout } from '@/components/square/Blackout'
import { APPEAR, BEAT, FEEDBACK, SCENE, cssEase, ease } from './motion'
import { compile, stateAt, stepAt } from './story'
import type { HotState, Story, Timeline } from './story'
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
}

const SceneContext = createContext<SceneContextValue>({ hot: null, focus: null, animate: false })

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
} as CSSProperties

type Phase = 'play' | 'out' | 'in'

export interface OnboardingSceneProps<S> {
  story: Story<S>
  /** Разметка сцены по её состоянию. Только компоненты Square и примитивы `Scene*`. */
  children: (state: S) => ReactNode
}

export function OnboardingScene<S>({ story, children }: OnboardingSceneProps<S>) {
  const timeline = useMemo(() => compile(story), [story])
  const reduced = usePrefersReducedMotion()
  const broken = import.meta.env.DEV && timeline.problems.length > 0
  const still = reduced || broken

  const [step, setStep] = useState(() => (still ? timeline.events.length : 0))
  const [hot, setHot] = useState<SceneContextValue['hot']>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('play')

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
    return runClock(timeline, canvasRef, cursorRef, rippleRef, {
      setStep,
      setHot,
      setFocus,
      setPhase,
    })
  }, [timeline, still])

  const state = useMemo(() => stateAt(story, timeline, step), [story, timeline, step])
  const context = useMemo<SceneContextValue>(
    () => ({ hot, focus, animate: !still && phase === 'play' }),
    [hot, focus, still, phase],
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
      }}
      aria-hidden="true"
    >
      <div
        ref={canvasRef}
        className="OnbScene__canvas"
        style={{ inlineSize: SCENE.width, blockSize: SCENE.height, scale: String(SCENE.scale), ...fade }}
        inert
      >
        <SceneContext.Provider value={context}>{children(state)}</SceneContext.Provider>
        {!still && <div ref={rippleRef} className="OnbScene__ripple" />}
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
}

type Point = { x: number; y: number }

function runClock<S>(
  timeline: Timeline<S>,
  canvasRef: React.RefObject<HTMLDivElement | null>,
  cursorRef: React.RefObject<HTMLDivElement | null>,
  rippleRef: React.RefObject<HTMLDivElement | null>,
  set: Setters,
) {
  let elapsed = 0
  let last = performance.now()
  let frame = 0
  let loopIndex = -1
  /** Куда ведёт каждый путь курсора в этом цикле. Меряется один раз, при старте пути. */
  let resolved: (Point | null)[] = []
  let origins: Point[] = []
  let prev = { step: -1, hot: '', focus: '', phase: '' }
  let dropAt: { start: number; x: number; y: number } | null = null

  const measure = (target: string): Point | null => {
    const canvas = canvasRef.current
    const node = canvas?.querySelector(`[data-scene-target="${CSS.escape(target)}"]`)
    if (!canvas || !node) {
      if (import.meta.env.DEV) console.warn(`[onboarding] цель «${target}» не найдена в сцене`)
      return null
    }
    const c = canvas.getBoundingClientRect()
    const r = node.getBoundingClientRect()
    return {
      x: (r.left + r.width / 2 - c.left) / SCENE.scale,
      y: (r.top + r.height / 2 - c.top) / SCENE.scale,
    }
  }

  const tick = (now: number) => {
    // Шаг кадра ограничен: после скрытой вкладки или подвисания сцена
    // продолжает с места, а не прыгает вперёд.
    elapsed += Math.min(now - last, 100)
    last = now

    const index = Math.floor(elapsed / timeline.loop)
    const t = elapsed - index * timeline.loop
    if (index !== loopIndex) {
      loopIndex = index
      resolved = []
      origins = []
    }

    const resetAt = timeline.total + BEAT.fadeOut
    const playing = t < timeline.total

    const step = t < resetAt ? stepAt(timeline, t) : 0
    const phase: Phase = playing ? 'play' : t < resetAt ? 'out' : 'in'
    const hot = playing ? timeline.hots.find((h) => h.start <= t && t < h.end) : undefined
    const focus = playing ? timeline.focuses.find((f) => f.start <= t && t < f.end) : undefined

    if (step !== prev.step) set.setStep(step)
    const hotKey = hot ? `${hot.target}:${hot.state}` : ''
    if (hotKey !== prev.hot) set.setHot(hot ? { target: hot.target, state: hot.state } : null)
    const focusKey = focus?.target ?? ''
    if (focusKey !== prev.focus) set.setFocus(focus?.target ?? null)
    if (phase !== prev.phase) set.setPhase(phase)
    prev = { step, hot: hotKey, focus: focusKey, phase }

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
        const k = ease('move', (t - move.start) / (move.end - move.start))
        pos = { x: origins[i].x + (to.x - origins[i].x) * k, y: origins[i].y + (to.y - origins[i].y) * k }
      })
    }
    const pressed = hot?.state === 'pressed'
    if (cursorRef.current) {
      cursorRef.current.style.transform = `translate(${pos.x}px, ${pos.y}px) scale(${pressed ? SCENE.cursorPress : 1})`
    }

    // Капля: от начала нажатия круг мягко расходится и гаснет. Она длиннее
    // такта нажатия, поэтому центр — точка нажатия, запомненная один раз,
    // а не текущая точка курсора, который к концу капли уже в пути.
    const drop = playing
      ? timeline.hots.find(
          (h) => h.state === 'pressed' && h.start <= t && t < h.start + FEEDBACK.drop,
        )
      : undefined
    if (drop && dropAt?.start !== drop.start) dropAt = { start: drop.start, ...pos }
    if (rippleRef.current) {
      if (drop && dropAt) {
        const p = (t - drop.start) / FEEDBACK.drop
        const scale = 1 + (FEEDBACK.dropScale - 1) * ease('enter', p)
        // Гаснет по `move`: заметен в начале, без резкого обрыва в конце.
        const opacity = FEEDBACK.dropOpacity * (1 - ease('move', p))
        rippleRef.current.style.transform = `translate(${dropAt.x}px, ${dropAt.y}px) scale(${scale})`
        rippleRef.current.style.opacity = String(opacity)
      } else {
        rippleRef.current.style.opacity = '0'
      }
    }

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
  children: ReactNode
}

/**
 * Цель действия. Состояние под курсором включается витринным крючком
 * `data-demo-state` — тем же, каким стенды показывают hovered и pressed.
 * В прототипах крючок запрещён (там состояния настоящие); сцена — это
 * демонстрация, как стенд, и это единственное разрешённое место.
 */
export function SceneTarget({ id, inline = false, children }: SceneTargetProps) {
  const { hot, focus } = useContext(SceneContext)
  useContext(ItemContext)?.add(id)
  // `released` для компонента — тот же hovered: курсор ещё стоит на цели.
  const state =
    hot?.target === id
      ? hot.state === 'released'
        ? 'hovered'
        : hot.state
      : focus === id
        ? 'focused'
        : undefined
  return (
    <div
      className="OnbScene__target"
      data-inline={inline ? '' : undefined}
      data-scene-target={id}
      data-demo-state={state}
    >
      {children}
    </div>
  )
}

/** Фон сцены — белая плоскость на слое `background/neutral/subtle-1`, как экран в миниатюре. */
export function ScenePlane({ children }: { children: ReactNode }) {
  return <div className="OnbScene__plane">{children}</div>
}

type AppearPhase = 'shown' | 'entering' | 'exiting' | 'hidden'

function useAppear(show: boolean) {
  const { animate } = useContext(SceneContext)
  const [phase, setPhase] = useState<AppearPhase>(show ? 'shown' : 'hidden')

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
    const timer = window.setTimeout(() => setPhase('hidden'), APPEAR.exit)
    return () => window.clearTimeout(timer)
  }, [show, animate])

  return phase
}

export interface SceneAppearProps {
  show: boolean
  /**
   * `item` — строка списка, чип, сообщение: проявляется со сдвигом 4px.
   * `result` — то, ради чего сцена: появляется так же и коротко подсвечивается
   * акцентом, чтобы глаз нашёл, куда смотреть. `result` в сцене один.
   */
  kind?: 'item' | 'result'
  children: ReactNode
}

/**
 * Появление и уход элемента в сцене. Длительности и кривые — `APPEAR`
 * из motion.ts; своих у элемента нет. При первом показе сцены и при
 * сбросе перед повтором анимации нет — элемент просто стоит на месте.
 */
export function SceneAppear({ show, kind = 'item', children }: SceneAppearProps) {
  const phase = useAppear(show)
  const { hot } = useContext(SceneContext)
  const targets = useRef(new Set<string>()).current
  if (phase === 'hidden') return null
  // Отклик строки: в ней только что отпустили цель. Сидит на внутренней
  // обёртке — `transform` внешней занят анимацией появления.
  const inRow = kind === 'item' && !!hot && targets.has(hot.target)
  const pop = inRow && hot?.state === 'released'
  // Подсветка строки — как у строки `Table` в ДС: наведение и нажатие, без
  // постоянного фона у отмеченной.
  const rowState = inRow ? (hot?.state === 'pressed' ? 'pressed' : 'hovered') : undefined
  return (
    <div className="OnbScene__appear" data-kind={kind} data-phase={phase}>
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
  actions?: ReactNode
  children: ReactNode
}

/**
 * Модалка в сцене. `Modal` из ДС не подходит сам: он выносит окно порталом
 * в `body` и затемняет весь вьюпорт. Здесь тот же каркас — `Blackout`,
 * `ModalHeader`, `ModalActionBar` и класс окна `Modal`, — но в границах
 * холста. Появление — родная анимация накладок ДС, уход — `APPEAR.exit`.
 */
export function SceneWindow({ open, label, actions, children }: SceneWindowProps) {
  const phase = useAppear(open)
  if (phase === 'hidden') return null
  return (
    <Blackout className="OnbScene__blackout" data-phase={phase}>
      <div className="Modal sq-appear sq-appear--dialog OnbScene__window" data-width="extraSmall">
        <ModalHeader label={label} onClose={() => {}} />
        <div className="Modal__content">{children}</div>
        {actions && <ModalActionBar>{actions}</ModalActionBar>}
      </div>
    </Blackout>
  )
}
