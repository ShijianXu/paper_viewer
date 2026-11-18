"""Paths and settings, overridable with environment variables."""

import os
import shutil
from pathlib import Path

DATA_DIR = Path(os.environ.get("PAPER_VIEWER_DATA", "~/.paper_viewer")).expanduser()
DB_PATH = DATA_DIR / "paper_viewer.db"
PAPERS_DIR = DATA_DIR / "papers"  # one working folder per session; Claude's cwd
ORIGINALS_DIR = DATA_DIR / "originals"  # untouched PDF backups, outside the sandbox

HOST = os.environ.get("PAPER_VIEWER_HOST", "127.0.0.1")
PORT = int(os.environ.get("PAPER_VIEWER_PORT", "8000"))

CLAUDE_BIN = os.environ.get("PAPER_VIEWER_CLAUDE", shutil.which("claude") or "claude")
# Optional model override, e.g. "opus" or "sonnet". Empty means the CLI default.
CLAUDE_MODEL = os.environ.get("PAPER_VIEWER_MODEL", "")

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
HOOK_SCRIPT = Path(__file__).resolve().parent / "hooks" / "check_paths.py"

PDF_NAME = "paper.pdf"
MATERIALS_DIR = "materials"  # extra files for Claude, inside the session folder
ATTACHMENTS_DIR = "attachments"  # images pasted into a message, inside the session folder
EXTRA_PAPERS_DIR = "papers"  # papers opened next to the first one, inside the session folder
# Width (CSS px) at which web pages are laid out and saved as PDF.
WEBPAGE_WIDTH = int(os.environ.get("PAPER_VIEWER_WEBPAGE_WIDTH", "1000"))
MAX_MATERIAL_BYTES = int(os.environ.get("PAPER_VIEWER_MAX_MATERIAL_MB", "50")) * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024  # per pasted image
MAX_IMAGES = 10  # per message


def ensure_dirs() -> None:
    for d in (DATA_DIR, PAPERS_DIR, ORIGINALS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def session_dir(session_id: str) -> Path:
    return PAPERS_DIR / session_id


def original_pdf(session_id: str, num: int = 1) -> Path:
    """Untouched copy of the session's paper `num` (1: the first paper, 2, 3, ...: papers added next to it)."""
    return ORIGINALS_DIR / (f"{session_id}.pdf" if num == 1 else f"{session_id}-{num}.pdf")
