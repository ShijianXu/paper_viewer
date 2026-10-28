import { memo, useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { Message, ToolCall } from './api'
import { parseCitations, type Citation } from './citations'

type Props = {
  message: Pick<Message, 'id' | 'role' | 'text' | 'tools' | 'error'>
  streaming?: boolean
  active?: boolean
  found?: (key: string) => boolean | undefined // undefined: not checked yet
  onCite?: (c: Citation) => void
}

function MessageView({ message, streaming, active, found, onCite }: Props) {
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
    }),
    [citations, found, onCite],
  )

  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">{message.text}</div>
      </div>
    )
  }

  return (
    <div className={`msg assistant${active ? ' active' : ''}`}>
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
