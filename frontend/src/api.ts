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

export type Message = {
  id: number
  role: 'user' | 'assistant'
  text: string
  tools: ToolCall[]
  error: string | null
  created_at: number
}

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
  getSession: (id: string) => request<{ session: Session; messages: Message[] }>(`/sessions/${id}`),
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
  async sendMessage(id: string, text: string, onEvent: (e: StreamEvent) => void) {
    const res = await fetch(`/api/sessions/${id}/messages`, json('POST', { text }))
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
