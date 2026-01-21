const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(`${protocol}//${window.location.host}`);
const bingoBoard = document.getElementById('bingo-board');
const activeBall = document.getElementById('active-ball');
const recentBalls = document.getElementById('recent-balls');
const callCount = document.getElementById('call-count');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');

const colors = {
    B: '#3b82f6',
    I: '#8b5cf6',
    N: '#22c55e',
    G: '#f59e0b',
    O: '#ef4444'
};

function createBingoNumbers() {
    bingoBoard.innerHTML = '';
    for (let row = 0; row < 15; row++) {
        for (let col = 0; col < 5; col++) {
            const num = (col * 15) + row + 1;
            const cell = document.createElement('div');
            cell.className = 'bingo-cell';
            cell.id = `num-${num}`;
            cell.innerText = num;
            bingoBoard.appendChild(cell);
        }
    }
}

let currentRoom = null;
let roomTakenCards = [];
let roomStates = {};

function getRoomState(roomId) {
    if (!roomStates[roomId]) {
        roomStates[roomId] = {
            myGameCard: null,
            currentSelectedCard: null,
            currentCardData: null,
            lastHistory: []
        };
    }
    return roomStates[roomId];
}

// Variables to store current global stats
let globalStats = {};
let globalPrizes = {};

function updateRoomStats(stats, roomTimers, prizes) {
    globalStats = stats || {};
    globalPrizes = prizes || {};
    Object.keys(stats).forEach(amount => {
        const countEl = document.getElementById(`stake-count-${amount}`);
        if (countEl) {
            countEl.innerText = `${stats[amount]} Players`;
            countEl.style.fontWeight = 'bold';
            countEl.style.color = stats[amount] > 0 ? '#3b82f6' : '#6b7280';
        }
        
        const prizeEl = document.getElementById(`stake-prize-${amount}`);
        if (prizeEl && prizes && prizes[amount] !== undefined) {
            prizeEl.innerText = `Prize: ${prizes[amount].toFixed(2)} ETB`;
            prizeEl.style.display = 'block';
        }
        
        const timerEl = document.getElementById(`stake-timer-${amount}`);
        if (timerEl && roomTimers && roomTimers[amount] !== undefined) {
            const val = roomTimers[amount];
            if (val === 'PLAYING') {
                timerEl.innerText = '🎮 PLAYING';
                timerEl.style.color = '#22c55e';
                timerEl.style.background = 'rgba(34, 197, 94, 0.1)';
            } else {
                const seconds = parseInt(val);
                timerEl.innerText = `⏰ ${seconds}`;
                timerEl.style.color = '#f59e0b';
                timerEl.style.background = 'rgba(245, 158, 11, 0.1)';
            }
        }
    });
}

function updateCountdown(seconds) {
    const timerEl = document.getElementById('selection-timer');
    const timerLargeEl = document.getElementById('selection-timer-large');
    const stakeTimerEl = document.getElementById('stake-selection-timer');
    
    if (!timerEl && !timerLargeEl && !stakeTimerEl) return;

    const timeStr = seconds === 'PLAYING' ? 'በጨዋታ ላይ' : seconds;
    const timeStrWithEmoji = seconds === 'PLAYING' ? '🎮 በጨዋታ ላይ' : `⏰ ${seconds}`;
    
    if (timerEl) timerEl.innerText = timeStrWithEmoji;
    if (timerLargeEl) timerLargeEl.innerText = timeStr;
    if (stakeTimerEl) stakeTimerEl.innerText = timeStrWithEmoji;
    
    if (typeof STAKES !== 'undefined' && STAKES) {
        STAKES.forEach(amount => {
            const rowTimer = document.getElementById(`stake-timer-${amount}`);
            if (rowTimer && currentRoom == amount) {
                rowTimer.innerText = timeStrWithEmoji;
            }
        });
    }
}

const STAKES = [5, 10, 20, 30, 40, 50, 100, 200, 500];

const staticCards = [{"id":1,"data":{"B":[7,10,13,14,15],"I":[18,21,23,29,30],"N":[35,36,"FREE",40,43],"G":[46,47,48,49,56],"O":[65,67,69,70,75]}},{"id":2,"data":{"B":[2,7,11,14,15],"I":[16,18,20,21,25],"N":[31,32,"FREE",39,43],"G":[50,53,56,58,60],"O":[63,66,72,73,74]}},{"id":3,"data":{"B":[2,4,12,13,14],"I":[16,22,24,29,30],"N":[32,33,"FREE",44,45],"G":[47,52,56,59,60],"O":[61,62,64,66,68]}},{"id":4,"data":{"B":[3,6,7,10,13],"I":[16,21,24,26,30],"N":[32,33,"FREE",36,41],"G":[46,48,52,54,59],"O":[63,65,66,72,75]}},{"id":5,"data":{"B":[1,4,7,12,15],"I":[17,19,26,29,30],"N":[31,32,"FREE",36,37],"G":[46,51,52,54,58],"O":[64,68,71,73,74]}},{"id":6,"data":{"B":[3,4,5,6,10],"I":[18,20,25,26,27],"N":[32,34,"FREE",41,45],"G":[48,50,51,53,54],"O":[62,63,65,67,75]}},{"id":7,"data":{"B":[1,2,4,5,6],"I":[17,21,24,27,30],"N":[31,33,"FREE",42,45],"G":[48,49,50,56,57],"O":[67,68,71,73,74]}},{"id":8,"data":{"B":[1,6,7,9,12],"I":[17,19,21,27,28],"N":[31,40,"FREE",42,43],"G":[47,49,50,51,57],"O":[64,65,66,70,74]}},{"id":9,"data":{"B":[3,6,9,12,14],"I":[16,17,20,22,27],"N":[31,37,"FREE",39,40],"G":[49,54,55,57,59],"O":[63,67,69,70,74]}},{"id":10,"data":{"B":[1,5,9,10,15],"I":[23,24,27,29,30],"N":[35,39,"FREE",43,45],"G":[47,52,56,58,59],"O":[62,63,64,67,71]}},{"id":11,"data":{"B":[1,2,6,12,14],"I":[16,18,21,28,30],"N":[31,37,"FREE",41,45],"G":[46,52,54,55,56],"O":[63,68,71,72,73]}},{"id":12,"data":{"B":[1,6,7,12,14],"I":[16,17,18,21,29],"N":[31,33,"FREE",43,45],"G":[46,54,55,56,59],"O":[62,63,65,69,70]}},{"id":13,"data":{"B":[1,6,8,11,15],"I":[16,19,20,22,30],"N":[35,38,"FREE",41,42],"G":[48,51,53,56,58],"O":[68,69,70,73,75]}},{"id":14,"data":{"B":[2,9,11,14,15],"I":[16,21,22,25,29],"N":[35,38,"FREE",41,45],"G":[46,51,52,54,57],"O":[66,67,69,72,75]}},{"id":15,"data":{"B":[5,7,11,12,14],"I":[18,19,22,25,26],"N":[33,41,"FREE",44,45],"G":[46,51,53,54,55],"O":[63,67,70,73,74]}},{"id":16,"data":{"B":[1,7,8,14,15],"I":[17,19,25,27,30],"N":[32,37,"FREE",42,44],"G":[50,52,55,56,58],"O":[61,62,65,69,70]}}];

