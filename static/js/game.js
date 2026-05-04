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
let roomStates = {};

function getRoomState(roomId) {
    if (!roomStates[roomId]) {
        roomStates[roomId] = {
            myGameCard: null,
            currentSelectedCard: null,
            currentCardData: null,
            lastHistory: [],
            takenCards: [],
            lastBallCount: 0,
            winnerShown: false,
            autoClaimInProgress: false,
            bingoFlashed: false,
            purchasedCard: null,
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
// status: 'waiting' (20-s card-selection countdown) | 'playing'
// ================================================================

let _timerPollId = null;
let _prevRoomStatus = {}; // stakeStr -> { status }
let _gameStarted = {};    // stake -> bool, prevent duplicate startGame calls
let _gameStartCDActive = false; // prevent overlapping 3-2-1 overlays
let _lastLaunchTick = -1; // last launch_timer value we played a tick for
let _lastCardCount = {};  // stakeStr -> last known cards_count for taken-card refresh

function startTimerSystem() {
    if (_timerPollId) clearInterval(_timerPollId);
    _syncTimers();
    _timerPollId = setInterval(_syncTimers, 2000);
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
                const n  = info.cards_count || 0;
                const lt = info.launch_timer || 0;
                if (info.status === 'playing') {
                    countEl.innerText  = `${n} Cards in Game`;
                    countEl.style.color = '#22c55e';
                } else {
                    // waiting — show how many cards bought so far
                    countEl.innerText  = n > 0
                        ? `🃏 ${n} card${n > 1 ? 's' : ''} bought`
                        : '🃏 No cards yet';
                    countEl.style.color = n > 0 ? '#f59e0b' : '#94a3b8';
                }
                countEl.style.fontWeight = 'bold';
            }

            // ── Stake-list status badge (shows countdown timer) ───────────
            const badge = document.getElementById(`stake-timer-${stake}`);
            if (badge) {
                if (info.status === 'playing') {
                    badge.innerText = '🎮 PLAYING';
                    badge.style.color = '#22c55e';
                    badge.style.background = 'rgba(34,197,94,0.1)';
                } else {
                    const lt = info.launch_timer || 0;
                    badge.innerText = lt > 0 ? `⏱ ${lt}s` : '⏳';
                    badge.style.color = lt <= 5 ? '#ef4444' : lt <= 10 ? '#f59e0b' : '#64748b';
                    badge.style.background = lt <= 5
                        ? 'rgba(239,68,68,0.1)'
                        : lt <= 10 ? 'rgba(245,158,11,0.1)' : 'rgba(100,116,139,0.1)';
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

            // ── Live taken-cards refresh ──────────────────────────────────
            // When the purchased-card count changes for the current room,
            // refresh the taken-cards list so every player on the selection
            // screen immediately sees newly-bought cards marked as taken.
            if (currentRoom == stake && info.status !== 'playing' &&
                    _lastCardCount[stakeStr] !== info.cards_count) {
                _lastCardCount[stakeStr] = info.cards_count;
                const selScreen = document.getElementById('selection-screen');
                if (selScreen && selScreen.classList.contains('active')) {
                    fetchTakenCards(stake);
                }
            }

            // ── Screen transitions ────────────────────────────────────────
            const _rs   = getRoomState(stake);
            const _onSel = () => {
                const s = document.getElementById('selection-screen');
                return !!(s && s.classList.contains('active'));
            };

            // ① playing → waiting/launching: game ended → return to selection screen
            if (prev.status === 'playing' && info.status !== 'playing' && currentRoom == stake) {
                _gameStarted[stake] = false;
                // If the winner modal is already showing (poll caught the winner),
                // let its own setTimeout handle the return so we don't interrupt it.
                const _winModal = document.getElementById('winner-modal');
                const _winModalActive = _winModal && _winModal.classList.contains('active');
                if (!_winModalActive) {
                    handleGameOverReturn(stake);
                }
            }

            // ② non-playing → playing: game just started
            //    Only navigate if user has purchased a card AND is on the selection screen.
            //    This prevents false-triggering when user joins a room that is already playing
            //    (mid-game join) without having bought a card.
            if (prev.status !== 'playing' && info.status === 'playing' && currentRoom == stake) {
                _gameStarted[stake] = true;   // acknowledge the transition regardless
                if (_rs.purchasedCard && _onSel() && !_gameStartCDActive) {
                    _showGameStartCountdown(startGame);
                }
            }

            // ③ Safety net: game is playing, user has a card, but still on selection screen.
            //    Catches: card bought while game was already playing, or rapid status flip
            //    that ② missed because _gameStarted was already true from a previous cycle.
            if (info.status === 'playing' && currentRoom == stake &&
                _rs.purchasedCard && _onSel() && !_gameStartCDActive) {
                _gameStarted[stake] = true;   // prevent re-entry from other checks
                _showGameStartCountdown(startGame);
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

        // ── In-game broadcast alert (first stake key carries global alert) ─
        const firstInfo = Object.values(data)[0];
        if (firstInfo) _handleBroadcastAlert(firstInfo.broadcast_alert || null);

        // ── Rebuild lobby if server rooms differ from current DOM ─────────
        const apiStakes = Object.keys(data).map(Number).sort((a, b) => a - b);
        const domStakes = Array.from(
            document.querySelectorAll('#stake-list .stake-row[data-stake]')
        ).map(el => parseInt(el.dataset.stake));
        const listsMatch = apiStakes.length === domStakes.length &&
            apiStakes.every((s, i) => s === domStakes[i]);
        if (!listsMatch) createStakeList();

    } catch (e) { console.error('[Status] _syncTimers error:', e); }
}

let _lastAlertMsg = '';
let _alertDismissTimer = null;

function _handleBroadcastAlert(alert) {
    const overlay = document.getElementById('ingame-alert-overlay');
    if (!overlay) return;
    if (!alert || !alert.message) return;
    if (alert.message === _lastAlertMsg) return;   // already shown this one
    _lastAlertMsg = alert.message;

    // Populate content
    const iconEl = document.getElementById('ingame-alert-icon');
    const textEl = document.getElementById('ingame-alert-text');
    const barEl  = document.getElementById('ingame-alert-bar');
    if (iconEl) iconEl.innerText = alert.icon || '📢';
    if (textEl) textEl.innerText = alert.message;

    // Show overlay
    overlay.style.display = 'flex';

    // Animate countdown bar
    const ttl = (alert.ttl || 30) * 1000;
    if (barEl) {
        barEl.style.transition = 'none';
        barEl.style.width      = '100%';
        requestAnimationFrame(() => {
            barEl.style.transition = `width ${ttl}ms linear`;
            barEl.style.width      = '0%';
        });
    }

    // Auto-dismiss
    clearTimeout(_alertDismissTimer);
    _alertDismissTimer = setTimeout(() => {
        overlay.style.display = 'none';
    }, ttl + 200);
}

window.dismissIngameAlert = function () {
    const overlay = document.getElementById('ingame-alert-overlay');
    if (overlay) overlay.style.display = 'none';
    clearTimeout(_alertDismissTimer);
};

// ── Card Fill Panel renderer ──────────────────────────────────────────────────
function _updateCardFillPanel(info) {
    const n          = info.cards_count    || 0;
    const lt         = info.launch_timer   || 0;
    const selectTime = info.card_select_time || 20;

    const iconEl      = document.getElementById('cfp-icon');
    const labelEl     = document.getElementById('cfp-label');
    const currentEl   = document.getElementById('cfp-current');
    const barEl       = document.getElementById('cfp-bar');
    const launchWrap  = document.getElementById('cfp-launch-wrap');
    const launchNumEl = document.getElementById('cfp-launch-num');
    const prizePoolEl = document.getElementById('sel-prize-pool');

    // Show cards bought so far (replaces the old min-cards counter)
    if (currentEl) currentEl.innerText = n;

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
        _lastLaunchTick = -1;

    } else {
        // ── CARD SELECTION COUNTDOWN ─────────────────────────────────────────
        // lt counts down from selectTime to 0; use it as the visual timer.
        const pct = selectTime > 0 ? Math.round((lt / selectTime) * 100) : 0;

        if (iconEl) iconEl.innerText = lt <= 5 && lt > 0 ? '🔴' : lt > 0 ? '⏱️' : '✅';
        if (labelEl) {
            if (lt > 0) {
                labelEl.innerText = `ካርድ ምረጡ! ጨዋታ ${lt} ሰከንድ ውስጥ ይጀምራል`;
            } else {
                labelEl.innerText = n > 0 ? 'ዝግጁ — ጨዋታ ይጀምራል!' : 'ካርዶ ሳይሸጥ — ዳግም ቆጠራ';
            }
        }
        if (barEl) {
            barEl.style.width      = pct + '%';
            barEl.style.background = lt <= 5 ? '#ef4444' : lt <= 10 ? '#f59e0b' : '#3b82f6';
        }

        // Show the big countdown number in the launch-wrap box
        if (launchWrap) launchWrap.style.display = lt > 0 ? 'flex' : 'none';
        if (launchNumEl && lt > 0) {
            if (lt !== _lastLaunchTick) {
                launchNumEl.innerText = lt;
                launchNumEl.style.animation = 'none';
                void launchNumEl.offsetWidth;
                launchNumEl.style.animation = 'cfp-launch-pop 0.3s ease-out';
            }
        }

        // Tick sounds on every second change
        if (lt !== _lastLaunchTick) {
            _lastLaunchTick = lt;
            if (lt <= 5 && lt > 0 && typeof playFinalTick === 'function') playFinalTick();
            else if (lt > 0 && typeof playTick === 'function') playTick();
        }
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
    const info = identifyWinPattern(cardData, calledBalls);
    return info.cells;
}

function identifyWinPattern(cardData, calledBalls) {
    if (!cardData || !calledBalls) return { cells: [], type: 'ቢንጎ' };
    const called = new Set((calledBalls).map(n => Number(n)));
    const letters = ['B', 'I', 'N', 'G', 'O'];
    const grid = [];
    for (let row = 0; row < 5; row++) {
        const r = [];
        for (const l of letters) {
            const val = cardData[l][row];
            r.push({ val, hit: val === 'FREE' || called.has(Number(val)) });
        }
        grid.push(r);
    }
    const rowNames = ['1ኛ ረድፍ', '2ኛ ረድፍ', '3ኛ ረድፍ', '4ኛ ረድፍ', '5ኛ ረድፍ'];
    for (let i = 0; i < 5; i++) {
        if (grid[i].every(c => c.hit)) return { cells: grid[i].map(c => c.val), type: rowNames[i] };
    }
    const colNames = ['B አምድ', 'I አምድ', 'N አምድ', 'G አምድ', 'O አምድ'];
    for (let c = 0; c < 5; c++) {
        if (grid.every(r => r[c].hit)) return { cells: grid.map(r => r[c].val), type: colNames[c] };
    }
    if (grid.every((r, i) => r[i].hit)) return { cells: grid.map((r, i) => r[i].val), type: 'ዲያጎናል ↘' };
    if (grid.every((r, i) => r[4 - i].hit)) return { cells: grid.map((r, i) => r[4 - i].val), type: 'ዲያጎናል ↙' };
    return { cells: [], type: 'ቢንጎ' };
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

function handleGameOverReturn(stake) {
    stopGameStatePoll();
    // Clear game board state for this room
    const state = getRoomState(stake);
    state.myGameCard = null;
    state.currentSelectedCard = null;
    state.currentCardData = null;
    state.purchasedCard = null;
    state.bingoFlashed = false;
    state.lastHistory = [];
    state.autoClaimInProgress = false;
    state.winnerShown = false;
    state.lastBallCount = 0;
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

    // Clear taken cards so old session's cards don't show as taken in new session
    state.takenCards = [];
    createAvailableCards();

    // Return to selection screen (countdown already restarted)
    const screens = ['game-screen', 'profile-screen', 'wallet-screen', 'deposit-screen', 'withdraw-screen'];
    screens.forEach(s => {
        const el = document.getElementById(s);
        if (el) el.classList.remove('active');
    });
    const selScreen = document.getElementById('selection-screen');
    if (selScreen) selScreen.classList.add('active');

    // Fetch fresh taken cards for the new session after a short delay
    // (server needs a moment to reset active_session_id)
    setTimeout(() => fetchTakenCards(stake), 1500);
}

function updateRoomStats(stats, prizes) {
    // Count, prize pool, and timer are all handled live by _syncTimers.
    // This function is kept as a no-op to avoid errors from any remaining callers.
    globalStats = stats || {};
    globalPrizes = prizes || {};
}

// Legacy no-op
function updateCountdown(seconds) {}

async function fetchTakenCards(stake) {
    try {
        const res = await fetch(`/api/taken-cards/${stake}`);
        if (!res.ok) return;
        const data = await res.json();
        const newTaken = data.taken || [];
        const state = getRoomState(stake);
        // Only re-render the grid when the list has actually changed — prevents
        // constant flicker from re-rendering on every 2-second poll tick.
        const oldKey = JSON.stringify([...state.takenCards].sort((a, b) => a - b));
        const newKey = JSON.stringify([...newTaken].sort((a, b) => a - b));
        if (oldKey !== newKey) {
            state.takenCards = newTaken;
            if (stake == currentRoom) createAvailableCards();
        }
    } catch (e) { /* silent — best effort */ }
}

let STAKES = [10]; // kept as fallback; synced dynamically from server

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
    
    const state = getRoomState(currentRoom);
    const takenCards = state.takenCards;
    const purchasedCard = state.purchasedCard;
    const availableCount = 100 - takenCards.length;
    const takenCount = takenCards.length;
    
    const legendAvailable = document.querySelector('.legend-item:nth-child(1)');
    const legendTaken = document.querySelector('.legend-item:nth-child(2)');
    
    if (legendAvailable) legendAvailable.innerHTML = `<div class="dot green"></div> Available (${availableCount})`;
    if (legendTaken) legendTaken.innerHTML = `<div class="dot red"></div> Taken (${takenCount})`;

    for (let i = 1; i <= 100; i++) {
        const card = document.createElement('div');
        card.className = 'card-item';

        if (i === purchasedCard) {
            // Highlight the player's own card distinctly — green star badge,
            // stays visible even after the grid re-renders from a live refresh.
            card.classList.add('taken', 'my-card');
        } else if (takenCards.includes(i)) {
            card.classList.add('taken');
        }

        card.innerText = i;
        
        card.onclick = () => {
            if (card.classList.contains('taken')) return;
            showCardPreview(i);
        };
        cardsGrid.appendChild(card);
    }
}

function _showDebugPanel(info) {
    let panel = document.getElementById('_debug_panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = '_debug_panel';
        panel.style.cssText = `
            position:fixed;bottom:0;left:0;right:0;z-index:99999;
            background:#1a0000;color:#ff9999;font-family:monospace;font-size:11px;
            padding:10px;max-height:55vh;overflow-y:auto;
            border-top:2px solid #ff4444;
        `;
        const closeBtn = document.createElement('button');
        closeBtn.innerText = '✕ ዝጋ';
        closeBtn.style.cssText = 'float:right;background:#ff4444;color:#fff;border:none;padding:3px 10px;border-radius:4px;cursor:pointer;';
        closeBtn.onclick = () => panel.remove();
        panel.appendChild(closeBtn);
        const title = document.createElement('div');
        title.style.cssText = 'font-weight:bold;color:#ff6666;margin-bottom:6px;font-size:12px;';
        title.innerText = '🔴 DEBUG — ስህተት ዝርዝር';
        panel.appendChild(title);
        document.body.appendChild(panel);
    }
    const entry = document.createElement('pre');
    entry.style.cssText = 'margin:4px 0;padding:6px;background:#2a0000;border-radius:4px;white-space:pre-wrap;word-break:break-all;';
    entry.innerText = JSON.stringify(info, null, 2);
    panel.appendChild(entry);

    // Also run session debug fetch and show result
    fetch('/api/debug/session', { method: 'POST', credentials: 'include' })
        .then(r => r.json())
        .then(d => {
            const sess = document.createElement('pre');
            sess.style.cssText = 'margin:4px 0;padding:6px;background:#001a00;color:#99ff99;border-radius:4px;white-space:pre-wrap;word-break:break-all;';
            sess.innerText = '🔐 SESSION INFO:\n' + JSON.stringify(d, null, 2);
            panel.appendChild(sess);
        })
        .catch(err => {
            const sess = document.createElement('pre');
            sess.style.cssText = 'margin:4px 0;padding:6px;background:#001a00;color:#ff9999;border-radius:4px;';
            sess.innerText = '🔐 SESSION fetch failed: ' + err.message;
            panel.appendChild(sess);
        });
}

// ── Room Engine Debug Panel ──────────────────────────────────────────────────
window.showRoomDebugPanel = async function() {
    let panel = document.getElementById('_room_debug_panel');
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = '_room_debug_panel';
    panel.style.cssText = `
        position:fixed;top:0;left:0;right:0;z-index:99998;
        background:#000d1a;color:#7dd3fc;font-family:monospace;font-size:11px;
        padding:10px;max-height:70vh;overflow-y:auto;
        border-bottom:2px solid #0ea5e9;
    `;
    const closeBtn = document.createElement('button');
    closeBtn.innerText = '✕ ዝጋ';
    closeBtn.style.cssText = 'float:right;background:#0ea5e9;color:#fff;border:none;padding:3px 10px;border-radius:4px;cursor:pointer;margin-bottom:4px;';
    closeBtn.onclick = () => panel.remove();
    panel.appendChild(closeBtn);

    const refBtn = document.createElement('button');
    refBtn.innerText = '🔄 Refresh';
    refBtn.style.cssText = 'float:right;background:#1e40af;color:#fff;border:none;padding:3px 10px;border-radius:4px;cursor:pointer;margin:0 6px 4px 0;';
    refBtn.onclick = () => window.showRoomDebugPanel();
    panel.appendChild(refBtn);

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;color:#38bdf8;margin-bottom:8px;font-size:13px;clear:both;padding-top:4px;';
    title.innerText = '🔍 ROOM ENGINE DEBUG — ' + new Date().toLocaleTimeString();
    panel.appendChild(title);
    document.body.appendChild(panel);

    try {
        const res = await fetch('/api/debug/room', { credentials: 'include' });
        const data = await res.json();
        for (const [stake, info] of Object.entries(data.rooms || {})) {
            const block = document.createElement('div');
            block.style.cssText = 'margin:6px 0;padding:8px;background:#0c1a2e;border-radius:6px;border-left:3px solid ' +
                (info.thread_alive ? '#22c55e' : '#ef4444') + ';';

            const icon = info.memory_status === 'playing' ? '🎮' :
                         info.thread_alive ? '⏳' : '💀';

            block.innerHTML = `<span style="color:#f59e0b;font-weight:bold;font-size:12px;">${icon} ${stake} ETB Room</span>
<pre style="margin:4px 0;white-space:pre-wrap;word-break:break-all;color:${info.thread_alive ? '#86efac' : '#fca5a5'};">` +
`  Thread alive     : ${info.thread_alive ? '✅ YES' : '❌ NO — room loop is DEAD!'}
  Memory status     : ${info.memory_status}  (timer: ${info.memory_timer}s, balls: ${info.memory_balls})
  live DB count     : ${info.live_db_count}  (cached: ${info.cached_count ?? 'none'}, age: ${info.cache_age_s ?? '-'}s)
  DB tx count       : ${info.db_tx_count}   (session_id: ${info.db_room?.active_session_id ?? 'NULL'})
  card_select_time  : ${info.card_select_time}s
  ${info.db_room?.active_session_id == null
      ? '⚠️  PROBLEM: active_session_id is NULL — card count will always return 0!'
      : ''}
  ${info.db_error ? '❌ DB Error: ' + info.db_error : ''}</pre>`;
            panel.appendChild(block);
        }
        const settingsBlock = document.createElement('pre');
        settingsBlock.style.cssText = 'margin:6px 0;padding:8px;background:#0c1a2e;border-radius:6px;color:#a5b4fc;font-size:10px;white-space:pre-wrap;';
        settingsBlock.innerText = '⚙️ Settings cache:\n' + JSON.stringify(data.settings_cache, null, 2);
        panel.appendChild(settingsBlock);
    } catch(e) {
        const err = document.createElement('pre');
        err.style.cssText = 'color:#fca5a5;';
        err.innerText = '❌ Failed to load room debug: ' + e.message;
        panel.appendChild(err);
    }
};

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

function showWinnerModal(name, cardNumber, cardData, calledBalls, prize, isMe) {
    const modal = document.getElementById('winner-modal');
    if (!modal) return;

    // Title
    const titleEl = document.getElementById('winner-title');
    if (titleEl) titleEl.innerText = isMe ? '🏆 አሸንፈዋል!' : '🏆 አሸናፊ!';

    // Winner name
    const nameEl = document.getElementById('winner-display-name');
    if (nameEl) nameEl.innerText = name || '';

    // Card number badge
    const badgeEl = document.getElementById('winner-card-badge');
    if (badgeEl) badgeEl.innerText = cardNumber ? `ካርድ #${cardNumber}` : '';

    // Prize display
    const prizeEl = document.getElementById('winner-prize-display');
    if (prizeEl) {
        const amt = (prize || 0).toFixed(2);
        prizeEl.innerHTML = `<span class="prize-amount">+${amt}</span><span class="prize-currency"> ETB</span>`;
    }

    // Winning pattern identification
    const winInfo = identifyWinPattern(cardData, calledBalls || []);
    const patternEl = document.getElementById('winner-pattern-label');
    if (patternEl) patternEl.innerHTML = `⚡ ${winInfo.type}`;

    // Build BINGO column headers
    const headerEl = document.getElementById('winner-card-header');
    if (headerEl) {
        const colColors = { B: '#3b82f6', I: '#8b5cf6', N: '#22c55e', G: '#f59e0b', O: '#ef4444' };
        headerEl.innerHTML = '';
        ['B','I','N','G','O'].forEach(l => {
            const h = document.createElement('div');
            h.className = 'wcch-cell';
            h.innerText = l;
            h.style.color = colColors[l];
            headerEl.appendChild(h);
        });
    }

    // Build 5×5 card grid
    const cardCont = document.getElementById('winner-card-container');
    if (cardCont) {
        cardCont.innerHTML = '';
        const calledSet = new Set((calledBalls || []).map(n => Number(n)));
        const winCells = new Set(winInfo.cells.map(v => v === 'FREE' ? 'FREE' : Number(v)));
        if (cardData) {
            const letters = ['B','I','N','G','O'];
            for (let row = 0; row < 5; row++) {
                letters.forEach(l => {
                    const val = cardData[l][row];
                    const cell = document.createElement('div');
                    const isFree = val === 'FREE';
                    const numVal = isFree ? null : Number(val);
                    const isWin = isFree ? winCells.has('FREE') : winCells.has(numVal);
                    const isCalled = isFree || calledSet.has(numVal);
                    cell.className = 'wc-cell' + (isWin ? ' winning' : isCalled ? ' called' : '');
                    cell.innerText = isFree ? '★' : val;
                    cardCont.appendChild(cell);
                });
            }
        }
    }

    modal.classList.add('active');
    if (isMe) fetchAndSyncBalance();
}

socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'INIT') {
        currentRoom = data.room;
        const state = getRoomState(currentRoom);
        state.takenCards = data.takenCards || [];
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
            getRoomState(currentRoom).takenCards = data.takenCards[currentRoom];
            createAvailableCards();
        }
        updateRoomStats(data.stats, data.prizes);
    } else if (data.type === 'BALANCE_UPDATE') {
        fetchAndSyncBalance();
    }
};

// startTimerSystem() is called inside initApp() after createStakeList() builds the DOM elements.

    const submitDeposit = document.getElementById('submit-deposit');
    if (submitDeposit) {
        submitDeposit.onclick = async () => {
            const amount   = document.getElementById('deposit-amount').value;
            const method   = document.getElementById('deposit-method').value;
            const code     = document.getElementById('deposit-code').value.trim();
            const statusEl = document.getElementById('deposit-status');

            if (!method) {
                if (statusEl) { statusEl.innerText = "⚠️ ዘዴ ይምረጡ"; statusEl.style.color = "#f59e0b"; }
                return;
            }
            if (!amount || parseFloat(amount) < 1) {
                if (statusEl) { statusEl.innerText = "⚠️ መጠን ያስገቡ (ቢያንስ 1 ETB)"; statusEl.style.color = "#f59e0b"; }
                return;
            }
            if (!code) {
                if (statusEl) { statusEl.innerText = "⚠️ Transaction code ያስገቡ"; statusEl.style.color = "#f59e0b"; }
                return;
            }

            submitDeposit.disabled  = true;
            submitDeposit.innerText = 'Sending...';
            try {
                const response = await fetch('/api/deposit-request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount, method, code })
                });
                const data = await response.json();
                if (response.ok) {
                    if (statusEl) { statusEl.innerText = data.message; statusEl.style.color = "#22c55e"; }
                    document.getElementById('deposit-code').value   = '';
                    document.getElementById('deposit-amount').value = '';
                } else {
                    if (statusEl) { statusEl.innerText = data.error || "ስህተት አጋጥሟል"; statusEl.style.color = "#ef4444"; }
                }
            } catch (err) {
                if (statusEl) { statusEl.innerText = "❌ Network error"; statusEl.style.color = "#ef4444"; }
            }
            submitDeposit.disabled  = false;
            submitDeposit.innerText = '✅ ጠይቅ / Submit Request';
        };
    }


    // Bingo is now fully auto-claimed server-side — no manual button needed.

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

