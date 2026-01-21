# Royal Bingo - WebSocket Game Application

## Overview
This is a real-time Bingo game application built with Node.js, Express, and WebSocket. Players can join rooms with different stake amounts, select bingo cards, and play against other players in real-time.

## Tech Stack
- **Backend**: Node.js with Express
- **Real-time Communication**: WebSocket (ws library)
- **Database**: PostgreSQL
- **Authentication**: JWT tokens with bcrypt password hashing
- **Frontend**: Vanilla JavaScript with Bootstrap 5

## Project Structure
- `server.js` - Main Express server with WebSocket, API endpoints, and game logic
- `db.js` - PostgreSQL database connection
- `game.js` - Client-side game logic and WebSocket handling
- `index.html` - Main landing page and game interface
- `login.html` - Login page
- `signup.html` - Registration page with Telegram OTP verification
- `admin.html` - Admin panel for managing users and transactions
- `cards.json` - Bingo card configurations
- `style.css` - Custom styling

## Database Schema
- `users` - User accounts with balance, telegram integration
- `deposit_requests` - User deposit requests
- `withdraw_requests` - User withdrawal requests  
- `balance_history` - Transaction history

## Environment Variables
- `DATABASE_URL` - PostgreSQL connection string (automatically set by Replit)
- `SESSION_SECRET` or `JWT_SECRET` - Secret key for JWT tokens
- `BOT_TOKEN` - Telegram bot token for notifications (optional)

## Running the Application
The application runs on port 5000 using:
```
node server.js
```

## Features
- Multiple stake rooms (5, 10, 20, 30, 40, 50, 100, 200, 500 ETB)
- Real-time bingo gameplay via WebSocket
- User registration with Telegram OTP verification
- Balance management (deposits/withdrawals)
- Admin panel for user management
- Telegram bot integration for notifications

## Recent Changes
- Converted Jinja2 templates to standalone HTML files for Node.js compatibility
- Configured PostgreSQL database for Replit environment
- Set up Express server to serve static files and handle API routes
