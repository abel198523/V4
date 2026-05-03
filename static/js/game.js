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

// ================================================================
// ROOM STATUS SYSTEM v4 — Card Threshold based.
// No countdown timer. Game launches when enough cards are purchased.
// status: 'waiting' | 'launching' | 'playing'
// ================================================================

let _timerPollId = null;
let _prevRoomStatus = {}; // stakeStr -> { status }
let _gameStarted = {};    // stake -> bool, prevent duplicate startGame calls
let _gameStartCDActive = false; // prevent overlapping 3-2-1 overlays
let _lastLaunchTick = -1; // last launch_timer value we played a tick for

function startTimerSystem() {
    if (_timerPollId) clearInterval(_timerPollId);
    _syncTimers();
    _timerPollId = setInterval(_syncTimers, 1000);
}

function stopTimerSystem() {
    if (_timerPollId) { clearInterval(_timerPollId); _timerPollId = null; }
}

async function _syncTimers() {
    try {
        const res = await fetch('/api/room-status');
        if (!res.ok) return;
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) return;
        const data = await res.json();

        for (const [stakeStr, info] of Object.entries(data)) {
            const stake = parseInt(stakeStr);
            const prev  = _prevRoomStatus[stakeStr] || {};

            // ── Stake-list card count badge ───────────────────────────────
            const countEl = document.getElementById(`stake-count-${stake}`);
            if (countEl) {
                const n   = info.cards_count || 0;
                const min = info.min_cards   || 5;
                if (info.status === 'playing') {
                    countEl.innerText  = `${n} Cards in Game`;
                    countEl.style.color = '#22c55e';
                } else if (info.status === 'launching') {
                    countEl.innerText  = `✅ ${n}/${min} — Launching in ${info.launch_timer}s`;
                    countEl.style.color = '#f59e0b';
                } else {
                    const need = Math.max(0, min - n);
                    countEl.innerText  = need > 0
                        ? `⏳ Need ${need} more card${need > 1 ? 's' : ''} (${n}/${min})`
                        : `✅ ${n}/${min} Cards — Ready!`;
                    countEl.style.color = need > 0 ? '#94a3b8' : '#22c55e';
                }
                countEl.style.fontWeight = 'bold';
            }

            // ── Stake-list status badge ───────────────────────────────────
            const badge = document.getElementById(`stake-timer-${stake}`);
            if (badge) {
                if (info.status === 'playing') {
                    badge.innerText = '🎮 PLAYING';
                    badge.style.color = '#22c55e';
                    badge.style.background = 'rgba(34,197,94,0.1)';
                } else if (info.status === 'launching') {
                    badge.innerText = `🚀 ${info.launch_timer}s`;
                    badge.style.color = '#f59e0b';
                    badge.style.background = 'rgba(245,158,11,0.1)';
                } else {
                    badge.innerText = '⏳ Waiting';
                    badge.style.color = '#64748b';
                    badge.style.background = 'rgba(100,116,139,0.1)';
                }
            }

            // ── Stake-list prize pool badge ───────────────────────────────
            const prizeEl = document.getElementById(`stake-prize-${stake}`);
            if (prizeEl) {
                const pool = info.prize_pool || 0;
                prizeEl.innerText = `🏆 Prize Pool: ${pool.toFixed(2)} ETB`;
                prizeEl.style.color = pool > 0 ? '#f59e0b' : '#6b7280';
                prizeEl.style.fontWeight = pool > 0 ? 'bold' : 'normal';
            }

            // ── Card Fill Panel (selection screen, current room only) ─────
            if (currentRoom == stake) {
                _updateCardFillPanel(info);
            }

            // ── Screen transitions ────────────────────────────────────────
            // launching → playing
            if (prev.status !== 'playing' && info.status === 'playing') {
                _gameStarted[stake] = true;
                if (currentRoom == stake) _showGameStartCountdown(startGame);
            }

            // Safety net: already playing but stuck on selection screen
            if (info.status === 'playing' && currentRoom == stake && !_gameStarted[stake]) {
                const sel = document.getElementById('selection-screen');
                if (sel && sel.classList.contains('active')) {
                    _gameStarted[stake] = true;
                    _showGameStartCountdown(startGame);
                }
            }

            // playing → waiting/launching → return to selection
            if (prev.status === 'playing' && info.status !== 'playing') {
                _gameStarted[stake] = false;
                if (currentRoom == stake) handleGameOverReturn(stake);
            }

            // ── Live game screen stats ────────────────────────────────────
            if (info.status === 'playing' && currentRoom == stake) {
                const derashEl  = document.getElementById('derash');
                const playersEl = document.getElementById('players');
                if (derashEl)  derashEl.innerText  = (info.prize_pool || 0).toFixed(0);
                if (playersEl) playersEl.innerText = info.cards_count || 0;
            }

            _prevRoomStatus[stakeStr] = { status: info.status };
        }
    } catch (e) { console.error('[Status] _syncTimers error:', e); }
}

// ── Card Fill Panel renderer ──────────────────────────────────────────────────
function _updateCardFillPanel(info) {
    const n   = info.cards_count  || 0;
    const min = info.min_cards    || 5;
    const lt  = info.launch_timer || 0;
    const maxLaunch = info.launch_countdown || 10;

    const iconEl       = document.getElementById('cfp-icon');
    const labelEl      = document.getElementById('cfp-label');
    const currentEl    = document.getElementById('cfp-current');
    const minEl        = document.getElementById('cfp-min');
    const barEl        = document.getElementById('cfp-bar');
    const launchWrap   = document.getElementById('cfp-launch-wrap');
    const launchNumEl  = document.getElementById('cfp-launch-num');
    const prizePoolEl  = document.getElementById('sel-prize-pool');

    if (currentEl) currentEl.innerText = n;
    if (minEl)     minEl.innerText     = min;

    // Prize pool in info bar
    if (prizePoolEl) {
        const pool = info.prize_pool || 0;
        prizePoolEl.innerText = `${pool.toFixed(0)} ETB`;
        prizePoolEl.style.color = pool > 0 ? '#f59e0b' : '#94a3b8';
    }

    if (info.status === 'playing') {
        if (iconEl)  iconEl.innerText  = '🎮';
        if (labelEl) labelEl.innerText = 'ጨዋታ በሂደት ላይ ነው!';
        if (barEl)   { barEl.style.width = '100%'; barEl.style.background = '#22c55e'; }
        if (launchWrap) launchWrap.style.display = 'none';

    } else if (info.status === 'launching') {
        if (iconEl)  iconEl.innerText  = '🚀';
        if (labelEl) labelEl.innerText = 'ዝግጁ! ጨዋታ ይጀምራል!';
        if (barEl)   { barEl.style.width = '100%'; barEl.style.background = '#f59e0b'; }
        if (launchWrap) launchWrap.style.display = 'flex';
        if (launchNumEl) {
            launchNumEl.innerText = lt;
            // Pulse animation on change
            launchNumEl.style.animation = 'none';
            void launchNumEl.offsetWidth;
            launchNumEl.style.animation = 'cfp-launch-pop 0.3s ease-out';
        }
        // Tick sounds during launch countdown
        if (lt !== _lastLaunchTick) {
            _lastLaunchTick = lt;
            if (lt <= 3 && lt > 0 && typeof playFinalTick === 'function') playFinalTick();
            else if (lt > 0 && typeof playTick === 'function') playTick();
        }

    } else {
        // waiting
        const pct = Math.min(100, Math.round((n / min) * 100));
        if (iconEl)  iconEl.innerText  = n >= min ? '✅' : '⏳';
        if (labelEl) {
            const need = Math.max(0, min - n);
            labelEl.innerText = need > 0
                ? `ሌሎች ${need} ካርዶች ሲገዙ ጨዋታ ይጀምራል`
                : 'ዝግጁ ነው! ጨዋታ ምልክት ይሰጣል...';
        }
        if (barEl) {
            barEl.style.width      = pct + '%';
            barEl.style.background = n >= min ? '#22c55e' : '#3b82f6';
        }
        if (launchWrap) launchWrap.style.display = 'none';
        _lastLaunchTick = -1;
    }
}

