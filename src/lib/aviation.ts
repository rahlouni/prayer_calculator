import { useEffect, useState } from 'react'
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson'

type Advisory = { hazard?: string; qualifier?: string; firName?: string; validTimeFrom?: string; validTimeTo?: string; base?: number; top?: number }
export type AdvisoryFeed = FeatureCollection<Polygon | MultiPolygon, Advisory>
type Snapshot = { fetchedAt: number; data: AdvisoryFeed }

const storageKey = 'salah-aviation-advisories'
const endpoint = import.meta.env.DEV || import.meta.env.MODE === 'flight-test'
  ? '/api/aviation-advisories'
  : import.meta.env.VITE_AVIATION_WEATHER_URL as string | undefined

function isSnapshot(value: Snapshot | null): value is Snapshot {
  return Number.isFinite(value?.fetchedAt) && value?.data?.type === 'FeatureCollection' && Array.isArray(value.data.features)
}

function savedSnapshot(): Snapshot | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Snapshot | null
    return isSnapshot(value) ? value : null
  } catch {
    return null
  }
}

export function useAviationAdvisories(enabled: boolean) {
  const [snapshot, setSnapshot] = useState(savedSnapshot)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!enabled || !endpoint) return
    const url = endpoint
    const controller = new AbortController()

    async function refresh() {
      try {
        const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
        if (!response.ok) throw new Error('Aviation advisories unavailable')
        const value = await response.json() as Snapshot | null
        if (!isSnapshot(value)) throw new Error('Invalid advisory response')
        if (controller.signal.aborted) return
        setSnapshot(value)
        setFailed(false)
        try { localStorage.setItem(storageKey, JSON.stringify(value)) } catch { /* The current feed stays available in memory. */ }
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      }
    }
    void refresh()
    const interval = window.setInterval(refresh, 300_000)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [enabled])
  return { snapshot, failed, configured: Boolean(endpoint) }
}

export function activeAdvisories(snapshot: Snapshot | null, timestamp: number): AdvisoryFeed {
  return {
    type: 'FeatureCollection',
    features: (snapshot?.data.features ?? []).filter((feature) => {
      const type = feature.geometry?.type
      const start = Date.parse(feature.properties?.validTimeFrom ?? '')
      const end = Date.parse(feature.properties?.validTimeTo ?? '')
      return (type === 'Polygon' || type === 'MultiPolygon') && start <= timestamp && timestamp < end
    }),
  }
}
