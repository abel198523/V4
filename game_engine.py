import threading
import time
import random
import logging

logger = logging.getLogger(__name__)

STAKES = [10, 50, 100, 200]
BALL_INTERVAL = 3
WINNER_DISPLAY_SECONDS = 8
HOUSE_FEE = 0.10
MIN_CARDS = 5        # cards needed before launch countdown begins
LAUNCH_COUNTDOWN = 10  # seconds of warning before game starts after threshold met

_lock = threading.Lock()

# ── In-memory TTL cache for DB settings ──────────────────────────────────────
_settings_cache: dict = {}
_SETTINGS_TTL = 30  # seconds — re-read from DB at most once per 30s

def _cached_setting(key: str, default, cast=int):
    """Return a DB setting value, re-fetching at most every _SETTINGS_TTL seconds."""
    now = time.time()
    entry = _settings_cache.get(key)
    if entry and now - entry['ts'] < _SETTINGS_TTL:
        return entry['val']
    try:
        from app import app
        from models import Setting
        with app.app_context():
            s = Setting.query.get(key)
            val = cast(s.value) if s else default
    except Exception:
        val = default
    _settings_cache[key] = {'val': val, 'ts': now}
    return val

# ── In-memory TTL cache for room card counts ──────────────────────────────────
_card_count_cache: dict = {}   # stake -> {'count': int, 'ts': float}
_CARD_COUNT_TTL = 1.5          # seconds

def _cached_card_count(stake):
    """Return session card count, cached for _CARD_COUNT_TTL seconds."""
    now = time.time()
    entry = _card_count_cache.get(stake)
    if entry and now - entry['ts'] < _CARD_COUNT_TTL:
        return entry['count']
    count = _count_session_players(stake)
    _card_count_cache[stake] = {'count': count, 'ts': now}
    return count

def _invalidate_card_count(stake):
    """Call after a card is purchased to force next poll to re-fetch."""
    _card_count_cache.pop(stake, None)

# status values:
#   'waiting'   – not enough cards yet, showing fill progress
#   'launching' – threshold met, 10-s countdown running
#   'playing'   – balls being called
room_states = {
    s: {
        'status': 'waiting',
        'launch_timer': 0,
        'balls': [],
        'winner': None,
        'winner_card': None,
        'prize': 0.0,
    }
    for s in STAKES
}

_timer_threads = {}
_stopped_stakes = set()  # stakes whose loops should exit

# ─── In-game broadcast alert ─────────────────────────────────────────────────
_broadcast_alert = {
    'message':    '',
    'icon':       '📢',
    'expires_at': 0.0,   # unix timestamp; 0 = no active alert
}


def set_broadcast_alert(message: str, icon: str = '📢', duration_sec: int = 30):
    """Set a global in-game alert visible to all polling clients."""
    with _lock:
        _broadcast_alert['message']    = message
        _broadcast_alert['icon']       = icon or '📢'
        _broadcast_alert['expires_at'] = time.time() + duration_sec


def get_broadcast_alert():
    """Return active alert dict, or None if expired / not set."""
    with _lock:
        if _broadcast_alert['message'] and time.time() < _broadcast_alert['expires_at']:
            return {
                'message':    _broadcast_alert['message'],
                'icon':       _broadcast_alert['icon'],
                'expires_at': _broadcast_alert['expires_at'],
                'ttl':        max(0, int(_broadcast_alert['expires_at'] - time.time())),
            }
    return None


def get_min_cards():
    return _cached_setting('min_cards', MIN_CARDS, cast=int)

def get_launch_countdown():
    return _cached_setting('launch_countdown', LAUNCH_COUNTDOWN, cast=int)

def get_house_fee():
    raw = _cached_setting('house_fee_pct', int(HOUSE_FEE * 100), cast=int)
    return round(raw / 100.0, 4)


