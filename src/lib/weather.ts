import { positionAlongRoute } from './flight'
import type { Location } from './prayer'

const storageKey = 'salah-route-weather'
const hour = 3_600_000

type WeatherPoint = {
  latitude: number
  longitude: number
  time: number
  departure?: boolean
  temperature: number | null
  precipitation: number | null
  wind: number | null
}

export type RouteWeather = { route: string; capturedAt: number; points: WeatherPoint[] }

export function weatherRouteId(origin: Location, destination: Location, departure: Date, arrival: Date): string {
  return JSON.stringify([origin.latitude, origin.longitude, destination.latitude, destination.longitude, +departure, +arrival])
}

export function readRouteWeather(): RouteWeather | null {
  try {
    const saved = localStorage.getItem(storageKey)
    if (!saved) return null
    const snapshot = JSON.parse(saved) as RouteWeather
    return Array.isArray(snapshot?.points) ? snapshot : null
  } catch {
    return null
  }
}

export function forecastHour(timestamp: number): number {
  return Math.round(timestamp / hour) * hour
}

export async function captureRouteWeather(origin: Location, destination: Location, departure: Date, arrival: Date): Promise<RouteWeather> {
  const start = departure.getTime()
  const end = arrival.getTime()
  const intervals = Math.min(24, Math.ceil((end - start) / hour))
  const locations: Array<Pick<WeatherPoint, 'latitude' | 'longitude' | 'time' | 'departure'>> = Array.from({ length: intervals }, (_, index) => {
    const time = start + index * hour
    return { ...positionAlongRoute(origin, destination, (time - start) / (end - start)), time, departure: index === 0 }
  })
  locations.push({ latitude: destination.latitude, longitude: destination.longitude, time: end })

  const params = new URLSearchParams({
    latitude: locations.map((location) => location.latitude.toFixed(2)).join(','),
    longitude: locations.map((location) => location.longitude.toFixed(2)).join(','),
    start_date: new Date(forecastHour(start)).toISOString().slice(0, 10),
    end_date: new Date(forecastHour(end)).toISOString().slice(0, 10),
    hourly: 'temperature_2m,precipitation,wind_speed_10m',
    timeformat: 'unixtime',
    timezone: 'GMT',
    cell_selection: 'nearest',
  })
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error('Route weather unavailable')
  type Hourly = { time: number[]; temperature_2m: Array<number | null>; precipitation: Array<number | null>; wind_speed_10m: Array<number | null> }
  const forecasts = await response.json() as Array<{ hourly?: Hourly }>
  const points = locations.flatMap((location, index) => {
    const hourly = forecasts[index]?.hourly
    const sample = hourly?.time.indexOf(forecastHour(location.time) / 1000) ?? -1
    if (!hourly || sample < 0) return []
    const temperature = hourly.temperature_2m[sample] ?? null
    const precipitation = hourly.precipitation[sample] ?? null
    const wind = hourly.wind_speed_10m[sample] ?? null
    return temperature === null && precipitation === null && wind === null ? [] : [{ ...location, temperature, precipitation, wind }]
  })
  if (!points.length) throw new Error('Route weather unavailable')
  const snapshot = { route: weatherRouteId(origin, destination, departure, arrival), capturedAt: Date.now(), points }
  localStorage.setItem(storageKey, JSON.stringify(snapshot))
  return snapshot
}

export const precipitationColors = {
  dry: '#87a9b4',
  light: '#2d80d1',
  heavy: '#522c9e',
} as const

export function precipitationBands(
  weather: RouteWeather,
  origin: Location,
  destination: Location,
  departure: number,
  arrival: number,
) {
  const duration = arrival - departure
  return weather.points.flatMap((sample, index) => {
    if (sample.precipitation === null || duration <= 0) return []
    const previousTime = weather.points[index - 1]?.time ?? departure
    const nextTime = weather.points[index + 1]?.time ?? arrival
    const start = Math.max(departure, sample.time - hour / 2, (previousTime + sample.time) / 2)
    const end = Math.min(arrival, sample.time + hour / 2, (nextTime + sample.time) / 2)
    if (end <= start) return []
    const positions = Array.from({ length: 9 }, (_, step): [number, number] => {
      const time = start + (end - start) * step / 8
      const point = positionAlongRoute(origin, destination, (time - departure) / duration)
      return [point.latitude, point.longitude]
    })
    const color = sample.precipitation >= 2 ? precipitationColors.heavy
      : sample.precipitation > 0 ? precipitationColors.light
      : precipitationColors.dry
    return [{ time: sample.time, positions, color }]
  })
}
