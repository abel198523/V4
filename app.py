import os
import logging

from flask import Flask
from flask_compress import Compress
from flask_sock import Sock
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm import DeclarativeBase
from werkzeug.middleware.proxy_fix import ProxyFix

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


db = SQLAlchemy(model_class=Base)
app = Flask(__name__, static_folder='static', template_folder='templates')
app.secret_key = os.environ.get("SESSION_SECRET") or os.environ.get("SECRET_KEY")
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

# Allow session cookies in cross-site contexts (Telegram Mini App iframe / WebView)
app.config['SESSION_COOKIE_SAMESITE'] = 'None'
app.config['SESSION_COOKIE_SECURE']   = True
app.config['REMEMBER_COOKIE_SAMESITE'] = 'None'
app.config['REMEMBER_COOKIE_SECURE']   = True

# Gzip compress JSON/HTML responses — reduces payload size by ~70%
app.config['COMPRESS_MIMETYPES'] = [
    'text/html', 'text/css', 'application/json',
    'application/javascript', 'text/javascript',
]
app.config['COMPRESS_LEVEL'] = 6
app.config['COMPRESS_MIN_SIZE'] = 500
Compress(app)
sock = Sock(app)

database_url = os.environ.get("RAILWAY_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not database_url:
    logger.critical(
        "FATAL: DATABASE_URL environment variable is not set. "
        "Add a PostgreSQL database to your project and set DATABASE_URL."
    )
    import sys
    sys.exit(1)

if database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)
logger.info("Database URL configured.")

app.config["SQLALCHEMY_DATABASE_URI"] = database_url

# Engine options: connection pool + SSL for Railway/Render
engine_options = {
    "pool_size":     10,
    "max_overflow":  20,
    "pool_timeout":  10,
    "pool_recycle":  300,
    "pool_pre_ping": True,
}
if os.environ.get("RENDER") or os.environ.get("RAILWAY_ENVIRONMENT"):
    engine_options["connect_args"] = {"sslmode": "require"}
    logger.info("Production environment detected — SSL enabled for PostgreSQL.")
else:
    logger.info("Development environment — SSL not required for PostgreSQL.")

app.config["SQLALCHEMY_ENGINE_OPTIONS"] = engine_options

db.init_app(app)

from flask_login import LoginManager
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'


@login_manager.user_loader
def load_user(user_id):
    from models import User
    return User.query.get(int(user_id))


