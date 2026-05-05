import os
import threading
from app import app
from routes import *
from bot import bot, BOT_TOKEN


def run_bot():
    if not BOT_TOKEN:
        return
    print("[Bot] Removing any existing webhook and starting polling mode...")
    try:
        bot.remove_webhook()
    except Exception as e:
        print(f"[Bot] Could not remove webhook: {e}")
    while True:
        try:
            print("[Bot] Polling started.")
            bot.infinity_polling(timeout=30, long_polling_timeout=20)
        except Exception as e:
            print(f"[Bot] Polling error, restarting in 5s: {e}")
            import time
            time.sleep(5)


if BOT_TOKEN:
    bot_thread = threading.Thread(target=run_bot, daemon=True)
    bot_thread.start()
else:
    print("TELEGRAM_BOT_TOKEN not set. Bot functionality disabled.")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
