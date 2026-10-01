/** Строки списка в сцене. Демонстрационные данные. */
export const SCENE_DOCS = [
  { id: 'supply', title: 'Договор поставки №12', number: 'Д-2026/112' },
  { id: 'act', title: 'Акт сверки за сентябрь', number: 'А-2026/087' },
  { id: 'letter', title: 'Письмо о продлении срока', number: 'П-2026/341' },
  { id: 'invoice', title: 'Счёт на оплату №58', number: 'С-2026/058' },
]

/** Какие документы сцена отмечает и переносит. */
export const MOVED = ['supply', 'act']

export const FOLDERS = ['Договоры', 'Акты', 'Входящие']

/** Папка, которую выбирает сцена. */
export const TARGET_FOLDER = FOLDERS[0]

export const TIP = {
  title: 'Переносите документы в папку разом',
  text: 'Отметьте нужные документы и выберите папку — не придётся открывать каждый',
}

export const RESULT = `2 документа перенесены в «${TARGET_FOLDER}»`
