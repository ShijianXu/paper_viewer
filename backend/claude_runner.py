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
When a paper is open it is saved as ./paper.pdf in your working directory. Read it with the Read tool, or with shell tools such as `pdftotext -layout paper.pdf -` if they are available.

## Citing the paper (important)
Whenever a statement in your answer is supported by a specific passage of the paper, quote that passage in exactly this form:

<cite page="4">exact words copied from the paper</cite>

- `page` is the 1-based page index in the PDF file (the first page of the file is 1), not the page number printed on the page.
- The quote must be copied verbatim from the paper: same words, same order. Keep it short: one sentence or a clause, at most about 30 words. Do not paraphrase inside the tag, do not join text from different places, and do not quote equations, tables or figure contents (quote the sentence around them instead).
- The app shows the tag's content inline as a clickable quotation (it adds the quotation marks and the page number) and highlights it in the PDF. So the sentence must read naturally with the quote in place, e.g.: The authors propose <cite page="1">a new simple network architecture, the Transformer</cite>, which removes recurrence entirely.
- Cite generously when you discuss the paper's content, but never invent a quote. Never put cite tags inside code blocks or headings.

## Additional materials
The user may add supplementary files (other papers, notes, images, data, ...) in ./materials/. You are told when files are added or removed. Use them as complementary information. Cite tags are only for paper.pdf: when you use a material, name the file instead (e.g. "according to materials/notes.txt, ..."). The files are read-only.

## Pasted images
The user can paste images (screenshots, crops of figures or equations, ...) into a message. They are saved in ./attachments/ and the message lists them. Look at them with the Read tool. They stay there, so you can look at an earlier one again if a later question refers to it. They are read-only.

## Formatting
Answer in Markdown. Use $...$ for inline math and $$...$$ for display math.

## Figures and diagrams
- To show an image (a figure from the paper, a plot you made, a GIF, an .mp4 video), save it under ./figures/ and include it as ![caption](figures/name.png); the app displays it. To cut a figure out of the paper, render its page with `pdftoppm -f N -l N -r 150 -png -singlefile paper.pdf figures/pN`, look at it with Read, then crop it (the same command with -x -y -W -H, in pixels at that resolution, or Python). Check an image with Read before showing it.
- For a diagram (a flow, an architecture, a timeline), write a ```mermaid code block; the app draws it. Put node labels in double quotes when they contain brackets, parentheses, braces or other punctuation, e.g. A["cache (h_{n-1})"].
- For a plot worth exploring (zoom, hover, rotating a 3D surface), write a ```plotly code block with a Plotly figure as JSON, {"data": [...], "layout": {...}}; the app makes it interactive. For a lot of data, save the JSON as figures/name.plotly.json and include it as ![title](figures/name.plotly.json). Data only, no JavaScript.