function getCardById(id) {
    const found = staticCards.find(c => c.id === id);
    return found ? found.data : staticCards[0].data;
}

function createAvailableCards() {
    const cardsGrid = document.getElementById('cards-grid');
    if (!cardsGrid) return;
    cardsGrid.innerHTML = '';
    
    const availableCount = 100 - roomTakenCards.length;
    const takenCount = roomTakenCards.length;
    
    const legendAvailable = document.querySelector('.legend-item:nth-child(1)');
    const legendTaken = document.querySelector('.legend-item:nth-child(2)');
    
    if (legendAvailable) legendAvailable.innerHTML = `<div class="dot green"></div> Available (${availableCount})`;
    if (legendTaken) legendTaken.innerHTML = `<div class="dot red"></div> Taken (${takenCount})`;

    for (let i = 1; i <= 100; i++) {
        const card = document.createElement('div');
        card.className = 'card-item';
        if (roomTakenCards.includes(i)) card.classList.add('taken');
        card.innerText = i;
        
        card.onclick = () => {
            if (card.classList.contains('taken')) return;
            showCardPreview(i);
        };
        cardsGrid.appendChild(card);
    }
}

function showToast(message) {
    const toast = document.getElementById('notification-toast');
    const msgEl = document.getElementById('toast-message');
    if (!toast || !msgEl) {
        // Fallback for standard alert if toast element is missing
        if (message.includes("አልሞላም")) {
             // Create dynamic notification if missing
             const div = document.createElement('div');
             div.id = 'notification-toast';
             div.className = 'active';
             div.innerHTML = `<span id="toast-message">${message}</span>`;
             document.body.appendChild(div);
             setTimeout(() => div.remove(), 3000);
        }
        return;
    }
    msgEl.innerText = message;
    toast.classList.add('active');
    setTimeout(() => toast.classList.remove('active'), 3000);
}

function showWinnerModal(name, winCard, winPattern) {
    const modal = document.getElementById('winner-modal');
    const nameEl = document.getElementById('winner-display-name');
    const cardCont = document.getElementById('winner-card-container');
    if (!modal || !nameEl || !cardCont) return;
    nameEl.innerText = name;
    cardCont.innerHTML = '';
    if (winCard && winPattern) {
        const letters = ['B', 'I', 'N', 'G', 'O'];
        for (let row = 0; row < 5; row++) {
            letters.forEach(l => {
                const val = winCard[l][row];
                const cell = document.createElement('div');
                cell.className = 'win-cell';
                cell.innerText = val === 'FREE' ? '★' : val;
                if (winPattern.includes(val) || val === 'FREE') cell.classList.add('highlight');
                cardCont.appendChild(cell);
            });
        }
    }
    modal.classList.add('active');
}

socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'INIT') {
        currentRoom = data.room;
        const state = getRoomState(currentRoom);
        roomTakenCards = data.takenCards || [];
        if (!data.isGameRunning) {
            state.myGameCard = null;
            state.currentSelectedCard = null;
            state.currentCardData = null;
        }
        updateGameUI(data.history);
        updateCountdown(data.isGameRunning ? 'PLAYING' : data.countdown);
        createAvailableCards();
    } else if (data.type === 'NEW_BALL') {
        const state = getRoomState(data.room);
        state.lastHistory = data.history;
        if (data.room == currentRoom) updateGameUI(data.history);
    } else if (data.type === 'COUNTDOWN') {
        if (data.room == currentRoom) {
            updateCountdown(data.value);
        }
    } else if (data.type === 'GAME_START') {
        if (data.room == currentRoom) startGame();
            } else if (data.type === 'GAME_OVER') {
        const state = getRoomState(data.room);
        state.myGameCard = null;
        state.currentSelectedCard = null;
        state.currentCardData = null;
        state.lastHistory = [];
        
        // Ensure game board and all lists are cleared for the next session
        const masterGrid = document.getElementById('master-grid');
        if (masterGrid) masterGrid.innerHTML = '';
        
        const bingoBoard = document.getElementById('bingo-board');
        if (bingoBoard) bingoBoard.innerHTML = '';
        
        const recentBalls = document.getElementById('recent-balls');
        if (recentBalls) recentBalls.innerHTML = '';
        
        const activeBall = document.getElementById('active-ball');
        if (activeBall) activeBall.innerHTML = '<span>--</span>';
        
        const callCount = document.getElementById('call-count');
        if (callCount) callCount.innerText = '0';
        
        const progressText = document.getElementById('progress-text');
        if (progressText) progressText.innerText = '0/75';
        
        const progressBar = document.getElementById('progress-bar');
        if (progressBar) progressBar.style.width = '0%';
        
        if (data.room == currentRoom || !data.room) {
            showWinnerModal(data.winner, data.winCard, data.winPattern);
            setTimeout(() => {
                const modal = document.getElementById('winner-modal');
                if (modal) modal.classList.remove('active');
                
                // Hide all active screens
                const screens = ['game-screen', 'selection-screen', 'profile-screen', 'wallet-screen', 'deposit-screen', 'withdraw-screen'];
                screens.forEach(s => {
                    const el = document.getElementById(s);
                    if (el) el.classList.remove('active');
                });
                
                // Redirect to stake selection screen (initial state)
                const stakeScreen = document.getElementById('stake-screen');
                if (stakeScreen) stakeScreen.classList.add('active');
                
                // Reset current room to force re-selection
                currentRoom = null;
                
            }, 8000);
        }
    } else if (data.type === 'ERROR') {
        showToast(data.message);
    } else if (data.type === 'ROOM_STATS') {
        if (data.takenCards && data.takenCards[currentRoom]) {
            roomTakenCards = data.takenCards[currentRoom];
            createAvailableCards();
        }
        updateRoomStats(data.stats, data.timers, data.prizes);
        
        // Ensure selection timer is updated if we are in a room
        if (currentRoom && data.timers && data.timers[currentRoom] !== undefined) {
            updateCountdown(data.timers[currentRoom]);
        }
    } else if (data.type === 'BALANCE_UPDATE') {
        userBalance = data.balance;
        const balanceEl = document.getElementById('sel-balance');
        const walletBalanceEl = document.getElementById('wallet-balance-value');
        const indexBalanceEl = document.getElementById('walletBalance');
        if (balanceEl) balanceEl.innerText = userBalance.toFixed(2);
        if (walletBalanceEl) walletBalanceEl.innerText = userBalance.toFixed(2);
        if (indexBalanceEl) indexBalanceEl.innerText = userBalance.toFixed(2);
    }
};

    const submitDeposit = document.getElementById('submit-deposit');
    if (submitDeposit) {
        submitDeposit.onclick = async () => {
            const amount = document.getElementById('deposit-amount').value;
            const method = document.getElementById('deposit-method').value;
            const code = document.getElementById('deposit-code').value;
            const statusEl = document.getElementById('deposit-status');
            const token = localStorage.getItem('bingo_token');

            if (!amount || !method || !code) {
                if (statusEl) {
                    statusEl.innerText = "እባክዎ ሁሉንም መረጃዎች በትክክል ይሙሉ";
                    statusEl.style.color = "#ef4444";
                }
                return;
            }

            try {
                const response = await fetch('/api/deposit-request', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ amount, method, code })
                });
                const data = await response.json();
                if (response.ok) {
                    if (statusEl) {
                        statusEl.innerText = data.message;
                        statusEl.style.color = "#22c55e";
                    }
                    document.getElementById('deposit-code').value = '';
                } else {
                    if (statusEl) {
                        statusEl.innerText = data.error || "ስህተት አጋጥሟል";
                        statusEl.style.color = "#ef4444";
                    }
                }
            } catch (err) {
                if (statusEl) {
                    statusEl.innerText = "ከሰርቨር ጋር መገናኘት አልተቻለም";
                    statusEl.style.color = "#ef4444";
                }
            }
        };
    }

    const submitWithdrawElement = document.getElementById('submit-withdraw');
    if (submitWithdrawElement) {
        submitWithdrawElement.onclick = async () => {
            const amount = document.getElementById('withdraw-amount').value;
            const method = document.getElementById('withdraw-method').value;
            const account = document.getElementById('withdraw-account').value;
            const statusEl = document.getElementById('withdraw-status');
            const token = localStorage.getItem('bingo_token');

            if (!amount || !method || !account) {
                if (statusEl) {
                    statusEl.innerText = "እባክዎ ሁሉንም መረጃዎች በትክክል ይሙሉ";
                    statusEl.style.color = "#ef4444";
                }
                return;
            }

            try {
                const response = await fetch('/api/withdraw-request', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ amount, method, account })
                });
                const data = await response.json();
                if (response.ok) {
                    if (statusEl) {
                        statusEl.innerText = data.message;
                        statusEl.style.color = "#22c55e";
                    }
                    document.getElementById('withdraw-amount').value = '';
                    document.getElementById('withdraw-account').value = '';
                } else {
                    if (statusEl) {
                        statusEl.innerText = data.error || "ስህተት አጋጥሟል";
                        statusEl.style.color = "#ef4444";
                    }
                }
            } catch (err) {
                if (statusEl) {
                    statusEl.innerText = "ከሰርቨር ጋር መገናኘት አልተቻለም";
                    statusEl.style.color = "#ef4444";
                }
            }
        };
    }

    const bingoBtn = document.getElementById('bingo-btn');
    if (bingoBtn) {
        bingoBtn.onclick = () => {
            const state = getRoomState(currentRoom);
            if (!currentRoom) {
                showToast("በቅድሚያ ክፍል ይግቡ");
                return;
            }
            
            // Log for debugging
            console.log("Bingo claim clicked. Room:", currentRoom, "Card:", state.currentSelectedCard, "MyGameCard:", state.myGameCard);

            socket.send(JSON.stringify({
                type: 'BINGO_CLAIM',
                room: currentRoom,
                cardNumber: state.currentSelectedCard || (state.myGameCard ? state.myGameCard.id : null),
                cardData: state.myGameCard || state.currentCardData
            }));
            
            bingoBtn.style.transform = 'scale(0.95)';
            setTimeout(() => bingoBtn.style.transform = 'scale(1)', 100);
        };
    }

function logout() {
    localStorage.removeItem('bingo_token');
    localStorage.removeItem('bingo_user');
    window.location.reload();
}

