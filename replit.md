# Royal Bingo

## Overview
A multiplayer bingo game web application built with Flask. Users register via Telegram OTP, join stake rooms, and play real-time bingo games. Supports an admin interface for balance management.

## Architecture

### Backend
- **Framework**: Python Flask
- **Database**: PostgreSQL via Flask-SQLAlchemy (Replit built-in DB)
- **Auth**: Flask-Login with session-based authentication
- **Telegram Bot**: pyTelegramBotAPI for OTP-based signup verification

### Frontend
- **Templates**: Jinja2 HTML templates with Bootstrap
- **Real-time**: WebSocket-driven game UI (`static/js/game.js`)
- **Pages**: landing, login, signup, game (rooms), admin, dashboard

### Key Files
- `main.py` — App entrypoint; starts the Flask app via gunicorn and optionally the Telegram bot
- `app.py` — Flask app factory, SQLAlchemy config, LoginManager setup
- `routes.py` — All route handlers and API endpoints
- `models.py` — SQLAlchemy models: User, Room, GameSession, Transaction
- `bot.py` — Telegram bot definition with OTP and /id command handlers
- `static/js/game.js` — WebSocket game client logic
- `templates/` — Jinja2 HTML templates
- `cards.json` — Predefined bingo card data

## Running the App
The app runs via gunicorn on port 5000:
```
gunicorn --bind 0.0.0.0:5000 --reuse-port --reload main:app
```

## Environment Variables / Secrets
- `DATABASE_URL` — PostgreSQL connection string (auto-set by Replit DB; on Render, set manually from your Render PostgreSQL service)
- `SESSION_SECRET` — Flask session secret key (random string, keep it secret)
- `TELEGRAM_BOT_TOKEN` — (Optional) Telegram bot token for OTP signup flow
- `APP_URL` — (Optional, local dev only) Public URL fallback if not on Render or Replit

## Render Deployment (Manual Setup — No Blueprint)

### 1. Create a Render Web Service
- Go to https://dashboard.render.com → **New → Web Service**
- Connect your GitHub/GitLab repo
- **Environment**: Python 3
- **Build Command**: `pip install -r requirements.txt`
- **Start Command**: `gunicorn main:app --bind 0.0.0.0:$PORT --workers 2 --threads 2 --timeout 120`

### 2. Create a Render PostgreSQL Database
- Go to **New → PostgreSQL** on Render dashboard
- After creation, copy the **Internal Database URL**

### 3. Set Environment Variables on Render
In your Web Service → **Environment** tab, add:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | Internal Database URL from your Render PostgreSQL |
| `SESSION_SECRET` | Any long random string (e.g. generate with `python -c "import secrets; print(secrets.token_hex(32))"`) |
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token from @BotFather (optional) |

> Render automatically sets `RENDER=true` and `RENDER_EXTERNAL_URL` — **do not add these manually**.

### 4. Deploy
Click **Deploy** — the app will start automatically. Telegram webhook will be registered to `RENDER_EXTERNAL_URL/webhook/<token>` on startup.

## User Flow
1. User visits the landing page
2. User opens Telegram and sends `/start` to the bot to get an OTP
3. User signs up on the website using their Telegram chat ID + OTP
4. User logs in and enters bingo rooms to buy cards and play
5. Admin can manage user balances via `/admin`
