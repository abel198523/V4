import threading
import time
import logging

logger = logging.getLogger(__name__)

STAKES = [5, 10, 20]
COUNTDOWN_SECONDS = 30

_lock = threading.Lock()

# Per-room state: {stake: {'timer': int, 'status': 'waiting'|'playing'}}
room_states = {s: {'timer': COUNTDOWN_SECONDS, 'status': 'waiting'} for s in STAKES}

_timer_threads = {}


def _room_loop(stake):
    """Independent countdown loop for a single room. Runs forever."""
    logger.info(f"Room timer thread started for {stake} ETB room.")
    while True:
        with _lock:
            status = room_states[stake]['status']

        if status == 'playing':
            time.sleep(0.5)
            continue

        # Count down from COUNTDOWN_SECONDS to 0
        for t in range(COUNTDOWN_SECONDS, -1, -1):
            with _lock:
                if room_states[stake]['status'] == 'playing':
                    break
                room_states[stake]['timer'] = t
            time.sleep(1)

        # After reaching 0 (or if still waiting), cycle back
        with _lock:
            if room_states[stake]['status'] == 'waiting':
                room_states[stake]['timer'] = COUNTDOWN_SECONDS


def start_all_room_timers():
    """Start independent background timer threads for all rooms."""
    for stake in STAKES:
        if stake not in _timer_threads or not _timer_threads[stake].is_alive():
            t = threading.Thread(target=_room_loop, args=(stake,), daemon=True)
            t.name = f"room-timer-{stake}"
            _timer_threads[stake] = t
            t.start()
    logger.info("All room timer threads started.")


def set_room_playing(stake):
    """Mark a room as 'playing' — stops countdown."""
    with _lock:
        room_states[stake]['status'] = 'playing'
    logger.info(f"Room {stake} ETB set to PLAYING.")


def set_room_waiting(stake):
    """Mark a room as 'waiting' — restarts countdown from 30."""
    with _lock:
        room_states[stake]['status'] = 'waiting'
        room_states[stake]['timer'] = COUNTDOWN_SECONDS
    logger.info(f"Room {stake} ETB set to WAITING (timer reset to {COUNTDOWN_SECONDS}).")


def get_all_room_status():
    """Return a snapshot of all room states for polling."""
    with _lock:
        result = {}
        for stake in STAKES:
            s = room_states[stake]
            result[str(stake)] = {
                'timer': 'PLAYING' if s['status'] == 'playing' else s['timer'],
                'status': s['status'],
            }
        return result
