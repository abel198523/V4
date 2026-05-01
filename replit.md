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
- `DATABASE_URL` — PostgreSQL connection string (auto-set by Replit DB)
- `SESSION_SECRET` — Flask session secret key
- `TELEGRAM_BOT_TOKEN` — (Optional) Telegram bot token for OTP signup flow

## User Flow
1. User visits the landing page
2. User opens Telegram and sends `/start` to the bot to get an OTP
3. User signs up on the website using their Telegram chat ID + OTP
4. User logs in and enters bingo rooms to buy cards and play
5. Admin can manage user balances via `/admin`
