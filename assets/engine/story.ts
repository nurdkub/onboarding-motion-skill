import { BEAT, LIMITS } from './motion'

/**
 * Сценарий сцены — данные, а не анимация.
 *
 * Автор перечисляет, ЧТО делает пользователь и как отвечает интерфейс.
 * КАК это движется (длительности, кривые, паузы, начало и конец цикла)
 * добавляет компилятор из `motion.ts`. Ни у одного шага нет параметра
 * длительности — это и делает результат одинаковым у любого автора.
 *
 * Шаги:
 * - `click(target, apply?)` — курсор едет к цели, наводится, нажимает;
 *   `apply` меняет состояние сцены в момент отпускания;
 * - `type(target, text, apply)` — печать в поле по символу, курсор стоит;
 *   `apply(state, typed)` зовётся на каждом символе;
 * - `point(target)` — курсор подводится и задерживается, ничего не нажимая
 *   (показать то, что раскрывается по наведению);
 * - `react(apply)` — интерфейс отвечает сам, без курсора (пришёл ответ,
 *   отфильтровался список).
 *
 * Вступление, финальный кадр и повтор движок добавляет сам — забыть их
 * нельзя, растянуть тоже.
 */

export type Update<S> = (state: S) => S

export type Beat<S> =
  | { kind: 'click'; target: string; apply?: Update<S> }
  | { kind: 'point'; target: string }
  | { kind: 'type'; target: string; text: string; apply: (state: S, typed: string) => S }
  | { kind: 'react'; apply: Update<S> }

export interface Story<S> {
  /** Состояние сцены на старте каждого цикла. */
  initial: S
  beats: Beat<S>[]
}

export const click = <S>(target: string, apply?: Update<S>): Beat<S> => ({
  kind: 'click',
  target,
  apply,
})
export const point = <S>(target: string): Beat<S> => ({ kind: 'point', target })
export const type = <S>(
  target: string,
  text: string,
  apply: (state: S, typed: string) => S,
): Beat<S> => ({ kind: 'type', target, text, apply })
export const react = <S>(apply: Update<S>): Beat<S> => ({ kind: 'react', apply })

/** Типизированный конструктор: `defineStory({ initial, beats: [...] })`. */
export function defineStory<S>(story: Story<S>): Story<S> {
  return story
}

/* ── компиляция в таймлайн ─────────────────────────────────────────────── */

/**
 * `released` — цель под курсором сразу после отпускания: для компонента это
 * тот же hovered, но строка, в которой лежит цель, по нему отзывается.
 */
export type HotState = 'hovered' | 'pressed' | 'released'

/** Путь курсора к цели. Координаты цели меряются по DOM в момент старта. */
export interface Move {
  start: number
  end: number
  target: string
}

/** Отрезок, на котором цель под курсором показывает hovered или pressed. */
export interface Hot {
  start: number
  end: number
  target: string
  state: HotState
}

/** Отрезок, на котором поле в фокусе. Держится до следующего нажатия. */
export interface Focus {
  start: number
  end: number
  target: string
}

export interface StateEvent<S> {
  at: number
  apply: Update<S>
}

export interface Timeline<S> {
  moves: Move[]
  hots: Hot[]
  focuses: Focus[]
  events: StateEvent<S>[]
  /** Конец финального кадра — всё, что видит пользователь за один проход. */
  total: number
  /** Период повтора: `total` + затухание, проявление и пауза. */
  loop: number
  /** Нарушения потолков `LIMITS`. Непустой список — сцена не играет. */
  problems: string[]
  /** Мягкие нарушения: сцена играет, но длиннее ориентира. */
  warnings: string[]
}

export function compile<S>(story: Story<S>): Timeline<S> {
  const moves: Move[] = []
  const hots: Hot[] = []
  const focuses: Focus[] = []
  const events: StateEvent<S>[] = []
  const problems: string[] = []

  let t = BEAT.leadIn
  let actions = 0
  let openFocus: { start: number; target: string } | null = null

  const closeFocus = (at: number) => {
    if (openFocus) focuses.push({ ...openFocus, end: at })
    openFocus = null
  }

  for (const beat of story.beats) {
    switch (beat.kind) {
      case 'click': {
        actions++
        moves.push({ start: t, end: t + BEAT.move, target: beat.target })
        t += BEAT.move
        hots.push({ start: t, end: t + BEAT.hover, target: beat.target, state: 'hovered' })
        t += BEAT.hover
        closeFocus(t)
        hots.push({ start: t, end: t + BEAT.press, target: beat.target, state: 'pressed' })
        t += BEAT.press
        if (beat.apply) events.push({ at: t, apply: beat.apply })
        hots.push({ start: t, end: t + BEAT.release, target: beat.target, state: 'released' })
        t += BEAT.release
        break
      }
      case 'point': {
        actions++
        moves.push({ start: t, end: t + BEAT.move, target: beat.target })
        t += BEAT.move
        hots.push({ start: t, end: t + BEAT.dwell, target: beat.target, state: 'hovered' })
        t += BEAT.dwell
        break
      }
      case 'type': {
        actions++
        if (beat.text.length > LIMITS.typeChars) {
          problems.push(
            `Печать «${beat.text}» — ${beat.text.length} символов, потолок ${LIMITS.typeChars}. Сократите запрос: сцена про фичу, а не про набор текста`,
          )
        }
        closeFocus(t)
        openFocus = { start: t, target: beat.target }
        t += BEAT.typeFocus
        for (let i = 1; i <= beat.text.length; i++) {
          const typed = beat.text.slice(0, i)
          events.push({ at: t, apply: (state) => beat.apply(state, typed) })
          t += BEAT.typeChar
        }
        t += BEAT.typeSettle
        break
      }
      case 'react': {
        events.push({ at: t, apply: beat.apply })
        t += BEAT.react
        break
      }
    }
  }

  t += BEAT.hold
  closeFocus(t)

  if (story.beats.length === 0) problems.push('В сцене нет ни одного шага')
  if (actions > LIMITS.actions) {
    problems.push(
      `Действий пользователя ${actions}, потолок ${LIMITS.actions}. Это две фичи — разделите на две подсказки`,
    )
  }
  // Цикл меряется целиком, вместе с затуханием и паузой перед повтором:
  // столько человек ждёт, пока сцена начнётся снова.
  const loop = t + BEAT.fadeOut + BEAT.fadeIn + BEAT.loopGap
  const warnings: string[] = []
  const sec = (ms: number) => (ms / 1000).toFixed(1).replace('.', ',')
  if (loop > LIMITS.loopMax) {
    problems.push(
      `Цикл ${sec(loop)} с, край ${sec(LIMITS.loopMax)} с. Уберите шаги, которые не показывают саму фичу`,
    )
  } else if (loop > LIMITS.loop) {
    warnings.push(
      `Цикл ${sec(loop)} с — дольше ориентира ${sec(LIMITS.loop)} с. Сцена играет, но проверьте, нет ли лишнего шага`,
    )
  }

  return {
    moves,
    hots,
    focuses,
    events,
    total: t,
    loop,
    problems,
    warnings,
  }
}

/** Сколько событий состояния уже случилось к моменту `t`. */
export function stepAt<S>(timeline: Timeline<S>, t: number) {
  let n = 0
  while (n < timeline.events.length && timeline.events[n].at <= t) n++
  return n
}

export function stateAt<S>(story: Story<S>, timeline: Timeline<S>, step: number) {
  let state = story.initial
  for (let i = 0; i < step; i++) state = timeline.events[i].apply(state)
  return state
}
