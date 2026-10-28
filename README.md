# Paper Viewer

A local web app for reading research papers together with Claude. You open a PDF, ask Claude to read it, and then chat about the paper while the PDF is shown next to the conversation. When Claude's answer is based on specific passages in the paper, those passages are highlighted in the PDF.

The app is a thin front end over the **Claude Code CLI (`claude`) installed on your machine**. It does not call the Anthropic API directly; it uses whatever login, model, settings and skills your local `claude` already has.

## Quick start

```bash
# 1. build the front end (once, and again after changing it)
cd frontend && npm install && npm run build && cd ..

# 2. start the app (uv creates the Python environment on first run)
uv run python -m backend
```

Then open <http://127.0.0.1:8000>.

Tested on Linux (Ubuntu) with Claude Code 2.1, Python 3.13 via uv, and Node 24. macOS should work but has not been tested.

### Requirements

- Claude Code CLI installed and logged in (`claude` works in a terminal).
- [uv](https://docs.astral.sh/uv/) (manages Python 3.12 and the backend dependencies).
- Node.js 20+ (only for building the front end).
- On Linux: bubblewrap and socat (`sudo apt install bubblewrap socat`), used by Claude Code's shell sandbox. On macOS the sandbox uses the built-in Seatbelt and needs nothing extra. Windows is not supported (the sandbox doesn't run there).
- Recommended: poppler-utils (`pdftotext`, `pdfimages`, `pdfinfo`), which Claude uses for better text and figure extraction.
- Optional: paper-reading skills under `~/.claude/skills/` (e.g. `paper_read_en`, `paper_read_cn`).

### Configuration

