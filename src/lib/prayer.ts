import {
  CalculationMethod,
  Coordinates,
  Madhab,
  PolarCircleResolution,
  PrayerTimes,
  Qibla,
  Rounding,
} from 'adhan'

export type MethodKey = 'isna' | 'mwl' | 'egyptian' | 'ummAlQura' | 'karachi' | 'moonsighting'
export type HighLatitudeKey = 'middleofthenight' | 'seventhofthenight' | 'twilightangle'
export type Location = {
  name: string
  latitude: number
  longitude: number
  timezone: string
  country?: string
}
export type Preferences = {
  method: MethodKey
  madhab: 'standard' | 'hanafi'
  fajrAngle: number | null
  ishaAngle: number | null
  highLatitude: HighLatitudeKey
  timeFormat: '12' | '24'
}

export const defaultLocation: Location = {
  name: 'Houston',
  country: 'United States',
  latitude: 29.7604,
  longitude: -95.3698,
  timezone: 'America/Chicago',
}

export const defaultPreferences: Preferences = {
  method: 'isna',
  madhab: 'standard',
  fajrAngle: null,
  ishaAngle: null,
  highLatitude: 'middleofthenight',
  timeFormat: '12',
}

const methods = {
  isna: CalculationMethod.NorthAmerica,
  mwl: CalculationMethod.MuslimWorldLeague,
  egyptian: CalculationMethod.Egyptian,
  ummAlQura: CalculationMethod.UmmAlQura,
  karachi: CalculationMethod.Karachi,
  moonsighting: CalculationMethod.MoonsightingCommittee,
}

function prayerTimesForDay(location: Location, day: Date, preferences: Preferences, roundToMinute = true) {
  const params = methods[preferences.method]()
  params.madhab = preferences.madhab === 'hanafi' ? Madhab.Hanafi : Madhab.Shafi
  params.highLatitudeRule = preferences.highLatitude
  params.polarCircleResolution = PolarCircleResolution.Unresolved
  if (!roundToMinute) params.rounding = Rounding.None

  // Keep method defaults unless the user explicitly customized an angle.
  if (preferences.fajrAngle !== null) params.fajrAngle = preferences.fajrAngle
  if (preferences.ishaAngle !== null) {
    params.ishaAngle = preferences.ishaAngle
    params.ishaInterval = 0
  }

  const date = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12)
  return new PrayerTimes(new Coordinates(location.latitude, location.longitude), date, params)
}

export const salahKeys = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const
export type SalahKey = typeof salahKeys[number]

export function calculateRoutePrayerStarts(location: Location, day: Date, preferences: Preferences) {
  const times = prayerTimesForDay(location, day, preferences, false)
  return salahKeys.map((prayer) => times[prayer].getTime())
}

export function calculatePrayerTimes(location: Location, day: Date, preferences: Preferences) {
  const result = prayerTimesForDay(location, day, preferences)
  const events = [result.fajr, result.sunrise, result.dhuhr, result.asr, result.maghrib, result.isha]
  if (events.some((event) => !(event instanceof Date) || !Number.isFinite(event.getTime()))) return null
  return {
    fajr: result.fajr,
    sunrise: result.sunrise,
    dhuhr: result.dhuhr,
    asr: result.asr,
    maghrib: result.maghrib,
    isha: result.isha,
  }
}

export function dateInTimezone(now: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return new Date(Number(values.year), Number(values.month) - 1, Number(values.day), 12)
}

export function dateKey(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

export function timezoneIsValid(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export function calculateQiblaBearing(location: Location): number {
  return Qibla(new Coordinates(location.latitude, location.longitude))
}