def _count_session_players(stake):
    try:
        from app import app, db
        from models import Transaction, Room
        with app.app_context():
            room = Room.query.filter_by(card_price=float(stake)).first()
            if not room or not room.active_session_id:
                return 0
            return Transaction.query.filter_by(
                room_id=room.id,
                session_id=room.active_session_id
            ).count()
    except Exception as e:
        logger.error(f"count_session_players error for room {stake}: {e}")
        return 0


def _find_and_award_winner(stake, called_set):
    try:
        from app import app, db
        from models import Transaction, Room, User, GameSession
        from card_data import get_card_data, check_bingo

        with app.app_context():
            room = Room.query.filter_by(card_price=float(stake)).first()
            if not room or not room.active_session_id:
                return None

            session_id = room.active_session_id
            transactions = Transaction.query.filter_by(
                room_id=room.id,
                session_id=session_id
            ).all()

            if not transactions:
                return None

            prize = len(transactions) * float(stake) * (1 - get_house_fee())

            for tx in transactions:
                card_data = get_card_data(tx.card_number)
                if check_bingo(card_data, called_set):
                    user = User.query.get(tx.user_id)
                    if user:
                        user.balance += prize
                        session = GameSession.query.get(session_id)
                        if session:
                            session.status = 'completed'
                            session.winner_id = user.id
                        room.active_session_id = None
                        db.session.commit()
                        cards_count = len(transactions)
                        logger.info(
                            f"Room {stake} ETB: WINNER={user.username} "
                            f"card=#{tx.card_number} prize={prize:.2f} ETB"
                        )
                        _notify_admins_game_result(
                            stake=stake,
                            cards=cards_count,
                            winner=user.username,
                            prize=round(prize, 2),
                        )
                        return (user.username, tx.card_number, round(prize, 2))
    except Exception as e:
        logger.error(f"Winner check error for room {stake}: {e}")
    return None


def _complete_session_no_winner(stake):
    """Mark current session as completed (no winner) and clear active_session_id."""
    try:
        from app import app, db
        from models import Room, GameSession, Transaction
        with app.app_context():
            room = Room.query.filter_by(card_price=float(stake)).first()
            if room and room.active_session_id:
                tx_count = Transaction.query.filter_by(session_id=room.active_session_id).count()
                session = GameSession.query.get(room.active_session_id)
                if session:
                    session.status = 'completed'
                room.active_session_id = None
                db.session.commit()
                _notify_admins_game_result(
                    stake=stake,
                    cards=tx_count,
                    winner=None,
                    prize=0.0,
                )
    except Exception as e:
        logger.error(f"_complete_session_no_winner error for room {stake}: {e}")


def _notify_admins_game_result(stake, cards, winner, prize):
    """Send a Telegram message to all admin users with telegram_chat_id."""
    try:
        from app import app
        from models import User
        from bot import bot
        if not bot:
            return
        with app.app_context():
            admins = User.query.filter_by(is_admin=True).all()
            admin_chat_ids = [
                a.telegram_chat_id for a in admins if a.telegram_chat_id
            ]
        if not admin_chat_ids:
            return

        if winner:
            msg = (
                f"🎉 *ዙር ተጠናቀቀ! / Round Complete!*\n\n"
                f"🏆 አሸናፊ / Winner: *{winner}*\n"
                f"💰 ሽልማት / Prize: *{prize:.2f} ETB*\n"
                f"🃏 ካርዶች / Cards: *{cards}*\n"
                f"🎮 Stake: *{stake} ETB*"
            )
        else:
            msg = (
                f"⚠️ *ዙር ተጠናቀቀ — አሸናፊ የለም*\n\n"
                f"🃏 ካርዶች / Cards: *{cards}*\n"
                f"🎮 Stake: *{stake} ETB*\n"
                f"_(ሁሉም 75 ቦሎች ተጠርተዋል)_"
            )

        for chat_id in admin_chat_ids:
            try:
                bot.send_message(chat_id, msg, parse_mode='Markdown')
            except Exception as e:
                logger.warning(f"Telegram notify failed for chat_id {chat_id}: {e}")
    except Exception as e:
        logger.warning(f"_notify_admins_game_result error: {e}")