All optional, set as environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PAPER_VIEWER_DATA` | `~/.paper_viewer` | Where sessions, messages and papers are stored |
| `PAPER_VIEWER_PORT` | `8000` | Port of the web server |
| `PAPER_VIEWER_HOST` | `127.0.0.1` | Address to listen on (keep it local) |
| `PAPER_VIEWER_MODEL` | CLI default | Model for Claude, e.g. `opus`, `sonnet`, `haiku` |
| `PAPER_VIEWER_CLAUDE` | `claude` on `PATH` | Path to the Claude CLI |

Example: `PAPER_VIEWER_MODEL=sonnet uv run python -m backend`

### Development

Run the backend and the Vite dev server side by side; the dev server reloads the UI on every change and forwards `/api` to the backend:

```bash
uv run python -m backend          # terminal 1, port 8000
cd frontend && npm run dev        # terminal 2, open the URL it prints
```

## How it works for the user

### 1. Start screen: a plain chat box

When the app opens, it looks like an ordinary LLM chat interface: a message list and an input box. You can chat with Claude without a paper.

A sidebar on the left lists earlier sessions, newest first. "New session" starts an empty one. The sidebar can be hidden with `«`.

### 2. Open a paper

Each session holds **one paper**. To read a different paper, start a new session.

- Click "Open PDF" (or drop a PDF onto the chat) and pick a file, **or** paste a link to the paper into your message (see [Paper links](#paper-links)).
- Type a reading request, for example:
  - "Summarize this paper and explain the main method."
  - "Read this critically and list the weakest assumptions."
  - "用中文帮我读这篇论文。"
- Send it with Enter (Shift+Enter for a new line).

#### Paper links

If the session has no paper yet and your message contains links, the app first tries to download the paper from them (up to 3 links, first success wins), before Claude starts:

- **Success:** the PDF becomes the session's paper, the split view opens, and the title is taken from the paper. Claude then reads it like an opened file.
- **Failure:** Claude still answers. It is told the download failed and why, and can try to read the page with WebFetch / WebSearch instead. The reason is shown in the message's tool list (e.g. "openreview.net refused the download (HTTP 403)"); you can then download the PDF in the browser and use "Open PDF".

How a link is turned into a PDF:

1. Known sites are mapped straight to their PDF link: arXiv (`/abs/`, `/pdf/`, `/html/`), Hugging Face papers and alphaXiv (via arXiv), OpenReview, ACL Anthology, bioRxiv / medRxiv, NeurIPS proceedings, CVF open access.
2. Any other link is fetched. If it returns a PDF, that's it. If it returns a web page, the app follows the page's `citation_pdf_url` tag, which most publishers set (e.g. DOI links to Nature).

Tested sites: arXiv, Hugging Face, ACL Anthology, NeurIPS, CVF, bioRxiv, Nature (direct and via `doi.org`) all work. **OpenReview fails:** it requires a browser check before downloads, which the app does not try to get around. Paywalled papers fail unless your network has access.

Downloads are limited to 100 MB, and the app checks that the file really is a PDF.

### 3. Claude reads the paper

- Claude reads the PDF with its own tools (`Read`, or `pdftotext` in the shell).
- If paper-reading skills are installed, Claude may use them. The app does not need to know which skills exist.
- The answer streams into the chat. While Claude works, the tool it is using is shown above the answer (e.g. `Bash: pdftotext -layout paper.pdf -`), and a **Stop** button ends the run.

### 4. Split view

Once a PDF is open, the window splits into two panes:

| Left pane | Right pane |
|---|---|
| The PDF, rendered in the browser, with page indicator and zoom. | The conversation with Claude, with the input box at the bottom. |

Drag the divider to resize the panes.

### 5. Quotes and highlighting

When an answer relies on the paper, Claude quotes the passages. In the chat, each quote appears inline as “quoted text”<sup>p.4</sup>:

- The quote is highlighted in the PDF. **Each answer has its own color**: all highlights of one answer, its quote chips in the chat and the bar beside it share that color, and each new answer gets a color not used before in the session. Highlights of the selected answer are strong; those of other answers are faded.
- Colors: the first 10 answers with quotes get 10 hand-picked, well-separated hues (yellow, green, blue, pink, orange, purple, teal, red, lime, indigo). After that, each new hue is 137.5° (the golden angle) around the color wheel from the previous one, which keeps consecutive answers far apart; with more than 10 answers, some colors are similar to earlier ones.
- Clicking a quote selects that answer, scrolls the PDF to the passage and flashes it.
- If the app can't find a quote in the PDF (Claude paraphrased instead of quoting), the quote is shown without highlight and its page number is struck through. Hover for details.

For questions that need outside information, Claude can search the web, fetch pages, or run commands in the session folder (see [Tool permissions](#tool-permissions)).

### 6. Your own highlights

You can highlight the PDF yourself:

- Select text with the mouse (drag, or double-click a word). A small bar with 6 colours appears under the selection: yellow, green, blue, pink, orange, purple. Click one to highlight; Escape or a click elsewhere cancels.
- Click one of your highlights to change its colour or remove it (🗑).
- Your highlights are a marker-style fill with an underline, so they look different from Claude's quote highlights. Where both overlap, both are visible.
- A selection that runs onto the next page is cut at the end of the first page.
- Highlights are saved with the session and come back when you reopen it. Each is stored by its position in the page's text and by the selected text; if the position no longer matches (for example after a PDF.js update), it is found again by its text.

### 7. Saved sessions

Every session is saved automatically: the paper, all messages and the tools used.

- Click a session in the sidebar to reopen it with the PDF, the conversation and the highlights, and keep asking questions.
- The title is the paper's title (from the PDF metadata, or else the largest text on page 1). Rename with ✎ or a double-click; delete with 🗑.
- If you close or reload the page while Claude is answering, the answer is still finished and saved; the session shows "Claude is still answering…" until it is done.

## Architecture

| Part | Choice |
|---|---|
| Backend | Python 3.12, FastAPI, Uvicorn; managed with uv |
| Storage | SQLite (one file in the data folder) |
| Front end | React + TypeScript, built with Vite |
| PDF rendering | PDF.js via `react-pdf` (its text layer is used for highlighting) |
| Chat rendering | `react-markdown` with GFM tables and KaTeX math |

The backend also serves the built front end, so there is one process and one port.

```
┌──────────────────────── Browser ────────────────────────┐
│  PDF pane (PDF.js)          │  Chat pane                │
│  - render pages             │  - messages (streamed)    │
│  - index page text          │  - input box, Stop        │
│  - find quotes, highlight   │  - clickable quotes       │
└──────────────┬──────────────┴──────────────┬────────────┘
               │  HTTP, answers streamed as NDJSON       │
