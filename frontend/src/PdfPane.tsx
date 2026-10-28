import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import { markItem, type CitationMatch, type Mark } from './citations'

// Must be set in the module that renders react-pdf components.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

type Props = {
  url: string
  matches: Map<string, CitationMatch>
  activeMessageId: number | null
  focus: { key: string; nonce: number } | null
  onDocument: (pdf: PDFDocumentProxy | null) => void
}

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

export default function PdfPane({ url, matches, activeMessageId, focus, onDocument }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const [numPages, setNumPages] = useState(0)
  const [width, setWidth] = useState(600)
  const [zoom, setZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)

  // Fit pages to the pane width.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, entry.contentRect.width - 32)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Highlights per page, then per text item.
  const marksByPage = useMemo(() => {
    const byPage = new Map<number, Map<number, { range: [number, number]; mark: Mark }[]>>()
    for (const [key, m] of matches) {
      const mark = { key, active: key.startsWith(`${activeMessageId}:`) }
      const items = byPage.get(m.page) ?? new Map()
      for (const [item, ranges] of m.ranges) {
        const list = items.get(item) ?? []
        for (const range of ranges) list.push({ range, mark })
        items.set(item, list)
      }
      byPage.set(m.page, items)
    }
    return byPage
  }, [matches, activeMessageId])

  const textRenderer = useCallback(
    ({ pageNumber, itemIndex, str }: { pageNumber: number; itemIndex: number; str: string }) =>
      markItem(str, marksByPage.get(pageNumber)?.get(itemIndex) ?? []),
    [marksByPage],
  )

  // Scroll to a citation: go to its page, then wait for its <mark> to be rendered.
  useEffect(() => {
    if (!focus) return
    const match = matches.get(focus.key)
    const root = scroller.current
    if (!match || !root) return
    root.querySelector(`[data-page="${match.page}"]`)?.scrollIntoView({ block: 'start' })
    let tries = 0
    const timer = setInterval(() => {
      const mark = root.querySelector<HTMLElement>(`mark[data-cite="${focus.key}"]`)
      if (mark || ++tries > 40) {
        clearInterval(timer)
        if (mark) {
          mark.scrollIntoView({ block: 'center', behavior: 'smooth' })
          root.querySelectorAll(`mark[data-cite="${focus.key}"]`).forEach((m) => {
            m.classList.remove('flash')
            void (m as HTMLElement).offsetWidth // restart the animation
            m.classList.add('flash')
          })
        }
      }
    }, 50)
    return () => clearInterval(timer)
  }, [focus, matches])

  // Track which page is in view, for the page indicator.
  const onScroll = () => {
    const root = scroller.current
    if (!root) return
    const mid = root.getBoundingClientRect().top + root.clientHeight / 3
    for (const el of root.querySelectorAll<HTMLElement>('[data-page]')) {
      const r = el.getBoundingClientRect()
      if (r.top <= mid && r.bottom >= mid) {
        setCurrentPage(Number(el.dataset.page))
        break
      }
    }
  }

  const zoomBy = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 1e-6)
    setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + dir))])
  }

  return (
    <div className="pdf-pane">
      <div className="pdf-toolbar">
        <span>{numPages ? `Page ${currentPage} / ${numPages}` : 'Loading…'}</span>
        <span className="spacer" />
        <button onClick={() => zoomBy(-1)} title="Zoom out" aria-label="Zoom out">−</button>
        <button onClick={() => setZoom(1)} title="Fit width">{Math.round(zoom * 100)}%</button>
        <button onClick={() => zoomBy(1)} title="Zoom in" aria-label="Zoom in">+</button>
      </div>
      <div className="pdf-scroller" ref={scroller} onScroll={onScroll}>
        <Document
          file={url}
          onLoadSuccess={(pdf) => {
            setNumPages(pdf.numPages)
            onDocument(pdf)
          }}
          onLoadError={() => onDocument(null)}
          loading={<div className="pdf-message">Loading PDF…</div>}
          error={<div className="pdf-message">Could not load the PDF.</div>}
        >
          {Array.from({ length: numPages }, (_, i) => (
            <div className="pdf-page" data-page={i + 1} key={i}>
              <Page
                pageNumber={i + 1}
                width={width * zoom}
                customTextRenderer={textRenderer}
                loading={<div className="pdf-page-placeholder" style={{ height: width * zoom * 1.3 }} />}
              />
            </div>
          ))}
        </Document>
      </div>
    </div>
  )
}