## Environment
- You may create files (extracted text, figures, scripts) only inside your working directory. Shell commands run in a sandbox that cannot write elsewhere and has no network access; use WebSearch / WebFetch for the web.
- Do not try to install software or change anything on the system.
"""

TOOL_PATTERNS = ["Write", "Edit", "MultiEdit", "NotebookEdit"]

ALLOWED_TOOLS = [
    "Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "Skill", "TodoWrite", "Task",
    *TOOL_PATTERNS,  # limited to the session folder by the hook
    # Every shell command runs in the sandbox (no escape: allowUnsandboxedCommands
    # is off), so all of them may run. Without this, commands the sandbox doesn't
    # auto-approve, e.g. ones with $(...), would be refused in dontAsk mode.
    "Bash",
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


def _size(n: int) -> str:
    return f"{n} B" if n < 1024 else f"{n / 1024:.0f} KB" if n < 1 << 20 else f"{n / (1 << 20):.1f} MB"


def _announce_materials(session_id: str) -> tuple[str, list[int]]:
    """A note about materials added or removed since Claude last heard, and their ids."""
    materials = db.list_materials(session_id, include_removed=True)
    new = [m for m in materials if not m["announced"] and not m["removed"]]
    gone = [m for m in materials if m["removed"]]
    note = ""
    if new:
        files = "\n".join(f"- ./materials/{m['filename']} ({_size(m['size'])})" for m in new)
        note += (
            "[The user added supplementary materials to this session:\n"
            f"{files}\n"
            "Read them now, so you can draw on them for this and later questions.]\n\n"
        )
    if gone:
        names = ", ".join(m["filename"] for m in gone)
        note += f"[The user removed these materials; don't use them any more: {names}]\n\n"
    return note, [m["id"] for m in new + gone]


def _user_turn(text: str, selection: dict | None, images: list[str] | None = None) -> str:
    """The user's question, preceded by the images and PDF passage it is about (if any)."""
    prefix = ""
    if images:
        files = "\n".join(f"- ./{config.ATTACHMENTS_DIR}/{name}" for name in images)
        prefix += (
            f"[The user pasted {'an image' if len(images) == 1 else f'{len(images)} images'} into this message "
            "(e.g. a screenshot, or a figure, table or equation cropped from the paper). "
            f"Look at {'it' if len(images) == 1 else 'each'} with the Read tool before answering:\n{files}]\n\n"
        )
        if not text:
            text = "(No text: the user sent only the image(s). Work out what they want from the image and the context.)"
    if selection:
        quoted = "\n".join(f"> {line}" for line in selection["text"].splitlines())
        prefix += f"[The user selected this passage on page {selection['page']} of the paper and asks about it:]\n{quoted}\n\n"
    return prefix + text


def _transcript(messages: list[dict], limit: int = 40_000) -> str:
    parts = [
        f"{m['role'].upper()}:\n{_user_turn(m['text'], m.get('selection'), m.get('images'))}" for m in messages
    ]
    text = "\n\n".join(parts)
    return text[-limit:]


CLIP = 20_000  # longest tool input string / tool output kept in a trace


def _clip(value, limit: int = CLIP):
    """Shorten long strings anywhere inside a tool input or output."""
    if isinstance(value, str):
        return value if len(value) <= limit else value[:limit] + f"\n… [{len(value) - limit} more characters]"
    if isinstance(value, list):
        return [_clip(v, limit) for v in value]
    if isinstance(value, dict):
        return {k: _clip(v, limit) for k, v in value.items()}
    return value


def _result_text(content) -> str:
    """The text of a tool_result's content (a string or a list of blocks)."""
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
        else:
            parts.append(f"[{block.get('type', 'content')}]")
    return "\n".join(parts)


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


def start(session_id: str, user_text: str, selection: dict | None = None, images: list[str] | None = None) -> Run:
    """Save the user message and start a background turn. Caller checks is_running first.

    images: names of files in the session's attachments folder sent with the message.
    """
    run = Run(session_id)
    RUNS[session_id] = run
    db.add_message(session_id, "user", user_text, selection=selection, images=images)
    run.task = asyncio.create_task(_turn(run, user_text, selection, images))
    return run


async def stop(session_id: str) -> bool:
    run = RUNS.get(session_id)
    if not run:
        return False
    run.stopped = True
    if run.proc and run.proc.returncode is None:
        run.proc.terminate()
    return True


