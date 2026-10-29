export type Session = {
  id: string
  title: string
  pdf_filename: string | null
  has_pdf: boolean
  running?: boolean
  created_at: number
  updated_at: number
}

export type ToolCall = { name: string; summary: string }

/** A passage of the PDF; ranges: [itemIndex, start, end] in the page's text items. */
export type PdfSelection = {
  page: number
  ranges: [number, number, number][]
  text: string
}

export type Message = {
  id: number
  role: 'user' | 'assistant'
  text: string
  tools: ToolCall[]
  error: string | null
  selection: PdfSelection | null // the passage a question is about
  created_at: number
}

export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink', 'orange', 'purple'] as const
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]

/** A passage the user highlighted. ranges: [itemIndex, start, end] in the page's text items. */
export type UserHighlight = PdfSelection & { id: number; color: HighlightColor }

export type StreamEvent =
  | { type: 'started' }
  | { type: 'text'; text: string }
  | ({ type: 'tool' } & ToolCall)
  | { type: 'pdf' } // the paper was downloaded from a link in the message
  | { type: 'done'; message: Message }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init)
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* not JSON */
    }
    throw new Error(detail)
  }
  return res.json()
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  listSessions: () => request<Session[]>('/sessions'),
  createSession: () => request<Session>('/sessions', { method: 'POST' }),
  getSession: (id: string) =>
    request<{ session: Session; messages: Message[]; highlights: UserHighlight[] }>(`/sessions/${id}`),
  addHighlight: (id: string, h: Omit<UserHighlight, 'id'>) =>
    request<UserHighlight>(`/sessions/${id}/highlights`, json('POST', h)),
  recolorHighlight: (id: string, highlightId: number, color: HighlightColor) =>
    request<UserHighlight>(`/sessions/${id}/highlights/${highlightId}`, json('PATCH', { color })),
  deleteHighlight: (id: string, highlightId: number) =>
    request<{ ok: boolean }>(`/sessions/${id}/highlights/${highlightId}`, { method: 'DELETE' }),
  renameSession: (id: string, title: string) => request<Session>(`/sessions/${id}`, json('PATCH', { title })),
  deleteSession: (id: string) => request<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),
  stop: (id: string) => request<{ stopped: boolean }>(`/sessions/${id}/stop`, { method: 'POST' }),
  pdfUrl: (id: string) => `/api/sessions/${id}/pdf`,

  uploadPdf(id: string, file: File) {
    const form = new FormData()
    form.append('file', file)
    return request<Session>(`/sessions/${id}/pdf`, { method: 'POST', body: form })
  },

  /** Send a message and call onEvent for each streamed event until the answer is done. */
  async sendMessage(id: string, text: string, selection: PdfSelection | null, onEvent: (e: StreamEvent) => void) {
    const res = await fetch(`/api/sessions/${id}/messages`, json('POST', { text, selection }))
    if (!res.ok || !res.body) {
      let detail = res.statusText
      try {
        detail = (await res.json()).detail ?? detail
      } catch {
        /* not JSON */
      }
      throw new Error(detail)
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) onEvent(JSON.parse(line))
      }
    }
  },
}
