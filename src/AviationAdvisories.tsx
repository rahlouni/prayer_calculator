import { GeoJSON } from 'react-leaflet'
import en from './i18n/en'
import type { AdvisoryFeed } from './lib/aviation'

function hazardName(hazard: string | undefined): string {
  switch (hazard) {
    case 'TURB': return en.advisoryTurbulence
    case 'ICE': return en.advisoryIcing
    case 'TS': return en.advisoryStorms
    case 'VA': return en.advisoryAsh
    case 'TC': return en.advisoryCyclone
    default: return hazard || en.aviationAdvisory
  }
}

function altitudeText(base: number | undefined, top: number | undefined) {
  if (!Number.isFinite(base) && !Number.isFinite(top)) return ''
  const floor = base === 0 ? en.advisorySurface : Number.isFinite(base) ? `${base?.toLocaleString()} ft` : '—'
  const ceiling = Number.isFinite(top) ? `${top?.toLocaleString()} ft` : '—'
  return `${floor} – ${ceiling}`
}

export function AviationAdvisoryLayer({ data }: { data: AdvisoryFeed }) {
  return <GeoJSON data={data} style={(feature) => {
    const hazard = feature?.properties?.hazard
    const color = hazard === 'ICE' ? '#315cbb' : hazard === 'TURB' ? '#9a4e12' : '#9a2745'
    return { color, fillColor: color, fillOpacity: 0.17, opacity: 0.85, weight: 1.5, dashArray: '4 3' }
  }} onEachFeature={(feature, layer) => {
    const { hazard, qualifier, firName, validTimeFrom, validTimeTo, base, top } = feature.properties
    const popup = document.createElement('div')
    const title = document.createElement('strong')
    title.textContent = [hazardName(hazard), qualifier].filter(Boolean).join(' · ')
    popup.append(title)
    for (const line of [firName, altitudeText(base, top), `${en.advisoryValid} ${validTimeFrom?.replace('T', ' ').slice(0, 16)} – ${validTimeTo?.replace('T', ' ').slice(0, 16)} UTC`]) {
      if (!line) continue
      const row = document.createElement('div')
      row.textContent = line
      popup.append(row)
    }
    layer.bindPopup(popup, { maxWidth: 250 })
  }} />
}
