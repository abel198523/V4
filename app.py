import os
import logging

from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm import DeclarativeBase
from werkzeug.middleware.proxy_fix import ProxyFix

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


db = SQLAlchemy(model_class=Base)
app = Flask(__name__, static_folder='static', template_folder='templates')
app.secret_key = os.environ.get("SESSION_SECRET")
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

# Fix DATABASE_URL: postgres:// -> postgresql://
database_url = os.environ.get("DATABASE_URL")
if not database_url:
    logger.error("DATABASE_URL is not set!")
else:
    if database_url.startswith("postgres://"):
        database_url = database_url.replace("postgres://", "postgresql://", 1)
    logger.info("Database URL configured.")

app.config["SQLALCHEMY_DATABASE_URI"] = database_url

# Engine options: SSL for Render, standard pool settings everywhere
engine_options = {
    "pool_recycle": 300,
    "pool_pre_ping": True,
}
if os.environ.get("RENDER"):
    engine_options["connect_args"] = {"sslmode": "require"}
    logger.info("Render environment detected — SSL enabled for PostgreSQL.")

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
        raise

    # Migration: ensure telegram_chat_id is nullable (older DBs had NOT NULL)
    try:
        db.session.execute(db.text(
            "ALTER TABLE users ALTER COLUMN telegram_chat_id DROP NOT NULL"
        ))
        db.session.commit()
        logger.info("Migration: telegram_chat_id set to nullable.")
    except Exception:
        db.session.rollback()
        # Column is already nullable or table doesn't exist yet — safe to ignore

# Start independent per-room countdown timers
from game_engine import start_all_room_timers
start_all_room_timers()