def add_stake(stake):
    """Dynamically add a new stake/room and start its game loop."""
    stake = int(stake)
    with _lock:
        if stake in STAKES:
            return False, "ሩሙ አስቀድሞ አለ"
        STAKES.append(stake)
        room_states[stake] = {
            'status': 'waiting',
            'launch_timer': 0,
            'balls': [],
            'winner': None,
            'winner_card': None,
            'prize': 0.0,
        }
        _stopped_stakes.discard(stake)
    t = threading.Thread(target=_room_loop, args=(stake,), daemon=True)
    t.name = f"room-loop-{stake}"
    _timer_threads[stake] = t
    t.start()
    logger.info(f"Dynamic room added: {stake} ETB")
    return True, "ሩም ተጨምሯል"


def remove_stake(stake):
    """Dynamically remove a stake/room. Blocks only during active play/launching."""
    stake = int(stake)
    with _lock:
        if stake not in STAKES:
            # Already stopped or never started — treat as success
            return True, "ሩሙ ቀደም ብሎ ቆሟል"
        state = room_states.get(stake, {})
        if state.get('status') in ('playing', 'launching'):
            return False, "ጨዋታ በሂደት ላይ ነው — ሩም ሊሰረዝ አይችልም"
        _stopped_stakes.add(stake)
        STAKES.remove(stake)
        room_states.pop(stake, None)
    logger.info(f"Dynamic room removed: {stake} ETB")
    return True, "ሩም ተሰርዟል"


def _room_loop(stake):
    logger.info(f"Room loop started for {stake} ETB room.")
    while True:
        try:
            # ── Check if this room has been removed ───────────────────────────
            with _lock:
                if stake in _stopped_stakes:
                    logger.info(f"Room {stake} ETB: loop stopping (room removed).")
                    return

            # ── WAITING PHASE: poll until enough cards are purchased ──────────
            min_cards = get_min_cards()
            with _lock:
                room_states[stake]['status'] = 'waiting'
                room_states[stake]['launch_timer'] = 0

            logger.info(f"Room {stake} ETB: WAITING — need {min_cards} cards to launch.")

            while True:
                with _lock:
                    if stake in _stopped_stakes:
                        return
                player_count = _cached_card_count(stake)
                min_cards = get_min_cards()
                if player_count >= min_cards:
                    break
                time.sleep(2)  # poll every 2s instead of 1s to reduce DB load

            # ── LAUNCHING PHASE: countdown before game starts ─────────────────
            countdown = get_launch_countdown()
            logger.info(f"Room {stake} ETB: {player_count}/{min_cards} cards — LAUNCHING in {countdown}s.")

            aborted = False
            for t in range(countdown, -1, -1):
                with _lock:
                    room_states[stake]['status'] = 'launching'
                    room_states[stake]['launch_timer'] = t

                # If cards drop below threshold during countdown, abort and wait again
                current = _cached_card_count(stake)
                current_min = get_min_cards()
                if current < current_min:
                    logger.info(
                        f"Room {stake} ETB: cards dropped to {current}/{current_min} "
                        f"during launch countdown — aborting."
                    )
                    aborted = True
                    break
                time.sleep(1)

            if aborted:
                # Countdown was aborted (cards dropped) — loop back to WAITING
                with _lock:
                    room_states[stake]['status'] = 'waiting'
                    room_states[stake]['launch_timer'] = 0
                continue

            # Countdown completed — check final count
            player_count = _count_session_players(stake)
            min_cards = get_min_cards()
            if player_count < min_cards:
                logger.info(f"Room {stake} ETB: cards insufficient at launch time — restarting wait.")
                continue

            # ── PLAYING PHASE ─────────────────────────────────────────────
            balls = list(range(1, 76))
            random.shuffle(balls)

            with _lock:
                room_states[stake]['status'] = 'playing'
                room_states[stake]['launch_timer'] = 0
                room_states[stake]['balls'] = []
                room_states[stake]['winner'] = None
                room_states[stake]['winner_card'] = None
                room_states[stake]['prize'] = 0.0

            logger.info(f"Room {stake} ETB: GAME STARTED with {player_count} player(s)")

            winner_found = False
            for ball in balls:
                with _lock:
                    room_states[stake]['balls'].append(ball)
                    called_set = set(room_states[stake]['balls'])

                logger.info(f"Room {stake} ETB: called ball {ball} ({len(called_set)}/75)")

                result = _find_and_award_winner(stake, called_set)
                if result:
                    username, card_num, prize = result
                    with _lock:
                        room_states[stake]['winner'] = username
                        room_states[stake]['winner_card'] = card_num
                        room_states[stake]['prize'] = prize
                    winner_found = True
                    break

                time.sleep(BALL_INTERVAL)

            if not winner_found:
                logger.info(f"Room {stake} ETB: all 75 balls called, no winner.")
                _complete_session_no_winner(stake)

            # ── GAME OVER: hold winner display, then reset ─────────────────
            time.sleep(WINNER_DISPLAY_SECONDS)

            with _lock:
                room_states[stake]['status'] = 'waiting'
                room_states[stake]['launch_timer'] = 0
                room_states[stake]['balls'] = []
                room_states[stake]['winner'] = None
                room_states[stake]['winner_card'] = None
                room_states[stake]['prize'] = 0.0

            logger.info(f"Room {stake} ETB: reset to WAITING")

        except Exception as e:
            logger.error(f"Room {stake} ETB: UNHANDLED EXCEPTION in loop — restarting in 5s: {e}", exc_info=True)
            time.sleep(5)  # brief pause then loop resumes automatically


