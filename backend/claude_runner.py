"""Run the local `claude` CLI for one chat turn and stream its output.

Each turn runs `claude -p` in the session folder. The first turn creates a
Claude session with a known id; later turns `--resume` it. A run is a
background task that saves its result itself, so it finishes and is stored
even if the browser disconnects. The HTTP response just follows its queue.
"""

import asyncio
import json
import logging
import shlex
import sys
import uuid
from dataclasses import dataclass, field

from . import config, db, papers

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are the assistant inside Paper Viewer, a local app where the user reads a research paper and chats with you about it. The PDF is shown to the user in a pane next to this chat.

## The paper
When a paper is open it is saved as ./paper.pdf in your working directory. Read it with the Read tool, or with shell tools such as `pdftotext -layout paper.pdf -` if they are available. Use installed skills (e.g. a paper-reading skill) when they fit the request.

## Citing the paper (important)
Whenever a statement in your answer is supported by a specific passage of the paper, quote that passage in exactly this form:

<cite page="4">exact words copied from the paper</cite>

- `page` is the 1-based page index in the PDF file (the first page of the file is 1), not the page number printed on the page.
- The quote must be copied verbatim from the paper: same words, same order. Keep it short: one sentence or a clause, at most about 30 words. Do not paraphrase inside the tag, do not join text from different places, and do not quote equations, tables or figure contents (quote the sentence around them instead).
- The app shows the tag's content inline as a clickable quotation (it adds the quotation marks and the page number) and highlights it in the PDF. So the sentence must read naturally with the quote in place, e.g.: The authors propose <cite page="1">a new simple network architecture, the Transformer</cite>, which removes recurrence entirely.
- Cite generously when you discuss the paper's content, but never invent a quote. Never put cite tags inside code blocks or headings.

## Formatting
Answer in Markdown. Use $...$ for inline math and $$...$$ for display math.

## Environment
- You may create files (extracted text, figures, scripts) only inside your working directory. Shell commands run in a sandbox that cannot write elsewhere and has no network access; use WebSearch / WebFetch for the web.
- Do not try to install software or change anything on the system.
"""

TOOL_PATTERNS = ["Write", "Edit", "MultiEdit", "NotebookEdit"]

ALLOWED_TOOLS = [
    "Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "Skill", "TodoWrite", "Task",
    *TOOL_PATTERNS,  # limited to the session folder by the hook
]

DENIED_COMMANDS = ["sudo", "su", "kill", "pkill", "killall", "systemctl", "shutdown", "reboot", "crontab"]


def claude_settings(workdir: str) -> dict:
    hook = f"{shlex.quote(sys.executable)} {shlex.quote(str(config.HOOK_SCRIPT))} {shlex.quote(workdir)}"
    return {
        "sandbox": {
            "enabled": True,
            "autoAllowBashIfSandboxed": True,
            "allowUnsandboxedCommands": False,
        },
        "permissions": {
            "allow": ALLOWED_TOOLS,
            "deny": [f"Bash({c}:*)" for c in DENIED_COMMANDS],
        },
        "hooks": {
            "PreToolUse": [
                {"matcher": "|".join(TOOL_PATTERNS), "hooks": [{"type": "command", "command": hook}]}
            ]
        },
    }


# ---------------------------------------------------------------- prompts


def _announce_pdf(session: dict) -> str:
    return (
        f'[The user opened the paper "{session["pdf_filename"]}". It is saved as ./paper.pdf '
        "in your working directory. Read it before answering.]\n\n"
    )


def _with_selection(text: str, selection: dict | None) -> str:
    """The user's question, preceded by the PDF passage it is about (if any)."""
    if not selection:
        return text
    quoted = "\n".join(f"> {line}" for line in selection["text"].splitlines())
    return (
        f"[The user selected this passage on page {selection['page']} of the paper and asks about it:]\n"
        f"{quoted}\n\n{text}"
    )


def _transcript(messages: list[dict], limit: int = 40_000) -> str:
    parts = [f"{m['role'].upper()}:\n{_with_selection(m['text'], m.get('selection'))}" for m in messages]
    text = "\n\n".join(parts)
    return text[-limit:]


def _tool_summary(name: str, inp: dict) -> str:
    for key in ("command", "file_path", "notebook_path", "query", "url", "skill", "pattern", "description"):
        if inp.get(key):
            return str(inp[key])[:200]
    return ""


# ---------------------------------------------------------------- runs


@dataclass
class Run:
    session_id: str
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    proc: asyncio.subprocess.Process | None = None
    stopped: bool = False
    task: asyncio.Task | None = None


RUNS: dict[str, Run] = {}


def is_running(session_id: str) -> bool:
    return session_id in RUNS


def start(session_id: str, user_text: str, selection: dict | None = None) -> Run:
    """Save the user message and start a background turn. Caller checks is_running first."""
    run = Run(session_id)
    RUNS[session_id] = run
    db.add_message(session_id, "user", user_text, selection=selection)
    run.task = asyncio.create_task(_turn(run, user_text, selection))
    return run


async def stop(session_id: str) -> bool:
    run = RUNS.get(session_id)
    if not run:
        return False
    run.stopped = True
    if run.proc and run.proc.returncode is None:
        run.proc.terminate()
    return True


