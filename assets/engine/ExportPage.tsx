import { useEffect, useRef } from 'react'
import type { ComponentType } from 'react'
import { useLocation } from 'react-router-dom'
import { exportSceneSvg } from './svgExport'
import type { SceneController } from './OnboardingScene'
import './onboarding.css'

/**
 * Служебная страница выгрузки сцены в SVG: `/#/onboarding-export?scene=<слаг>`.
 *
 * Показывает подсказку открытой, без хрома, на прозрачном поле 24 px — под
 * тень. Сцена монтируется в режиме перемотки (`window.__ONB_EXPORT__`): часы
 * не идут, выгрузка ведёт время сама. Скрипт `scripts/export-onboarding-svg.mjs`
 * открывает страницу в браузере без окна и зовёт `window.__onbExportSvg()`.
 *
 * Сцены находятся сами: файл `src/prototypes/<слаг>/scene.tsx` с экспортом
 * `onboardingTip = { title, text, Scene }`.
 */

interface OnboardingTipExport {
  title: string
  text: string
  Scene: ComponentType
}

const modules = import.meta.glob<{ onboardingTip?: OnboardingTipExport }>('/src/prototypes/*/scene.tsx', {
  eager: true,
})

export const exportableScenes = Object.entries(modules)
  .filter(([, m]) => m.onboardingTip)
  .map(([path, m]) => ({ slug: path.split('/')[3], tip: m.onboardingTip! }))

type ExportWindow = {
  __ONB_EXPORT__?: boolean
  __onbScenes?: SceneController[]
  __onbExportSvg?: () => Promise<{ svg: string; shots: number; bytes: number }>
}

export function OnboardingExportPage() {
  const { search } = useLocation()
  const slug = new URLSearchParams(search).get('scene') ?? ''
  const found = exportableScenes.find((s) => s.slug === slug || s.slug.includes(slug))
  const root = useRef<HTMLDivElement>(null)
  const w = window as unknown as ExportWindow

  // Флаг ставится при рендере страницы — до того, как смонтируется сцена.
  w.__ONB_EXPORT__ = true

  useEffect(() => {
    document.documentElement.dataset.product = 'platform'
    w.__onbExportSvg = async () => {
      const ctrl = w.__onbScenes?.[0]
      if (!root.current || !ctrl) throw new Error('сцена не смонтирована')
      return exportSceneSvg(root.current, ctrl)
    }
    return () => {
      delete document.documentElement.dataset.product
      delete w.__ONB_EXPORT__
      delete w.__onbExportSvg
    }
  }, [w])

  if (!found) {
    return (
      <pre style={{ padding: 24 }}>
        {`Сцена «${slug}» не найдена. Есть: ${exportableScenes.map((s) => s.slug).join(', ') || 'ни одной'}`}
      </pre>
    )
  }

  const { Scene, title, text } = found.tip
  return (
    <div ref={root} id="onb-export" style={{ padding: 24, display: 'inline-block' }}>
      <span className="OnbTip__bubble" style={{ position: 'relative', display: 'flex' }}>
        <Scene />
        <span className="OnbTip__text">
          <span className="OnbTip__title headline-h6">{title}</span>
          <span className="OnbTip__description body-m">{text}</span>
        </span>
      </span>
    </div>
  )
}
