# Flask Website Project

## Overview
This is a Flask web application migrated to the Replit environment. It is primarily built with the intention of being deployed on Render. All architectural decisions and configurations should remain compatible with Render's hosting environment.

## Deployment on Render
To deploy this application on Render:
1. **Build Command**: `pip install -r requirements.txt` (ensure a requirements.txt is maintained or use the environment's package manager export).
2. **Start Command**: `gunicorn main:app`
3. **Environment Variables**:
   - `DATABASE_URL`: Your PostgreSQL connection string (Render provides this for their managed databases).
   - `SESSION_SECRET`: A secure random string for session encryption.
   - `PYTHON_VERSION`: 3.11.x
   - `PORT`: Render automatically sets this, but our app should be flexible (defaulting to 5000 if not set).

## User Preferences
- **Deployment Platform**: Render (Primary target). All development must be Render-compatible.
- **Database**: PostgreSQL.
- **WSGI Server**: Gunicorn.

## Recent Changes
- Migrated project from Replit Agent to Replit.
- Configured PostgreSQL database.
- Added Render deployment considerations.
- Set up Gunicorn as the WSGI server.
