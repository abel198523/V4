import os
import threading
import traceback
import telebot
import random
from flask import render_template, request, jsonify, redirect, url_for
from app import app, db
from models import User, Room, Transaction, GameSession, OTPStore, DepositRequest, WithdrawRequest, Setting
from flask_login import login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from bot import bot, BOT_TOKEN, BOT_USERNAME

# Global lock: ensures only one thread can create/fetch a session at a time.
# This prevents the race condition where two players buying simultaneously
# each create their own isolated session instead of sharing one.
_session_create_lock = threading.Lock()


from werkzeug.exceptions import HTTPException

@app.errorhandler(HTTPException)
def http_error(e):
    if e.code == 404:
        return render_template("error.html", error=e, traceback=None, code=404), 404
    return render_template("error.html", error=e, traceback=None, code=e.code), e.code

@app.errorhandler(Exception)
def handle_exception(e):
    if isinstance(e, HTTPException):
        return http_error(e)
    db.session.rollback()
    tb = traceback.format_exc()
    import logging
    logging.error(f"Unhandled exception: {e}\n{tb}")
    return render_template("error.html", error=e, traceback=tb, code=500), 500


def save_otp(telegram_chat_id, otp):
    existing = OTPStore.query.filter_by(telegram_chat_id=str(telegram_chat_id)).first()
    if existing:
        existing.otp = otp
    else:
        db.session.add(OTPStore(telegram_chat_id=str(telegram_chat_id), otp=otp))
    db.session.commit()


def get_otp(telegram_chat_id):
    record = OTPStore.query.filter_by(telegram_chat_id=str(telegram_chat_id)).first()
    return record.otp if record else None


def delete_otp(telegram_chat_id):
    OTPStore.query.filter_by(telegram_chat_id=str(telegram_chat_id)).delete()
    db.session.commit()


@app.route("/")
def landing():
    if current_user.is_authenticated:
        return redirect(url_for('game_page'))
    return render_template("landing.html")


@app.route("/game")
@login_required
def game_page():
    try:
        rooms = Room.query.all()
    except Exception:
        db.create_all()
        rooms = Room.query.all()

    stakes_needed = [10]
    existing_prices = {r.card_price for r in rooms}
    for s in stakes_needed:
        if float(s) not in existing_prices:
            # Use INSERT ... ON CONFLICT DO NOTHING to prevent race-condition duplicates
            db.session.execute(db.text(
                "INSERT INTO room (name, card_price) VALUES (:name, :price) "
                "ON CONFLICT DO NOTHING"
            ), {"name": f"Room {s} ETB", "price": float(s)})
    try:
        db.session.commit()
        rooms = Room.query.all()
    except Exception:
        db.session.rollback()
    if not rooms:
        rooms = []

    tg_link_status = request.args.get('tg_link', '')
    response = render_template(
        "index.html",
        rooms=rooms,
        balance=current_user.balance,
        bonus_balance=current_user.bonus_balance,
        withdrawable_balance=current_user.withdrawable_balance,
        bot_username=BOT_USERNAME,
        has_telegram=bool(current_user.telegram_chat_id),
        tg_link_status=tg_link_status,
    )
    from flask import make_response
    resp = make_response(response)
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


@app.route('/webhook/' + (BOT_TOKEN if BOT_TOKEN else 'token'), methods=['POST'])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        json_string = request.get_data().decode('utf-8')
        update = telebot.types.Update.de_json(json_string)
        if bot:
            bot.process_new_updates([update])
        return ''
    return jsonify({"error": "Forbidden"}), 403


def get_or_create_session(room_id):
    with _session_create_lock:
        # Expire all cached ORM objects so we read fresh state from the DB.
        # This is critical: without it, a second concurrent thread could read a
        # stale Room.active_session_id = None even after the first thread already
        # committed a new session, causing each player to land in a separate
        # isolated session (the "playing separately" bug).
        db.session.expire_all()
        room = Room.query.get(room_id)
        if not room:
            return None
        game_session = None
        if room.active_session_id:
            game_session = GameSession.query.get(room.active_session_id)
            if game_session and game_session.status != 'active':
                game_session = None
        if not game_session:
            game_session = GameSession(room_id=room_id, status='active')
            db.session.add(game_session)
            db.session.flush()
            room.active_session_id = game_session.id
            db.session.commit()
        return game_session


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
    if request.method == "POST":
        return api_login()
    return render_template("login.html", bot_username=BOT_USERNAME)


@app.route("/tg-login/<token>")
def tg_login(token):
    """One-time auto-login link sent by the Telegram bot."""
    from models import LoginToken
    import datetime
    lt = LoginToken.query.filter_by(token=token, used=False).first()
    if not lt:
        return render_template("tg_login_invalid.html", bot_username=BOT_USERNAME), 400
    age = datetime.datetime.utcnow() - lt.created_at.replace(tzinfo=None)
    if age.total_seconds() > 600:
        lt.used = True
        db.session.commit()
        return render_template("tg_login_invalid.html", bot_username=BOT_USERNAME), 400
    lt.used = True
    db.session.commit()
    user = User.query.get(lt.user_id)
    if not user:
        return render_template("tg_login_invalid.html", bot_username=BOT_USERNAME), 400
    login_user(user, remember=True)
    return redirect(url_for('game_page'))


@app.route("/api/tg-miniapp-auth", methods=["POST"])
def tg_miniapp_auth():
    """Authenticate user via Telegram Mini App initData."""
    import hmac
    import hashlib
    import json
    import urllib.parse
    import secrets as sec_mod

    data = request.get_json(force=True) or {}
    init_data = data.get("initData", "")

    if not init_data:
        return jsonify({"success": False, "error": "No initData"}), 400

    if not BOT_TOKEN:
        return jsonify({"success": False, "error": "Bot not configured"}), 500

    # Validate initData HMAC
    params = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
    received_hash = params.pop("hash", None)
    if not received_hash:
        return jsonify({"success": False, "error": "Missing hash"}), 400

    data_check_string = "\n".join(
        f"{k}={v}" for k, v in sorted(params.items())
    )
    secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(computed_hash, received_hash):
        return jsonify({"success": False, "error": "Invalid initData"}), 403

    # Parse user info from initData
    user_str = params.get("user")
    if not user_str:
        return jsonify({"success": False, "error": "No user in initData"}), 400

    try:
        tg_user = json.loads(user_str)
    except Exception:
        return jsonify({"success": False, "error": "Bad user data"}), 400

    tg_id = str(tg_user.get("id", ""))
    first_name = tg_user.get("first_name", "")
    last_name = tg_user.get("last_name", "")
    tg_username = tg_user.get("username", "")
    ref_code = data.get("ref", "").strip()

    if not tg_id:
        return jsonify({"success": False, "error": "No Telegram ID"}), 400

    # Get or create user
    user = User.query.filter_by(telegram_chat_id=tg_id).first()
    if not user:
        base_un = tg_username or first_name or f"user{tg_id[-6:]}"
        base_un = base_un.replace(" ", "_").lower()
        uname = base_un
        counter = 1
        while User.query.filter_by(username=uname).first():
            uname = f"{base_un}{counter}"
            counter += 1

        code = None
        for _ in range(20):
            c = sec_mod.token_urlsafe(6)
            if not User.query.filter_by(referral_code=c).first():
                code = c
                break

        user = User(
            username=uname,
            telegram_chat_id=tg_id,
            password_hash=None,
            referral_code=code,
        )
        db.session.add(user)
        db.session.flush()

        if ref_code:
            referrer = User.query.filter_by(referral_code=ref_code).first()
            if referrer and referrer.id != user.id:
                user.referred_by = ref_code

        db.session.commit()

    login_user(user, remember=True)
    return jsonify({"success": True, "redirect": url_for("game_page")})


@app.route("/auth/telegram")
def telegram_auth():
    """Legacy Telegram widget auth — redirect to bot instructions."""
    return redirect(url_for('login'))


def _apply_referral_bonus(new_user, ref_code):
    """Record who referred this user at signup. Bonus is paid on first deposit."""
    if not ref_code:
        return
    referrer = User.query.filter_by(referral_code=ref_code).first()
    if not referrer or referrer.id == new_user.id:
        return
    new_user.referred_by = ref_code


def _apply_first_deposit_referral_bonus(user):
    """Credit referral bonus to both user and referrer on user's first approved deposit."""
    if not user or not user.referred_by:
        return
    if user.referral_bonus_paid:
        return
    referrer = User.query.filter_by(referral_code=user.referred_by).first()
    if not referrer:
        return
    bonus = _get_referral_bonus()
    if bonus <= 0:
        return
    from datetime import datetime, timezone, timedelta
    expiry_days  = _get_bonus_expiry_days()
    new_exp      = datetime.now(timezone.utc) + timedelta(days=expiry_days)
    user.bonus_balance        = round(float(user.bonus_balance or 0) + bonus, 2)
    user.bonus_expires_at     = new_exp
    referrer.bonus_balance    = round(float(referrer.bonus_balance or 0) + bonus, 2)
    referrer.bonus_expires_at = new_exp
    user.referral_bonus_paid  = True
    db.session.flush()
    exp_str = new_exp.strftime("%Y-%m-%d")
    _notify_user_telegram(referrer,
        f"🎁 *Referral Bonus ተሰጥቶዎታል!*\n\n"
        f"ወዳጆዎ *{user.username}* ለመጀመሪያ ጊዜ ዲፖዚት አድርጓል!\n"
        f"💰 Bonus: *{bonus:.2f} ETB* ወደ ቦነስ ባላንስዎ ታክሏል።\n"
        f"⏳ ጊዜ ያልፋል: *{exp_str}* (ካልተጫወቱ ይሰረዛል)"
    )
    _notify_user_telegram(user,
        f"🎁 *Referral Bonus ተሰጥቶዎታል!*\n\n"
        f"ለመጀመሪያ ዲፖዚት ምስጋና! *{bonus:.2f} ETB* bonus ተጨምሯል።\n"
        f"⏳ ጊዜ ያልፋል: *{exp_str}* (ካልተጫወቱ ይሰረዛል)"
    )


