import { useEffect, useId, useRef, useState } from 'react'

const VIDEO = /\.(mp4|webm|mov|ogv)$/i

/** URL for an image path in Claude's answer: files in the session folder are
 * served by the backend; web and data URLs are used as they are. */
export function mediaUrl(src: string | undefined, sessionId: string | undefined, version: number): string | null {
  if (!src) return null
  if (/^(https?:|data:image\/)/i.test(src)) return src
  if (!sessionId) return null
  let path = src.replace(/^\.\//, '')
  // An absolute path into the session folder: keep the part inside it.
  const marker = `/papers/${sessionId}/`
  if (path.includes(marker)) path = path.slice(path.indexOf(marker) + marker.length)
  if (path.startsWith('/') || /^[a-z]+:/i.test(path)) return null
  return `/api/sessions/${sessionId}/files/${path.split('/').map(encodeURIComponent).join('/')}?v=${version}`
}

/** An image, GIF or video from an answer; click an image to open it full size. */
export function MediaFile({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  const path = decodeURIComponent(src.split('?')[0].split('/').pop() ?? '')
  if (failed) return <span className="media-missing">[{alt || 'image'} not found: {path}]</span>
  if (VIDEO.test(src.split('?')[0])) {
    return (
      <video className="media" src={src} controls loop playsInline onError={() => setFailed(true)} aria-label={alt} />
    )
  }
  return (
    <a href={src} target="_blank" rel="noreferrer" className="media-link" title="Open full size">
      <img className="media" src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
    </a>
  )
}

let mermaidReady: Promise<typeof import('mermaid').default> | null = null

function loadMermaid(dark: boolean) {
  // Loaded on first use: the library is large, and most answers have no diagram.
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
    return mermaid
  })
  return mermaidReady
}

/** A ```mermaid code block drawn as a diagram; the code is shown if it can't be drawn. */
export function MermaidDiagram({ code }: { code: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    loadMermaid(dark)
      .then((mermaid) => mermaid.render(id, code))
      .then(({ svg }) => !cancelled && setSvg(svg))
      .catch((e) => !cancelled && setError(String(e?.message ?? e).split('\n')[0]))
    return () => {
      cancelled = true
    }
  }, [code, id])

  if (error) {
    return (
      <div className="diagram-error">
        <pre>
          <code>{code}</code>
        </pre>
        <span className="muted small">Diagram could not be drawn: {error}</span>
      </div>
    )
  }
  if (!svg) return <div className="diagram muted small">Drawing diagram…</div>
  // The SVG comes from mermaid with securityLevel 'strict', which sanitizes it.
  return <div className="diagram" dangerouslySetInnerHTML={{ __html: svg }} />
}

type Figure = { data: object[]; layout?: Record<string, unknown>; config?: Record<string, unknown> }

/** Accepts a Plotly figure {data, layout, config}, or just its data array. */
function toFigure(value: unknown): Figure {
  if (Array.isArray(value)) return { data: value }
  if (value && typeof value === 'object' && Array.isArray((value as Figure).data)) return value as Figure
  throw new Error('expected a Plotly figure: {"data": [...], "layout": {...}}')
}

/** An interactive Plotly chart (zoom, pan, hover; rotate in 3D), from a ```plotly
 * block (`spec`) or a *.plotly.json file (`src`). Only data and settings, no code. */
export function PlotlyChart({ spec, src }: { spec?: string; src?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const el = box.current
    if (!el) return
    let cancelled = false
    let plotly: typeof import('plotly.js-dist-min') | null = null
    const figure = src
      ? fetch(src).then((r) => {
          if (!r.ok) throw new Error(`could not load ${decodeURIComponent(src.split('?')[0].split('/').pop() ?? '')}`)
          return r.json()
        })
      : Promise.resolve().then(() => JSON.parse(spec ?? ''))
    // Loaded on first use: the library is large, and most answers have no chart.
    Promise.all([figure.then(toFigure), import('plotly.js-dist-min')])
      .then(([fig, lib]) => {
        if (cancelled) return
        plotly = lib
        const style = getComputedStyle(document.documentElement)
        const fg = style.getPropertyValue('--fg').trim() || '#222'
        const layout = {
          height: 420,
          margin: { l: 50, r: 20, t: 40, b: 45 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          font: { color: fg },
          ...fig.layout,
          autosize: true,
        }
        return lib.newPlot(el, fig.data, layout, { responsive: true, displaylogo: false, ...fig.config })
      })
      .then(() => !cancelled && setReady(true))
      .catch((e) => !cancelled && setError(String(e?.message ?? e).split('\n')[0]))

    // Follow the chat pane's width (e.g. when the PDF divider is dragged).
    const ro = new ResizeObserver(() => plotly && el.isConnected && plotly.Plots.resize(el))
    ro.observe(el)
    return () => {
      cancelled = true
      ro.disconnect()
      plotly?.purge(el)
    }
  }, [spec, src])

  if (error) {
    return (
      <div className="diagram-error">
        {spec && (
          <pre>
            <code>{spec}</code>
          </pre>
        )}
        <span className="muted small">Chart could not be drawn: {error}</span>
      </div>
    )
  }
  return (
    <div className="chart">
      {!ready && <div className="muted small">Drawing chart…</div>}
      <div ref={box} />
    </div>
  )
}
