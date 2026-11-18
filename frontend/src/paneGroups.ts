// The PDF panes: one, or two side by side. Each pane has its own tabs, and every paper of
// the session is open in exactly one pane (like editor groups in a code editor).

/** A pane: the papers in its tabs (by number), and the one it shows. */
export type Group = { tabs: number[]; shown: number }

/** The groups made valid for the session's papers: each paper in exactly one group (papers
 * not placed yet go to the first), removed papers dropped, no empty group, at most two. */
export function normalize(groups: Group[], papers: number[]): Group[] {
  const live = new Set(papers)
  const seen = new Set<number>()
  let out = groups.slice(0, 2).map((g) => ({
    shown: g.shown,
    tabs: g.tabs.filter((n) => live.has(n) && !seen.has(n) && seen.add(n)),
  }))
  out = out.filter((g) => g.tabs.length)
  const missing = papers.filter((n) => !seen.has(n))
  if (missing.length) {
    if (!out.length) out = [{ tabs: [], shown: missing[0] }]
    out[0] = { ...out[0], tabs: [...out[0].tabs, ...missing] }
  }
  return out.map((g) => (g.tabs.includes(g.shown) ? g : { ...g, shown: g.tabs[0] }))
}

/** Show `num` in pane `pane` (it must be one of its tabs). */
export function show(groups: Group[], pane: number, num: number): Group[] {
  return groups.map((g, i) => (i === pane ? { ...g, shown: num } : g))
}

/** Move paper `num` (open or not yet) into pane `pane` and show it there; `pane` may be
 * groups.length, for a new pane. A pane left without tabs closes. */
export function moveTo(groups: Group[], num: number, pane: number): Group[] {
  const out = groups.map((g) => ({ ...g, tabs: g.tabs.filter((n) => n !== num) }))
  if (pane >= out.length) out.push({ tabs: [], shown: num })
  out[pane] = { tabs: [...out[pane].tabs, num], shown: num }
  return out
    .filter((g) => g.tabs.length)
    .map((g) => (g.tabs.includes(g.shown) ? g : { ...g, shown: g.tabs[g.tabs.length - 1] }))
}

/** Where to show `num` so that what the user reads in pane `active` stays put: the pane where
 * it is a tab; or, if it is a hidden tab of the active pane, the other pane (opened if needed). */
export function reveal(groups: Group[], active: number, num: number): { groups: Group[]; pane: number } {
  const at = groups.findIndex((g) => g.tabs.includes(num))
  if (at === -1) return { groups, pane: active }
  if (groups[at].shown === num) return { groups, pane: at }
  if (at !== active) return { groups: show(groups, at, num), pane: at }
  const other = groups.length === 1 ? 1 : 1 - active
  const next = moveTo(groups, num, other)
  return { groups: next, pane: next.findIndex((g) => g.tabs.includes(num)) }
}

/** Open a second pane next to pane `pane`, with another of its papers (the tab after the
 * shown one, else the one before); null if the pane has only one paper. */
export function split(groups: Group[], pane: number): Group[] | null {
  const g = groups[pane]
  if (groups.length > 1 || g.tabs.length < 2) return null
  const i = g.tabs.indexOf(g.shown)
  return moveTo(groups, g.tabs[i + 1] ?? g.tabs[i - 1], 1)
}

/** Close pane `pane`; its papers move to the other pane, which keeps showing what it shows. */
export function close(groups: Group[], pane: number): Group[] {
  if (groups.length < 2) return groups
  const keep = groups[1 - pane]
  return [{ ...keep, tabs: [...keep.tabs, ...groups[pane].tabs] }]
}
