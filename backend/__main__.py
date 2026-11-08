import logging
from pathlib import Path

import uvicorn

from . import config

BUILD_HINT = "run `npm install && npm run build` in frontend/, then restart"


def _latest_mtime(paths: list[Path]) -> float:
    """The newest modification time among these files and the files in these folders."""
    latest = 0.0
    for p in paths:
        files = p.rglob("*") if p.is_dir() else [p]
        for f in files:
            if f.is_file():
                latest = max(latest, f.stat().st_mtime)
    return latest


def check_frontend() -> None:
    """Warn when the served front end is missing or older than its sources."""
    dist = config.FRONTEND_DIST
    if not (dist / "index.html").is_file():
        logging.warning("Front end not built: %s", BUILD_HINT)
        return
    frontend = dist.parent
    sources = [frontend / name for name in ("src", "index.html", "package.json", "package-lock.json", "vite.config.ts")]
    if _latest_mtime(sources) > (dist / "index.html").stat().st_mtime:
        logging.warning(
            "Front end build is older than its sources, so the app may lack recent changes: %s", BUILD_HINT
        )
    # Dependencies added to package-lock.json since the last `npm install`.
    installed = frontend / "node_modules" / ".package-lock.json"
    lock = frontend / "package-lock.json"
    if lock.is_file() and (not installed.is_file() or lock.stat().st_mtime > installed.stat().st_mtime):
        logging.warning("Front end dependencies changed since the last `npm install`: %s", BUILD_HINT)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    check_frontend()
    print(f"Paper Viewer: http://{config.HOST}:{config.PORT}")
    uvicorn.run("backend.app:app", host=config.HOST, port=config.PORT)


if __name__ == "__main__":
    main()
