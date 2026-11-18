import { pdfjs } from 'react-pdf'
import { buildPageIndex, type PageIndex } from './citations'

// The same worker as the viewer (PdfPane sets it too; whichever module loads first wins).
pdfjs.GlobalWorkerOptions.workerSrc ||= new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

/** The text of every page of a PDF, indexed for finding quotes. Loads the PDF on its own,
 * so it works for papers that aren't shown in a pane. */
export async function loadPageIndexes(url: string): Promise<PageIndex[]> {
  const task = pdfjs.getDocument({ url })
  try {
    const pdf = await task.promise
    return await Promise.all(
      Array.from({ length: pdf.numPages }, (_, i) =>
        pdf
          .getPage(i + 1)
          .then((p) => p.getTextContent())
          .then((tc) => buildPageIndex(tc.items as { str?: string }[])),
      ),
    )
  } finally {
    void task.destroy()
  }
}
