import os
import threading
import time
from app import app
from routes import *
from bot import bot, BOT_TOKEN

def run_bot():
    if BOT_TOKEN:
        # Check if running on Render
        if os.environ.get('RENDER'):
            render_url = os.environ.get('RENDER_EXTERNAL_URL')
            if render_url:
                webhook_url = f"{render_url}/webhook/{BOT_TOKEN}"
                print(f"Setting webhook to: {webhook_url}")
                bot.remove_webhook()
                time.sleep(1)
                bot.set_webhook(url=webhook_url)
            else:
                print("RENDER detected but RENDER_EXTERNAL_URL not found.")
        else:
            print("Starting Telegram Bot (Polling mode)...")
            bot.remove_webhook()
            bot.infinity_polling()

if __name__ == "__main__":
    # Start Telegram Bot in a separate thread
    if BOT_TOKEN:
        bot_thread = threading.Thread(target=run_bot, daemon=True)
        bot_thread.start()

    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
