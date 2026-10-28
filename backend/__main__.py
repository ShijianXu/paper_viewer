import logging

import uvicorn

from . import config


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if not config.FRONTEND_DIST.is_dir():
        logging.warning("Front end not built: run `npm install && npm run build` in frontend/")
    print(f"Paper Viewer: http://{config.HOST}:{config.PORT}")
    uvicorn.run("backend.app:app", host=config.HOST, port=config.PORT)


if __name__ == "__main__":
    main()
