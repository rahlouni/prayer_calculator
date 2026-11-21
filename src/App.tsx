import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Gauge,
  Compass,
  LocateFixed,
  MapPin,
  MapPinned,
  MoveUpRight,
  Moon,
  Plane,
  Route,
  Search,
  Settings2,
  Smartphone,
  Sunrise,
  Sun,
  X,
  Plus,
  Minus,
} from 'lucide-react'
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { divIcon } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import en from './i18n/en'
import {
  calculateQiblaBearing,
  calculatePrayerTimes,
  dateInTimezone,
  dateKey,
  defaultLocation,
  defaultPreferences,
  timezoneIsValid,
  type Location,
  type MethodKey,
  type Preferences,
} from './lib/prayer'
import { approximateFlightTimezone, cacheFlightApp, displayFlightTimezone, hasOfflineFlight, offlineFlightKey } from './lib/offline'
import './App.css'

type CityResult = Location & { id: number; admin1?: string }
type PrayerKey = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha'
type FlightPlan = {
  flightNumber: string
  origin: Location
  destination: Location
  scheduledDeparture: string
  actualDeparture: string
  expectedArrival: string
  holdAtOrigin?: boolean
  timeDisplay?: 'local' | 'destination'
  displayTimezone?: 'origin' | 'destination' | 'utc'
}
type FlightDraft = Omit<FlightPlan, 'origin' | 'destination' | 'timeDisplay'> & { origin: Location | null; destination: Location | null; timeDisplay: 'local' | 'destination' }
type FlightTimeField = 'scheduledDeparture' | 'actualDeparture' | 'expectedArrival'
type FlightApiRecord = {
  flight_date?: string
  flight_status?: string
  flight?: { iata?: string; number?: string }
  airline?: { iata?: string }
  departure?: { airport?: string; iata?: string; timezone?: string; scheduled?: string; estimated?: string; actual?: string }
  arrival?: { airport?: string; iata?: string; timezone?: string; scheduled?: string; estimated?: string; actual?: string }
  live?: { latitude?: number | null; longitude?: number | null; direction?: number | null; speed_horizontal?: number | null; updated?: string | null }
}

const prayerRows: { key: PrayerKey; label: string; icon: typeof Sun; obligatory: boolean }[] = [
  { key: 'fajr', label: en.fajr, icon: Moon, obligatory: true },
  { key: 'sunrise', label: en.sunrise, icon: Sunrise, obligatory: false },
  { key: 'dhuhr', label: en.dhuhr, icon: Sun, obligatory: true },
  { key: 'asr', label: en.asr, icon: Sun, obligatory: true },
  { key: 'maghrib', label: en.maghrib, icon: Sunrise, obligatory: true },
  { key: 'isha', label: en.isha, icon: Moon, obligatory: true },
]

const methodOptions: { key: MethodKey; label: string }[] = [
  { key: 'isna', label: en.methodNames.isna },
  { key: 'mwl', label: en.methodNames.mwl },
  { key: 'egyptian', label: en.methodNames.egyptian },
  { key: 'ummAlQura', label: en.methodNames.ummAlQura },
  { key: 'karachi', label: en.methodNames.karachi },
  { key: 'moonsighting', label: en.methodNames.moonsighting },
]

function readStored<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key)
    return stored ? { ...fallback, ...JSON.parse(stored) } : fallback
  } catch {
    return fallback
  }
}

function formatTime(date: Date, location: Location, format: Preferences['timeFormat']): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: location.timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: format === '12',
  }).format(date)
}

function formatDate(date: Date, location: Location, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en', { ...options, timeZone: location.timezone }).format(date)
}

function formatScheduleDate(date: Date, location: Location, options: Intl.DateTimeFormatOptions): string {
  const datePart = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T12:00`
  return formatDate(wallTimeToInstant(datePart, location.timezone) ?? date, location, options)
}

function locationDisplay(location: Location): string {
  return [location.name, location.country].filter(Boolean).join(', ')
}

function makeSearchDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

function wallTimeToInstant(value: string, timezone: string): Date | null {
  const [datePart, timePart] = value.split('T')
  const [year, month, day] = (datePart ?? '').split('-').map(Number)
  const [hour, minute] = (timePart ?? '').split(':').map(Number)
  if (![year, month, day, hour, minute].every(Number.isFinite) || !timezoneIsValid(timezone)) return null
  const target = Date.UTC(year, month - 1, day, hour, minute)
  let candidate = target
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(candidate))
      const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]))
      const rendered = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute)
      candidate += target - rendered
    }
    const result = new Date(candidate)
    return Number.isFinite(result.getTime()) ? result : null
  } catch {
    return null
  }
}

function dateTimeInputValue(dateTime: string | null | undefined, timezone: string): string {
  if (!dateTime || !timezoneIsValid(timezone)) return ''
  // Aviationstack returns the airport's local wall-clock value while also
  // attaching an offset. The airport IANA zone is the authoritative display zone.
  const airportWallTime = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(dateTime)?.[1]
  if (airportWallTime) return airportWallTime
  const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateTime) ? dateTime : `${dateTime}Z`
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return ''
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date)
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`
  } catch {
    return ''
  }
}

