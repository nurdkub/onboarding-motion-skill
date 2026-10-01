import { Button } from '@/components/square/Button'
import { Checkbox } from '@/components/square/Checkbox'
import { Chip } from '@/components/square/Chip'
import { Icon } from '@/components/square/Icon'
import { IconButton } from '@/components/square/IconButton'
import { Input } from '@/components/square/Input'
import {
  OnboardingScene,
  SceneAppear,
  ScenePlane,
  SceneTarget,
  SceneWindow,
  click,
  defineStory,
  type,
} from '@/shared/onboarding'
import { CORRESPONDENTS, PICK } from './dg-name.data'

interface State {
  modal: boolean
  query: string
  picked: boolean
  chip: boolean
}

/**
 * Сценарий — только действия пользователя. Ни одной длительности: сколько
 * длится каждый шаг и как движется курсор, решает motion.ts.
 */
export const story = defineStory<State>({
  initial: { modal: false, query: '', picked: false, chip: false },
  beats: [
    click('picker', (s) => ({ ...s, modal: true })),
    type('search', PICK.dgName, (s, query) => ({ ...s, query })),
    click('pick', (s) => ({ ...s, picked: true })),
    click('ok', (s) => ({ ...s, modal: false, chip: true })),
  ],
})

export function RecipientScene() {
  return (
    <OnboardingScene story={story}>
      {(s) => (
        <>
          <ScenePlane>
            <Input size="medium" label="outside" labelValue="Тема" value="Договор поставки" readOnly />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-03)' }}>
              <Input
                size="medium"
                label="outside"
                labelValue="Получатели"
                required
                placeholder="Поиск по названию, DG Name или ИИН"
                readOnly
                rightIcon={
                  <SceneTarget id="picker" inline>
                    <IconButton
                      color="neutral"
                      priority="quaternary"
                      size="extraSmall"
                      aria-label="Справочник"
                      icon={<Icon name="menu_book" />}
                    />
                  </SceneTarget>
                }
              />
              <SceneAppear show={s.chip} kind="result">
                <Chip draggable deleteable>
                  {PICK.name}, {PICK.dgName}
                </Chip>
              </SceneAppear>
            </div>
          </ScenePlane>

          <SceneWindow
            open={s.modal}
            label="Корреспонденты"
            actions={
              <>
                <Button color="accent" priority="secondary" size="small">
                  Отменить
                </Button>
                <SceneTarget id="ok" inline>
                  <Button color="accent" priority="primary" size="small">
                    ОК
                  </Button>
                </SceneTarget>
              </>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-05)' }}>
              <SceneTarget id="search">
                <Input
                  size="small"
                  placeholder="Поиск по названию, DG Name или ИИН"
                  leftIcon={<Icon name="search" />}
                  value={s.query}
                  onChange={() => {}}
                />
              </SceneTarget>
              {CORRESPONDENTS.map((c) => (
                <SceneAppear
                  key={c.id}
                  show={c.dgName.includes(s.query)}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--gap-05)',
                      padding: 'var(--paddings-03)',
                    }}
                  >
                    <SceneTarget id={c.id === PICK.id ? 'pick' : c.id} inline>
                      <Checkbox
                        size="small"
                        checked={c.id === PICK.id && s.picked}
                        onChange={() => {}}
                        labelValue={c.name}
                      />
                    </SceneTarget>
                    <span
                      className="body-m"
                      style={{
                        marginInlineStart: 'auto',
                        color:
                          s.query && c.dgName.includes(s.query)
                            ? 'var(--colors-text-accent-primary)'
                            : 'var(--colors-text-neutral-secondary)',
                      }}
                    >
                      {c.dgName}
                    </span>
                  </div>
                </SceneAppear>
              ))}
            </div>
          </SceneWindow>
        </>
      )}
    </OnboardingScene>
  )
}
