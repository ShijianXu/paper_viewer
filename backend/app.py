"""HTTP API and static file server."""

import base64
import json
import logging
import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import claude_runner, config, db, papers

log = logging.getLogger(__name__)
app = FastAPI(title="Paper Viewer")


@app.on_event("startup")
def startup() -> None:
    db.init()


def _require(session_id: str) -> dict:
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return session


# ---------------------------------------------------------------- sessions


@app.get("/api/sessions")
def list_sessions() -> list[dict]:
    return [s | {"running": claude_runner.is_running(s["id"])} for s in db.list_sessions()]


@app.get("/api/sessions/search")
def search_sessions(q: str = "") -> list[dict]:
    """Sessions matching every word of q in their title, paper, highlights, materials or chat."""
    return [s | {"running": claude_runner.is_running(s["id"])} for s in db.search_sessions(q[:500])]


@app.post("/api/sessions")
def create_session() -> dict:
    session = db.create_session()
    config.session_dir(session["id"]).mkdir(parents=True, exist_ok=True)
    return session


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str) -> dict:
    session = _require(session_id)
    return {
        "session": session | {"running": claude_runner.is_running(session_id)},
        "messages": db.list_messages(session_id),
        "highlights": db.list_highlights(session_id),
        "materials": db.list_materials(session_id),
        "papers": [_paper(p) for p in db.list_papers(session_id)],
    }


class Rename(BaseModel):
    title: str


@app.patch("/api/sessions/{session_id}")
def rename_session(session_id: str, body: Rename) -> dict:
    _require(session_id)
    title = body.title.strip()
    if not title:
        raise HTTPException(400, "Title must not be empty")
    db.update_session(session_id, title=title[:300])
    return db.get_session(session_id)


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict:
    _require(session_id)
    run = claude_runner.RUNS.get(session_id)
    if run:
        await claude_runner.stop(session_id)
        await run.task
    db.delete_session(session_id)
    folder = config.session_dir(session_id)
    if folder.exists():
        # paper.pdf is read-only; make everything writable again so rmtree works.
        for p in [folder, *folder.rglob("*")]:
            if not p.is_symlink():
                p.chmod(p.stat().st_mode | 0o200)
        shutil.rmtree(folder)
    config.original_pdf(session_id).unlink(missing_ok=True)
    for backup in config.ORIGINALS_DIR.glob(f"{session_id}-*.pdf"):
        backup.unlink(missing_ok=True)
    return {"ok": True}


# ---------------------------------------------------------------- the paper


@app.post("/api/sessions/{session_id}/pdf")
def upload_pdf(session_id: str, file: UploadFile) -> dict:
    session = _require(session_id)
    if session["has_pdf"]:
        raise HTTPException(409, "This session already has a paper. Open more papers with the + above it.")
    head = file.file.read(5)
    if head != b"%PDF-":
        raise HTTPException(400, "This file is not a PDF.")
    file.file.seek(0)
    with tempfile.TemporaryDirectory(dir=config.DATA_DIR) as tmp:
        upload = Path(tmp) / "upload.pdf"
        with upload.open("wb") as out:
            shutil.copyfileobj(file.file, out)
        return papers.store_pdf(session_id, upload, file.filename or "paper.pdf")


@app.get("/api/sessions/{session_id}/pdf")
def get_pdf(session_id: str) -> FileResponse:
    session = _require(session_id)
    if not session["has_pdf"]:
        raise HTTPException(404, "No paper in this session")
    # Serve the backup: it is the file the user opened, whatever Claude did in its folder.
    return FileResponse(config.original_pdf(session_id), media_type="application/pdf")


# ---------------------------------------------------------------- papers next to the first one


def _paper(p: dict) -> dict:
    return {k: p[k] for k in ("num", "title", "filename", "created_at")}


def _require_paper(session: dict, num: int) -> None:
    """HTTP 400 unless paper `num` is open in the session."""
    if not session["has_pdf"]:
        raise HTTPException(400, "This session has no paper")
    if num != 1 and not db.get_paper(session["id"], num):
        raise HTTPException(400, f"This session has no paper {num}")


