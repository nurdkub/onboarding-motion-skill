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
 * - `doubleClick(target, apply?)` — то же, но два нажатия подряд: два круга;
 * - `rightClick(target, apply?)` — нажатие правой кнопкой: у курсора значок
 *   мыши с правой половиной, ответ (контекстное меню) встаёт у точки нажатия;
 * - `clickWith(key, target, apply?)` — нажатие с зажатой клавишей: у курсора
 *   клавиша с подписью (`Shift`, `Ctrl`), она нажимается вместе с кликом;
 * - `type(target, text, apply, opts?)` — курсор нажимает в поле, в нём
 *   встаёт мигающая каретка, и текст печатается по символу; `apply(state,
 *   typed)` зовётся на каждом символе. `{ focused: true }` — поле уже в
 *   фокусе (автофокус в открывшемся окне), клика нет;
 * - `point(target, apply?)` — курсор подводится и задерживается, ничего не
 *   нажимая; `apply` срабатывает через задержку наведения ДС (250 мс) —
 *   так показывают подсказку по наведению;
 * - `key(keys, apply?)` — нажатие клавиш без мыши (`Enter`, `Ctrl+V`):
 *   у курсора клавиши, они нажимаются, ответ — после нажатия;
 * - `drag(from, to, apply?)` — взять и перенести: курсор берёт цель, едет
 *   к другой с полупрозрачной копией, `apply` — в момент, когда отпустил;
 * - `resize(handle, to, apply)` — потянуть край: `apply` в момент захвата,
 *   размер меняется вместе с курсором (`SceneResize`);
 * - `scroll(target, apply)` — прокрутить колёсиком: у курсора мышь
 *   с колёсиком, содержимое едет (`SceneScroll`);
 * - `react(apply)` — интерфейс отвечает сам, без курсора (пришёл ответ,
 *   отфильтровался список);
 * - `wait(apply)` — система работает: пауза ожидания (загрузка, пришло
 *   событие), потом `apply`. Пока ждут, сцена показывает загрузку сама.
 *
 * Вступление, финальный кадр и повтор движок добавляет сам — забыть их
 * нельзя, растянуть тоже.
 */

export type Update<S> = (state: S) => S

export type Beat<S> =
  | {
      kind: 'click'
      target: string
      apply?: Update<S>
      /** Два нажатия подряд. */
      double?: boolean
      /** Правая кнопка мыши. */
      right?: boolean
      /** Зажатая клавиша. */
      key?: string
    }
  | { kind: 'point'; target: string; apply?: Update<S> }
  | { kind: 'key'; keys: string; apply?: Update<S> }
  | { kind: 'drag'; from: string; to: string; apply?: Update<S>; resize?: boolean }
  | { kind: 'scroll'; target: string; apply: Update<S> }
  | { kind: 'type'; target: string; text: string; apply: (state: S, typed: string) => S; focused?: boolean }
  | { kind: 'react'; apply: Update<S> }
  | { kind: 'wait'; apply: Update<S> }

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
export const doubleClick = <S>(target: string, apply?: Update<S>): Beat<S> => ({
  kind: 'click',
  target,
  apply,
  double: true,
})
export const rightClick = <S>(target: string, apply?: Update<S>): Beat<S> => ({
  kind: 'click',
  target,
  apply,
  right: true,
})
export const clickWith = <S>(key: string, target: string, apply?: Update<S>): Beat<S> => ({
  kind: 'click',
  target,
  apply,
  key,
})
export const point = <S>(target: string, apply?: Update<S>): Beat<S> => ({ kind: 'point', target, apply })
export const key = <S>(keys: string, apply?: Update<S>): Beat<S> => ({ kind: 'key', keys, apply })
export const drag = <S>(from: string, to: string, apply?: Update<S>): Beat<S> => ({
  kind: 'drag',
  from,
  to,
  apply,
})
export const resize = <S>(handle: string, to: string, apply: Update<S>): Beat<S> => ({
  kind: 'drag',
  from: handle,
  to,
  apply,
  resize: true,
})
export const scroll = <S>(target: string, apply: Update<S>): Beat<S> => ({ kind: 'scroll', target, apply })
export const type = <S>(
  target: string,
  text: string,
  apply: (state: S, typed: string) => S,
  opts?: { focused?: boolean },
): Beat<S> => ({ kind: 'type', target, text, apply, focused: opts?.focused })
export const react = <S>(apply: Update<S>): Beat<S> => ({ kind: 'react', apply })
export const wait = <S>(apply: Update<S>): Beat<S> => ({ kind: 'wait', apply })

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

/**
 * Значок у курсора: чем нажимают. `key` — клавиша с подписью, `right` —
 * мышь. С момента `press` клавиша или правая кнопка показаны нажатыми.
 */
export interface Cue {
  start: number
  press: number
  /** Моменты нажатия каждой клавиши по очереди (`Ctrl+V`); нет — все в `press`. */
  presses?: number[]
  end: number
  kind: 'key' | 'right' | 'wheel'
  label?: string
}

/** Отрезок, на котором курсор другой формы: над краем, который тянут, — стрелка ширины. */
export interface Shape {
  start: number
  end: number
  shape: 'resize'
}

/** Перенос: с момента захвата до отпускания у курсора копия источника. */
export interface Drag {
  start: number
  end: number
  from: string
}

export interface StateEvent<S> {
  at: number
  apply: Update<S>
}

