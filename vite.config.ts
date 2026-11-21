import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { aviationWeatherResponse } from './server/aviation-weather.ts'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite'

function flightStatusProxy(apiKey: string, enablePreview: boolean): Plugin {
  const lookup: Connect.NextHandleFunction = async (request, response, next) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost')
    if (requestUrl.pathname !== '/api/flight-status') return next()
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method !== 'GET') {
      response.statusCode = 405
      response.end(JSON.stringify({ error: { code: 'method_not_allowed' } }))
      return
    }
    if (!apiKey) {
      response.statusCode = 503
      response.end(JSON.stringify({ error: { code: 'missing_api_key' } }))
      return
    }
    const flightNumber = (requestUrl.searchParams.get('flightNumber') ?? '').replace(/\s+/g, '').toUpperCase()
    const flightDate = requestUrl.searchParams.get('flightDate') ?? ''
    if (!/^[A-Z0-9]{2,3}\d{1,5}[A-Z]?$/.test(flightNumber) || !/^\d{4}-\d{2}-\d{2}$/.test(flightDate)) {
      response.statusCode = 400
      response.end(JSON.stringify({ error: { code: 'invalid_query' } }))
      return
    }
    try {
      const apiUrl = new URL('https://api.aviationstack.com/v1/flights')
      apiUrl.searchParams.set('access_key', apiKey)
      apiUrl.searchParams.set('flight_iata', flightNumber)
      // Keep this on the live /flights endpoint. Aviationstack's historical
      // date-filtered functionality is restricted on free subscriptions.
      const upstream = await fetch(apiUrl)
      const responseText = await upstream.text()
      let body: { data?: unknown; results?: unknown; error?: { code?: string; type?: string; info?: string } }
      try {
        body = JSON.parse(responseText) as typeof body
      } catch {
        response.statusCode = 502
        response.end(JSON.stringify({ error: { code: 'invalid_provider_response' } }))
        return
      }
      if (!upstream.ok || body.error) {
        response.statusCode = upstream.status === 429 ? 429 : 502
        const providerMessage = [body.error?.code, body.error?.info ?? body.error?.type].filter(Boolean).join(': ') || `Aviationstack returned HTTP ${upstream.status}.`
        response.end(JSON.stringify({ error: { code: 'provider_error', message: providerMessage.replaceAll(apiKey, '[redacted]').slice(0, 240) } }))
        return
      }
      const records = Array.isArray(body.data) ? body.data : Array.isArray(body.results) ? body.results : []
      response.statusCode = 200
      response.end(JSON.stringify({ data: records, requestedDate: flightDate }))
    } catch {
      response.statusCode = 502
      response.end(JSON.stringify({ error: { code: 'provider_unavailable' } }))
    }
  }

  return {
    name: 'local-flight-status-proxy',
    configureServer(server) {
      server.middlewares.use(lookup)
    },
    configurePreviewServer(server) {
      if (enablePreview) server.middlewares.use(lookup)
    },
  }
}

function aviationWeatherProxy(): Plugin {
  const middleware: Connect.NextHandleFunction = async (request, response, next) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/api/aviation-advisories') return next()
    const result = await aviationWeatherResponse(request.method ?? 'GET')
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(await result.text())
  }
  return {
    name: 'aviation-weather-proxy',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

function offlineFlightWorker(): Plugin {
  return {
    name: 'offline-flight-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).sort()
      const worker = readFileSync(new URL('./offline-worker.js', import.meta.url), 'utf8')
      const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
      const version = createHash('sha256').update(JSON.stringify(assets)).update(html).update(worker).digest('hex').slice(0, 16)
      this.emitFile({
        type: 'asset',
        fileName: 'offline-worker.js',
        source: `const BUILD_VERSION = ${JSON.stringify(version)}\nconst BUILD_ASSETS = ${JSON.stringify(assets)}\n${worker}`,
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss(), flightStatusProxy(env.AVIATIONSTACK_ACCESS_KEY ?? '', mode === 'flight-test'), aviationWeatherProxy(), offlineFlightWorker()],
  }
})
