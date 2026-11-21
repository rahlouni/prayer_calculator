# Salah times

A responsive prayer-times application built with React, TypeScript, and Vite. Prayer times and Qibla bearings are calculated in the browser with Adhan JS; there is no application database. Flight-status lookups use a local Vite development-server proxy.

## Run locally

Install dependencies with `npm install`, then start the Vite development server with `npm run dev`. Create a production build with `npm run build` and serve it locally with `npm run preview`.

## Features

- Houston, Texas demo location, browser geolocation, Open-Meteo city search, manual coordinates/time-zone entry, and map-based coordinate picking.
- Fajr, sunrise (Shuruq), Dhuhr, Asr, Maghrib, and Isha schedules calculated locally with Adhan JS.
- Location-time-zone-aware display, date navigation, next-prayer countdown, and Isha-to-next-Fajr rollover.
- ISNA, Muslim World League, Egyptian, Umm al-Qura, Karachi, and Moonsighting Committee methods; Standard/Hanafi Asr; custom twilight angles; supported high-latitude rules; 12/24-hour formatting.
- Adhan Qibla bearing, north-up compass, and browser-formatted Umm al-Qura Hijri date.
- Calculation preferences and selected location saved in browser localStorage.
- Flight route mode with flight-number lookup, airport-coordinate resolution, editable schedule/actual times, and great-circle route interpolation.
- Separate local-location and flight-route modes; departure times display in origin-local time and arrival in destination-local time. Only actual departure has five-minute adjustment controls. The route map shows estimated plane position, heading, and ground speed.

Geolocation, city search, map tiles, flight lookup, and automatic time-zone resolution require network access; geolocation also requires browser permission and a secure context. Flight prayer times use the interpolated route position and estimated local time zone along the aircraft route. Prayer times are estimates; verify them with a local mosque, particularly for high-latitude locations and locally announced dates.

## Test flight-number lookup

The planner uses Aviationstack's free personal-use plan (100 requests/month; non-commercial use). Create a free Aviationstack account and API key, copy `.env.example` to `.env.local`, and set `AVIATIONSTACK_ACCESS_KEY` in `.env.local`. Restart `npm run dev`, open **Plan a flight**, enter a flight number and its scheduled departure date, then select **Look up flight**. A matching result fills airport locations, scheduled/actual departure, and estimated/actual arrival; review the data and select **Use this flight plan** to calculate.

The Vite development server proxies the lookup so the API key is not sent to browser code. Aviationstack provides an airport IANA time zone for each event; the planner shows departure and actual departure in the origin airport's local time and arrival in the destination airport's local time. Verify those values in the in-app status dialog. Route position, heading, and speed on the map are estimates based on the entered times and device clock—not live telemetry. This proxy is for local testing only; deploy a protected server-side proxy before production. API availability and free-plan coverage/limits are controlled by Aviationstack. Airport coordinates are resolved by IATA code through Open-Meteo Geocoding.
