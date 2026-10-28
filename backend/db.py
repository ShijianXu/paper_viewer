"""SQLite storage for sessions and messages."""

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    pdf_filename      TEXT,             -- name of the file the user opened
    pdf_sha256        TEXT,
    claude_session_id TEXT,             -- for `claude --resume`
    pdf_announced     INTEGER NOT NULL DEFAULT 0,  -- Claude has been told where the PDF is
    created_at        REAL NOT NULL,
    updated_at        REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text        TEXT NOT NULL,
    tools       TEXT NOT NULL DEFAULT '[]',  -- JSON list of tool calls shown under the message
    error       TEXT,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS highlights (       -- made by the user with the mouse
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    page        INTEGER NOT NULL,             -- 1-based
    ranges      TEXT NOT NULL,                -- JSON [[itemIndex, start, end], ...] in the page's text items
    text        TEXT NOT NULL,                -- the selected text, to re-find it if the ranges don't match
    color       TEXT NOT NULL,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS highlights_session ON highlights(session_id, id);
"""


@contextmanager
def connect():
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init() -> None:
    config.ensure_dirs()
    with connect() as c:
        c.executescript(SCHEMA)


def _session(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["has_pdf"] = d["pdf_sha256"] is not None
    d["pdf_announced"] = bool(d["pdf_announced"])
    return d


def _message(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["tools"] = json.loads(d["tools"])
    return d


def list_sessions() -> list[dict]:
    with connect() as c:
        rows = c.execute("SELECT * FROM sessions ORDER BY updated_at DESC").fetchall()
    return [_session(r) for r in rows]


def get_session(session_id: str) -> dict | None:
    with connect() as c:
        row = c.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return _session(row) if row else None


def create_session(title: str = "New session") -> dict:
    now = time.time()
    sid = uuid.uuid4().hex
    with connect() as c:
        c.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (sid, title, now, now),
        )
    return get_session(sid)


def update_session(session_id: str, **fields) -> None:
    fields["updated_at"] = time.time()
    cols = ", ".join(f"{k} = ?" for k in fields)
    with connect() as c:
        c.execute(f"UPDATE sessions SET {cols} WHERE id = ?", (*fields.values(), session_id))


def delete_session(session_id: str) -> None:
    with connect() as c:
        c.execute("DELETE FROM sessions WHERE id = ?", (session_id,))


def list_messages(session_id: str) -> list[dict]:
    with connect() as c:
        rows = c.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY id", (session_id,)
        ).fetchall()
    return [_message(r) for r in rows]


def _highlight(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["ranges"] = json.loads(d["ranges"])
    return d


def list_highlights(session_id: str) -> list[dict]:
    with connect() as c:
        rows = c.execute(
            "SELECT * FROM highlights WHERE session_id = ? ORDER BY id", (session_id,)
        ).fetchall()
    return [_highlight(r) for r in rows]


def add_highlight(session_id: str, page: int, ranges: list, text: str, color: str) -> dict:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO highlights (session_id, page, ranges, text, color, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, page, json.dumps(ranges), text, color, time.time()),
        )
        row = c.execute("SELECT * FROM highlights WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _highlight(row)


def update_highlight(session_id: str, highlight_id: int, color: str) -> dict | None:
    with connect() as c:
        c.execute(
            "UPDATE highlights SET color = ? WHERE id = ? AND session_id = ?",
            (color, highlight_id, session_id),
        )
        row = c.execute(
            "SELECT * FROM highlights WHERE id = ? AND session_id = ?", (highlight_id, session_id)
        ).fetchone()
    return _highlight(row) if row else None


def delete_highlight(session_id: str, highlight_id: int) -> bool:
    with connect() as c:
        cur = c.execute(
            "DELETE FROM highlights WHERE id = ? AND session_id = ?", (highlight_id, session_id)
        )
    return cur.rowcount > 0


def add_message(
    session_id: str, role: str, text: str, tools: list | None = None, error: str | None = None
) -> dict:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO messages (session_id, role, text, tools, error, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, role, text, json.dumps(tools or []), error, time.time()),
        )
        row = c.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
    update_session(session_id)
    return _message(row)
