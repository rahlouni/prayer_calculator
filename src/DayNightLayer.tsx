import { useEffect } from 'react'
import { GridLayer, point, type Coords } from 'leaflet'
import { useMap } from 'react-leaflet'

const radians = Math.PI / 180

// NOAA's fractional-year approximation for solar declination and equation of time.
function sunPosition(time: Date) {
  const year = time.getUTCFullYear()
  const yearStart = Date.UTC(year, 0, 1)
  const yearLength = Date.UTC(year + 1, 0, 1) - yearStart
  const gamma = 2 * Math.PI * ((time.getTime() - yearStart - 43_200_000) / yearLength)
  const equationOfTime = 229.18 * (
    0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma)
  )
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)
  const minutes = time.getUTCHours() * 60 + time.getUTCMinutes()
  return { declination, longitude: (720 - minutes - equationOfTime) / 4 }
}

export function DayNightLayer({ minute }: { minute: number }) {
  const map = useMap()

  useEffect(() => {
    const sun = sunPosition(new Date(minute * 60_000))
    const sinDeclination = Math.sin(sun.declination)
    const cosDeclination = Math.cos(sun.declination)
    const horizon = Math.sin(-0.833 * radians)
    const twilight = Math.sin(-12 * radians)
    const resolution = 64

    class ShadowLayer extends GridLayer {
      createTile(coords: Coords) {
        const tile = document.createElement('canvas')
        tile.width = resolution
        tile.height = resolution
        tile.setAttribute('aria-hidden', 'true')
        const context = tile.getContext('2d')
        if (!context) return tile

        const pixels = context.createImageData(resolution, resolution)
        const size = this.getTileSize().x
        const pixelStep = size / resolution
        const longitudeWeights = Array.from({ length: resolution }, (_, column) => {
          const x = coords.x * size + (column + 0.5) * pixelStep
          const longitude = map.unproject(point(x, 0), coords.z).lng
          return Math.cos((longitude - sun.longitude) * radians)
        })

        for (let row = 0; row < resolution; row += 1) {
          const y = coords.y * size + (row + 0.5) * pixelStep
          const latitude = map.unproject(point(0, y), coords.z).lat * radians
          const latitudeTerm = Math.sin(latitude) * sinDeclination
          const longitudeTerm = Math.cos(latitude) * cosDeclination
          for (let column = 0; column < resolution; column += 1) {
            const sineOfElevation = latitudeTerm + longitudeTerm * longitudeWeights[column]
            const darkness = Math.max(0, Math.min(1, (horizon - sineOfElevation) / (horizon - twilight)))
            const index = (row * resolution + column) * 4
            pixels.data[index] = 22
            pixels.data[index + 1] = 36
            pixels.data[index + 2] = 70
            pixels.data[index + 3] = Math.round(darkness * 115)
          }
        }

        context.putImageData(pixels, 0, 0)
        return tile
      }
    }

    const layer = new ShadowLayer({ className: 'day-night-layer', zIndex: 250 }).addTo(map)
    return () => { layer.remove() }
  }, [map, minute])

  return null
}