// Legacy no-ops
function updateCountdown(seconds) {}
function _hideUrgencyBanner() {}

// ── 3-2-1 Game Start Countdown Overlay ───────────────
function _showGameStartCountdown(callback) {
    if (_gameStartCDActive) { callback(); return; }
    _gameStartCDActive = true;
    const overlay = document.getElementById('game-start-overlay');
    if (!overlay) { _gameStartCDActive = false; callback(); return; }
    overlay.classList.add('active');
    const numEl = document.getElementById('gso-number');
    const nums = [3, 2, 1];
    let idx = 0;
    function tick() {
        if (idx < nums.length) {
            const n = nums[idx];
            if (numEl) {
                numEl.className = '';
                void numEl.offsetWidth;
                numEl.innerText = n;
                numEl.className = 'gso-num gso-pop';
            }
            if (typeof playCountdownChime === 'function') playCountdownChime(n);
            idx++;
            setTimeout(tick, 900);
        } else {
            if (numEl) {
                numEl.className = '';
                void numEl.offsetWidth;
                numEl.innerText = 'GO!';
                numEl.className = 'gso-num gso-go';
            }
            if (typeof playGoSound === 'function') playGoSound();
            setTimeout(() => {
                overlay.classList.remove('active');
                _gameStartCDActive = false;
                callback();
            }, 650);
        }
    }
    tick();
}

// ── Winning Pattern Helper ────────────────────────────
function getWinningPattern(cardData, calledBalls) {
    if (!cardData || !calledBalls) return [];
    const called = new Set(calledBalls);
    const letters = ['B', 'I', 'N', 'G', 'O'];
    const grid = [];
    for (let row = 0; row < 5; row++) {
        const r = [];
        for (const l of letters) {
            const val = cardData[l][row];
            r.push({ val, hit: val === 'FREE' || called.has(val) });
        }
        grid.push(r);
    }
    for (const row of grid) {
        if (row.every(c => c.hit)) return row.map(c => c.val);
    }
    for (let c = 0; c < 5; c++) {
        if (grid.every(r => r[c].hit)) return grid.map(r => r[c].val);
    }
    if (grid.every((r, i) => r[i].hit)) return grid.map((r, i) => r[i].val);
    if (grid.every((r, i) => r[4 - i].hit)) return grid.map((r, i) => r[4 - i].val);
    return calledBalls;
}

// ── Near-Bingo Calculator ─────────────────────────────
function calcNearBingo(cardData, calledBalls) {
    if (!cardData || !calledBalls) return 99;
    const called = new Set(calledBalls);
    const letters = ['B', 'I', 'N', 'G', 'O'];
    const grid = [];
    for (let row = 0; row < 5; row++) {
        const r = [];
        for (const l of letters) {
            const val = cardData[l][row];
            r.push(val === 'FREE' ? true : called.has(val));
        }
        grid.push(r);
    }
    let min = Infinity;
    for (const row of grid) { min = Math.min(min, row.filter(v => !v).length); }
    for (let c = 0; c < 5; c++) { min = Math.min(min, grid.filter(r => !r[c]).length); }
    min = Math.min(min, grid.filter((r, i) => !r[i]).length);
    min = Math.min(min, grid.filter((r, i) => !r[4 - i]).length);
    return min;
}

async function fetchRoomHistory() {
    const list = document.getElementById('rh-list');
    if (!list) return;
    try {
        const res = await fetch('/api/room-history', { headers: _ah() });
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) {
            list.innerHTML = '<div class="rh-empty">ገና ዙር አልተጫወተም</div>';
            return;
        }
        list.innerHTML = data.map((r, i) => {
            const noWinner = r.winner === '—';
            const winnerHtml = noWinner
                ? `<span class="rh-no-winner">አሸናፊ የለም</span>`
                : `<span class="rh-winner">${r.winner}</span>`;
            const prizeHtml = r.prize > 0
                ? `<span class="rh-prize">${r.prize} ETB</span>`
                : `<span class="rh-prize" style="color:#4b5563;">— ETB</span>`;
            return `<div class="rh-row">
                <span class="rh-rank">#${i + 1}</span>
                ${winnerHtml}
                <span class="rh-cards">${r.cards} ካርድ</span>
                ${prizeHtml}
                <span class="rh-time">${r.created_at}</span>
            </div>`;
        }).join('');
    } catch (e) {
        // silently fail — non-critical
    }
}

function handleGameOverReturn(stake) {
    stopGameStatePoll();
    fetchRoomHistory();
    // Clear game board state for this room
    const state = getRoomState(stake);
    state.myGameCard = null;
    state.currentSelectedCard = null;
    state.currentCardData = null;
    state.purchasedCard = null;
    state.bingoFlashed = false;
    state.lastHistory = [];
    // Reset bingo button
    const btn = document.getElementById('bingo-btn');
    if (btn) {
        btn.style.animation = '';
        btn.style.background = '';
        btn.style.boxShadow = '';
    }

    // Reset near-bingo bar
    const nbBar = document.getElementById('near-bingo-bar');
    if (nbBar) { nbBar.style.display = 'none'; nbBar.className = 'near-bingo-bar'; }

    ['master-grid', 'bingo-board', 'recent-balls'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });
    const ab = document.getElementById('active-ball');
    if (ab) ab.innerHTML = '<span>--</span>';
    const cc = document.getElementById('call-count');
    if (cc) cc.innerText = '0';
    const pt = document.getElementById('progress-text');
    if (pt) pt.innerText = '0/75';
    const pb = document.getElementById('progress-bar');
    if (pb) pb.style.width = '0%';

    // Return to selection screen (countdown already restarted)
    const screens = ['game-screen', 'profile-screen', 'wallet-screen', 'deposit-screen', 'withdraw-screen'];
    screens.forEach(s => {
        const el = document.getElementById(s);
        if (el) el.classList.remove('active');
    });
    const selScreen = document.getElementById('selection-screen');
    if (selScreen) selScreen.classList.add('active');
}

function updateRoomStats(stats, prizes) {
    // Count, prize pool, and timer are all handled live by _syncTimers.
    // This function is kept as a no-op to avoid errors from any remaining callers.
    globalStats = stats || {};
    globalPrizes = prizes || {};
}

// Legacy no-op
function updateCountdown(seconds) {}

const STAKES = [10];

