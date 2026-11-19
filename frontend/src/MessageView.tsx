import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import type { Element, ElementContent } from 'hast'
import type { PluggableList } from 'unified'
import 'katex/dist/katex.min.css'
import { attachmentUrl, type Message, type PdfSelection, type ToolCall, type TraceStep } from './api'
import { citationsToMarkdown, parseCitations, type Citation } from './citations'
import { MediaFile, MermaidDiagram, PlotlyChart, mediaUrl } from './Media'

type Props = {
  message: Pick<Message, 'id' | 'role' | 'text' | 'tools' | 'trace' | 'error' | 'images'> & { selection?: PdfSelection | null }
  streaming?: boolean
  hue?: number // highlight color of this answer's quotes
  active?: boolean
  found?: (key: string) => boolean | undefined // undefined: not checked yet
  onCite?: (c: Citation) => void
  onShowSelection?: (s: PdfSelection) => void
  sessionId?: string // for images Claude saved in the session folder
  paperTitles?: Map<number, string> // titles of the session's papers, by number
}

/** The short label of a paper in quotes: nothing for the first paper, "P2 · " for paper 2. */
const paperPrefix = (paper: number | undefined) => (paper && paper !== 1 ? `P${paper} · ` : '')

/** "the PDF" while the session has one paper, else "paper N: title". */
function paperName(paper: number, titles: Map<number, string> | undefined): string {
  if (paper === 1 && (titles?.size ?? 0) <= 1) return 'the PDF'
  const title = titles?.get(paper)
  return `paper ${paper}${title ? `: ${title}` : ''}`
}

function citeTooltip(paper: number, titles: Map<number, string> | undefined, missing: boolean): string {
  if (!missing) return `Show in ${paperName(paper, titles)}`
  return titles?.has(paper) || paper === 1 ? 'This quote was not found in the PDF' : `Paper ${paper} is not open in this session`
}

function MessageView({ message, streaming, hue, active, found, onCite, onShowSelection, sessionId, paperTitles }: Props) {
  const { markdown, citations } = useMemo(
    () => parseCitations(message.text, message.id, streaming),
    [message.text, message.id, streaming],
  )

  const components: Components = useMemo(
    () => ({
      a({ href, children }) {
        if (href?.startsWith('#cite-')) {
          const c = citations.find((x) => x.key === href.slice(6))
          if (!c) return <>{children}</>
          const ok = found?.(c.key)
          return (
            <span
              role="button"
              tabIndex={0}
              className={`cite${ok === false ? ' missing' : ''}`}
              title={citeTooltip(c.paper, paperTitles, ok === false)}
              onClick={() => onCite?.(c)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onCite?.(c))}
            >
              “{children}”<sup>{paperPrefix(c.paper)}p.{c.page}</sup>
            </span>
          )
        }
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      },
      img({ src, alt }) {
        const url = mediaUrl(typeof src === 'string' ? src : undefined, sessionId, message.id)
        if (!url) return <span className="media-missing">[{alt || 'image'}]</span>
        // ![title](figures/x.plotly.json): an interactive chart stored in a file.
        if (/\.plotly\.json$/i.test(url.split('?')[0])) return streaming ? null : <PlotlyChart src={url} />
        return <MediaFile src={url} alt={alt ?? ''} />
      },
      pre({ node, children }) {
        // ```mermaid and ```plotly blocks become diagrams and charts (once the answer is complete).
        const code = node?.children[0]
        if (code?.type !== 'element' || code.tagName !== 'code') return <pre>{children}</pre>
        const classes = code.properties.className
        const lang = Array.isArray(classes)
          ? classes.map(String).find((c) => c.startsWith('language-'))?.slice(9)
          : undefined
        const text = hastText(code).replace(/\n$/, '')
        if (!streaming && lang === 'mermaid') return <MermaidDiagram code={text} />
        if (!streaming && lang === 'plotly') return <PlotlyChart spec={text} />
        return <CodeBlock lang={lang} text={text}>{children}</CodeBlock>
      },
    }),
    [citations, found, onCite, sessionId, message.id, streaming, paperTitles],
  )

  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">
          {message.selection && (
            <button
              className="quoted"
              onClick={() => onShowSelection?.(message.selection!)}
              title={`Show this passage in ${paperName(message.selection.paper ?? 1, paperTitles)}`}
            >
              <span className="quoted-page">
                {paperPrefix(message.selection.paper)}p.{message.selection.page}
              </span>
              <span className="quoted-text">“{message.selection.text}”</span>
            </button>
          )}
          {message.images && message.images.length > 0 && (
            <div className="msg-images">
              {message.images.map((name) => (
                <a key={name} href={attachmentUrl(sessionId, name)} target="_blank" rel="noreferrer" title="Open full size">
                  <img src={attachmentUrl(sessionId, name)} alt="Pasted image" loading="lazy" />
                </a>
              ))}
            </div>
          )}
          {message.text}
        </div>
      </div>
    )
  }

  return (
    <div className={`msg assistant${active ? ' active' : ''}`} style={hue === undefined ? undefined : ({ '--h': hue } as CSSProperties)}>
      {message.trace?.length ? (
        <Trace trace={message.trace} running={streaming} />
      ) : (
        message.tools.length > 0 && <Tools tools={message.tools} running={streaming} />
      )}
      {markdown && (
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={REHYPE_PLUGINS} components={components}>
            {markdown}
          </ReactMarkdown>
        </div>
      )}
      {streaming && !markdown && <div className="thinking">Claude is working…</div>}
      {message.error && <div className="msg-error">{message.error}</div>}
      {!streaming && message.text && <CopyButton text={message.text} />}
    </div>
  )
}

