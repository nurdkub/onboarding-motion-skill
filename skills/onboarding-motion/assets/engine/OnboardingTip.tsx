import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import './onboarding.css'

/**
 * Задержка появления по наведению — сквозное правило ДС (docs/principles.md,
 * «Появление по наведению — с задержкой»), то же число, что у `Tooltip`.
 */
const OPEN_DELAY = 250

export interface OnboardingTipProps {
  /** Что за фича — `headline-h6`, одна строка. */
  title: string
  /** Зачем она — `body-m`, одно-два предложения, без точки в конце. */
  text: string
  /** Сцена — `<OnboardingScene story={…}>`. Монтируется при открытии: цикл всегда с начала. */
  scene: ReactNode
  /** Сторона от цели. По умолчанию под целью. */
  side?: 'bottom' | 'top'
  /**
   * Открыта всегда — для экрана, где подсказку показывают, а не ищут
   * (витрина, сценарий прототипа). Без пропа — по наведению на цель.
   */
  open?: boolean
  /** Цель: значок «i», бейдж «Новое», кнопка фичи. */
  children: ReactNode
}

/**
 * Onboarding / Tip — подсказка с живой сценой.
 *
 * Сверху сцена (360×240), под ней заголовок и одна-две строки текста.
 * Появление — общий слой накладок ДС (`sq-appear` + `data-side`), уход —
 * сразу, как у `Tooltip`. Интерактива внутри нет: сцена `inert`,
 * кнопки «Понятно» и «Пропустить» — это уже тур, а не подсказка.
 *
 * Не компонент Square: в Figma обучающая подсказка — приватный
 * `.tooltip-main` на сырых hex, в код не перенесён (docs/components/Tooltip.md).
 * Имя полигона, фронт-команде передаётся хореография из motion.ts, а не
 * этот файл.
 */
export function OnboardingTip({
  title,
  text,
  scene,
  side = 'bottom',
  open: forced,
  children,
}: OnboardingTipProps) {
  const [hoverOpen, setHoverOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const cancel = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  useEffect(() => cancel, [cancel])

  const open = forced ?? hoverOpen

  return (
    <span
      className="OnbTip"
      onPointerEnter={() => {
        cancel()
        timer.current = window.setTimeout(() => setHoverOpen(true), OPEN_DELAY)
      }}
      onPointerLeave={() => {
        cancel()
        setHoverOpen(false)
      }}
    >
      {children}
      {open && (
        <span className="OnbTip__bubble sq-appear" data-side={side} role="tooltip">
          {scene}
          <span className="OnbTip__text">
            <span className="OnbTip__title headline-h6">{title}</span>
            <span className="OnbTip__description body-m">{text}</span>
          </span>
        </span>
      )}
    </span>
  )
}