const staticCards = [{"id":1,"data":{"B":[7,10,13,14,15],"I":[18,21,23,29,30],"N":[35,36,"FREE",40,43],"G":[46,47,48,49,56],"O":[65,67,69,70,75]}},{"id":2,"data":{"B":[2,7,11,14,15],"I":[16,18,20,21,25],"N":[31,32,"FREE",39,43],"G":[50,53,56,58,60],"O":[63,66,72,73,74]}},{"id":3,"data":{"B":[2,4,12,13,14],"I":[16,22,24,29,30],"N":[32,33,"FREE",44,45],"G":[47,52,56,59,60],"O":[61,62,64,66,68]}},{"id":4,"data":{"B":[3,6,7,10,13],"I":[16,21,24,26,30],"N":[32,33,"FREE",36,41],"G":[46,48,52,54,59],"O":[63,65,66,72,75]}},{"id":5,"data":{"B":[1,4,7,12,15],"I":[17,19,26,29,30],"N":[31,32,"FREE",36,37],"G":[46,51,52,54,58],"O":[64,68,71,73,74]}},{"id":6,"data":{"B":[3,4,5,6,10],"I":[18,20,25,26,27],"N":[32,34,"FREE",41,45],"G":[48,50,51,53,54],"O":[62,63,65,67,75]}},{"id":7,"data":{"B":[1,2,4,5,6],"I":[17,21,24,27,30],"N":[31,33,"FREE",42,45],"G":[48,49,50,56,57],"O":[67,68,71,73,74]}},{"id":8,"data":{"B":[1,6,7,9,12],"I":[17,19,21,27,28],"N":[31,40,"FREE",42,43],"G":[47,49,50,51,57],"O":[64,65,66,70,74]}},{"id":9,"data":{"B":[3,6,9,12,14],"I":[16,17,20,22,27],"N":[31,37,"FREE",39,40],"G":[49,54,55,57,59],"O":[63,67,69,70,74]}},{"id":10,"data":{"B":[1,5,9,10,15],"I":[23,24,27,29,30],"N":[35,39,"FREE",43,45],"G":[47,52,56,58,59],"O":[62,63,64,67,71]}},{"id":11,"data":{"B":[1,2,6,12,14],"I":[16,18,21,28,30],"N":[31,37,"FREE",41,45],"G":[46,52,54,55,56],"O":[63,68,71,72,73]}},{"id":12,"data":{"B":[1,6,7,12,14],"I":[16,17,18,21,29],"N":[31,33,"FREE",43,45],"G":[46,54,55,56,59],"O":[62,63,65,69,70]}},{"id":13,"data":{"B":[1,6,8,11,15],"I":[16,19,20,22,30],"N":[35,38,"FREE",41,42],"G":[48,51,53,56,58],"O":[68,69,70,73,75]}},{"id":14,"data":{"B":[2,9,11,14,15],"I":[16,21,22,25,29],"N":[35,38,"FREE",41,45],"G":[46,51,52,54,57],"O":[66,67,69,72,75]}},{"id":15,"data":{"B":[5,7,11,12,14],"I":[18,19,22,25,26],"N":[33,41,"FREE",44,45],"G":[46,51,53,54,55],"O":[63,67,70,73,74]}},{"id":16,"data":{"B":[1,7,8,14,15],"I":[17,19,25,27,30],"N":[32,37,"FREE",42,44],"G":[50,52,55,56,58],"O":[61,62,65,69,70]}}];

function getCardById(id) {
    const found = staticCards.find(c => c.id === id);
    return found ? found.data : staticCards[0].data;
}