┌──────────────┴──────────────────────────────┴────────────┐
│  Backend (FastAPI)                                       │
│  - stores sessions and messages in SQLite                │
│  - stores the PDF, serves it to the browser              │
│  - runs `claude -p` per message, in the session folder   │
│  - streams Claude's text and tool calls to the browser   │
└──────────────────────────────┬───────────────────────────┘
                               │
                       local `claude` CLI
              (your login, model, settings, skills)
```

### Project layout

```
backend/
  __main__.py          start the server (`python -m backend`)
  app.py               HTTP API, PDF upload, title detection, static files
  claude_runner.py     runs `claude`, system prompt, permissions, streaming
  papers.py            storing the paper, title detection, downloading from links
  db.py                SQLite schema and queries
  config.py            paths and environment variables
  hooks/check_paths.py hook that keeps Write/Edit inside the session folder
frontend/src/
  App.tsx              layout, sessions, sending messages, split view
  PdfPane.tsx          PDF rendering, highlights, scroll-to-quote, zoom
  MessageView.tsx      one chat message: Markdown, quotes, tool list
  citations.ts         parsing <cite> tags and finding quotes in the PDF text
  api.ts               calls to the backend
```

### HTTP API

| Method and path | Purpose |
|---|---|
| `GET /api/sessions` | List sessions, newest first |
| `POST /api/sessions` | Create an empty session |
| `GET /api/sessions/{id}` | Session, its messages and its user highlights |
| `PATCH /api/sessions/{id}` | Rename (`{"title": ...}`) |
| `DELETE /api/sessions/{id}` | Delete the session, its folder and its PDF |
| `POST /api/sessions/{id}/pdf` | Upload the paper (multipart `file`); only once per session |
| `GET /api/sessions/{id}/pdf` | The paper |
| `POST /api/sessions/{id}/messages` | Send `{"text": ...}`; the response is a stream of JSON lines: `text` (a piece of the answer), `tool` (a tool call, including `Download`), `pdf` (the paper was downloaded from a link), `done` (the saved answer) |
| `POST /api/sessions/{id}/stop` | Stop the current answer |
| `POST /api/sessions/{id}/highlights` | Save a user highlight (`page`, `ranges`, `text`, `color`) |
| `PATCH /api/sessions/{id}/highlights/{hid}` | Change its colour (`{"color": ...}`) |
| `DELETE /api/sessions/{id}/highlights/{hid}` | Remove it |

### Talking to the Claude CLI

Each user message runs:

```bash
claude -p --output-format stream-json --verbose --include-partial-messages \
  --permission-mode dontAsk --settings '<generated JSON>' \
  --append-system-prompt '<paper viewer instructions>' \
  --session-id <new uuid>      # first message
  --resume <saved uuid>        # every later message
