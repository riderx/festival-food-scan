export type MealSession = {
  key: string
  label: string
  dayKey: string
  dayLabel: string
  mealLabel: string
  entitlementField: string
  scannedAtField: string
}

export const mealSessions = [
  {
    key: 'ven-5-diner',
    label: 'Ven 5 - Dîner',
    dayKey: 'vendredi',
    dayLabel: 'Vendredi',
    mealLabel: 'Dîner',
    entitlementField: 'Ven 5 - Dîner',
    scannedAtField: 'Scanned Ven 5 - Dîner',
  },
  {
    key: 'sam-6-petit-dej',
    label: 'Sam 6 - Petit-déj',
    dayKey: 'samedi',
    dayLabel: 'Samedi',
    mealLabel: 'Petit-déj',
    entitlementField: 'Sam 6 - Petit-déj',
    scannedAtField: 'Scanned Sam 6 - Petit-déj',
  },
  {
    key: 'sam-6-dejeuner',
    label: 'Sam 6 - Déjeuner',
    dayKey: 'samedi',
    dayLabel: 'Samedi',
    mealLabel: 'Déjeuner',
    entitlementField: 'Sam 6 - Déjeuner',
    scannedAtField: 'Scanned Sam 6 - Déjeuner',
  },
  {
    key: 'sam-6-diner',
    label: 'Sam 6 - Dîner',
    dayKey: 'samedi',
    dayLabel: 'Samedi',
    mealLabel: 'Dîner',
    entitlementField: 'Sam 6 - Dîner',
    scannedAtField: 'Scanned Sam 6 - Dîner',
  },
  {
    key: 'dim-7-petit-dej',
    label: 'Dim 7 - Petit-déj',
    dayKey: 'dimanche',
    dayLabel: 'Dimanche',
    mealLabel: 'Petit-déj',
    entitlementField: 'Dim 7 - Petit-déj',
    scannedAtField: 'Scanned Dim 7 - Petit-déj',
  },
  {
    key: 'dim-7-dejeuner',
    label: 'Dim 7 - Déjeuner',
    dayKey: 'dimanche',
    dayLabel: 'Dimanche',
    mealLabel: 'Déjeuner',
    entitlementField: 'Dim 7 - Déjeuner',
    scannedAtField: 'Scanned Dim 7 - Déjeuner',
  },
  {
    key: 'dim-7-diner',
    label: 'Dim 7 - Dîner',
    dayKey: 'dimanche',
    dayLabel: 'Dimanche',
    mealLabel: 'Dîner',
    entitlementField: 'Dim 7 - Dîner',
    scannedAtField: 'Scanned Dim 7 - Dîner',
  },
  {
    key: 'lun-8-petit-dej',
    label: 'Lun 8 - Petit-déj',
    dayKey: 'lundi',
    dayLabel: 'Lundi',
    mealLabel: 'Petit-déj',
    entitlementField: 'Lun 8 - Petit-déj',
    scannedAtField: 'Scanned Lun 8 - Petit-déj',
  },
] satisfies MealSession[]

export type MealSessionGroup = {
  dayKey: string
  dayLabel: string
  sessions: MealSession[]
}

export const mealSessionGroups = mealSessions.reduce<MealSessionGroup[]>((groups, session) => {
  const group = groups.find((item) => item.dayKey === session.dayKey)
  if (group) {
    group.sessions.push(session)
    return groups
  }

  groups.push({
    dayKey: session.dayKey,
    dayLabel: session.dayLabel,
    sessions: [session],
  })
  return groups
}, [])

export function mealSessionByKey(key: string): MealSession {
  return mealSessions.find((session) => session.key === key) ?? mealSessions[0]
}
