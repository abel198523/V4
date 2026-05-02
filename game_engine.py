import threading
import time
import random
import logging

logger = logging.getLogger(__name__)

STAKES = [10]
COUNTDOWN_SECONDS = 20
BALL_INTERVAL = 3
WINNER_DISPLAY_SECONDS = 8
HOUSE_FEE = 0.10
MIN_CARDS = 2  # default minimum; overridden at runtime by DB setting

_lock = threading.Lock()

room_states = {
    s: {
        'status': 'waiting',
        'timer': COUNTDOWN_SECONDS,
        'balls': [],
        'winner': None,
        'winner_card': None,
        'prize': 0.0,
    }
    for s in STAKES
}

_timer_threads = {}


def get_min_cards():
    """Read MIN_CARDS from DB setting; fall back to module default."""
    try:
        from app import app, db
        from models import Setting
        with app.app_context():
            s = Setting.query.get('min_cards')
            return int(s.value) if s else MIN_CARDS
    except Exception:
        return MIN_CARDS


def get_countdown_seconds():
    """Read COUNTDOWN_SECONDS from DB setting; fall back to module default."""
    try:
        from app import app, db
        from models import Setting
        with app.app_context():
            s = Setting.query.get('countdown_seconds')
            return int(s.value) if s else COUNTDOWN_SECONDS
    except Exception:
        return COUNTDOWN_SECONDS


def get_house_fee():
    """Read HOUSE_FEE (0.0–1.0) from DB setting stored as integer percent; fall back to default."""
    try:
        from app import app, db
        from models import Setting
        with app.app_context():
            s = Setting.query.get('house_fee_pct')
            return round(int(s.value) / 100.0, 4) if s else HOUSE_FEE
    except Exception:
        return HOUSE_FEE


def _count_session_players(stake):
    """Return number of cards purchased for this room's current active session."""
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
        from models import Transaction, Room, User
        from card_data import get_card_data, check_bingo

        with app.app_context():
            room = Room.query.filter_by(card_price=float(stake)).first()
            if not room or not room.active_session_id:
                return None

            transactions = Transaction.query.filter_by(
                room_id=room.id,
                session_id=room.active_session_id
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
                        db.session.commit()
                        logger.info(
                            f"Room {stake} ETB: WINNER={user.username} "
                            f"card=#{tx.card_number} prize={prize:.2f} ETB"
                        )
                        return (user.username, tx.card_number, round(prize, 2))
    except Exception as e:
        logger.error(f"Winner check error for room {stake}: {e}")
    return None


def _room_loop(stake):
    logger.info(f"Room timer thread started for {stake} ETB room.")
    while True:
        # --- WAITING PHASE: count down (reads live DB value each round) ---
        countdown = get_countdown_seconds()
        with _lock:
            room_states[stake]['status'] = 'waiting'
            room_states[stake]['timer'] = countdown

        for t in range(countdown, -1, -1):
            with _lock:
                room_states[stake]['timer'] = t
            time.sleep(1)

        # Check minimum cards threshold before launching (reads live DB value)
        min_cards = get_min_cards()
        player_count = _count_session_players(stake)
        if player_count < min_cards:
            logger.info(f"Room {stake} ETB: only {player_count}/{min_cards} cards — restarting countdown.")
            continue  # restart countdown, not enough cards

        # --- AUTO-START GAME ---
        balls = list(range(1, 76))
        random.shuffle(balls)

        with _lock:
            room_states[stake]['status'] = 'playing'
            room_states[stake]['balls'] = []
            room_states[stake]['winner'] = None
            room_states[stake]['winner_card'] = None
            room_states[stake]['prize'] = 0.0

        logger.info(f"Room {stake} ETB: GAME STARTED with {player_count} player(s)")

        # --- PLAYING PHASE: call one ball every BALL_INTERVAL seconds ---
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

        # --- GAME OVER: hold winner display, then reset ---
        time.sleep(WINNER_DISPLAY_SECONDS)

        with _lock:
            room_states[stake]['status'] = 'waiting'
            room_states[stake]['timer'] = COUNTDOWN_SECONDS
            room_states[stake]['balls'] = []
            room_states[stake]['winner'] = None
            room_states[stake]['winner_card'] = None
            room_states[stake]['prize'] = 0.0

        logger.info(f"Room {stake} ETB: reset to WAITING")


def start_all_room_timers():
    for stake in STAKES:
        if stake not in _timer_threads or not _timer_threads[stake].is_alive():
            t = threading.Thread(target=_room_loop, args=(stake,), daemon=True)
            t.name = f"room-timer-{stake}"
            _timer_threads[stake] = t
            t.start()
    logger.info("All room timer threads started.")


def set_room_playing(stake):
    with _lock:
        room_states[stake]['status'] = 'playing'
    logger.info(f"Room {stake} ETB set to PLAYING (manual).")


def set_room_waiting(stake):
    with _lock:
        room_states[stake]['status'] = 'waiting'
        room_states[stake]['timer'] = COUNTDOWN_SECONDS
    logger.info(f"Room {stake} ETB set to WAITING (manual).")


def get_all_room_status():
    with _lock:
        states_snapshot = {stake: dict(room_states[stake]) for stake in STAKES}

    result = {}
    for stake in STAKES:
        s = states_snapshot[stake]
        count = _count_session_players(stake)
        prize_pool = round(count * stake * (1 - get_house_fee()), 2)
        result[str(stake)] = {
            'timer': 'PLAYING' if s['status'] == 'playing' else s['timer'],
            'status': s['status'],
            'cards_count': count,
            'prize_pool': prize_pool,
            'min_cards': get_min_cards(),
            'countdown_seconds': get_countdown_seconds(),
            'house_fee_pct': round(get_house_fee() * 100),
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
            'timer': s['timer'],
        }
