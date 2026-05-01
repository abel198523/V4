import os
import telebot
from flask import request, jsonify

from telebot import types

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")

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
            "ይህንን ቁጥር በመያዝ ወደ ዌብሳይቱ ተመልሰው ምዝገባዎን ያጠናቅቁ።\n\n"
            "👇 Chat ID ለማግኘት ከታች ያለውን በተን ይጫኑ።"
        )

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

        markup = types.InlineKeyboardMarkup(row_width=1)
        btn_website = types.InlineKeyboardButton("🌐 ወደ ዌብሳይቱ ይሂዱ / Go to Website", url=web_url)
        btn_get_id = types.InlineKeyboardButton("🪪 Get My ID / መለያ ቁጥሬን አሳይ", callback_data="get_id")
        markup.add(btn_website, btn_get_id)

        bot.reply_to(message, welcome_text, reply_markup=markup, parse_mode='Markdown')

    @bot.callback_query_handler(func=lambda call: call.data == "get_id")
    def callback_get_id(call):
        chat_id = call.message.chat.id
        bot.answer_callback_query(call.id)
        bot.send_message(
            chat_id,
            f"🪪 *የእርስዎ Chat ID:*\n`{chat_id}`\n\n"
            f"Your Chat ID is: `{chat_id}`\n\n"
            "ይህንን ቁጥር ኮፒ አድርገው በምዝገባ ቅጹ ላይ ያስገቡ።",
            parse_mode='Markdown'
        )

    @bot.message_handler(commands=['id'])
    def send_id(message):
        bot.reply_to(message, f"🪪 የእርስዎ Chat ID: `{message.chat.id}`", parse_mode='Markdown')

    if __name__ == "__main__":
        print("Bot is starting...")
        bot.infinity_polling()
else:
    print("TELEGRAM_BOT_TOKEN not found. Bot functionality disabled.")