with app.app_context():
    import models  # noqa: F401
    import routes  # noqa: F401
    try:
        db.create_all()
        logger.info("Database tables created/verified successfully.")
    except Exception as e:
        logger.error(f"Failed to create database tables: {e}")

    # Migration: ensure telegram_chat_id is nullable (older DBs had NOT NULL)
    try:
        db.session.execute(db.text(
            "ALTER TABLE users ALTER COLUMN telegram_chat_id DROP NOT NULL"
        ))
        db.session.commit()
        logger.info("Migration: telegram_chat_id set to nullable.")
    except Exception:
        db.session.rollback()

    # Migration: add referral_code column if not present
    try:
        db.session.execute(db.text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(16) UNIQUE"
        ))
        db.session.commit()
        logger.info("Migration: referral_code column added.")
    except Exception:
        db.session.rollback()

    # Migration: add referral_bonus_paid column if not present
    try:
        db.session.execute(db.text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_bonus_paid BOOLEAN NOT NULL DEFAULT false"
        ))
        db.session.commit()
        logger.info("Migration: referral_bonus_paid column added.")
    except Exception:
        db.session.rollback()

    # Migration: add bonus_balance column if not present
    try:
        db.session.execute(db.text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_balance FLOAT NOT NULL DEFAULT 0"
        ))
        db.session.commit()
        logger.info("Migration: bonus_balance column added.")
    except Exception:
        db.session.rollback()

    # Migration: add withdrawable_balance column if not present
    try:
        db.session.execute(db.text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawable_balance FLOAT NOT NULL DEFAULT 0"
        ))
        db.session.commit()
        logger.info("Migration: withdrawable_balance column added.")
    except Exception:
        db.session.rollback()

    # Migration: add bonus_expires_at column if not present
    try:
        db.session.execute(db.text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_expires_at TIMESTAMP NULL"
        ))
        db.session.commit()
        logger.info("Migration: bonus_expires_at column added.")
    except Exception:
        db.session.rollback()

    # Migration: add streak columns if not present
    try:
        db.session.execute(db.text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS current_streak INTEGER NOT NULL DEFAULT 0"
        ))
        db.session.execute(db.text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_play_date DATE NULL"
        ))
        db.session.commit()
        logger.info("Migration: streak columns added.")
    except Exception:
        db.session.rollback()

    # Migration: add phone_number column if not present
    try:
        db.session.execute(db.text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(32) NULL"
        ))
        db.session.commit()
        logger.info("Migration: phone_number column added.")
    except Exception:
        db.session.rollback()

    # Migration: create login_tokens table if not present
    try:
        db.session.execute(db.text("""
            CREATE TABLE IF NOT EXISTS login_tokens (
                id SERIAL PRIMARY KEY,
                token VARCHAR(64) UNIQUE NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id),
                created_at TIMESTAMP DEFAULT NOW(),
                used BOOLEAN NOT NULL DEFAULT false
            )
        """))
        db.session.execute(db.text(
            "CREATE INDEX IF NOT EXISTS ix_login_tokens_token ON login_tokens(token)"
        ))
        db.session.commit()
        logger.info("Migration: login_tokens table ready.")
    except Exception:
        db.session.rollback()

    # Migration: convert bonus_expires_at to TIMESTAMPTZ (timezone-aware)
    # Only runs if column is currently plain TIMESTAMP (not already TIMESTAMPTZ)
    try:
        result = db.session.execute(db.text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_name='users' AND column_name='bonus_expires_at'"
        )).fetchone()
        if result and result[0] == 'timestamp without time zone':
            db.session.execute(db.text(
                "ALTER TABLE users ALTER COLUMN bonus_expires_at TYPE TIMESTAMPTZ "
                "USING bonus_expires_at AT TIME ZONE 'UTC'"
            ))
            db.session.commit()
            logger.info("Migration: bonus_expires_at converted to TIMESTAMPTZ.")
        else:
            logger.info("Migration: bonus_expires_at already TIMESTAMPTZ, skipped.")
    except Exception as e:
        db.session.rollback()
        logger.warning(f"Migration bonus_expires_at TIMESTAMPTZ skipped: {e}")

    # Migration: unique constraint — one card number per session (prevents duplicate
    # card purchases that could slip through concurrent buy requests).
    # Table is named 'transaction' (SQLAlchemy auto-name for Transaction model).
    try:
        db.session.execute(db.text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_session_card "
            "ON \"transaction\"(session_id, card_number) WHERE session_id IS NOT NULL"
        ))
        db.session.commit()
        logger.info("Migration: unique index on transaction(session_id, card_number) ready.")
    except Exception as e:
        db.session.rollback()
        logger.warning(f"Migration uq_transaction_session_card skipped: {e}")

    # game_participants: one row per player per session for WS state restore
    try:
        db.session.execute(db.text("""
            CREATE TABLE IF NOT EXISTS game_participants (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                session_id INTEGER NOT NULL REFERENCES game_sessions(id),
                card_number INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT uq_gp_user_session UNIQUE (user_id, session_id)
            )
        """))
        db.session.commit()
        logger.info("Migration: game_participants table ready.")
    except Exception as e:
        db.session.rollback()
        logger.warning(f"Migration game_participants skipped: {e}")

    # Generate referral codes for users who don't have one
    try:
        import secrets as _sec
        from models import User as _User
        missing = _User.query.filter(_User.referral_code.is_(None)).all()
        for u in missing:
            for _ in range(20):
                code = _sec.token_urlsafe(6)
                if not _User.query.filter_by(referral_code=code).first():
                    u.referral_code = code
                    break
        if missing:
            db.session.commit()
            logger.info(f"Generated referral codes for {len(missing)} existing users.")
    except Exception as e:
        db.session.rollback()
        logger.warning(f"Referral code generation failed: {e}")

# Room timers are started by gunicorn's post_fork hook (gunicorn.conf.py)
# so they run only in worker processes, not the master process.
