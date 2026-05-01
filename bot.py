import os
import telebot
from flask import request, jsonify

from telebot import types

# Get token from environment
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")

# Initialize bot to None by default
bot = None

if BOT_TOKEN:
    bot = telebot.TeleBot(BOT_TOKEN, threaded=False)

    @bot.message_handler(commands=['start'])
    def send_welcome(message):
        import random
        from routes import OTPS
        otp = str(random.randint(100000, 999999))
        OTPS[str(message.chat.id)] = otp
        
        welcome_text = (
            "🎮 እንኳን ወደ ROYAL BINGO በደህና መጡ!\n\n"
            f"የእርስዎ መለያ ማረጋገጫ ኮድ፡ `{otp}`\n"
            f"Your verification code is: `{otp}`\n\n"
            "ይህንን ቁጥር በመያዝ ወደ ዌብሳይቱ ተመልሰው ምዝገባዎን ያጠናቅቁ።"
        )
        
        markup = types.InlineKeyboardMarkup()
        # Determine the public URL based on the environment
        render_url = os.environ.get('RENDER_EXTERNAL_URL')
        replit_domain = os.environ.get('REPLIT_DEV_DOMAIN') or (
            os.environ.get('REPLIT_DOMAINS', '').split(',')[0]
            if os.environ.get('REPLIT_DOMAINS') else None
        )
        if render_url:
            web_url = render_url
        elif replit_domain:
            web_url = f"https://{replit_domain}"
        else:
            web_url = os.environ.get('APP_URL', 'http://localhost:5000')
        btn = types.InlineKeyboardButton("ወደ ዌብሳይቱ ይሂዱ / Go to Website", url=web_url)
        markup.add(btn)
        
        bot.reply_to(message, welcome_text, reply_markup=markup, parse_mode='Markdown')

    @bot.message_handler(commands=['id'])
    def send_id(message):
        bot.reply_to(message, f"የእርስዎ Chat ID: `{message.chat.id}`", parse_mode='Markdown')

    if __name__ == "__main__":
        print("Bot is starting...")
        bot.infinity_polling()
else:
    print("TELEGRAM_BOT_TOKEN not found. Bot functionality disabled.")
