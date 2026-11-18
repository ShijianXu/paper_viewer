import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Material, Paper } from './api'

type Props = {
  papers: Paper[]
  current: number
  onSelect: (num: number) => void
  onDropTab?: (num: number) => void // a tab of another pane dropped here
  onRemove: (num: number) => void
  adding: boolean
  onAddFiles: (files: File[]) => void
  onAddLink: (url: string) => void
  pdfMaterials: Material[]
  onOpenMaterial: (m: Material) => void
  children?: ReactNode // buttons at the right end
}

const TAB_TYPE = 'application/x-paper-viewer-tab' // a tab being dragged to the other pane

/** The tabs of a PDF pane (the papers open in it), with + to open another paper. */
export default function PaperTabs({ papers, current, onSelect, onDropTab, onRemove, adding, onAddFiles, onAddLink, pdfMaterials, onOpenMaterial, children }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [link, setLink] = useState('')
  const menu = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [dropTarget, setDropTarget] = useState(false)

  // Close the menu on Escape or a click elsewhere.
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    const onDown = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && setMenuOpen(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [menuOpen])

  const submitLink = () => {
    const url = link.trim()
    if (!url) return
    onAddLink(url)
    setLink('')
    setMenuOpen(false)
  }

  return (
    <div
      className={`paper-tabs${dropTarget ? ' drop-target' : ''}`}
      role="tablist"
      aria-label="Papers"
      onDragOver={(e) => {
        if (!onDropTab || !e.dataTransfer.types.includes(TAB_TYPE)) return
        e.preventDefault()
        setDropTarget(true)
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(e) => {
        setDropTarget(false)
        const num = Number(e.dataTransfer.getData(TAB_TYPE))
        if (!onDropTab || !num || papers.some((p) => p.num === num)) return
        e.preventDefault()
        onDropTab(num)
      }}
    >
      <div className="paper-tabs-list">
        {papers.map((p) => (
          <div
            key={p.num}
            role="tab"
            tabIndex={0}
            aria-selected={p.num === current}
            className={`paper-tab${p.num === current ? ' current' : ''}`}
            title={`Paper ${p.num}: ${p.title}\n${p.filename}${onDropTab ? '\nDrag to the other pane to move it there' : ''}`}
            draggable={!!onDropTab}
            onDragStart={(e) => {
              e.dataTransfer.setData(TAB_TYPE, String(p.num))
              e.dataTransfer.effectAllowed = 'move'
            }}
            onClick={() => onSelect(p.num)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(p.num))}
          >
            <span className="paper-tab-num">{p.num}</span>
            <span className="paper-tab-title">{p.title}</span>
            {p.num !== 1 && (
              <button
                className="icon paper-tab-close"
                onClick={(e) => (e.stopPropagation(), onRemove(p.num))}
                title="Remove this paper from the session"
                aria-label={`Remove paper ${p.num}`}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <div className="paper-add" ref={menu}>
          <button
            className="icon"
            onClick={() => setMenuOpen((o) => !o)}
            disabled={adding}
            title="Open another paper next to this one"
            aria-label="Open another paper"
            aria-expanded={menuOpen}
          >
            {adding ? '…' : '+'}
          </button>
          {menuOpen && (
            <div className="paper-add-menu">
              <button
                onClick={() => {
                  fileInput.current?.click()
                  setMenuOpen(false)
                }}
              >
                📄 Open PDF file…
              </button>
              <form
                className="paper-add-link"
                onSubmit={(e) => {
                  e.preventDefault()
                  submitLink()
                }}
              >
                <input
                  type="url"
                  value={link}
                  placeholder="or paste a link (arXiv, OpenReview, DOI…)"
                  aria-label="Link to a paper"
                  onChange={(e) => setLink(e.target.value)}
                  autoFocus
                />
                <button type="submit" disabled={!link.trim()}>
                  Open
                </button>
              </form>
              {pdfMaterials.length > 0 && (
                <>
                  <div className="muted small">From the materials:</div>
                  {pdfMaterials.map((m) => (
                    <button
                      key={m.id}
                      className="paper-add-material"
                      title={m.filename}
                      onClick={() => {
                        onOpenMaterial(m)
                        setMenuOpen(false)
                      }}
                    >
                      📎 {m.filename}
                    </button>
                  ))}
                </>
              )}
              <div className="muted small">You can also drop PDFs onto the paper.</div>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(e) => {
              onAddFiles([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
        </div>
      </div>
      <span className="paper-tabs-actions">{children}</span>
    </div>
  )
}
