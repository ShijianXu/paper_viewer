import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type HighlightColor, type Material, type Message, type Paper, type PdfSelection, type Session, type SessionHit, type ToolCall, type TraceStep, type UserHighlight } from './api'
import {
  citeHue,
  matchCitation,
  parseCitations,
  resolveHighlight,
  type Citation,
  type CitationMatch,
  type PageIndex,
} from './citations'
import MessageView from './MessageView'
import PdfPane, { type AskMark, type PaneView, type ShownHighlight } from './PdfPane'
import PaperTabs from './PaperTabs'
import * as panes from './paneGroups'
import { loadPageIndexes } from './pdfText'
import './App.css'

type Draft = { text: string; tools: ToolCall[]; trace: TraceStep[] }
/** An image pasted into the composer; url: a blob: URL for its thumbnail. */
type PastedImage = { file: File; url: string }
const MAX_IMAGES = 10 // per message; the server allows as many
const MAX_IMAGE_MB = 10

/** Which paper a passage is in (1 for passages saved before there could be several). */
const paperOf = (s: { paper?: number }) => s.paper ?? 1

const NO_MATCHES = new Map<string, CitationMatch>()
const NO_HIGHLIGHTS: ShownHighlight[] = []

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
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [split, setSplit] = useState(55) // PDF area width in %
  const [papers, setPapers] = useState<Paper[]>([]) // papers opened next to the first one
  const [addingPaper, setAddingPaper] = useState(false)
  // The text of each paper (by number), for finding quotes; filled as the papers are indexed.
  const [pageIndexes, setPageIndexes] = useState<Map<number, PageIndex[]>>(() => new Map())
  const indexing = useRef(new Set<string>()) // `${session}:${paper}` being or already indexed
  // The PDF panes, one or two side by side, each with its own tabs (see paneGroups).
  const [groups, setGroups] = useState<panes.Group[]>([{ tabs: [1], shown: 1 }])
  const [activePane, setActivePane] = useState(0) // the pane last clicked into
  const [paneSplit, setPaneSplit] = useState(50) // width of the left pane in % of the PDF area
  const [chatHidden, setChatHidden] = useState(false)
  const [pdfDragOver, setPdfDragOver] = useState(false)
  const views = useRef(new Map<number, PaneView>()) // where each paper was left, by number
  const [activeMessageId, setActiveMessageId] = useState<number | null>(null)
  const [focus, setFocus] = useState<{ key: string; nonce: number; pane: number } | null>(null)
  const [askSelection, setAskSelection] = useState<PdfSelection | null>(null) // attached to the next question
  const [shownSelection, setShownSelection] = useState<{ selection: PdfSelection; nonce: number; pane: number } | null>(null)
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId
  const createdHere = useRef<string | null>(null) // session just created by send/openPdf: keep its state

  const refreshSessions = useCallback(() => api.listSessions().then(setSessions).catch(() => {}), [])

  // Searching sessions: titles are filtered at once, the server also looks in the chats etc.
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionHit[] | null>(null) // server results for `query`
  const searchRef = useRef<HTMLInputElement>(null)
  const terms = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query])
  useEffect(() => {
    if (!terms.length) return setHits(null)
    const ctrl = new AbortController()
    const timer = setTimeout(
      () => api.searchSessions(terms.join(' '), ctrl.signal).then(setHits).catch(() => {}),
      200,
    )
    return () => (clearTimeout(timer), ctrl.abort())
  }, [terms, sessions]) // sessions: search again after a rename, a delete, a new answer
  // Until the server answers, show the sessions whose title or file name matches.
  const shownSessions: (Session & { match?: SessionHit['match'] })[] = useMemo(() => {
    if (!terms.length) return sessions
    if (hits) return hits
    return sessions.filter((s) => {
      const hay = `${s.title} ${s.pdf_filename ?? ''}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [terms, hits, sessions])
  // Ctrl/Cmd+K: search sessions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSidebarOpen(true)
        requestAnimationFrame(() => searchRef.current?.select())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const loadSession = useCallback(async (id: string) => {
    const data = await api.getSession(id)
    if (currentIdRef.current !== id) return
    setSession(data.session)
    setMessages(data.messages)
    setHighlights(data.highlights)
    setMaterials(data.materials)
    setPapers(data.papers)
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
    setPapers([])
    setDraft(null)
    setPageIndexes(new Map())
    indexing.current.clear()
    views.current.clear()
    setGroups([{ tabs: [1], shown: 1 }])
    setActivePane(0)
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

  // Every paper of the session: the first one (paper.pdf), then those opened next to it.
  const allPapers = useMemo<Paper[]>(() => {
    if (!session?.has_pdf) return []
    const first = { num: 1, title: session.pdf_title || session.title, filename: session.pdf_filename ?? 'paper.pdf' }
    return [first, ...papers]
  }, [session?.has_pdf, session?.pdf_title, session?.title, session?.pdf_filename, papers])
  const paperTitles = useMemo(() => new Map(allPapers.map((p) => [p.num, p.title])), [allPapers])

  // The panes made valid for the session's papers, and the paper each one shows.
  const shownGroups = useMemo(() => panes.normalize(groups, allPapers.map((p) => p.num)), [groups, allPapers])
  const shownPanes = useMemo(() => shownGroups.map((g) => g.shown), [shownGroups])
  const groupsRef = useRef(shownGroups)
  groupsRef.current = shownGroups
  const activePaneRef = useRef(activePane)
  activePaneRef.current = Math.max(0, Math.min(activePane, shownGroups.length - 1))
  const paperTitlesRef = useRef(paperTitles)
  paperTitlesRef.current = paperTitles

  const changeGroups = useCallback((next: panes.Group[]) => {
    if (next.length === 2 && groupsRef.current.length === 1) setSplit((s) => Math.max(s, 68)) // room for two papers
    groupsRef.current = next
    setGroups(next)
  }, [])

  /** Make `paper` visible without changing what the user is reading; returns its pane. */
  const reveal = useCallback(
    (paper: number): number => {
      const { groups: next, pane } = panes.reveal(groupsRef.current, activePaneRef.current, paper)
      if (next !== groupsRef.current) changeGroups(next)
      return pane
    },
    [changeGroups],
  )

  // Index the text of every paper, for finding quotes, also of papers not shown.
  useEffect(() => {
    const sid = currentId
    if (!sid) return
    for (const p of allPapers) {
      const tag = `${sid}:${p.num}`
      if (indexing.current.has(tag)) continue
      indexing.current.add(tag)
      loadPageIndexes(api.paperUrl(sid, p.num))
        .then((idx) => currentIdRef.current === sid && setPageIndexes((m) => new Map(m).set(p.num, idx)))
        .catch(() => indexing.current.delete(tag)) // e.g. the session was deleted; try again next time
    }
  }, [currentId, allPapers])

  // Where each quote is: per paper, the quotes found in it; and which paper each quote names.
  const { matchesByPaper, citePaper } = useMemo(() => {
    const matchesByPaper = new Map<number, Map<string, CitationMatch>>()
    const citePaper = new Map<string, number>()
    for (const m of messages) {
      if (m.role !== 'assistant') continue
      for (const c of parseCitations(m.text, m.id).citations) {
        citePaper.set(c.key, c.paper)
        const index = pageIndexes.get(c.paper)
        const hit = index && matchCitation(c, index)
        if (!hit) continue
        if (!matchesByPaper.has(c.paper)) matchesByPaper.set(c.paper, new Map())
        matchesByPaper.get(c.paper)!.set(c.key, hit)
      }
    }
    return { matchesByPaper, citePaper }
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

  // The user's own highlights, placed on the text of their papers.
  const highlightsByPaper = useMemo(() => {
    const out = new Map<number, ShownHighlight[]>()
    for (const h of highlights) {
      const index = pageIndexes.get(paperOf(h))
      const match = index && resolveHighlight(h, index)
      if (!match) continue
      if (!out.has(paperOf(h))) out.set(paperOf(h), [])
      out.get(paperOf(h))!.push({ id: h.id, color: h.color, text: h.text, match })
    }
    return out
  }, [highlights, pageIndexes])

  // The passage marked with a dashed outline, per pane: one the user clicked in a sent
  // question (shown for a few seconds, scrolled to in its pane), else the one attached
  // to the next question.
  const askMarks = useMemo<(AskMark | null)[]>(() => {
    const target = shownSelection?.selection ?? askSelection
    const index = target && pageIndexes.get(paperOf(target))
    const match = target && index && resolveHighlight(target, index)
    return shownPanes.map((num, i) =>
      match && paperOf(target) === num
        ? { match, nonce: shownSelection?.nonce ?? 0, scroll: !!shownSelection && shownSelection.pane === i }
        : null,
    )
  }, [shownSelection, askSelection, pageIndexes, shownPanes])

  useEffect(() => {
    if (!shownSelection) return
    const timer = setTimeout(() => setShownSelection(null), 3000)
    return () => clearTimeout(timer)
  }, [shownSelection])

  const showSelection = useCallback(
    (selection: PdfSelection) => {
      if (!paperTitlesRef.current.has(paperOf(selection))) return // that paper was removed
      setShownSelection({ selection, nonce: Date.now(), pane: reveal(paperOf(selection)) })
    },
    [reveal],
  )

  const createHighlight = useCallback(
    (h: PdfSelection & { paper: number }, color: HighlightColor) => {
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

  // Whether a quote was found in its paper; undefined until that paper is indexed.
  const found = useCallback(
    (key: string) => {
      const paper = citePaper.get(key)
      if (paper === undefined || !paperTitles.size) return undefined
      if (!paperTitles.has(paper)) return false // a paper that isn't (or is no longer) in the session
      return pageIndexes.has(paper) ? !!matchesByPaper.get(paper)?.has(key) : undefined
    },
    [citePaper, paperTitles, pageIndexes, matchesByPaper],
  )

  const onCite = useCallback(
    (c: Citation) => {
      setActiveMessageId(c.messageId)
      if (!paperTitlesRef.current.has(c.paper)) return
      setFocus({ key: c.key, nonce: Date.now(), pane: reveal(c.paper) })
    },
    [reveal],
  )

  /** Show another paper in a pane (a click on one of its tabs). */
  const selectPaper = (pane: number, num: number) => {
    setActivePane(pane)
    if (shownPanes[pane] === num) return
    changeGroups(panes.show(shownGroups, pane, num))
    setFocus((f) => (f?.pane === pane ? null : f))
  }

  /** A tab dragged onto the tabs of pane `pane`. */
  const moveTab = (num: number, pane: number) => {
    const next = panes.moveTo(shownGroups, num, pane)
    changeGroups(next)
    setActivePane(Math.max(0, next.findIndex((g) => g.tabs.includes(num))))
    setFocus(null)
  }

  const splitPanes = () => {
    const next = panes.split(shownGroups, 0)
    if (!next) return
    changeGroups(next)
    setActivePane(1)
  }

  const closePane = (pane: number) => {
    changeGroups(panes.close(shownGroups, pane))
    setActivePane(0)
    setFocus(null)
  }

  // Papers added go to `pane` (the pane whose + was used), else beside the pane being read.
  async function addPapers(files: File[], pane?: number) {
    const sid = currentIdRef.current
    if (!sid || !files.length) return
    setError(null)
    setAddingPaper(true)
    const failed: string[] = []
    for (const f of files) {
      try {
        const added = await api.addPaper(sid, f)
        if (currentIdRef.current !== sid) continue
        setPapers((all) => [...all, added])
        showNewPaper(added.num, pane)
      } catch (e) {
        failed.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setAddingPaper(false)
    if (currentIdRef.current !== sid) return
    if (failed.length) setError(`Could not open ${failed.length === 1 ? 'a paper' : `${failed.length} papers`}: ${failed.join('; ')}`)
  }

  async function addPaperFromLink(url: string, pane?: number) {
    const sid = currentIdRef.current
    if (!sid) return
    setError(null)
    setAddingPaper(true)
    try {
      const added = await api.addPaperFromLink(sid, url)
      if (currentIdRef.current !== sid) return
      setPapers((all) => [...all, added])
      showNewPaper(added.num, pane)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setAddingPaper(false)
    }
  }

  async function openMaterialAsPaper(m: Material, pane?: number) {
    const sid = currentIdRef.current
    if (!sid) return
    setError(null)
    setAddingPaper(true)
    try {
      const added = await api.openMaterialAsPaper(sid, m.id)
      if (currentIdRef.current !== sid) return
      setPapers((all) => [...all, added])
      setMaterials((all) => all.filter((x) => x.id !== m.id))
      showNewPaper(added.num, pane)
    } catch (e) {
      setError(`Could not open ${m.filename}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAddingPaper(false)
    }
  }

  /** A paper was just added: open it in `pane` if there are two panes, else beside the one
   * being read (in a second pane, opened if needed). */
  function showNewPaper(num: number, pane?: number) {
    const cur = groupsRef.current
    const target = cur.length === 1 ? 1 : (pane ?? 1 - activePaneRef.current)
    changeGroups(panes.moveTo(cur, num, target))
    setActivePane(target)
  }

  async function removePaper(num: number) {
    const sid = currentIdRef.current
    const title = paperTitles.get(num)
    if (!sid || num === 1) return
    if (!confirm(`Remove paper ${num}${title ? ` “${title}”` : ''} from this session? Your highlights in it are removed too.`)) return
    try {
      await api.removePaper(sid, num)
      if (currentIdRef.current !== sid) return
      setPapers((all) => all.filter((p) => p.num !== num))
      // panes.normalize drops it from its pane, and the pane if that was its only paper.
      setHighlights((all) => all.filter((h) => paperOf(h) !== num))
      setAskSelection((s) => (s && paperOf(s) === num ? null : s))
      views.current.delete(num)
    } catch (e) {
      setError(`Could not remove the paper: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Files dropped on the PDFs: PDFs are opened as papers, anything else becomes a material. */
  function dropOnPdfs(e: React.DragEvent) {
    e.preventDefault()
    setPdfDragOver(false)
    const files = [...e.dataTransfer.files]
    const isPdf = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    const pdfs = files.filter(isPdf)
    const others = files.filter((f) => !isPdf(f))
    if (pdfs.length) addPapers(pdfs)
    if (others.length) addMaterials(others)
  }

  async function ensureSession(): Promise<string> {
    if (currentId) return currentId
    const s = await api.createSession()
    selectSession(s.id)
    createdHere.current = s.id // its state is already known; skip loading it
    setSession(s)
    refreshSessions()
    return s.id
  }

  async function send(text: string, selection: PdfSelection | null, images: PastedImage[] = []) {
    setError(null)
    setAskSelection(null)
    let id: string | null = null
    try {
      id = await ensureSession()
      const sid = id
      const now = Date.now() / 1000
      const user: Message = {
        id: -2, role: 'user', text, tools: [], error: null, selection, images: images.map((i) => i.url), created_at: now,
      }
      setMessages((m) => [...m, user])
      setDraft({ text: '', tools: [], trace: [] })
      await api.sendMessage(sid, text, selection, images.map((i) => i.file), (ev) => {
        if (currentIdRef.current !== sid) return
        if (ev.type === 'text') setDraft((d) => d && { ...d, text: d.text + ev.text })
        else if (ev.type === 'tool') setDraft((d) => d && { ...d, tools: [...d.tools, { name: ev.name, summary: ev.summary }] })
        else if (ev.type === 'step')
          setDraft((d) => {
            if (!d) return d
            const trace = d.trace.slice()
            trace[ev.index] = { ...ev.step }
            return { ...d, trace }
          })
        else if (ev.type === 'step_delta')
          setDraft((d) => {
            const step = d?.trace[ev.index]
            if (!d || !step || (step.type !== 'text' && step.type !== 'thinking')) return d
            const trace = d.trace.slice()
            trace[ev.index] = { ...step, text: step.text + ev.text }
            return { ...d, trace }
          })
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
      onOpenMaterial={session?.has_pdf ? openMaterialAsPaper : undefined}
      paperTitles={paperTitles}
    />
  )

  const twoPanes = shownPanes.length === 2
  const pdfPane = (num: number, i: number) => {
    const sid = session!.id
    const paneFocus = focus && focus.pane === i && citePaper.get(focus.key) === num ? focus : null
    return (
      <div
        key={i}
        className={`pdf-group${twoPanes && i === activePaneRef.current ? ' active' : ''}`}
        style={twoPanes && i === 0 ? { width: `${paneSplit}%`, flex: 'none' } : undefined}
      >
        <PaperTabs
          papers={allPapers.filter((p) => shownGroups[i].tabs.includes(p.num))}
          current={num}
          onSelect={(n) => selectPaper(i, n)}
          onDropTab={twoPanes ? (n) => moveTab(n, i) : undefined}
          onRemove={removePaper}
          adding={addingPaper}
          onAddFiles={(files) => addPapers(files, i)}
          onAddLink={(url) => addPaperFromLink(url, i)}
          pdfMaterials={materials.filter((m) => m.filename.toLowerCase().endsWith('.pdf'))}
          onOpenMaterial={(m) => openMaterialAsPaper(m, i)}
        >
          {twoPanes ? (
            <button className="icon" onClick={() => closePane(i)} title="Close this pane" aria-label="Close this pane">
              ×
            </button>
          ) : (
            <button
              className="icon"
              onClick={splitPanes}
              disabled={shownGroups[0].tabs.length < 2}
              title={shownGroups[0].tabs.length < 2 ? 'Open another paper (+) to see two side by side' : 'Show two papers side by side'}
              aria-label="Split"
            >
              ◫
            </button>
          )}
          {i === shownPanes.length - 1 && (
            <button
              className="icon"
              onClick={() => setChatHidden((h) => !h)}
              title={chatHidden ? 'Show the chat' : 'Hide the chat (more room for the papers)'}
              aria-label={chatHidden ? 'Show the chat' : 'Hide the chat'}
            >
              {chatHidden ? '💬' : '⇥'}
            </button>
          )}
        </PaperTabs>
        {/* keyed by session, pane and paper: each paper gets a fresh viewer, back where it was left */}
        <ErrorBoundary key={`${sid}:${i}:${num}`} fallback={<div className="pdf-message">The PDF viewer failed. Reload the page to try again.</div>}>
          <PdfPane
            url={api.paperUrl(sid, num)}
            matches={matchesByPaper.get(num) ?? NO_MATCHES}
            hues={hues}
            activeMessageId={activeMessageId}
            focus={paneFocus}
            userHighlights={highlightsByPaper.get(num) ?? NO_HIGHLIGHTS}
            askMark={askMarks[i]}
            view={views.current.get(num)}
            onView={(v) => views.current.set(num, v)}
            onActivate={() => setActivePane(i)}
            onAsk={(sel) => setAskSelection({ ...sel, paper: num })}
            onCreateHighlight={(h, color) => createHighlight({ ...h, paper: num }, color)}
            onRecolorHighlight={recolorHighlight}
            onDeleteHighlight={deleteHighlight}
          />
        </ErrorBoundary>
      </div>
    )
  }

  return (
    <div className="app">
      {sidebarOpen && (
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />
          <div className="sidebar-head">
            <button className="primary" onClick={() => selectSession(null)}>
              + New session
            </button>
            <button className="icon" onClick={() => setSidebarOpen(false)} title="Hide sessions" aria-label="Hide sessions">
              «
            </button>
          </div>
          <div className="session-search">
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Search sessions (Ctrl+K)"
              aria-label="Search sessions"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
                else if (e.key === 'Enter' && shownSessions[0]) selectSession(shownSessions[0].id)
              }}
            />
          </div>
          <nav className="session-list">
            {sessions.length === 0 && <p className="muted small">No sessions yet.</p>}
            {sessions.length > 0 && terms.length > 0 && shownSessions.length === 0 && (
              <p className="muted small">{hits ? 'No matching sessions.' : 'Searching…'}</p>
            )}
            {shownSessions.map((s) => (
              <div
                key={s.id}
                className={`session-item${s.id === currentId ? ' current' : ''}`}
                onClick={() => selectSession(s.id)}
                onDoubleClick={() => renameSession(s)}
                title={s.title}
              >
                <span className="session-title">
                  {s.has_pdf ? '📄 ' : ''}
                  <Marked text={s.title} terms={terms} />
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
                {s.match && s.match.where !== 'title' && (
                  <span className="session-match">
                    <span className="session-match-where">{MATCH_LABELS[s.match.where]}</span>{' '}
                    <Marked text={s.match.snippet} terms={terms} />
                  </span>
                )}
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
            <div className="split-left" style={chatHidden ? { flex: 1 } : { width: `${split}%` }}>
              <div
                className={`pdf-area${pdfDragOver ? ' drag-over' : ''}`}
                onDragOver={(e) => {
                  if (![...e.dataTransfer.types].includes('Files')) return
                  e.preventDefault()
                  setPdfDragOver(true)
                }}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setPdfDragOver(false)}
                onDrop={dropOnPdfs}
              >
                {pdfPane(shownPanes[0], 0)}
                {twoPanes && <Divider onDrag={setPaneSplit} />}
                {twoPanes && pdfPane(shownPanes[1], 1)}
              </div>
            </div>
            {!chatHidden && (
              <>
                <Divider onDrag={setSplit} />
                <div className="split-right">{chat}</div>
              </>
            )}
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

const SIDEBAR_WIDTH = { default: 260, min: 180, max: 640 }
const MATCH_LABELS: Record<SessionHit['match']['where'], string> = {
  title: 'Title',
  file: 'File',
  highlight: 'Highlight',
  material: 'Material',
  question: 'You',
  answer: 'Claude',
}

/** text with every occurrence of the (lower-case) search terms marked. */
function Marked({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return text
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'gi'))
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))
}

const SIDEBAR_WIDTH_KEY = 'paper-viewer.sidebar-width'

function loadSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    if (saved >= SIDEBAR_WIDTH.min && saved <= SIDEBAR_WIDTH.max) return saved
  } catch {
    /* storage unavailable */
  }
  return SIDEBAR_WIDTH.default
}

/** Drag handle on the sidebar's right edge; double-click resets the width. The width is remembered. */
function SidebarResizer({ width, onResize }: { width: number; onResize: (px: number) => void }) {
  const save = (px: number) => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(px))
    } catch {
      /* storage unavailable */
    }
  }
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    let current = width
    const move = (ev: PointerEvent) => {
      const max = Math.min(SIDEBAR_WIDTH.max, window.innerWidth * 0.5)
      current = Math.round(Math.min(max, Math.max(SIDEBAR_WIDTH.min, width + ev.clientX - startX)))
      onResize(current)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('dragging')
      save(current)
    }
    document.body.classList.add('dragging')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const reset = () => {
    onResize(SIDEBAR_WIDTH.default)
    save(SIDEBAR_WIDTH.default)
  }
  return (
    <div
      className="sidebar-resizer"
      onPointerDown={start}
      onDoubleClick={reset}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the session list"
      title="Drag to resize · double-click to reset"
    />
  )
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
  onSend: (text: string, selection: PdfSelection | null, images: PastedImage[]) => void
  askSelection: PdfSelection | null
  onClearAsk: () => void
  onShowSelection: (s: PdfSelection) => void
  onStop: () => void
  onOpenPdf: (file: File) => void
  materials: Material[]
  addingMaterials: boolean
  onAddMaterials: (files: File[]) => void
  onRemoveMaterial: (m: Material) => void
  onOpenMaterial?: (m: Material) => void // show a PDF material as a paper
  paperTitles: Map<number, string>
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
  onOpenMaterial,
  paperTitles,
}: ChatProps) {
  const materialInput = useRef<HTMLInputElement>(null)
  const [showMaterials, setShowMaterials] = useState(false)
  const [text, setText] = useState('')
  const [images, setImages] = useState<PastedImage[]>([])
  const [pasteError, setPasteError] = useState<string | null>(null)
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
    if ((!t && !images.length) || busy) return
    stickToBottom.current = true
    onSend(t, askSelection, images) // the sent message keeps showing the blob: URLs until it reloads
    setText('')
    setImages([])
    setPasteError(null)
  }

  // Ctrl+V of an image (a screenshot, a crop…) attaches it to the message, like in Claude Code.
  const onPaste = (e: React.ClipboardEvent) => {
    const items = [...e.clipboardData.items]
    const files = items
      .filter((i) => i.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(i.type))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f)
    if (!files.length) return
    // Copying from some apps (office suites, web pages) puts text and a picture of it on the clipboard:
    // then paste the text as usual, unless the clipboard holds nothing else.
    if (items.some((i) => i.kind === 'string' && i.type === 'text/plain')) return
    e.preventDefault()
    const tooBig = files.filter((f) => f.size > MAX_IMAGE_MB << 20)
    const room = MAX_IMAGES - images.length
    const ok = files.filter((f) => f.size <= MAX_IMAGE_MB << 20).slice(0, Math.max(room, 0))
    setPasteError(
      tooBig.length
        ? `Images larger than ${MAX_IMAGE_MB} MB can't be attached.`
        : ok.length < files.length
          ? `At most ${MAX_IMAGES} images per message.`
          : null,
    )
    setImages((cur) => [...cur, ...ok.map((file) => ({ file, url: URL.createObjectURL(file) }))])
  }

  const removeImage = (img: PastedImage) => {
    URL.revokeObjectURL(img.url)
    setImages((cur) => cur.filter((i) => i !== img))
    setPasteError(null)
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
                      {onOpenMaterial && m.filename.toLowerCase().endsWith('.pdf') && (
                        <button
                          className="icon"
                          onClick={() => onOpenMaterial(m)}
                          title="Show this PDF as a paper, next to the others (Claude can then quote it)"
                          aria-label={`Open ${m.filename} as a paper`}
                        >
                          📄
                        </button>
                      )}
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
            sessionId={session?.id}
            paperTitles={paperTitles}
          />
        ))}
        {draft && (
          <MessageView
            message={{ id: -1, role: 'assistant', error: null, ...draft }}
            hue={nextHue}
            sessionId={session?.id}
            paperTitles={paperTitles}
            streaming
          />
        )}
        {!draft && session?.running && <div className="thinking">Claude is still answering…</div>}
      </div>

      <div className="composer">
        {askSelection && (
          <div className="ask-chip">
            <span className="ask-chip-label" title={paperTitles.size > 1 ? paperTitles.get(paperOf(askSelection)) : undefined}>
              Asking about {paperTitles.size > 1 ? `paper ${paperOf(askSelection)}, ` : ''}p.{askSelection.page}
            </span>
            <span className="ask-chip-text">“{askSelection.text}”</span>
            <button className="icon" onClick={onClearAsk} title="Remove the passage" aria-label="Remove the passage">
              ×
            </button>
          </div>
        )}
        {images.length > 0 && (
          <div className="pasted-images">
            {images.map((img, i) => (
              <div className="pasted-image" key={img.url}>
                <a href={img.url} target="_blank" rel="noreferrer" title="Open full size">
                  <img src={img.url} alt={`Pasted image ${i + 1}`} />
                </a>
                <button className="icon" onClick={() => removeImage(img)} title="Remove the image" aria-label={`Remove image ${i + 1}`}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {pasteError && <div className="paste-error small">{pasteError}</div>}
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
          onPaste={onPaste}
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
          <span className="muted small">Enter to send · Shift+Enter for a new line · Ctrl+V to attach an image</span>
          {busy ? (
            <button className="danger" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={submit} disabled={!text.trim() && !askSelection && !images.length}>
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