```

- The message is passed on standard input; the working directory is the session folder.
- If the session has no paper and the message has links, the backend first tries to download the paper (see [Paper links](#paper-links)). This happens in the backend, not in Claude's sandbox, which has no network.
- With the first message after a paper is opened, the backend adds a note telling Claude that the paper is `./paper.pdf`.
- Follow-up messages use `--resume`, so Claude keeps the paper and the conversation in context.
- The run is a background task on the server: it is saved even if the browser disconnects.
- If Claude can't resume its session (its history under `~/.claude/` was deleted), the backend starts a new Claude session and sends the saved transcript along with the new message.
- The system prompt (in `claude_runner.py`) explains the citation format, Markdown/math formatting and the sandbox rules.

### Citation format

Claude is told to quote supporting passages like this, inline in its sentences:

```
The authors propose <cite page="1">a new simple network architecture, the Transformer</cite>, which ...
```

- `page` is the 1-based page index in the PDF file.
- The content is a verbatim quote, at most about 30 words.

The front end then:

1. Indexes the text of every page with PDF.js. Matching ignores case, spaces, punctuation, line-break hyphens and ligatures, so a quote still matches across line breaks.
2. Looks for the quote on the cited page, then the pages next to it, then everywhere (Claude sometimes gets the page wrong). Long quotes with a small difference in the middle still match by their start and end.
3. Marks the matched characters in the PDF text layer.
4. Shows the quote in the chat as a clickable inline quotation.

### Tool permissions

Rule: **Claude may run any command, as long as it changes nothing outside the session's folder.**

Inside the session folder Claude is free to work: extract text, pull out figures, write scratch files, run a Python script to check a number. Outside it, nothing may change.

| Allowed | Blocked |
|---|---|
| Any shell command, e.g. `pdftotext`, `pdfimages`, `python`, `grep` | Writing, moving or deleting anything outside the session folder |
| Creating files in the session folder (`Bash`, `Write`, `Edit`) | Changing `paper.pdf` |
| Reading files (`Read`, `Glob`, `Grep`) | `sudo`, `su`, `kill`, `pkill`, `killall`, `systemctl`, `shutdown`, `reboot`, `crontab` |
| `WebSearch`, `WebFetch`, `Skill`, `TodoWrite`, subagents (`Task`) | Network access from shell commands (use `WebSearch` / `WebFetch`) |
| | MCP tools (not on the allow list) |

#### How this is enforced

The settings are generated for each run by `claude_settings()` in `backend/claude_runner.py` and passed with `--settings`:

1. **OS sandbox for shell commands.** `sandbox.enabled` turns on Claude Code's Bash sandbox (bubblewrap on Linux). Commands can write only to the working directory and to Claude's own temporary folder (`/tmp/claude-<uid>`), and have no network. `allowUnsandboxedCommands: false` stops Claude from retrying a command outside the sandbox.
2. **A hook for file tools.** `Write`, `Edit`, `MultiEdit` and `NotebookEdit` don't go through the sandbox, so a `PreToolUse` hook (`backend/hooks/check_paths.py`) resolves the target path (following `..` and symlinks) and refuses anything outside the session folder, and `paper.pdf` itself.
3. **Allow and deny lists.** `--permission-mode dontAsk` refuses every tool that isn't explicitly allowed, without prompting. The allow list holds the tools in the table; the deny list holds the system commands above.
4. **Protecting the paper.** `paper.pdf` is read-only. After every run the backend compares its SHA-256 with the original and restores it from the backup in `originals/` if it changed. The browser is always served the backup.

When a call is refused, Claude sees why and can try another way.

### Data folder

```
~/.paper_viewer/
├── paper_viewer.db          # SQLite: sessions, messages, highlights
├── originals/
│   └── <session-id>.pdf     # untouched copy of the paper (outside the sandbox)
└── papers/
    └── <session-id>/        # Claude's working directory; the only place it can write
        ├── paper.pdf        # the paper (read-only)
        └── ...              # anything Claude creates: extracted text, figures, scripts
```

- The PDF is uploaded through the browser and copied here, so a session still opens if the original file is moved or deleted.
- `sessions`: id, title, original file name, SHA-256 of the PDF, Claude session id, whether Claude has been told about the PDF, times.
- `messages`: id, session id, role, text, tools used, error (e.g. "Stopped by user."), time. Quotes are part of the message text and are found in the PDF again when a session is opened.
- `highlights`: id, session id, page, ranges (`[itemIndex, start, end]` in the page's text items), selected text, colour, time.
- Claude's own conversation history is kept by the CLI under `~/.claude/projects/`.
- Deleting a session removes its rows, its folder and its backup PDF.

## Known limitations

- Quotes from equations, tables and figures usually can't be highlighted, because the PDF text there is not in reading order. Claude is told to quote the surrounding sentence instead.
- Scanned PDFs without a text layer can't be highlighted.
- Paper links from OpenReview and paywalled publishers can't be downloaded automatically; open the PDF by hand instead.
- When a session has no paper yet, any link in a message is tried as a paper. For a link that isn't a paper (e.g. GitHub), the download fails and Claude simply answers.
- All pages are rendered at once; very long documents (hundreds of pages) may be slow.

## Out of scope

- Multiple users or remote access. The server only listens on localhost.
- More than one paper in a session.
- Editing or annotating the PDF by hand.
- Saving highlights back into the PDF file.
