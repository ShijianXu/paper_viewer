// The parts of plotly.js the app uses (the package ships without types).
declare module 'plotly.js-dist-min' {
  type Figure = { data: object[]; layout?: Record<string, unknown>; config?: Record<string, unknown> }
  export function newPlot(el: HTMLElement, data: Figure['data'], layout?: Figure['layout'], config?: Figure['config']): Promise<HTMLElement>
  export function purge(el: HTMLElement): void
  export const Plots: { resize(el: HTMLElement): void }
}
