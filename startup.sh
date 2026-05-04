#!/bin/bash
set -e

echo "==> Starting Royal Bingo..."
echo "==> Initializing database tables..."

python3 - <<'EOF'
import os, sys, logging
logging.basicConfig(level=logging.INFO)

try:
    from app import app, db
    import models

    with app.app_context():
        db.create_all()
        print("✓ All database tables created/verified.")

        # List created tables
        from sqlalchemy import inspect
        inspector = inspect(db.engine)
        tables = inspector.get_table_names()
        print(f"✓ Tables in database: {', '.join(tables)}")

except Exception as e:
    print(f"✗ Database initialization failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
EOF

echo "==> Database ready. Starting gunicorn..."
exec gunicorn main:app \
    --bind 0.0.0.0:$PORT \
    --workers 1 \
    --threads 8 \
    --worker-class gthread \
    --timeout 120 \
    --keep-alive 5
