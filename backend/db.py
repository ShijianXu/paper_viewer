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