// Highlight fenced blocks that name a language (no guessing); mermaid and plotly stay plain text for the diagram and chart renderers.
const REHYPE_PLUGINS: PluggableList = [rehypeKatex, [rehypeHighlight, { detect: false, plainText: ['mermaid', 'plotly'] }]]

/** The text of a hast node, including the text inside highlight spans. */
function hastText(node: Element | ElementContent): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(hastText).join('')
  return ''
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard API unavailable (e.g. not a secure context): fall back to a hidden textarea.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

/** true for 1.5 s after mark() is called: the "Copied" state of a copy button. */
function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return [copied, () => setCopied(true)]
}

const CopyIcon = ({ copied, size = 14 }: { copied: boolean; size?: number }) =>
  copied ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  )

/** A fenced code block with a header: the language and a button that copies the code. */
function CodeBlock({ lang, text, children }: { lang?: string; text: string; children: ReactNode }) {
  const [copied, markCopied] = useCopied()
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang ?? 'text'}</span>
        <button
          className="code-copy"
          onClick={() => copyText(text).then(markCopied)}
          title={copied ? 'Copied' : 'Copy code'}
          aria-label="Copy code"
        >
          <CopyIcon copied={copied} />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

/** Copies the answer as Markdown (math stays as $…$ / $$…$$), so it renders when pasted into a Markdown app. */
function CopyButton({ text }: { text: string }) {
  const [copied, markCopied] = useCopied()
  return (
    <div className="msg-actions">
      <button
        className="msg-action"
        onClick={() => copyText(citationsToMarkdown(text)).then(markCopied)}
        title={copied ? 'Copied' : 'Copy as Markdown'}
        aria-label="Copy as Markdown"
      >
        <CopyIcon copied={copied} size={15} />
      </button>
    </div>
  )
}

function Tools({ tools, running }: { tools: ToolCall[]; running?: boolean }) {
  const last = tools[tools.length - 1]
  return (
    <details className="tools">
      <summary>
        {running ? `${last.name}${last.summary ? `: ${last.summary}` : ''}` : `Used ${tools.length} tool${tools.length > 1 ? 's' : ''}`}
      </summary>
      <ul>
        {tools.map((t, i) => (
          <li key={i}>
            <b>{t.name}</b> {t.summary && <code>{t.summary}</code>}
          </li>
        ))}
      </ul>
    </details>
  )
}

type ToolStep = Extract<TraceStep, { type: 'tool' }>
type ResultStep = Extract<TraceStep, { type: 'result' }>
type ByParent = Map<string | null, TraceStep[]>