function refreshCards() {
    const btn = document.querySelector('.sel-refresh-btn');
    if (btn) { btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; }
    createAvailableCards();
    setTimeout(() => {
        if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
    }, 600);
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

function showWinnerModal(name, winCard, winPattern, prize, isMe) {
    const modal = document.getElementById('winner-modal');
    const nameEl = document.getElementById('winner-display-name');
    const cardCont = document.getElementById('winner-card-container');
    const titleEl = document.getElementById('winner-title');
    if (!modal || !nameEl || !cardCont) return;

    if (isMe) {
        if (titleEl) titleEl.innerText = '🏆 አሸነፉ! YOU WIN!';
        nameEl.innerHTML = `<span style="color:#f59e0b;font-size:1.2rem;font-weight:900;">${name}</span>
            <div style="color:#22c55e;font-size:1rem;font-weight:800;margin-top:6px;">+${prize ? prize.toFixed(2) : '0.00'} ETB</div>`;
        // Sync balance
        fetchAndSyncBalance();
    } else {
        if (titleEl) titleEl.innerText = 'WINNER!';
        nameEl.innerHTML = `<span style="color:#f59e0b;">${name}</span>
            <div style="color:#64748b;font-size:0.85rem;margin-top:4px;">Prize: ${prize ? prize.toFixed(2) : '0.00'} ETB</div>`;
    }

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
        createAvailableCards();
        // Timer system handles game/waiting state — no action needed here
    } else if (data.type === 'NEW_BALL') {
        const state = getRoomState(data.room);
        state.lastHistory = data.history;
        if (data.room == currentRoom) updateGameUI(data.history);
    } else if (data.type === 'ERROR') {
        showToast(data.message);
    } else if (data.type === 'ROOM_STATS') {
        if (data.takenCards && data.takenCards[currentRoom]) {
            roomTakenCards = data.takenCards[currentRoom];
            createAvailableCards();
        }
        updateRoomStats(data.stats, data.prizes);
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

// startTimerSystem() is called inside initApp() after createStakeList() builds the DOM elements.

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
        bingoBtn.onclick = async () => {
            const state = getRoomState(currentRoom);
            if (!currentRoom) { showToast("በቅድሚያ ክፍል ይግቡ"); return; }
            if (!state.purchasedCard) { showToast("ካርድ አልተገዛም"); return; }

            bingoBtn.style.transform = 'scale(0.95)';
            setTimeout(() => bingoBtn.style.transform = '', 150);

            try {
                const res = await fetch(`/api/bingo-claim/${currentRoom}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ card_number: state.purchasedCard })
                });
                const data = await res.json();
                if (data.valid) {
                    showToast('🎉 ' + data.message);
                } else {
                    showToast('❌ ' + (data.message || 'ቢንጎ አልሆነም'));
                }
            } catch (e) {
                showToast('❌ ከሰርቨር ጋር አልተገናኘም');
            }
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

// initApp() is defined later and called from window.onload


// Auth State Check — this is the single guaranteed entry point after DOM is fully ready
window.onload = () => {
    const token = localStorage.getItem('bingo_token');
    const userJson = localStorage.getItem('bingo_user');

    if (token && userJson) {
        const user = JSON.parse(userJson);
        const authScreen = document.getElementById('auth-screen');
        const mainContent = document.getElementById('main-content');
        if (authScreen) { authScreen.classList.remove('active'); authScreen.style.display = 'none'; }
        if (mainContent) mainContent.style.display = 'block';

        const usernameEls = ['username', 'stake-username', 'profile-username-top', 'sel-username'];
        usernameEls.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerText = user.username || user.name || 'User';
        });

        const profileName = document.getElementById('profile-full-name');
        if (profileName) profileName.innerText = user.name || user.username;
        const profileId = document.getElementById('profile-player-id');
        if (profileId) profileId.innerText = `ID: ${user.player_id || '--'}`;
        const profilePhone = document.getElementById('profile-phone-number');
        if (profilePhone) profilePhone.innerText = user.phone_number || '--';

        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'AUTH', token }));
        } else {
            socket.onopen = () => socket.send(JSON.stringify({ type: 'AUTH', token }));
        }
    }

    // Always initialise the full app — DOM is guaranteed ready here
    initApp();
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
        const latestBall = history[history.length - 1];
        history.forEach(num => {
            const el = document.getElementById(`cell-${num}`);
            if (el) {
                if (!el.classList.contains('called')) {
                    el.classList.add('called');
                    if (num === latestBall) {
                        el.classList.add('newly-called');
                        setTimeout(() => el.classList.remove('newly-called'), 500);
                        if (typeof playBallCall === 'function') playBallCall();
                    }
                }
            }
        });
    }

    // Near-bingo indicator
    const stateNB = getRoomState(currentRoom);
    if (stateNB.myGameCard && history.length > 0) {
        const remaining = calcNearBingo(stateNB.myGameCard, history);
        const nbBar = document.getElementById('near-bingo-bar');
        if (nbBar) {
            if (remaining === 0) {
                nbBar.style.display = 'none';
            } else if (remaining === 1) {
                nbBar.style.display = 'block';
                nbBar.className = 'near-bingo-bar one-away';
                nbBar.innerText = '🔥 ሌላ 1 ቁጥር — BINGO!';
            } else if (remaining <= 3) {
                nbBar.style.display = 'block';
                nbBar.className = 'near-bingo-bar';
                nbBar.innerText = `⚡ ሌላ ${remaining} ቁጥር ብቻ ቢንጎ!`;
            } else {
                nbBar.style.display = 'none';
            }
        }
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
    if (btn) { btn.style.animation = 'spin 1s linear infinite'; btn.disabled = true; }
    try {
        await fetchAndSyncBalance();
        showToast("ባላንስ ታድሷል ✓");
    } catch (e) {
        showToast("ማደስ አልተቻለም");
    } finally {
        if (btn) { btn.style.animation = 'none'; btn.disabled = false; }
    }
};

async function showCardPreview(num) {
    // Always pull fresh balance from DB before checking
    await fetchAndSyncBalance();
    const roomPrice = getRoomPrice();
    if (userBalance < roomPrice) {
        showCustomAlert("ባላንስ የሎትም", `ይቅርታ፣ ካርድ ለመግዛት ${roomPrice} ETB ያስፈልጋል። ያሎት ባላንስ ${userBalance.toFixed(2)} ETB ነው።`, "low_balance");
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

function getRoomPrice() {
    if (!currentRoom) return 0;
    if (typeof currentRoom === 'number') return currentRoom;
    const parsed = parseFloat(currentRoom);
    return Number.isFinite(parsed) ? parsed : 0;
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
    confirmCard.onclick = async () => {
        const state = getRoomState(currentRoom);
        if (!state.currentSelectedCard || !state.currentCardData) return;

        // Disable button to prevent double-tap
        confirmCard.disabled = true;
        confirmCard.innerText = '⏳ እየተገዛ...';

        try {
            const res = await fetch(
                `/api/buy-card-by-stake/${currentRoom}/${state.currentSelectedCard}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' } }
            );
            const data = await res.json();

            if (data.success) {
                // Commit card to game state
                state.myGameCard = state.currentCardData;
                state.purchasedCard = state.currentSelectedCard;

                // Update balance from server response
                if (typeof data.new_balance === 'number') {
                    userBalance = data.new_balance;
                    ['sel-balance','wallet-balance-value','withdraw-balance-value',
                     'walletBalance','profile-balance'].forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.innerText = userBalance.toFixed(2);
                    });
                    const mw = document.getElementById('sel-main-wallet');
                    const pw = document.getElementById('sel-play-wallet');
                    if (mw) mw.innerText = Math.round(userBalance);
                    if (pw) pw.innerText = Math.round(userBalance);
                }

                // Mark this card taken in the local grid
                if (!roomTakenCards.includes(state.currentSelectedCard)) {
                    roomTakenCards.push(state.currentSelectedCard);
                }
                createAvailableCards();

                // Highlight the owned card in the grid
                const allCardEls = document.querySelectorAll('#cards-grid .card-item');
                allCardEls.forEach(el => el.classList.remove('my-card'));
                allCardEls.forEach(el => {
                    if (parseInt(el.innerText) === state.currentSelectedCard) {
                        el.classList.add('my-card');
                    }
                });

                const myBoardLabel = document.getElementById('sel-my-board');
                if (myBoardLabel) myBoardLabel.innerText = `#${state.currentSelectedCard}`;

                previewOverlay.classList.remove('active');
                showToast(`✅ ካርድ #${state.currentSelectedCard} ተገዝቷል!`);
            } else {
                showToast(`❌ ${data.message || 'ካርዱ ሊገዛ አልተቻለም'}`);
                previewOverlay.classList.remove('active');
            }
        } catch (e) {
            showToast('❌ ግንኙነት ተሳስቷል። እባክዎ ዳግም ሞክሩ።');
        } finally {
            confirmCard.disabled = false;
            confirmCard.innerText = '✓ ግዛ / Buy';
        }
    };
}

function createStakeList() {
    const list = document.getElementById('stake-list');
    if (!list) return;
    list.innerHTML = '';
    STAKES.forEach(amount => {
        const row = document.createElement('div');
        row.className = 'stake-row premium';
        row.innerHTML = `
            <div class="stake-badge">${amount} ETB</div>
            <div class="stake-amount">${amount} ETB</div>
            <div class="stake-info">
                <div class="stake-players" id="stake-count-${amount}" style="color:#6b7280;font-size:0.82rem;">0 Cards Purchased</div>
                <div class="stake-timer" id="stake-timer-${amount}">⏰ 20</div>
                <div class="stake-prize" id="stake-prize-${amount}" style="font-size:0.82rem;color:#6b7280;margin-top:3px;">🏆 Prize Pool: 0.00 ETB</div>
            </div>
            <button class="join-btn" onclick="joinStake(${amount})">JOIN</button>
        `;
        list.appendChild(row);
    });
}

window.joinStake = (amount) => {
    currentRoom = amount;
    // Reset prev-status for this stake so _syncTimers sees the current state as
    // "fresh" on its next tick — fixes the race where _prevRoomStatus already
    // holds 'playing' (set before the player joined) and the transition never fires.
    delete _prevRoomStatus[String(amount)];
    _gameStarted[amount] = false;
    const token = localStorage.getItem('bingo_token');
    try {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'JOIN_ROOM', room: amount, token: token }));
        }
    } catch (e) { /* WebSocket optional — backend uses HTTP polling */ }
    const stakeLabel = document.getElementById('sel-stake-amount');
    if (stakeLabel) stakeLabel.innerText = `${amount} ETB`;
    // Set stake display in info bar
    const stakeDisp = document.getElementById('sel-stake-display');
    if (stakeDisp) stakeDisp.innerText = amount;
    // Sync wallet values to current balance
    const walletVal = Math.round(userBalance);
    const mw = document.getElementById('sel-main-wallet');
    const pw = document.getElementById('sel-play-wallet');
    if (mw) mw.innerText = walletVal;
    if (pw) pw.innerText = walletVal;
    const screens = ['stake-screen', 'profile-screen', 'wallet-screen', 'game-screen'];
    screens.forEach(s => {
        const el = document.getElementById(s);
        if (el) el.classList.remove('active');
    });
    const selectionScreen = document.getElementById('selection-screen');
    if (selectionScreen) selectionScreen.classList.add('active');
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.style.display = 'block';
    fetchRoomHistory();
};

