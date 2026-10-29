"""HTTP API and static file server."""

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
    return {"ok": True}


# ---------------------------------------------------------------- the paper


@app.post("/api/sessions/{session_id}/pdf")
def upload_pdf(session_id: str, file: UploadFile) -> dict:
    session = _require(session_id)
    if session["has_pdf"]:
        raise HTTPException(409, "This session already has a paper. Start a new session for another one.")
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


# ---------------------------------------------------------------- user highlights

HIGHLIGHT_COLORS = {"yellow", "green", "blue", "pink", "orange", "purple"}


class NewHighlight(BaseModel):
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
    if not session["has_pdf"]:
        raise HTTPException(400, "This session has no paper")
    _check_color(body.color)
    return db.add_highlight(session_id, body.page, [list(r) for r in body.ranges], body.text, body.color)


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

    page: int = Field(ge=1)
    ranges: list[tuple[int, int, int]] = Field(min_length=1)
    text: str = Field(min_length=1, max_length=5_000)


class NewMessage(BaseModel):
    text: str
    selection: Selection | None = None


@app.post("/api/sessions/{session_id}/messages")
async def send_message(session_id: str, body: NewMessage) -> StreamingResponse:
    session = _require(session_id)
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Message is empty")
    if body.selection and not session["has_pdf"]:
        raise HTTPException(400, "This session has no paper")
    if claude_runner.is_running(session_id):
        raise HTTPException(409, "Claude is still answering the previous message")
    if session["title"] == "New session" and not session["has_pdf"]:
        db.update_session(session_id, title=text[:60])

    selection = body.selection.model_dump() if body.selection else None
    run = claude_runner.start(session_id, text, selection)

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