@app.post("/api/sessions/{session_id}/papers")
def upload_paper(session_id: str, file: UploadFile) -> dict:
    """Open another PDF next to the session's paper."""
    session = _require(session_id)
    if not session["has_pdf"]:
        raise HTTPException(400, "Open the session's first paper with Open PDF")
    if file.file.read(5) != b"%PDF-":
        raise HTTPException(400, f"{file.filename or 'This file'} is not a PDF.")
    file.file.seek(0)
    with tempfile.TemporaryDirectory(dir=config.DATA_DIR) as tmp:
        upload = Path(tmp) / "upload.pdf"
        with upload.open("wb") as out:
            shutil.copyfileobj(file.file, out)
        return _paper(papers.add_paper(session_id, upload, file.filename or "paper.pdf"))


class PaperLink(BaseModel):
    url: str = Field(min_length=1, max_length=2000)


@app.post("/api/sessions/{session_id}/papers/link")
async def add_paper_from_link(session_id: str, body: PaperLink) -> dict:
    """Download a paper (arXiv, OpenReview, a DOI, a web page, ...) and open it next to the others."""
    session = _require(session_id)
    if not session["has_pdf"]:
        raise HTTPException(400, "Open the session's first paper with Open PDF")
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "The link must start with http:// or https://")
    try:
        return _paper(await papers.fetch_paper(session_id, url))
    except papers.DownloadError as e:
        raise HTTPException(400, f"Could not get the paper: {e}") from e


@app.get("/api/sessions/{session_id}/papers/{num}/pdf")
def get_paper_pdf(session_id: str, num: int) -> FileResponse:
    _require(session_id)
    backup = config.original_pdf(session_id, num)
    if num < 2 or not db.get_paper(session_id, num) or not backup.is_file():
        raise HTTPException(404, "No such paper in this session")
    return FileResponse(backup, media_type="application/pdf")


@app.delete("/api/sessions/{session_id}/papers/{num}")
def remove_paper(session_id: str, num: int) -> dict:
    """Take a paper (not the first one) out of the session, with its highlights."""
    _require(session_id)
    paper = db.remove_paper(session_id, num) if num >= 2 else None
    if not paper:
        raise HTTPException(404, "No such paper in this session")
    papers.delete_paper_files(session_id, paper)
    return {"ok": True}


@app.post("/api/sessions/{session_id}/materials/{material_id}/open")
def open_material_as_paper(session_id: str, material_id: int) -> dict:
    """Turn a PDF from the materials into a paper shown in the viewer."""
    session = _require(session_id)
    if not session["has_pdf"]:
        raise HTTPException(400, "Open the session's first paper with Open PDF")
    material = next((m for m in db.list_materials(session_id) if m["id"] == material_id), None)
    if not material:
        raise HTTPException(404, "Material not found")
    path = config.session_dir(session_id) / config.MATERIALS_DIR / material["filename"]
    if not path.is_file() or path.is_symlink():
        raise HTTPException(404, "Material not found")
    with path.open("rb") as f:
        if f.read(5) != b"%PDF-":
            raise HTTPException(400, f"{material['filename']} is not a PDF.")
    paper = papers.add_paper(session_id, path, material["filename"])
    # Claude is told about the paper (with its new path); a "material removed" note would contradict that.
    db.forget_material(session_id, material_id)
    papers.delete_material_file(session_id, material["filename"])
    return _paper(paper)


# Files from the session folder (images Claude made, ...) are shown inside the
# app, so they must not be able to run code there: no scripts, no plugins.
FILE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
}


@app.get("/api/sessions/{session_id}/files/{path:path}")
def get_file(session_id: str, path: str) -> FileResponse:
    """A file from the session folder, e.g. an image Claude made and shows in an answer."""
    _require(session_id)
    root = config.session_dir(session_id).resolve()
    target = (root / path).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(target, headers=FILE_HEADERS)


# ---------------------------------------------------------------- additional materials


@app.post("/api/sessions/{session_id}/materials")
def add_materials(session_id: str, files: list[UploadFile]) -> list[dict]:
    """Add files for Claude to read. Any type; stored as-is, not shown in the app."""
    _require(session_id)
    added = []
    for f in files:
        try:
            added.append(papers.store_material(session_id, f.file, f.filename or "file"))
        except ValueError as e:
            raise HTTPException(413, str(e)) from e
    return added


@app.delete("/api/sessions/{session_id}/materials/{material_id}")
def remove_material(session_id: str, material_id: int) -> dict:
    _require(session_id)
    material = db.remove_material(session_id, material_id)
    if not material:
        raise HTTPException(404, "Material not found")
    papers.delete_material_file(session_id, material["filename"])
    return {"ok": True}


