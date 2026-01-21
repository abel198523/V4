import os
import telebot
import random
from flask import render_template, request, jsonify, redirect, url_for
from app import app, db
from models import User, Room, Transaction, GameSession
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from bot import bot, BOT_TOKEN

@app.route("/")
def landing():
    if current_user.is_authenticated:
        return redirect(url_for('game_page'))
    return render_template("landing.html")

@app.route("/game")
@login_required
def game_page():
    try:
        from models import Room
        rooms = Room.query.all()
    except Exception:
        db.create_all()
        from models import Room
        rooms = Room.query.all()
        
    if not rooms:
        from models import Room
        room1 = Room(name="Room 1", card_price=10.0)
        room2 = Room(name="Room 2", card_price=20.0)
        db.session.add_all([room1, room2])
        try:
            db.session.commit()
            rooms = [room1, room2]
        except Exception:
            db.session.rollback()
            rooms = []
            
    return render_template("index.html", rooms=rooms, balance=current_user.balance)

@app.route('/webhook/' + (BOT_TOKEN if BOT_TOKEN else 'token'), methods=['POST'])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        json_string = request.get_data().decode('utf-8')
        update = telebot.types.Update.de_json(json_string)
        if bot:
            bot.process_new_updates([update])
        return ''
    return jsonify({"error": "Forbidden"}), 403

OTPS = {}

def get_or_create_session(room_id):
    room = Room.query.get(room_id)
    if not room: return None
    session = None
    if room.active_session_id:
        session = GameSession.query.get(room.active_session_id)
        if session and session.status != 'active': session = None
    if not session:
        session = GameSession(room_id=room_id, status='active')
        db.session.add(session)
        db.session.flush()
        room.active_session_id = session.id
        db.session.commit()
    return session

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.json
    user = User.query.filter_by(username=data.get('username')).first()
    if user and check_password_hash(user.password_hash, data.get('password')):
        login_user(user, remember=True)
        return jsonify({"success": True, "token": "dummy-token-for-auth"})
    return jsonify({"success": False, "message": "Invalid credentials"}), 401

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST": return api_login()
    return render_template("login.html")

@app.route("/signup", methods=["GET", "POST"])
def signup():
    if request.method == "POST": return redirect(url_for('index'))
    return render_template("signup.html")

@app.route("/api/signup-request", methods=["POST"])
def send_otp():
    data = request.json
    username, telegram_chat_id = data.get('username'), data.get('telegram_chat_id')
    if not username or not telegram_chat_id:
        return jsonify({"success": False, "message": "Missing info"}), 400
    otp = str(random.randint(100000, 999999))
    OTPS[telegram_chat_id] = otp
    print(f"DEBUG OTP: {username} -> {otp}")
    if bot:
        try:
            bot.send_message(telegram_chat_id, f"Your code: {otp}")
            return jsonify({"success": True, "message": "OTP sent"})
        except: pass
    return jsonify({"success": True, "message": f"OTP: {otp}"})

@app.route("/api/signup-verify", methods=["POST"])
def verify_otp():
    data = request.json
    if OTPS.get(data.get('telegram_chat_id')) == data.get('otp'):
        if User.query.filter_by(username=data.get('username')).first():
            return jsonify({"success": False, "message": "Taken"}), 400
        user = User(username=data.get('username'), 
                    password_hash=generate_password_hash(data.get('password')),
                    telegram_chat_id=data.get('telegram_chat_id'))
        db.session.add(user)
        db.session.commit()
        # Ensure the user is logged in properly with session persistence
        login_user(user, remember=True)
        del OTPS[data.get('telegram_chat_id')]
        return jsonify({"success": True, "token": "dummy-token-for-auth"})
    return jsonify({"success": False, "message": "Invalid code"}), 400

@app.route("/api/user/balance")
@login_required
def get_balance():
    return jsonify({"balance": current_user.balance})

@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for('landing'))

@app.route("/buy-card/<int:room_id>/<int:card_number>", methods=["POST"])
@login_required
def buy_card(room_id, card_number):
    room = Room.query.get_or_404(room_id)
    if current_user.balance < room.card_price:
        return jsonify({"success": False, "message": "Insufficient balance"}), 400
    session = get_or_create_session(room_id)
    if Transaction.query.filter_by(room_id=room_id, session_id=session.id, card_number=card_number).first():
        return jsonify({"success": False, "message": "Card taken"}), 400
    current_user.balance -= room.card_price
    db.session.add(Transaction(user_id=current_user.id, room_id=room.id, session_id=session.id, amount=room.card_price, card_number=card_number))
    db.session.commit()
    return jsonify({"success": True, "new_balance": current_user.balance})
