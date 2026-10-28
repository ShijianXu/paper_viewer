"""Storing a session's paper, and downloading papers from links."""

import hashlib
import html
import logging
import os
import re
import shutil
import stat
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import httpx
from pypdf import PdfReader

from . import config, db

log = logging.getLogger(__name__)

MAX_PDF_BYTES = 100 * 1024 * 1024
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36 PaperViewer/0.1"
)


class DownloadError(Exception):
    pass


# ---------------------------------------------------------------- storing


def sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def protect_pdf(session_id: str) -> None:
    pdf = config.session_dir(session_id) / config.PDF_NAME
    os.chmod(pdf, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)


def restore_pdf_if_changed(session: dict) -> None:
    """Put back paper.pdf from the backup if Claude changed or removed it."""
    if not session["has_pdf"]:
        return
    pdf = config.session_dir(session["id"]) / config.PDF_NAME
    if pdf.is_file() and sha256(pdf) == session["pdf_sha256"]:
        return
    log.warning("paper.pdf of session %s changed; restoring it", session["id"])
    if pdf.exists() or pdf.is_symlink():
        if pdf.is_dir():
            shutil.rmtree(pdf)
        else:
            pdf.unlink()
    shutil.copyfile(config.original_pdf(session["id"]), pdf)
    protect_pdf(session["id"])


def paper_title(pdf: Path, filename: str) -> str:
    """Best guess at the paper title: PDF metadata, then the largest text on page 1."""
    try:
        reader = PdfReader(pdf)
        meta = (reader.metadata.title or "").strip() if reader.metadata else ""
        if 8 <= len(meta) <= 250 and not meta.lower().endswith((".pdf", ".doc", ".docx", ".tex")):
            return meta

        pieces: list[tuple[float, float, str]] = []  # (size, baseline y, text)

        def visit(text, cm, tm, font, size):
            # Rendered size = font size scaled by the text and current matrices.
            # Rotated text (e.g. the arXiv stamp in the margin) is skipped.
            if abs(tm[1]) > 1e-3 or abs(tm[2]) > 1e-3:
                return
            scale = abs(tm[3] * cm[3]) or 1
            y = cm[3] * tm[5] + cm[5]
            if text.strip():
                pieces.append((round(size * scale, 1), y, text))

        reader.pages[0].extract_text(visitor_text=visit)
        if pieces:
            # The lines holding the largest text, with everything else on them
            # (titles in small caps mix large initials with smaller letters).
            biggest = max(s for s, _, _ in pieces)
            lines = {round(y) for s, y, _ in pieces if s == biggest}
            text = "".join(t for _, y, t in pieces if any(abs(y - ly) <= 2 for ly in lines))
            title = " ".join(text.split())
            if 8 <= len(title) <= 250:
                return title
    except Exception:
        log.exception("could not read title from %s", pdf)
    return Path(filename).stem


def _has_automatic_title(session: dict) -> bool:
    """True unless the user renamed the session."""
    if session["title"] == "New session":
        return True
    first = next((m for m in db.list_messages(session["id"]) if m["role"] == "user"), None)
    return bool(first) and session["title"] == first["text"][:60]


def store_pdf(session_id: str, source: Path, filename: str) -> dict:
    """Make `source` the session's paper: backup copy, read-only working copy, title."""
    session = db.get_session(session_id)
    folder = config.session_dir(session_id)
    folder.mkdir(parents=True, exist_ok=True)
    backup = config.original_pdf(session_id)
    shutil.copyfile(source, backup)
    shutil.copyfile(backup, folder / config.PDF_NAME)
    protect_pdf(session_id)

    fields = {"pdf_filename": filename, "pdf_sha256": sha256(backup), "pdf_announced": 0}
    if _has_automatic_title(session):
        fields["title"] = paper_title(backup, filename)
    db.update_session(session_id, **fields)
    return db.get_session(session_id)


# ---------------------------------------------------------------- links

URL_RE = re.compile(r"https?://[^\s<>\"'`]+")


def find_urls(text: str) -> list[str]:
    urls = []
    for u in URL_RE.findall(text):
        u = u.rstrip(".,;:!?)]}>")
        if u not in urls:
            urls.append(u)
    return urls


def known_pdf_urls(url: str) -> list[str]:
    """Direct PDF links for well-known paper sites; empty if the site isn't known."""
    p = urlparse(url)
    host = p.netloc.lower().removeprefix("www.")
    path = p.path

    if host in ("arxiv.org", "export.arxiv.org"):
        m = re.match(r"/(?:abs|pdf|html|format)/(.+?)(?:\.pdf)?/?$", path)
        if m:
            return [f"https://arxiv.org/pdf/{m.group(1)}"]
    if host in ("huggingface.co", "hf.co"):
        m = re.match(r"/papers/(\d{4}\.\d{4,5}(?:v\d+)?)", path)
        if m:
            return [f"https://arxiv.org/pdf/{m.group(1)}"]
    if host == "alphaxiv.org":
        m = re.match(r"/(?:abs|overview)/(\d{4}\.\d{4,5}(?:v\d+)?)", path)
        if m:
            return [f"https://arxiv.org/pdf/{m.group(1)}"]
    if host == "openreview.net":
        ids = parse_qs(p.query).get("id")
        if ids:
            return [f"https://openreview.net/pdf?id={ids[0]}"]
    if host == "aclanthology.org":
        stem = path.strip("/").removesuffix(".pdf")
        if stem and "/" not in stem:
            return [f"https://aclanthology.org/{stem}.pdf"]
    if host in ("biorxiv.org", "medrxiv.org") and "/content/" in path:
        stem = re.sub(r"(\.full)?(\.pdf)?(\+html)?/?$", "", path)
        return [f"https://www.{host}{stem}.full.pdf"]
    if host in ("proceedings.neurips.cc", "papers.nips.cc") and "-Abstract" in path:
        pdf = path.replace("/hash/", "/file/").replace("-Abstract", "-Paper").removesuffix(".html") + ".pdf"
        return [f"https://{p.netloc}{pdf}"]
    if host == "openaccess.thecvf.com" and "/html/" in path:
        return [f"https://{p.netloc}{path.replace('/html/', '/papers/').removesuffix('.html')}.pdf"]
    return []


