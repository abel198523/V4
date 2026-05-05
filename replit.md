# NOVA BINGO

A Telegram-integrated bingo game platform built with Flask and PostgreSQL.

## Architecture

- **Backend**: Flask (Python 3.11) with Flask-SQLAlchemy, Flask-Login, Flask-Compress
- **Database**: PostgreSQL (Replit-managed via `DATABASE_URL`)
- **Auth**: Custom Telegram OTP / token-based login (no external auth provider)
- **Bot**: Telegram bot (`pyTelegramBotAPI`) for user registration and login link delivery
- **Frontend**: Jinja2 templates + vanilla JS + static CSS

## Project Structure

```
app.py           — Flask app, DB, session/auth setup, startup migrations
main.py          — Entry point: imports app, starts Telegram bot thread conditionally
routes.py        — All Flask route handlers and API endpoints
models.py        — SQLAlchemy models (User, Room, GameSession, Transaction, etc.)
game_engine.py   — Game/session logic, room timers, daily report scheduler
bot.py           — Telegram bot (OTP/login flow, webhook vs polling logic)
card_data.py     — Card data helpers
cards.json       — Card data
gunicorn.conf.py — Gunicorn runtime config (1 worker, 8 threads, post_fork timer restart)
templates/       — Jinja2 HTML templates
static/          — CSS, JS, images
```

## Running the App

The app is started via gunicorn (PATH must include `.pythonlibs/bin`):
```
export PATH="/home/runner/workspace/.pythonlibs/bin:$PATH" && gunicorn --bind 0.0.0.0:5000 --reuse-port --reload --config gunicorn.conf.py main:app
```

## Environment Variables / Secrets

| Key | Required | Notes |
|-----|----------|-------|
| `DATABASE_URL` | Yes | Auto-managed by Replit PostgreSQL |
| `SESSION_SECRET` | Yes | Auto-managed by Replit |
| `TELEGRAM_BOT_TOKEN` | Optional | Set to enable Telegram bot features |

## Key Features

- **Bingo rooms**: Multiple rooms with configurable card prices (ETB)
- **Telegram login**: Users register and log in via the Telegram bot
- **Wallet system**: Balance, bonus balance, deposits, withdrawals
- **Referral system**: Referral codes with bonus rewards
- **Streak tracking**: Daily play streak tracking
- **Admin panel**: `/admin` route for managing users, rooms, deposit/withdraw requests
- **Real-time game**: Per-room countdown timers running as background threads

## Auth Flow

1. User clicks "Login via Telegram" on landing page
2. Telegram bot sends a one-time login token
3. User clicks the login link which calls `/auth/token/<token>`
4. Flask-Login session is established

## Telegram Bot Modes

- **Replit** (dev): Sets webhook to `REPLIT_DEV_DOMAIN`
- **Render** (prod): Sets webhook to `RENDER_EXTERNAL_URL`
- **Local**: Falls back to long polling

## Database Migrations

Inline migrations run at startup in `app.py` using `ALTER TABLE ... IF NOT EXISTS` patterns — safe to re-run on every boot.