@app.route("/signup", methods=["GET", "POST"])
def signup():
    ref_code = request.args.get('ref', '').strip()
    if request.method == "POST":
        username  = request.form.get('username', '').strip()
        password  = request.form.get('password', '')
        form_ref  = request.form.get('ref', '').strip() or ref_code
        error     = None
        error_type = None

        if not username or not password:
            error      = "Username and password are required."
            error_type = "validation"
        elif len(password) < 6:
            error      = "Password must be at least 6 characters."
            error_type = "validation"
        elif User.query.filter_by(username=username).first():
            error      = "This username is already registered."
            error_type = "taken"
        else:
            try:
                import secrets
                code = None
                for _ in range(20):
                    c = secrets.token_urlsafe(6)
                    if not User.query.filter_by(referral_code=c).first():
                        code = c
                        break
                user = User(
                    username=username,
                    password_hash=generate_password_hash(password),
                    referral_code=code,
                )
                db.session.add(user)
                db.session.flush()
                _apply_referral_bonus(user, form_ref)
                db.session.commit()
                login_user(user, remember=True)
                return redirect(url_for('game_page'))
            except Exception as e:
                db.session.rollback()
                tb = traceback.format_exc()
                import logging
                logging.error(f"Signup error for '{username}': {e}\n{tb}")
                return render_template("error.html", error=e, traceback=tb, code=500), 500

        return render_template("signup.html", error=error, error_type=error_type,
                               username=username, ref_code=form_ref, bot_username=BOT_USERNAME)

    return render_template("signup.html", ref_code=ref_code, bot_username=BOT_USERNAME)


@app.route("/api/signup-request", methods=["POST"])
def send_otp():
    # Verification temporarily disabled
    return jsonify({"success": True, "message": "OK"})


@app.route("/api/signup-verify", methods=["POST"])
def verify_otp():
    # Verification temporarily disabled
    return jsonify({"success": True, "message": "OK"})


@app.route("/api/signup", methods=["POST"])
def do_signup():
    import secrets
    data      = request.json or {}
    username  = data.get('username', '').strip()
    password  = data.get('password', '')
    ref_code  = data.get('ref', '').strip()

    if not username or not password:
        return jsonify({"success": False, "message": "Username and password are required"}), 400
    if len(password) < 6:
        return jsonify({"success": False, "message": "Password must be at least 6 characters"}), 400
    if User.query.filter_by(username=username).first():
        return jsonify({"success": False, "message": "Username already taken"}), 400

    code = None
    for _ in range(20):
        c = secrets.token_urlsafe(6)
        if not User.query.filter_by(referral_code=c).first():
            code = c
            break

    user = User(
        username=username,
        password_hash=generate_password_hash(password),
        referral_code=code,
    )
    db.session.add(user)
    db.session.flush()
    _apply_referral_bonus(user, ref_code)
    db.session.commit()
    login_user(user, remember=True)

    bonus = _get_referral_bonus() if ref_code else 0
    return jsonify({"success": True, "referral_bonus": bonus if ref_code and user.referred_by else 0})


@app.route("/api/user/balance")
@login_required
def get_balance():
    # Reload only the balance columns — avoids a full ORM refresh round-trip
    user = User.query.with_entities(
        User.balance, User.withdrawable_balance, User.bonus_balance, User.bonus_expires_at, User.username
    ).filter_by(id=current_user.id).first()
    if not user:
        return jsonify({"error": "user not found"}), 404
    dep          = round(float(user.balance or 0), 2)
    withdrawable = round(float(user.withdrawable_balance or 0), 2)
    bonus        = round(float(user.bonus_balance or 0), 2)
    exp          = user.bonus_expires_at.isoformat() if user.bonus_expires_at else None
    return jsonify({
        "balance":              dep,
        "withdrawable_balance": withdrawable,
        "bonus_balance":        bonus,
        "total_balance":        round(dep + withdrawable + bonus, 2),
        "bonus_expires_at":     exp,
        "username":             user.username,
    })


@app.route("/api/room-status")
def room_status():
    from game_engine import get_all_room_status
    return jsonify(get_all_room_status())


@app.route("/api/taken-cards/<int:stake>")
@login_required
def taken_cards(stake):
    """Return list of card numbers taken in the current active session for a room."""
    room = Room.query.filter_by(card_price=float(stake)).first()
    if not room:
        return jsonify({"taken": []})
    if not room.active_session_id:
        return jsonify({"taken": []})
    taken = [
        t.card_number for t in
        Transaction.query.filter_by(
            room_id=room.id,
            session_id=room.active_session_id
        ).with_entities(Transaction.card_number).all()
    ]
    return jsonify({"taken": taken})


def _admin_ok():
    """Accept either a session-based admin user OR X-Admin-Key header with the stored password."""
    from models import Setting
    key = request.headers.get('X-Admin-Key', '')
    if key:
        stored = Setting.query.get('admin_password')
        correct = stored.value if stored else 'fidel123'
        return key == correct
    try:
        return current_user.is_authenticated and current_user.is_admin
    except Exception:
        return False


@app.route("/api/admin/user/<username>")
def admin_get_user(username):
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    user = User.query.filter_by(username=username).first()
    if not user:
        return jsonify({"error": "ተጠቃሚ አልተገኘም"}), 404
    return jsonify({
        "id":                   user.id,
        "username":             user.username,
        "balance":              round(float(user.balance or 0), 2),
        "withdrawable_balance": round(float(user.withdrawable_balance or 0), 2),
        "bonus_balance":        round(float(user.bonus_balance or 0), 2),
        "is_admin":             user.is_admin,
    })


@app.route("/api/admin/adjust-balance", methods=["POST"])
def admin_adjust_balance():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json() or {}
    user_id = data.get("user_id")
    amount  = data.get("amount")
    note    = data.get("note", "Admin adjustment")

    if user_id is None or amount is None:
        return jsonify({"error": "user_id and amount are required"}), 400

    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid amount"}), 400

    user = User.query.get(user_id)
    if not user:
        return jsonify({"error": "ተጠቃሚ አልተገኘም"}), 404

    new_balance = round(user.balance + amount, 2)
    if new_balance < 0:
        return jsonify({"error": f"ባላንስ አሉታዊ ሊሆን አይችልም (current: {user.balance:.2f} ETB)"}), 400

    user.balance = new_balance
    db.session.commit()
    return jsonify({
        "success":     True,
        "username":    user.username,
        "new_balance": new_balance,
        "adjusted_by": round(amount, 2),
    })


@app.route("/api/room-history")
def room_history():
    if not current_user.is_authenticated:
        return jsonify({"error": "Unauthorized"}), 401
    from game_engine import get_house_fee
    sessions = (GameSession.query
                .filter(GameSession.status == 'completed')
                .order_by(GameSession.id.desc())
                .limit(5)
                .all())
    result = []
    fee = get_house_fee()
    for gs in sessions:
        room = Room.query.get(gs.room_id)
        winner = User.query.get(gs.winner_id) if gs.winner_id else None
        tx_count = Transaction.query.filter_by(session_id=gs.id).count()
        prize = 0.0
        if room and tx_count:
            prize = round(tx_count * room.card_price * (1 - fee), 2)
        result.append({
            'winner': winner.username if winner else '—',
            'prize': prize,
            'cards': tx_count,
            'created_at': gs.created_at.strftime('%H:%M') if gs.created_at else '—',
        })
    return jsonify(result)


@app.route("/api/admin/game-history")
def admin_game_history():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    sessions = (GameSession.query
                .filter(GameSession.status == 'completed')
                .order_by(GameSession.id.desc())
                .limit(50)
                .all())
    result = []
    for gs in sessions:
        room = Room.query.get(gs.room_id)
        winner = User.query.get(gs.winner_id) if gs.winner_id else None
        tx_count = Transaction.query.filter_by(session_id=gs.id).count()
        prize = 0.0
        if room and tx_count:
            prize = round(tx_count * room.card_price * 0.9, 2)
        result.append({
            'session_id': gs.id,
            'room': room.name if room else '—',
            'stake': room.card_price if room else 0,
            'players': tx_count,
            'winner': winner.username if winner else '—',
            'prize': prize,
            'created_at': gs.created_at.strftime('%Y-%m-%d %H:%M') if gs.created_at else '—',
        })
    return jsonify(result)


