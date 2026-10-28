// Citations: Claude writes <cite page="N">verbatim quote</cite> in its answers.
// This module parses them out of message text and finds each quote in the PDF's text.

export type Citation = {
  key: string // unique within the session: `${messageId}:${index}`
  messageId: number
  page: number // 1-based, as Claude wrote it
  quote: string
}

/** Where a quote was found: the page and, per text item, the character ranges to mark. */
export type CitationMatch = {
  page: number
  ranges: Map<number, [number, number][]>
}

const CITE_RE = /<cite\s+page\s*=\s*["']?(\d+)["']?\s*>([\s\S]*?)<\/cite>/g

/** Turn cite tags into Markdown links `[quote](#cite-key)` and collect the citations. */
export function parseCitations(
  text: string,
  messageId: number,
  streaming = false,
): { markdown: string; citations: Citation[] } {
  if (streaming) text = hidePartialCite(text)
  const citations: Citation[] = []
  const markdown = text.replace(CITE_RE, (_m, page: string, quote: string) => {
    const key = `${messageId}:${citations.length}`
    const q = quote.replace(/\s+/g, ' ').trim()
    citations.push({ key, messageId, page: Number(page), quote: q })
    return `[${q.replace(/[\\`*_[\]$<>]/g, '\\$&')}](#cite-${key})`
  })
  return { markdown, citations }
}

/** While streaming, don't show a cite tag until it is complete. */
function hidePartialCite(text: string): string {
  const open = text.lastIndexOf('<cite')
  if (open !== -1 && text.indexOf('</cite>', open) === -1) return text.slice(0, open)
  return text.replace(/<(c(i(t(e)?)?)?)?$/, '')
}

// ---------------------------------------------------------------- matching

type PageIndex = {
  norm: string // letters and digits only, lowercased
  map: [number, number, number][] // per norm char: [itemIndex, charStart, charEnd] in the original item
}

const KEEP = /[\p{L}\p{N}]/u

function normalizeInto(s: string, onChar: (c: string, start: number, end: number) => void) {
  let i = 0
  for (const ch of s) {
    const start = i
    i += ch.length
    for (const c of ch.normalize('NFKC').toLowerCase()) {
      if (KEEP.test(c)) onChar(c, start, i)
    }
  }
}

function normalize(s: string): string {
  let out = ''
  normalizeInto(s, (c) => (out += c))
  return out
}

/** Build a searchable index of one page's text items (from page.getTextContent()). */
export function buildPageIndex(items: { str?: string }[]): PageIndex {
  let norm = ''
  const map: PageIndex['map'] = []
  items.forEach((item, itemIndex) => {
    if (!item.str) return
    normalizeInto(item.str, (c, start, end) => {
      norm += c
      map.push([itemIndex, start, end])
    })
  })
  return { norm, map }
}

/** Find a range [from, to) of the normalized page text that matches the quote. */
function locate(norm: string, q: string): [number, number] | null {
  if (q.length < 4) return null
  const exact = norm.indexOf(q)
  if (exact !== -1) return [exact, exact + q.length]
  // Tolerate small differences in the middle (a paraphrased word, a dropped
  // footnote mark): match the start and the end of the quote separately.
  if (q.length < 40) return null
  const n = 20
  const head = norm.indexOf(q.slice(0, n))
  if (head === -1) return null
  const tail = norm.indexOf(q.slice(-n), head + n)
  if (tail === -1 || tail + n - head > q.length * 1.5) return null
  return [head, tail + n]
}

/** Per text item, the span from the first to the last matched character (spaces included). */
function toRanges(index: PageIndex, [from, to]: [number, number]): CitationMatch['ranges'] {
  const ranges = new Map<number, [number, number][]>()
  for (let i = from; i < to; i++) {
    const [item, start, end] = index.map[i]
    const span = ranges.get(item)?.[0]
    if (span) span[1] = end
    else ranges.set(item, [[start, end]])
  }
  return ranges
}

/** Look for the quote on the cited page first, then its neighbours, then everywhere. */
export function matchCitation(c: Citation, pages: PageIndex[]): CitationMatch | null {
  const q = normalize(c.quote)
  const order = [c.page, c.page - 1, c.page + 1]
  for (let p = 1; p <= pages.length; p++) if (!order.includes(p)) order.push(p)
  for (const p of order) {
    const index = pages[p - 1]
    if (!index) continue
    const hit = locate(index.norm, q)
    if (hit) return { page: p, ranges: toRanges(index, hit) }
  }
  return null
}

// ---------------------------------------------------------------- rendering

export type Mark = { key: string; active: boolean }

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** HTML for one text item with <mark> elements around the highlighted ranges. */
export function markItem(str: string, marks: { range: [number, number]; mark: Mark }[]): string {
  if (!marks.length) return escapeHtml(str)
  // Per character, the mark to show; an active citation wins over a faded one.
  const owner: (Mark | null)[] = new Array(str.length).fill(null)
  for (const { range, mark } of marks) {
    for (let i = range[0]; i < Math.min(range[1], str.length); i++) {
      if (!owner[i] || (mark.active && !owner[i]!.active)) owner[i] = mark
    }
  }
  let html = ''
  let i = 0
  while (i < str.length) {
    const m = owner[i]
    let j = i + 1
    while (j < str.length && owner[j] === m) j++
    const text = escapeHtml(str.slice(i, j))
    html += m
      ? `<mark class="cite-mark${m.active ? ' active' : ''}" data-cite="${m.key}">${text}</mark>`
      : text
    i = j
  }
  return html
}
