import os

workers = 1
threads = 8
worker_class = "gthread"
timeout = 120
keepalive = 5
bind = f"0.0.0.0:{os.environ.get('PORT', '5000')}"


def on_starting(server):
    pass


def post_fork(server, worker):
    """Called in each worker after forking — restart background threads here
    because threads created before the fork do NOT survive into child processes."""
    try:
        from game_engine import start_all_room_timers
        start_all_room_timers()
        server.log.info(f"[worker {worker.pid}] Room timers started via post_fork hook.")
    except Exception as e:
        server.log.error(f"[worker {worker.pid}] Failed to start room timers: {e}")