@app.route("/api/admin/revenue")
def admin_revenue():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403

    from datetime import datetime, timezone, timedelta
    from game_engine import get_house_fee
    from sqlalchemy import func

    fee = get_house_fee()
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    def _session_stats(sessions):
        income = 0.0
        payout = 0.0
        cards  = 0
        for gs in sessions:
            room = Room.query.get(gs.room_id)
            if not room:
                continue
            tx_count = Transaction.query.filter_by(session_id=gs.id).count()
            round_income  = tx_count * float(room.card_price)
            round_payout  = round_income * (1 - fee)
            income += round_income
            payout += round_payout
            cards  += tx_count
        return cards, round(income, 2), round(payout, 2)

    # Today's completed sessions
    today_sessions = (GameSession.query
                      .filter(GameSession.status == 'completed')
                      .filter(GameSession.created_at >= today_start)
                      .all())
    t_cards, t_income, t_payout = _session_stats(today_sessions)

    # All-time completed sessions
    all_sessions = GameSession.query.filter(GameSession.status == 'completed').all()
    a_cards, a_income, a_payout = _session_stats(all_sessions)

    # Active players today (distinct users who bought a card today)
    active_today = (db.session.query(func.count(func.distinct(Transaction.user_id)))
                    .filter(Transaction.timestamp >= today_start)
                    .scalar() or 0)

    # Total registered users
    total_users = User.query.count()

    # Today's approved deposits
    today_deposits = round(db.session.query(func.coalesce(func.sum(DepositRequest.amount), 0))
                           .filter(DepositRequest.status == 'approved')
                           .filter(DepositRequest.created_at >= today_start)
                           .scalar() or 0, 2)

    # All-time approved deposits
    all_deposits = round(db.session.query(func.coalesce(func.sum(DepositRequest.amount), 0))
                         .filter(DepositRequest.status == 'approved')
                         .scalar() or 0, 2)

    # Today's approved withdrawals
    today_withdrawals = round(db.session.query(func.coalesce(func.sum(WithdrawRequest.amount), 0))
                              .filter(WithdrawRequest.status == 'approved')
                              .filter(WithdrawRequest.created_at >= today_start)
                              .scalar() or 0, 2)

    # All-time approved withdrawals
    all_withdrawals = round(db.session.query(func.coalesce(func.sum(WithdrawRequest.amount), 0))
                            .filter(WithdrawRequest.status == 'approved')
                            .scalar() or 0, 2)

    # Net app profit = deposits received - withdrawals paid out + game house-fee profit
    today_net = round(today_deposits - today_withdrawals + (t_income - t_payout), 2)
    all_net   = round(all_deposits - all_withdrawals + (a_income - a_payout), 2)

    # Last 10 completed rounds detail
    recent_sessions = (GameSession.query
                       .filter(GameSession.status == 'completed')
                       .order_by(GameSession.id.desc())
                       .limit(10)
                       .all())
    recent_rounds = []
    for gs in recent_sessions:
        room = Room.query.get(gs.room_id)
        if not room:
            continue
        tx_count   = Transaction.query.filter_by(session_id=gs.id).count()
        r_income   = round(tx_count * float(room.card_price), 2)
        r_payout   = round(r_income * (1 - fee), 2)
        r_profit   = round(r_income - r_payout, 2)
        winner_obj = User.query.get(gs.winner_id) if gs.winner_id else None
        recent_rounds.append({
            "session_id": gs.id,
            "cards":      tx_count,
            "income":     r_income,
            "payout":     r_payout,
            "profit":     r_profit,
            "winner":     winner_obj.username if winner_obj else "—",
            "time":       gs.created_at.strftime("%H:%M") if gs.created_at else "—",
        })

    return jsonify({
        "today": {
            "rounds":      len(today_sessions),
            "cards":       t_cards,
            "income":      t_income,
            "payout":      t_payout,
            "game_profit": round(t_income - t_payout, 2),
            "deposits":    today_deposits,
            "withdrawals": today_withdrawals,
            "net_profit":  today_net,
        },
        "alltime": {
            "rounds":      len(all_sessions),
            "cards":       a_cards,
            "income":      a_income,
            "payout":      a_payout,
            "game_profit": round(a_income - a_payout, 2),
            "deposits":    all_deposits,
            "withdrawals": all_withdrawals,
            "net_profit":  all_net,
        },
        "recent_rounds":          recent_rounds,
        "active_players_today":   active_today,
        "total_users":            total_users,
        "house_fee_pct":          round(fee * 100),
        "generated_at":           now.strftime("%Y-%m-%d %H:%M UTC"),
    })


def _get_referral_bonus():
    from models import Setting
    s = Setting.query.get('referral_bonus')
    try:
        return round(float(s.value), 2) if s else 5.0
    except Exception:
        return 5.0


def _get_bonus_expiry_days():
    from models import Setting
    s = Setting.query.get('bonus_expiry_days')
    try:
        v = int(s.value) if s else 30
        return max(1, v)
    except Exception:
        return 30


_STREAK_REWARDS = [2, 2, 2, 2, 2, 2, 10]  # Day 1–6: 2 ETB, Day 7: 10 ETB (cycles)


def _get_streak_reward(streak_day):
    idx = (max(streak_day, 1) - 1) % 7
    return _STREAK_REWARDS[idx]


def _check_and_update_streak(user):
    """Update daily streak on card purchase. Credits bonus_balance and notifies via Telegram.
    Returns (rewarded: bool, streak: int, reward_etb: float)."""
    from datetime import datetime, timezone, timedelta
    EAT = timezone(timedelta(hours=3))
    today = datetime.now(EAT).date()

    prev_streak = int(user.current_streak or 0)
    last = user.last_play_date  # may be None or date

    if last == today:
        return False, prev_streak, 0

    if last is None or (today - last).days > 1:
        new_streak = 1
    else:
        new_streak = prev_streak + 1

    user.current_streak = new_streak
    user.last_play_date = today

    reward = _get_streak_reward(new_streak)
    expiry_days = _get_bonus_expiry_days()
    new_exp = datetime.now(timezone.utc) + timedelta(days=expiry_days)
    user.bonus_balance = round(float(user.bonus_balance or 0) + reward, 2)
    exp_at = user.bonus_expires_at
    if exp_at is not None and exp_at.tzinfo is None:
        exp_at = exp_at.replace(tzinfo=timezone.utc)
    if not exp_at or exp_at < new_exp:
        user.bonus_expires_at = new_exp

    milestones = {3, 7, 14, 21, 30}
    is_milestone = new_streak in milestones

    def _render(tmpl, default):
        t = tmpl.strip() if tmpl and tmpl.strip() else default
        return (t.replace("{username}", user.username or "ጨዋታ")
                 .replace("{streak}", str(new_streak))
                 .replace("{reward}", str(int(reward)))
                 .replace("{next_reward}", str(_get_streak_reward(new_streak + 1))))

    fire = "🔥" * min(new_streak, 5)
    default_auto = (
        f"{fire} *{new_streak} ቀን Streak!*\n\n"
        f"ዛሬ ጨዋታ ስለተጫወቱ *{reward:.0f} ETB* ቦነስ ታክሏል! 🎁\n"
        f"ነገ ቢጫወቱ: *{_get_streak_reward(new_streak + 1):.0f} ETB* ይጠብቆዎታል።"
    )
    msg = _render(_get_streak_auto_msg(), default_auto)
    if is_milestone:
        default_ms = f"🏆 *{new_streak} ቀን milestone!* ትልቅ ስኬት! 🎉"
        msg += "\n" + _render(_get_streak_milestone_msg(), default_ms)
    _notify_user_telegram(user, msg)
    return True, new_streak, reward


def _maybe_expire_user_bonus(user):
    """Zero bonus_balance if it has expired. Returns True if it was expired."""
    from datetime import datetime, timezone
    if user.bonus_balance and user.bonus_balance > 0 and user.bonus_expires_at:
        now = datetime.now(timezone.utc)
        exp = user.bonus_expires_at
        if exp.tzinfo is None:
            from datetime import timezone as tz
            exp = exp.replace(tzinfo=tz.utc)
        if now >= exp:
            user.bonus_balance   = 0.0
            user.bonus_expires_at = None
            return True
    return False


@app.route("/api/user/referral")
@login_required
def user_referral():
    import secrets
    # Ensure user has a referral code
    if not current_user.referral_code:
        for _ in range(20):
            code = secrets.token_urlsafe(6)
            if not User.query.filter_by(referral_code=code).first():
                current_user.referral_code = code
                db.session.commit()
                break
    referred_users  = User.query.filter_by(referred_by=current_user.referral_code).all()
    confirmed_count = sum(1 for u in referred_users if u.referral_bonus_paid)
    pending_count   = len(referred_users) - confirmed_count
    bonus           = _get_referral_bonus()
    return jsonify({
        "referral_code":   current_user.referral_code,
        "referred_count":  len(referred_users),
        "confirmed_count": confirmed_count,
        "pending_count":   pending_count,
        "bonus_per_ref":   bonus,
        "bonus_earned":    round(confirmed_count * bonus, 2),
        "bot_username":    BOT_USERNAME or "",
    })


