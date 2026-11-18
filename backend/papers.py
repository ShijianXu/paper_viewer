"""Storing a session's paper, and downloading papers from links."""

import asyncio
import hashlib
import html
import logging
import os
import re
import shutil
import stat
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import httpx
from pypdf import PdfReader

from . import config, db, webpage

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


def _restore_copy(pdf: Path, backup: Path, expected_sha256: str) -> None:
    """Put back `pdf` from `backup` if it no longer has the expected content."""
    if pdf.is_file() and not pdf.is_symlink() and sha256(pdf) == expected_sha256:
        return
    log.warning("%s changed; restoring it", pdf)
    _clear(pdf)
    shutil.copyfile(backup, pdf)
    os.chmod(pdf, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)


def _clear(path: Path) -> None:
    """Remove whatever is at `path` (a file, a symlink, a folder) without following links."""
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        for p in [path, *path.rglob("*")]:
            if not p.is_symlink():
                p.chmod(p.stat().st_mode | 0o200)
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def _papers_folder(session_id: str) -> Path:
    """The session's papers/ folder, a real folder inside the session (Claude might have replaced it)."""
    folder = config.session_dir(session_id) / config.EXTRA_PAPERS_DIR
    if folder.is_symlink() or (folder.exists() and not folder.is_dir()):
        _clear(folder)
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def restore_pdf_if_changed(session: dict) -> None:
    """Put back paper.pdf, and the papers in papers/, from the backups if Claude changed or removed them."""
    sid = session["id"]
    if session["has_pdf"]:
        _restore_copy(config.session_dir(sid) / config.PDF_NAME, config.original_pdf(sid), session["pdf_sha256"])
    extra = [p for p in db.list_papers(sid) if config.original_pdf(sid, p["num"]).is_file()]
    if extra:
        folder = _papers_folder(sid)
        for p in extra:
            _restore_copy(folder / p["filename"], config.original_pdf(sid, p["num"]), p["sha256"])


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

    title = paper_title(backup, filename)
    fields = {"pdf_filename": filename, "pdf_title": title, "pdf_sha256": sha256(backup), "pdf_announced": 0}
    if _has_automatic_title(session):
        fields["title"] = title
    db.update_session(session_id, **fields)
    return db.get_session(session_id)


# ---------------------------------------------------------------- papers next to the first one


_adding_paper = threading.Lock()  # two papers added at once must not pick the same file name