async def _turn(run: Run, user_text: str, selection: dict | None) -> None:
    sid = run.session_id
    question = _with_selection(user_text, selection)
    state = {"text": "", "tools": []}
    error = None
    try:
        session = db.get_session(sid)
        notes = ""
        if not session["has_pdf"]:
            session, notes = await _download_linked_paper(run, session, user_text, state)
            if run.stopped:
                return
        prefix = notes + ("" if session["pdf_announced"] or not session["has_pdf"] else _announce_pdf(session))

        if session["claude_session_id"]:
            ok, error = await _invoke(run, prefix + question, state, resume=session["claude_session_id"])
            if not ok and error and "No conversation found" in error and not state["text"]:
                # Claude's own history is gone: start over with our saved transcript.
                error = None
                history = db.list_messages(sid)[:-1]
                prompt = (
                    "[This continues an earlier conversation whose history was lost. "
                    "Here is the saved transcript:]\n\n"
                    f"{_transcript(history)}\n\n[End of transcript. The user's new message follows.]\n\n"
                    + (_announce_pdf(session) if session["has_pdf"] else "")
                    + question
                )
                ok, error = await _invoke(run, prompt, state, new_id=str(uuid.uuid4()))
        else:
            ok, error = await _invoke(run, prefix + question, state, new_id=str(uuid.uuid4()))

        if ok and session["has_pdf"]:
            db.update_session(sid, pdf_announced=1)
    except Exception as e:  # keep the run alive enough to report and save
        log.exception("turn failed")
        error = f"{type(e).__name__}: {e}"
    finally:
        if run.stopped:
            error = "Stopped by user."
        session = db.get_session(sid)
        if session:
            try:
                papers.restore_pdf_if_changed(session)
            except Exception:
                log.exception("could not restore paper.pdf")
            msg = db.add_message(sid, "assistant", state["text"], state["tools"], error)
            await run.queue.put({"type": "done", "message": msg})
        RUNS.pop(sid, None)
        await run.queue.put(None)


MAX_LINKS = 3


async def _download_linked_paper(run: Run, session: dict, text: str, state: dict) -> tuple[dict, str]:
    """If the message has links and the session no paper yet, download the paper first.

    Returns the (possibly updated) session and a note for Claude when every link failed.
    """
    failures = []
    for url in papers.find_urls(text)[:MAX_LINKS]:
        tool = {"name": "Download", "summary": url}
        state["tools"].append(tool)
        await run.queue.put({"type": "tool", **tool})
        try:
            session = await papers.fetch_into_session(session["id"], url)
        except Exception as e:
            reason = str(e) if isinstance(e, papers.DownloadError) else f"{type(e).__name__}: {e}"
            log.info("download from %s failed: %s", url, reason)
            tool["summary"] = f"{url} (failed: {reason})"
            failures.append(f"- {url}: {reason}")
            continue
        tool["summary"] = f"{url} → {session['pdf_filename']}"
        await run.queue.put({"type": "pdf"})
        return session, ""
    if not failures:
        return session, ""
    note = (
        "[The app tried to download the paper from the link(s) in the message, but failed:\n"
        + "\n".join(failures)
        + "\nThere is no paper.pdf. Use WebFetch / WebSearch to read the paper if you can, "
        "and tell the user they can open the PDF with the Open PDF button.]\n\n"
    )
    return session, note


async def _invoke(run: Run, prompt: str, state: dict, *, resume: str | None = None, new_id: str | None = None):
    """Run claude once. Returns (ok, error_text)."""
    workdir = str(config.session_dir(run.session_id))
    cmd = [
        config.CLAUDE_BIN, "-p",
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--permission-mode", "dontAsk",
        "--settings", json.dumps(claude_settings(workdir)),
        "--append-system-prompt", SYSTEM_PROMPT,
    ]
    if config.CLAUDE_MODEL:
        cmd += ["--model", config.CLAUDE_MODEL]
    if resume:
        cmd += ["--resume", resume]
    else:
        cmd += ["--session-id", new_id]
        db.update_session(run.session_id, claude_session_id=new_id, pdf_announced=0)

    run.proc = proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=workdir,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=64 * 1024 * 1024,
    )
    proc.stdin.write(prompt.encode())
    await proc.stdin.drain()
    proc.stdin.close()

    stderr_task = asyncio.create_task(proc.stderr.read())
    result = None
    async for raw in proc.stdout:
        try:
            ev = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if ev.get("parent_tool_use_id"):
            continue  # output of a subagent, not the main answer
        kind = ev.get("type")
        if kind == "stream_event":
            await _on_stream_event(run, ev["event"], state)
        elif kind == "assistant":
            for block in ev["message"].get("content", []):
                if block.get("type") == "tool_use":
                    tool = {"name": block["name"], "summary": _tool_summary(block["name"], block.get("input") or {})}
                    state["tools"].append(tool)
                    await run.queue.put({"type": "tool", **tool})
        elif kind == "result":
            result = ev

    await proc.wait()
    stderr = (await stderr_task).decode(errors="replace").strip()
    if run.stopped:
        return False, None
    if result and not result.get("is_error"):
        return True, None
    detail = (result or {}).get("result") or "; ".join((result or {}).get("errors") or []) or stderr
    return False, detail or f"claude exited with code {proc.returncode}"


async def _on_stream_event(run: Run, event: dict, state: dict) -> None:
    kind = event.get("type")
    if kind == "message_start" and state["text"] and not state["text"].endswith("\n\n"):
        await _emit_text(run, state, "\n\n")
    elif kind == "content_block_delta":
        delta = event.get("delta") or {}
        if delta.get("type") == "text_delta":
            await _emit_text(run, state, delta["text"])


async def _emit_text(run: Run, state: dict, text: str) -> None:
    state["text"] += text
    await run.queue.put({"type": "text", "text": text})
