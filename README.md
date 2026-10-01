# onboarding-motion

Скилл для Claude: онбординг фич живой сценой в подсказке, как в Telegram. Курсор сам
показывает новое действие на миниатюре интерфейса, в конце — результат. Автор пишет только
сценарий (`click`, `type`, `point`, `react`); такт, кривые, отклик на нажатие, финальный кадр
и повтор задаёт движок — поэтому сцена выходит одинаковой у любого автора.

Собран на дизайн-системе Square (Documentolog, d8n). Версия 1.0.0 от 01.10.2026.

## Что внутри

```
.claude-plugin/
  marketplace.json      маркетплейс из одного плагина — для установки из GitHub
  plugin.json           манифест плагина
skills/onboarding-motion/
  SKILL.md              правила, порядок сборки сцены, чек-лист, установка движка
  references/
    timing.md           такт, кривые, отклик на нажатие — таблица для фронт-команды
    storyboard.md       как выбрать сюжет и разложить на шаги, анти-паттерны
    research.md         выжимка гайдов Material, Apple, NN/g, Appcues, WCAG и референсы
  assets/
    engine/             движок: motion.ts, story.ts, OnboardingScene.tsx, OnboardingTip.tsx, onboarding.css, index.ts
    examples/           две готовые сцены: выбор получателя по DG Name и перенос документов в папку
onboarding-motion.zip   та же папка скилла одним архивом — для claude.ai
```

## Установка в Claude Code из GitHub

В сеансе Claude Code:

```
/plugin marketplace add <владелец>/<репозиторий>
/plugin install onboarding-motion@square-onboarding
```

Или из терминала:

```bash
claude plugin marketplace add <владелец>/<репозиторий>
claude plugin install onboarding-motion@square-onboarding
```

Репозиторий приватный — у того, кто ставит, должен быть к нему доступ (`gh auth login`).
Обновление: `/plugin marketplace update square-onboarding`, затем переустановка плагина.

## Установка без маркетплейса

Скопировать папку `skills/onboarding-motion/` в одно из мест:

- `~/.claude/skills/onboarding-motion/` — для всех проектов;
- `.claude/skills/onboarding-motion/` в корне проекта — только для него.

## claude.ai

Загрузить `onboarding-motion.zip` в настройках Claude, раздел навыков (Skills). В архиве —
папка `onboarding-motion/` с `SKILL.md` в корне. В claude.ai скилл работает как справочник
правил и образец кода: движок из `assets/engine/` не запускается сам, его копируют в проект.

## Движок

Работает в проекте на React с компонентами Square и токенами Square — подробности в разделе
«Установка движка» в `SKILL.md`. В полигоне Square DS Prototyping движок уже лежит в
`src/shared/onboarding/`, и источник правды — он; этот пакет — снимок на 01.10.2026.
