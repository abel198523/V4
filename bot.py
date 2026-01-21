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
        domain = os.environ.get('REPLIT_DEV_DOMAIN')
        if not domain:
            # Get from domains list if dev domain is not specifically set
            domains = os.environ.get('REPLIT_DOMAINS')
            if domains:
                domain = domains.split(',')[0]
            else:
                domain = "royal-bingo.replit.app"
            
        web_url = f"https://{domain}"
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
