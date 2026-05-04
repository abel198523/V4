from app import db
from flask_login import UserMixin

class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False)
    telegram_chat_id = db.Column(db.String(64), unique=True, nullable=True)
    phone_number = db.Column(db.String(32), nullable=True)
    balance = db.Column(db.Float, default=0.0)
    withdrawable_balance = db.Column(db.Float, default=0.0, nullable=False, server_default='0')
    is_admin = db.Column(db.Boolean, default=False)
    bonus_balance = db.Column(db.Float, default=0.0, nullable=False, server_default='0')
    bonus_expires_at = db.Column(db.DateTime(timezone=True), nullable=True)
    current_streak = db.Column(db.Integer, default=0, nullable=False, server_default='0')
    last_play_date = db.Column(db.Date, nullable=True)
    referred_by = db.Column(db.String(16), nullable=True)
    referral_code = db.Column(db.String(16), unique=True, nullable=True)
    referral_bonus_paid = db.Column(db.Boolean, default=False, nullable=False, server_default='false')
    password_hash = db.Column(db.String(256), nullable=True)

class LoginToken(db.Model):
    __tablename__ = 'login_tokens'
    id = db.Column(db.Integer, primary_key=True)
    token = db.Column(db.String(64), unique=True, nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    created_at = db.Column(db.DateTime, server_default=db.func.now())
    used = db.Column(db.Boolean, default=False, nullable=False)

class Room(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(64), unique=True, nullable=False)
    card_price = db.Column(db.Float, nullable=False)
    active_session_id = db.Column(db.Integer, db.ForeignKey('game_sessions.id'))

class GameSession(db.Model):
    __tablename__ = 'game_sessions'
    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey('room.id'), nullable=False)
    status = db.Column(db.String(20), default='active')
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

class OTPStore(db.Model):
    __tablename__ = 'otp_store'
    id = db.Column(db.Integer, primary_key=True)
    telegram_chat_id = db.Column(db.String(64), unique=True, nullable=False)
    otp = db.Column(db.String(6), nullable=False)
    created_at = db.Column(db.DateTime, server_default=db.func.now())

class Setting(db.Model):
    __tablename__ = 'settings'
    key = db.Column(db.String(64), primary_key=True)
    value = db.Column(db.String(256), nullable=False)

class DepositRequest(db.Model):
    __tablename__ = 'deposit_requests'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    method = db.Column(db.String(64), nullable=False)
    transaction_code = db.Column(db.String(128), nullable=False)
    status = db.Column(db.String(20), default='pending')
    created_at = db.Column(db.DateTime, server_default=db.func.now())
    user = db.relationship('User', backref='deposit_requests')

class WithdrawRequest(db.Model):
    __tablename__ = 'withdraw_requests'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    method = db.Column(db.String(64), nullable=False)
    account_details = db.Column(db.String(256), nullable=False)
    status = db.Column(db.String(20), default='pending')
    created_at = db.Column(db.DateTime, server_default=db.func.now())
    user = db.relationship('User', backref='withdraw_requests')