async function findAirportLocation(iata: string | undefined, airportName: string | undefined, timezone: string | undefined): Promise<Location | null> {
  const searchNames = [iata, airportName].filter((value): value is string => Boolean(value?.trim()))
  for (const searchName of searchNames) {
    const params = new URLSearchParams({ name: searchName, count: '10', language: 'en', format: 'json' })
    const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`)
    if (!response.ok) continue
    const data = await response.json() as { results?: Array<{ name: string; latitude: number; longitude: number; timezone?: string; country?: string; feature_code?: string }> }
    const airports = (data.results ?? []).filter((item) => item.feature_code === 'AIRP')
    const matched = airports.find((item) => airportName && item.name.toLowerCase().includes(airportName.toLowerCase())) ?? airports[0]
    if (!matched) continue
    const resolvedTimezone = timezone && timezoneIsValid(timezone) ? timezone : matched.timezone
    if (!resolvedTimezone || !timezoneIsValid(resolvedTimezone)) continue
    return {
      name: `${matched.name}${iata ? ` (${iata})` : ''}`,
      country: matched.country,
      latitude: matched.latitude,
      longitude: matched.longitude,
      timezone: resolvedTimezone,
    }
  }
  return null
}

function positionAlongRoute(origin: Location, destination: Location, progress: number): Pick<Location, 'latitude' | 'longitude'> {
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

function routeBearing(origin: Pick<Location, 'latitude' | 'longitude'>, destination: Pick<Location, 'latitude' | 'longitude'>): number {
  const radians = Math.PI / 180
  const lat1 = origin.latitude * radians
  const lat2 = destination.latitude * radians
  const deltaLon = (destination.longitude - origin.longitude) * radians
  const y = Math.sin(deltaLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon)
  return (Math.atan2(y, x) / radians + 360) % 360
}

function routeDistanceKm(origin: Pick<Location, 'latitude' | 'longitude'>, destination: Pick<Location, 'latitude' | 'longitude'>): number {
  const radians = Math.PI / 180
  const lat1 = origin.latitude * radians
  const lat2 = destination.latitude * radians
  const deltaLat = lat2 - lat1
  const deltaLon = (destination.longitude - origin.longitude) * radians
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function routePoints(origin: Location, destination: Location): [number, number][] {
  return Array.from({ length: 33 }, (_, index) => {
    const point = positionAlongRoute(origin, destination, index / 32)
    return [point.latitude, point.longitude]
  })
}

function changeWallTime(value: string, part: 'date' | 'time', nextValue: string): string {
  const [date = '', time = '00:00'] = value.split('T')
  return part === 'date' ? `${nextValue}T${time}` : `${date || dateKey(new Date())}T${nextValue}`
}

function shiftWallTime(value: string, minutes: number): string {
  const [datePart = '', timePart = '00:00'] = value.split('T')
  const dateValues = datePart.split('-').map(Number)
  const timeValues = timePart.split(':').map(Number)
  const [year, month, day] = dateValues.length === 3 && dateValues.every(Number.isFinite)
    ? dateValues
    : [new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()]
  const [hour, minute] = timeValues.length >= 2 && timeValues.every(Number.isFinite) ? timeValues : [0, 0]
  const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes))
  const nextDate = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
  const nextTime = `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`
  return `${nextDate}T${nextTime}`
}

function FlightDateTimePicker({ label, timezone, value, onChange, nudgable = false }: { label: string; timezone: string; value: string; onChange: (value: string) => void; nudgable?: boolean }) {
  const [date = '', time = ''] = value.split('T')
  return <div className="flight-datetime-field">
    <div className="flight-field-heading"><span>{label}</span><small>{timezone}</small></div>
    <input className="flight-date-input" type="date" aria-label={`${label} date`} value={date} onChange={(event) => onChange(changeWallTime(value, 'date', event.target.value))} />
    {nudgable ? <div className="time-stepper">
      <input type="time" step="300" aria-label={`${label} time`} value={time} onChange={(event) => onChange(changeWallTime(value, 'time', event.target.value))} />
      <button type="button" aria-label={`${label} five minutes earlier`} onClick={() => onChange(shiftWallTime(value, -5))}><Minus size={13} /></button>
      <button type="button" aria-label={`${label} five minutes later`} onClick={() => onChange(shiftWallTime(value, 5))}><Plus size={13} /></button>
    </div> : <input type="time" aria-label={`${label} time`} value={time} onChange={(event) => onChange(changeWallTime(value, 'time', event.target.value))} />}
  </div>
}

function RouteMapBounds({ origin, destination }: { origin: Location; destination: Location }) {
  const map = useMap()
  useEffect(() => {
    map.fitBounds([[origin.latitude, origin.longitude], [destination.latitude, destination.longitude]], { padding: [28, 28], maxZoom: 5 })
  }, [map, origin.latitude, origin.longitude, destination.latitude, destination.longitude])
  return null
}

function FlightRouteMap({ origin, destination, position, heading, flightNumber, now, timeFormat, status, online }: { origin: Location; destination: Location; position: Location; heading: number; flightNumber: string; now: Date; timeFormat: Preferences['timeFormat']; status: string; online: boolean }) {
  const aircraftIcon = useMemo(() => divIcon({
    className: 'aircraft-marker-wrap',
    html: `<span class="aircraft-marker" style="transform:rotate(${heading}deg)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5 15 10l6 4v2l-6-2v6l2 2v1l-5-1.5L7 23v-1l2-2v-6l-6 2v-2l6-4 3-8.5Z"/></svg></span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  }), [heading])
  const path = useMemo(() => routePoints(origin, destination), [origin, destination])
  return <div className="flight-map-wrap">
    <div className="flight-map-title"><span><MapPinned size={16} /> {en.routeMap}</span><small>{en.estimatedRouteOnly}</small></div>
    <MapContainer key={`${flightNumber}-${origin.latitude}-${destination.latitude}`} center={[position.latitude, position.longitude]} zoom={4} scrollWheelZoom className="flight-route-map">
      {online && <TileLayer attribution={en.mapAttribution} url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />}
      <RouteMapBounds origin={origin} destination={destination} />
      <Polyline positions={path} pathOptions={{ color: '#548267', weight: 3, opacity: 0.8, dashArray: '7 7' }} />
      <CircleMarker center={[origin.latitude, origin.longitude]} radius={6} pathOptions={{ color: '#fff', weight: 2, fillColor: '#527b67', fillOpacity: 1 }} />
      <CircleMarker center={[destination.latitude, destination.longitude]} radius={6} pathOptions={{ color: '#fff', weight: 2, fillColor: '#b28a53', fillOpacity: 1 }} />
      <Marker position={[position.latitude, position.longitude]} icon={aircraftIcon} title={flightNumber}>
        <Tooltip direction="top" offset={[0, -18]}>
          <strong>{flightNumber}</strong><br />
          {status}<br />
          {en.estimatedAircraftTime} {formatTime(now, position, timeFormat)}<br />
          {formatDate(now, position, { month: 'short', day: 'numeric', year: 'numeric' })} · {displayFlightTimezone(position.timezone)}
        </Tooltip>
      </Marker>
    </MapContainer>
    <div className="flight-map-legend"><span><i className="origin-legend" />{origin.name}</span><span><i className="plane-legend">✈</i>{flightNumber}</span><span><i className="destination-legend" />{destination.name}</span></div>
  </div>
}

function createDemoFlightDraft(): FlightDraft {
  const origin: Location = { name: 'Houston (IAH)', country: 'United States', latitude: 29.9902, longitude: -95.3368, timezone: 'America/Chicago' }
  const destination: Location = { name: 'Istanbul (IST)', country: 'Türkiye', latitude: 41.2753, longitude: 28.7519, timezone: 'Europe/Istanbul' }
  return {
    flightNumber: 'TK 6016', origin, destination,
    scheduledDeparture: '2026-11-20T08:40',
    actualDeparture: '2026-11-20T09:20',
    expectedArrival: '2026-11-21T05:15',
    timeDisplay: 'local',
  }
}

const demoFlightDraft = createDemoFlightDraft()

function MapClickPicker({ onPick }: { onPick: (latitude: number, longitude: number) => void }) {
  useMapEvents({ click: (event) => onPick(event.latlng.lat, event.latlng.lng) })
  return null
}

function AirportPicker({ label, location, onSelect }: { label: string; location: Location | null; onSelect: (location: Location | null) => void }) {
  const [query, setQuery] = useState(location ? locationDisplay(location) : '')
  const [results, setResults] = useState<CityResult[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const searchText = query.trim()
  const visibleResults = searchText.length >= 2 && !(location && searchText === locationDisplay(location)) ? results : []

  useEffect(() => {
    const search = searchText
    if (search.length < 2 || (location && search === locationDisplay(location))) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setBusy(true)
      setError(false)
      try {
        const params = new URLSearchParams({ name: search, count: '5', language: 'en', format: 'json' })
        const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Search failed')
        const data = await response.json() as { results?: Array<{ id: number; name: string; latitude: number; longitude: number; timezone?: string; country?: string; admin1?: string }> }
        setResults((data.results ?? []).filter((item) => item.timezone).map((item) => ({
          id: item.id, name: item.name, latitude: item.latitude, longitude: item.longitude,
          timezone: item.timezone as string, country: item.country, admin1: item.admin1,
        })))
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(true)
      } finally {
        setBusy(false)
      }
    }, 350)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [searchText, location])

  return <div className="airport-picker">
    <label>{label}</label>
    <div className="airport-input-wrap"><MapPin size={14} /><input value={query} onChange={(event) => { setQuery(event.target.value); onSelect(null) }} placeholder={en.searchAirportCity} autoComplete="off" />{busy && <span className="search-spinner" />}</div>
    {visibleResults.length > 0 && <div className="airport-results">{visibleResults.map((result) => <button key={result.id} type="button" onClick={() => { onSelect(result); setQuery(locationDisplay(result)); setResults([]) }}><strong>{result.name}</strong><small>{[result.admin1, result.country].filter(Boolean).join(', ')}</small></button>)}</div>}
    {error && <small className="airport-error">{en.airportSearchError}</small>}
    {!busy && query.trim().length >= 2 && results.length === 0 && !error && !location && <small className="airport-hint">{en.airportNoResults}</small>}
    {location && <small className="airport-zone">{location.timezone}</small>}
  </div>
}