async def _turn(run: Run, user_text: str, selection: dict | None, images: list[str] | None) -> None:
    sid = run.session_id
    question = _user_turn(user_text, selection, images)
    # text: the answer; tools: short list of tool calls (kept for older messages);
    # trace: every step in order (text, thinking, tool calls with input and output,
    # subagent steps, final stats), streamed to the browser as it happens.
    state = {"text": "", "tools": [], "trace": [], "tool_steps": {}, "open_block": None}
    error = None
    try:
        session = db.get_session(sid)
        notes = ""
        if not session["has_pdf"]:
            session, notes = await _download_linked_paper(run, session, user_text, state)
            if run.stopped:
                return
        prefix = notes + ("" if session["pdf_announced"] or not session["has_pdf"] else _announce_pdf(session))
        materials_note, material_ids = _announce_materials(sid)
        prefix += materials_note

        if session["claude_session_id"]:
            ok, error = await _invoke(run, prefix + question, state, resume=session["claude_session_id"])
            if not ok and error and "No conversation found" in error and not state["text"]:
                # Claude's own history is gone: start over with our saved transcript.
                error = None
                history = db.list_messages(sid)[:-1]
                db.reset_materials_announced(sid)
                materials_note, material_ids = _announce_materials(sid)
                prompt = (
                    "[This continues an earlier conversation whose history was lost. "
                    "Here is the saved transcript:]\n\n"
                    f"{_transcript(history)}\n\n[End of transcript. The user's new message follows.]\n\n"
                    + (_announce_pdf(session) if session["has_pdf"] else "")
                    + materials_note
                    + question
                )
                ok, error = await _invoke(run, prompt, state, new_id=str(uuid.uuid4()))
        else:
            ok, error = await _invoke(run, prefix + question, state, new_id=str(uuid.uuid4()))

        if ok and session["has_pdf"]:
            db.update_session(sid, pdf_announced=1)
        if ok:
            db.materials_announced(sid, material_ids)
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
            msg = db.add_message(sid, "assistant", state["text"], state["tools"], error, trace=state["trace"])
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
        tool = {"name": "Download", "summary": url}  # "Download" also covers saving a web page
        state["tools"].append(tool)
        step = await _add_step(run, state, {"type": "tool", "id": None, "parent": None, "name": "Download",
                                            "summary": url, "input": {"url": url}, "result": None, "is_error": False})
        try:
            session, webpage_url = await papers.fetch_into_session(session["id"], url)
        except Exception as e:
            reason = str(e) if isinstance(e, papers.DownloadError) else f"{type(e).__name__}: {e}"
            log.info("download from %s failed: %s", url, reason)
            tool["summary"] = f"{url} (failed: {reason})"
            await _set_step(run, state, step, result=reason, is_error=True)
            failures.append(f"- {url}: {reason}")
            continue
        tool["summary"] = f"{url} → {session['pdf_filename']}"
        if webpage_url:
            tool["summary"] += " (web page saved as PDF)"
        await _set_step(run, state, step, result=tool["summary"])
        await run.queue.put({"type": "pdf"})
        if webpage_url:
            return session, (
                f"[paper.pdf is the web page {webpage_url} (e.g. a blog post or article), saved as a PDF "
                "that looks like the site. Treat it like a paper: read it and quote it with cite tags.]\n\n"
            )
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
        "--forward-subagent-text",  # subagents' text, for the trace
        "--permission-mode", "dontAsk",
        "--settings", json.dumps(claude_settings(workdir)),
        "--append-system-prompt", SYSTEM_PROMPT,
        # Use the current prompt on every message. By default Claude Code keeps the
        # prompt a conversation started with, so changes would reach new sessions only.
        "--system-prompt-snapshot", "off",
    ]
    if config.CLAUDE_MODEL:
        cmd += ["--model", config.CLAUDE_MODEL]
    if resume:
        cmd += ["--resume", resume]
    else:
        cmd += ["--session-id", new_id]
        db.update_session(run.session_id, claude_session_id=new_id, pdf_announced=0)
        db.reset_materials_announced(run.session_id)

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
        parent = ev.get("parent_tool_use_id")
        kind = ev.get("type")
        if kind == "stream_event":
            if not parent:  # subagent steps come whole, as assistant messages
                await _on_stream_event(run, ev["event"], state)
        elif kind == "assistant":
            await _on_assistant(run, ev["message"], parent, state)
        elif kind == "user":
            await _on_user(run, ev["message"], state)
        elif kind == "system" and ev.get("subtype") == "init":
            state["model"] = ev.get("model")
        elif kind == "result":
            result = ev
            await _add_step(run, state, {
                "type": "result",
                "model": state.get("model"),
                "duration_ms": ev.get("duration_ms"),
                "num_turns": ev.get("num_turns"),
                "cost_usd": ev.get("total_cost_usd"),
                "usage": {k: v for k, v in (ev.get("usage") or {}).items() if isinstance(v, int)},
                "is_error": bool(ev.get("is_error")),
            })

    await proc.wait()
    stderr = (await stderr_task).decode(errors="replace").strip()
    if run.stopped:
        return False, None
    if result and not result.get("is_error"):
        return True, None
    detail = (result or {}).get("result") or "; ".join((result or {}).get("errors") or []) or stderr
    return False, detail or f"claude exited with code {proc.returncode}"


