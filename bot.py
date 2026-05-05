import os
import secrets
import logging
import telebot
from telebot import types

logger = logging.getLogger(__name__)

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
if not BOT_TOKEN:
    raise EnvironmentError(
        "TELEGRAM_BOT_TOKEN environment variable is not set or is empty. "
        "Set it before starting the application."
    )
logger.info(f"TELEGRAM_BOT_TOKEN loaded — length={len(BOT_TOKEN)}, starts_with={BOT_TOKEN[:6]}***")

BOT_USERNAME = None

bot = None

def _get_web_url():
    # Explicit override always wins
    app_url = os.environ.get('APP_URL')
    if app_url:
        return app_url.rstrip('/')

    # Replit: prefer the deployed domain (REPLIT_DOMAINS) over dev-tunnel
    replit_domains = os.environ.get('REPLIT_DOMAINS', '')
    if replit_domains:
        first = replit_domains.split(',')[0].strip()
        if first:
            return f"https://{first}"

    replit_dev = os.environ.get('REPLIT_DEV_DOMAIN')
    if replit_dev:
        return f"https://{replit_dev}"

    # Other platforms
    render_url = os.environ.get('RENDER_EXTERNAL_URL')
    if render_url:
        return render_url

    railway_domain = os.environ.get('RAILWAY_PUBLIC_DOMAIN')
    if railway_domain:
        return f"https://{railway_domain}"

    return 'http://localhost:5000'


def _get_or_create_user_and_token(tg_id, first_name, last_name, username, phone_number=None, ref_code=None):
    """Get/create user and return (user_id, login_token) — all in one app context."""
    from app import app, db
    from models import User, LoginToken
    import secrets as sec_mod

    with app.app_context():
        user = User.query.filter_by(telegram_chat_id=str(tg_id)).first()
        if user:
            if phone_number and not user.phone_number:
                user.phone_number = phone_number
                db.session.commit()
        else:
            # Build a unique username
            base_un = username or first_name or f"user{str(tg_id)[-6:]}"
            base_un = base_un.replace(' ', '_').lower()
            uname = base_un
            counter = 1
            while User.query.filter_by(username=uname).first():
                uname = f"{base_un}{counter}"
                counter += 1

            # Generate referral code
            code = None
            for _ in range(20):
                c = sec_mod.token_urlsafe(6)
                if not User.query.filter_by(referral_code=c).first():
                    code = c
                    break

            user = User(
                username=uname,
                telegram_chat_id=str(tg_id),
                phone_number=phone_number,
                password_hash=None,
                referral_code=code,
            )
            db.session.add(user)
            db.session.flush()

            if ref_code:
                referrer = User.query.filter_by(referral_code=ref_code.strip()).first()
                if referrer and referrer.id != user.id:
                    user.referred_by = ref_code.strip()

            db.session.commit()

        # Create one-time login token in the same context
        token_str = sec_mod.token_urlsafe(32)
        lt = LoginToken(token=token_str, user_id=user.id)
        db.session.add(lt)
        db.session.commit()

        return user.id, token_str