@app.route("/api/user/streak")
@login_required
def user_streak():
    from datetime import datetime, timezone, timedelta
    EAT = timezone(timedelta(hours=3))
    today = datetime.now(EAT).date()
    last  = current_user.last_play_date

    # Break streak if user hasn't played today or yesterday
    streak_valid = last is not None and (today - last).days <= 1
    if not streak_valid and int(current_user.current_streak or 0) > 0:
        current_user.current_streak = 0
        db.session.commit()

    streak      = int(current_user.current_streak or 0)
    played_today = (last == today)
    next_day    = (streak % 7) + 1
    return jsonify({
        "streak":       streak,
        "played_today": played_today,
        "rewards":      _STREAK_REWARDS,
        "next_reward":  _get_streak_reward(next_day),
    })


def _get_withdraw_min():
    s = Setting.query.get('withdraw_min')
    try:
        return float(s.value) if s else 50.0
    except (ValueError, AttributeError):
        return 50.0


def _get_withdraw_max():
    s = Setting.query.get('withdraw_max')
    try:
        return float(s.value) if s else 10000.0
    except (ValueError, AttributeError):
        return 10000.0


_PAYMENT_METHODS = [
    {"key": "telebirr", "label": "TeleBirr"},
    {"key": "cbe",      "label": "CBE (Commercial Bank of Ethiopia)"},
    {"key": "awash",    "label": "Awash Bank"},
]


def _get_payment_methods_config():
    """Return list of payment method configs (all methods, enabled or not)."""
    methods = []
    for m in _PAYMENT_METHODS:
        k = m["key"]
        enabled_s  = Setting.query.get(f"pay_{k}_enabled")
        account_s  = Setting.query.get(f"pay_{k}_account")
        name_s     = Setting.query.get(f"pay_{k}_name")
        methods.append({
            "key":     k,
            "label":   m["label"],
            "enabled": (enabled_s.value == "1") if enabled_s else True,
            "account": account_s.value if account_s else "",
            "name":    name_s.value if name_s else "",
        })
    return methods


@app.route("/api/payment-methods")
@login_required
def get_payment_methods():
    """Public (logged-in) endpoint: returns enabled payment methods with account info."""
    cfg = _get_payment_methods_config()
    return jsonify([m for m in cfg if m["enabled"]])


def _get_streak_auto_msg():
    s = Setting.query.get('streak_auto_msg')
    return s.value if s else ""


def _get_streak_milestone_msg():
    s = Setting.query.get('streak_milestone_msg')
    return s.value if s else ""


def _get_lb_prizes():
    defaults = {1: 500.0, 2: 300.0, 3: 100.0}
    result = {}
    for rank, default in defaults.items():
        s = Setting.query.get(f'lb_prize_{rank}')
        result[rank] = round(float(s.value), 2) if s else default
    return result


def _get_lb_period_enabled(period):
    """Return True if the leaderboard period tab is enabled (default: True)."""
    s = Setting.query.get(f'lb_period_{period}_enabled')
    if s is None:
        return True
    return s.value == '1'


def _get_lb_prize_enabled(period):
    """Return True if prizes are active for this leaderboard period (default: False)."""
    s = Setting.query.get(f'lb_prize_{period}_enabled')
    if s is None:
        return False
    return s.value == '1'


@app.route("/api/admin/settings", methods=["GET"])
def get_admin_settings():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    from game_engine import get_card_select_time, get_house_fee
    prizes = _get_lb_prizes()
    return jsonify({
        "card_select_time":           get_card_select_time(),
        "house_fee_pct":              round(get_house_fee() * 100),
        "referral_bonus":             _get_referral_bonus(),
        "bonus_expiry_days":          _get_bonus_expiry_days(),
        "withdraw_min":               _get_withdraw_min(),
        "withdraw_max":               _get_withdraw_max(),
        "payment_methods":            _get_payment_methods_config(),
        "streak_auto_msg":            _get_streak_auto_msg(),
        "streak_milestone_msg":       _get_streak_milestone_msg(),
        "lb_prize_1":                 prizes[1],
        "lb_prize_2":                 prizes[2],
        "lb_prize_3":                 prizes[3],
        "lb_period_daily_enabled":    _get_lb_period_enabled('daily'),
        "lb_period_weekly_enabled":   _get_lb_period_enabled('weekly'),
        "lb_period_monthly_enabled":  _get_lb_period_enabled('monthly'),
        "lb_period_all_enabled":      _get_lb_period_enabled('all'),
        "lb_prize_daily_enabled":     _get_lb_prize_enabled('daily'),
        "lb_prize_weekly_enabled":    _get_lb_prize_enabled('weekly'),
        "lb_prize_monthly_enabled":   _get_lb_prize_enabled('monthly'),
    })


@app.route("/api/admin/settings", methods=["POST"])
def update_admin_settings():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json() or {}
    errors = []
    from models import Setting

    def _save(key, val, lo, hi):
        if val is None:
            return
        if not isinstance(val, int) or val < lo or val > hi:
            errors.append(f"{key} must be an integer between {lo} and {hi}")
            return
        s = Setting.query.get(key)
        if s:
            s.value = str(val)
        else:
            db.session.add(Setting(key=key, value=str(val)))

    _save('card_select_time', data.get('card_select_time'), 5, 120)
    _save('house_fee_pct',    data.get('house_fee_pct'),    0,  50)

    # referral_bonus: float, 0–100 ETB
    rb = data.get('referral_bonus')
    if rb is not None:
        try:
            rb_f = round(float(rb), 2)
            if rb_f < 0 or rb_f > 100:
                errors.append("referral_bonus must be 0–100 ETB")
            else:
                s = Setting.query.get('referral_bonus')
                if s:
                    s.value = str(rb_f)
                else:
                    db.session.add(Setting(key='referral_bonus', value=str(rb_f)))
        except (ValueError, TypeError):
            errors.append("referral_bonus must be a number")

    # bonus_expiry_days: int 1–365
    bed = data.get('bonus_expiry_days')
    if bed is not None:
        try:
            bed_i = int(bed)
            if bed_i < 1 or bed_i > 365:
                errors.append("bonus_expiry_days must be 1–365")
            else:
                s = Setting.query.get('bonus_expiry_days')
                if s:
                    s.value = str(bed_i)
                else:
                    db.session.add(Setting(key='bonus_expiry_days', value=str(bed_i)))
        except (ValueError, TypeError):
            errors.append("bonus_expiry_days must be an integer")

    # withdraw_min / withdraw_max: float ETB
    for key, default_lo, default_hi in [('withdraw_min', 10, 50000), ('withdraw_max', 10, 50000)]:
        val = data.get(key)
        if val is not None:
            try:
                val_f = round(float(val), 2)
                if val_f < 0:
                    errors.append(f"{key} must be >= 0")
                else:
                    s = Setting.query.get(key)
                    if s:
                        s.value = str(val_f)
                    else:
                        db.session.add(Setting(key=key, value=str(val_f)))
            except (ValueError, TypeError):
                errors.append(f"{key} must be a number")

    # streak_auto_msg / streak_milestone_msg: free-text strings
    for msg_key in ('streak_auto_msg', 'streak_milestone_msg'):
        msg_val = data.get(msg_key)
        if msg_val is not None:
            val_str = str(msg_val).strip()
            s = Setting.query.get(msg_key)
            if s:
                s.value = val_str
            else:
                db.session.add(Setting(key=msg_key, value=val_str))

    # lb_prize_1 / lb_prize_2 / lb_prize_3: float ETB >= 0
    for rank in (1, 2, 3):
        pval = data.get(f'lb_prize_{rank}')
        if pval is not None:
            try:
                pval_f = round(float(pval), 2)
                if pval_f < 0:
                    errors.append(f"lb_prize_{rank} must be >= 0")
                else:
                    key = f'lb_prize_{rank}'
                    s = Setting.query.get(key)
                    if s:
                        s.value = str(pval_f)
                    else:
                        db.session.add(Setting(key=key, value=str(pval_f)))
            except (ValueError, TypeError):
                errors.append(f"lb_prize_{rank} must be a number")

    # lb period enable/disable: daily | weekly | monthly | all
    for period in ('daily', 'weekly', 'monthly', 'all'):
        key = f'lb_period_{period}_enabled'
        val = data.get(key)
        if val is not None:
            flag = '1' if val else '0'
            s = Setting.query.get(key)
            if s:
                s.value = flag
            else:
                db.session.add(Setting(key=key, value=flag))

    # lb prize on/off per period: daily | weekly | monthly
    for period in ('daily', 'weekly', 'monthly'):
        key = f'lb_prize_{period}_enabled'
        val = data.get(key)
        if val is not None:
            flag = '1' if val else '0'
            s = Setting.query.get(key)
            if s:
                s.value = flag
            else:
                db.session.add(Setting(key=key, value=flag))

    # cross-validate min < max
    wmin = data.get('withdraw_min')
    wmax = data.get('withdraw_max')
    if wmin is not None and wmax is not None:
        try:
            if float(wmin) >= float(wmax):
                errors.append("withdraw_min must be less than withdraw_max")
        except (ValueError, TypeError):
            pass

    if errors:
        return jsonify({"error": "; ".join(errors)}), 400

    # payment methods: list [{key, account, name, enabled}, ...]
    pm_list = data.get('payment_methods')
    if isinstance(pm_list, list):
        allowed_keys = {m["key"] for m in _PAYMENT_METHODS}
        for pm in pm_list:
            k = pm.get("key", "")
            if k not in allowed_keys:
                continue
            account = str(pm.get("account", "")).strip()
            name    = str(pm.get("name", "")).strip()
            enabled = "1" if pm.get("enabled") else "0"
            for sub_key, val in [(f"pay_{k}_account", account),
                                 (f"pay_{k}_name",    name),
                                 (f"pay_{k}_enabled", enabled)]:
                s = Setting.query.get(sub_key)
                if s:
                    s.value = val
                else:
                    db.session.add(Setting(key=sub_key, value=val))

    db.session.commit()
    from game_engine import get_card_select_time, get_house_fee
    prizes = _get_lb_prizes()
    return jsonify({
        "success":                    True,
        "card_select_time":           get_card_select_time(),
        "house_fee_pct":              round(get_house_fee() * 100),
        "referral_bonus":             _get_referral_bonus(),
        "bonus_expiry_days":          _get_bonus_expiry_days(),
        "withdraw_min":               _get_withdraw_min(),
        "withdraw_max":               _get_withdraw_max(),
        "payment_methods":            _get_payment_methods_config(),
        "lb_prize_1":                 prizes[1],
        "lb_prize_2":                 prizes[2],
        "lb_prize_3":                 prizes[3],
        "lb_period_daily_enabled":    _get_lb_period_enabled('daily'),
        "lb_period_weekly_enabled":   _get_lb_period_enabled('weekly'),
        "lb_period_monthly_enabled":  _get_lb_period_enabled('monthly'),
        "lb_period_all_enabled":      _get_lb_period_enabled('all'),
        "lb_prize_daily_enabled":     _get_lb_prize_enabled('daily'),
        "lb_prize_weekly_enabled":    _get_lb_prize_enabled('weekly'),
        "lb_prize_monthly_enabled":   _get_lb_prize_enabled('monthly'),
    })