def _send_daily_revenue_report(manual=False):
    """Calculate stats and send daily revenue summary to all admin Telegram accounts."""
    try:
        from app import app, db
        from models import User, Room, GameSession, Transaction
        from bot import bot
        from datetime import datetime, timezone, timedelta
        from sqlalchemy import func, distinct

        if not bot:
            logger.info("Daily report: bot not configured, skipping.")
            return False

        with app.app_context():
            admins = User.query.filter_by(is_admin=True).all()
            admin_chat_ids = [a.telegram_chat_id for a in admins if a.telegram_chat_id]

        if not admin_chat_ids:
            logger.info("Daily report: no admin with telegram_chat_id found.")
            return False

        with app.app_context():
            now = datetime.now(timezone.utc)
            if manual:
                # Manual trigger: report covers today so far
                period_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
                period_end   = now
                date_label   = f"📅 {now.strftime('%Y-%m-%d')} (ዛሬ / Today)"
            else:
                # Scheduled: report covers yesterday
                period_end   = now.replace(hour=0, minute=0, second=0, microsecond=0)
                period_start = period_end - timedelta(days=1)
                date_label   = f"📅 {period_start.strftime('%Y-%m-%d')} (ትናንት / Yesterday)"

            sessions = (GameSession.query
                        .filter(GameSession.status == 'completed')
                        .filter(GameSession.created_at >= period_start)
                        .filter(GameSession.created_at < period_end)
                        .all())

            fee = get_house_fee()
            total_rounds  = len(sessions)
            total_cards   = 0
            total_income  = 0.0
            total_payout  = 0.0

            for gs in sessions:
                room = Room.query.get(gs.room_id)
                if not room:
                    continue
                tx_count = Transaction.query.filter_by(session_id=gs.id).count()
                round_income   = tx_count * float(room.card_price)
                total_cards   += tx_count
                total_income  += round_income
                total_payout  += round_income * (1 - fee)

            total_profit  = total_income - total_payout
            active_players = (db.session.query(func.count(distinct(Transaction.user_id)))
                              .filter(Transaction.timestamp >= period_start)
                              .filter(Transaction.timestamp < period_end)
                              .scalar() or 0)
            total_users = User.query.count()

        tag = "🔔 ሪፖርት (Manual)" if manual else "📊 የዕለቱ ሪፖርት / Daily Report"
        msg = (
            f"{tag}\n"
            f"{date_label}\n\n"
            f"🎮 ዙሮች / Rounds: *{total_rounds}*\n"
            f"🃏 ካርዶች / Cards Sold: *{total_cards}*\n"
            f"👥 ንቁ ተጫዋቾች / Active: *{active_players}*\n"
            f"👤 ጠቅላላ ተጠቃሚዎች / Users: *{total_users}*\n\n"
            f"💵 ገቢ / Income: *{total_income:.2f} ETB*\n"
            f"💸 ክፍያ / Payout: *{total_payout:.2f} ETB*\n"
            f"🏦 ትርፍ / Profit: *{total_profit:.2f} ETB*\n"
            f"📈 Commission Rate: *{round(fee * 100)}%*"
        )

        sent = 0
        for chat_id in admin_chat_ids:
            try:
                bot.send_message(chat_id, msg, parse_mode='Markdown')
                sent += 1
            except Exception as e:
                logger.warning(f"Daily report send failed for {chat_id}: {e}")
        logger.info(f"Daily revenue report sent to {sent}/{len(admin_chat_ids)} admin(s).")
        return sent > 0

    except Exception as e:
        logger.error(f"_send_daily_revenue_report error: {e}")
        return False


