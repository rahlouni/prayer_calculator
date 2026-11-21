import { approximateFlightTimezone } from './offline'
import { calculateRoutePrayerStarts, salahKeys, type Location, type Preferences, type SalahKey } from './prayer'

export function positionAlongRoute(origin: Location, destination: Location, progress: number): Pick<Location, 'latitude' | 'longitude'> {
  const fraction = Math.max(0, Math.min(1, progress))
  const radians = Math.PI / 180
  const startLat = origin.latitude * radians
  const startLon = origin.longitude * radians
  const endLat = destination.latitude * radians
  const endLon = destination.longitude * radians
  const start = [Math.cos(startLat) * Math.cos(startLon), Math.cos(startLat) * Math.sin(startLon), Math.sin(startLat)]
  const end = [Math.cos(endLat) * Math.cos(endLon), Math.cos(endLat) * Math.sin(endLon), Math.sin(endLat)]
  const dot = Math.max(-1, Math.min(1, start[0] * end[0] + start[1] * end[1] + start[2] * end[2]))
  const angle = Math.acos(dot)
  const denominator = Math.sin(angle)
  const startWeight = angle < 0.000001 ? 1 - fraction : Math.sin((1 - fraction) * angle) / denominator
  const endWeight = angle < 0.000001 ? fraction : Math.sin(fraction * angle) / denominator
  const x = startWeight * start[0] + endWeight * end[0]
  const y = startWeight * start[1] + endWeight * end[1]
  const z = startWeight * start[2] + endWeight * end[2]
  return { latitude: Math.atan2(z, Math.hypot(x, y)) / radians, longitude: Math.atan2(y, x) / radians }
}

type RoutePrayer = { prayer: SalahKey; time: Date; location: Location }

export function projectRoutePrayers(
  origin: Location,
  destination: Location,
  departure: Date,
  arrival: Date,
  preferences: Preferences,
): { crossings: RoutePrayer[]; incomplete: boolean } {
  const start = departure.getTime()
  const end = arrival.getTime()
  const crossings: RoutePrayer[] = []
  let incomplete = false

  function sample(timestamp: number) {
    const point = positionAlongRoute(origin, destination, (timestamp - start) / (end - start))
    const location = { ...point, name: '', timezone: approximateFlightTimezone(point.longitude) }
    const localDate = new Date(timestamp + Math.round(point.longitude / 15) * 3_600_000)
    const day = new Date(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate(), 12)
    const starts = calculateRoutePrayerStarts(location, day, preferences)
    incomplete ||= starts.some((time) => !Number.isFinite(time))
    return { timestamp, location, offsets: starts.map((time) => timestamp - time) }
  }

  let previous = sample(start)
  const step = Math.max(60_000, Math.ceil((end - start) / 2_880))
  for (let timestamp = start; timestamp < end;) {
    timestamp = Math.min(timestamp + step, end)
    const current = sample(timestamp)
    salahKeys.forEach((prayer, index) => {
      if (!(previous.offsets[index] < 0 && current.offsets[index] >= 0)) return

      let low = previous.timestamp
      let crossing = current
      while (crossing.timestamp - low > 500) {
        const middle = sample(Math.floor((low + crossing.timestamp) / 2))
        if (!Number.isFinite(middle.offsets[index])) return
        if (middle.offsets[index] >= 0) crossing = middle
        else low = middle.timestamp
      }

      // A date-boundary jump can change the sign without approaching a prayer start.
      if (crossing.offsets[index] <= 2_000) {
        crossings.push({ prayer, time: new Date(crossing.timestamp), location: crossing.location })
      }
    })
    previous = current
  }
  crossings.sort((first, second) => first.time.getTime() - second.time.getTime())
  return { crossings, incomplete }
}