# ---------------------------------------------------------------- user highlights

HIGHLIGHT_COLORS = {"yellow", "green", "blue", "pink", "orange", "purple"}


class NewHighlight(BaseModel):
    paper: int = Field(default=1, ge=1)
    page: int = Field(ge=1)
    ranges: list[tuple[int, int, int]] = Field(min_length=1)
    text: str = Field(min_length=1, max_length=20_000)
    color: str


class HighlightColor(BaseModel):
    color: str


def _check_color(color: str) -> None:
    if color not in HIGHLIGHT_COLORS:
        raise HTTPException(400, f"Unknown color; use one of {sorted(HIGHLIGHT_COLORS)}")


@app.post("/api/sessions/{session_id}/highlights")
def add_highlight(session_id: str, body: NewHighlight) -> dict:
    session = _require(session_id)
    _require_paper(session, body.paper)
    _check_color(body.color)
    return db.add_highlight(session_id, body.paper, body.page, [list(r) for r in body.ranges], body.text, body.color)


@app.patch("/api/sessions/{session_id}/highlights/{highlight_id}")
def recolor_highlight(session_id: str, highlight_id: int, body: HighlightColor) -> dict:
    _require(session_id)
    _check_color(body.color)
    highlight = db.update_highlight(session_id, highlight_id, body.color)
    if not highlight:
        raise HTTPException(404, "Highlight not found")
    return highlight


@app.delete("/api/sessions/{session_id}/highlights/{highlight_id}")
def delete_highlight(session_id: str, highlight_id: int) -> dict:
    _require(session_id)
    if not db.delete_highlight(session_id, highlight_id):
        raise HTTPException(404, "Highlight not found")
    return {"ok": True}


# ---------------------------------------------------------------- chat


class Selection(BaseModel):
    """A passage of the PDF the question is about."""

    paper: int = Field(default=1, ge=1)
    page: int = Field(ge=1)
    ranges: list[tuple[int, int, int]] = Field(min_length=1)
    text: str = Field(min_length=1, max_length=5_000)


class NewMessage(BaseModel):
    text: str
    selection: Selection | None = None
    images: list[str] = Field(default=[], max_length=config.MAX_IMAGES)  # base64, or data: URLs


def _decode_images(images: list[str]) -> list[bytes]:
    """Pasted images as bytes; HTTP 400/413 if one is not a usable image."""
    out = []
    for item in images:
        b64 = item.split(",", 1)[1] if item.startswith("data:") else item
        if len(b64) > config.MAX_IMAGE_BYTES * 4 // 3 + 4:
            raise HTTPException(413, f"An image is larger than {config.MAX_IMAGE_BYTES >> 20} MB")
        try:
            data = base64.b64decode(b64, validate=True)
        except ValueError as e:
            raise HTTPException(400, "An attached image is not valid base64") from e
        if not papers.image_extension(data):
            raise HTTPException(400, "Only PNG, JPEG, GIF and WebP images can be attached")
        out.append(data)
    return out


@app.post("/api/sessions/{session_id}/messages")
async def send_message(session_id: str, body: NewMessage) -> StreamingResponse:
    session = _require(session_id)
    text = body.text.strip()
    images = _decode_images(body.images)
    if not text and not images:
        raise HTTPException(400, "Message is empty")
    if body.selection:
        _require_paper(session, body.selection.paper)
    if claude_runner.is_running(session_id):
        raise HTTPException(409, "Claude is still answering the previous message")
    if session["title"] == "New session" and not session["has_pdf"]:
        db.update_session(session_id, title=text[:60] or "Image")

    selection = body.selection.model_dump() if body.selection else None
    image_names = papers.store_images(session_id, images) if images else []
    run = claude_runner.start(session_id, text, selection, image_names)

    async def events():
        yield json.dumps({"type": "started"}) + "\n"
        while (event := await run.queue.get()) is not None:
            yield json.dumps(event) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson")


@app.post("/api/sessions/{session_id}/stop")
async def stop(session_id: str) -> dict:
    _require(session_id)
    return {"stopped": await claude_runner.stop(session_id)}


# ---------------------------------------------------------------- front end

if config.FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIST, html=True), name="frontend")