@app.route("/api/leaderboard/config")
@login_required
def leaderboard_config():
    """Public endpoint: returns which leaderboard period tabs are enabled."""
    return jsonify({
        "daily":   _get_lb_period_enabled('daily'),
        "weekly":  _get_lb_period_enabled('weekly'),
        "monthly": _get_lb_period_enabled('monthly'),
        "all":     _get_lb_period_enabled('all'),
    })


@app.route("/api/admin/verify-password", methods=["POST"])
def verify_admin_password():
    from models import Setting
    data = request.get_json() or {}
    stored = Setting.query.get('admin_password')
    correct = stored.value if stored else 'fidel123'
    ok = data.get('password', '') == correct
    return jsonify({"valid": ok})


@app.route("/api/admin/change-password", methods=["POST"])
def change_admin_password():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    from models import Setting
    data = request.get_json() or {}
    current_pass = data.get('current_password', '')
    new_pass     = data.get('new_password', '').strip()

    stored = Setting.query.get('admin_password')
    correct = stored.value if stored else 'fidel123'

    if current_pass != correct:
        return jsonify({"error": "Current password is incorrect."}), 400
    if len(new_pass) < 6:
        return jsonify({"error": "New password must be at least 6 characters."}), 400

    if stored:
        stored.value = new_pass
    else:
        db.session.add(Setting(key='admin_password', value=new_pass))
    db.session.commit()
    return jsonify({"success": True})


@app.route("/api/room-set-playing/<int:stake>", methods=["POST"])
def room_set_playing(stake):
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    from game_engine import set_room_playing, STAKES
    if stake not in STAKES:
        return jsonify({"error": "Invalid room"}), 400
    set_room_playing(stake)
    return jsonify({"success": True})


@app.route("/api/room-set-waiting/<int:stake>", methods=["POST"])
def room_set_waiting(stake):
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    from game_engine import set_room_waiting, STAKES
    if stake not in STAKES:
        return jsonify({"error": "Invalid room"}), 400
    set_room_waiting(stake)
    return jsonify({"success": True})


@app.route("/api/admin/reset-game/<int:stake>", methods=["POST"])
def admin_reset_game(stake):
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    from game_engine import reset_room_game, STAKES
    if stake not in STAKES:
        return jsonify({"error": "Invalid room"}), 400
    refunded_count, refunded_total = reset_room_game(stake)
    msg = (
        f"✅ {stake} ETB ጨዋታ ክሊር ተደረገ። "
        f"{refunded_count} ካርድ ({refunded_total:.2f} ETB) ለተጫዋቾቹ ተመልሷል።"
        if refunded_count > 0
        else f"✅ {stake} ETB ጨዋታ ክሊር ተደረገ። (ምንም ካርድ አልተሸጠም ነበር)"
    )
    return jsonify({"success": True, "message": msg,
                    "refunded_count": refunded_count,
                    "refunded_total": refunded_total})


@app.route("/api/user/stats")
@login_required
def user_stats():
    uid = current_user.id
    cards_purchased = Transaction.query.filter_by(user_id=uid).count()
    # Distinct sessions the user played in
    from sqlalchemy import distinct
    games_played = db.session.query(
        db.func.count(distinct(Transaction.session_id))
    ).filter(Transaction.user_id == uid).scalar() or 0
    # Sessions won
    won_sessions = GameSession.query.filter_by(winner_id=uid).all()
    wins = len(won_sessions)
    total_won = 0.0
    for gs in won_sessions:
        room = Room.query.get(gs.room_id)
        if room:
            tx_count = Transaction.query.filter_by(session_id=gs.id).count()
            total_won += tx_count * room.card_price * 0.9
    total_spent = db.session.query(
        db.func.coalesce(db.func.sum(Transaction.amount), 0)
    ).filter(Transaction.user_id == uid).scalar() or 0.0
    return jsonify({
        'games_played': games_played,
        'cards_purchased': cards_purchased,
        'wins': wins,
        'total_won': round(float(total_won), 2),
        'total_spent': round(float(total_spent), 2),
    })


@app.route("/api/leaderboard")
@login_required
def leaderboard():
    from sqlalchemy import func, distinct
    from game_engine import get_house_fee
    from datetime import datetime, timedelta

    period = request.args.get('period', 'all')   # daily | weekly | monthly | all
    sort   = request.args.get('sort',   'prize')  # prize | wins | winrate | played

    fee = get_house_fee()
    now = datetime.utcnow()

    if period == 'daily':
        since = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == 'weekly':
        since = now - timedelta(days=7)
    elif period == 'monthly':
        since = now - timedelta(days=30)
    else:
        since = None

    # Completed session IDs in period
    sess_q = db.session.query(GameSession.id).filter(GameSession.status == 'completed')
    if since:
        sess_q = sess_q.filter(GameSession.created_at >= since)
    completed_sub = sess_q.scalar_subquery()

    # All participants (distinct sessions & total cards) within period
    participation = (
        db.session.query(
            Transaction.user_id,
            func.count(distinct(Transaction.session_id)).label('rounds_played'),
            func.count(Transaction.id).label('cards_bought'),
        )
        .filter(Transaction.session_id.in_(completed_sub))
        .group_by(Transaction.user_id)
        .all()
    )
    part_map = {
        r.user_id: {'rounds_played': r.rounds_played, 'cards_bought': r.cards_bought}
        for r in participation
    }

    # Winning sessions in period
    won_q = (GameSession.query
             .filter(GameSession.winner_id.isnot(None))
             .filter(GameSession.status == 'completed'))
    if since:
        won_q = won_q.filter(GameSession.created_at >= since)

    user_stats = {}
    for gs in won_q.all():
        room = Room.query.get(gs.room_id)
        if not room:
            continue
        tx_count = Transaction.query.filter_by(session_id=gs.id).count()
        prize = round(tx_count * float(room.card_price) * (1 - fee), 2)
        uid = gs.winner_id
        if uid not in user_stats:
            u = User.query.get(uid)
            user_stats[uid] = {
                'username': u.username if u else 'Unknown',
                'wins': 0,
                'total_prize': 0.0,
            }
        user_stats[uid]['wins'] += 1
        user_stats[uid]['total_prize'] = round(user_stats[uid]['total_prize'] + prize, 2)

    # Merge all participants (include non-winners for "most played")
    all_uids = set(user_stats.keys()) | set(part_map.keys())
    for uid in all_uids:
        if uid not in user_stats:
            u = User.query.get(uid)
            user_stats[uid] = {
                'username': u.username if u else 'Unknown',
                'wins': 0,
                'total_prize': 0.0,
            }
        p  = part_map.get(uid, {})
        rp = p.get('rounds_played', user_stats[uid]['wins'])
        user_stats[uid]['rounds_played'] = rp
        user_stats[uid]['cards_bought']  = p.get('cards_bought', 0)
        user_stats[uid]['win_rate']      = round(
            (user_stats[uid]['wins'] / rp * 100) if rp > 0 else 0, 1
        )

    if sort == 'wins':
        key_fn = lambda x: (-x['wins'],         -x['total_prize'])
    elif sort == 'winrate':
        key_fn = lambda x: (-x['win_rate'],      -x['wins'])
    elif sort == 'played':
        key_fn = lambda x: (-x['rounds_played'], -x['wins'])
    else:
        key_fn = lambda x: (-x['total_prize'],   -x['wins'])

    leaders = sorted(user_stats.values(), key=key_fn)[:20]

    # Attach leaderboard prize for daily/weekly/monthly when prize is enabled and sort=played
    if sort == 'played' and period in ('daily', 'weekly', 'monthly') and _get_lb_prize_enabled(period):
        prizes = _get_lb_prizes()
        for i, entry in enumerate(leaders):
            rank = i + 1
            entry['lb_prize'] = prizes.get(rank, 0.0) if rank <= 3 else 0.0
    else:
        for entry in leaders:
            entry['lb_prize'] = 0.0

    return jsonify(leaders)