function _buildMasterGrid(masterGrid) {
    masterGrid.innerHTML = '';
    for (let row = 0; row < 15; row++) {
        for (let col = 0; col < 5; col++) {
            const num = (col * 15) + row + 1;
            const cell = document.createElement('div');
            cell.className = 'master-cell';
            cell.id = `mcell-${num}`;
            cell.innerText = num;
            masterGrid.appendChild(cell);
        }
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

    // ── Master Grid: build once, update classes only (no full rebuild) ──
    const masterGrid = document.getElementById('master-grid');
    if (masterGrid) {
        if (masterGrid.children.length !== 75) _buildMasterGrid(masterGrid);
        const calledSetMG = new Set(history.map(n => Number(n)));
        const lastBallMG  = history.length > 0 ? Number(history[history.length - 1]) : null;
        for (let num = 1; num <= 75; num++) {
            const cell = document.getElementById(`mcell-${num}`);
            if (!cell) continue;
            const isCalled = calledSetMG.has(num);
            const isLast   = num === lastBallMG;
            cell.classList.toggle('called',      isCalled || isLast);
            cell.classList.toggle('last-called', isLast);
        }
    }

    // Update top bar stats
    if (currentRoom) {
        const derashEl  = document.getElementById('derash');
        const playersEl = document.getElementById('players');
        const betEl     = document.getElementById('bet');
        if (derashEl  && globalPrizes[currentRoom]) derashEl.innerText  = globalPrizes[currentRoom].toFixed(0);
        if (playersEl && globalStats[currentRoom])  playersEl.innerText = globalStats[currentRoom];
        if (betEl) betEl.innerText = currentRoom;
    }

    if (history.length === 0) {
        activeBall.innerHTML = '<span>--</span>';
        recentBalls.innerHTML = '';
        if (state.myGameCard) renderMyGameCard();
        return;
    }

    const lastBall = Number(history[history.length - 1]);
    const letter   = getBallLetter(lastBall);
    activeBall.innerHTML = `<span style="background:${colors[letter]};color:white;">${letter}${lastBall}</span>`;

    // ── Player card auto-marking ──────────────────────────────────────────
    if (autoMarking) {
        const calledSet = new Set(history.map(n => Number(n)));

        document.querySelectorAll('#bingo-board [id^="cell-"]').forEach(el => {
            const n = parseInt(el.id.slice(5), 10);
            const shouldMark = calledSet.has(n);
            if (!shouldMark && el.classList.contains('called')) {
                el.classList.remove('called', 'newly-called');
            } else if (shouldMark && !el.classList.contains('called')) {
                el.classList.add('called');
                if (n === lastBall) {
                    el.classList.add('newly-called');
                    setTimeout(() => el.classList.remove('newly-called'), 800);
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
    const cols = {
        B: { bg: 'rgba(59,130,246,0.18)',  border: 'rgba(59,130,246,0.45)',  text: '#93c5fd', hdr: '#3b82f6',  hdrBg: 'rgba(59,130,246,0.15)'  },
        I: { bg: 'rgba(139,92,246,0.18)',  border: 'rgba(139,92,246,0.45)', text: '#c4b5fd', hdr: '#a78bfa', hdrBg: 'rgba(139,92,246,0.15)' },
        N: { bg: 'rgba(245,158,11,0.18)',  border: 'rgba(245,158,11,0.45)', text: '#fde68a', hdr: '#fbbf24', hdrBg: 'rgba(245,158,11,0.15)' },
        G: { bg: 'rgba(34,197,94,0.18)',   border: 'rgba(34,197,94,0.45)',  text: '#86efac', hdr: '#4ade80',  hdrBg: 'rgba(34,197,94,0.15)'  },
        O: { bg: 'rgba(239,68,68,0.18)',   border: 'rgba(239,68,68,0.45)',  text: '#fca5a5', hdr: '#f87171',  hdrBg: 'rgba(239,68,68,0.15)'  },
    };
    letters.forEach(l => {
        const c = cols[l];
        const header = document.createElement('div');
        header.className = 'preview-header';
        header.innerText = l;
        header.style.cssText = `background:${c.hdrBg};color:${c.hdr};border:1px solid ${c.border};`;
        container.appendChild(header);
    });
    for (let row = 0; row < 5; row++) {
        letters.forEach(l => {
            const c = cols[l];
            const cell = document.createElement('div');
            cell.className = 'preview-cell';
            if (cardData[l][row] === 'FREE') {
                cell.classList.add('free-spot');
                cell.innerText = '★';
                cell.style.cssText = `background:linear-gradient(135deg,rgba(245,158,11,0.28),rgba(234,179,8,0.18));border:1px solid rgba(245,158,11,0.55);color:#fbbf24;text-shadow:0 0 8px rgba(251,191,36,0.6);`;
            } else {
                cell.innerText = cardData[l][row];
                cell.style.cssText = `background:${c.bg};border:1px solid ${c.border};color:${c.text};`;
            }
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
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' }
            );
            if (res.status === 401 || res.redirected) {
                showToast('❌ ክፍለ ጊዜ አልፏል። እባክዎ ዳግም ይግቡ።');
                setTimeout(() => { window.location.href = '/login'; }, 1500);
                return;
            }
            const rawText = await res.text();
            let data;
            try {
                data = JSON.parse(rawText);
            } catch (parseErr) {
                _showDebugPanel({
                    phase: 'JSON parse failed',
                    status: res.status,
                    redirected: res.redirected,
                    url: res.url,
                    rawBody: rawText.substring(0, 600),
                    parseError: parseErr.message
                });
                return;
            }
            if (!res.ok && !data.success) {
                _showDebugPanel({
                    phase: 'Server error response',
                    status: res.status,
                    message: data.message,
                    detail: data.detail || '(no detail)'
                });
                showToast(`❌ ${data.message || 'ስህተት ተፈጥሯል'}`);
                return;
            }

            if (data.success) {
                // Commit card to game state
                state.myGameCard = state.currentCardData;
                state.purchasedCard = state.currentSelectedCard;

                // Update balance from server response
                if (typeof data.new_balance === 'number') {
                    userBalance = data.new_balance;
                    if (typeof data.deposit_balance === 'number') userDepositBalance = data.deposit_balance;
                    if (typeof data.bonus_balance   === 'number') userBonusBalance   = data.bonus_balance;
                    const dep   = userDepositBalance;
                    const bonus = userBonusBalance;
                    const total = userBalance;
                    const rounded = Math.round(total);
                    const balEls = {
                        'sel-balance':          total.toFixed(2),
                        'wallet-balance-value': total.toFixed(2),
                        'walletBalance':        total.toFixed(2),
                        'profile-balance':      total.toFixed(2),
                        'sel-main-wallet':      rounded,
                        'sel-play-wallet':      rounded,
                        'wallet-deposit-value':   dep.toFixed(2),
                        'wallet-bonus-value':     bonus.toFixed(2),
                        'withdraw-balance-value': dep.toFixed(2),
                        'withdraw-bonus-display': bonus.toFixed(2),
                    };
                    Object.entries(balEls).forEach(([id, val]) => {
                        const el = document.getElementById(id);
                        if (el) el.innerText = val;
                    });
                }

                // Mark this card taken locally and re-render the grid.
                // createAvailableCards() now applies both 'taken' and 'my-card'
                // classes automatically based on purchasedCard, so no separate
                // post-loop highlighting step is needed.
                if (!state.takenCards.includes(state.currentSelectedCard)) {
                    state.takenCards.push(state.currentSelectedCard);
                }
                createAvailableCards();

                const myBoardLabel = document.getElementById('sel-my-board');
                if (myBoardLabel) myBoardLabel.innerText = `#${state.currentSelectedCard}`;

                previewOverlay.classList.remove('active');
                showToast(`✅ ካርድ #${state.currentSelectedCard} ተገዝቷል!`);
                // Auto-show room debug panel so user can see engine state
                setTimeout(() => window.showRoomDebugPanel(), 1500);
            } else {
                showToast(`❌ ${data.message || 'ካርዱ ሊገዛ አልተቻለም'}`);
                previewOverlay.classList.remove('active');
            }
        } catch (e) {
            _showDebugPanel({ phase: 'fetch threw exception', error: e.message, stack: e.stack });
            showToast('❌ ግንኙነት ተሳስቷል። እባክዎ ዳግም ሞክሩ።');
        } finally {
            confirmCard.disabled = false;
            confirmCard.innerText = '✓ ግዛ / Buy';
        }
    };
}

function _buildStakeRow(amount) {
    const row = document.createElement('div');
    row.className = 'stake-row premium';
    row.dataset.stake = amount;
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
    return row;
}

async function createStakeList() {
    const list = document.getElementById('stake-list');
    if (!list) return;

    // Try to load rooms dynamically from server
    let serverStakes = null;
    try {
        const res = await fetch('/api/room-status');
        if (res.ok) {
            const data = await res.json();
            serverStakes = Object.keys(data).map(Number).sort((a, b) => a - b);
        }
    } catch (e) { /* fallback to STAKES */ }

    const stakes = serverStakes || STAKES;
    STAKES = stakes;

    // Check if the DOM already matches — skip full rebuild if so
    const existing = Array.from(list.querySelectorAll('.stake-row[data-stake]')).map(el => parseInt(el.dataset.stake));
    const same = existing.length === stakes.length && stakes.every((s, i) => s === existing[i]);
    if (same) return;

    list.innerHTML = '';
    stakes.forEach(amount => list.appendChild(_buildStakeRow(amount)));
}

window.joinStake = (amount) => {
    currentRoom = amount;
    // Reset prev-status for this stake so _syncTimers sees the current state as
    // "fresh" on its next tick — fixes the race where _prevRoomStatus already
    // holds 'playing' (set before the player joined) and the transition never fires.
    delete _prevRoomStatus[String(amount)];
    // Reset the card-count tracker so the very first _syncTimers tick after
    // joining always triggers a taken-cards refresh, even if the count is the
    // same as whatever was cached from a previous visit to this room.
    delete _lastCardCount[String(amount)];
    _gameStarted[amount] = false;
    // Reset taken cards immediately when entering a room so stale data is cleared
    getRoomState(amount).takenCards = [];
    createAvailableCards();
    // Fetch fresh taken cards for this room's current session
    fetchTakenCards(amount);
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
};

async function initApp() {
    // Handle Telegram link callback status from URL params
    (function _handleTgLinkStatus() {
        const params = new URLSearchParams(window.location.search);
        const status = params.get('tg_link');
        if (!status) return;
        // Clean the URL so refresh doesn't re-trigger
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
        const messages = {
            ok:      { text: '✅ Telegram account ተያያዘ!',              color: '#4ade80' },
            fail:    { text: '❌ Telegram verification ሳይሳካ ቀረ',        color: '#f87171' },
            expired: { text: '⏰ Auth token ጊዜው አልፏል — ዳግም ሞክሩ',      color: '#f59e0b' },
            taken:   { text: '⚠️ ይህ Telegram account ሌላ user ላይ አለ',   color: '#f59e0b' },
        };
        const m = messages[status];
        if (m) {
            setTimeout(() => {
                showToast(m.text);
                // Navigate to profile so user sees the updated card
                navTo('profile');
            }, 400);
        }
    })();

    createBingoNumbers();
    await createStakeList(); // builds stake-timer-* / stake-count-* / stake-prize-* elements
    createAvailableCards();

    // Start server-driven timer system AFTER DOM elements exist
    startTimerSystem();

    // Fetch fresh balance from DB immediately on load, then every 15 seconds
    fetchAndSyncBalance();
    setInterval(fetchAndSyncBalance, 20000);

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
let userBalance        = (typeof window.INITIAL_BALANCE === 'number') ? window.INITIAL_BALANCE : 0;
let userDepositBalance = (typeof window.INITIAL_DEPOSIT_BALANCE === 'number') ? window.INITIAL_DEPOSIT_BALANCE : 0;
let userBonusBalance   = (typeof window.INITIAL_BONUS_BALANCE === 'number') ? window.INITIAL_BONUS_BALANCE : 0;

// Central balance sync — always fetches fresh value from DB
async function fetchAndSyncBalance() {
    try {
        const token = localStorage.getItem('bingo_token');
        const res = await fetch('/api/user/balance', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        const dep   = typeof data.balance       === 'number' ? data.balance       : 0;
        const bonus = typeof data.bonus_balance === 'number' ? data.bonus_balance : 0;
        const total = typeof data.total_balance === 'number' ? data.total_balance : dep + bonus;
        userDepositBalance = dep;
        userBonusBalance   = bonus;
        userBalance        = total;
        const rounded = Math.round(total);
        const els = {
            'sel-balance':          total.toFixed(2),
            'wallet-balance-value': total.toFixed(2),
            'walletBalance':        total.toFixed(2),
            'profile-balance':      total.toFixed(2),
            'sel-main-wallet':      rounded,
            'sel-play-wallet':      rounded,
            'wallet-deposit-value':   dep.toFixed(2),
            'wallet-bonus-value':     bonus.toFixed(2),
            'withdraw-balance-value': dep.toFixed(2),
            'withdraw-bonus-display': bonus.toFixed(2),
        };
        Object.entries(els).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el) el.innerText = val;
        });

        // Update bonus expiry display
        const expiryRow  = document.getElementById('wallet-bonus-expiry');
        const expiryDate = document.getElementById('wallet-bonus-expiry-date');
        if (expiryRow && expiryDate) {
            if (bonus > 0 && data.bonus_expires_at) {
                const d = new Date(data.bonus_expires_at);
                const daysLeft = Math.ceil((d - Date.now()) / 86400000);
                const dateStr = d.toLocaleDateString('am-ET', {year:'numeric', month:'short', day:'numeric'});
                expiryDate.innerText = `${dateStr} (${daysLeft} ቀን)`;
                expiryRow.style.display = 'block';
                expiryRow.style.color = daysLeft <= 3 ? '#ef4444' : '#92400e';
            } else {
                expiryRow.style.display = 'none';
            }
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

function startGameStatePoll(stake) {
    stopGameStatePoll();
    const rs = getRoomState(stake);
    rs.lastBallCount = 0;
    rs.winnerShown = false;
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

        const rs = getRoomState(stake);

        // ── Auto-claim: winner announced by server (check FIRST, before status gate) ──
        if (data.winner && !rs.winnerShown) {
            rs.winnerShown = true;
            stopGameStatePoll();
            const isMe = (data.winner === (window.CURRENT_USERNAME || ''));
            showWinnerModal(data.winner, data.winner_card, data.winner_card_data, data.balls, data.prize, isMe);
            if (typeof playWinnerFanfare === 'function') playWinnerFanfare();
            setTimeout(() => {
                const modal = document.getElementById('winner-modal');
                if (modal) modal.classList.remove('active');
                handleGameOverReturn(stake);
            }, WINNER_DISPLAY_SECONDS * 1000);
            return;
        }

        if (data.status !== 'playing') {
            stopGameStatePoll();
            return;
        }

        // Update board only when new balls have been called
        if (data.balls && data.balls.length !== rs.lastBallCount) {
            rs.lastBallCount = data.balls.length;
            updateGameUI(data.balls);
            // Flash latest ball + always play ball-call sound
            const latest = data.balls[data.balls.length - 1];
            if (latest) {
                const letter = getBallLetter(latest);
                const ab = document.getElementById('active-ball');
                if (ab) {
                    ab.innerHTML = `<span style="background:${colors[letter]};color:white;">${letter}${latest}</span>`;
                    ab.classList.add('ball-flash');
                    setTimeout(() => ab.classList.remove('ball-flash'), 600);
                }
                if (typeof playBallCall === 'function') playBallCall();
                checkMyCardForBingo(data.balls);
            }
        }
    } catch (e) { /* silent */ }
}

const WINNER_DISPLAY_SECONDS = 12;

function _detectBingo(cardData, calledBalls) {
    if (!cardData || !calledBalls) return false;
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
    for (const row of grid) if (row.every(Boolean)) return true;
    for (let c = 0; c < 5; c++) if (grid.every(r => r[c])) return true;
    if (grid.every((r, i) => r[i])) return true;
    if (grid.every((r, i) => r[4 - i])) return true;
    return false;
}

async function checkMyCardForBingo(calledBalls) {
    const state = getRoomState(currentRoom);
    if (!state.myGameCard || state.bingoFlashed || state.autoClaimInProgress) return;

    const hasBingo = _detectBingo(state.myGameCard, calledBalls);
    if (!hasBingo) return;

    // Lock immediately to prevent duplicate claims
    state.bingoFlashed = true;
    state.autoClaimInProgress = true;

    showToast('🎉 ቢንጎ ተገኝቷል! ክሌም እየተደረገ ነው...');

    try {
        const res = await fetch(`/api/bingo-claim/${currentRoom}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ card_number: state.purchasedCard })
        });

        if (!res.ok) {
            // Non-200 — game may have already been won by someone else
            const errData = await res.json().catch(() => ({}));
            showToast(`ቢንጎ: ${errData.message || 'ክሌም አልተቻለም'}`);
            state.autoClaimInProgress = false;
            return;
        }

        const data = await res.json();

        if (data.valid) {
            // Stop ball-calling immediately — game is won
            stopGameStatePoll();

            if (typeof playWinnerFanfare === 'function') playWinnerFanfare();
            showToast('🏆 ቢንጎ! አሸንፈዋል! ሽልማት ወደ ባላንስዎ ተጨምሯል።');

            // Highlight winning cells on the physical card UI
            const winInfo = identifyWinPattern(state.myGameCard, calledBalls);
            if (winInfo.cells && winInfo.cells.length) {
                winInfo.cells.forEach(val => {
                    if (val === 'FREE') return;
                    const el = document.getElementById(`cell-${val}`);
                    if (el) {
                        el.classList.add('win-highlight');
                        el.style.animation = 'win-pulse 0.6s ease-in-out infinite alternate';
                    }
                });
            }

            // Show winner modal to the claimant immediately
            showWinnerModal(
                window.CURRENT_USERNAME || 'You',
                state.purchasedCard,
                state.myGameCard,
                calledBalls,
                data.prize || 0,
                true
            );

            // Return to lobby after showing the win
            setTimeout(() => {
                const wm = document.getElementById('winner-modal');
                if (wm) wm.classList.remove('active');
                handleGameOverReturn(currentRoom);
            }, 8000);
        } else {
            showToast(`ቢንጎ: ${data.message || 'ክሌም ተቀባይነት አላገኘም'}`);
        }
    } catch (e) {
        showToast('⚠️ ቢንጎ ክሌም ግንኙነት ተሳስቷል — ዳግም ሞክሩ');
        // Reset flag so the next ball poll can retry
        state.bingoFlashed = false;
    } finally {
        state.autoClaimInProgress = false;
    }
}

function startGame() {
    navTo('game');
    const state = getRoomState(currentRoom);
    if (state.purchasedCard && !state.myGameCard) {
        state.myGameCard = state.currentCardData;
    }
    state.bingoFlashed = false;
    state.autoClaimInProgress = false;
    state.winnerShown = false;
    state.lastBallCount = 0;
    renderMyGameCard();
    // Show player's card number in game header
    const myBoardEl = document.getElementById('sel-my-board-game');
    if (myBoardEl) myBoardEl.innerText = state.purchasedCard ? `#${state.purchasedCard}` : '--';
    // Reset game board
    updateGameUI([]);
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
    if (screenId === 'withdraw') loadWithdrawHistory();
    if (screenId === 'deposit') loadDepositMethods();

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

    // Load daily streak
    try {
        const sr = await fetch('/api/user/streak');
        if (sr.ok) {
            const sd = await sr.json();
            const streak      = sd.streak || 0;
            const playedToday = sd.played_today || false;
            const rewards     = sd.rewards || [2,2,2,2,2,2,10];
            const nextReward  = sd.next_reward || rewards[0];

            const countEl  = document.getElementById('streak-count');
            const nextEl   = document.getElementById('streak-next-reward');
            const badgeEl  = document.getElementById('streak-played-badge');
            const dotsEl   = document.getElementById('streak-dots');
            const rewRow   = document.getElementById('streak-rewards-row');

            if (countEl)  countEl.innerText  = streak;
            if (nextEl)   nextEl.innerText   = playedToday ? rewards[Math.min(streak, rewards.length-1)] : nextReward;
            if (badgeEl)  badgeEl.style.display = playedToday ? 'inline-block' : 'none';

            if (dotsEl) {
                const posInCycle = streak % 7;
                dotsEl.innerHTML = rewards.map((_, i) => {
                    const done = (streak >= 7) ? true : i < posInCycle;
                    const isCurrent = i === (posInCycle === 0 && streak > 0 ? 6 : posInCycle - 1) && streak > 0;
                    const color = done ? '#f59e0b' : '#1e2435';
                    const border = isCurrent ? '2px solid #f59e0b' : (done ? 'none' : '1px solid #374151');
                    const size = isCurrent ? '30px' : '26px';
                    return `<div style="width:${size};height:${size};border-radius:50%;background:${color};border:${border};display:flex;align-items:center;justify-content:center;transition:all 0.3s;">
                        ${done ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="white"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                    </div>`;
                }).join('');
            }

            if (rewRow) {
                const dayLabels = ['1','2','3','4','5','6','7+'];
                rewRow.innerHTML = rewards.map((r, i) => {
                    const posInCycle = streak % 7;
                    const isDone = streak > 0 && (streak >= 7 ? true : i < posInCycle);
                    const isCurrent = i === posInCycle && !playedToday;
                    const bg = isCurrent ? 'rgba(245,158,11,0.2)' : (isDone ? 'rgba(245,158,11,0.08)' : 'transparent');
                    const col = isCurrent ? '#fbbf24' : (isDone ? '#f59e0b' : '#4b5563');
                    const bdr = isCurrent ? '1px solid rgba(245,158,11,0.4)' : 'none';
                    return `<div style="text-align:center;border-radius:8px;padding:5px 2px;background:${bg};border:${bdr};">
                        <div style="font-size:0.55rem;color:#6b7280;font-weight:700;">D${dayLabels[i]}</div>
                        <div style="font-size:0.72rem;font-weight:800;color:${col};margin-top:1px;">${r}</div>
                    </div>`;
                }).join('');
            }
        }
    } catch(e) { /* silent */ }

    // Load referral stats
    try {
        const rr = await fetch('/api/user/referral');
        if (!rr.ok) return;
        const rd = await rr.json();
        const refCountEl     = document.getElementById('ref-count');
        const refConfirmedEl = document.getElementById('ref-confirmed');
        const refEarnedEl    = document.getElementById('ref-earned');
        const refLinkBox     = document.getElementById('ref-link-box');
        if (refCountEl)     refCountEl.innerText     = rd.referred_count;
        if (refConfirmedEl) refConfirmedEl.innerText = rd.confirmed_count;
        if (refEarnedEl)    refEarnedEl.innerText    = rd.bonus_earned.toFixed(2);
        const botUsername = rd.bot_username || '';
        const link = botUsername
            ? `https://t.me/${botUsername}?start=${rd.referral_code}`
            : window.location.origin + '/signup?ref=' + rd.referral_code;
        if (refLinkBox) {
            refLinkBox.innerText    = link;
            refLinkBox.dataset.link = link;
        }
    } catch (e) { /* silent */ }
}

function _getReferralLink() {
    const box = document.getElementById('ref-link-box');
    return (box && box.dataset.link) ? box.dataset.link : (box ? box.innerText.trim() : '');
}

function copyReferralLink() {
    const link = _getReferralLink();
    const statusEl  = document.getElementById('ref-copy-status');
    const labelEl   = document.getElementById('ref-copy-label');
    if (!link || link === 'Loading...') {
        if (statusEl) { statusEl.innerText = '⚠️ Link ገና አልተዘጋጀም'; statusEl.style.color = '#f59e0b'; }
        return;
    }

    const _onCopied = () => {
        if (labelEl)  { labelEl.innerText = 'Copied! ✓'; setTimeout(() => { labelEl.innerText = 'Copy Link'; }, 2200); }
        if (statusEl) { statusEl.innerText = '✅ Link ተቀዳ!'; statusEl.style.color = '#4ade80'; setTimeout(() => { statusEl.innerText = ''; }, 2500); }
    };
    const _onFail = () => {
        // Fallback: create a temp textarea and execCommand
        try {
            const ta = document.createElement('textarea');
            ta.value = link;
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            _onCopied();
        } catch {
            if (statusEl) { statusEl.innerText = '⚠️ Manually copy: ' + link; statusEl.style.color = '#f59e0b'; }
        }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(_onCopied).catch(_onFail);
    } else {
        _onFail();
    }
}

function shareReferralLink() {
    const link     = _getReferralLink();
    const statusEl = document.getElementById('ref-copy-status');
    if (!link || link === 'Loading...') return;

    const shareData = {
        title: '🎮 Nova Bingo — ይጫወቱ ያሸንፉ!',
        text:  '🏆 Nova Bingo ይቀላቀሉ — ካርድ ይግዙ ያሸንፉ! ሲቀላቀሉ ሁለታቹም bonus ትቀበሉ 🎉\n',
        url:   link,
    };

    if (navigator.share) {
        navigator.share(shareData).catch(() => {});
    } else {
        // Fallback: copy the message + link
        const fullText = shareData.text + link;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(fullText).then(() => {
                if (statusEl) { statusEl.innerText = '✅ Share message copied!'; statusEl.style.color = '#60a5fa'; setTimeout(() => { statusEl.innerText = ''; }, 2500); }
            }).catch(() => copyReferralLink());
        } else {
            copyReferralLink();
        }
    }
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
        const amount   = parseFloat(document.getElementById('withdraw-amount').value);
        const method   = document.getElementById('withdraw-method').value;
        const account  = document.getElementById('withdraw-account').value.trim();
        const statusEl = document.getElementById('withdraw-status');

        if (isNaN(amount) || amount < 50) {
            if (statusEl) { statusEl.innerText = '⚠️ ዝቅተኛ ማስወጣት 50 ETB ነው'; statusEl.style.color = '#f59e0b'; }
            return;
        }
        if (!account) {
            if (statusEl) { statusEl.innerText = '⚠️ Account number / phone ያስገቡ'; statusEl.style.color = '#f59e0b'; }
            return;
        }

        submitWithdraw.disabled  = true;
        submitWithdraw.innerText = 'Sending...';
        try {
            const res  = await fetch('/api/withdraw-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount, method, account })
            });
            const data = await res.json();
            if (statusEl) {
                statusEl.innerText    = data.message || data.error;
                statusEl.style.color  = res.ok ? '#22c55e' : '#ef4444';
            }
            if (res.ok && data.success) {
                userBalance = Math.max(0, userBalance - amount);
                updateUserData({ balance: userBalance });
                document.getElementById('withdraw-amount').value  = '';
                document.getElementById('withdraw-account').value = '';
                loadWithdrawHistory();
            }
        } catch (e) {
            if (statusEl) { statusEl.innerText = '❌ Network error'; statusEl.style.color = '#ef4444'; }
        }
        submitWithdraw.disabled  = false;
        submitWithdraw.innerText = 'ጠይቅ / Request';
    };
}

let _depositMethodsCache = [];

async function loadDepositMethods() {
    try {
        const res  = await fetch('/api/payment-methods');
        if (!res.ok) return;
        const methods = await res.json();
        _depositMethodsCache = methods;

        const sel = document.getElementById('deposit-method');
        if (!sel) return;
        sel.innerHTML = '<option value="">— ዘዴ ይምረጡ —</option>';
        methods.forEach(m => {
            const opt = document.createElement('option');
            opt.value       = m.key;
            opt.textContent = m.label;
            sel.appendChild(opt);
        });
        // Hide info banner until a method is chosen
        const infoEl    = document.getElementById('deposit-pay-info');
        const noMethEl  = document.getElementById('deposit-no-method');
        if (infoEl)   infoEl.style.display   = 'none';
        if (noMethEl) noMethEl.style.display  = 'none';
    } catch (e) { /* silent */ }
}

const _methodIcons = { telebirr: '📱', cbe: '🏦', awash: '🏦' };

window.onDepositMethodChange = function () {
    const key     = document.getElementById('deposit-method')?.value;
    const infoEl  = document.getElementById('deposit-pay-info');
    const noMeth  = document.getElementById('deposit-no-method');
    if (!key) {
        if (infoEl)  infoEl.style.display  = 'none';
        if (noMeth)  noMeth.style.display   = 'none';
        return;
    }
    const m = _depositMethodsCache.find(x => x.key === key);
    if (!m || !m.account) {
        if (infoEl)  infoEl.style.display  = 'none';
        if (noMeth)  noMeth.style.display   = 'block';
        return;
    }
    if (noMeth)  noMeth.style.display   = 'none';
    if (infoEl)  infoEl.style.display   = 'block';
    const icon = document.getElementById('deposit-method-icon');
    const lbl  = document.getElementById('deposit-pay-label');
    const name = document.getElementById('deposit-pay-name');
    const acct = document.getElementById('deposit-pay-account');
    if (icon) icon.innerText = _methodIcons[key] || '💳';
    if (lbl)  lbl.innerText  = m.label;
    if (name) name.innerText = m.name || '—';
    if (acct) acct.innerText = m.account;
};

window.copyDepositAccount = function () {
    const acct = document.getElementById('deposit-pay-account')?.innerText;
    if (!acct || acct === '—') return;
    navigator.clipboard.writeText(acct).then(() => {
        _showToast('✅ Account number copied!', 'success');
    }).catch(() => { /* fallback */ });
};

async function loadWithdrawHistory() {
    const el = document.getElementById('withdraw-history-list');
    if (!el) return;
    try {
        const res  = await fetch('/api/user/my-withdrawals');
        if (!res.ok) return;
        const list = await res.json();
        if (!list.length) {
            el.innerHTML = '<p style="text-align:center;color:#475569;font-size:0.8rem;padding:12px 0;">No withdrawal requests yet.</p>';
            return;
        }
        const badge = s => {
            const cfg = { pending: ['#f59e0b','rgba(245,158,11,0.15)','⏳'], approved: ['#22c55e','rgba(34,197,94,0.15)','✅'], rejected: ['#ef4444','rgba(239,68,68,0.15)','❌'] };
            const [c, bg, icon] = cfg[s] || ['#94a3b8','rgba(148,163,184,0.15)','•'];
            return `<span style="font-size:0.68rem;font-weight:700;color:${c};background:${bg};border-radius:6px;padding:2px 7px;">${icon} ${s.toUpperCase()}</span>`;
        };
        el.innerHTML = list.map(w => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#161b22;border-radius:10px;margin-bottom:6px;border:1px solid rgba(255,255,255,0.06);">
            <div>
                <div style="font-size:0.8rem;font-weight:700;color:#e2e8f0;">${w.method.toUpperCase()} · <span style="font-family:monospace;color:#94a3b8;">${w.account_details}</span></div>
                <div style="font-size:0.68rem;color:#64748b;margin-top:2px;">${w.created_at}</div>
            </div>
            <div style="text-align:right;">
                <div style="font-size:0.95rem;font-weight:900;color:#ef4444;">-${parseFloat(w.amount).toFixed(2)} ETB</div>
                <div style="margin-top:3px;">${badge(w.status)}</div>
            </div>
        </div>`).join('');
    } catch (e) { /* silent */ }
}

// Admin UI Switcher
let _roomsRefreshId = null;

window.switchAdminTab = (tab) => {
    document.querySelectorAll('.admin-tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(`admin-${tab}-tab`).classList.add('active');
    event.target.classList.add('active');

    // Stop rooms auto-refresh when leaving that tab
    if (_roomsRefreshId && tab !== 'rooms') {
        clearInterval(_roomsRefreshId);
        _roomsRefreshId = null;
    }

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
    const statusEl     = document.getElementById('settings-status');
    const minEl        = document.getElementById('settings-min-cards');
    const countEl      = document.getElementById('settings-countdown');
    const feeEl        = document.getElementById('settings-house-fee');
    const refBonEl     = document.getElementById('settings-referral-bonus');
    const bonExpEl     = document.getElementById('settings-bonus-expiry-days');
    const wMinEl       = document.getElementById('settings-withdraw-min');
    const wMaxEl       = document.getElementById('settings-withdraw-max');
    const strAutoEl    = document.getElementById('settings-streak-auto-msg');
    const strMsEl      = document.getElementById('settings-streak-milestone-msg');

    if (statusEl) { statusEl.innerText = 'Loading...'; statusEl.style.color = '#6b7280'; }

    try {
        const res  = await fetch('/api/admin/settings', { headers: _ah() });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (countEl)   countEl.value   = data.card_select_time;
        if (feeEl)     feeEl.value     = data.house_fee_pct;
        if (refBonEl)  refBonEl.value  = data.referral_bonus;
        if (bonExpEl)  bonExpEl.value  = data.bonus_expiry_days ?? 30;
        if (wMinEl)    wMinEl.value    = data.withdraw_min;
        if (wMaxEl)    wMaxEl.value    = data.withdraw_max;
        if (strAutoEl) strAutoEl.value = data.streak_auto_msg      || '';
        if (strMsEl)   strMsEl.value   = data.streak_milestone_msg || '';

        // Render payment method cards
        const pmListEl = document.getElementById('admin-payment-methods-list');
        if (pmListEl && Array.isArray(data.payment_methods)) {
            pmListEl.innerHTML = data.payment_methods.map(m => `
            <div style="background:#1e2435;border-radius:12px;padding:16px;border:1px solid rgba(59,130,246,0.15);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <span style="font-weight:800;font-size:0.88rem;">${m.label}</span>
                    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                        <input type="checkbox" id="pm-${m.key}-enabled" ${m.enabled ? 'checked' : ''}
                            style="width:16px;height:16px;accent-color:#3b82f6;">
                        <span style="font-size:0.75rem;color:#94a3b8;font-weight:600;">Active</span>
                    </label>
                </div>
                <div style="display:grid;gap:8px;">
                    <div>
                        <label style="font-size:0.68rem;color:#64748b;font-weight:700;display:block;margin-bottom:4px;">ACCOUNT NUMBER / PHONE</label>
                        <input type="text" id="pm-${m.key}-account" value="${m.account || ''}"
                            class="form-input" placeholder="e.g. 0912345678 or account number"
                            style="font-family:monospace;font-size:0.9rem;">
                    </div>
                    <div>
                        <label style="font-size:0.68rem;color:#64748b;font-weight:700;display:block;margin-bottom:4px;">ACCOUNT HOLDER NAME</label>
                        <input type="text" id="pm-${m.key}-name" value="${m.name || ''}"
                            class="form-input" placeholder="e.g. Nova Bingo Ltd">
                    </div>
                </div>
            </div>`).join('');
        }

        if (statusEl) {
            statusEl.innerText = `✅ Loaded — card selection: ${data.card_select_time}s, fee: ${data.house_fee_pct}%, referral: ${data.referral_bonus} ETB, bonus expiry: ${data.bonus_expiry_days ?? 30} days`;
            statusEl.style.color = '#22c55e';
        }
    } catch (e) {
        if (statusEl) { statusEl.innerText = '❌ Failed to load settings.'; statusEl.style.color = '#ef4444'; }
    }

    const saveBtn = document.getElementById('settings-save-btn');
    if (saveBtn) {
        saveBtn.onclick = async () => {
            const cntVal    = parseInt(countEl  ? countEl.value  : '20');
            const feeVal    = parseInt(feeEl    ? feeEl.value    : '10');
            const refBonVal = parseFloat(refBonEl ? refBonEl.value : '5');
            const bonExpVal = parseInt(bonExpEl ? bonExpEl.value : '30');
            const wMinVal   = parseFloat(wMinEl ? wMinEl.value : '50');
            const wMaxVal   = parseFloat(wMaxEl ? wMaxEl.value : '10000');

            if (isNaN(cntVal) || cntVal < 5 || cntVal > 120) {
                if (statusEl) { statusEl.innerText = '⚠️ Card selection time must be 5–120 seconds.'; statusEl.style.color = '#f59e0b'; }
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
            if (isNaN(wMinVal) || wMinVal < 1) {
                if (statusEl) { statusEl.innerText = '⚠️ Minimum withdrawal must be at least 1 ETB.'; statusEl.style.color = '#f59e0b'; }
                return;
            }
            if (isNaN(wMaxVal) || wMaxVal <= wMinVal) {
                if (statusEl) { statusEl.innerText = '⚠️ Maximum withdrawal must be greater than minimum.'; statusEl.style.color = '#f59e0b'; }
                return;
            }

            saveBtn.disabled  = true;
            saveBtn.innerText = 'Saving...';
            try {
                // Collect payment methods from rendered inputs
                const pmKeys    = ['telebirr', 'cbe', 'awash'];
                const pmPayload = pmKeys.map(k => ({
                    key:     k,
                    account: document.getElementById(`pm-${k}-account`)?.value.trim() || '',
                    name:    document.getElementById(`pm-${k}-name`)?.value.trim()    || '',
                    enabled: document.getElementById(`pm-${k}-enabled`)?.checked      ?? true,
                }));

                const res  = await fetch('/api/admin/settings', {
                    method: 'POST',
                    headers: _ah(),
                    body: JSON.stringify({
                        card_select_time:     cntVal,
                        house_fee_pct:        feeVal,
                        referral_bonus:       refBonVal,
                        bonus_expiry_days:    bonExpVal,
                        withdraw_min:         wMinVal,
                        withdraw_max:         wMaxVal,
                        payment_methods:      pmPayload,
                        streak_auto_msg:      strAutoEl ? strAutoEl.value.trim() : '',
                        streak_milestone_msg: strMsEl   ? strMsEl.value.trim()   : '',
                    })
                });
                const data = await res.json();
                if (data.success) {
                    // Refresh deposit methods cache
                    loadDepositMethods();
                    const pmSaved = (data.payment_methods || []).filter(m => m.enabled && m.account).map(m => m.label).join(', ') || 'none active';
                    if (statusEl) {
                        statusEl.innerText = `✅ Saved! Card selection: ${data.card_select_time}s | Fee: ${data.house_fee_pct}% | Referral: ${data.referral_bonus} ETB | Withdraw: ${data.withdraw_min}–${data.withdraw_max} ETB | Pay: ${pmSaved}`;
                        statusEl.style.color = '#22c55e';
                    }
                } else {
                    if (statusEl) { statusEl.innerText = `❌ ${data.error}`; statusEl.style.color = '#ef4444'; }
                }
            } catch (e) {
                if (statusEl) { statusEl.innerText = '❌ Save failed.'; statusEl.style.color = '#ef4444'; }
            }
            saveBtn.disabled  = false;
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

function _reqCard({ topLeft, topRight, rows, id, approveCall, rejectCall, accentColor }) {
    const rowsHtml = rows.map(([label, val, color]) =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span style="font-size:0.72rem;color:#64748b;font-weight:600;">${label}</span>
            <span style="font-size:0.78rem;font-weight:700;color:${color || '#e2e8f0'};">${val}</span>
        </div>`
    ).join('');
    return `
    <div style="background:#161b22;border:1px solid ${accentColor || 'rgba(255,255,255,0.08)'};border-radius:14px;padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div>
                <div style="font-weight:800;font-size:0.9rem;">${topLeft}</div>
                <div style="font-size:0.72rem;color:#64748b;margin-top:2px;">${topRight}</div>
            </div>
            <div style="font-size:1.3rem;font-weight:900;color:${accentColor || '#e2e8f0'};">${rows[0]?.[1] || ''} ETB</div>
        </div>
        <div style="margin-bottom:12px;">${rowsHtml.split('</div>').slice(1).join('</div>')}</div>
        <div style="display:flex;gap:8px;margin-top:10px;">
            <button onclick="${approveCall}" style="flex:1;padding:9px;border-radius:10px;border:none;background:rgba(34,197,94,0.18);color:#4ade80;font-weight:800;font-size:0.82rem;cursor:pointer;">✅ Approve</button>
            <button onclick="${rejectCall}"  style="flex:1;padding:9px;border-radius:10px;border:none;background:rgba(239,68,68,0.18);color:#f87171;font-weight:800;font-size:0.82rem;cursor:pointer;">❌ Reject</button>
        </div>
    </div>`;
}

async function fetchAdminDeposits() {
    const listEl = document.getElementById('admin-deposits-list');
    if (!listEl) return;
    listEl.innerHTML = '<p class="empty-msg">Loading...</p>';
    try {
        const res      = await fetch('/api/admin/deposits', { headers: _ah() });
        const deposits = await res.json();
        if (!deposits.length) {
            listEl.innerHTML = '<p class="empty-msg">✅ No pending deposit requests.</p>';
            return;
        }
        listEl.innerHTML = deposits.map(d => `
        <div style="background:#161b22;border:1px solid rgba(34,197,94,0.2);border-radius:14px;padding:14px;margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
                <div>
                    <div style="font-weight:800;font-size:0.92rem;">👤 ${d.name}</div>
                    <div style="font-size:0.72rem;color:#64748b;margin-top:2px;">${d.phone_number} · ${d.created_at ? new Date(d.created_at).toLocaleString() : ''}</div>
                </div>
                <div style="font-size:1.4rem;font-weight:900;color:#22c55e;">${parseFloat(d.amount).toFixed(0)} ETB</div>
            </div>
            <div style="display:grid;gap:4px;margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
                    <span style="font-size:0.72rem;color:#64748b;font-weight:600;">Method</span>
                    <span style="font-size:0.78rem;font-weight:700;color:#3b82f6;">${d.method.toUpperCase()}</span>
                </div>
                <div style="display:flex;justify-content:space-between;padding:5px 0;">
                    <span style="font-size:0.72rem;color:#64748b;font-weight:600;">Transaction Code</span>
                    <span style="font-size:0.78rem;font-weight:700;color:#f59e0b;font-family:monospace;">${d.transaction_code}</span>
                </div>
            </div>
            <div style="display:flex;gap:8px;">
                <button onclick="handleDeposit('${d.id}','approve')" style="flex:1;padding:9px;border-radius:10px;border:none;background:rgba(34,197,94,0.18);color:#4ade80;font-weight:800;font-size:0.82rem;cursor:pointer;">✅ Approve</button>
                <button onclick="handleDeposit('${d.id}','reject')"  style="flex:1;padding:9px;border-radius:10px;border:none;background:rgba(239,68,68,0.18);color:#f87171;font-weight:800;font-size:0.82rem;cursor:pointer;">❌ Reject</button>
            </div>
        </div>`).join('');
    } catch (e) { listEl.innerHTML = '<p class="empty-msg">Error loading deposits.</p>'; }
}

async function fetchAdminWithdrawals() {
    const listEl = document.getElementById('admin-withdrawals-list');
    if (!listEl) return;
    listEl.innerHTML = '<p class="empty-msg">Loading...</p>';
    try {
        const res         = await fetch('/api/admin/withdrawals', { headers: _ah() });
        const withdrawals = await res.json();
        if (!withdrawals.length) {
            listEl.innerHTML = '<p class="empty-msg">✅ No pending withdrawal requests.</p>';
            return;
        }
        listEl.innerHTML = withdrawals.map(w => `
        <div style="background:#161b22;border:1px solid rgba(239,68,68,0.2);border-radius:14px;padding:14px;margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
                <div>
                    <div style="font-weight:800;font-size:0.92rem;">👤 ${w.name}</div>
                    <div style="font-size:0.72rem;color:#64748b;margin-top:2px;">${w.phone_number} · ${w.created_at ? new Date(w.created_at).toLocaleString() : ''}</div>
                </div>
                <div style="font-size:1.4rem;font-weight:900;color:#ef4444;">${parseFloat(w.amount).toFixed(0)} ETB</div>
            </div>
            <div style="display:grid;gap:4px;margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
                    <span style="font-size:0.72rem;color:#64748b;font-weight:600;">Method</span>
                    <span style="font-size:0.78rem;font-weight:700;color:#3b82f6;">${w.method.toUpperCase()}</span>
                </div>
                <div style="display:flex;justify-content:space-between;padding:5px 0;">
                    <span style="font-size:0.72rem;color:#64748b;font-weight:600;">Send To (Account)</span>
                    <span style="font-size:0.78rem;font-weight:700;color:#f59e0b;font-family:monospace;">${w.account_details}</span>
                </div>
            </div>
            <div style="display:flex;gap:8px;">
                <button onclick="handleWithdraw('${w.id}','approve')" style="flex:1;padding:9px;border-radius:10px;border:none;background:rgba(34,197,94,0.18);color:#4ade80;font-weight:800;font-size:0.82rem;cursor:pointer;">✅ Approve & Pay</button>
                <button onclick="handleWithdraw('${w.id}','reject')"  style="flex:1;padding:9px;border-radius:10px;border:none;background:rgba(239,68,68,0.18);color:#f87171;font-weight:800;font-size:0.82rem;cursor:pointer;">❌ Reject</button>
            </div>
        </div>`).join('');
    } catch (e) { listEl.innerHTML = '<p class="empty-msg">Error loading withdrawals.</p>'; }
}

window.handleDeposit = async (id, action) => {
    const label    = action === 'approve' ? 'Approve' : 'Reject';
    if (!confirm(`${label} this deposit request?`)) return;
    const endpoint = action === 'approve' ? '/api/admin/approve-deposit' : '/api/admin/reject-deposit';
    try {
        const res  = await fetch(endpoint, { method: 'POST', headers: _ah(), body: JSON.stringify({ depositId: id }) });
        const data = await res.json();
        _showToast(data.message || data.error, res.ok ? 'success' : 'error');
        fetchAdminDeposits();
    } catch (e) { console.error(e); }
};

window.handleWithdraw = async (id, action) => {
    const label = action === 'approve' ? 'Approve & Pay' : 'Reject';
    if (!confirm(`${label} this withdrawal request?`)) return;
    try {
        const res  = await fetch('/api/admin/handle-withdraw', { method: 'POST', headers: _ah(), body: JSON.stringify({ withdrawId: id, action }) });
        const data = await res.json();
        _showToast(data.message || data.error, res.ok ? 'success' : 'error');
        fetchAdminWithdrawals();
    } catch (e) { console.error(e); }
};

function _showToast(msg, type) {
    let toast = document.getElementById('_admin_toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = '_admin_toast';
        toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);padding:10px 20px;border-radius:12px;font-weight:700;font-size:0.85rem;z-index:9999;transition:opacity 0.3s;max-width:90vw;text-align:center;';
        document.body.appendChild(toast);
    }
    toast.innerText  = msg;
    toast.style.background = type === 'success' ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.9)';
    toast.style.color      = 'white';
    toast.style.opacity    = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

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

// ── Streak Milestone Broadcast ────────────────────────────────────────────────
async function loadStreakBcCount() {
    const ms = document.getElementById('streak-milestone-select')?.value || 7;
    const countEl = document.getElementById('streak-bc-count');
    const savedEl = document.getElementById('streak-bc-message');
    try {
        const res = await fetch(`/api/admin/streak-broadcast?milestone=${ms}`, { headers: _ah() });
        if (!res.ok) return;
        const d = await res.json();
        if (countEl) countEl.innerText = d.user_count ?? '—';
        if (savedEl && d.saved_message) savedEl.value = d.saved_message;
    } catch(e) {}
}
const streakMsSelect = document.getElementById('streak-milestone-select');
if (streakMsSelect) {
    streakMsSelect.onchange = loadStreakBcCount;
    loadStreakBcCount();
}
const streakBcPreviewBtn = document.getElementById('streak-bc-preview-btn');
if (streakBcPreviewBtn) {
    streakBcPreviewBtn.onclick = () => {
        const ms  = document.getElementById('streak-milestone-select')?.value || 7;
        let tmpl  = document.getElementById('streak-bc-message')?.value?.trim();
        if (!tmpl) tmpl = `🔥 *${ms} ቀን Streak!* ሰላም {username}!\n\nለ{streak} ቀን ተከታታይ ጨዋታ በጣም አደንቃለሁ! 🏆\nቦነስ ቀጥሎ → *{bonus} ETB*`;
        const sample = tmpl.replace(/{username}/g, 'አበበ')
                           .replace(/{streak}/g, ms)
                           .replace(/{bonus}/g, ms >= 7 ? '20' : ms >= 5 ? '10' : ms >= 3 ? '5' : '3');
        const box = document.getElementById('streak-bc-preview-box');
        if (box) { box.innerText = sample; box.style.display = 'block'; }
    };
}
const streakBcSendBtn = document.getElementById('streak-bc-send-btn');
if (streakBcSendBtn) {
    streakBcSendBtn.onclick = async () => {
        const ms      = document.getElementById('streak-milestone-select')?.value || 7;
        const message = document.getElementById('streak-bc-message')?.value?.trim() || '';
        const statusEl = document.getElementById('streak-bc-status');
        streakBcSendBtn.disabled  = true;
        streakBcSendBtn.innerText = 'Sending...';
        try {
            const res  = await fetch('/api/admin/streak-broadcast', {
                method: 'POST', headers: _ah(),
                body: JSON.stringify({ milestone: parseInt(ms), message }),
            });
            const data = await res.json();
            if (statusEl) {
                statusEl.innerText   = data.message || data.error || '';
                statusEl.style.color = res.ok ? '#22c55e' : '#ef4444';
            }
        } catch(e) {
            if (statusEl) { statusEl.innerText = '❌ Network error'; statusEl.style.color = '#ef4444'; }
        }
        streakBcSendBtn.disabled  = false;
        streakBcSendBtn.innerText = '🔥 Send Streak Broadcast';
    };
}

const sendBroadcastBtn = document.getElementById('send-broadcast');
if (sendBroadcastBtn) {
    sendBroadcastBtn.onclick = async () => {
        const message   = document.getElementById('broadcast-message')?.value?.trim();
        const statusEl  = document.getElementById('broadcast-status');
        if (!message) {
            if (statusEl) { statusEl.innerText = '⚠️ መልዕክት ያስገቡ'; statusEl.style.color = '#f59e0b'; }
            return;
        }
        sendBroadcastBtn.disabled  = true;
        sendBroadcastBtn.innerText = 'Sending...';
        try {
            const res  = await fetch('/api/admin/broadcast', { method: 'POST', headers: _ah(), body: JSON.stringify({ message }) });
            const data = await res.json();
            if (statusEl) {
                statusEl.innerText   = data.message || data.error;
                statusEl.style.color = res.ok ? '#22c55e' : '#ef4444';
            }
        } catch (e) {
            if (statusEl) { statusEl.innerText = '❌ Network error'; statusEl.style.color = '#ef4444'; }
        }
        sendBroadcastBtn.disabled  = false;
        sendBroadcastBtn.innerText = '📢 Send Telegram Broadcast';
    };
}

const sendAlertBtn = document.getElementById('send-alert-btn');
if (sendAlertBtn) {
    sendAlertBtn.onclick = async () => {
        const message   = document.getElementById('alert-message')?.value?.trim();
        const icon      = document.getElementById('alert-icon')?.value  || '📢';
        const duration  = parseInt(document.getElementById('alert-duration')?.value || '30');
        const statusEl  = document.getElementById('alert-status');
        if (!message) {
            if (statusEl) { statusEl.innerText = '⚠️ Alert message ያስገቡ'; statusEl.style.color = '#f59e0b'; }
            return;
        }
        sendAlertBtn.disabled  = true;
        sendAlertBtn.innerText = 'Sending...';
        try {
            const res  = await fetch('/api/admin/in-game-alert', {
                method: 'POST', headers: _ah(),
                body: JSON.stringify({ message, icon, duration })
            });
            const data = await res.json();
            if (statusEl) {
                statusEl.innerText   = data.message || data.error;
                statusEl.style.color = res.ok ? '#22c55e' : '#ef4444';
            }
            if (res.ok) {
                document.getElementById('alert-message').value = '';
                // Preview the alert for the admin too
                _handleBroadcastAlert({ message, icon, ttl: duration });
            }
        } catch (e) {
            if (statusEl) { statusEl.innerText = '❌ Network error'; statusEl.style.color = '#ef4444'; }
        }
        sendAlertBtn.disabled  = false;
        sendAlertBtn.innerText = '🔔 Send In-Game Alert';
    };
}

// initApp() is called from window.onload — guaranteed DOM-ready single entry point.