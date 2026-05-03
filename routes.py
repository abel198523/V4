import os
import traceback
import telebot
import random
from flask import render_template, request, jsonify, redirect, url_for
from app import app, db
from models import User, Room, Transaction, GameSession, OTPStore, DepositRequest, WithdrawRequest
from flask_login import login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from bot import bot, BOT_TOKEN


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
            db.session.add(Room(name=f"Room {s} ETB", card_price=float(s)))
    try:
        db.session.commit()
        rooms = Room.query.all()
    except Exception:
        db.session.rollback()
    if not rooms:
        rooms = []

    response = render_template("index.html", rooms=rooms, balance=current_user.balance)
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
    room = Room.query.get(room_id)
    if not room:
        return None
    session = None
    if room.active_session_id:
        session = GameSession.query.get(room.active_session_id)
        if session and session.status != 'active':
            session = None
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
    if request.method == "POST":
        return api_login()
    return render_template("login.html")


def _apply_referral_bonus(new_user, ref_code):
    """Credit signup bonus to new user and referral bonus to referrer."""
    if not ref_code:
        return
    referrer = User.query.filter_by(referral_code=ref_code).first()
    if not referrer or referrer.id == new_user.id:
        return
    bonus = _get_referral_bonus()
    if bonus <= 0:
        return
    new_user.referred_by  = ref_code
    new_user.balance       = round(float(new_user.balance or 0) + bonus, 2)
    referrer.balance       = round(float(referrer.balance or 0) + bonus, 2)


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
                               username=username, ref_code=form_ref)

    return render_template("signup.html", ref_code=ref_code)


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
    db.session.refresh(current_user)
    return jsonify({"balance": current_user.balance, "username": current_user.username})


@app.route("/api/room-status")
def room_status():
    from game_engine import get_all_room_status
    return jsonify(get_all_room_status())


@app.route("/api/game-state/<int:stake>")
@login_required
def game_state(stake):
    from game_engine import get_room_game_state, STAKES
    if stake not in STAKES:
        return jsonify({"error": "Invalid room"}), 400
    state = get_room_game_state(stake)
    return jsonify(state)


