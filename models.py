from app import db
from flask_login import UserMixin

class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False)
    telegram_chat_id = db.Column(db.String(64), unique=True, nullable=False)
    balance = db.Column(db.Float, default=0.0)
    is_admin = db.Column(db.Boolean, default=False)
    referred_by = db.Column(db.String(255), nullable=True)
    password_hash = db.Column(db.String(256), nullable=True)

class Room(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(64), unique=True, nullable=False)
    card_price = db.Column(db.Float, nullable=False)
    active_session_id = db.Column(db.Integer, db.ForeignKey('game_sessions.id'))

class GameSession(db.Model):
    __tablename__ = 'game_sessions'
    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey('room.id'), nullable=False)
    status = db.Column(db.String(20), default='active') # active, completed
    winner_id = db.Column(db.Integer, db.ForeignKey('users.id'))
    created_at = db.Column(db.DateTime, server_default=db.func.now())
    
    room = db.relationship('Room', foreign_keys=[room_id], backref='sessions')

class Transaction(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    room_id = db.Column(db.Integer, db.ForeignKey('room.id'), nullable=False)
    session_id = db.Column(db.Integer, db.ForeignKey('game_sessions.id'))
    amount = db.Column(db.Float, nullable=False)
    card_number = db.Column(db.Integer, nullable=True)
    timestamp = db.Column(db.DateTime, server_default=db.func.now())