@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for('landing'))


@app.route("/buy-card/<int:room_id>/<int:card_number>", methods=["POST"])
@login_required
def buy_card(room_id, card_number):
    room = Room.query.get_or_404(room_id)
    _maybe_expire_user_bonus(current_user)
    price = room.card_price
    dep   = float(current_user.balance or 0)
    bonus = float(current_user.bonus_balance or 0)
    if dep + bonus < price:
        return jsonify({"success": False, "message": "Insufficient balance"}), 400
    session = get_or_create_session(room_id)
    if Transaction.query.filter_by(room_id=room_id, session_id=session.id, card_number=card_number).first():
        return jsonify({"success": False, "message": "Card taken"}), 400
    if bonus >= price:
        current_user.bonus_balance = round(bonus - price, 2)
    else:
        current_user.bonus_balance = 0.0
        current_user.balance       = round(dep - (price - bonus), 2)
    # Snapshot balance BEFORE streak reward is added
    dep_new   = round(float(current_user.balance), 2)
    bonus_new = round(float(current_user.bonus_balance), 2)
    _check_and_update_streak(current_user)
    db.session.add(Transaction(
        user_id=current_user.id,
        room_id=room.id,
        session_id=session.id,
        amount=room.card_price,
        card_number=card_number
    ))
    db.session.commit()
    return jsonify({"success": True, "new_balance": dep_new + bonus_new,
                    "deposit_balance": dep_new, "bonus_balance": bonus_new,
                    "streak": current_user.current_streak})


# ─── User Deposit / Withdraw Requests ────────────────────────────────────────

@app.route("/api/deposit-request", methods=["POST"])
@login_required
def deposit_request():
    data = request.get_json() or {}
    amount = data.get("amount")
    method = data.get("method")
    code   = data.get("code")
    if not amount or not method or not code:
        return jsonify({"error": "ሁሉንም መረጃ ያስገቡ"}), 400
    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return jsonify({"error": "የተሳሳተ መጠን"}), 400
    if amount < 10:
        return jsonify({"error": "ዝቅተኛ ገደብ 10 ETB ነው"}), 400
    req = DepositRequest(user_id=current_user.id, amount=amount, method=method, transaction_code=code)
    db.session.add(req)
    db.session.commit()
    return jsonify({"message": f"የ{amount:.0f} ETB ዲፖዚት ጥያቄ ተልኳል። አድሚን ያረጋግጣል።"})


@app.route("/api/withdraw-request", methods=["POST"])
@login_required
def withdraw_request():
    data = request.get_json() or {}
    amount  = data.get("amount")
    method  = data.get("method")
    account = data.get("account")
    if not amount or not method or not account:
        return jsonify({"error": "ሁሉንም መረጃ ያስገቡ"}), 400
    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return jsonify({"error": "የተሳሳተ መጠን"}), 400
    w_min = _get_withdraw_min()
    w_max = _get_withdraw_max()
    if amount < w_min:
        return jsonify({"error": f"ዝቅተኛ ማስወጣት {w_min:.0f} ETB ነው"}), 400
    if amount > w_max:
        return jsonify({"error": f"ከፍተኛ ማስወጣት {w_max:.0f} ETB ነው"}), 400
    db.session.refresh(current_user)
    withdrawable = float(current_user.withdrawable_balance or 0)
    if withdrawable < amount:
        return jsonify({"error": f"ሊወጣ የሚችል ባላንስዎ {withdrawable:.2f} ETB ብቻ ነው። ዲፖዚት ባላንስ ሊወጣ አይችልም — ለጨዋታ ብቻ ነው።"}), 400
    pending = WithdrawRequest.query.filter_by(user_id=current_user.id, status='pending').first()
    if pending:
        return jsonify({"error": f"ቀደም ያስቀመጡት {pending.amount:.0f} ETB ጥያቄ አሁንም pending ነው።"}), 400
    current_user.withdrawable_balance = round(withdrawable - amount, 2)
    req = WithdrawRequest(user_id=current_user.id, amount=amount, method=method, account_details=account)
    db.session.add(req)
    db.session.commit()

    # Notify all admins on Telegram with full player stats
    try:
        admin_msg = _build_player_withdraw_stats(current_user, amount, method, account)
        _notify_admins_telegram(admin_msg)
    except Exception as _e:
        import logging
        logging.warning(f"Admin withdraw notification failed: {_e}")

    return jsonify({"success": True, "message": f"የ{amount:.0f} ETB ጥያቄ ተልኳል። አድሚን ያረጋግጣል።"})


@app.route("/api/user/balance-history")
@login_required
def balance_history():
    txs = Transaction.query.filter_by(user_id=current_user.id)\
              .order_by(Transaction.timestamp.desc()).limit(50).all()
    deps = DepositRequest.query.filter_by(user_id=current_user.id)\
               .order_by(DepositRequest.created_at.desc()).limit(20).all()
    wds  = WithdrawRequest.query.filter_by(user_id=current_user.id)\
               .order_by(WithdrawRequest.created_at.desc()).limit(20).all()
    rows = []
    for t in txs:
        rows.append({"type": "GAME", "description": f"Card #{t.card_number}",
                     "amount": -t.amount, "created_at": str(t.timestamp)})
    for d in deps:
        rows.append({"type": "DEPOSIT", "description": f"{d.method} — {d.status}",
                     "amount": d.amount, "created_at": str(d.created_at)})
    for w in wds:
        rows.append({"type": "WITHDRAW", "description": f"{w.method} — {w.status}",
                     "amount": -w.amount, "created_at": str(w.created_at)})
    rows.sort(key=lambda r: r["created_at"], reverse=True)
    return jsonify(rows[:60])


# ─── Admin Deposit / Withdraw Management ─────────────────────────────────────

@app.route("/api/admin/deposits")
def admin_deposits():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    reqs = DepositRequest.query.filter_by(status='pending')\
               .order_by(DepositRequest.created_at.desc()).all()
    return jsonify([{
        "id": r.id,
        "name": r.user.username,
        "phone_number": r.user.telegram_chat_id or "—",
        "amount": r.amount,
        "method": r.method,
        "transaction_code": r.transaction_code,
        "created_at": str(r.created_at),
    } for r in reqs])


@app.route("/api/admin/approve-deposit", methods=["POST"])
def admin_approve_deposit():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json() or {}
    req  = DepositRequest.query.get(data.get("depositId"))
    if not req or req.status != 'pending':
        return jsonify({"error": "ጥያቄ አልተገኘም ወይም ቀድሞ ታይቷል"}), 404
    req.status = 'approved'
    user = User.query.get(req.user_id)
    if user:
        user.balance = round(float(user.balance or 0) + req.amount, 2)
        _apply_first_deposit_referral_bonus(user)
    db.session.commit()
    _notify_user_telegram(user,
        f"✅ *ዲፖዚት ጸደቀ / Deposit Approved*\n\n"
        f"💵 መጠን: *{req.amount:.2f} ETB*\n"
        f"📲 ዘዴ: {req.method}\n\n"
        f"ባላንስዎ ታክሏል። መጫወት ይጀምሩ! 🎮"
    )
    return jsonify({"message": f"✅ {req.amount:.0f} ETB approved for {user.username if user else '?'}"})


@app.route("/api/admin/reject-deposit", methods=["POST"])
def admin_reject_deposit():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json() or {}
    req  = DepositRequest.query.get(data.get("depositId"))
    if not req or req.status != 'pending':
        return jsonify({"error": "ጥያቄ አልተገኘም"}), 404
    req.status = 'rejected'
    user = User.query.get(req.user_id)
    db.session.commit()
    _notify_user_telegram(user,
        f"❌ *ዲፖዚት ተቀባይነት አላገኘም / Deposit Rejected*\n\n"
        f"💵 መጠን: *{req.amount:.2f} ETB*\n"
        f"ዝርዝሩን ያረጋግጡ ወይም አድሚን ያግኙ።"
    )
    return jsonify({"message": f"❌ Deposit rejected for {user.username if user else '?'}"})


@app.route("/api/admin/withdrawals")
def admin_withdrawals():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    reqs = WithdrawRequest.query.filter_by(status='pending')\
               .order_by(WithdrawRequest.created_at.desc()).all()
    return jsonify([{
        "id": r.id,
        "name": r.user.username,
        "phone_number": r.user.telegram_chat_id or "—",
        "amount": r.amount,
        "method": r.method,
        "account_details": r.account_details,
        "created_at": str(r.created_at),
    } for r in reqs])