def add_paper(session_id: str, source: Path, filename: str) -> dict:
    """Open another paper in the session: a read-only copy in papers/ for Claude, and an
    untouched backup outside the sandbox that the app shows. Returns the paper (with its num)."""
    title = paper_title(source, filename)
    digest = sha256(source)
    with _adding_paper:
        folder = _papers_folder(session_id)
        name = _material_name(folder, filename if filename.lower().endswith(".pdf") else f"{filename}.pdf")
        dest = folder / name
        shutil.copyfile(source, dest)
        os.chmod(dest, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        paper = db.add_paper(session_id, name, title, digest)
    shutil.copyfile(source, config.original_pdf(session_id, paper["num"]))
    return paper


def delete_paper_files(session_id: str, paper: dict) -> None:
    path = config.session_dir(session_id) / config.EXTRA_PAPERS_DIR / paper["filename"]
    if path.is_file() and not path.is_symlink() and path.parent.resolve() == _papers_folder(session_id).resolve():
        path.chmod(0o600)
        path.unlink()
    config.original_pdf(session_id, paper["num"]).unlink(missing_ok=True)


async def fetch_paper(session_id: str, url: str) -> dict:
    """Download the paper at `url` and add it next to the session's other papers."""
    with tempfile.TemporaryDirectory(dir=config.DATA_DIR) as tmp:
        dest = Path(tmp) / "download.pdf"
        _, filename, _ = await download_paper(url, dest)
        # Reading the title and hashing a large PDF takes a while: not on the event loop.
        return await asyncio.to_thread(add_paper, session_id, dest, filename)


# ---------------------------------------------------------------- additional materials


def _material_name(folder: Path, filename: str) -> str:
    """A safe, unused file name in `folder`, close to the original."""
    name = Path(filename).name.strip() or "file"
    name = re.sub(r"[^\w.\-+() ]", "_", name)[:150].lstrip(".") or "file"
    stem, suffix = Path(name).stem, Path(name).suffix
    candidate, n = name, 2
    while (folder / candidate).exists():
        candidate = f"{stem} ({n}){suffix}"
        n += 1
    return candidate


def store_material(session_id: str, upload, filename: str) -> dict:
    """Save an uploaded file into the session's materials folder (read-only for Claude)."""
    folder = config.session_dir(session_id) / config.MATERIALS_DIR
    folder.mkdir(parents=True, exist_ok=True)
    name = _material_name(folder, filename)
    dest = folder / name
    size = 0
    try:
        with dest.open("wb") as out:
            while chunk := upload.read(1 << 20):
                size += len(chunk)
                if size > config.MAX_MATERIAL_BYTES:
                    raise ValueError(f"{filename} is larger than {config.MAX_MATERIAL_BYTES >> 20} MB")
                out.write(chunk)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    os.chmod(dest, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
    return db.add_material(session_id, name, size)


def delete_material_file(session_id: str, filename: str) -> None:
    path = config.session_dir(session_id) / config.MATERIALS_DIR / filename
    if path.is_file():
        path.chmod(0o600)
        path.unlink()


# ---------------------------------------------------------------- pasted images

IMAGE_TYPES = {  # magic bytes -> extension; the formats Claude can look at
    b"\x89PNG\r\n\x1a\n": ".png",
    b"\xff\xd8\xff": ".jpg",
    b"GIF87a": ".gif",
    b"GIF89a": ".gif",
}


def image_extension(data: bytes) -> str | None:
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return next((ext for magic, ext in IMAGE_TYPES.items() if data.startswith(magic)), None)


def store_images(session_id: str, images: list[bytes]) -> list[str]:
    """Save images sent with a message (read-only for Claude); returns their file names."""
    folder = config.session_dir(session_id) / config.ATTACHMENTS_DIR
    folder.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    names = []
    for i, data in enumerate(images, 1):
        ext = image_extension(data)
        if not ext:
            raise ValueError("Only PNG, JPEG, GIF and WebP images can be attached")
        name = _material_name(folder, f"image-{stamp}-{i}{ext}")
        dest = folder / name
        dest.write_bytes(data)
        os.chmod(dest, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        names.append(name)
    return names


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


async def download_paper(url: str, dest: Path) -> tuple[str, str, bool]:
    """Get the paper behind `url` into `dest`. Returns (source url, filename, is_webpage).

    Tries the site's known PDF link first; otherwise fetches the page and, if it
    is HTML, follows its `citation_pdf_url` meta tag (used by most publishers).
    A web page with no PDF behind it (a blog post, an article) is saved as a
    PDF that looks like the page.
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
                return str(resp.url), _filename(str(resp.url), resp), False
            for rx in META_PDF_RES:
                m = rx.search(page)
                if m:
                    pdf_url = urljoin(str(resp.url), html.unescape(m.group(1)))
                    try:
                        kind, resp, _ = await _get(client, pdf_url, dest)
                    except httpx.HTTPError as e:
                        raise DownloadError(f"could not fetch {pdf_url}: {type(e).__name__}") from e
                    if kind == "pdf":
                        return str(resp.url), _filename(pdf_url, resp), False
                    raise DownloadError(f"{pdf_url} did not return a PDF (the site may require a login)")
            if candidate == url:
                # A plain web page: save it as it looks.
                try:
                    final_url, _, filename = await webpage.capture(str(resp.url), dest)
                except webpage.CaptureError as e:
                    raise DownloadError(str(e)) from e
                return final_url, filename, True
        raise guess_error or DownloadError(f"no PDF found at {url}")


async def fetch_into_session(session_id: str, url: str) -> tuple[dict, str | None]:
    """Get the paper at `url` and make it the session's paper.

    Returns the session, and the page's address if it was a web page saved as PDF.
    """
    with tempfile.TemporaryDirectory(dir=config.DATA_DIR) as tmp:
        dest = Path(tmp) / "download.pdf"
        source, filename, is_webpage = await download_paper(url, dest)
        return store_pdf(session_id, dest, filename), (source if is_webpage else None)