META_PDF_RES = [
    re.compile(r"""<meta[^>]+name=["']citation_pdf_url["'][^>]*content=["']([^"']+)""", re.I),
    re.compile(r"""<meta[^>]+content=["']([^"']+)["'][^>]*name=["']citation_pdf_url["']""", re.I),
]


def _filename(url: str, response: httpx.Response) -> str:
    cd = response.headers.get("content-disposition", "")
    m = re.search(r"""filename\*?=(?:UTF-8'')?["']?([^"';]+)""", cd, re.I)
    name = unquote(m.group(1)) if m else unquote(Path(urlparse(url).path).name)
    if not name or name in ("pdf", "download"):
        ids = parse_qs(urlparse(url).query).get("id")
        name = ids[0] if ids else "paper"
    name = re.sub(r"[^\w.\-+ ]", "_", name)[:120]
    return name if name.lower().endswith(".pdf") else f"{name}.pdf"


async def _get(client: httpx.AsyncClient, url: str, dest: Path) -> tuple[str, httpx.Response, str | None]:
    """Download `url`. Returns ('pdf', response, None) with the file in `dest`, or ('html', response, page)."""
    async with client.stream("GET", url) as r:
        if r.status_code in (401, 403):
            raise DownloadError(
                f"{urlparse(url).netloc} refused the download (HTTP {r.status_code}); it may need a login "
                "or block automated downloads. Download the PDF in the browser and open it with Open PDF"
            )
        if r.status_code >= 400:
            raise DownloadError(f"{url} answered HTTP {r.status_code}")
        size = 0
        head = b""
        with dest.open("wb") as out:
            async for chunk in r.aiter_bytes():
                size += len(chunk)
                if size > MAX_PDF_BYTES:
                    raise DownloadError(f"file at {url} is larger than {MAX_PDF_BYTES >> 20} MB")
                if len(head) < 1024:
                    head += chunk[:1024]
                    # Not a PDF and not a web page (e.g. a video): stop early.
                    if len(head) >= 1024 and not head.lstrip().startswith(b"%PDF-") and b"<" not in head:
                        raise DownloadError(f"{url} is not a PDF")
                out.write(chunk)
    if head.lstrip()[:5] == b"%PDF-":
        return "pdf", r, None
    if b"<" in head:
        return "html", r, dest.read_text(errors="replace")
    raise DownloadError(f"{url} is not a PDF")


async def download_paper(url: str, dest: Path) -> tuple[str, str]:
    """Download the paper behind `url` into `dest`. Returns (pdf_url, filename).

    Tries the site's known PDF link first; otherwise fetches the page and, if it
    is HTML, follows its `citation_pdf_url` meta tag (used by most publishers).
    """
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=httpx.Timeout(60, connect=15), headers={"User-Agent": USER_AGENT}
    ) as client:
        guess_error = None
        for candidate in [*known_pdf_urls(url), url]:
            try:
                kind, resp, page = await _get(client, candidate, dest)
            except httpx.HTTPError as e:
                raise DownloadError(f"could not fetch {candidate}: {type(e).__name__}") from e
            except DownloadError as e:
                if candidate != url:
                    guess_error = e
                    continue  # the guessed link failed; try the page itself
                raise guess_error or e
            if kind == "pdf":
                return str(resp.url), _filename(str(resp.url), resp)
            for rx in META_PDF_RES:
                m = rx.search(page)
                if m:
                    pdf_url = urljoin(str(resp.url), html.unescape(m.group(1)))
                    try:
                        kind, resp, _ = await _get(client, pdf_url, dest)
                    except httpx.HTTPError as e:
                        raise DownloadError(f"could not fetch {pdf_url}: {type(e).__name__}") from e
                    if kind == "pdf":
                        return str(resp.url), _filename(pdf_url, resp)
                    raise DownloadError(f"{pdf_url} did not return a PDF (the site may require a login)")
        raise guess_error or DownloadError(f"no PDF found at {url}")


async def fetch_into_session(session_id: str, url: str) -> dict:
    """Download the paper at `url` and make it the session's paper. Returns the session."""
    with tempfile.TemporaryDirectory(dir=config.DATA_DIR) as tmp:
        dest = Path(tmp) / "download.pdf"
        _, filename = await download_paper(url, dest)
        return store_pdf(session_id, dest, filename)