def _notify_user_telegram(user, message):
    """Send a Telegram message to a single user if they have a chat_id and bot is available."""
    try:
        if not bot or not user or not user.telegram_chat_id:
            return
        bot.send_message(user.telegram_chat_id, message, parse_mode='Markdown')
    except Exception as e:
        import logging
        logging.warning(f"Telegram notify user failed for {getattr(user,'username','?')}: {e}")


def _notify_admins_telegram(message):
    """Send a Telegram message to every admin who has a linked telegram_chat_id."""
    if not bot:
        return
    admins = User.query.filter_by(is_admin=True).all()
    for admin in admins:
        if admin.telegram_chat_id:
            try:
                bot.send_message(admin.telegram_chat_id, message, parse_mode='Markdown')
            except Exception as e:
                import logging
                logging.warning(f"Telegram notify admin failed for {admin.username}: {e}")


def _build_player_withdraw_stats(user, amount, method, account):
    """Build a detailed Telegram message for admins when a player requests a withdrawal."""
    from game_engine import get_house_fee
    from sqlalchemy import func

    # Total approved deposits
    total_deposits = db.session.query(
        func.coalesce(func.sum(DepositRequest.amount), 0)
    ).filter_by(user_id=user.id, status='approved').scalar() or 0

    # Games won + total prize earned
    won_sessions = (GameSession.query
                    .filter_by(winner_id=user.id, status='completed')
                    .all())
    games_won = len(won_sessions)
    fee = get_house_fee()
    total_prize_earned = 0.0
    for gs in won_sessions:
        room = Room.query.get(gs.room_id)
        if room:
            tx_count = Transaction.query.filter_by(session_id=gs.id).count()
            total_prize_earned += tx_count * float(room.card_price) * (1 - fee)
    total_prize_earned = round(total_prize_earned, 2)

    # Total games played (sessions where user bought a card)
    games_played = db.session.query(
        func.count(func.distinct(Transaction.session_id))
    ).filter_by(user_id=user.id).scalar() or 0

    # Total cards bought
    cards_bought = Transaction.query.filter_by(user_id=user.id).count()

    # Previous withdrawals (approved)
    prev_withdrawals = db.session.query(
        func.coalesce(func.sum(WithdrawRequest.amount), 0)
    ).filter_by(user_id=user.id, status='approved').scalar() or 0

    dep_bal        = round(float(user.balance or 0), 2)
    withdrawable   = round(float(user.withdrawable_balance or 0), 2)
    bonus_bal      = round(float(user.bonus_balance or 0), 2)

    msg = (
        f"🏧 *ዊዝድሮው ጥያቄ / Withdrawal Request*\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"👤 ተጫዋች: *{user.username}*\n"
        f"💸 መጠን: *{amount:.2f} ETB*\n"
        f"📲 ዘዴ: {method}\n"
        f"🔢 Account: `{account}`\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"📊 *የተጫዋቹ ሙሉ ታሪክ*\n"
        f"💵 ጠቅላላ ዲፖዚት (approved): *{total_deposits:.2f} ETB*\n"
        f"🎮 ጨዋታ የተጫወተ: *{games_played}* ዙር | ካርድ: *{cards_bought}*\n"
        f"🏆 ያሸነፈ ዙር: *{games_won}*\n"
        f"🎁 ከጨዋታ ሽልማት ያገኘ: *{total_prize_earned:.2f} ETB*\n"
        f"🏧 ቀደም ያወጣ (approved): *{prev_withdrawals:.2f} ETB*\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"💰 *አሁን ያለ ባላንስ*\n"
        f"   ዲፖዚት: {dep_bal:.2f} ETB\n"
        f"   ሊወጣ ይችላል: {withdrawable:.2f} ETB\n"
        f"   ቦነስ: {bonus_bal:.2f} ETB"
    )
    return msg


@app.route("/api/user/my-withdrawals")
@login_required
def user_my_withdrawals():
    wds = WithdrawRequest.query.filter_by(user_id=current_user.id)\
              .order_by(WithdrawRequest.created_at.desc()).limit(15).all()
    return jsonify([{
        "id":             w.id,
        "amount":         w.amount,
        "method":         w.method,
        "account_details": w.account_details,
        "status":         w.status,
        "created_at":     w.created_at.strftime("%Y-%m-%d %H:%M") if w.created_at else "—",
    } for w in wds])


@app.route("/api/admin/handle-withdraw", methods=["POST"])
def admin_handle_withdraw():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    data   = request.get_json() or {}
    req    = WithdrawRequest.query.get(data.get("withdrawId"))
    action = data.get("action", "")
    if not req or req.status != 'pending':
        return jsonify({"error": "ጥያቄ አልተገኘም"}), 404
    user = User.query.get(req.user_id)
    if action == "approve":
        req.status = 'approved'
        db.session.commit()
        _notify_user_telegram(user,
            f"✅ *ጥያቄ ጸደቀ / Withdrawal Approved*\n\n"
            f"💸 መጠን: *{req.amount:.2f} ETB*\n"
            f"📲 ዘዴ: {req.method}\n"
            f"🔢 Account: `{req.account_details}`\n\n"
            f"ክፍያዎ ተልኳል። ያረጋግጡ!"
        )
        return jsonify({"message": f"✅ {req.amount:.0f} ETB approved — {user.username if user else '?'}"})
    elif action == "reject":
        req.status = 'rejected'
        if user:
            user.withdrawable_balance = round(float(user.withdrawable_balance or 0) + req.amount, 2)
        db.session.commit()
        _notify_user_telegram(user,
            f"❌ *ጥያቄ ተቀባይነት አላገኘም / Withdrawal Rejected*\n\n"
            f"💸 መጠን: *{req.amount:.2f} ETB*\n"
            f"ሊወጣ የሚችል ባላንስዎ ተመልሷል። ለዝርዝር አድሚን ያግኙ።"
        )
        return jsonify({"message": f"❌ Rejected — {req.amount:.0f} ETB refunded to {user.username if user else '?'}"})
    return jsonify({"error": "action required (approve/reject)"}), 400


@app.route("/api/admin/promote-user", methods=["POST"])
def admin_promote_user():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json() or {}
    username    = data.get("username") or data.get("targetPhone")
    user_id_val = data.get("user_id")
    user = None
    if user_id_val:
        user = User.query.get(int(user_id_val))
    elif username:
        user = User.query.filter(
            (User.username == username) | (User.telegram_chat_id == username)
        ).first()
    if not user:
        return jsonify({"error": "ተጠቃሚ አልተገኘም"}), 404
    user.is_admin = True
    db.session.commit()
    return jsonify({"message": f"{user.username} አድሚን ሆኗል"})


@app.route("/api/admin/send-daily-report", methods=["POST"])
def admin_send_daily_report():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    from game_engine import _send_daily_revenue_report
    import threading
    t = threading.Thread(target=lambda: _send_daily_revenue_report(manual=True), daemon=True)
    t.start()
    return jsonify({"success": True, "message": "📊 Daily report is being sent to admins via Telegram."})


@app.route("/api/admin/streak-broadcast", methods=["GET", "POST"])
def admin_streak_broadcast():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    if request.method == "GET":
        try:
            milestone = int(request.args.get("milestone", 7))
        except ValueError:
            milestone = 7
        count = User.query.filter(
            User.current_streak >= milestone,
            User.telegram_chat_id.isnot(None)
        ).count()
        saved_key = f"streak_msg_{milestone}"
        saved = Setting.query.get(saved_key)
        return jsonify({
            "user_count": count,
            "saved_message": saved.value if saved else "",
        })
    data      = request.get_json() or {}
    try:
        milestone = int(data.get("milestone", 7))
    except ValueError:
        milestone = 7
    template  = data.get("message", "").strip()
    if not template:
        template = (
            "🔥 *{streak} ቀን Streak!* ሰላም {username}!\n\n"
            "ለ{streak} ቀን ተከታታይ ጨዋታ በጣም አደንቃለሁ! 🏆\n"
            "ቦነስ ቀጥሎ ወደ *{bonus} ETB* ይደርሳል — ጨዋታ አቁሙ !"
        )
    saved_key = f"streak_msg_{milestone}"
    s = Setting.query.get(saved_key)
    if not s:
        s = Setting(key=saved_key, value=template)
        db.session.add(s)
    else:
        s.value = template
    db.session.commit()
    users = User.query.filter(
        User.current_streak >= milestone,
        User.telegram_chat_id.isnot(None)
    ).all()
    sent = 0
    for u in users:
        try:
            bonus = _get_streak_reward(int(u.current_streak or 0) + 1)
            msg = template.replace("{username}", u.username or "ጨዋታ") \
                          .replace("{streak}", str(u.current_streak or 0)) \
                          .replace("{bonus}", str(bonus))
            bot.send_message(u.telegram_chat_id, msg, parse_mode="Markdown")
            sent += 1
        except Exception:
            pass
    return jsonify({
        "success": True,
        "message": f"🔥 Streak broadcast sent to {sent} user{'' if sent==1 else 's'} (streak ≥ {milestone})",
    })


