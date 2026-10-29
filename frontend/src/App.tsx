import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { api, type HighlightColor, type Material, type Message, type PdfSelection, type Session, type ToolCall, type UserHighlight } from './api'
import {
  buildPageIndex,
  citeHue,
  matchCitation,
  parseCitations,
  resolveHighlight,
  type Citation,
  type CitationMatch,
  type PageIndex,
} from './citations'
import MessageView from './MessageView'
import PdfPane, { type AskMark, type ShownHighlight } from './PdfPane'
import './App.css'

type Draft = { text: string; tools: ToolCall[] }

const EXAMPLES = [
  'Summarize this paper and explain the main method.',
  'Read this critically and list the weakest assumptions.',
  '用中文帮我读这篇论文。',
]

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [highlights, setHighlights] = useState<UserHighlight[]>([])
  const [materials, setMaterials] = useState<Material[]>([])
  const [addingMaterials, setAddingMaterials] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [split, setSplit] = useState(55) // PDF pane width in %
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageIndexes, setPageIndexes] = useState<PageIndex[] | null>(null)
  const [activeMessageId, setActiveMessageId] = useState<number | null>(null)
  const [focus, setFocus] = useState<{ key: string; nonce: number } | null>(null)
  const [askSelection, setAskSelection] = useState<PdfSelection | null>(null) // attached to the next question
  const [shownSelection, setShownSelection] = useState<{ selection: PdfSelection; nonce: number } | null>(null)
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId
  const createdHere = useRef<string | null>(null) // session just created by send/openPdf: keep its state

  const refreshSessions = useCallback(() => api.listSessions().then(setSessions).catch(() => {}), [])

  const loadSession = useCallback(async (id: string) => {
    const data = await api.getSession(id)
    if (currentIdRef.current !== id) return
    setSession(data.session)
    setMessages(data.messages)
    setHighlights(data.highlights)
    setMaterials(data.materials)
    const lastAnswer = [...data.messages].reverse().find((m) => m.role === 'assistant')
    setActiveMessageId(lastAnswer?.id ?? null)
  }, [])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  /** Switch sessions. All per-session state is reset in the same render, so the
   * new session id is never shown together with the old session's data. */
  const selectSession = useCallback((id: string | null) => {
    if (id === currentIdRef.current) return
    currentIdRef.current = id
    createdHere.current = null
    setCurrentId(id)
    setSession(null)
    setMessages([])
    setHighlights([])
    setMaterials([])
    setDraft(null)
    setPdfDoc(null)
    setPageIndexes(null)
    setFocus(null)
    setActiveMessageId(null)
    setAskSelection(null)
    setShownSelection(null)
  }, [])

  useEffect(() => {
    if (!currentId || currentId === createdHere.current) return
    loadSession(currentId).catch((e) => setError(String(e.message ?? e)))
  }, [currentId, loadSession])

  // Claude may still be answering (e.g. after a page reload): poll until it is done.
  useEffect(() => {
    if (!currentId || !session?.running || draft) return
    const timer = setInterval(() => loadSession(currentId).then(refreshSessions), 2000)
    return () => clearInterval(timer)
  }, [currentId, session?.running, draft, loadSession, refreshSessions])

  // Index the text of every page once the PDF is loaded, for finding quotes.
  useEffect(() => {
    if (!pdfDoc) return
    let cancelled = false
    Promise.all(
      Array.from({ length: pdfDoc.numPages }, (_, i) =>
        pdfDoc.getPage(i + 1).then((p) => p.getTextContent()).then((tc) => buildPageIndex(tc.items as { str?: string }[])),
      ),
    )
      .then((idx) => !cancelled && setPageIndexes(idx))
      .catch(() => {}) // the document was closed (e.g. the session was switched)
    return () => {
      cancelled = true
    }
  }, [pdfDoc])

  const matches = useMemo(() => {
    const out = new Map<string, CitationMatch>()
    if (!pageIndexes) return out
    for (const m of messages) {
      if (m.role !== 'assistant') continue
      for (const c of parseCitations(m.text, m.id).citations) {
        const hit = matchCitation(c, pageIndexes)
        if (hit) out.set(c.key, hit)
      }
    }
    return out
  }, [messages, pageIndexes])

  // One highlight color per answer that quotes the paper, in order; the answer
  // being written gets the next one.
  const { hues, nextHue } = useMemo(() => {
    const hues = new Map<number, number>()
    for (const m of messages) {
      if (m.role === 'assistant' && parseCitations(m.text, m.id).citations.length) hues.set(m.id, citeHue(hues.size))
    }
    return { hues, nextHue: citeHue(hues.size) }
  }, [messages])

  // The user's own highlights, placed on the current PDF text.
  const shownHighlights = useMemo<ShownHighlight[]>(() => {
    if (!pageIndexes) return []
    return highlights.flatMap((h) => {
      const match = resolveHighlight(h, pageIndexes)
      return match ? [{ id: h.id, color: h.color, text: h.text, match }] : []
    })
  }, [highlights, pageIndexes])

  // The passage marked with a dashed outline: one the user clicked in a sent
  // question (shown for a few seconds), else the one attached to the next question.
  const askMark = useMemo<AskMark | null>(() => {
    const target = shownSelection?.selection ?? askSelection
    const match = target && pageIndexes && resolveHighlight(target, pageIndexes)
    return match ? { match, nonce: shownSelection?.nonce ?? 0, scroll: !!shownSelection } : null
  }, [shownSelection, askSelection, pageIndexes])

  useEffect(() => {
    if (!shownSelection) return
    const timer = setTimeout(() => setShownSelection(null), 3000)
    return () => clearTimeout(timer)
  }, [shownSelection])

  const showSelection = useCallback(
    (selection: PdfSelection) => setShownSelection({ selection, nonce: Date.now() }),
    [],
  )

  const createHighlight = useCallback(
    (h: PdfSelection, color: HighlightColor) => {
      const sid = currentIdRef.current
      if (!sid) return
      api
        .addHighlight(sid, { ...h, color })
        .then((saved) => currentIdRef.current === sid && setHighlights((all) => [...all, saved]))
        .catch((e) => setError(`Could not save the highlight: ${e.message ?? e}`))
    },
    [],
  )

  const recolorHighlight = useCallback((id: number, color: HighlightColor) => {
    const sid = currentIdRef.current
    if (!sid) return
    api
      .recolorHighlight(sid, id, color)
      .then((saved) => currentIdRef.current === sid && setHighlights((all) => all.map((h) => (h.id === id ? saved : h))))
      .catch((e) => setError(`Could not change the highlight: ${e.message ?? e}`))
  }, [])

  const deleteHighlight = useCallback((id: number) => {
    const sid = currentIdRef.current
    if (!sid) return
    api
      .deleteHighlight(sid, id)
      .then(() => currentIdRef.current === sid && setHighlights((all) => all.filter((h) => h.id !== id)))
      .catch((e) => setError(`Could not remove the highlight: ${e.message ?? e}`))
  }, [])

  const found = useCallback((key: string) => (pageIndexes ? matches.has(key) : undefined), [pageIndexes, matches])

  const onCite = useCallback((c: Citation) => {
    setActiveMessageId(c.messageId)
    setFocus({ key: c.key, nonce: Date.now() })
  }, [])

  async function ensureSession(): Promise<string> {
    if (currentId) return currentId
    const s = await api.createSession()
    selectSession(s.id)
    createdHere.current = s.id // its state is already known; skip loading it
    setSession(s)
    refreshSessions()
    return s.id
  }

  async function send(text: string, selection: PdfSelection | null) {
    setError(null)
    setAskSelection(null)
    let id: string | null = null
    try {
      id = await ensureSession()
      const sid = id
      const now = Date.now() / 1000
      setMessages((m) => [...m, { id: -2, role: 'user', text, tools: [], error: null, selection, created_at: now }])
      setDraft({ text: '', tools: [] })
      await api.sendMessage(sid, text, selection, (ev) => {
        if (currentIdRef.current !== sid) return
        if (ev.type === 'text') setDraft((d) => d && { ...d, text: d.text + ev.text })
        else if (ev.type === 'tool') setDraft((d) => d && { ...d, tools: [...d.tools, { name: ev.name, summary: ev.summary }] })
        else if (ev.type === 'pdf') {
          loadSession(sid).catch(() => {})
          refreshSessions()
        }
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (id && currentIdRef.current === id) {
        await loadSession(id).catch(() => {})
        setDraft(null)
      }
      refreshSessions()
    }
  }

  async function addMaterials(files: File[]) {
    if (!files.length) return
    setError(null)
    setAddingMaterials(true)
    try {
      const id = await ensureSession()
      const added = await api.addMaterials(id, files)
      if (currentIdRef.current === id) setMaterials((all) => [...all, ...added])
    } catch (e) {
      setError(`Could not add the materials: ${e instanceof Error ? e.message : String(e)}`)
      // Files before the failing one may have been saved: show what is there.
      const id = currentIdRef.current
      if (id) api.getSession(id).then((d) => currentIdRef.current === id && setMaterials(d.materials)).catch(() => {})
    } finally {
      setAddingMaterials(false)
    }
  }

  async function removeMaterial(m: Material) {
    const id = currentIdRef.current
    if (!id) return
    try {
      await api.deleteMaterial(id, m.id)
      if (currentIdRef.current === id) setMaterials((all) => all.filter((x) => x.id !== m.id))
    } catch (e) {
      setError(`Could not remove ${m.filename}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function openPdf(file: File) {
    setError(null)
    setUploading(true)
    try {
      const id = await ensureSession()
      await api.uploadPdf(id, file)
      await loadSession(id)
      refreshSessions()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  async function removeSession(s: Session) {
    if (!confirm(`Delete “${s.title}”? The conversation and its files are removed.`)) return
    await api.deleteSession(s.id)
    if (s.id === currentId) selectSession(null)
    refreshSessions()
  }

  async function renameSession(s: Session) {
    const title = prompt('Rename session', s.title)?.trim()
    if (!title || title === s.title) return
    await api.renameSession(s.id, title)
    if (s.id === currentId) setSession((cur) => cur && { ...cur, title })
    refreshSessions()
  }

  const busy = !!draft || !!session?.running
  const chat = (
    <ChatPane
      session={session}
      messages={messages}
      draft={draft}
      hues={hues}
      nextHue={nextHue}
      busy={busy}
      uploading={uploading}
      activeMessageId={activeMessageId}
      found={found}
      onCite={onCite}
      onSend={send}
      askSelection={askSelection}
      onClearAsk={() => setAskSelection(null)}
      onShowSelection={showSelection}
      onStop={() => currentId && api.stop(currentId)}
      onOpenPdf={openPdf}
      materials={materials}
      addingMaterials={addingMaterials}
      onAddMaterials={addMaterials}
      onRemoveMaterial={removeMaterial}
    />
  )

  return (
    <div className="app">
      {sidebarOpen && (
        <aside className="sidebar">
          <div className="sidebar-head">
            <button className="primary" onClick={() => selectSession(null)}>
              + New session
            </button>
            <button className="icon" onClick={() => setSidebarOpen(false)} title="Hide sessions" aria-label="Hide sessions">
              «
            </button>
          </div>
          <nav className="session-list">
            {sessions.length === 0 && <p className="muted small">No sessions yet.</p>}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`session-item${s.id === currentId ? ' current' : ''}`}
                onClick={() => selectSession(s.id)}
                onDoubleClick={() => renameSession(s)}
                title={s.title}
              >
                <span className="session-title">
                  {s.has_pdf ? '📄 ' : ''}
                  {s.title}
                </span>
                {s.running && <span className="dot" title="Claude is answering" />}
                <span className="session-actions">
                  <button className="icon" onClick={(e) => (e.stopPropagation(), renameSession(s))} title="Rename" aria-label="Rename">
                    ✎
                  </button>
                  <button className="icon" onClick={(e) => (e.stopPropagation(), removeSession(s))} title="Delete" aria-label="Delete">
                    🗑
                  </button>
                </span>
              </div>
            ))}
          </nav>
        </aside>
      )}

      <main className="main">
        {!sidebarOpen && (
          <button className="icon show-sidebar" onClick={() => setSidebarOpen(true)} title="Show sessions" aria-label="Show sessions">
            »
          </button>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button className="icon" onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {session?.has_pdf && session.id === currentId ? (
          <div className="split">
            <div className="split-left" style={{ width: `${split}%` }}>
              {/* keyed by session: each paper gets a fresh viewer */}
              <ErrorBoundary key={session.id} fallback={<div className="pdf-message">The PDF viewer failed. Reload the page to try again.</div>}>
                <PdfPane
                  url={api.pdfUrl(session.id)}
                  matches={matches}
                  hues={hues}
                  activeMessageId={activeMessageId}
                  focus={focus}
                  userHighlights={shownHighlights}
                  askMark={askMark}
                  onAsk={setAskSelection}
                  onDocument={setPdfDoc}
                  onCreateHighlight={createHighlight}
                  onRecolorHighlight={recolorHighlight}
                  onDeleteHighlight={deleteHighlight}
                />
              </ErrorBoundary>
            </div>
            <Divider onDrag={setSplit} />
            <div className="split-right">{chat}</div>
          </div>
        ) : (
          <div className="single">{chat}</div>
        )}
      </main>
    </div>
  )
}

/** Keeps an error in one pane (e.g. the PDF viewer) from blanking the whole app. */
class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error('Pane crashed:', error)
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function Divider({ onDrag }: { onDrag: (percent: number) => void }) {
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    const parent = e.currentTarget.parentElement!
    const rect = parent.getBoundingClientRect()
    const move = (ev: PointerEvent) => onDrag(Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('dragging')
    }
    document.body.classList.add('dragging')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return <div className="divider" onPointerDown={start} role="separator" aria-orientation="vertical" />
}

type ChatProps = {
  session: Session | null
  messages: Message[]
  draft: Draft | null
  hues: Map<number, number>
  nextHue: number
  busy: boolean
  uploading: boolean
  activeMessageId: number | null
  found: (key: string) => boolean | undefined
  onCite: (c: Citation) => void
  onSend: (text: string, selection: PdfSelection | null) => void
  askSelection: PdfSelection | null
  onClearAsk: () => void
  onShowSelection: (s: PdfSelection) => void
  onStop: () => void
  onOpenPdf: (file: File) => void
  materials: Material[]
  addingMaterials: boolean
  onAddMaterials: (files: File[]) => void
  onRemoveMaterial: (m: Material) => void
}

function ChatPane({
  session,
  messages,
  draft,
  hues,
  nextHue,
  busy,
  uploading,
  activeMessageId,
  found,
  onCite,
  onSend,
  askSelection,
  onClearAsk,
  onShowSelection,
  onStop,
  onOpenPdf,
  materials,
  addingMaterials,
  onAddMaterials,
  onRemoveMaterial,
}: ChatProps) {
  const materialInput = useRef<HTMLInputElement>(null)
  const [showMaterials, setShowMaterials] = useState(false)
  const [text, setText] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)

  // A passage was attached: type the question right away.
  useEffect(() => {
    if (askSelection) textarea.current?.focus()
  }, [askSelection])
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const canOpenPdf = !session?.has_pdf

  // Follow new content, unless the user scrolled up to read.
  useEffect(() => {
    const el = list.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, draft])

  const submit = () => {
    const t = text.trim() || (askSelection ? 'Explain this passage.' : '')
    if (!t || busy) return
    stickToBottom.current = true
    onSend(t, askSelection)
    setText('')
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = [...e.dataTransfer.files]
    if (!files.length) return
    // A single PDF in a session without a paper becomes the paper; anything else is extra material.
    const isPdf = files[0].type === 'application/pdf' || files[0].name.toLowerCase().endsWith('.pdf')
    if (canOpenPdf && files.length === 1 && isPdf) onOpenPdf(files[0])
    else onAddMaterials(files)
  }

  const empty = messages.length === 0 && !draft

  return (
    <div
      className={`chat${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="chat-head">
        <h1 title={session?.title}>{session?.title ?? 'New session'}</h1>
        {materials.length > 0 && (
          <div className="materials">
            <button
              className="materials-toggle"
              onClick={() => setShowMaterials((v) => !v)}
              aria-expanded={showMaterials}
              title="Extra files Claude can read"
            >
              📎 {materials.length} material{materials.length > 1 ? 's' : ''}
            </button>
            {showMaterials && (
              <div className="materials-list">
                <p className="muted small">Extra files for Claude. They are not shown here; Claude reads them.</p>
                <ul>
                  {materials.map((m) => (
                    <li key={m.id}>
                      <span className="material-name" title={m.filename}>
                        {m.filename}
                      </span>
                      <span className="muted small">{formatSize(m.size)}</span>
                      <button className="icon" onClick={() => onRemoveMaterial(m)} title="Remove" aria-label={`Remove ${m.filename}`}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </header>

      <div
        className="messages"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {empty && (
          <div className="empty">
            <h2>{session?.has_pdf ? 'What should Claude do with this paper?' : 'Read a paper with Claude'}</h2>
            {canOpenPdf && (
              <p className="muted">
                Open a PDF (or drop it here), or paste a link to a paper (arXiv, OpenReview, ACL Anthology, a DOI, …), then tell
                Claude what to look for. You can also just chat. With 📎 Materials you can give Claude extra files (other papers,
                notes, images…) to draw on.
              </p>
            )}
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => setText(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            hue={hues.get(m.id)}
            active={m.id === activeMessageId}
            found={found}
            onCite={onCite}
            onShowSelection={onShowSelection}
          />
        ))}
        {draft && <MessageView message={{ id: -1, role: 'assistant', error: null, ...draft }} hue={nextHue} streaming />}
        {!draft && session?.running && <div className="thinking">Claude is still answering…</div>}
      </div>

      <div className="composer">
        {askSelection && (
          <div className="ask-chip">
            <span className="ask-chip-label">Asking about p.{askSelection.page}</span>
            <span className="ask-chip-text">“{askSelection.text}”</span>
            <button className="icon" onClick={onClearAsk} title="Remove the passage" aria-label="Remove the passage">
              ×
            </button>
          </div>
        )}
        <textarea
          ref={textarea}
          value={text}
          placeholder={
            askSelection
              ? 'Ask about this passage… (leave empty to have it explained)'
              : session?.has_pdf
                ? 'Ask about the paper… (or select text in the PDF and click Ask Claude)'
                : 'Message Claude, or paste a link to a paper…'
          }
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-actions">
          {canOpenPdf && (
            <>
              <button onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? 'Opening…' : '📄 Open PDF'}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,.pdf"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onOpenPdf(f)
                  e.target.value = ''
                }}
              />
            </>
          )}
          <button
            onClick={() => materialInput.current?.click()}
            disabled={addingMaterials}
            title="Add extra files (other papers, notes, images, data…) for Claude to read"
          >
            {addingMaterials ? 'Adding…' : '📎 Materials'}
          </button>
          <input
            ref={materialInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              onAddMaterials([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <span className="spacer" />
          <span className="muted small">Enter to send · Shift+Enter for a new line</span>
          {busy ? (
            <button className="danger" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={submit} disabled={!text.trim() && !askSelection}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1 << 20) return `${Math.round(n / 1024)} KB`
  return `${(n / (1 << 20)).toFixed(1)} MB`
}