if BOT_TOKEN:
    bot = telebot.TeleBot(BOT_TOKEN, threaded=False)
    try:
        BOT_USERNAME = bot.get_me().username
    except Exception:
        BOT_USERNAME = None

    @bot.message_handler(commands=['start'])
    def send_welcome(message):
        ref_code = ''
        parts = message.text.split()
        if len(parts) > 1:
            ref_code = parts[1]

        chat_id = message.chat.id
        first_name = message.from_user.first_name or ''

        web_url = _get_web_url()
        # Append ref code as startapp param so Mini App can pick it up
        mini_app_url = f"{web_url}/?ref={ref_code}" if ref_code else web_url

        # Inline keyboard with Mini App button
        markup = types.InlineKeyboardMarkup()
        markup.add(types.InlineKeyboardButton(
            "🎮 ጨዋታ ጀምር / Play Now",
            web_app=types.WebAppInfo(url=mini_app_url)
        ))

        bot.send_message(
            chat_id,
            f"🎮 *እንኳን ወደ NOVA BINGO በደህና መጡ!*\n\n"
            f"ሰላም *{first_name}*! 👋\n\n"
            f"ከታች ያለውን ቁልፍ ተጭነው ወዲያው ጨዋታ ይጀምሩ። "
            f"ምዝገባ አያስፈልግም — ቴሌግራም አካውንትዎ ይበቃል! 🚀",
            parse_mode='Markdown',
            reply_markup=markup
        )

    # Also set bot menu button to open the Mini App
    try:
        web_url = _get_web_url()
        bot.set_chat_menu_button(
            menu_button=types.MenuButtonWebApp(
                type="web_app",
                text="🎮 ጨዋታ",
                web_app=types.WebAppInfo(url=web_url)
            )
        )
        logger.info("Bot menu button set to Mini App.")
    except Exception as e:
        logger.warning(f"Could not set menu button: {e}")

    @bot.message_handler(content_types=['contact'])
    def handle_contact(message):
        contact = message.contact
        chat_id = message.chat.id

        # Only allow sharing own contact
        if contact.user_id != message.from_user.id:
            bot.send_message(chat_id, "⚠️ እባክዎ የራስዎን ቁጥር ያጋሩ።")
            return

        phone_number = contact.phone_number
        first_name = contact.first_name or message.from_user.first_name or ''
        last_name = contact.last_name or message.from_user.last_name or ''
        tg_username = message.from_user.username or ''

        # Retrieve stored ref_code
        ref_code = ''
        try:
            from app import app, db
            from models import Setting
            with app.app_context():
                key = f"ref_{chat_id}"
                s = Setting.query.get(key)
                if s:
                    ref_code = s.value or ''
                    db.session.delete(s)
                    db.session.commit()
        except Exception:
            pass

        # Get or create user AND create login token — all in one db context
        try:
            user_id, token = _get_or_create_user_and_token(
                tg_id=chat_id,
                first_name=first_name,
                last_name=last_name,
                username=tg_username,
                phone_number=phone_number,
                ref_code=ref_code,
            )
        except Exception as e:
            logger.error(f"User/token creation failed: {e}")
            bot.send_message(chat_id, "❌ ምዝገባ አልተሳካም። እንደገና ይሞክሩ /start")
            return

        # Remove keyboard and notify user
        remove_markup = types.ReplyKeyboardRemove()
        bot.send_message(
            chat_id,
            f"✅ *ምዝገባ ተሳካ!*\n\n"
            f"ሰላም *{first_name}*! አካውንትዎ ተፈጥሯል። 🎉\n\n"
            f"▶️ አሁን በቴሌግራም ታች ያለውን *Open* ቁልፍ ተጭነው ጨዋታ ይጀምሩ።",
            parse_mode='Markdown',
            reply_markup=remove_markup
        )

    @bot.message_handler(commands=['login'])
    def send_login_link(message):
        """Returning users can get a new login link with /login"""
        chat_id = message.chat.id
        try:
            from app import app, db
            from models import User, LoginToken
            import secrets as sec_mod
            with app.app_context():
                user = User.query.filter_by(telegram_chat_id=str(chat_id)).first()
                if not user:
                    bot.send_message(
                        chat_id,
                        "⚠️ አካውንት አልተገኘም። /start ይጫኑ ለመመዝገብ።"
                    )
                    return
                token_str = sec_mod.token_urlsafe(32)
                lt = LoginToken(token=token_str, user_id=user.id)
                db.session.add(lt)
                db.session.commit()

            bot.send_message(
                chat_id,
                "▶️ በቴሌግራም ታች ያለውን *Open* ቁልፍ ተጭነው ጨዋታ ይጀምሩ።",
                parse_mode='Markdown'
            )
        except Exception as e:
            logger.error(f"/login error: {e}")
            bot.send_message(chat_id, "❌ ሊንክ ሊፈጠር አልቻለም። እንደገና ይሞክሩ።")

    @bot.message_handler(commands=['id'])
    def send_id(message):
        bot.reply_to(message, f"🪪 የእርስዎ Chat ID: `{message.chat.id}`", parse_mode='Markdown')

    if __name__ == "__main__":
        print("Bot is starting...")
        bot.infinity_polling()
else:
    print("TELEGRAM_BOT_TOKEN not found. Bot functionality disabled.")