@app.route("/api/admin/broadcast", methods=["POST"])
def admin_broadcast():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    data    = request.get_json() or {}
    message = data.get("message", "").strip()
    if not message:
        return jsonify({"error": "መልዕክት ያስገቡ"}), 400
    sent = 0
    if BOT_TOKEN:
        users = User.query.filter(User.telegram_chat_id.isnot(None)).all()
        for u in users:
            try:
                bot.send_message(u.telegram_chat_id, message)
                sent += 1
            except Exception:
                pass
    return jsonify({"success": True, "message": f"📢 Telegram broadcast sent to {sent} user{'' if sent==1 else 's'}"})


@app.route("/api/admin/in-game-alert", methods=["POST"])
def admin_in_game_alert():
    """Push a timed in-game notification to all polling players."""
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    data     = request.get_json() or {}
    message  = data.get("message", "").strip()
    icon     = data.get("icon", "📢").strip() or "📢"
    duration = int(data.get("duration", 30))
    if not message:
        return jsonify({"error": "መልዕክት ያስገቡ"}), 400
    duration = max(5, min(duration, 120))
    from game_engine import set_broadcast_alert
    set_broadcast_alert(message, icon, duration)
    return jsonify({"success": True, "message": f"✅ In-game alert sent — visible for {duration}s"})


# ─── Card Purchase (by stake) ─────────────────────────────────────────────────

@app.route("/api/debug/session", methods=["GET", "POST"])
def debug_session():
    """Debug endpoint: returns full session/auth/cookie/request info."""
    import traceback as _tb
    try:
        from flask import session as flask_session
        info = {
            "method":           request.method,
            "is_authenticated": current_user.is_authenticated,
            "user_id":          current_user.get_id() if current_user.is_authenticated else None,
            "username":         getattr(current_user, 'username', None),
            "session_keys":     list(flask_session.keys()),
            "cookies_received": list(request.cookies.keys()),
            "content_type":     request.content_type,
            "headers": {
                "Origin":      request.headers.get("Origin"),
                "Referer":     request.headers.get("Referer"),
                "User-Agent":  request.headers.get("User-Agent"),
                "X-Forwarded-Proto": request.headers.get("X-Forwarded-Proto"),
            },
            "scheme":           request.scheme,
            "host":             request.host,
        }
        return jsonify({"ok": True, "debug": info})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "trace": _tb.format_exc()})


@app.route("/api/debug/room", methods=["GET"])
def debug_room():
    """Deep diagnostic: in-memory room state + live DB counts + thread status."""
    import traceback as _tb
    import threading as _threading
    from game_engine import (room_states, STAKES, _timer_threads,
                              _count_session_players, _cached_card_count,
                              get_card_select_time, get_house_fee,
                              _card_count_cache, _settings_cache)
    result = {}
    for stake in STAKES:
        # Live DB count (bypass cache)
        try:
            live_db_count = _count_session_players(stake)
            db_error = None
        except Exception as ex:
            live_db_count = -1
            db_error = str(ex)

        # Cached count
        cached = _card_count_cache.get(stake)

        # Thread status
        t = _timer_threads.get(stake)
        thread_alive = t.is_alive() if t else False
        thread_name  = t.name if t else None

        # DB room info
        try:
            room = Room.query.filter_by(card_price=float(stake)).first()
            db_room = {
                "id":                room.id if room else None,
                "active_session_id": room.active_session_id if room else None,
            } if room else None
            if room and room.active_session_id:
                tx_count = Transaction.query.filter_by(
                    room_id=room.id, session_id=room.active_session_id
                ).count()
            else:
                tx_count = 0
        except Exception as ex:
            db_room  = None
            tx_count = -1
            db_error = (db_error or "") + " | room_query: " + str(ex)

        state = room_states.get(stake, {})
        result[str(stake)] = {
            "memory_status":    state.get("status"),
            "memory_timer":     state.get("launch_timer"),
            "memory_balls":     len(state.get("balls", [])),
            "thread_alive":     thread_alive,
            "thread_name":      thread_name,
            "live_db_count":    live_db_count,
            "cached_count":     cached["count"] if cached else None,
            "cache_age_s":      round(__import__("time").time() - cached["ts"], 2) if cached else None,
            "db_room":          db_room,
            "db_tx_count":      tx_count,
            "card_select_time": get_card_select_time(),
            "db_error":         db_error,
        }

    return jsonify({
        "ok":    True,
        "rooms": result,
        "settings_cache": {k: v["val"] for k, v in _settings_cache.items()},
    })


@app.route("/api/game-state/<int:stake>")
def api_game_state(stake):
    from game_engine import get_room_game_state, STAKES, get_broadcast_alert
    if stake not in STAKES:
        return jsonify({"error": "Room not found"}), 404
    state = get_room_game_state(stake)
    state['broadcast_alert'] = get_broadcast_alert()
    return jsonify(state)


@app.route("/api/bingo-claim/<int:stake>", methods=["POST"])
@login_required
def api_bingo_claim(stake):
    from game_engine import room_states, STAKES
    if stake not in STAKES:
        return jsonify({"error": "Room not found"}), 404
    state = room_states.get(stake, {})
    winners = state.get('winners', [])
    if winners:
        return jsonify({
            "valid": True,
            "winners": winners,
            "winner": winners[0]['username'],
            "winner_card": winners[0]['card_number'],
            "winner_card_data": winners[0]['card_data'],
            "balls": list(state.get('balls', [])),
            "prize": winners[0]['prize'],
        })
    return jsonify({"valid": False, "message": "ዳቢ ሊጠናቀቅ ጥቂት ይጠብቁ..."})


@app.route("/api/buy-card-by-stake/<int:stake>/<int:card_number>", methods=["POST"])
@login_required
def buy_card_by_stake(stake, card_number):
    """Buy a card by stake amount. JS uses this instead of WebSocket."""
    import traceback as _tb
    try:
        room = Room.query.filter_by(card_price=float(stake)).first()
        if not room:
            return jsonify({"success": False, "message": "Room not found", "detail": f"No room with card_price={stake}"}), 404

        # Block purchases while a game is actively running — all players must
        # buy before the round starts so everyone is in the same session.
        from game_engine import room_states, STAKES as _STAKES
        if stake in _STAKES and room_states.get(stake, {}).get('status') == 'playing':
            return jsonify({
                "success": False,
                "message": "ጨዋታ ጀምሯል — ቀጣዩን ዙር ይጠብቁ"
            }), 400

        db.session.refresh(current_user)
        _maybe_expire_user_bonus(current_user)
        price = room.card_price
        dep   = float(current_user.balance or 0)
        bonus = float(current_user.bonus_balance or 0)
        if dep + bonus < price:
            return jsonify({
                "success": False,
                "message": f"ባላንስ አነስተኛ ነው። ያሎት: {dep + bonus:.2f} ETB"
            }), 400

        # Prevent the same player from buying more than two cards per session
        existing_txs = []
        if room.active_session_id:
            existing_txs = Transaction.query.filter_by(
                room_id=room.id,
                session_id=room.active_session_id,
                user_id=current_user.id
            ).all()
        if len(existing_txs) >= 2:
            nums = ', '.join(f'#{t.card_number}' for t in existing_txs)
            return jsonify({
                "success": False,
                "message": f"ካርዶች {nums} ተይዘዋል — በአንድ ዙር ከ2 ካርድ በላይ አይቻልም"
            }), 400

        game_session = get_or_create_session(room.id)
        if not game_session:
            return jsonify({"success": False, "message": "Session error", "detail": "get_or_create_session returned None"}), 500
        if Transaction.query.filter_by(
            room_id=room.id, session_id=game_session.id, card_number=card_number
        ).first():
            return jsonify({"success": False, "message": "ይህ ካርድ ተወስዷል"}), 400
        # Deduct bonus_balance first, then deposit balance
        if bonus >= price:
            current_user.bonus_balance = round(bonus - price, 2)
        else:
            current_user.bonus_balance = 0.0
            current_user.balance       = round(dep - (price - bonus), 2)
        # Snapshot balance BEFORE streak reward is added
        dep_new   = round(float(current_user.balance), 2)
        bonus_new = round(float(current_user.bonus_balance), 2)
        _check_and_update_streak(current_user)
        db.session.add(Transaction(
            user_id=current_user.id,
            room_id=room.id,
            session_id=game_session.id,
            amount=room.card_price,
            card_number=card_number
        ))
        db.session.commit()
        # Invalidate the in-memory card-count cache so next poll sees fresh count
        from game_engine import _invalidate_card_count
        _invalidate_card_count(stake)
        return jsonify({"success": True, "new_balance": dep_new + bonus_new,
                        "deposit_balance": dep_new, "bonus_balance": bonus_new,
                        "streak": current_user.current_streak})
    except Exception as e:
        db.session.rollback()
        import logging as _log
        _log.error(f"buy_card_by_stake ERROR stake={stake} card={card_number}: {e}\n{_tb.format_exc()}")
        return jsonify({
            "success": False,
            "message": f"Server error: {str(e)}",
            "detail":  _tb.format_exc()
        }), 500


