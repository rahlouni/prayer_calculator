import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv, type Plugin } from 'vite'

function flightStatusProxy(apiKey: string): Plugin {
  return {
    name: 'local-flight-status-proxy',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
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
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss(), flightStatusProxy(env.AVIATIONSTACK_ACCESS_KEY ?? '')],
  }
})
