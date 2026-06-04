export type MealSession = {
  key: string
  label: string
  entitlementField: string
  scannedAtField: string
}

export const mealSessions = [
  {
    key: 'ven-5-diner',
    label: 'Ven 5 - Dîner',
    entitlementField: 'Ven 5 - Dîner',
    scannedAtField: 'Scanned Ven 5 - Dîner',
  },
  {
    key: 'sam-6-petit-dej',
    label: 'Sam 6 - Petit-déj',
    entitlementField: 'Sam 6 - Petit-déj',
    scannedAtField: 'Scanned Sam 6 - Petit-déj',
  },
  {
    key: 'sam-6-dejeuner',
    label: 'Sam 6 - Déjeuner',
    entitlementField: 'Sam 6 - Déjeuner',
    scannedAtField: 'Scanned Sam 6 - Déjeuner',
  },
  {
    key: 'sam-6-diner',
    label: 'Sam 6 - Dîner',
    entitlementField: 'Sam 6 - Dîner',
    scannedAtField: 'Scanned Sam 6 - Dîner',
  },
  {
    key: 'dim-7-petit-dej',
    label: 'Dim 7 - Petit-déj',
    entitlementField: 'Dim 7 - Petit-déj',
    scannedAtField: 'Scanned Dim 7 - Petit-déj',
  },
  {
    key: 'dim-7-dejeuner',
    label: 'Dim 7 - Déjeuner',
    entitlementField: 'Dim 7 - Déjeuner',
    scannedAtField: 'Scanned Dim 7 - Déjeuner',
  },
  {
    key: 'dim-7-diner',
    label: 'Dim 7 - Dîner',
    entitlementField: 'Dim 7 - Dîner',
    scannedAtField: 'Scanned Dim 7 - Dîner',
  },
  {
    key: 'lun-8-petit-dej',
    label: 'Lun 8 - Petit-déj',
    entitlementField: 'Lun 8 - Petit-déj',
    scannedAtField: 'Scanned Lun 8 - Petit-déj',
  },
] satisfies MealSession[]

export function mealSessionByKey(key: string): MealSession {
  return mealSessions.find((session) => session.key === key) ?? mealSessions[0]
}
