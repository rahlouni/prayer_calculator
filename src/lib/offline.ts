export const offlineFlightKey = 'salah-offline-flight'

export function hasOfflineFlight(): boolean {
  try {
    return localStorage.getItem(offlineFlightKey) === 'ready'
  } catch {
    return false
  }
}

export async function cacheFlightApp(): Promise<void> {
  const base = new URL(import.meta.env.BASE_URL, window.location.href)
  const worker = navigator.serviceWorker
  await worker.register(new URL('offline-worker.js', base))
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Offline cache did not finish installing')), 20000)
    void worker.ready.then(() => {
      window.clearTimeout(timer)
      resolve()
    })
  })
  if (!await caches.match(new URL('index.html', base).href)) {
    throw new Error('Offline app is missing from browser storage')
  }
}

export function approximateFlightTimezone(longitude: number): string {
  const hoursEast = Math.round(longitude / 15)
  // Etc/GMT zone identifiers use the opposite sign from UTC offsets.
  return hoursEast === 0 ? 'UTC' : `Etc/GMT${hoursEast > 0 ? '-' : '+'}${Math.abs(hoursEast)}`
}

export function displayFlightTimezone(timezone: string): string {
  const offset = /^Etc\/GMT([+-])(\d+)$/.exec(timezone)
  if (!offset) return timezone
  return `UTC${offset[1] === '-' ? '+' : '−'}${offset[2]}`
}