export interface Timeline<S> {
  moves: Move[]
  hots: Hot[]
  focuses: Focus[]
  cues: Cue[]
  drags: Drag[]
  shapes: Shape[]
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
  const cues: Cue[] = []
  const drags: Drag[] = []
  const shapes: Shape[] = []
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
        // Со значком кнопки или клавиши курсор стоит дольше: значок читают до нажатия.
        const cue = beat.key ? 'key' : beat.right ? 'right' : null
        const lead = cue === 'key' ? BEAT.keyLead : cue === 'right' ? BEAT.cueLead : BEAT.hover
        const cueStart = t
        hots.push({ start: t, end: t + lead, target: beat.target, state: 'hovered' })
        t += lead
        closeFocus(t)
        if (beat.double) {
          hots.push({ start: t, end: t + BEAT.press, target: beat.target, state: 'pressed' })
          t += BEAT.press
          hots.push({ start: t, end: t + BEAT.doubleGap, target: beat.target, state: 'released' })
          t += BEAT.doubleGap
        }
        const pressAt = t
        hots.push({ start: t, end: t + BEAT.press, target: beat.target, state: 'pressed' })
        t += BEAT.press
        if (cue === 'right') {
          // Мышь показывает нажатие и уходит, меню открывается следом, а не в том же кадре.
          hots.push({ start: t, end: t + BEAT.cueOut, target: beat.target, state: 'released' })
          t += BEAT.cueOut
          cues.push({ start: cueStart, press: pressAt, end: t, kind: cue })
        }
        if (beat.apply) events.push({ at: t, apply: beat.apply })
        hots.push({ start: t, end: t + BEAT.release, target: beat.target, state: 'released' })
        t += BEAT.release
        // Клавиша зажата до конца ответа, как настоящий Shift.
        if (cue === 'key') cues.push({ start: cueStart, press: pressAt, end: t, kind: cue, label: beat.key })
        break
      }
      case 'point': {
        actions++
        moves.push({ start: t, end: t + BEAT.move, target: beat.target })
        t += BEAT.move
        hots.push({ start: t, end: t + BEAT.dwell, target: beat.target, state: 'hovered' })
        if (beat.apply) events.push({ at: t + BEAT.hoverDelay, apply: beat.apply })
        t += BEAT.dwell
        break
      }
      case 'key': {
        actions++
        // Курсор стоит, у него клавиши: прочитать — нажать — ответ.
        const start = t
        t += BEAT.keyLead
        // Клавиши по очереди: первая, через шаг вторая — первая остаётся зажатой.
        const presses = beat.keys.split('+').map((_, i) => t + i * BEAT.keyStagger)
        t = presses[presses.length - 1] + BEAT.press
        if (beat.apply) events.push({ at: t, apply: beat.apply })
        t += BEAT.release
        cues.push({ start, press: presses[0], presses, end: t, kind: 'key', label: beat.keys })
        break
      }
      case 'drag': {
        actions++
        moves.push({ start: t, end: t + BEAT.move, target: beat.from })
        t += BEAT.move
        // Над краем курсор сразу меняет форму — как настоящий, ещё до нажатия.
        const shapeStart = t
        hots.push({ start: t, end: t + BEAT.hover, target: beat.from, state: 'hovered' })
        t += BEAT.hover
        closeFocus(t)
        hots.push({ start: t, end: t + BEAT.press, target: beat.from, state: 'pressed' })
        t += BEAT.press
        // Захват: край тянут — размер начинает меняться сразу и едет с курсором.
        if (beat.resize && beat.apply) events.push({ at: t, apply: beat.apply })
        const grab = t
        moves.push({ start: t, end: t + BEAT.dragMove, target: beat.to })
        t += BEAT.dragMove
        // Курсор над местом сброса — оно подсвечивается (наведение за курсором).
        t += BEAT.hover
        if (!beat.resize) {
          drags.push({ start: grab, end: t, from: beat.from })
          if (beat.apply) events.push({ at: t, apply: beat.apply })
        }
        t += BEAT.release
        if (beat.resize) shapes.push({ start: shapeStart, end: t, shape: 'resize' })
        break
      }
      case 'scroll': {
        actions++
        moves.push({ start: t, end: t + BEAT.move, target: beat.target })
        t += BEAT.move
        const start = t
        t += BEAT.cueLead
        events.push({ at: t, apply: beat.apply })
        // Колесо крутится всё время, пока едет содержимое.
        cues.push({ start, press: t, end: t + BEAT.scroll, kind: 'wheel' })
        t += BEAT.scroll + BEAT.release
        break
      }
      case 'type': {
        actions++
        if (beat.text.length > LIMITS.typeChars) {
          problems.push(
            `Печать «${beat.text}» — ${beat.text.length} символов, потолок ${LIMITS.typeChars}. Сократите запрос: сцена про фичу, а не про набор текста`,
          )
        }
        // В поле сначала нажимают — так в нём появляется каретка. Ответ на
        // клик короче обычного: ждать нечего, печать начинается сразу.
        if (!beat.focused) {
          moves.push({ start: t, end: t + BEAT.move, target: beat.target })
          t += BEAT.move
          hots.push({ start: t, end: t + BEAT.hover, target: beat.target, state: 'hovered' })
          t += BEAT.hover
          hots.push({ start: t, end: t + BEAT.press, target: beat.target, state: 'pressed' })
          t += BEAT.press
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
      case 'wait': {
        t += BEAT.wait
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
    cues,
    drags,
    shapes,
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
