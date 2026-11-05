import { memo, useMemo, type CSSProperties } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { Message, PdfSelection, ToolCall } from './api'
import { parseCitations, type Citation } from './citations'
import { MediaFile, MermaidDiagram, mediaUrl } from './Media'

type Props = {
  message: Pick<Message, 'id' | 'role' | 'text' | 'tools' | 'error'> & { selection?: PdfSelection | null }
  streaming?: boolean
  hue?: number // highlight color of this answer's quotes
  active?: boolean
  found?: (key: string) => boolean | undefined // undefined: not checked yet
  onCite?: (c: Citation) => void
  onShowSelection?: (s: PdfSelection) => void
  sessionId?: string // for images Claude saved in the session folder
}

function MessageView({ message, streaming, hue, active, found, onCite, onShowSelection, sessionId }: Props) {
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
              title={ok === false ? 'This quote was not found in the PDF' : 'Show in the PDF'}
              onClick={() => onCite?.(c)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onCite?.(c))}
            >
              “{children}”<sup>p.{c.page}</sup>
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
        return url ? <MediaFile src={url} alt={alt ?? ''} /> : <span className="media-missing">[{alt || 'image'}]</span>
      },
      pre({ node, children }) {
        // ```mermaid blocks become diagrams (once the answer is complete).
        const code = node?.children[0]
        const classes = code?.type === 'element' ? code.properties.className : undefined
        if (!streaming && Array.isArray(classes) && classes.includes('language-mermaid') && code?.type === 'element') {
          const text = code.children.map((c) => (c.type === 'text' ? c.value : '')).join('')
          return <MermaidDiagram code={text} />
        }
        return <pre>{children}</pre>
      },
    }),
    [citations, found, onCite, sessionId, message.id, streaming],
  )

  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">
          {message.selection && (
            <button
              className="quoted"
              onClick={() => onShowSelection?.(message.selection!)}
              title="Show this passage in the PDF"
            >
              <span className="quoted-page">p.{message.selection.page}</span>
              <span className="quoted-text">“{message.selection.text}”</span>
            </button>
          )}
          {message.text}
        </div>
      </div>
    )
  }

  return (
    <div className={`msg assistant${active ? ' active' : ''}`} style={hue === undefined ? undefined : ({ '--h': hue } as CSSProperties)}>
      {message.tools.length > 0 && <Tools tools={message.tools} running={streaming} />}
      {markdown && (
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
            {markdown}
          </ReactMarkdown>
        </div>
      )}
      {streaming && !markdown && <div className="thinking">Claude is working…</div>}
      {message.error && <div className="msg-error">{message.error}</div>}
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

export default memo(MessageView)