/** Every step of an answer in order: text, thinking, tool calls with input and output, subagents. */
function Trace({ trace, running }: { trace: TraceStep[]; running?: boolean }) {
  const steps = trace.filter(Boolean) // a streamed trace can have a hole for a moment
  const byParent: ByParent = new Map()
  for (const s of steps) {
    if (s.type === 'result') continue
    const key = s.parent ?? null
    byParent.set(key, [...(byParent.get(key) ?? []), s])
  }
  const result = steps.find((s): s is ResultStep => s.type === 'result')
  const tools = steps.filter((s): s is ToolStep => s.type === 'tool')
  const failed = tools.filter((t) => t.is_error).length

  let label: string
  if (running) {
    const last = [...steps].reverse().find((s) => s.type !== 'result')
    label =
      last?.type === 'tool'
        ? `${last.name}${last.summary ? `: ${last.summary}` : ''}`
        : last?.type === 'thinking'
          ? 'Thinking…'
          : 'Writing…'
  } else {
    label = [
      `${tools.length} tool call${tools.length === 1 ? '' : 's'}`,
      failed ? `${failed} failed` : '',
      result?.duration_ms != null ? formatDuration(result.duration_ms) : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }

  return (
    <details className="trace">
      <summary>{label}</summary>
      <div className="trace-body">
        <Steps steps={byParent.get(null) ?? []} byParent={byParent} />
        {result && <ResultLine result={result} />}
      </div>
    </details>
  )
}

function Steps({ steps, byParent }: { steps: TraceStep[]; byParent: ByParent }) {
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={i}>
          <Step step={s} byParent={byParent} />
        </li>
      ))}
    </ol>
  )
}

function Step({ step, byParent }: { step: TraceStep; byParent: ByParent }) {
  if (step.type === 'text') return step.text.trim() ? <div className="step-text">{step.text.trim()}</div> : null
  if (step.type === 'thinking') {
    // Claude Code usually sends no thinking text in print mode, only that Claude thought.
    if (!step.text.trim()) return <div className="step-thinking">Thinking</div>
    return (
      <details className="step-thinking">
        <summary>Thinking</summary>
        <div className="step-text">{step.text.trim()}</div>
      </details>
    )
  }
  if (step.type !== 'tool') return null
  const status = step.result === null ? 'running' : step.is_error ? 'error' : 'ok'
  const sub = step.id ? byParent.get(step.id) : undefined
  return (
    <details className={`step-tool ${status}`}>
      <summary>
        <span className="step-dot" title={status} />
        <b>{step.name}</b> {step.summary && <code>{step.summary}</code>}
      </summary>
      <div className="step-detail">
        {Object.keys(step.input).length > 0 && (
          <>
            <div className="step-label">Input</div>
            <ToolInput input={step.input} />
          </>
        )}
        {sub && sub.length > 0 && (
          <>
            <div className="step-label">Subagent</div>
            <Steps steps={sub} byParent={byParent} />
          </>
        )}
        <div className={`step-label${step.is_error ? ' error' : ''}`}>{step.is_error ? 'Error' : 'Output'}</div>
        {step.result === null ? (
          <div className="step-pending">running…</div>
        ) : (
          <pre className="step-pre">{step.result || '(no output)'}</pre>
        )}
      </div>
    </details>
  )
}

/** Tool input as key / value rows; strings are shown as they are (commands, file contents), not JSON-escaped. */
function ToolInput({ input }: { input: Record<string, unknown> }) {
  return (
    <dl className="step-input">
      {Object.entries(input).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            <pre className="step-pre">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ResultLine({ result }: { result: ResultStep }) {
  const u = result.usage ?? {}
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  const parts = [
    result.model,
    result.num_turns != null ? `${result.num_turns} turn${result.num_turns === 1 ? '' : 's'}` : '',
    result.duration_ms != null ? formatDuration(result.duration_ms) : '',
    input || u.output_tokens ? `${formatTokens(input)} in / ${formatTokens(u.output_tokens ?? 0)} out tokens` : '',
    result.cost_usd != null ? `$${result.cost_usd.toFixed(result.cost_usd < 0.1 ? 3 : 2)}` : '',
    result.is_error ? 'ended with an error' : '',
  ].filter(Boolean)
  return <div className="trace-result">{parts.join(' · ')}</div>
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

const formatTokens = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`)

export default memo(MessageView)