@app.route("/api/bingo-claim/<int:stake>", methods=["POST"])
@login_required
def bingo_claim(stake):
    from game_engine import get_room_game_state, STAKES
    from card_data import get_card_data, check_bingo
    if stake not in STAKES:
        return jsonify({"valid": False, "message": "Invalid room"}), 400
    state = get_room_game_state(stake)
    if state['status'] != 'playing':
        return jsonify({"valid": False, "message": "ጨዋታ አልጀመረም"})
    data = request.json or {}
    card_number = data.get('card_number')
    if not card_number:
        return jsonify({"valid": False, "message": "ካርድ አልተመረጠም"})
    called_set = set(state['balls'])
    card_data = get_card_data(int(card_number))
    if check_bingo(card_data, called_set):
        return jsonify({"valid": True, "message": "🎉 ቢንጎ! አሸንፈዋል!"})
    return jsonify({"valid": False, "message": "ቢንጎ አልሆነም — ቆጠሩ!"})


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
        "id":       user.id,
        "username": user.username,
        "balance":  round(user.balance, 2),
        "is_admin": user.is_admin,
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
            "rounds":  len(today_sessions),
            "cards":   t_cards,
            "income":  t_income,
            "payout":  t_payout,
            "profit":  round(t_income - t_payout, 2),
        },
        "alltime": {
            "rounds":  len(all_sessions),
            "cards":   a_cards,
            "income":  a_income,
            "payout":  a_payout,
            "profit":  round(a_income - a_payout, 2),
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
    referred_users = User.query.filter_by(referred_by=current_user.referral_code).all()
    bonus = _get_referral_bonus()
    return jsonify({
        "referral_code":  current_user.referral_code,
        "referred_count": len(referred_users),
        "bonus_per_ref":  bonus,
        "bonus_earned":   round(len(referred_users) * bonus, 2),
    })


@app.route("/api/admin/settings", methods=["GET"])
def get_admin_settings():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized"}), 403
    from game_engine import get_min_cards, get_launch_countdown, get_house_fee
    return jsonify({
        "min_cards":       get_min_cards(),
        "launch_countdown": get_launch_countdown(),
        "house_fee_pct":   round(get_house_fee() * 100),
        "referral_bonus":  _get_referral_bonus(),
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

    _save('min_cards',        data.get('min_cards'),        1,  50)
    _save('launch_countdown', data.get('launch_countdown'), 5, 120)
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

    if errors:
        return jsonify({"error": "; ".join(errors)}), 400

    db.session.commit()
    from game_engine import get_min_cards, get_launch_countdown, get_house_fee
    return jsonify({
        "success":         True,
        "min_cards":       get_min_cards(),
        "launch_countdown": get_launch_countdown(),
        "house_fee_pct":   round(get_house_fee() * 100),
        "referral_bonus":  _get_referral_bonus(),
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

    fee = get_house_fee()

    # rounds_played per user = distinct completed sessions where they bought a card
    completed_ids = db.session.query(GameSession.id).filter(GameSession.status == 'completed').scalar_subquery()
    participation = (
        db.session.query(
            Transaction.user_id,
            func.count(distinct(Transaction.session_id)).label('rounds_played')
        )
        .filter(Transaction.session_id.in_(completed_ids))
        .group_by(Transaction.user_id)
        .all()
    )
    participation_map = {row.user_id: row.rounds_played for row in participation}

    # total cards bought per user
    cards_query = (
        db.session.query(
            Transaction.user_id,
            func.count(Transaction.id).label('cards_bought')
        )
        .group_by(Transaction.user_id)
        .all()
    )
    cards_map = {row.user_id: row.cards_bought for row in cards_query}

    # wins + prize from completed won sessions
    won_sessions = (GameSession.query
                    .filter(GameSession.winner_id.isnot(None))
                    .filter(GameSession.status == 'completed')
                    .all())
    user_stats = {}
    for gs in won_sessions:
        room = Room.query.get(gs.room_id)
        if not room:
            continue
        tx_count = Transaction.query.filter_by(session_id=gs.id).count()
        prize = round(tx_count * float(room.card_price) * (1 - fee), 2)
        uid = gs.winner_id
        if uid not in user_stats:
            user = User.query.get(uid)
            user_stats[uid] = {
                'username': user.username if user else 'Unknown',
                'wins': 0,
                'total_prize': 0.0,
            }
        user_stats[uid]['wins'] += 1
        user_stats[uid]['total_prize'] = round(user_stats[uid]['total_prize'] + prize, 2)

    # attach rounds_played, cards_bought, win_rate
    for uid, stats in user_stats.items():
        rp = participation_map.get(uid, stats['wins'])
        stats['rounds_played'] = rp
        stats['cards_bought']  = cards_map.get(uid, 0)
        stats['win_rate']      = round((stats['wins'] / rp * 100) if rp > 0 else 0, 1)

    leaders = sorted(user_stats.values(), key=lambda x: x['total_prize'], reverse=True)[:20]
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
    if current_user.balance < room.card_price:
        return jsonify({"success": False, "message": "Insufficient balance"}), 400
    session = get_or_create_session(room_id)
    if Transaction.query.filter_by(room_id=room_id, session_id=session.id, card_number=card_number).first():
        return jsonify({"success": False, "message": "Card taken"}), 400
    current_user.balance -= room.card_price
    db.session.add(Transaction(
        user_id=current_user.id,
        room_id=room.id,
        session_id=session.id,
        amount=room.card_price,
        card_number=card_number
    ))
    db.session.commit()
    return jsonify({"success": True, "new_balance": current_user.balance})


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
    if amount < 50:
        return jsonify({"error": "ዝቅተኛ ማስወጣት 50 ETB ነው"}), 400
    db.session.refresh(current_user)
    if current_user.balance < amount:
        return jsonify({"error": f"ያሎት ባላንስ {current_user.balance:.2f} ETB ብቻ ነው"}), 400
    pending = WithdrawRequest.query.filter_by(user_id=current_user.id, status='pending').first()
    if pending:
        return jsonify({"error": f"ቀደም ያስቀመጡት {pending.amount:.0f} ETB ጥያቄ አሁንም pending ነው።"}), 400
    current_user.balance = round(float(current_user.balance) - amount, 2)
    req = WithdrawRequest(user_id=current_user.id, amount=amount, method=method, account_details=account)
    db.session.add(req)
    db.session.commit()
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
            user.balance = round(float(user.balance or 0) + req.amount, 2)
        db.session.commit()
        _notify_user_telegram(user,
            f"❌ *ጥያቄ ተቀባይነት አላገኘም / Withdrawal Rejected*\n\n"
            f"💸 መጠን: *{req.amount:.2f} ETB*\n"
            f"ባላንስዎ ተመልሷል። ለዝርዝር አድሚን ያግኙ።"
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
    return jsonify({"message": f"መልዕክት ለ {sent} ተጠቃሚዎች ተልኳል"})


# ─── Card Purchase (by stake) ─────────────────────────────────────────────────

@app.route("/api/buy-card-by-stake/<int:stake>/<int:card_number>", methods=["POST"])
@login_required
def buy_card_by_stake(stake, card_number):
    """Buy a card by stake amount (5, 10, or 20 ETB). JS uses this instead of WebSocket."""
    room = Room.query.filter_by(card_price=float(stake)).first()
    if not room:
        return jsonify({"success": False, "message": "Room not found"}), 404
    db.session.refresh(current_user)
    if current_user.balance < room.card_price:
        return jsonify({
            "success": False,
            "message": f"ባላንስ አነስተኛ ነው። ያሎት: {current_user.balance:.2f} ETB"
        }), 400
    game_session = get_or_create_session(room.id)
    if not game_session:
        return jsonify({"success": False, "message": "Session error"}), 500
    if Transaction.query.filter_by(
        room_id=room.id, session_id=game_session.id, card_number=card_number
    ).first():
        return jsonify({"success": False, "message": "ይህ ካርድ ተወስዷል"}), 400
    current_user.balance -= room.card_price
    db.session.add(Transaction(
        user_id=current_user.id,
        room_id=room.id,
        session_id=game_session.id,
        amount=room.card_price,
        card_number=card_number
    ))
    db.session.commit()
    return jsonify({"success": True, "new_balance": current_user.balance})
