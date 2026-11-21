import cityDataUrl from './geonames-cities.tsv?url'

const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' })

export async function nearbyCity(latitude: number, longitude: number): Promise<{ name: string; country?: string } | undefined> {
  try {
    const response = await fetch(cityDataUrl)
    if (!response.ok) return undefined

    const radians = Math.PI / 180
    const latitudeRadians = latitude * radians
    // Compare squared half-chord distances, limited to roughly 40 km.
    let closestDistance = Math.sin(40 / (2 * 6371)) ** 2
    let closestCity: { name: string; country?: string } | undefined
    for (const row of (await response.text()).split('\n')) {
      if (!row) continue
      const [name, lat, lon, countryCode] = row.trimEnd().split('\t')
      const latitudeDelta = Number(lat) - latitude
      if (Math.abs(latitudeDelta) > 0.36) continue
      const longitudeDelta = (Number(lon) - longitude) * radians
      const distance = Math.sin(latitudeDelta * radians / 2) ** 2
        + Math.cos(latitudeRadians) * Math.cos(Number(lat) * radians) * Math.sin(longitudeDelta / 2) ** 2
      if (distance < closestDistance) {
        closestDistance = distance
        closestCity = { name, country: /^[A-Z]{2}$/.test(countryCode) ? regionNames.of(countryCode) : undefined }
      }
    }
    return closestCity
  } catch {
    return undefined
  }
}
