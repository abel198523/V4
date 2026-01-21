import os
import telebot
from flask import render_template, request, jsonify, redirect, url_for, session
from app import app, db
from models import User, Room, Transaction, GameSession
from flask_login import LoginManager, login_user, logout_user, login_required, current_user

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))
import random
import requests
from werkzeug.security import generate_password_hash, check_password_hash
from bot import bot, BOT_TOKEN

@app.route('/webhook/' + (BOT_TOKEN if BOT_TOKEN else 'token'), methods=['POST'])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        json_string = request.get_data().decode('utf-8')
        update = telebot.types.Update.de_json(json_string)
        if bot:
            bot.process_new_updates([update])
        return ''
    else:
        return jsonify({"error": "Forbidden"}), 403

# Temp storage for OTPs
OTPS = {}

def get_or_create_session(room_id):
    room = Room.query.get(room_id)
    if not room:
        return None
    
    session = None
    if room.active_session_id:
        session = GameSession.query.get(room.active_session_id)
        if session and session.status != 'active':
            session = None
            
    if not session:
        session = GameSession()
        session.room_id = room_id
        session.status = 'active'
        db.session.add(session)
        db.session.flush()
        room.active_session_id = session.id
        db.session.commit()
    return session

@app.route("/landing")
def landing():
    return render_template("landing.html")

from werkzeug.security import generate_password_hash, check_password_hash

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        data = request.json
        username = data.get('username')
        password = data.get('password')
        
        user = User.query.filter_by(username=username).first()
        if user and check_password_hash(user.password_hash, password):
            login_user(user)
            return jsonify({"success": True, "redirect": url_for('index')})
        return jsonify({"success": False, "message": "Invalid username or password"}), 401
    return render_template("login.html")

@app.route("/signup", methods=["GET", "POST"])
def signup():
    if request.method == "POST":
        return redirect(url_for('index'))
    return render_template("signup.html")

@app.route("/send-otp", methods=["POST"])
def send_otp():
    data = request.json
    username = data.get('username')
    telegram_chat_id = data.get('telegram_chat_id')
    
    if not username or not telegram_chat_id:
        return jsonify({"success": False, "message": "Missing username or chat ID"}), 400
        
    otp = str(random.randint(100000, 999999))
    OTPS[telegram_chat_id] = otp
    
    if bot:
        try:
            bot.send_message(telegram_chat_id, f"Your verification code is: {otp}")
            return jsonify({"success": True})
        except Exception as e:
            return jsonify({"success": False, "message": f"Could not send message to Telegram: {str(e)}"}), 500
    
    return jsonify({"success": False, "message": "Bot not initialized"}), 500

@app.route("/verify-otp", methods=["POST"])
def verify_otp():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    telegram_chat_id = data.get('telegram_chat_id')
    otp = data.get('otp')
    
    if OTPS.get(telegram_chat_id) == otp:
        # Check if user already exists
        if User.query.filter_by(username=username).first():
            return jsonify({"success": False, "message": "Username already taken"}), 400
            
        new_user = User()
        new_user.username = username
        new_user.password_hash = generate_password_hash(password)
        new_user.telegram_chat_id = telegram_chat_id
        
        db.session.add(new_user)
        db.session.commit()
        
        # Clear OTP
        del OTPS[telegram_chat_id]
        return jsonify({"success": True})
    
    return jsonify({"success": False, "message": "Invalid verification code"}), 400

@app.route("/api/user/balance")
@login_required
def get_balance():
    return jsonify({"balance": current_user.balance})

@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for('landing'))

@app.route("/")
@login_required
def index():
    # Attempt to use the existing Room table, handle if it doesn't exist
    try:
        rooms = Room.query.all()
    except Exception:
        db.create_all()
        rooms = Room.query.all()
        
    if not rooms:
        # Create some default rooms if none exist
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

@app.route("/buy-card/<int:room_id>/<int:card_number>", methods=["POST"])
@login_required
def buy_card(room_id, card_number):
    room = Room.query.get_or_404(room_id)
    if card_number < 1 or card_number > 100:
        return jsonify({"success": False, "message": "Invalid card number"}), 400
        
    if current_user.balance < room.card_price:
        return jsonify({"success": False, "message": "የሂሳብ መጠንዎ በቂ አይደለም / Insufficient balance"}), 400
    
    # Check if card is already taken in this session
    session = get_or_create_session(room_id)
    existing_ticket = Transaction.query.filter_by(
        room_id=room_id, 
        session_id=session.id, 
        card_number=card_number
    ).first()
    
    if existing_ticket:
        return jsonify({"success": False, "message": f"ካርድ ቁጥር {card_number} ተይዟል / Card {card_number} is already taken"}), 400

    current_user.balance -= room.card_price
    transaction = Transaction(
        user_id=current_user.id,
        room_id=room.id,
        session_id=session.id,
        amount=room.card_price,
        card_number=card_number
    )
    db.session.add(transaction)
    db.session.commit()
    
    return jsonify({
        "success": True, 
        "message": f"ካርድ ቁጥር {card_number} በተሳካ ሁኔታ ገዝተዋል / Card {card_number} purchased successfully",
        "new_balance": current_user.balance
    })

@app.route("/declare-winner/<int:room_id>", methods=["POST"])
def declare_winner(room_id):
    return jsonify({"success": False, "message": "Disabled"}), 403

@app.route("/admin", methods=["GET", "POST"])
def admin_panel():
    return "Unauthorized", 403

@app.route("/setup-rooms")
def setup_rooms():
    return "Disabled", 403