function App() {
  const [location, setLocation] = useState<Location>(() => readStored('salah-location', defaultLocation))
  const [preferences, setPreferences] = useState<Preferences>(() => readStored('salah-preferences', defaultPreferences))
  const [selectedDate, setSelectedDate] = useState(() => dateInTimezone(new Date(), location.timezone))
  const [now, setNow] = useState(() => new Date())
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<CityResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [locationMessage, setLocationMessage] = useState('')
  const [locating, setLocating] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualLat, setManualLat] = useState(String(location.latitude))
  const [manualLon, setManualLon] = useState(String(location.longitude))
  const [manualTimezone, setManualTimezone] = useState(location.timezone)
  const [manualName, setManualName] = useState(location.name)
  const [manualInvalid, setManualInvalid] = useState(false)
  const [manualMapOpen, setManualMapOpen] = useState(false)
  const [mapTimezonePending, setMapTimezonePending] = useState(false)
  const [mapTimezoneFailed, setMapTimezoneFailed] = useState(false)
  const mapTimezoneRequest = useRef(0)
  const [flightDraft, setFlightDraft] = useState<FlightDraft>(() => readStored('salah-flight-draft-v2', demoFlightDraft))
  const [activeFlight, setActiveFlight] = useState<FlightPlan | null>(() => {
    try {
      const saved = localStorage.getItem('salah-flight-v2')
      return saved ? JSON.parse(saved) as FlightPlan : null
    } catch { return null }
  })
  const [offlineReady, setOfflineReady] = useState(hasOfflineFlight)
  const [offlineSaveStatus, setOfflineSaveStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const [online, setOnline] = useState(() => navigator.onLine)
  const [viewMode, setViewMode] = useState<'local' | 'flight'>(() => activeFlight && offlineReady ? 'flight' : 'local')
  const [flightInvalid, setFlightInvalid] = useState(false)
  const [flightLookupBusy, setFlightLookupBusy] = useState(false)
  const [flightLookupError, setFlightLookupError] = useState('')
  const [flightLookupMessage, setFlightLookupMessage] = useState('')
  const [flightProviderStatus, setFlightProviderStatus] = useState('')
  const [flightStatusOpen, setFlightStatusOpen] = useState(false)
  const [flightStatusRecord, setFlightStatusRecord] = useState<FlightApiRecord | null>(null)
  const [deviceCompassStatus, setDeviceCompassStatus] = useState<'idle' | 'requesting' | 'active' | 'denied' | 'unsupported' | 'no-sensor'>('idle')
  const [deviceHeading, setDeviceHeading] = useState<number | null>(null)
  const [estimatedFlightTimezone, setEstimatedFlightTimezone] = useState<{ key: string; timezone: string } | null>(null)

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('salah-location', JSON.stringify(location))
  }, [location])

  useEffect(() => {
    localStorage.setItem('salah-preferences', JSON.stringify(preferences))
  }, [preferences])

  useEffect(() => {
    localStorage.setItem('salah-flight-draft-v2', JSON.stringify(flightDraft))
  }, [flightDraft])

  useEffect(() => {
    if (activeFlight) localStorage.setItem('salah-flight-v2', JSON.stringify(activeFlight))
    else localStorage.removeItem('salah-flight-v2')
  }, [activeFlight])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setSearchError('')
      try {
        const params = new URLSearchParams({ name: trimmed, count: '6', language: 'en', format: 'json' })
        const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Search unavailable')
        const data = await response.json() as { results?: Array<{ id: number; name: string; latitude: number; longitude: number; timezone?: string; country?: string; admin1?: string }> }
        setSuggestions((data.results ?? []).filter((item) => item.timezone).map((item) => ({
          id: item.id, name: item.name, latitude: item.latitude, longitude: item.longitude,
          timezone: item.timezone as string, country: item.country, admin1: item.admin1,
        })))
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setSearchError(en.geocodingError)
          setSuggestions([])
        }
      } finally {
        setSearching(false)
      }
    }, 350)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!flightStatusOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFlightStatusOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [flightStatusOpen])

  useEffect(() => {
    if (deviceCompassStatus !== 'requesting' && deviceCompassStatus !== 'active') return
    const handleOrientation = (event: Event) => {
      const orientation = event as DeviceOrientationEvent & { webkitCompassHeading?: number }
      const heading = Number.isFinite(orientation.webkitCompassHeading)
        ? orientation.webkitCompassHeading
        : orientation.absolute && orientation.alpha !== null
          ? (360 - orientation.alpha) % 360
          : null
      if (heading !== null && heading !== undefined) {
        setDeviceHeading(heading)
        setDeviceCompassStatus('active')
      }
    }
    window.addEventListener('deviceorientation', handleOrientation)
    window.addEventListener('deviceorientationabsolute', handleOrientation)
    const timer = window.setTimeout(() => setDeviceCompassStatus((current) => current === 'requesting' ? 'no-sensor' : current), 5000)
    return () => {
      window.removeEventListener('deviceorientation', handleOrientation)
      window.removeEventListener('deviceorientationabsolute', handleOrientation)
      window.clearTimeout(timer)
    }
  }, [deviceCompassStatus])

  const flightMinute = Math.floor(now.getTime() / 60000)
  const routePlan = activeFlight ?? (viewMode === 'flight' && flightDraft.origin && flightDraft.destination ? flightDraft as FlightPlan : null)
  const flightState = useMemo(() => {
    if (!routePlan) return null
    const departure = wallTimeToInstant(routePlan.actualDeparture || routePlan.scheduledDeparture, routePlan.origin.timezone)
    const arrival = wallTimeToInstant(routePlan.expectedArrival, routePlan.destination.timezone)
    if (!departure || !arrival || arrival <= departure) return null
    const estimatedNow = new Date(flightMinute * 60000)
    const atOrigin = estimatedNow < departure || Boolean(routePlan.holdAtOrigin && !routePlan.actualDeparture)
    const atDestination = !atOrigin && estimatedNow >= arrival
    const progress = atOrigin ? 0 : Math.min(1, (estimatedNow.getTime() - departure.getTime()) / (arrival.getTime() - departure.getTime()))
    const point = atOrigin ? routePlan.origin : atDestination ? routePlan.destination : positionAlongRoute(routePlan.origin, routePlan.destination, progress)
    const timezone = atDestination ? routePlan.destination.timezone : atOrigin ? routePlan.origin.timezone : approximateFlightTimezone(point.longitude)
    const label = `${routePlan.flightNumber} · ${Math.round(progress * 100)}%`
    const distanceKm = routeDistanceKm(routePlan.origin, routePlan.destination)
    const durationHours = (arrival.getTime() - departure.getTime()) / 3_600_000
    const position = { latitude: point.latitude, longitude: point.longitude }
    return {
      location: { name: label, country: 'Flight route', latitude: point.latitude, longitude: point.longitude, timezone } satisfies Location,
      progress: Math.round(progress * 100), atOrigin, atDestination,
      departure, arrival, position,
      heading: routeBearing(position, routePlan.destination),
      distanceKm,
      speedKmh: atOrigin || atDestination ? 0 : distanceKm / durationHours,
    }
  }, [routePlan, flightMinute])

  const flightTimezoneBucket = flightState && !flightState.atOrigin && !flightState.atDestination
    ? Math.floor(flightState.progress / 5)
    : null
  const flightTimezoneKey = routePlan && flightTimezoneBucket !== null
    ? `${routePlan.flightNumber}:${routePlan.origin.latitude}:${routePlan.origin.longitude}:${routePlan.destination.latitude}:${routePlan.destination.longitude}:${flightTimezoneBucket}`
    : ''
  const flightTimezoneLookupPoint = routePlan && flightTimezoneBucket !== null
    ? positionAlongRoute(routePlan.origin, routePlan.destination, Math.min(1, (flightTimezoneBucket * 5 + 2.5) / 100))
    : null

  const flightTimezoneLatitude = flightTimezoneLookupPoint?.latitude
  const flightTimezoneLongitude = flightTimezoneLookupPoint?.longitude
  useEffect(() => {
    if (!online || viewMode !== 'flight' || !flightTimezoneKey || flightTimezoneLatitude === undefined || flightTimezoneLongitude === undefined) return
    let cancelled = false
    getTimezoneForCoordinates(flightTimezoneLatitude, flightTimezoneLongitude)
      .then((timezone) => {
        if (!cancelled) setEstimatedFlightTimezone({ key: flightTimezoneKey, timezone })
      })
      .catch(() => { /* The route longitude provides an offline time zone estimate. */ })
    return () => { cancelled = true }
  }, [online, viewMode, flightTimezoneKey, flightTimezoneLatitude, flightTimezoneLongitude])

  const activeLocation = useMemo(() => {
    if (viewMode !== 'flight' || !flightState || !routePlan) return location
    const timezone = online && estimatedFlightTimezone?.key === flightTimezoneKey
      ? estimatedFlightTimezone.timezone
      : flightState.location.timezone
    return { ...flightState.location, timezone }
  }, [viewMode, flightState, routePlan, location, online, estimatedFlightTimezone, flightTimezoneKey])

  const selectedKey = dateKey(selectedDate)
  const todayKey = dateKey(dateInTimezone(now, activeLocation.timezone))
  const todayDate = makeSearchDate(todayKey)
  const previousTodayKey = useRef(todayKey)
  useEffect(() => {
    if (selectedKey === previousTodayKey.current && previousTodayKey.current !== todayKey) setSelectedDate(makeSearchDate(todayKey))
    previousTodayKey.current = todayKey
  }, [todayKey, selectedKey])
  const displayedTimes = useMemo(() => {
    try {
      return calculatePrayerTimes(activeLocation, selectedDate, preferences)
    } catch {
      return null
    }
  }, [activeLocation, selectedDate, preferences])
  const todayTimes = useMemo(() => {
    try {
      return calculatePrayerTimes(activeLocation, makeSearchDate(todayKey), preferences)
    } catch {
      return null
    }
  }, [activeLocation, todayKey, preferences])

  const nextPrayer = useMemo(() => {
    if (!todayTimes) return null
    const obligatory = prayerRows.filter((prayer) => prayer.obligatory)
    const upcoming = obligatory.find((prayer) => todayTimes[prayer.key] > now)
    if (upcoming) return { ...upcoming, time: todayTimes[upcoming.key] }
    try {
      const tomorrow = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() + 1, 12)
      const tomorrowTimes = calculatePrayerTimes(activeLocation, tomorrow, preferences)
      return tomorrowTimes ? { ...prayerRows[0], time: tomorrowTimes.fajr } : null
    } catch {
      return null
    }
  }, [todayTimes, todayDate, now, activeLocation, preferences])

  const countdown = useMemo(() => {
    if (!nextPrayer) return null
    const seconds = Math.max(0, Math.floor((nextPrayer.time.getTime() - now.getTime()) / 1000))
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const remainingSeconds = seconds % 60
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
  }, [nextPrayer, now])

  const qiblaBearing = useMemo(() => {
    return calculateQiblaBearing(activeLocation)
  }, [activeLocation])

  const hijriDate = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
        timeZone: activeLocation.timezone,
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(wallTimeToInstant(`${dateKey(selectedDate)}T12:00`, activeLocation.timezone) ?? selectedDate)
    } catch {
      return '—'
    }
  }, [activeLocation.timezone, selectedDate])

  function updatePreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences((current) => ({ ...current, [key]: value }))
  }

  function flightTimeZone(field: FlightTimeField, draft: FlightDraft): string {
    if (field === 'expectedArrival') return draft.destination?.timezone ?? draft.origin?.timezone ?? 'UTC'
    return draft.origin?.timezone ?? draft.destination?.timezone ?? 'UTC'
  }

  function displayedFlightTime(field: FlightTimeField): string {
    return flightDraft[field] ?? ''
  }

  function updateFlightTime(field: FlightTimeField, shownValue: string) {
    setFlightDraft((current) => ({ ...current, [field]: shownValue }))
    setFlightLookupError('')
    setFlightLookupMessage('')
  }

  function selectViewMode(mode: 'local' | 'flight') {
    setViewMode(mode)
    const timezone = mode === 'flight' && activeFlight ? activeFlight.origin.timezone : location.timezone
    setSelectedDate(dateInTimezone(new Date(), timezone))
  }
  async function toggleDeviceCompass() {
    if (deviceCompassStatus === 'active' || deviceCompassStatus === 'requesting') {
      setDeviceCompassStatus('idle')
      setDeviceHeading(null)
      return
    }
    if (typeof DeviceOrientationEvent === 'undefined') {
      setDeviceCompassStatus('unsupported')
      return
    }
    setDeviceCompassStatus('requesting')
    const orientationApi = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>
    }
    if (orientationApi.requestPermission) {
      try {
        const permission = await orientationApi.requestPermission()
        if (permission !== 'granted') {
          setDeviceCompassStatus('denied')
          return
        }
      } catch {
        setDeviceCompassStatus('denied')
        return
      }
    }
  }
  const compassRelativeBearing = (qiblaBearing - (deviceHeading ?? 0) + 360) % 360
  const compassBearingRadians = compassRelativeBearing * Math.PI / 180
  const meccaMarkerPosition = {
    left: `${50 + 39 * Math.sin(compassBearingRadians)}%`,
    top: `${50 - 39 * Math.cos(compassBearingRadians)}%`,
  }

  function chooseCity(city: CityResult) {
    const nextLocation = { name: city.name, country: city.country, latitude: city.latitude, longitude: city.longitude, timezone: city.timezone }
    setLocation(nextLocation)
    setSelectedDate(dateInTimezone(new Date(), nextLocation.timezone))
    setQuery('')
    setSuggestions([])
    setSearchError('')
    setLocationMessage('')
  }

  async function getTimezoneForCoordinates(latitude: number, longitude: number): Promise<string> {
    const params = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), current: 'temperature_2m', timezone: 'auto' })
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`)
    if (!response.ok) throw new Error('Could not resolve timezone')
    const data = await response.json() as { timezone?: string }
    if (!data.timezone || !timezoneIsValid(data.timezone)) throw new Error('Timezone unavailable')
    return data.timezone
  }

  async function pickManualMapPoint(latitude: number, longitude: number) {
    setManualLat(latitude.toFixed(5))
    setManualLon(longitude.toFixed(5))
    setManualName(en.mapSelectionName)
    setMapTimezoneFailed(false)
    setMapTimezonePending(true)
    const requestId = ++mapTimezoneRequest.current
    try {
      const timezone = await getTimezoneForCoordinates(latitude, longitude)
      if (requestId === mapTimezoneRequest.current) setManualTimezone(timezone)
    } catch {
      if (requestId === mapTimezoneRequest.current) setMapTimezoneFailed(true)
    } finally {
      if (requestId === mapTimezoneRequest.current) setMapTimezonePending(false)
    }
  }

  function useMyLocation() {
    setLocationMessage('')
    if (!navigator.geolocation) {
      setLocationMessage(en.locationError)
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        const timezone = await getTimezoneForCoordinates(coords.latitude, coords.longitude)
        const nextLocation = { name: en.myLocation, latitude: coords.latitude, longitude: coords.longitude, timezone }
        setLocation(nextLocation)
        setSelectedDate(dateInTimezone(new Date(), timezone))
      } catch {
        setLocationMessage(en.locationUnavailable)
        setManualLat(coords.latitude.toFixed(5))
        setManualLon(coords.longitude.toFixed(5))
        setManualName(en.myLocation)
        setManualOpen(true)
      } finally {
        setLocating(false)
      }
    }, () => {
      setLocationMessage(en.locationError)
      setLocating(false)
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 })
  }

  function applyManualLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const latitude = Number(manualLat)
    const longitude = Number(manualLon)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !timezoneIsValid(manualTimezone.trim())) {
      setManualInvalid(true)
      return
    }
    setManualInvalid(false)
    const nextLocation = { name: manualName.trim() || en.manualLocationName, latitude, longitude, timezone: manualTimezone.trim() }
    setLocation(nextLocation)
    setSelectedDate(dateInTimezone(new Date(), nextLocation.timezone))
    setManualOpen(false)
    setLocationMessage('')
  }

  function changeDay(delta: number) {
    setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + delta, 12))
  }

  async function lookupFlight() {
    setFlightLookupError('')
    setFlightLookupMessage('')
    setFlightProviderStatus('')
    setFlightStatusRecord(null)
    setFlightStatusOpen(true)
    const flightDate = flightDraft.scheduledDeparture.split('T')[0]
    if (!flightDraft.flightNumber.trim() || !flightDate) {
      setFlightLookupError(en.flightLookupInvalid)
      return
    }
    setFlightLookupBusy(true)
    try {
      const params = new URLSearchParams({ flightNumber: flightDraft.flightNumber, flightDate })
      const response = await fetch(`/api/flight-status?${params}`)
      const payload = await response.json() as { data?: FlightApiRecord[]; error?: { code?: string; message?: string } }
      if (payload.error?.code === 'missing_api_key') {
        setFlightLookupError(en.flightLookupMissingKey)
        return
      }
      if (response.status === 429) {
        setFlightLookupError(en.flightLookupLimit)
        return
      }
      if (!response.ok) {
        setFlightLookupError(payload.error?.message ? `${en.flightLookupError} ${payload.error.message}` : en.flightLookupError)
        return
      }
      const normalizedNumber = flightDraft.flightNumber.replace(/\s+/g, '').toUpperCase()
      const records = payload.data ?? []
      const record = records.find((item) => {
        const iataNumber = item.flight?.iata?.replace(/\s+/g, '').toUpperCase()
        const composedNumber = `${item.airline?.iata ?? ''}${item.flight?.number ?? ''}`.toUpperCase()
        const dateMatches = !item.flight_date || item.flight_date === flightDate
        return dateMatches && (iataNumber === normalizedNumber || composedNumber === normalizedNumber)
      })
      if (!record?.departure || !record.arrival) {
        setFlightLookupError(en.flightLookupNoResults)
        return
      }

      const [origin, destination] = await Promise.all([
        findAirportLocation(record.departure.iata, record.departure.airport, record.departure.timezone),
        findAirportLocation(record.arrival.iata, record.arrival.airport, record.arrival.timezone),
      ])
      const scheduledDeparture = dateTimeInputValue(record.departure.scheduled, origin?.timezone ?? record.departure.timezone ?? '')
      const actualDeparture = record.departure.actual
        ? dateTimeInputValue(record.departure.actual, origin?.timezone ?? record.departure.timezone ?? '')
        : ''
      const arrivalTimestamp = record.arrival.actual ?? record.arrival.estimated ?? record.arrival.scheduled
      const expectedArrival = dateTimeInputValue(arrivalTimestamp, destination?.timezone ?? record.arrival.timezone ?? '')

      setFlightDraft((current) => ({
        ...current,
        flightNumber: record.flight?.iata ?? current.flightNumber,
        origin,
        destination,
        scheduledDeparture: scheduledDeparture || current.scheduledDeparture,
        actualDeparture,
        expectedArrival: expectedArrival || current.expectedArrival,
      }))
      setFlightStatusRecord(record)
      setFlightProviderStatus(record.flight_status || '')
      if (!origin || !destination) {
        setFlightLookupError(en.flightLookupAirportError)
      } else {
        setFlightLookupMessage(en.flightLookupReady)
      }
    } catch {
      setFlightLookupError(en.flightLookupError)
    } finally {
      setFlightLookupBusy(false)
    }
  }

  function activateFlightPlan(): boolean {
    if (!flightDraft.flightNumber.trim() || !flightDraft.origin || !flightDraft.destination) {
      setFlightInvalid(true)
      return false
    }
    const departureValue = flightDraft.actualDeparture || flightDraft.scheduledDeparture
    const departure = wallTimeToInstant(departureValue, flightDraft.origin.timezone)
    const arrival = wallTimeToInstant(flightDraft.expectedArrival, flightDraft.destination.timezone)
    if (!departure || !arrival || arrival <= departure) {
      setFlightInvalid(true)
      return false
    }
    const flight = flightDraft as FlightPlan
    setActiveFlight(flight)
    setViewMode('flight')
    setFlightInvalid(false)
    setSelectedDate(dateInTimezone(new Date(), flight.origin.timezone))
    return true
  }

  function applyFlightPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    activateFlightPlan()
  }

  async function saveFlightOffline() {
    if (!activateFlightPlan()) return
    setOfflineSaveStatus('saving')
    try {
      await cacheFlightApp()
      localStorage.setItem(offlineFlightKey, 'ready')
      setOfflineReady(true)
      setOfflineSaveStatus('idle')
    } catch {
      setOfflineSaveStatus('error')
    }
  }

  function removeFlightPlan() {
    localStorage.removeItem(offlineFlightKey)
    setOfflineReady(false)
    setOfflineSaveStatus('idle')
    setActiveFlight(null)
    setViewMode('local')
    setSelectedDate(dateInTimezone(new Date(), location.timezone))
  }

  const showingFlightEstimate = viewMode === 'flight' && Boolean(flightState)
  const canSaveOffline = import.meta.env.PROD && 'serviceWorker' in navigator && 'caches' in window
  const isViewingToday = selectedKey === todayKey
  const mapLatitude = manualLat.trim() && Number.isFinite(Number(manualLat)) ? Number(manualLat) : defaultLocation.latitude
  const mapLongitude = manualLon.trim() && Number.isFinite(Number(manualLon)) ? Number(manualLon) : defaultLocation.longitude

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label={en.brandHomeLabel}>
          <span className="brand-mark"><span /></span>
          <span><strong>{en.brand}</strong><small>{en.brandDescriptor}</small></span>
        </a>
        <div className="topbar-right">
          <span className="date-chip"><CalendarDays size={15} />{formatDate(now, activeLocation, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
          <span className="live-dot" aria-label={en.liveLocalTime} />
          <span className="live-label">{formatTime(now, activeLocation, preferences.timeFormat)}</span>
        </div>
      </header>

      <main id="top" className="page-content">
        <section className="welcome-row">
          <div>
            <p className="eyebrow">{en.resetEyebrow}</p>
            <h1>{en.welcomeHeadingStart} <em>{en.welcomeHeadingEmphasis}</em></h1>
            <p className="welcome-copy">{en.welcomeCopy}</p>
          </div>
          <div className="location-control">
            <div className="location-label"><MapPin size={14} /> {en.yourLocation}</div>
            <div className="location-name">{viewMode === 'flight' && flightState ? locationDisplay(activeLocation) : locationDisplay(location)}</div>
            <div className="location-zone">{displayFlightTimezone(activeLocation.timezone).replaceAll('_', ' ')}</div>
          </div>
        </section>

        <nav className="mode-switch" aria-label={en.modeSelection}>
          <button type="button" className={viewMode === 'local' ? 'selected' : ''} onClick={() => selectViewMode('local')}><MapPinned size={16} />{en.localLocationMode}</button>
          <button type="button" className={viewMode === 'flight' ? 'selected' : ''} onClick={() => selectViewMode('flight')}><Plane size={16} />{en.flightMode}</button>
        </nav>

        {viewMode === 'local' && <section className="location-tools" aria-label={en.locationControls}>
          <div className="search-wrap">
            <Search size={17} />
            <input value={query} onChange={(event) => { const value = event.target.value; setQuery(value); if (value.trim().length < 2) { setSuggestions([]); setSearching(false); setSearchError('') } else { setSearching(true); setSearchError('') } }} onFocus={() => setSearchError('')} placeholder={en.searchCity} aria-label={en.searchCity} />
            {searching && <span className="search-spinner" aria-label={en.searching} />}
            {suggestions.length > 0 && <div className="suggestions" role="listbox">
              {suggestions.map((city) => <button key={city.id} type="button" className="suggestion" onClick={() => chooseCity(city)}>
                <MapPin size={16} /><span><strong>{city.name}</strong><small>{[city.admin1, city.country].filter(Boolean).join(', ')}</small></span><span className="suggestion-zone">{city.timezone.split('/').pop()?.replaceAll('_', ' ')}</span>
              </button>)}
            </div>}
            {!!query.trim() && query.trim().length >= 2 && suggestions.length === 0 && !searching && !searchError && <div className="search-empty">{en.noResults}</div>}
            {searchError && <div className="search-empty error-text">{searchError}</div>}
          </div>
          <button className="secondary-button gps-button" type="button" onClick={useMyLocation} disabled={locating}>
            <LocateFixed size={16} />{locating ? en.findingLocation : en.useLocation}
          </button>
          <button className="text-button manual-toggle" type="button" onClick={() => { if (!manualOpen) { setManualLat(String(location.latitude)); setManualLon(String(location.longitude)); setManualTimezone(location.timezone); setManualName(location.name) } setManualOpen((open) => !open) }}>
            {manualOpen ? en.closeManualEntry : en.manualLocation}<ChevronDown size={15} className={manualOpen ? 'rotate-icon' : ''} />
          </button>
          {locationMessage && <p className="location-message" role="status">{locationMessage}</p>}
          {manualOpen && <div className="manual-location-area">
            <button className="map-toggle" type="button" onClick={() => setManualMapOpen((open) => !open)}><MapPin size={15} />{manualMapOpen ? en.closeMap : en.chooseOnMap}<ChevronDown size={14} className={manualMapOpen ? 'rotate-icon' : ''} /></button>
            {manualMapOpen && <div className="map-picker">
              <p>{en.mapInstructions}</p>
              <MapContainer center={[mapLatitude, mapLongitude]} zoom={4} scrollWheelZoom className="map-canvas">
                <TileLayer attribution={en.mapAttribution} url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
                <MapClickPicker onPick={pickManualMapPoint} />
                <CircleMarker center={[mapLatitude, mapLongitude]} radius={8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#367453', fillOpacity: 1 }} />
              </MapContainer>
              {mapTimezonePending && <span className="map-status">{en.resolvingMapTimezone}</span>}
              {mapTimezoneFailed && <span className="map-status error-text">{en.mapTimezoneFailure}</span>}
            </div>}
            <form className="manual-form" onSubmit={applyManualLocation}>
              <label>{en.locationNameLabel}<input value={manualName} onChange={(event) => setManualName(event.target.value)} placeholder={en.searchHint} /></label>
              <label>{en.latitude}<input type="number" min="-90" max="90" step="any" value={manualLat} onChange={(event) => setManualLat(event.target.value)} /></label>
              <label>{en.longitude}<input type="number" min="-180" max="180" step="any" value={manualLon} onChange={(event) => setManualLon(event.target.value)} /></label>
              <label className="timezone-field">{en.timezone}<input value={manualTimezone} onChange={(event) => setManualTimezone(event.target.value)} placeholder={en.timezoneHint} /></label>
              <button type="submit" className="primary-button">{en.applyLocation}<ChevronRight size={15} /></button>
              {manualInvalid && <span className="error-text manual-error">{en.invalidLocation}</span>}
            </form>
          </div>}
        </section>}

        {viewMode === 'flight' && <>
          <section className={`flight-panel ${flightState ? 'flight-panel-active' : ''}`}>
            <div className="flight-panel-heading"><span className="flight-summary-icon"><Plane size={17} /></span><span className="flight-summary-copy"><strong>{en.flightPlanning}</strong><small>{en.flightPlanningSubtitle}</small></span>{flightState && <span className="flight-active-badge"><span /> {en.flightRouteActive}</span>}</div>
            <div className="flight-content">
              <p className="flight-data-note">{en.flightDataNote} <a href="https://aviationstack.com/signup/free" target="_blank" rel="noreferrer">{en.getFreeApiKey}</a></p>
              <form className="flight-form" onSubmit={applyFlightPlan}>
                <div className="flight-top-fields">
                  <label className="flight-number-field">{en.flightNumber}<input value={flightDraft.flightNumber} onChange={(event) => { setFlightDraft((current) => ({ ...current, flightNumber: event.target.value })); setFlightLookupError(''); setFlightLookupMessage('') }} placeholder={en.flightNumberPlaceholder} /><small className="flight-lookup-notice">{import.meta.env.DEV ? en.flightLookupNotice : en.manualFlightNotice}</small>{import.meta.env.DEV && <button className="flight-lookup-button" type="button" onClick={lookupFlight} disabled={flightLookupBusy}>{flightLookupBusy ? <span className="search-spinner" /> : <Search size={14} />}{flightLookupBusy ? en.lookingUpFlight : en.lookupFlight}</button>}</label>
                </div>
                <div className="flight-airports">
                  <AirportPicker key={`origin-${flightDraft.origin?.name ?? 'empty'}`} label={en.origin} location={flightDraft.origin} onSelect={(value) => setFlightDraft((current) => ({ ...current, origin: value }))} />
                  <span className="flight-route-arrow"><ChevronRight size={17} /></span>
                  <AirportPicker key={`destination-${flightDraft.destination?.name ?? 'empty'}`} label={en.destination} location={flightDraft.destination} onSelect={(value) => setFlightDraft((current) => ({ ...current, destination: value }))} />
                </div>
                <div className="flight-times">
                  <FlightDateTimePicker label={`${en.scheduledDeparture} · ${en.originTime}`} timezone={flightTimeZone('scheduledDeparture', flightDraft)} value={displayedFlightTime('scheduledDeparture')} onChange={(value) => updateFlightTime('scheduledDeparture', value)} />
                  <fieldset className="actual-departure-field">
                    <legend>{en.actualDeparture}</legend>
                    <label className="actual-toggle">
                      <input type="checkbox" checked={Boolean(flightDraft.actualDeparture)} onChange={(event) => setFlightDraft((current) => ({ ...current, actualDeparture: event.target.checked ? current.scheduledDeparture : '' }))} />
                      <span>{en.useActualDeparture}</span>
                    </label>
                    {flightDraft.actualDeparture && <div className="date-time-pair">
                      <FlightDateTimePicker label={`${en.actualDeparture} · ${en.originTime}`} timezone={flightTimeZone('actualDeparture', flightDraft)} value={displayedFlightTime('actualDeparture')} onChange={(value) => updateFlightTime('actualDeparture', value)} nudgable />
                    </div>}
                    {!flightDraft.actualDeparture && <label className="actual-toggle">
                      <input type="checkbox" checked={Boolean(flightDraft.holdAtOrigin)} onChange={(event) => setFlightDraft((current) => ({ ...current, holdAtOrigin: event.target.checked }))} />
                      <span>{en.holdFlightAtOrigin}</span>
                    </label>}
                    {import.meta.env.DEV && <button className="flight-status-link" type="button" onClick={lookupFlight} disabled={flightLookupBusy}><Search size={13} />{en.actualDepartureLookup}</button>}
                  </fieldset>
                  <FlightDateTimePicker label={`${en.expectedArrival} · ${en.destinationTime}`} timezone={flightTimeZone('expectedArrival', flightDraft)} value={displayedFlightTime('expectedArrival')} onChange={(value) => updateFlightTime('expectedArrival', value)} />
                </div>
                {flightLookupError && <p className="flight-lookup-feedback flight-lookup-error" role="alert">{flightLookupError}</p>}
                {flightLookupMessage && <p className="flight-lookup-feedback flight-lookup-success" role="status">{flightLookupMessage}{flightProviderStatus && <strong>{en.flightProviderStatus.replace('{status}', flightProviderStatus)}</strong>}</p>}
                <div className="flight-form-actions"><button className="primary-button" type="submit"><Plane size={14} /> {en.saveFlightPlan}</button>{canSaveOffline && <button type="button" className="secondary-button" onClick={saveFlightOffline} disabled={!online || offlineSaveStatus === 'saving'}>{offlineSaveStatus === 'saving' ? en.savingFlightOffline : en.saveFlightOffline}</button>}{flightInvalid && <span className="flight-validation">{en.flightValidation}</span>}</div>
              </form>
              {offlineSaveStatus === 'error' && <p className="flight-lookup-feedback flight-lookup-error" role="alert">{en.offlineFlightError}</p>}
              {offlineReady && activeFlight && <p className="flight-lookup-feedback flight-lookup-success" role="status">{online ? en.offlineFlightReady : en.offlineFlightInUse}</p>}
              {flightState && activeFlight && <div className="flight-route-status">
                <div className="route-status-head"><strong>{activeFlight.flightNumber}</strong><span>{locationDisplay(activeFlight.origin)} <ChevronRight size={13} /> {locationDisplay(activeFlight.destination)}</span><button type="button" className="flight-clear" onClick={removeFlightPlan} disabled={offlineSaveStatus === 'saving'}>{en.removeFlight}</button></div>
                <div className="route-progress"><span style={{ width: `${flightState.progress}%` }} /></div>
                <div className="route-status-foot"><span>{flightState.atOrigin ? en.flightAtOrigin : flightState.atDestination ? en.flightAtDestination : en.flightAlongRoute}</span><strong>{en.flightProgress.replace('{flight}', activeFlight.flightNumber).replace('{progress}', String(flightState.progress))}</strong></div>
              </div>}
            </div>
          </section>
          {routePlan && flightState && <section className="flight-map-dashboard">
            <FlightRouteMap origin={routePlan.origin} destination={routePlan.destination} position={activeLocation} heading={flightState.heading} flightNumber={routePlan.flightNumber} online={online} now={now} timeFormat={preferences.timeFormat} status={flightState.atOrigin ? en.aircraftAtOrigin : flightState.atDestination ? en.flightAtDestination : en.flightAlongRoute} />
            <div className="flight-metrics">
              <article><span className="metric-icon"><MoveUpRight size={16} /></span><small>{en.heading}</small><strong>{Math.round(flightState.heading)}°</strong><span>{en.trueHeading}</span></article>
              <article><span className="metric-icon"><Gauge size={16} /></span><small>{en.estimatedSpeed}</small><strong>{Math.round(flightState.speedKmh)} <i>km/h</i></strong><span>{Math.round(flightState.speedKmh / 1.852)} {en.knots}</span></article>
              <article><span className="metric-icon"><Route size={16} /></span><small>{en.routeProgress}</small><strong>{flightState.progress}%</strong><span>{Math.round(flightState.distanceKm).toLocaleString()} {en.kilometers}</span></article>
            </div>
            {flightState.atOrigin && <p className="flight-not-started"><Clock3 size={14} /> {en.flightAtOrigin}</p>}
          </section>}
        </>}

        <section className="hero-grid">
          <article className="next-card">
            <div className="next-card-top"><span className="next-badge"><span /> {(showingFlightEstimate ? en.estimatedNextPrayer : en.nextPrayer).toUpperCase()}</span><Clock3 size={18} className="next-clock-icon" /></div>
            {nextPrayer && countdown ? <>
              <p className="next-intro">{nextPrayer.label} {en.beginsIn}</p>
              <div className="countdown" aria-live="off">{countdown.split(':').map((part, index) => <span className="countdown-part" key={`${part}-${index}`}><strong>{part}</strong>{index < 2 && <i>:</i>}</span>)}</div>
              <div className="next-meta"><span>{formatTime(nextPrayer.time, activeLocation, preferences.timeFormat)}</span><span className="meta-divider" />{isViewingToday ? en.upNextToday : en.upNextForLocation.replace('{location}', activeLocation.name)}</div>
            </> : <div className="no-times-inline">{en.invalidTimes}</div>}
            <div className="card-orbit orbit-one" /><div className="card-orbit orbit-two" />
            <div className="hero-prayer-mark"><span className="mark-sun" /><span className="mark-horizon" /></div>
          </article>

          <article className="date-card">
            <div className="section-kicker"><CalendarDays size={16} /> {en.date.toUpperCase()}</div>
            <div className="date-navigation">
              <button type="button" className="icon-button" onClick={() => changeDay(-1)} aria-label={en.previousDay}><ChevronLeft size={18} /></button>
              <div className="date-current">
                <strong>{isViewingToday ? en.today : formatScheduleDate(selectedDate, activeLocation, { weekday: 'long' })}</strong>
                <span>{formatScheduleDate(selectedDate, activeLocation, { month: 'long', day: 'numeric', year: 'numeric' })}</span>
              </div>
              <button type="button" className="icon-button" onClick={() => changeDay(1)} aria-label={en.nextDay}><ChevronRight size={18} /></button>
            </div>
            <div className="date-picker-row"><label htmlFor="schedule-date">{en.jumpToDate}</label><input id="schedule-date" type="date" value={selectedKey} onChange={(event) => event.target.value && setSelectedDate(makeSearchDate(event.target.value))} /></div>
            {!isViewingToday && <button className="today-button" type="button" onClick={() => setSelectedDate(todayDate)}>{en.returnToToday} <ChevronRight size={14} /></button>}
            <div className="hijri-block"><div className="hijri-icon"><Moon size={18} /></div><div><span>{en.islamicDate}</span><strong>{hijriDate}</strong><small>{en.hijriNote}</small></div></div>
          </article>
        </section>

        <section className="content-grid">
          <article className="panel prayer-panel">
            <div className="panel-heading">
              <div><p className="eyebrow">{formatScheduleDate(selectedDate, activeLocation, { weekday: 'long' }).toUpperCase()} · {formatScheduleDate(selectedDate, activeLocation, { month: 'short', day: 'numeric' }).toUpperCase()}</p><h2>{showingFlightEstimate ? en.estimatedPrayerTimes : en.prayerTimes}</h2></div>
              <span className="timezone-tag"><Clock3 size={13} /> {en.localTime}</span>
            </div>
            {displayedTimes ? <div className="prayer-list">
              {prayerRows.map((prayer, index) => {
                const active = isViewingToday && prayer.obligatory && nextPrayer?.key === prayer.key && nextPrayer.time.getTime() === displayedTimes[prayer.key].getTime()
                const Icon = prayer.icon
                return <div key={prayer.key} className={`prayer-row ${active ? 'is-next' : ''} ${!prayer.obligatory ? 'sunrise-row' : ''}`}>
                  <span className={`prayer-icon prayer-icon-${index}`}><Icon size={17} strokeWidth={1.7} /></span>
                  <span className="prayer-name">{prayer.label}{prayer.key === 'sunrise' && <small>({en.shuruq})</small>}</span>
                  <span className="prayer-row-line" />
                  <span className="prayer-time">{formatTime(displayedTimes[prayer.key], activeLocation, preferences.timeFormat)}</span>
                  {active && <span className="up-next-tag"><span /> {en.upNextTag}</span>}
                </div>
              })}
            </div> : <div className="calculation-error"><Sunrise size={21} /><p>{en.invalidTimes}</p></div>}
            <div className="method-note"><span className="method-dot" /> {en.selectedMethod}: <strong>{en.methodNames[preferences.method]}</strong></div>
          </article>

          <aside className="side-column">
            <article className="panel qibla-panel">
              <div className="side-panel-heading"><div className="side-icon"><Compass size={18} /></div><div><p className="eyebrow">{en.facingKaaba}</p><h3>{en.qibla}</h3></div></div>
              <div className="compass" aria-label={en.compassBearingLabel.replace('{bearing}', qiblaBearing.toFixed(1))}>
                <div className="compass-face" style={{ transform: `rotate(-${deviceHeading ?? 0}deg)` }}>
                  <span className="compass-cardinal north">N</span><span className="compass-cardinal east">E</span><span className="compass-cardinal south">S</span><span className="compass-cardinal west">W</span>
                  <span className="compass-tick tick-a" /><span className="compass-tick tick-b" /><span className="compass-tick tick-c" /><span className="compass-tick tick-d" />
                </div>
                <span className="compass-vector" style={{ transform: `rotate(${compassRelativeBearing - 90}deg)` }} />
                <span className="kaaba-marker" style={meccaMarkerPosition} title={en.meccaMarker} aria-label={en.meccaMarker}><span /></span>
                <span className="compass-center"><span /></span>
              </div>
              <div className="bearing-value"><strong>{qiblaBearing.toFixed(1)}°</strong><span>{en.fromTrueNorth}</span></div>
              <button className="compass-permission-button" type="button" onClick={toggleDeviceCompass} disabled={deviceCompassStatus === 'requesting'}><Smartphone size={14} />{deviceCompassStatus === 'active' ? en.disablePhoneCompass : en.enablePhoneCompass}</button>
              {deviceCompassStatus === 'active' && deviceHeading !== null && <p className="compass-note compass-active-note">{en.phoneCompassActive} · {Math.round(deviceHeading)}°</p>}
              {deviceCompassStatus === 'requesting' && <p className="compass-note">{en.phoneCompassRequesting}</p>}
              {deviceCompassStatus === 'denied' && <p className="compass-note error-text">{en.phoneCompassDenied}</p>}
              {deviceCompassStatus === 'unsupported' && <p className="compass-note">{en.phoneCompassUnsupported}</p>}
              {deviceCompassStatus === 'no-sensor' && <p className="compass-note">{en.phoneCompassNoSensor}</p>}
              {deviceCompassStatus === 'idle' && <p className="compass-note">{en.qiblaNote}</p>}
            </article>

            <details className="panel settings-panel">
              <summary><span className="settings-summary-icon"><Settings2 size={17} /></span><span><strong>{en.settings}</strong><small>{en.personalizeTimetable}</small></span><ChevronDown className="settings-chevron" size={17} /></summary>
              <div className="settings-content">
                <label className="setting-field"><span>{en.calculationMethod}</span><select value={preferences.method} onChange={(event) => updatePreference('method', event.target.value as MethodKey)}>{methodOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
                <div className="setting-field"><span>{en.asrSchool}</span><div className="segmented-control"><button type="button" className={preferences.madhab === 'standard' ? 'selected' : ''} onClick={() => updatePreference('madhab', 'standard')}>{en.standard}</button><button type="button" className={preferences.madhab === 'hanafi' ? 'selected' : ''} onClick={() => updatePreference('madhab', 'hanafi')}>{en.hanafi}</button></div></div>
                <div className="angle-grid"><label className="setting-field"><span>{en.fajrAngle} <small>°</small></span><input type="number" min="0" max="30" step="0.1" placeholder={en.methodDefault} value={preferences.fajrAngle ?? ''} onChange={(event) => updatePreference('fajrAngle', event.target.value === '' ? null : Number(event.target.value))} /></label><label className="setting-field"><span>{en.ishaAngle} <small>°</small></span><input type="number" min="0" max="30" step="0.1" placeholder={preferences.method === 'ummAlQura' ? en.ummAlQuraInterval : en.methodDefault} value={preferences.ishaAngle ?? ''} onChange={(event) => updatePreference('ishaAngle', event.target.value === '' ? null : Number(event.target.value))} /></label></div>
                <label className="setting-field"><span>{en.highLatitude}</span><select value={preferences.highLatitude} onChange={(event) => updatePreference('highLatitude', event.target.value as Preferences['highLatitude'])}><option value="middleofthenight">{en.middleOfNight}</option><option value="seventhofthenight">{en.seventhOfNight}</option><option value="twilightangle">{en.twilightAngle}</option></select></label>
                <div className="setting-field"><span>{en.timeFormat}</span><div className="segmented-control"><button type="button" className={preferences.timeFormat === '12' ? 'selected' : ''} onClick={() => updatePreference('timeFormat', '12')}>{en.twelveHour}</button><button type="button" className={preferences.timeFormat === '24' ? 'selected' : ''} onClick={() => updatePreference('timeFormat', '24')}>{en.twentyFourHour}</button></div></div>
                <p className="settings-footnote"><Check size={13} /> Changes apply instantly and are saved on this device.</p>
              </div>
            </details>
          </aside>
        </section>

        <footer className="page-footer"><span className="footer-mark"><span /></span><span>{en.footer}</span><span className="footer-coordinates">{activeLocation.latitude.toFixed(2)}°, {activeLocation.longitude.toFixed(2)}°</span></footer>
      </main>
      {flightStatusOpen && <div className="flight-status-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setFlightStatusOpen(false) }}>
        <section className="flight-status-dialog" role="dialog" aria-modal="true" aria-labelledby="flight-status-title">
          <div className="status-dialog-heading"><span className="flight-summary-icon"><Plane size={18} /></span><div><p className="eyebrow">{en.flightStatusWindowEyebrow}</p><h2 id="flight-status-title">{en.flightStatusWindowTitle}</h2></div><button className="icon-button status-close" type="button" aria-label={en.closeWindow} onClick={() => setFlightStatusOpen(false)}><X size={17} /></button></div>
          {flightLookupBusy ? <div className="status-loading"><span className="search-spinner" />{en.flightStatusLoading.replace('{flight}', flightDraft.flightNumber)}</div> : flightLookupError ? <div className="status-dialog-error"><Compass size={20} /><p>{flightLookupError}</p></div> : flightStatusRecord ? <>
            <div className="status-flight-route"><strong>{flightStatusRecord.flight?.iata ?? flightDraft.flightNumber}</strong><span>{locationDisplay(flightDraft.origin ?? defaultLocation)} <ChevronRight size={14} /> {locationDisplay(flightDraft.destination ?? defaultLocation)}</span><b>{flightProviderStatus || flightStatusRecord.flight_status || en.statusUnavailable}</b></div>
            <div className="status-time-grid"><div><small>{en.scheduledDeparture} · {en.originTime}</small><strong>{displayedFlightTime('scheduledDeparture').replace('T', ' ')}</strong><span>{flightDraft.origin?.timezone ?? '—'}</span></div><div><small>{en.actualDeparture} · {en.originTime}</small><strong>{flightDraft.actualDeparture ? displayedFlightTime('actualDeparture').replace('T', ' ') : en.notAvailable}</strong><span>{flightDraft.origin?.timezone ?? '—'}</span></div><div><small>{en.expectedArrival} · {en.destinationTime}</small><strong>{displayedFlightTime('expectedArrival').replace('T', ' ')}</strong><span>{flightDraft.destination?.timezone ?? '—'}</span></div></div>
            <p className="status-utc-note"><Clock3 size={14} />{en.utcTimesConverted}</p>
            <button type="button" className="primary-button status-use-button" onClick={() => { if (activateFlightPlan()) setFlightStatusOpen(false) }}><Plane size={14} />{en.useFlightPlan}</button>
          </> : <div className="status-loading">{en.flightStatusLoading.replace('{flight}', flightDraft.flightNumber)}</div>}
          <p className="status-dialog-footnote">{en.flightStatusDisclaimer}</p>
        </section>
      </div>}
    </div>
  )
}

export default App