const loginBtn = document.getElementById('do-login');
if (loginBtn) {
    loginBtn.onclick = async () => {
        const phone = document.getElementById('login-phone').value;
        const password = document.getElementById('login-pass').value;
        const errorEl = document.getElementById('auth-error-login');

        if (!phone || !password) {
            if (errorEl) errorEl.innerText = "እባክዎ ሁሉንም መረጃዎች ያስገቡ";
            return;
        }

        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, password })
            });
            const data = await res.json();
            if (res.ok) {
                localStorage.setItem('bingo_token', data.token);
                localStorage.setItem('bingo_user', JSON.stringify(data));
                window.location.reload();
            } else {
                if (errorEl) errorEl.innerText = data.error || "የመግቢያ ስህተት";
            }
        } catch (err) {
            if (errorEl) errorEl.innerText = "ከሰርቨር ጋር መገናኘት አልተቻለም";
        }
    };
}

window.showSignup = () => {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('signup-form').style.display = 'block';
    document.getElementById('otp-form').style.display = 'none';
};

window.showLogin = () => {
    document.getElementById('signup-form').style.display = 'none';
    document.getElementById('otp-form').style.display = 'none';
    document.getElementById('login-form').style.display = 'block';
};

const doSignupBtn = document.getElementById('do-signup');
if (doSignupBtn) {
    doSignupBtn.onclick = async () => {
        const name = document.getElementById('signup-name').value;
        const phone = document.getElementById('signup-phone').value;
        const telegram_chat_id = document.getElementById('signup-telegram').value;
        const password = document.getElementById('signup-pass').value;
        const errorEl = document.getElementById('auth-error-signup');

        if (!name || !phone || !telegram_chat_id || !password) {
            if (errorEl) errorEl.innerText = "እባክዎ ሁሉንም መረጃዎች ያስገቡ";
            return;
        }

        try {
            const res = await fetch('/api/signup-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telegram_chat_id })
            });
            const data = await res.json();
            if (res.ok) {
                document.getElementById('signup-form').style.display = 'none';
                document.getElementById('otp-form').style.display = 'block';
                const hint = document.getElementById('otp-hint');
                if (hint) hint.innerText = `OTP ወደ ቴሌግራም (${telegram_chat_id}) ተልኳል`;
                window.signupTempData = { name, phone, telegram_chat_id, password };
            } else {
                if (errorEl) errorEl.innerText = data.error || "የምዝገባ ጥያቄ ስህተት";
            }
        } catch (err) {
            if (errorEl) errorEl.innerText = "ከሰርቨር ጋር መገናኘት አልተቻለም";
        }
    };
}

const verifyOtpBtn = document.getElementById('verify-otp');
if (verifyOtpBtn) {
    verifyOtpBtn.onclick = async () => {
        const otp = document.getElementById('otp-code').value;
        const errorEl = document.getElementById('auth-error-otp');
        const signupData = window.signupTempData;

        if (!otp) {
            if (errorEl) errorEl.innerText = "እባክዎ የኦቲፒ ኮዱን ያስገቡ";
            return;
        }
        if (!signupData) {
            if (errorEl) errorEl.innerText = "የምዝገባ መረጃ አልተገኘም፣ እባክዎ እንደገና ይሞክሩ";
            return;
        }

        try {
            const res = await fetch('/api/signup-verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...signupData, otp })
            });
            const data = await res.json();
            if (res.ok) {
                localStorage.setItem('bingo_token', data.token);
                localStorage.setItem('bingo_user', JSON.stringify(data));
                window.location.reload();
            } else {
                if (errorEl) errorEl.innerText = data.error || "የማረጋገጫ ስህተት";
            }
        } catch (err) {
            if (errorEl) errorEl.innerText = "ከሰርቨር ጋር መገናኘት አልተቻለም";
        }
    };
}

// Initialize App
window.showCardSelection = (stake, name, price) => {
    currentRoom = stake;
    document.getElementById('selection-room-name').innerText = name;
    document.getElementById('card-selection-screen').style.display = 'flex';
    createAvailableCards();
};

function initApp() {
    const token = localStorage.getItem("bingo_token");
    if (token) {
        // Start global stats sync
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "AUTH", token }));
        } else {
            socket.onopen = () => {
                socket.send(JSON.stringify({ type: "AUTH", token }));
            };
        }
    }
}


// Auth State Check
window.onload = () => {
    const token = localStorage.getItem('bingo_token');
    const userJson = localStorage.getItem('bingo_user');
    
    if (token && userJson) {
        const user = JSON.parse(userJson);
        document.getElementById('auth-screen').classList.remove('active');
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';
        
        // Update UI with user info
        const usernameEls = ['username', 'stake-username', 'profile-username-top', 'sel-username'];
        usernameEls.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerText = user.username || user.name || "User";
        });
        
        const profileName = document.getElementById('profile-full-name');
        if (profileName) profileName.innerText = user.name || user.username;
        
        const profileId = document.getElementById('profile-player-id');
        if (profileId) profileId.innerText = `ID: ${user.player_id || '--'}`;
        
        const profilePhone = document.getElementById('profile-phone-number');
        if (profilePhone) profilePhone.innerText = user.phone_number || '--';

        // Start global stats sync
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'AUTH', token }));
        } else {
            socket.onopen = () => {
                socket.send(JSON.stringify({ type: 'AUTH', token }));
            };
        }
        
        // Initial nav
        navTo('stake');
    }
    
    createBingoNumbers();
};

function getBallLetter(num) {
    if (num <= 15) return 'B';
    if (num <= 30) return 'I';
    if (num <= 45) return 'N';
    if (num <= 60) return 'G';
    return 'O';
}

let autoMarking = true;
const autoToggle = document.getElementById('auto-toggle');
if (autoToggle) {
    autoToggle.classList.add('active');
    autoToggle.onclick = () => {
        autoMarking = !autoMarking;
        autoToggle.classList.toggle('active', autoMarking);
    };
}