def _expire_bonuses():
    """Zero out expired bonus balances and notify affected users via Telegram."""
    try:
        from app import app as _app, db as _db
        from models import User
        from datetime import datetime, timezone
        with _app.app_context():
            now = datetime.now(timezone.utc)
            expired = User.query.filter(
                User.bonus_balance > 0,
                User.bonus_expires_at != None,
                User.bonus_expires_at <= now
            ).all()
            count = 0
            for u in expired:
                amt = u.bonus_balance
                u.bonus_balance    = 0.0
                u.bonus_expires_at = None
                count += 1
                if u.telegram_chat_id:
                    try:
                        import telebot
                        import os
                        bot = telebot.TeleBot(os.environ.get("TELEGRAM_BOT_TOKEN", ""))
                        bot.send_message(
                            u.telegram_chat_id,
                            f"⏰ *Bonus ጊዜው አልፏል!*\n\n"
                            f"ያሎት *{amt:.2f} ETB* bonus balance ጊዜው ስላለፈ ተሰርዟል።\n"
                            f"💡 ወደፊት bonus ለማሳደር referral link ያጋሩ!",
                            parse_mode='Markdown'
                        )
                    except Exception:
                        pass
            if count:
                _db.session.commit()
                logger.info(f"Bonus expiry: zeroed bonus for {count} user(s).")
    except Exception as e:
        logger.error(f"_expire_bonuses error: {e}")


def _warn_expiring_bonuses():
    """Warn users whose bonus expires within 3 days."""
    try:
        from app import app as _app
        from models import User
        from datetime import datetime, timezone, timedelta
        with _app.app_context():
            now       = datetime.now(timezone.utc)
            warn_end  = now + timedelta(days=3)
            expiring  = User.query.filter(
                User.bonus_balance > 0,
                User.bonus_expires_at != None,
                User.bonus_expires_at > now,
                User.bonus_expires_at <= warn_end
            ).all()
            for u in expiring:
                if u.telegram_chat_id:
                    days_left = max(1, (u.bonus_expires_at.replace(tzinfo=timezone.utc) - now).days)
                    try:
                        import telebot, os
                        bot = telebot.TeleBot(os.environ.get("TELEGRAM_BOT_TOKEN", ""))
                        bot.send_message(
                            u.telegram_chat_id,
                            f"⚠️ *Bonus ጊዜ ማስጠንቀቂያ!*\n\n"
                            f"ያሎት *{u.bonus_balance:.2f} ETB* bonus ከ *{days_left}* ቀን ውስጥ ያልፋል!\n"
                            f"🎮 አሁኑኑ ጨዋታ ይጀምሩ — bonus ሲያልፍ ይሰረዛል።",
                            parse_mode='Markdown'
                        )
                    except Exception:
                        pass
            if expiring:
                logger.info(f"Bonus expiry warning sent to {len(expiring)} user(s).")
    except Exception as e:
        logger.error(f"_warn_expiring_bonuses error: {e}")