async def _on_stream_event(run: Run, event: dict, state: dict) -> None:
    """Live text and thinking of the main conversation."""
    kind = event.get("type")
    if kind == "message_start" and state["text"] and not state["text"].endswith("\n\n"):
        await _emit_text(run, state, "\n\n")
    elif kind == "content_block_start":
        block_type = (event.get("content_block") or {}).get("type")
        if block_type in ("text", "thinking", "redacted_thinking"):
            step_type = "thinking" if block_type != "text" else "text"
            state["open_block"] = await _add_step(run, state, {"type": step_type, "parent": None, "text": ""})
        else:
            state["open_block"] = None
    elif kind == "content_block_stop":
        state["open_block"] = None
    elif kind == "content_block_delta":
        delta = event.get("delta") or {}
        if delta.get("type") == "text_delta":
            await _emit_text(run, state, delta["text"])
            await _step_delta(run, state, delta["text"])
        elif delta.get("type") == "thinking_delta" and delta.get("thinking"):
            await _step_delta(run, state, delta["thinking"])


async def _on_assistant(run: Run, message: dict, parent: str | None, state: dict) -> None:
    """A finished assistant message: tool calls, and for subagents also text and thinking."""
    for block in message.get("content", []):
        btype = block.get("type")
        if btype == "tool_use":
            inp = block.get("input") or {}
            summary = _tool_summary(block["name"], inp)
            if not parent:
                tool = {"name": block["name"], "summary": summary}
                state["tools"].append(tool)
                await run.queue.put({"type": "tool", **tool})
            index = await _add_step(run, state, {
                "type": "tool", "id": block.get("id"), "parent": parent, "name": block["name"],
                "summary": summary, "input": _clip(inp), "result": None, "is_error": False,
            })
            state["tool_steps"][block.get("id")] = index
        elif parent and btype == "text" and block.get("text"):
            await _add_step(run, state, {"type": "text", "parent": parent, "text": block["text"]})
        elif parent and btype in ("thinking", "redacted_thinking"):
            await _add_step(run, state, {"type": "thinking", "parent": parent, "text": block.get("thinking") or ""})


async def _on_user(run: Run, message: dict, state: dict) -> None:
    """Tool results (of the main conversation and of subagents)."""
    content = message.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if block.get("type") != "tool_result":
            continue  # e.g. the prompt a subagent was given, already in the Task input
        index = state["tool_steps"].get(block.get("tool_use_id"))
        if index is not None:
            await _set_step(run, state, index, result=_clip(_result_text(block.get("content"))),
                            is_error=bool(block.get("is_error")))


async def _add_step(run: Run, state: dict, step: dict) -> int:
    state["trace"].append(step)
    index = len(state["trace"]) - 1
    # A copy: the step changes later, and the queue may be read after that.
    await run.queue.put({"type": "step", "index": index, "step": dict(step)})
    return index


async def _set_step(run: Run, state: dict, index: int, **fields) -> None:
    step = state["trace"][index]
    step.update(fields)
    await run.queue.put({"type": "step", "index": index, "step": dict(step)})


async def _step_delta(run: Run, state: dict, text: str) -> None:
    index = state["open_block"]
    if index is None:
        return
    state["trace"][index]["text"] += text
    await run.queue.put({"type": "step_delta", "index": index, "text": text})


async def _emit_text(run: Run, state: dict, text: str) -> None:
    state["text"] += text
    await run.queue.put({"type": "text", "text": text})