function renderMyGameCard() {
    const bingoBoard = document.getElementById('bingo-board');
    const state = getRoomState(currentRoom);
    if (!bingoBoard || !state.myGameCard) return;
    bingoBoard.innerHTML = '';
    const cardLabel = document.getElementById('my-card-label');
    if (cardLabel && state.currentSelectedCard) cardLabel.innerText = `የእርስዎ ካርድ #${state.currentSelectedCard}`;
    const cardData = JSON.parse(JSON.stringify(state.myGameCard));
    cardData['N'][2] = 'FREE';
    const letters = ['B', 'I', 'N', 'G', 'O'];
    letters.forEach(l => {
        const header = document.createElement('div');
        header.className = 'bingo-cell card-header-cell';
        header.innerText = l;
        bingoBoard.appendChild(header);
    });
    for (let row = 0; row < 5; row++) {
        letters.forEach(l => {
            const val = cardData[l][row];
            const cell = document.createElement('div');
            cell.className = 'bingo-cell';
            if (val === 'FREE') {
                cell.classList.add('free-spot', 'called');
                cell.innerText = 'FREE';
            } else {
                cell.id = `cell-${val}`;
                cell.innerText = val;
                cell.onclick = () => { if (!autoMarking) cell.classList.toggle('called'); };
            }
            bingoBoard.appendChild(cell);
        });
    }
}

function updateGameUI(history) {
    const state = getRoomState(currentRoom);
    state.lastHistory = history;
    const counts = { B: 0, I: 0, N: 0, G: 0, O: 0 };
    history.forEach(n => { counts[getBallLetter(n)]++; });
    Object.keys(counts).forEach(l => {
        const el = document.querySelector(`.h-${l}`);
        if (el) el.setAttribute('data-count', counts[l]);
    });
    const masterGrid = document.getElementById('master-grid');
    if (masterGrid) {
        masterGrid.innerHTML = '';
        for (let row = 0; row < 15; row++) {
            for (let col = 0; col < 5; col++) {
                const num = (col * 15) + row + 1;
                const cell = document.createElement('div');
                cell.className = 'master-cell';
                cell.innerText = num;
                if (history.includes(num)) {
                    cell.classList.add('called');
                    if (num === history[history.length - 1]) cell.classList.add('last-called');
                }
                masterGrid.appendChild(cell);
            }
        }
    }
    
    // Update top bar stats (Derash, Players, Bet)
    const derashEl = document.getElementById('derash');
    const playersEl = document.getElementById('players');
    const betEl = document.getElementById('bet');
    
    if (currentRoom) {
        if (derashEl && globalPrizes[currentRoom]) derashEl.innerText = globalPrizes[currentRoom].toFixed(0);
        if (playersEl && globalStats[currentRoom]) playersEl.innerText = globalStats[currentRoom];
        if (betEl) betEl.innerText = currentRoom;
    }

    if (history.length === 0) {
        activeBall.innerHTML = '<span>--</span>';
        recentBalls.innerHTML = '';
        if (state.myGameCard) renderMyGameCard();
        return;
    }
    const lastBall = history[history.length - 1];
    const letter = getBallLetter(lastBall);
    activeBall.innerHTML = `<span>${letter}${lastBall}</span>`;
    
    // Sync top bar stats on every UI update if global data exists
    if (currentRoom) {
        const derashEl = document.getElementById('derash');
        const playersEl = document.getElementById('players');
        const betEl = document.getElementById('bet');
        
        if (derashEl && globalPrizes[currentRoom]) derashEl.innerText = globalPrizes[currentRoom].toFixed(0);
        if (playersEl && globalStats[currentRoom]) playersEl.innerText = globalStats[currentRoom];
        if (betEl) betEl.innerText = currentRoom;
    }

    if (autoMarking) {
        history.forEach(num => {
            const el = document.getElementById(`cell-${num}`);
            if (el) el.classList.add('called');
        });
    }
    const callsEl = document.getElementById('call-count');
    if (callsEl) callsEl.innerText = history.length;
    progressText.innerText = `${history.length}/75`;
    progressBar.style.width = `${(history.length / 75) * 100}%`;
    const recent = history.slice(-4, -1).reverse();
    recentBalls.innerHTML = recent.map(n => {
        const l = getBallLetter(n);
        return `<div class="hist-ball" style="background: ${colors[l]}">${l}${n}</div>`;
    }).join('');
}

const previewOverlay = document.getElementById('preview-overlay');
const modalCardContent = document.getElementById('modal-card-content');
const previewCardNumber = document.getElementById('preview-card-number');
const closePreview = document.getElementById('close-preview');
const rejectCard = document.getElementById('reject-card');
const confirmCard = document.getElementById('confirm-card');

function showCustomAlert(title, message, imageType = 'low_balance') {
    const alertOverlay = document.getElementById('custom-alert');
    const alertTitle = document.getElementById('alert-title');
    const alertMsg = document.getElementById('alert-msg');
    const alertImg = document.getElementById('alert-img');
    
    if (!alertOverlay || !alertTitle || !alertMsg || !alertImg) return;
    
    alertTitle.innerText = title;
    alertMsg.innerText = message;
    alertImg.src = `static/images/${imageType}.png`;
    
    alertOverlay.classList.add('active');
}

window.closeCustomAlert = function() {
    const alertOverlay = document.getElementById('custom-alert');
    if (alertOverlay) alertOverlay.classList.remove('active');
};

