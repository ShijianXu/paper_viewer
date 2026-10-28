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

export type PageIndex = {
  items: string[] // text of each item, as rendered in the text layer
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
  return { items: items.map((i) => i.str ?? ''), norm, map }
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

/** Where a saved user highlight is now: its stored ranges if they still hold its
 * text, else its text found again on the same page (e.g. after a pdf.js update
 * split the text into items differently). */
export function resolveHighlight(
  h: { page: number; ranges: [number, number, number][]; text: string },
  pages: PageIndex[],
): CitationMatch | null {
  const index = pages[h.page - 1]
  if (!index) return null
  const want = normalize(h.text)
  const stored = h.ranges.map(([item, start, end]) => (index.items[item] ?? '').slice(start, end)).join('')
  if (want && normalize(stored) === want) {
    const ranges = new Map<number, [number, number][]>()
    for (const [item, start, end] of h.ranges) ranges.set(item, [[start, end]])
    return { page: h.page, ranges }
  }
  const hit = locate(index.norm, want)
  return hit ? { page: h.page, ranges: toRanges(index, hit) } : null
}

// ---------------------------------------------------------------- colors

// Hues for the 1st, 2nd, ... answer with quotes: well separated, and readable as
// translucent highlights on a white page. After these, the golden angle keeps
// each new hue far from the ones just before it.
const HUES = [48, 130, 205, 330, 25, 270, 175, 0, 90, 235]

export function citeHue(answerIndex: number): number {
  if (answerIndex < HUES.length) return HUES[answerIndex]
  return Math.round((HUES[HUES.length - 1] + (answerIndex - HUES.length + 1) * 137.508) % 360)
}

// ---------------------------------------------------------------- rendering

export type Mark = { key: string; active: boolean; hue: number } // a citation of Claude's
export type UserMark = { id: number; color: string } // a highlight made by the user

export type ItemMarks = {
  cites: { range: [number, number]; mark: Mark }[]
  users: { range: [number, number]; mark: UserMark }[]
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** HTML for one text item, with <mark> elements around the highlighted ranges.
 *
 * Only <mark> elements are used: pdf.js positions every <span> of the text
 * layer absolutely, so spans can't be nested. Each item starts with an empty
 * <mark class="ti"> carrying its index, so a selection can be mapped back to
 * the item. User highlights wrap citation highlights where they overlap. */
export function markItem(itemIndex: number, str: string, { cites, users }: ItemMarks): string {
  const tag = `<mark class="ti" data-i="${itemIndex}"></mark>`
  if (!cites.length && !users.length) return tag + escapeHtml(str)
  // Per character, the citation to show (an active one wins over a faded one)
  // and the user highlight (the newest wins).
  const cite: (Mark | null)[] = new Array(str.length).fill(null)
  const user: (UserMark | null)[] = new Array(str.length).fill(null)
  for (const { range, mark } of cites) {
    for (let i = range[0]; i < Math.min(range[1], str.length); i++) {
      if (!cite[i] || (mark.active && !cite[i]!.active)) cite[i] = mark
    }
  }
  for (const { range, mark } of users) {
    for (let i = range[0]; i < Math.min(range[1], str.length); i++) {
      if (!user[i] || mark.id > user[i]!.id) user[i] = mark
    }
  }
  let html = tag
  let i = 0
  while (i < str.length) {
    const c = cite[i]
    const u = user[i]
    let j = i + 1
    while (j < str.length && cite[j] === c && user[j] === u) j++
    let text = escapeHtml(str.slice(i, j))
    if (c) text = `<mark class="cite-mark${c.active ? ' active' : ''}" data-cite="${c.key}" style="--h: ${c.hue}">${text}</mark>`
    if (u) text = `<mark class="user-mark hl-${u.color}" data-hl="${u.id}">${text}</mark>`
    html += text
    i = j
  }
  return html
}
