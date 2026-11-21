import { aviationWeatherResponse } from './aviation-weather.ts'

export default {
  fetch(request: Request): Promise<Response> | Response {
    if (new URL(request.url).pathname !== '/api/aviation-advisories') {
      return new Response(null, { status: 404 })
    }
    return aviationWeatherResponse(request.method)
  },
}