function initApp() {
    createBingoNumbers();
    createStakeList();      // builds stake-timer-* / stake-count-* / stake-prize-* elements
    createAvailableCards();

    // Start server-driven timer system AFTER DOM elements exist
    startTimerSystem();

    // Fetch fresh balance from DB immediately on load, then every 15 seconds
    fetchAndSyncBalance();
    setInterval(fetchAndSyncBalance, 15000);

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

// Initialize immediately from server-rendered value (never stale)
let userBalance = (typeof window.INITIAL_BALANCE === 'number') ? window.INITIAL_BALANCE : 0;

// Central balance sync — always fetches fresh value from DB
async function fetchAndSyncBalance() {
    try {
        const token = localStorage.getItem('bingo_token');
        const res = await fetch('/api/user/balance', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data.balance === 'number') {
            userBalance = data.balance;
            const rounded = Math.round(userBalance);
            const els = {
                'sel-balance':          userBalance.toFixed(2),
                'wallet-balance-value': userBalance.toFixed(2),
                'withdraw-balance-value': userBalance.toFixed(2),
                'walletBalance':        userBalance.toFixed(2),
                'profile-balance':      userBalance.toFixed(2),
                'sel-main-wallet':      rounded,
                'sel-play-wallet':      rounded,
            };
            Object.entries(els).forEach(([id, val]) => {
                const el = document.getElementById(id);
                if (el) el.innerText = val;
            });
        }
    } catch (e) { /* silent */ }
}

function updateUserData(data) {
    if (typeof data.balance === 'number' || typeof data.balance === 'string') {
        userBalance = parseFloat(data.balance);
    }
    // Use the central sync to update all UI elements consistently
    fetchAndSyncBalance();

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

// ---- Game State Polling (runs while a room is PLAYING) ----
let _gameStatePollInterval = null;
let _lastBallCount = 0;
let _winnerShown = false;

function startGameStatePoll(stake) {
    stopGameStatePoll();
    _lastBallCount = 0;
    _winnerShown = false;
    _gameStatePollInterval = setInterval(() => pollGameState(stake), 1000);
}

function stopGameStatePoll() {
    if (_gameStatePollInterval) {
        clearInterval(_gameStatePollInterval);
        _gameStatePollInterval = null;
    }
}

async function pollGameState(stake) {
    try {
        const res = await fetch(`/api/game-state/${stake}`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.status !== 'playing') {
            stopGameStatePoll();
            if (!_winnerShown) {
                showToast('ጨዋታ ተጠናቋል — አሸናፊ አልተገኘም');
            }
            return;
        }

        // Update board only when new balls have been called
        if (data.balls && data.balls.length !== _lastBallCount) {
            _lastBallCount = data.balls.length;
            updateGameUI(data.balls);
            // Flash latest ball + always play ball-call sound
            const latest = data.balls[data.balls.length - 1];
            if (latest) {
                const letter = getBallLetter(latest);
                const ab = document.getElementById('active-ball');
                if (ab) {
                    ab.innerHTML = `<span style="color:${colors[letter]}">${letter}${latest}</span>`;
                    ab.classList.add('ball-flash');
                    setTimeout(() => ab.classList.remove('ball-flash'), 600);
                }
                if (typeof playBallCall === 'function') playBallCall();
                checkMyCardForBingo(data.balls);
            }
        }

        // Winner announced by server
        if (data.winner && !_winnerShown) {
            _winnerShown = true;
            stopGameStatePoll();
            const state = getRoomState(currentRoom);
            const isMe = (data.winner === (window.CURRENT_USERNAME || ''));
            const winCard = isMe ? state.myGameCard : null;
            const winPat = isMe ? getWinningPattern(state.myGameCard, data.balls) : null;
            showWinnerModal(data.winner, winCard, winPat, data.prize, isMe);
            if (typeof playWinnerFanfare === 'function') playWinnerFanfare();
            setTimeout(() => {
                const modal = document.getElementById('winner-modal');
                if (modal) modal.classList.remove('active');
                handleGameOverReturn(stake);
            }, WINNER_DISPLAY_SECONDS * 1000);
        }
    } catch (e) { /* silent */ }
}

const WINNER_DISPLAY_SECONDS = 8;

function checkMyCardForBingo(calledBalls) {
    const state = getRoomState(currentRoom);
    if (!state.myGameCard || state.bingoFlashed) return;
    const called = new Set(calledBalls);
    const letters = ['B', 'I', 'N', 'G', 'O'];
    const grid = [];
    for (let row = 0; row < 5; row++) {
        const r = [];
        for (const l of letters) {
            const val = state.myGameCard[l][row];
            r.push(val === 'FREE' ? true : called.has(val));
        }
        grid.push(r);
    }
    let hasBingo = false;
    for (const row of grid) if (row.every(Boolean)) { hasBingo = true; break; }
    if (!hasBingo) for (let c = 0; c < 5; c++) if (grid.every(r => r[c])) { hasBingo = true; break; }
    if (!hasBingo && grid.every((r, i) => r[i])) hasBingo = true;
    if (!hasBingo && grid.every((r, i) => r[4 - i])) hasBingo = true;

    if (hasBingo) {
        state.bingoFlashed = true;
        const btn = document.getElementById('bingo-btn');
        if (btn) {
            btn.style.animation = 'bingo-pulse 0.5s ease infinite';
            btn.style.background = '#22c55e';
            btn.style.boxShadow = '0 0 20px rgba(34,197,94,0.8)';
        }
        showToast('🎉 ቢንጎ አለዎት! BINGO ይንኩ!');
    }
}

function startGame() {
    navTo('game');
    const state = getRoomState(currentRoom);
    if (state.purchasedCard && !state.myGameCard) {
        state.myGameCard = state.currentCardData;
    }
    state.bingoFlashed = false;
    renderMyGameCard();
    // Show player's card number in game header
    const myBoardEl = document.getElementById('sel-my-board-game');
    if (myBoardEl) myBoardEl.innerText = state.purchasedCard ? `#${state.purchasedCard}` : '--';
    // Reset game board
    updateGameUI([]);
    _lastBallCount = 0;
    _winnerShown = false;
    // Start polling for balls
    if (currentRoom) startGameStatePoll(currentRoom);
}

function navTo(screenId) {
    const screens = ['stake-screen', 'profile-screen', 'wallet-screen', 'game-screen', 'selection-screen', 'admin-screen', 'deposit-screen', 'withdraw-screen', 'leaderboard-screen'];
    screens.forEach(s => {
        const el = document.getElementById(s);
        if (el) el.classList.remove('active');
    });

    const target = document.getElementById(`${screenId}-screen`);
    if (target) target.classList.add('active');

    if (screenId === 'profile') loadProfileData();
    if (screenId === 'wallet') loadBalanceHistory();
    if (screenId === 'leaderboard') loadLeaderboard();

    const sideMenu = document.getElementById('side-menu');
    const overlay = document.getElementById('menu-overlay');
    if (sideMenu) sideMenu.classList.remove('active');
    if (overlay) overlay.classList.remove('active');
}

async function loadProfileData() {
    try {
        const res = await fetch('/api/user/stats');
        if (!res.ok) return;
        const s = await res.json();

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };

        set('pstat-games', s.games_played);
        set('pstat-cards', s.cards_purchased);
        set('pstat-wins',  s.wins);
        set('pstat-won',   s.total_won.toFixed(2));
        set('pstat-spent', s.total_spent.toFixed(2));

        const net = s.total_won - s.total_spent;
        const netEl = document.getElementById('pstat-net');
        if (netEl) {
            netEl.innerText = (net >= 0 ? '+' : '') + net.toFixed(2) + ' ETB';
            netEl.style.color = net >= 0 ? '#22c55e' : '#ef4444';
        }
    } catch (e) { /* silent */ }

    // Load referral stats
    try {
        const rr = await fetch('/api/user/referral');
        if (!rr.ok) return;
        const rd = await rr.json();
        const refCountEl  = document.getElementById('ref-count');
        const refEarnedEl = document.getElementById('ref-earned');
        const refLinkBox  = document.getElementById('ref-link-box');
        if (refCountEl)  refCountEl.innerText  = rd.referred_count;
        if (refEarnedEl) refEarnedEl.innerText = rd.bonus_earned.toFixed(2);
        const link = window.location.origin + '/signup?ref=' + rd.referral_code;
        if (refLinkBox) {
            refLinkBox.innerText    = link;
            refLinkBox.dataset.link = link;
        }
    } catch (e) { /* silent */ }
}

function copyReferralLink() {
    const box = document.getElementById('ref-link-box');
    const statusEl = document.getElementById('ref-copy-status');
    const link = (box && box.dataset.link) ? box.dataset.link : (box ? box.innerText : '');
    if (!link || link === 'Loading...') return;
    navigator.clipboard.writeText(link).then(() => {
        if (statusEl) { statusEl.innerText = '✅ Link copied!'; }
        const btn = document.getElementById('ref-copy-btn');
        if (btn) { btn.innerText = 'Copied!'; setTimeout(() => { btn.innerText = 'Copy'; }, 2000); }
        if (statusEl) setTimeout(() => { statusEl.innerText = ''; }, 2500);
    }).catch(() => {
        if (statusEl) { statusEl.innerText = '⚠️ Could not copy — please copy manually.'; }
    });
}

let _lbData = [];
let _lbSortKey = 'prize';

function lbSort(key) {
    _lbSortKey = key;
    document.querySelectorAll('.lb-tab').forEach(b => b.classList.remove('active'));
    const tab = document.getElementById('lb-tab-' + key);
    if (tab) tab.classList.add('active');
    _lbRender();
}

function _lbRender() {
    const listEl = document.getElementById('lb-list');
    if (!listEl) return;
    if (!_lbData.length) {
        listEl.innerHTML = '<p class="lb-empty">🏆 ምንም አሸናፊ አልተመዘገበም።<br>No winners recorded yet.</p>';
        return;
    }
    const sorted = [..._lbData].sort((a, b) => {
        if (_lbSortKey === 'wins')    return b.wins - a.wins;
        if (_lbSortKey === 'winrate') return b.win_rate - a.win_rate;
        return b.total_prize - a.total_prize;
    });

    const medals    = ['🥇', '🥈', '🥉'];
    const rankCls   = ['gold', 'silver', 'bronze'];
    const avCls     = ['av-gold', 'av-silver', 'av-bronze'];
    const rowCls    = ['rank-1', 'rank-2', 'rank-3'];

    listEl.innerHTML = sorted.map((l, i) => {
        const initial  = (l.username || '?')[0].toUpperCase();
        const rankIcon = i < 3 ? medals[i] : `#${i + 1}`;
        const rCls     = i < 3 ? rankCls[i] : 'other';
        const aC       = i < 3 ? avCls[i] : '';
        const rRowCls  = i < 3 ? rowCls[i] : '';

        const wr = l.win_rate || 0;
        const wrCls = wr >= 40 ? 'wr-high' : wr >= 20 ? 'wr-mid' : 'wr-low';

        const highlightVal = _lbSortKey === 'wins'    ? `${l.wins} wins`
                           : _lbSortKey === 'winrate' ? `${wr}% win rate`
                           : `${l.total_prize.toFixed(2)} ETB`;
        const highlightLbl = _lbSortKey === 'wins'    ? 'rounds won'
                           : _lbSortKey === 'winrate' ? 'win rate'
                           : 'ETB won';

        return `
        <div class="lb-row ${rRowCls}">
            <div class="lb-rank ${rCls}">${rankIcon}</div>
            <div class="lb-avatar ${aC}">${initial}</div>
            <div class="lb-info">
                <div class="lb-name">${l.username}</div>
                <div class="lb-meta">
                    <span class="lb-wins-badge">🏅 ${l.wins} win${l.wins !== 1 ? 's' : ''}</span>
                    <span class="lb-rounds-badge">${l.rounds_played} played</span>
                    <span class="lb-wr-badge ${wrCls}">📈 ${wr}%</span>
                </div>
            </div>
            <div class="lb-right">
                <div class="lb-prize-amount">${highlightVal}</div>
                <div class="lb-prize-label">${highlightLbl}</div>
            </div>
        </div>`;
    }).join('');
}

async function loadLeaderboard() {
    const listEl = document.getElementById('lb-list');
    if (!listEl) return;
    listEl.innerHTML = '<p class="lb-empty">Loading...</p>';
    try {
        const res = await fetch('/api/leaderboard');
        if (!res.ok) throw new Error('Failed');
        _lbData = await res.json();
        _lbRender();
    } catch (e) {
        listEl.innerHTML = '<p class="lb-empty">ስህተት ተፈጥሯል። እባክዎ ዳግም ሞክሩ።</p>';
    }
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


// Returns headers that include the admin key for all admin API calls
function _ah(extra) {
    return Object.assign({ 'Content-Type': 'application/json', 'X-Admin-Key': localStorage.getItem('_ak') || '' }, extra || {});
}

async function promptAdminPassword() {
    const pass = prompt("አድሚን ፓስወርድ ያስገቡ:");
    if (!pass) return;
    try {
        const res = await fetch('/api/admin/verify-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pass })
        });
        const d = await res.json();
        if (d.valid) {
            localStorage.setItem('_ak', pass);
            navTo('admin');
        } else {
            alert("የተሳሳተ ፓስወርድ!");
        }
    } catch (e) {
        alert("Connection error. Please try again.");
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

    if (tab === 'revenue') loadAdminRevenue();
    if (tab === 'history') loadAdminHistory();
    if (tab === 'deposits') fetchAdminDeposits();
    if (tab === 'withdrawals') fetchAdminWithdrawals();
    if (tab === 'settings') loadAdminSettings();
};

let _revInterval = null;

async function loadAdminRevenue() {
    if (_revInterval) clearInterval(_revInterval);

    async function _fetch() {
        try {
            const res = await fetch('/api/admin/revenue', { headers: _ah() });
            if (!res.ok) return;
            const d = await res.json();

            const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };

            set('rev-today-rounds',  d.today.rounds);
            set('rev-active',        d.active_players_today);
            set('rev-today-income',  d.today.income.toFixed(2) + ' ETB');
            set('rev-today-profit',  d.today.profit.toFixed(2) + ' ETB');

            set('rev-today-cards',   d.today.cards);
            set('rev-today-income2', d.today.income.toFixed(2) + ' ETB');
            set('rev-today-payout',  d.today.payout.toFixed(2) + ' ETB');
            set('rev-today-profit2', d.today.profit.toFixed(2) + ' ETB');
            set('rev-fee-pct',       d.house_fee_pct);

            set('rev-all-rounds',  d.alltime.rounds);
            set('rev-all-cards',   d.alltime.cards);
            set('rev-all-income',  d.alltime.income.toFixed(2) + ' ETB');
            set('rev-all-payout',  d.alltime.payout.toFixed(2) + ' ETB');
            set('rev-all-profit',  d.alltime.profit.toFixed(2) + ' ETB');
            set('rev-users',       d.total_users);
            set('rev-updated',     'Updated ' + d.generated_at);

            // Colour today's profit
            const profitEl = document.getElementById('rev-today-profit');
            if (profitEl) profitEl.style.color = d.today.profit > 0 ? '#f59e0b' : '#6b7280';
            const profitEl2 = document.getElementById('rev-today-profit2');
            if (profitEl2) profitEl2.style.color = d.today.profit > 0 ? '#f59e0b' : '#6b7280';

            // Recent rounds log
            const listEl = document.getElementById('rev-rounds-list');
            if (listEl) {
                if (!d.recent_rounds || d.recent_rounds.length === 0) {
                    listEl.innerHTML = '<p style="font-size:0.8rem;color:#6b7280;text-align:center;padding:10px 0;">No completed rounds yet.</p>';
                } else {
                    listEl.innerHTML = d.recent_rounds.map(r => {
                        const profitColor = r.profit > 0 ? '#22c55e' : '#6b7280';
                        return `<div style="display:grid;grid-template-columns:40px 1fr 60px 60px 60px;gap:4px;padding:5px 0;border-bottom:1px solid #1a2035;align-items:center;">
                            <span style="font-size:0.7rem;color:#6b7280;">${r.time}</span>
                            <span style="font-size:0.75rem;color:#e5e7eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${r.winner}">🏆 ${r.winner}</span>
                            <span style="font-size:0.75rem;color:#22c55e;text-align:right;font-weight:600;">${r.income.toFixed(2)}</span>
                            <span style="font-size:0.75rem;color:#ef4444;text-align:right;font-weight:600;">${r.payout.toFixed(2)}</span>
                            <span style="font-size:0.75rem;text-align:right;font-weight:700;color:${profitColor};">${r.profit.toFixed(2)}</span>
                        </div>`;
                    }).join('');
                }
            }
        } catch (e) { console.error('[Revenue]', e); }
    }

    await _fetch();
    _revInterval = setInterval(_fetch, 15000);
}

async function loadAdminSettings() {
    const statusEl  = document.getElementById('settings-status');
    const minEl     = document.getElementById('settings-min-cards');
    const countEl   = document.getElementById('settings-countdown');
    const feeEl     = document.getElementById('settings-house-fee');
    const refBonEl  = document.getElementById('settings-referral-bonus');

    if (statusEl) { statusEl.innerText = 'Loading...'; statusEl.style.color = '#6b7280'; }

    try {
        const res = await fetch('/api/admin/settings', { headers: _ah() });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (minEl)    minEl.value    = data.min_cards;
        if (countEl)  countEl.value  = data.launch_countdown;
        if (feeEl)    feeEl.value    = data.house_fee_pct;
        if (refBonEl) refBonEl.value = data.referral_bonus;
        if (statusEl) {
            statusEl.innerText = `✅ Loaded — min cards: ${data.min_cards}, launch: ${data.launch_countdown}s, commission: ${data.house_fee_pct}%, referral bonus: ${data.referral_bonus} ETB`;
            statusEl.style.color = '#22c55e';
        }
    } catch (e) {
        if (statusEl) { statusEl.innerText = '❌ Failed to load settings.'; statusEl.style.color = '#ef4444'; }
    }

    const saveBtn = document.getElementById('settings-save-btn');
    if (saveBtn) {
        saveBtn.onclick = async () => {
            const minVal    = parseInt(minEl    ? minEl.value    : '5');
            const cntVal    = parseInt(countEl  ? countEl.value  : '10');
            const feeVal    = parseInt(feeEl    ? feeEl.value    : '10');
            const refBonVal = parseFloat(refBonEl ? refBonEl.value : '5');

            if (isNaN(minVal) || minVal < 1 || minVal > 50) {
                if (statusEl) { statusEl.innerText = '⚠️ Min cards must be 1–50.'; statusEl.style.color = '#f59e0b'; }
                return;
            }
            if (isNaN(cntVal) || cntVal < 5 || cntVal > 120) {
                if (statusEl) { statusEl.innerText = '⚠️ Launch countdown must be 5–120 seconds.'; statusEl.style.color = '#f59e0b'; }
                return;
            }
            if (isNaN(feeVal) || feeVal < 0 || feeVal > 50) {
                if (statusEl) { statusEl.innerText = '⚠️ Commission must be 0–50%.'; statusEl.style.color = '#f59e0b'; }
                return;
            }
            if (isNaN(refBonVal) || refBonVal < 0 || refBonVal > 100) {
                if (statusEl) { statusEl.innerText = '⚠️ Referral bonus must be 0–100 ETB.'; statusEl.style.color = '#f59e0b'; }
                return;
            }

            saveBtn.disabled = true;
            saveBtn.innerText = 'Saving...';
            try {
                const res = await fetch('/api/admin/settings', {
                    method: 'POST',
                    headers: _ah(),
                    body: JSON.stringify({ min_cards: minVal, launch_countdown: cntVal, house_fee_pct: feeVal, referral_bonus: refBonVal })
                });
                const data = await res.json();
                if (data.success) {
                    if (statusEl) {
                        statusEl.innerText = `✅ Saved! Min: ${data.min_cards} | Launch: ${data.launch_countdown}s | Commission: ${data.house_fee_pct}% | Referral: ${data.referral_bonus} ETB`;
                        statusEl.style.color = '#22c55e';
                    }
                } else {
                    if (statusEl) { statusEl.innerText = `❌ ${data.error}`; statusEl.style.color = '#ef4444'; }
                }
            } catch (e) {
                if (statusEl) { statusEl.innerText = '❌ Save failed.'; statusEl.style.color = '#ef4444'; }
            }
            saveBtn.disabled = false;
            saveBtn.innerText = '💾 Save Settings';
        };
    }

    // Change password handler
    const pwdBtn = document.getElementById('pwd-save-btn');
    if (pwdBtn) {
        pwdBtn.onclick = async () => {
            const curEl  = document.getElementById('pwd-current');
            const newEl  = document.getElementById('pwd-new');
            const conEl  = document.getElementById('pwd-confirm');
            const statEl = document.getElementById('pwd-status');

            const cur = curEl  ? curEl.value.trim()  : '';
            const nw  = newEl  ? newEl.value.trim()  : '';
            const con = conEl  ? conEl.value.trim()  : '';

            const show = (msg, color) => { if (statEl) { statEl.innerText = msg; statEl.style.color = color; } };

            if (!cur)         return show('⚠️ Please enter your current password.', '#f59e0b');
            if (nw.length < 6) return show('⚠️ New password must be at least 6 characters.', '#f59e0b');
            if (nw !== con)   return show('⚠️ Passwords do not match.', '#f59e0b');

            pwdBtn.disabled  = true;
            pwdBtn.innerText = 'Saving...';
            try {
                const res  = await fetch('/api/admin/change-password', {
                    method:  'POST',
                    headers: _ah(),
                    body:    JSON.stringify({ current_password: cur, new_password: nw })
                });
                const data = await res.json();
                if (data.success) {
                    show('✅ Password changed successfully!', '#22c55e');
                    if (curEl) curEl.value = '';
                    if (newEl) newEl.value = '';
                    if (conEl) conEl.value = '';
                } else {
                    show('❌ ' + (data.error || 'Failed.'), '#ef4444');
                }
            } catch (e) {
                show('❌ Connection error.', '#ef4444');
            }
            pwdBtn.disabled  = false;
            pwdBtn.innerText = '🔒 Change Password';
        };
    }
}

async function loadAdminHistory() {
    const listEl = document.getElementById('admin-history-list');
    if (!listEl) return;
    listEl.innerHTML = '<p class="empty-msg">Loading...</p>';
    try {
        const res = await fetch('/api/admin/game-history', { headers: _ah() });
        if (!res.ok) throw new Error('Failed');
        const sessions = await res.json();
        if (!sessions.length) {
            listEl.innerHTML = '<p class="empty-msg">ምንም ያለቀ ጨዋታ የለም።</p>';
            return;
        }
        listEl.innerHTML = `
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.78rem;">
            <thead>
                <tr style="color:#64748b;text-align:left;border-bottom:1px solid rgba(255,255,255,0.08);">
                    <th style="padding:8px 6px;">#</th>
                    <th style="padding:8px 6px;">ክፍል</th>
                    <th style="padding:8px 6px;">ተጫዋቾች</th>
                    <th style="padding:8px 6px;">አሸናፊ</th>
                    <th style="padding:8px 6px;">ሽልማት</th>
                    <th style="padding:8px 6px;">ጊዜ</th>
                </tr>
            </thead>
            <tbody>
                ${sessions.map(s => `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                    <td style="padding:8px 6px;color:#475569;">${s.session_id}</td>
                    <td style="padding:8px 6px;font-weight:700;color:#f59e0b;">${s.stake} ETB</td>
                    <td style="padding:8px 6px;color:#3b82f6;font-weight:700;">${s.players}</td>
                    <td style="padding:8px 6px;font-weight:800;color:${s.winner !== '—' ? '#22c55e' : '#475569'};">${s.winner}</td>
                    <td style="padding:8px 6px;font-weight:800;color:#22c55e;">${s.prize > 0 ? s.prize.toFixed(2) : '—'}</td>
                    <td style="padding:8px 6px;color:#64748b;white-space:nowrap;">${s.created_at}</td>
                </tr>`).join('')}
            </tbody>
        </table>
        </div>
        <div style="margin-top:10px;padding:10px;background:#161b22;border-radius:10px;display:flex;gap:20px;justify-content:center;font-size:0.8rem;">
            <span style="color:#64748b;">ጠቅላላ: <strong style="color:white;">${sessions.length}</strong> ጨዋታዎች</span>
            <span style="color:#64748b;">ጠቅላላ ሽልማት: <strong style="color:#22c55e;">${sessions.reduce((a,s)=>a+s.prize,0).toFixed(2)} ETB</strong></span>
            <span style="color:#64748b;">ጠቅላላ ተጫዋቾች: <strong style="color:#3b82f6;">${sessions.reduce((a,s)=>a+s.players,0)}</strong></span>
        </div>`;
    } catch (e) {
        listEl.innerHTML = '<p class="empty-msg">ስህተት ተፈጥሯል።</p>';
    }
}

async function fetchAdminDeposits() {
    const listEl = document.getElementById('admin-deposits-list');
    try {
        const res = await fetch('/api/admin/deposits', { headers: _ah() });
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
    const listEl = document.getElementById('admin-withdrawals-list');
    try {
        const res = await fetch('/api/admin/withdrawals', { headers: _ah() });
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
        const username = document.getElementById('admin-search-phone').value.trim();
        if (!username) return;
        try {
            const res  = await fetch(`/api/admin/user/${encodeURIComponent(username)}`, { headers: _ah() });
            const user = await res.json();
            if (res.ok) {
                document.getElementById('admin-user-result').style.display = 'block';
                document.getElementById('admin-user-name').innerText    = user.username;
                document.getElementById('admin-user-phone').innerText   = `ID: ${user.id}`;
                document.getElementById('admin-user-balance').innerText = user.balance.toFixed(2);
                const roleEl = document.getElementById('admin-user-role');
                if (roleEl) roleEl.innerText = user.is_admin ? 'ROLE: ADMIN' : 'ROLE: USER';
                const promoteBtn = document.getElementById('admin-promote-btn');
                if (promoteBtn) promoteBtn.style.display = user.is_admin ? 'none' : 'block';
                // clear amount input
                const amtEl = document.getElementById('admin-balance-amount');
                if (amtEl) amtEl.value = '';
                const balStatusEl = document.getElementById('admin-balance-status');
                if (balStatusEl) balStatusEl.innerText = '';
                window.currentAdminUser = user;
            } else {
                alert(user.error || 'ተጠቃሚ አልተገኘም');
            }
        } catch (e) { console.error(e); }
    };
}

const addBalanceBtn = document.getElementById('admin-add-balance');
if (addBalanceBtn) addBalanceBtn.onclick = () => _adjustBalance(true);
const subBalanceBtn = document.getElementById('admin-sub-balance');
if (subBalanceBtn) subBalanceBtn.onclick = () => _adjustBalance(false);

async function _adjustBalance(isAdd) {
    const amtEl      = document.getElementById('admin-balance-amount');
    const statusEl   = document.getElementById('admin-balance-status');
    const balEl      = document.getElementById('admin-user-balance');
    const user       = window.currentAdminUser;

    const show = (msg, color) => { if (statusEl) { statusEl.innerText = msg; statusEl.style.color = color; } };

    if (!user)              return show('⚠️ መጀመሪያ ተጠቃሚ ፈልጉ።', '#f59e0b');
    const raw = parseFloat(amtEl ? amtEl.value : '');
    if (isNaN(raw) || raw <= 0) return show('⚠️ ትክክለኛ መጠን ያስገቡ።', '#f59e0b');

    const amount = isAdd ? raw : -raw;
    try {
        const res  = await fetch('/api/admin/adjust-balance', {
            method:  'POST',
            headers: _ah(),
            body:    JSON.stringify({ user_id: user.id, amount })
        });
        const data = await res.json();
        if (data.success) {
            window.currentAdminUser.balance = data.new_balance;
            if (balEl) balEl.innerText = data.new_balance.toFixed(2);
            if (amtEl) amtEl.value = '';
            show(`✅ ተስተካክሏል! ${isAdd ? '+' : ''}${data.adjusted_by.toFixed(2)} ETB → አዲስ ባላንስ: ${data.new_balance.toFixed(2)} ETB`, '#22c55e');
        } else {
            show('❌ ' + (data.error || 'ስህተት ተፈጥሯል'), '#ef4444');
        }
    } catch (e) {
        show('❌ Connection error.', '#ef4444');
        console.error(e);
    }
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

const sendDailyReportBtn = document.getElementById('send-daily-report-btn');
if (sendDailyReportBtn) {
    sendDailyReportBtn.onclick = async () => {
        const statusEl = document.getElementById('daily-report-status');
        sendDailyReportBtn.disabled = true;
        sendDailyReportBtn.innerText = 'Sending...';
        if (statusEl) { statusEl.innerText = ''; statusEl.style.color = '#6b7280'; }
        try {
            const res = await fetch('/api/admin/send-daily-report', {
                method: 'POST',
                headers: _ah()
            });
            const data = await res.json();
            if (data.success) {
                if (statusEl) { statusEl.innerText = '✅ ' + data.message; statusEl.style.color = '#22c55e'; }
            } else {
                if (statusEl) { statusEl.innerText = '❌ ' + (data.error || 'Failed'); statusEl.style.color = '#ef4444'; }
            }
        } catch (e) {
            if (statusEl) { statusEl.innerText = '❌ Network error'; statusEl.style.color = '#ef4444'; }
        }
        sendDailyReportBtn.disabled = false;
        sendDailyReportBtn.innerText = '📤 Send Report Now';
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

// initApp() is called from window.onload — guaranteed DOM-ready single entry point.