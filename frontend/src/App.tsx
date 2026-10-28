import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { api, type Message, type Session, type ToolCall } from './api'
import { buildPageIndex, citeHue, matchCitation, parseCitations, type Citation, type CitationMatch } from './citations'
import MessageView from './MessageView'
import PdfPane from './PdfPane'
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
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [split, setSplit] = useState(55) // PDF pane width in %
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageIndexes, setPageIndexes] = useState<ReturnType<typeof buildPageIndex>[] | null>(null)
  const [activeMessageId, setActiveMessageId] = useState<number | null>(null)
  const [focus, setFocus] = useState<{ key: string; nonce: number } | null>(null)
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId
  const createdHere = useRef<string | null>(null) // session just created by send/openPdf: keep its state

  const refreshSessions = useCallback(() => api.listSessions().then(setSessions).catch(() => {}), [])

  const loadSession = useCallback(async (id: string) => {
    const data = await api.getSession(id)
    if (currentIdRef.current !== id) return
    setSession(data.session)
    setMessages(data.messages)
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
    setDraft(null)
    setPdfDoc(null)
    setPageIndexes(null)
    setFocus(null)
    setActiveMessageId(null)
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

  async function send(text: string) {
    setError(null)
    let id: string | null = null
    try {
      id = await ensureSession()
      const sid = id
      const now = Date.now() / 1000
      setMessages((m) => [...m, { id: -2, role: 'user', text, tools: [], error: null, created_at: now }])
      setDraft({ text: '', tools: [] })
      await api.sendMessage(sid, text, (ev) => {
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
      onStop={() => currentId && api.stop(currentId)}
      onOpenPdf={openPdf}
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
                  onDocument={setPdfDoc}
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
  onSend: (text: string) => void
  onStop: () => void
  onOpenPdf: (file: File) => void
}

function ChatPane({ session, messages, draft, hues, nextHue, busy, uploading, activeMessageId, found, onCite, onSend, onStop, onOpenPdf }: ChatProps) {
  const [text, setText] = useState('')
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
    const t = text.trim()
    if (!t || busy) return
    stickToBottom.current = true
    onSend(t)
    setText('')
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file && canOpenPdf) onOpenPdf(file)
  }

  const empty = messages.length === 0 && !draft

  return (
    <div
      className={`chat${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        if (!canOpenPdf) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="chat-head">
        <h1 title={session?.title}>{session?.title ?? 'New session'}</h1>
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
                Claude what to look for. You can also just chat.
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
          <MessageView key={m.id} message={m} hue={hues.get(m.id)} active={m.id === activeMessageId} found={found} onCite={onCite} />
        ))}
        {draft && <MessageView message={{ id: -1, role: 'assistant', error: null, ...draft }} hue={nextHue} streaming />}
        {!draft && session?.running && <div className="thinking">Claude is still answering…</div>}
      </div>

      <div className="composer">
        <textarea
          value={text}
          placeholder={session?.has_pdf ? 'Ask about the paper…' : 'Message Claude, or paste a link to a paper…'}
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
          <span className="spacer" />
          <span className="muted small">Enter to send · Shift+Enter for a new line</span>
          {busy ? (
            <button className="danger" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={submit} disabled={!text.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
