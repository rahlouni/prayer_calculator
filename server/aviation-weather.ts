const sigmetUrl = 'https://aviationweather.gov/api/data/isigmet?format=geojson'
let cached: { fetchedAt: number; data: unknown } | undefined
let pending: Promise<NonNullable<typeof cached>> | undefined

async function readFeed() {
  if (cached && Date.now() - cached.fetchedAt < 60_000) return cached
  pending ??= (async () => {
    const response = await fetch(sigmetUrl, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error('SIGMET feed unavailable')
    const data = await response.json() as { type?: string; features?: unknown }
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('Invalid SIGMET feed')
    cached = { fetchedAt: Date.now(), data }
    return cached
  })().finally(() => { pending = undefined })
  return pending
}

export async function aviationWeatherResponse(method: string): Promise<Response> {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' }
  if (method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } })
  try {
    return new Response(JSON.stringify(await readFeed()), {
      headers: { ...headers, 'Cache-Control': 'public, max-age=60' },
    })
  } catch {
    return new Response(JSON.stringify({ error: 'Aviation advisory feed unavailable' }), {
      status: 502, headers: { ...headers, 'Cache-Control': 'no-store' },
    })
  }
}
