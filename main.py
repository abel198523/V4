import os
import threading
import time
from app import app
from routes import *
from bot import bot, BOT_TOKEN


def run_bot():
    if not BOT_TOKEN:
        return

    if os.environ.get('RENDER'):
        # Render deployment: use webhook via RENDER_EXTERNAL_URL
        render_url = os.environ.get('RENDER_EXTERNAL_URL')
        if render_url:
            webhook_url = f"{render_url}/webhook/{BOT_TOKEN}"
            print(f"[Render] Setting Telegram webhook to: {webhook_url}")
            try:
                bot.remove_webhook()
                time.sleep(1)
                bot.set_webhook(url=webhook_url)
                print("[Render] Webhook set successfully.")
            except Exception as e:
                print(f"[Render] Failed to set webhook: {e}")
        else:
            print("[Render] RENDER_EXTERNAL_URL not found. Bot webhook not set.")

    elif os.environ.get('REPLIT_DEV_DOMAIN') or os.environ.get('REPLIT_DOMAINS'):
        # Replit deployment: use webhook via Replit domain
        domain = os.environ.get('REPLIT_DEV_DOMAIN') or (
            os.environ.get('REPLIT_DOMAINS', '').split(',')[0]
        )
        webhook_url = f"https://{domain}/webhook/{BOT_TOKEN}"
        print(f"[Replit] Setting Telegram webhook to: {webhook_url}")
        try:
            bot.remove_webhook()
            time.sleep(1)
            bot.set_webhook(url=webhook_url)
            print("[Replit] Webhook set successfully.")
        except Exception as e:
            print(f"[Replit] Failed to set webhook: {e}")

    else:
        # Local / other: use long polling
        print("[Local] Starting Telegram Bot in polling mode...")
        try:
            bot.remove_webhook()
            bot.infinity_polling()
        except Exception as e:
            print(f"[Local] Bot polling error: {e}")


if BOT_TOKEN:
    bot_thread = threading.Thread(target=run_bot, daemon=True)
    bot_thread.start()
else:
    print("TELEGRAM_BOT_TOKEN not set. Bot functionality disabled.")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
