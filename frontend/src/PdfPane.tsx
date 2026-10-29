import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import { HIGHLIGHT_COLORS, type HighlightColor, type PdfSelection } from './api'
import { markItem, type CitationMatch, type ItemMarks } from './citations'

// Must be set in the module that renders react-pdf components.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

export type ShownHighlight = { id: number; color: HighlightColor; text: string; match: CitationMatch }

/** A passage marked with a dashed outline: the one being asked about, or the one
 * a sent question was about (then scrolled to). */
export type AskMark = { match: CitationMatch; nonce: number; scroll: boolean }

// Id used for the ask mark among the user-highlight marks; above every real id,
// so it is drawn on top.
const ASK_MARK_ID = Number.MAX_SAFE_INTEGER

type Props = {
  url: string
  matches: Map<string, CitationMatch>
  hues: Map<number, number> // highlight hue per answer (message id)
  activeMessageId: number | null
  focus: { key: string; nonce: number } | null
  userHighlights: ShownHighlight[]
  askMark: AskMark | null
  onDocument: (pdf: PDFDocumentProxy | null) => void
  onAsk: (selection: PdfSelection) => void
  onCreateHighlight: (h: PdfSelection, color: HighlightColor) => void
  onRecolorHighlight: (id: number, color: HighlightColor) => void
  onDeleteHighlight: (id: number) => void
}

/** The floating colour bar: for a fresh selection, or for an existing highlight. */
type Bar = { x: number; y: number } & (
  | { kind: 'new'; selection: PdfSelection }
  | { kind: 'edit'; id: number; color: HighlightColor; selection: PdfSelection }
)

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