window.manualRefreshBalance = async function() {
    const btn = document.querySelector('.refresh-btn-wallet');
    if (btn) {
        btn.style.animation = 'spin 1s linear infinite';
        btn.disabled = true;
    }
    
    try {
        const token = localStorage.getItem('bingo_token');
        const response = await fetch('/api/user/balance', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        if (data.balance !== undefined) {
            userBalance = data.balance;
            const balanceEl = document.getElementById('sel-balance');
            const walletBalanceEl = document.getElementById('wallet-balance-value');
            const indexBalanceEl = document.getElementById('walletBalance');
            const withdrawBalanceEl = document.getElementById('withdraw-balance-value');
            
            if (balanceEl) balanceEl.innerText = userBalance.toFixed(2);
            if (walletBalanceEl) walletBalanceEl.innerText = userBalance.toFixed(2);
            if (indexBalanceEl) indexBalanceEl.innerText = userBalance.toFixed(2);
            if (withdrawBalanceEl) withdrawBalanceEl.innerText = userBalance.toFixed(2);
            
            showToast("ባላንስ ታድሷል (Balance Refreshed)");
        }
    } catch (e) {
        console.error("Balance refresh failed", e);
        showToast("ማደስ አልተቻለም (Refresh Failed)");
    } finally {
        if (btn) {
            btn.style.animation = 'none';
            btn.disabled = false;
        }
    }
};

function showCardPreview(num) {
    if (userBalance < currentRoom) {
        showCustomAlert("ባላንስ የሎትም", "ይቅርታ፣ ካርድ ለመግዛት በቂ ብር የለዎትም። እባክዎ መጀመሪያ አካውንትዎን ይሙሉ።", "low_balance");
        return;
    }
    const state = getRoomState(currentRoom);
    state.currentSelectedCard = num;
    state.currentCardData = getCardById(num);
    previewCardNumber.innerText = `Card #${num}`;
    modalCardContent.innerHTML = '';
    
    // Add character to preview
    const charHeader = document.createElement('div');
    charHeader.className = 'preview-character-header';
    charHeader.innerHTML = `
        <img src="static/images/card_confirm.png" alt="Confirm">
        <span style="font-size: 0.9rem; color: var(--text-muted); font-weight: 600;">ይህንን ካርድ መርጠዋል</span>
    `;
    modalCardContent.appendChild(charHeader);
    
    modalCardContent.appendChild(createCardPreview(state.currentCardData));
    previewOverlay.classList.add('active');
}

function createCardPreview(cardData) {
    const container = document.createElement('div');
    container.className = 'card-preview';
    const letters = ['B', 'I', 'N', 'G', 'O'];
    letters.forEach(l => {
        const header = document.createElement('div');
        header.className = 'preview-header';
        header.innerText = l;
        container.appendChild(header);
    });
    for (let row = 0; row < 5; row++) {
        letters.forEach(l => {
            const cell = document.createElement('div');
            cell.className = 'preview-cell';
            if (cardData[l][row] === 'FREE') cell.classList.add('free-spot');
            cell.innerText = cardData[l][row];
            container.appendChild(cell);
        });
    }
    return container;
}

if (closePreview) {
    closePreview.onclick = () => {
        previewOverlay.classList.remove('active');
        const state = getRoomState(currentRoom);
        state.currentSelectedCard = null;
        state.currentCardData = null;
    };
}

if (rejectCard) {
    rejectCard.onclick = () => {
        previewOverlay.classList.remove('active');
        const state = getRoomState(currentRoom);
        state.currentSelectedCard = null;
        state.currentCardData = null;
    };
}

if (confirmCard) {
    confirmCard.onclick = () => {
        const state = getRoomState(currentRoom);
        if (!state.currentSelectedCard || !state.currentCardData) return;
        state.myGameCard = state.currentCardData;
        socket.send(JSON.stringify({ 
            type: 'BUY_CARD', 
            room: currentRoom,
            cardNumber: state.currentSelectedCard, 
            cardData: state.currentCardData 
        }));
        const myBoardLabel = document.getElementById('sel-my-board');
        if (myBoardLabel) myBoardLabel.innerText = `#${state.currentSelectedCard}`;
        previewOverlay.classList.remove('active');
    };
}

function createStakeList() {
    const list = document.getElementById('stake-list');
    if (!list) return;
    list.innerHTML = '';
    STAKES.forEach(amount => {
        const row = document.createElement('div');
        row.className = 'stake-row';
        row.innerHTML = `
            <div class="stake-amount">${amount} ETB</div>
            <div class="stake-info">
                <div class="stake-players" id="stake-count-${amount}">0 Players</div>
                <div class="stake-timer" id="stake-timer-${amount}">⏰ 0:30</div>
                <div class="stake-prize" id="stake-prize-${amount}" style="font-size: 0.85rem; color: #22c55e; font-weight: bold; display: none; margin-top: 4px;">Prize: 0.00 ETB</div>
            </div>
            <button class="join-btn" onclick="joinStake(${amount})">JOIN</button>
        `;
        list.appendChild(row);
    });
}

window.joinStake = (amount) => {
    currentRoom = amount;
    const token = localStorage.getItem('bingo_token');
    socket.send(JSON.stringify({ type: 'JOIN_ROOM', room: amount, token: token }));
    const stakeLabel = document.getElementById('sel-stake-amount');
    if (stakeLabel) stakeLabel.innerText = `${amount} ETB`;
    const screens = ['stake-screen', 'profile-screen', 'wallet-screen', 'game-screen'];
    screens.forEach(s => {
        const el = document.getElementById(s);
        if (el) el.classList.remove('active');
    });
    const selectionScreen = document.getElementById('selection-screen');
    if (selectionScreen) selectionScreen.classList.add('active');
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.style.display = 'block';
};

window.showCardSelection = (stake, name, price) => {
    currentRoom = stake;
    document.getElementById('selection-room-name').innerText = name;
    document.getElementById('card-selection-screen').style.display = 'flex';
    createAvailableCards();
};

function initApp() {
    createBingoNumbers();
    createStakeList();
    createAvailableCards();

    const token = localStorage.getItem('bingo_token');
    if (token) {
        const gameScreen = document.getElementById('game-screen');
        if (gameScreen) {
            gameScreen.style.display = 'block';
            gameScreen.classList.add('active');
        }
        navTo('stake');
    }

    const menuTriggers = document.querySelectorAll('.menu-trigger');
    const sideMenu = document.getElementById('side-menu');
    const overlay = document.getElementById('menu-overlay');
    const closeBtn = document.getElementById('close-menu');
    const menuLogo = document.getElementById('menu-logo-trigger');

    let clickCount = 0;
    let lastClickTime = 0;

    if (menuLogo) {
        menuLogo.onclick = () => {
            const now = Date.now();
            if (now - lastClickTime > 2000) {
                clickCount = 1;
            } else {
                clickCount++;
            }
            lastClickTime = now;

            if (clickCount === 3) {
                clickCount = 0;
                promptAdminPassword();
            }
        };
    }

    menuTriggers.forEach(btn => {
        btn.onclick = () => {
            if (sideMenu) sideMenu.classList.add('active');
            if (overlay) overlay.classList.add('active');
        };
    });

    if (closeBtn) {
        closeBtn.onclick = () => {
            if (sideMenu) sideMenu.classList.remove('active');
            if (overlay) overlay.classList.remove('active');
        };
    }

    if (overlay) {
        overlay.onclick = () => {
            if (sideMenu) sideMenu.classList.remove('active');
            if (overlay) overlay.classList.remove('active');
        };
    }
}

let userBalance = 0;

function updateUserData(data) {
    userBalance = parseFloat(data.balance);
    const balanceElements = [
        document.getElementById('sel-balance'),
        document.getElementById('wallet-balance-value'),
        document.getElementById('withdraw-balance-value'),
        document.getElementById('walletBalance')
    ];
    
    balanceElements.forEach(el => {
        if (el) el.innerText = userBalance.toFixed(2);
    });

    const profilePhoneEl = document.getElementById('profile-phone-number');
    const profileUserTop = document.getElementById('profile-username-top');
    const stakeUserTop = document.getElementById('stake-username');
    
    if(profilePhoneEl) profilePhoneEl.innerText = data.telegram_chat_id || data.phone_number || data.username;
    if(profileUserTop) profileUserTop.innerText = data.name || data.username;
    if(stakeUserTop) stakeUserTop.innerText = data.name || data.username;
    
    const profileFullName = document.getElementById('profile-full-name');
    if (profileFullName) profileFullName.innerText = data.name || 'User';
    const profileId = document.getElementById('profile-player-id');
    if (profileId) profileId.innerText = `ID: ${data.player_id || '--'}`;
}

function startGame() {
    navTo('game');
    const state = getRoomState(currentRoom);
    state.myGameCard = state.currentCardData;
    renderMyGameCard();
}

function navTo(screenId) {
    const screens = ['stake-screen', 'profile-screen', 'wallet-screen', 'game-screen', 'selection-screen', 'admin-screen', 'deposit-screen', 'withdraw-screen'];
    screens.forEach(s => {
        const el = document.getElementById(s);
        if (el) el.classList.remove('active');
    });
    
    const target = document.getElementById(`${screenId}-screen`);
    if (target) target.classList.add('active');
    
    if (screenId === 'profile') loadProfileData();
    if (screenId === 'wallet') loadBalanceHistory();

    const sideMenu = document.getElementById('side-menu');
    const overlay = document.getElementById('menu-overlay');
    if (sideMenu) sideMenu.classList.remove('active');
    if (overlay) overlay.classList.remove('active');
}

async function loadBalanceHistory() {
    const token = localStorage.getItem('bingo_token');
    const listEl = document.getElementById('balance-history-list');
    if (!listEl) return;
    
    try {
        const res = await fetch('/api/user/balance-history', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const history = await res.json();
        
        if (!res.ok) throw new Error(history.error);
        
        if (history.length === 0) {
            listEl.innerHTML = '<p class="empty-msg">No transactions yet.</p>';
            return;
        }
        
        listEl.innerHTML = history.map(h => `
            <div class="history-item">
                <div class="hist-main">
                    <span class="hist-type ${h.type.toLowerCase()}">${h.type.toUpperCase()}</span>
                    <span class="hist-desc">${h.description || ''}</span>
                </div>
                <div class="hist-meta">
                    <span class="hist-amount ${h.amount > 0 ? 'plus' : 'minus'}">
                        ${h.amount > 0 ? '+' : ''}${parseFloat(h.amount).toFixed(2)}
                    </span>
                    <span class="hist-date">${new Date(h.created_at).toLocaleString()}</span>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.error("History load error:", e);
        listEl.innerHTML = '<p class="empty-msg">Error loading history.</p>';
    }
}


function promptAdminPassword() {
    const pass = prompt("አድሚን ፓስወርድ ያስገቡ:");
    if (pass === "fidel123") {
        navTo('admin');
    } else {
        alert("የተሳሳተ ፓስወርድ!");
    }
}
window.promptAdminPassword = promptAdminPassword;

const submitWithdraw = document.getElementById('submit-withdraw');
if (submitWithdraw) {
    submitWithdraw.onclick = async () => {
        const amount = parseFloat(document.getElementById('withdraw-amount').value);
        const method = document.getElementById('withdraw-method').value;
        const account = document.getElementById('withdraw-account').value;
        const statusEl = document.getElementById('withdraw-status');
        const token = localStorage.getItem('bingo_token');

        if (isNaN(amount) || amount < 50) return alert("Minimum withdrawal is 50 ETB");
        if (!account) return alert("Please enter account details");

        try {
            const res = await fetch('/api/withdraw-request', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ amount, method, account })
            });
            const data = await res.json();
            statusEl.innerText = data.message || data.error;
            if (res.ok) {
                userBalance -= amount;
                updateUserData({ balance: userBalance });
            }
        } catch (e) { console.error(e); }
    };
}

// Admin UI Switcher
window.switchAdminTab = (tab) => {
    document.querySelectorAll('.admin-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(`admin-${tab}-tab`).classList.add('active');
    event.target.classList.add('active');
    
    if (tab === 'deposits') fetchAdminDeposits();
    if (tab === 'withdrawals') fetchAdminWithdrawals();
};

async function fetchAdminDeposits() {
    const token = localStorage.getItem('bingo_token');
    const listEl = document.getElementById('admin-deposits-list');
    try {
        const res = await fetch('/api/admin/deposits', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const deposits = await res.json();
        if (deposits.length === 0) {
            listEl.innerHTML = '<p class="empty-msg">No pending deposit requests.</p>';
            return;
        }
        listEl.innerHTML = deposits.map(d => `
            <div class="deposit-card">
                <p><strong>${d.name} (${d.phone_number})</strong></p>
                <p>Amount: ${d.amount} ETB | Method: ${d.method}</p>
                <p>Code: <small>${d.transaction_code}</small></p>
                <div class="btn-group">
                    <button onclick="handleDeposit('${d.id}', 'approve')" class="balance-btn add">Approve</button>
                    <button onclick="handleDeposit('${d.id}', 'reject')" class="balance-btn sub">Reject</button>
                </div>
            </div>
        `).join('');
    } catch (e) { console.error(e); }
}

async function fetchAdminWithdrawals() {
    const token = localStorage.getItem('bingo_token');
    const listEl = document.getElementById('admin-withdrawals-list');
    try {
        const res = await fetch('/api/admin/withdrawals', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const withdrawals = await res.json();
        if (withdrawals.length === 0) {
            listEl.innerHTML = '<p class="empty-msg">No pending withdrawal requests.</p>';
            return;
        }
        listEl.innerHTML = withdrawals.map(w => `
            <div class="deposit-card">
                <p><strong>${w.name} (${w.phone_number})</strong></p>
                <p>Amount: ${w.amount} ETB | Method: ${w.method}</p>
                <p>Account: ${w.account_details}</p>
                <div class="btn-group">
                    <button onclick="handleWithdraw('${w.id}', 'approve')" class="balance-btn add">Approve</button>
                    <button onclick="handleWithdraw('${w.id}', 'reject')" class="balance-btn sub">Reject</button>
                </div>
            </div>
        `).join('');
    } catch (e) { console.error(e); }
}

window.handleDeposit = async (id, action) => {
    const token = localStorage.getItem('bingo_token');
    const endpoint = action === 'approve' ? '/api/admin/approve-deposit' : '/api/admin/reject-deposit';
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ depositId: id })
        });
        const data = await res.json();
        alert(data.message || data.error);
        fetchAdminDeposits();
    } catch (e) { console.error(e); }
};

window.handleWithdraw = async (id, action) => {
    const token = localStorage.getItem('bingo_token');
    try {
        const res = await fetch('/api/admin/handle-withdraw', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ withdrawId: id, action })
        });
        const data = await res.json();
        alert(data.message || data.error);
        fetchAdminWithdrawals();
    } catch (e) { console.error(e); }
};

// User Search & Balance Update
const adminSearchBtn = document.getElementById('admin-search-btn');
if (adminSearchBtn) {
    adminSearchBtn.onclick = async () => {
        const phone = document.getElementById('admin-search-phone').value;
        const token = localStorage.getItem('bingo_token');
        try {
            const res = await fetch(`/api/admin/user/${phone}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const user = await res.json();
            if (res.ok) {
                document.getElementById('admin-user-result').style.display = 'block';
                document.getElementById('admin-user-name').innerText = user.name;
                document.getElementById('admin-user-phone').innerText = user.phone_number;
                document.getElementById('admin-user-balance').innerText = user.balance;
                const roleEl = document.getElementById('admin-user-role');
                if (roleEl) roleEl.innerText = user.is_admin ? "ROLE: ADMIN" : "ROLE: USER";
                
                const promoteBtn = document.getElementById('admin-promote-btn');
                if (promoteBtn) promoteBtn.style.display = user.is_admin ? 'none' : 'block';
                
                window.currentAdminUser = user;
            } else {
                alert(user.error);
            }
        } catch (e) { console.error(e); }
    };
}

const addBalanceBtn = document.getElementById('admin-add-balance');
if (addBalanceBtn) {
    addBalanceBtn.onclick = () => updateBalance(true);
}
const subBalanceBtn = document.getElementById('admin-sub-balance');
if (subBalanceBtn) {
    subBalanceBtn.onclick = () => updateBalance(false);
}

async function updateBalance(isAdd) {
    const amount = parseFloat(document.getElementById('admin-balance-amount').value);
    if (isNaN(amount)) return alert("መጠን ያስገቡ");
    const token = localStorage.getItem('bingo_token');
    const user = window.currentAdminUser;
    if (!user) return;

    const newBalance = isAdd ? (parseFloat(user.balance) + amount) : (parseFloat(user.balance) - amount);
    try {
        const res = await fetch('/api/admin/update-balance', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ phone: user.phone_number, balance: newBalance })
        });
        const data = await res.json();
        if (res.ok) {
            document.getElementById('admin-user-balance').innerText = newBalance;
            window.currentAdminUser.balance = newBalance;
            alert("ባላንስ ተስተካክሏል");
        } else {
            alert(data.error);
        }
    } catch (e) { console.error(e); }
}

