import os
import threading
import time
from app import app
from routes import *
from bot import bot, BOT_TOKEN


def run_bot():
    if not BOT_TOKEN:
        return

    # Determine webhook URL from environment
    app_url = (
        os.environ.get('APP_URL') or
        os.environ.get('RENDER_EXTERNAL_URL') or
        os.environ.get('RAILWAY_PUBLIC_DOMAIN') and f"https://{os.environ.get('RAILWAY_PUBLIC_DOMAIN')}"
    )
    replit_domain = os.environ.get('REPLIT_DEV_DOMAIN') or (
        os.environ.get('REPLIT_DOMAINS', '').split(',')[0]
        if os.environ.get('REPLIT_DOMAINS') else None
    )
    if replit_domain:
        app_url = f"https://{replit_domain}"

    if app_url:
        webhook_url = f"{app_url.rstrip('/')}/webhook/{BOT_TOKEN}"
        print(f"[Bot] Setting Telegram webhook to: {webhook_url}")
        try:
            bot.remove_webhook()
            time.sleep(1)
            bot.set_webhook(url=webhook_url)
            print("[Bot] Webhook set successfully.")
        except Exception as e:
            print(f"[Bot] Failed to set webhook: {e}")
    else:
        # Local fallback: use long polling
        print("[Bot] No public URL found — starting in polling mode...")
        try:
            bot.remove_webhook()
            bot.infinity_polling()
        except Exception as e:
            print(f"[Bot] Polling error: {e}")


if BOT_TOKEN:
    bot_thread = threading.Thread(target=run_bot, daemon=True)
    bot_thread.start()
else:
    print("TELEGRAM_BOT_TOKEN not set. Bot functionality disabled.")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
