"""Save a web page (blog post, article, ...) as a PDF that looks like the site.

The page is opened in headless Chrome and printed with the *screen* styles
(not the site's print stylesheet), backgrounds and images included. The PDF
keeps the page's real text, so selecting, highlighting and Claude's quotes
work as in any paper.
"""

import logging
import re
from pathlib import Path
from urllib.parse import urlparse

from . import config

log = logging.getLogger(__name__)

# Desktop layout, readable width; pages keep the A4 aspect ratio.
PAGE_WIDTH = config.WEBPAGE_WIDTH
PAGE_HEIGHT = round(PAGE_WIDTH * 297 / 210)

# Make a long scrolling page print as a whole document (consent dialogs often
# lock scrolling with overflow:hidden or position:fixed on html/body).
CAPTURE_CSS = """
html, body { height: auto !important; min-height: 0 !important; max-height: none !important;
             overflow: visible !important; position: static !important; }
* { scroll-behavior: auto !important; animation: none !important; transition: none !important; }
"""

# Scroll through the page so lazily loaded images and content appear.
SCROLL_JS = """
async () => {
  const step = Math.max(400, window.innerHeight * 0.8)
  for (let i = 0; i < 80; i++) {
    const before = window.scrollY
    window.scrollBy(0, step)
    await new Promise((r) => setTimeout(r, 150))
    if (window.scrollY === before) break
  }
  document.querySelectorAll('img[loading="lazy"]').forEach((img) => (img.loading = 'eager'))
  window.scrollTo(0, 0)
}
"""

# Elements pinned to the screen (sticky headers, chat buttons, cookie banners)
# would repeat on every PDF page. Consent dialogs and other overlays (pinned
# and covering much of the screen) are hidden; the rest scroll with the page,
# so they appear once. Scroll locks on html/body are undone.
UNPIN_JS = r"""
() => {
  const consent = /cookie|consent|gdpr|privacy|onetrust|cmp|sp_message|sp-message|didomi|usercentrics|cookiebot|truste|qc-cmp|fc-consent|cc-window|paywall|modal|overlay|backdrop/i
  const screen = window.innerWidth * window.innerHeight
  for (const el of document.querySelectorAll('body *')) {
    const pos = getComputedStyle(el).position
    if (pos !== 'fixed' && pos !== 'sticky') continue
    const label = `${el.id} ${el.className} ${el.getAttribute('aria-label') || ''}`
    const r = el.getBoundingClientRect()
    const overlay = pos === 'fixed' && r.width * r.height > 0.4 * screen
    const dialog = el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true'
    if (pos === 'fixed' && (consent.test(label) || dialog || overlay)) {
      el.style.setProperty('display', 'none', 'important')
    } else {
      el.style.setProperty('position', pos === 'fixed' ? 'absolute' : 'relative', 'important')
    }
  }
  for (const el of [document.documentElement, document.body]) {
    for (const [prop, value] of [['overflow', 'visible'], ['position', 'static'], ['height', 'auto']]) {
      el.style.setProperty(prop, value, 'important')
    }
  }
}
"""


class CaptureError(Exception):
    pass


async def _launch(pw):
    """Google Chrome if installed, else Playwright's own Chromium."""
    try:
        return await pw.chromium.launch(channel="chrome", headless=True)
    except Exception:
        pass
    try:
        return await pw.chromium.launch(headless=True)
    except Exception as e:
        raise CaptureError(
            "no browser available to save web pages; install Google Chrome, "
            "or run `uv run playwright install chromium`"
        ) from e


def _slug(title: str, url: str) -> str:
    name = re.sub(r"[^\w\- ]+", "", title).strip()
    name = re.sub(r"\s+", " ", name)[:100].strip()
    return name or urlparse(url).netloc or "web page"


async def capture(url: str, dest: Path) -> tuple[str, str, str]:
    """Save the page at `url` as a PDF in `dest`. Returns (final url, title, file name)."""
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await _launch(pw)
        try:
            context = await browser.new_context(
                viewport={"width": PAGE_WIDTH, "height": 1000}, accept_downloads=False, java_script_enabled=True
            )
            page = await context.new_page()
            try:
                response = await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
            except Exception as e:
                raise CaptureError(f"could not open {url}: {str(e).splitlines()[0]}") from e
            if response is None or response.status >= 400:
                status = response.status if response else "no response"
                raise CaptureError(f"{url} answered HTTP {status}; the site may block automated access")
            if "html" not in (response.headers.get("content-type") or "html"):
                raise CaptureError(f"{url} is not a web page")
            try:
                await page.wait_for_load_state("networkidle", timeout=15_000)
            except Exception:
                pass  # some pages never go quiet; capture what is there
            await page.evaluate(SCROLL_JS)
            try:
                await page.wait_for_load_state("networkidle", timeout=8_000)
            except Exception:
                pass
            await page.emulate_media(media="screen")
            await page.add_style_tag(content=CAPTURE_CSS)
            await page.evaluate(UNPIN_JS)
            await page.evaluate("document.fonts.ready")
            await page.wait_for_timeout(300)

            title = (await page.title()).strip() or urlparse(page.url).netloc
            await page.pdf(
                path=str(dest),
                width=f"{PAGE_WIDTH}px",
                height=f"{PAGE_HEIGHT}px",
                print_background=True,
                margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
            )
            final_url = page.url
        finally:
            await browser.close()

    if not dest.is_file() or dest.stat().st_size == 0:
        raise CaptureError(f"saving {url} as PDF produced no file")
    log.info("saved web page %s as PDF (%d bytes)", final_url, dest.stat().st_size)
    return final_url, title, f"{_slug(title, final_url)}.pdf"
