# Nova Bingo

A Telegram-integrated bingo gambling web app where users register via a Telegram bot, manage a wallet, and join timed bingo rooms to buy cards and win prize pools.

## Run & Operate

- **Start:** `bash start.sh` (runs gunicorn via `.pythonlibs/bin`)
- **Required secrets:** `SESSION_SECRET`, `DATABASE_URL` (auto-provided by Replit PostgreSQL)
- **Optional secrets:** `TELEGRAM_BOT_TOKEN` — bot disabled gracefully if missing

## Stack

- Python 3.11, Flask 3.1, SQLAlchemy 2.0, Flask-Login, Flask-Compress, Flask-Sock
- PostgreSQL via psycopg2-binary (Replit built-in)
- Gunicorn (gthread, 1 worker, 8 threads)
- pyTelegramBotAPI for Telegram bot integration

## Where things live

- `main.py` — entry point; starts Telegram bot polling thread if token present
- `app.py` — Flask app factory, DB init, all migrations inline
- `routes.py` — all HTTP routes and API endpoints
- `game_engine.py` — per-room game loop timers, winner detection/awarding
- `models.py` — SQLAlchemy models (User, Room, GameSession, Transaction, etc.)
- `bot.py` — Telegram bot command handlers
- `templates/` — Jinja2 HTML templates
- `static/` — CSS and JS (game.js polls `/api/room-status` every second)
- `gunicorn.conf.py` — gunicorn config; starts room timers via `post_fork`
- `start.sh` — sets PATH to `.pythonlibs/bin` then execs gunicorn

## Architecture decisions

- Room game loops run in background threads started in gunicorn's `post_fork` hook so they survive forking and only run in worker processes
- All DB migrations run inline at startup in `app.py` (no migration framework)
- Telegram bot runs in a daemon thread alongside gunicorn; gracefully degrades if `TELEGRAM_BOT_TOKEN` is absent
- Session cookies set to `SameSite=None; Secure` to support Telegram Mini App iframe/WebView embedding
- `start.sh` exports `.pythonlibs/bin` to PATH so gunicorn is found without system install

## Product

- Users register/login via Telegram bot OTP or Telegram Mini App auth
- Wallet system: deposit, withdraw, bonus balance with expiry
- Bingo rooms with stake tiers; users buy up to 2 cards per round during 20s selection window
- Server-side game loop calls balls (1–75) every 3s, awards prize pool (minus 10% house fee) to winner(s)
- Admin panel for user management, balance adjustments, revenue reporting
- Referral system with bonus rewards

## User preferences

- Keep Telegram bot as optional (disabled gracefully when token missing)

## Gotchas

- `DATABASE_URL` must start with `postgresql://` not `postgres://` — `app.py` fixes this automatically
- Room timers must be started in `post_fork`, not at module import time, to survive gunicorn forking
- `gunicorn` binary lives in `.pythonlibs/bin` — always use `bash start.sh` or set PATH first
- To enable the Telegram bot, set `TELEGRAM_BOT_TOKEN` as a secret in the Secrets panel

## Pointers

- Workflows skill: `.local/skills/workflows/SKILL.md`
- Environment secrets skill: `.local/skills/environment-secrets/SKILL.md`
