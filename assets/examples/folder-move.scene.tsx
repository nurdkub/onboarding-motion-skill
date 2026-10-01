import { ActionBar, ActionBarActionButtons } from '@/components/square/ActionBar'
import { Alert } from '@/components/square/Alert'
import { Button } from '@/components/square/Button'
import { Checkbox } from '@/components/square/Checkbox'
import { Dropdown } from '@/components/square/Dropdown'
import { Icon } from '@/components/square/Icon'
import { OnboardingScene, SceneAppear, SceneTarget, click, defineStory } from '@/shared/onboarding'
import { FOLDERS, MOVED, RESULT, SCENE_DOCS, TARGET_FOLDER } from './folder-move.data'

interface State {
  checked: string[]
  folders: boolean
  moved: boolean
}

/**
 * Сценарий — только действия пользователя: отметить два документа, открыть
 * «Папка», выбрать «Договоры». Длительности и кривые задаёт motion.ts.
 */
export const story = defineStory<State>({
  initial: { checked: [], folders: false, moved: false },
  beats: [
    click(`check-${MOVED[0]}`, (s) => ({ ...s, checked: [...s.checked, MOVED[0]] })),
    click(`check-${MOVED[1]}`, (s) => ({ ...s, checked: [...s.checked, MOVED[1]] })),
    click('folder', (s) => ({ ...s, folders: true })),
    click('target-folder', (s) => ({ ...s, folders: false, moved: true, checked: [] })),
  ],
})

export function FolderMoveScene() {
  return (
    <OnboardingScene story={story}>
      {(s) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-04)' }}>
          <ActionBar case="documentList" style={{ padding: 0 }}>
            <ActionBarActionButtons>
              <Button color="onColor" priority="primary" size="extraSmall">
                Экспорт в Excel
              </Button>
              <Dropdown
                open={s.folders}
                trigger={
                  <SceneTarget id="folder" inline>
                    <Button
                      color="onColor"
                      priority="primary"
                      size="extraSmall"
                      rightIcon={<Icon name="expand_more" />}
                    >
                      Папка
                    </Button>
                  </SceneTarget>
                }
              >
                {FOLDERS.map((folder) =>
                  folder === TARGET_FOLDER ? (
                    <SceneTarget key={folder} id="target-folder">
                      <Button color="accent" priority="quaternary" size="extraSmall">
                        {folder}
                      </Button>
                    </SceneTarget>
                  ) : (
                    <Button key={folder} color="accent" priority="quaternary" size="extraSmall">
                      {folder}
                    </Button>
                  ),
                )}
              </Dropdown>
            </ActionBarActionButtons>
          </ActionBar>

          {/* Плоскость списка — как таблица папки: белая, поле paddings/06. */}
          <div
            style={{
              padding: 'var(--paddings-06)',
              background: 'var(--colors-surface-onColor-neutral-primary)',
            }}
          >
            {SCENE_DOCS.map((doc) => (
              <SceneAppear
                key={doc.id}
                show={!(s.moved && MOVED.includes(doc.id))}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--gap-05)',
                    paddingBlock: 'var(--paddings-03)',
                    paddingInline: 'var(--paddings-03)',
                    borderBlockEnd:
                      'var(--borderWidth-default) solid var(--colors-border-neutral-tertiaryDefault)',
                  }}
                >
                  <SceneTarget id={`check-${doc.id}`} inline>
                    <Checkbox checked={s.checked.includes(doc.id)} onChange={() => {}} />
                  </SceneTarget>
                  <span className="body-m" style={{ color: 'var(--colors-text-neutral-secondary)' }}>
                    {doc.number}
                  </span>
                  <span className="body-m" style={{ color: 'var(--colors-text-neutral-primary)' }}>
                    {doc.title}
                  </span>
                </div>
              </SceneAppear>
            ))}
          </div>

          <SceneAppear show={s.moved} kind="result">
            <Alert type="success" labelValue={RESULT} />
          </SceneAppear>
        </div>
      )}
    </OnboardingScene>
  )
}