export default function PdfPane({
  url,
  matches,
  hues,
  activeMessageId,
  focus,
  userHighlights,
  askMark,
  onDocument,
  onAsk,
  onCreateHighlight,
  onRecolorHighlight,
  onDeleteHighlight,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [numPages, setNumPages] = useState(0)
  const [width, setWidth] = useState(600)
  const [zoom, setZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [bar, setBar] = useState<Bar | null>(null)

  // Fit pages to the pane width.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, entry.contentRect.width - 32)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Highlights (Claude's citations and the user's own) per page, then per text item.
  const marksByPage = useMemo(() => {
    const byPage = new Map<number, Map<number, ItemMarks>>()
    const itemMarks = (page: number, item: number) => {
      const items = byPage.get(page) ?? new Map<number, ItemMarks>()
      byPage.set(page, items)
      const marks = items.get(item) ?? { cites: [], users: [] }
      items.set(item, marks)
      return marks
    }
    for (const [key, m] of matches) {
      const messageId = Number(key.split(':')[0])
      const mark = { key, active: messageId === activeMessageId, hue: hues.get(messageId) ?? 48 }
      for (const [item, ranges] of m.ranges) {
        for (const range of ranges) itemMarks(m.page, item).cites.push({ range, mark })
      }
    }
    const users = userHighlights.map((h) => ({ id: h.id, color: h.color as string, match: h.match }))
    if (askMark) users.push({ id: ASK_MARK_ID, color: 'ask', match: askMark.match })
    for (const h of users) {
      const mark = { id: h.id, color: h.color }
      for (const [item, ranges] of h.match.ranges) {
        for (const range of ranges) itemMarks(h.match.page, item).users.push({ range, mark })
      }
    }
    return byPage
  }, [matches, hues, activeMessageId, userHighlights, askMark])

  const textRenderer = useCallback(
    ({ pageNumber, itemIndex, str }: { pageNumber: number; itemIndex: number; str: string }) =>
      markItem(itemIndex, str, marksByPage.get(pageNumber)?.get(itemIndex) ?? { cites: [], users: [] }),
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

  // Scroll to the passage a sent question was about, and flash it.
  useEffect(() => {
    if (!askMark?.scroll) return
    const root = scroller.current
    if (!root) return
    root.querySelector(`[data-page="${askMark.match.page}"]`)?.scrollIntoView({ block: 'start' })
    let tries = 0
    const timer = setInterval(() => {
      const marks = root.querySelectorAll<HTMLElement>(`mark.user-mark[data-hl="${ASK_MARK_ID}"]`)
      if (marks.length || ++tries > 40) {
        clearInterval(timer)
        marks[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        marks.forEach((m) => {
          m.classList.remove('flash')
          void m.offsetWidth // restart the animation
          m.classList.add('flash')
        })
      }
    }, 50)
    return () => clearInterval(timer)
  }, [askMark])

  // Close the colour bar on Escape or a click elsewhere.
  useEffect(() => {
    if (!bar) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setBar(null)
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setBar(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [bar])

  // Track which page is in view, for the page indicator.
  const onScroll = () => {
    setBar(null)
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

  // A finished mouse selection in the text layer: offer the colours.
  const onMouseUp = () => {
    // Let the browser finish updating the selection first.
    requestAnimationFrame(() => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return
      const selection = selectionToHighlight(sel.getRangeAt(0))
      if (!selection) return
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      setBar({ kind: 'new', selection, ...barPosition(rect.left + rect.width / 2, rect.bottom) })
    })
  }

  // A click on one of the user's highlights: offer to recolour or delete it.
  const onClick = (e: React.MouseEvent) => {
    if (!window.getSelection()?.isCollapsed) return
    const mark = (e.target as Element).closest<HTMLElement>('mark.user-mark')
    const h = mark && userHighlights.find((x) => x.id === Number(mark.dataset.hl))
    if (h) setBar({ kind: 'edit', id: h.id, color: h.color, selection: toSelection(h), ...barPosition(e.clientX, e.clientY) })
  }

  const ask = () => {
    if (!bar) return
    onAsk(bar.selection)
    window.getSelection()?.removeAllRanges()
    setBar(null)
  }

  const pick = (color: HighlightColor) => {
    if (!bar) return
    if (bar.kind === 'new') {
      onCreateHighlight(bar.selection, color)
      window.getSelection()?.removeAllRanges()
    } else if (color !== bar.color) {
      onRecolorHighlight(bar.id, color)
    }
    setBar(null)
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
        <span className="muted small hint">Select text to highlight it</span>
        <button onClick={() => zoomBy(-1)} title="Zoom out" aria-label="Zoom out">−</button>
        <button onClick={() => setZoom(1)} title="Fit width">{Math.round(zoom * 100)}%</button>
        <button onClick={() => zoomBy(1)} title="Zoom in" aria-label="Zoom in">+</button>
      </div>
      <div className="pdf-scroller" ref={scroller} onScroll={onScroll} onMouseUp={onMouseUp} onClick={onClick}>
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

      {bar && (
        <div
          ref={barRef}
          className="highlight-bar"
          style={{ left: bar.x, top: bar.y }}
          // Keep the text selection while clicking the bar.
          onMouseDown={(e) => e.preventDefault()}
          role="toolbar"
          aria-label={bar.kind === 'new' ? 'Highlight colour' : 'Change highlight'}
        >
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              className={`swatch hl-${c}${bar.kind === 'edit' && bar.color === c ? ' current' : ''}`}
              title={c}
              aria-label={`Highlight ${c}`}
              onClick={() => pick(c)}
            />
          ))}
          <button className="ask" onClick={ask} title="Ask Claude about this passage">
            💬 Ask Claude
          </button>
          {bar.kind === 'edit' && (
            <button
              className="icon delete"
              title="Remove highlight"
              aria-label="Remove highlight"
              onClick={() => {
                onDeleteHighlight(bar.id)
                setBar(null)
              }}
            >
              🗑
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** A saved highlight as a passage to ask about. */
function toSelection(h: ShownHighlight): PdfSelection {
  const ranges: [number, number, number][] = []
  for (const [item, spans] of h.match.ranges) for (const [start, end] of spans) ranges.push([item, start, end])
  return { page: h.match.page, ranges: ranges.sort((a, b) => a[0] - b[0]), text: h.text }
}

/** Place the bar under a point, kept inside the window. */
function barPosition(x: number, y: number) {
  const w = 360
  return { x: Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8), y: Math.min(y + 8, window.innerHeight - 50) }
}

// ---------------------------------------------------------------- selection → text items

/** The text-layer element of one text item (a direct child of the layer), and its index. */
function itemOf(node: Node | null): { el: HTMLElement; index: number } | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null)
  while (el && !el.parentElement?.matches('.textLayer, .markedContent')) el = el.parentElement
  if (!el || el.matches('.markedContent, .endOfContent')) return null
  const tag = el.querySelector<HTMLElement>('mark.ti')
  return tag ? { el, index: Number(tag.dataset.i) } : null
}

/** An item and character offset for one end of a selection. pdf.js sometimes
 * puts an end on the layer itself or on its `endOfContent` helper; then the
 * nearest item in the selection's direction is used. */
function endpoint(node: Node, offset: number, side: 'start' | 'end') {
  const direct = itemOf(node)
  if (direct) {
    const r = document.createRange()
    r.setStart(direct.el, 0)
    r.setEnd(node, offset)
    return { ...direct, offset: r.toString().length }
  }
  let probe: Node | null = side === 'start' ? (node.childNodes[offset] ?? null) : (node.childNodes[offset - 1] ?? null)
  while (probe) {
    const hit = itemOf(probe)
    if (hit) return { ...hit, offset: side === 'start' ? 0 : (hit.el.textContent ?? '').length }
    probe = side === 'start' ? probe.nextSibling : probe.previousSibling
  }
  return null
}

/** Turn a DOM selection into item ranges on one page (a selection running into
 * the next page is cut at the end of the first). */
function selectionToHighlight(range: Range): PdfSelection | null {
  const start = endpoint(range.startContainer, range.startOffset, 'start')
  let end = endpoint(range.endContainer, range.endOffset, 'end')
  if (!start) return null
  const pageEl = start.el.closest<HTMLElement>('[data-page]')
  const layer = start.el.closest('.textLayer')
  if (!pageEl || !layer) return null

  // Every item of this page: index → its element.
  const items = new Map<number, HTMLElement>()
  layer.querySelectorAll<HTMLElement>('mark.ti').forEach((t) => items.set(Number(t.dataset.i), itemOf(t)!.el))
  if (!end || end.el.closest('.textLayer') !== layer) {
    const last = Math.max(...items.keys())
    end = { el: items.get(last)!, index: last, offset: (items.get(last)!.textContent ?? '').length }
  }

  const ranges: [number, number, number][] = []
  const parts: string[] = []
  for (const index of [...items.keys()].sort((a, b) => a - b)) {
    if (index < start.index || index > end.index) continue
    const text = items.get(index)!.textContent ?? ''
    const from = index === start.index ? start.offset : 0
    const to = index === end.index ? end.offset : text.length
    if (to > from) {
      ranges.push([index, from, to])
      parts.push(text.slice(from, to))
    }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (!ranges.length || !text) return null
  return { page: Number(pageEl.dataset.page), ranges, text }
}