def _daily_report_loop():
    """Daemon thread: fire daily revenue report at 06:00 UTC every day (= 09:00 EAT)."""
    from datetime import datetime, timezone, timedelta
    logger.info("Daily report scheduler started — fires at 06:00 UTC (09:00 EAT) each day.")
    while True:
        now = datetime.now(timezone.utc)
        next_report = now.replace(hour=6, minute=0, second=0, microsecond=0)
        if next_report <= now:
            next_report += timedelta(days=1)
        sleep_secs = (next_report - now).total_seconds()
        logger.info(
            f"Daily report: next send in {sleep_secs/3600:.1f}h "
            f"({next_report.strftime('%Y-%m-%d %H:%M UTC')})"
        )
        time.sleep(sleep_secs)
        _send_daily_revenue_report(manual=False)
        _expire_bonuses()
        _warn_expiring_bonuses()


def _ensure_threads_alive():
    """Restart any room-loop threads that have died unexpectedly."""
    for stake in list(STAKES):
        t = _timer_threads.get(stake)
        if t is None or not t.is_alive():
            logger.warning(f"Room {stake} ETB: thread dead — restarting!")
            new_t = threading.Thread(target=_room_loop, args=(stake,), daemon=True)
            new_t.name = f"room-loop-{stake}"
            _timer_threads[stake] = new_t
            new_t.start()


def _watchdog_loop():
    """Daemon thread: check every 30s that all room loops are alive; revive any that died."""
    logger.info("Watchdog started — monitoring room loop threads every 30s.")
    while True:
        time.sleep(30)
        try:
            _ensure_threads_alive()
        except Exception as e:
            logger.error(f"Watchdog error: {e}")


def start_all_room_timers():
    for stake in STAKES:
        if stake not in _timer_threads or not _timer_threads[stake].is_alive():
            t = threading.Thread(target=_room_loop, args=(stake,), daemon=True)
            t.name = f"room-loop-{stake}"
            _timer_threads[stake] = t
            t.start()

    report_thread = threading.Thread(target=_daily_report_loop, daemon=True)
    report_thread.name = "daily-report-scheduler"
    report_thread.start()

    watchdog_thread = threading.Thread(target=_watchdog_loop, daemon=True)
    watchdog_thread.name = "room-watchdog"
    watchdog_thread.start()

    logger.info("All room loops and watchdog started.")


def set_room_playing(stake):
    with _lock:
        room_states[stake]['status'] = 'playing'
    logger.info(f"Room {stake} ETB set to PLAYING (manual).")


def set_room_waiting(stake):
    with _lock:
        room_states[stake]['status'] = 'waiting'
        room_states[stake]['launch_timer'] = 0
    logger.info(f"Room {stake} ETB set to WAITING (manual).")


def get_all_room_status():
    with _lock:
        states_snapshot = {stake: dict(room_states[stake]) for stake in STAKES}

    alert = get_broadcast_alert()
    # Read shared settings once — they are cached, so this is cheap
    min_c = get_min_cards()
    fee = get_house_fee()
    countdown = get_launch_countdown()
    fee_pct = round(fee * 100)

    result = {}
    for stake in STAKES:
        s = states_snapshot[stake]
        count = _cached_card_count(stake)
        prize_pool = round(count * stake * (1 - fee), 2)
        result[str(stake)] = {
            'status':           s['status'],
            'launch_timer':     s['launch_timer'],
            'cards_count':      count,
            'min_cards':        min_c,
            'prize_pool':       prize_pool,
            'house_fee_pct':    fee_pct,
            'launch_countdown': countdown,
            'broadcast_alert':  alert,
        }
    return result


def get_room_game_state(stake):
    with _lock:
        s = room_states[stake]
        return {
            'status': s['status'],
            'balls': list(s['balls']),
            'winner': s['winner'],
            'winner_card': s['winner_card'],
            'prize': s['prize'],
            'launch_timer': s['launch_timer'],
        }
