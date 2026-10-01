/** Корреспонденты в окне выбора. Демонстрационные данные. */
export const CORRESPONDENTS = [
  { id: 'seitova', name: 'Сейтова Айгерим', dgName: 'aigerim-seitova' },
  { id: 'nur', name: 'ТОО «Нур Логистик»', dgName: 'nur-logistic' },
  { id: 'asanov', name: 'Асанов Ерлан', dgName: 'asanov' },
]

/** Кого сцена находит и выбирает. */
export const PICK = CORRESPONDENTS[2]

export const TIP = {
  title: 'Найдите получателя по DG Name',
  text: 'Не нужен БИН или ИИН — достаточно никнейма, который получатель выбрал при регистрации',
}