const promoteUserBtn = document.getElementById('admin-promote-btn');
if (promoteUserBtn) {
    promoteUserBtn.onclick = async () => {
        const user = window.currentAdminUser;
        if (!user) return;
        if (!confirm(`${user.name}ን አድሚን ማድረግ ይፈልጋሉ?`)) return;
        
        const token = localStorage.getItem('bingo_token');
        try {
            const res = await fetch('/api/admin/promote-user', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}` 
                },
                body: JSON.stringify({ targetPhone: user.phone_number })
            });
            const data = await res.json();
            alert(data.message || data.error);
            if (res.ok) {
                document.getElementById('admin-promote-btn').style.display = 'none';
                document.getElementById('admin-user-role').innerText = "ROLE: ADMIN";
            }
        } catch (e) { console.error(e); }
    };
}

const sendBroadcastBtn = document.getElementById('send-broadcast');
if (sendBroadcastBtn) {
    sendBroadcastBtn.onclick = async () => {
        const message = document.getElementById('broadcast-message').value;
        if (!message) return alert("መልዕክት ያስገቡ");
        const token = localStorage.getItem('bingo_token');
        try {
            const res = await fetch('/api/admin/broadcast', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}` 
                },
                body: JSON.stringify({ message })
            });
            const data = await res.json();
            alert(data.message || data.error);
        } catch (e) { console.error(e); }
    };
}

initApp();