"""SQLite storage for sessions and messages."""

import json
import re
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
    pdf_title         TEXT,             -- the paper's title (sessions can be renamed)
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
    selection   TEXT,                        -- JSON {page, ranges, text}: PDF passage the question is about
    trace       TEXT,                        -- JSON list of the steps of an answer (see claude_runner)
    images      TEXT,                        -- JSON list of image file names in <session>/attachments/
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS highlights (       -- made by the user with the mouse
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    paper       INTEGER NOT NULL DEFAULT 1,   -- which paper: 1, or the num of one in `papers`
    page        INTEGER NOT NULL,             -- 1-based
    ranges      TEXT NOT NULL,                -- JSON [[itemIndex, start, end], ...] in the page's text items
    text        TEXT NOT NULL,                -- the selected text, to re-find it if the ranges don't match
    color       TEXT NOT NULL,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS highlights_session ON highlights(session_id, id);
CREATE TABLE IF NOT EXISTS materials (        -- extra files for Claude, stored in <session>/materials/
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,                -- name in the materials folder
    size        INTEGER NOT NULL,
    announced   INTEGER NOT NULL DEFAULT 0,   -- Claude has been told about it
    removed     INTEGER NOT NULL DEFAULT 0,   -- removed by the user; Claude still has to be told
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS materials_session ON materials(session_id, id);
CREATE TABLE IF NOT EXISTS papers (           -- papers opened next to the first one, in <session>/papers/
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    num         INTEGER NOT NULL,             -- 2, 3, ...: how the app and Claude refer to it; never reused
    filename    TEXT NOT NULL,                -- name in the papers folder
    title       TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    -- new: Claude hasn't been told yet; known; removed: Claude still has to be told; gone
    state       TEXT NOT NULL DEFAULT 'new',
    created_at  REAL NOT NULL,
    UNIQUE (session_id, num)
);
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


# Columns added after the first release: (table, column, definition).
MIGRATIONS = [
    ("messages", "selection", "TEXT"),
    ("messages", "trace", "TEXT"),
    ("messages", "images", "TEXT"),
    ("sessions", "pdf_title", "TEXT"),
    ("highlights", "paper", "INTEGER NOT NULL DEFAULT 1"),
]


def init() -> None:
    config.ensure_dirs()
    with connect() as c:
        c.executescript(SCHEMA)
        for table, column, definition in MIGRATIONS:
            columns = {row["name"] for row in c.execute(f"PRAGMA table_info({table})")}
            if column not in columns:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _session(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["has_pdf"] = d["pdf_sha256"] is not None
    d["pdf_announced"] = bool(d["pdf_announced"])
    return d


def _message(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["tools"] = json.loads(d["tools"])
    d["selection"] = json.loads(d["selection"]) if d["selection"] else None
    d["trace"] = json.loads(d["trace"]) if d.get("trace") else None
    d["images"] = json.loads(d["images"]) if d.get("images") else []
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


def add_highlight(session_id: str, paper: int, page: int, ranges: list, text: str, color: str) -> dict:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO highlights (session_id, paper, page, ranges, text, color, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (session_id, paper, page, json.dumps(ranges), text, color, time.time()),
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


def list_materials(session_id: str, include_removed: bool = False) -> list[dict]:
    query = "SELECT * FROM materials WHERE session_id = ?" + ("" if include_removed else " AND removed = 0")
    with connect() as c:
        rows = c.execute(query + " ORDER BY id", (session_id,)).fetchall()
    return [dict(r) for r in rows]


def add_material(session_id: str, filename: str, size: int) -> dict:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO materials (session_id, filename, size, created_at) VALUES (?, ?, ?, ?)",
            (session_id, filename, size, time.time()),
        )
        row = c.execute("SELECT * FROM materials WHERE id = ?", (cur.lastrowid,)).fetchone()
    update_session(session_id)
    return dict(row)


def remove_material(session_id: str, material_id: int) -> dict | None:
    """Mark a material removed (Claude is told on the next turn); returns it, or None."""
    with connect() as c:
        row = c.execute(
            "SELECT * FROM materials WHERE id = ? AND session_id = ? AND removed = 0",
            (material_id, session_id),
        ).fetchone()
        if not row:
            return None
        if row["announced"]:
            c.execute("UPDATE materials SET removed = 1 WHERE id = ?", (material_id,))
        else:  # Claude never heard of it: just forget it
            c.execute("DELETE FROM materials WHERE id = ?", (material_id,))
    return dict(row)


def forget_material(session_id: str, material_id: int) -> None:
    """Drop a material without telling Claude (it moved: it became a paper, announced as such)."""
    with connect() as c:
        c.execute("DELETE FROM materials WHERE id = ? AND session_id = ?", (material_id, session_id))


def materials_announced(session_id: str, ids: list[int]) -> None:
    """After a turn told Claude about these materials: mark added ones known, drop removed ones."""
    with connect() as c:
        for mid in ids:
            c.execute(
                "DELETE FROM materials WHERE id = ? AND session_id = ? AND removed = 1", (mid, session_id)
            )
            c.execute("UPDATE materials SET announced = 1 WHERE id = ? AND session_id = ?", (mid, session_id))


def reset_materials_announced(session_id: str) -> None:
    """A new Claude conversation knows none of the materials."""
    with connect() as c:
        c.execute("DELETE FROM materials WHERE session_id = ? AND removed = 1", (session_id,))
        c.execute("UPDATE materials SET announced = 0 WHERE session_id = ?", (session_id,))


# ---------------------------------------------------------------- papers next to the first one

LIVE_PAPER = "state IN ('new', 'known')"


def list_papers(session_id: str, include_removed: bool = False) -> list[dict]:
    where = "state != 'gone'" if include_removed else LIVE_PAPER
    with connect() as c:
        rows = c.execute(
            f"SELECT * FROM papers WHERE session_id = ? AND {where} ORDER BY num", (session_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def get_paper(session_id: str, num: int) -> dict | None:
    with connect() as c:
        row = c.execute(
            f"SELECT * FROM papers WHERE session_id = ? AND num = ? AND {LIVE_PAPER}", (session_id, num)
        ).fetchone()
    return dict(row) if row else None


def add_paper(session_id: str, filename: str, title: str, sha256: str) -> dict:
    """Add a paper; it gets the next number (2 for the first one added), never one used before."""
    with connect() as c:
        # One statement, so two papers added at once can't get the same number.
        cur = c.execute(
            "INSERT INTO papers (session_id, num, filename, title, sha256, created_at)"
            " SELECT ?, COALESCE(MAX(num), 1) + 1, ?, ?, ?, ? FROM papers WHERE session_id = ?",
            (session_id, filename, title, sha256, time.time(), session_id),
        )
        row = c.execute("SELECT * FROM papers WHERE id = ?", (cur.lastrowid,)).fetchone()
    update_session(session_id)
    return dict(row)


def remove_paper(session_id: str, num: int) -> dict | None:
    """Take a paper out of the session, with its highlights; returns it, or None.
    Its row stays, so its number is not given to another paper."""
    with connect() as c:
        row = c.execute(
            f"SELECT * FROM papers WHERE session_id = ? AND num = ? AND {LIVE_PAPER}", (session_id, num)
        ).fetchone()
        if not row:
            return None
        # Claude is told even about a 'new' one: a turn running now may have announced it.
        c.execute("UPDATE papers SET state = 'removed' WHERE id = ?", (row["id"],))
        c.execute("DELETE FROM highlights WHERE session_id = ? AND paper = ?", (session_id, num))
    update_session(session_id)
    return dict(row)


def papers_announced(session_id: str, ids: list[int]) -> None:
    """After a turn told Claude about these papers: added ones are known, removed ones gone."""
    with connect() as c:
        for pid in ids:
            c.execute(
                "UPDATE papers SET state = CASE state WHEN 'new' THEN 'known' WHEN 'removed' THEN 'gone' ELSE state END"
                " WHERE id = ? AND session_id = ?",
                (pid, session_id),
            )


def reset_papers_announced(session_id: str) -> None:
    """A new Claude conversation knows none of the papers."""
    with connect() as c:
        c.execute("UPDATE papers SET state = 'gone' WHERE session_id = ? AND state = 'removed'", (session_id,))
        c.execute("UPDATE papers SET state = 'new' WHERE session_id = ? AND state = 'known'", (session_id,))


def add_message(
    session_id: str,
    role: str,
    text: str,
    tools: list | None = None,
    error: str | None = None,
    selection: dict | None = None,
    trace: list | None = None,
    images: list[str] | None = None,
) -> dict:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO messages (session_id, role, text, tools, error, selection, trace, images, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                session_id, role, text, json.dumps(tools or []), error,
                json.dumps(selection) if selection else None,
                json.dumps(trace) if trace else None,
                json.dumps(images) if images else None, time.time(),
            ),
        )
        row = c.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
    update_session(session_id)
    return _message(row)


# Where a search term can be found: (label, SQL giving (session_id, text) rows matching `LIKE ?`).
# The label names the best match shown in the sidebar; earlier sources win.
_SEARCH_SOURCES = [
    ("title", "SELECT id, title FROM sessions WHERE title LIKE ? ESCAPE '\\'"),
    ("file", "SELECT id, pdf_filename FROM sessions WHERE pdf_filename LIKE ? ESCAPE '\\'"),
    ("file", f"SELECT session_id, title FROM papers WHERE {LIVE_PAPER} AND title LIKE ? ESCAPE '\\'"),
    ("file", f"SELECT session_id, filename FROM papers WHERE {LIVE_PAPER} AND filename LIKE ? ESCAPE '\\'"),
    ("highlight", "SELECT session_id, text FROM highlights WHERE text LIKE ? ESCAPE '\\'"),
    ("material", "SELECT session_id, filename FROM materials WHERE removed = 0 AND filename LIKE ? ESCAPE '\\'"),
    ("question", "SELECT session_id, text FROM messages WHERE role = 'user' AND text LIKE ? ESCAPE '\\'"),
    ("answer", "SELECT session_id, text FROM messages WHERE role = 'assistant' AND text LIKE ? ESCAPE '\\'"),
]


def _snippet(text: str, term: str, width: int = 120) -> str:
    """The part of `text` around the first occurrence of `term`, on one line."""
    text = " ".join(re.sub(r"</?cite[^>]*>", "", text).split())
    i = text.lower().find(term.lower())
    if i < 0:
        return text[:width]
    start = max(0, i - width // 3)
    end = min(len(text), start + width)
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")


def search_sessions(query: str, limit: int = 100) -> list[dict]:
    """Sessions in which every word of `query` occurs somewhere (title, file name,
    highlights, materials, questions or answers; case-insensitive for ASCII).
    Newest first; each with where the first word was found and a snippet."""
    terms = query.split()[:8]
    if not terms:
        return []
    found: list[dict[str, tuple[str, str]]] = []  # per term: session id -> (label, text)
    with connect() as c:
        for term in terms:
            pattern = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            hits: dict[str, tuple[str, str]] = {}
            for label, sql in _SEARCH_SOURCES:
                for sid, text in c.execute(sql, (pattern,)):
                    hits.setdefault(sid, (label, text))
            found.append(hits)
            if not hits:
                return []
        ids = set.intersection(*(set(h) for h in found))
        rows = c.execute(
            f"SELECT * FROM sessions WHERE id IN ({','.join('?' * len(ids))}) ORDER BY updated_at DESC LIMIT ?",
            (*ids, limit),
        ).fetchall() if ids else []
    results = []
    for row in rows:
        # Show the match that is not just the title, if any: that is what the user can't see.
        label, text, term = next(
            ((h[row["id"]][0], h[row["id"]][1], t) for t, h in zip(terms, found) if h[row["id"]][0] != "title"),
            (*found[0][row["id"]], terms[0]),
        )
        results.append(_session(row) | {"match": {"where": label, "snippet": _snippet(text, term)}})
    return results
