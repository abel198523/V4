import os
import threading
import time
from app import app
from routes import *
from bot import bot, BOT_TOKEN


def run_bot():
    if BOT_TOKEN:
        replit_domain = os.environ.get('REPLIT_DEV_DOMAIN') or (
            os.environ.get('REPLIT_DOMAINS', '').split(',')[0] if os.environ.get('REPLIT_DOMAINS') else None
        )
        if replit_domain:
            webhook_url = f"https://{replit_domain}/webhook/{BOT_TOKEN}"
            print(f"Setting Telegram webhook to: {webhook_url}")
            bot.remove_webhook()
            time.sleep(1)
            bot.set_webhook(url=webhook_url)
        else:
            print("Starting Telegram Bot (Polling mode)...")
            bot.remove_webhook()
            bot.infinity_polling()


if BOT_TOKEN:
    bot_thread = threading.Thread(target=run_bot, daemon=True)
    bot_thread.start()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
