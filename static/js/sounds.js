// ── Nova Bingo Sound Engine (Web Audio API — no files needed) ─────────────────
(function () {
    let _ctx  = null;
    let _muted = (localStorage.getItem('nvbMuted') === 'true');

    function _getCtx() {
        if (!_ctx) {
            try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); }
            catch (e) { return null; }
        }
        if (_ctx.state === 'suspended') _ctx.resume();
        return _ctx;
    }

    // Generic tone builder — silently skips if muted
    function _tone(freq, type, gainPeak, attackSec, decaySec, startOffset) {
        if (_muted) return;
        const ctx = _getCtx();
        if (!ctx) return;
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type            = type;
        osc.frequency.value = freq;
        const t = ctx.currentTime + (startOffset || 0);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(gainPeak, t + attackSec);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + attackSec + decaySec);
        osc.start(t);
        osc.stop(t + attackSec + decaySec + 0.02);
    }

    // ── Mute control ──────────────────────────────────────────────────────────
    window.isMuted = function () { return _muted; };

    window.toggleMute = function () {
        _muted = !_muted;
        localStorage.setItem('nvbMuted', _muted);
        _updateMuteBtns();
        return _muted;
    };

    function _updateMuteBtns() {
        document.querySelectorAll('.mute-btn').forEach(btn => {
            const iconOn  = btn.querySelector('.mute-icon-on');
            const iconOff = btn.querySelector('.mute-icon-off');
            const label   = btn.querySelector('.mute-label');
            if (iconOn)  iconOn.style.display  = _muted ? 'none'         : 'inline';
            if (iconOff) iconOff.style.display = _muted ? 'inline'       : 'none';
            if (label)   label.textContent     = _muted ? 'Unmute'       : 'Mute';
            btn.setAttribute('aria-label',       _muted ? 'Unmute sound' : 'Mute sound');
            btn.classList.toggle('muted', _muted);
        });
    }

    // Run once DOM is ready so buttons reflect saved state
    document.addEventListener('DOMContentLoaded', _updateMuteBtns);
    // Also patch after dynamic render (game.js calls this after load)
    window._syncMuteBtns = _updateMuteBtns;

    // ── Tick (last 5 s warning, one per second) ───────────────────────────────
    window.playTick = function () {
        _tone(1100, 'sine',   0.30, 0.004, 0.08);
        _tone(550,  'square', 0.08, 0.002, 0.05);
    };

    // ── Final-second tick (t === 1) — more urgent ─────────────────────────────
    window.playFinalTick = function () {
        _tone(1400, 'sine',   0.45, 0.003, 0.10);
        _tone(700,  'square', 0.12, 0.002, 0.06);
        _tone(1400, 'sine',   0.30, 0.003, 0.08, 0.14);
    };

    // ── 3-2-1 chimes ──────────────────────────────────────────────────────────
    const _chimePitches = { 3: 440, 2: 554, 1: 659 };

    window.playCountdownChime = function (num) {
        const freq = _chimePitches[num] || 500;
        _tone(freq,       'sine',     0.50, 0.01,  0.55);
        _tone(freq * 2,   'sine',     0.15, 0.01,  0.30);
        _tone(freq * 0.5, 'triangle', 0.10, 0.005, 0.40);
    };

    // ── GO! triumphant chord ──────────────────────────────────────────────────
    window.playGoSound = function () {
        const notes = [523.25, 659.25, 783.99];
        notes.forEach((f, i) => {
            _tone(f,     'sine', 0.45, 0.01,  0.55, i * 0.04);
            _tone(f * 2, 'sine', 0.12, 0.005, 0.30, i * 0.04);
        });
        _tone(130, 'sine', 0.35, 0.005, 0.25);
    };

    // ── Ball-called chime ─────────────────────────────────────────────────────
    window.playBallCall = function () {
        _tone(880, 'sine', 0.18, 0.005, 0.20);
        _tone(440, 'sine', 0.06, 0.005, 0.18);
    };

    // ── Winner fanfare ────────────────────────────────────────────────────────
    window.playWinnerFanfare = function () {
        const melody = [
            [523, 0.00], [659, 0.12], [784, 0.24],
            [1047, 0.36], [784, 0.52], [1047, 0.64]
        ];
        melody.forEach(([f, off]) => _tone(f, 'sine', 0.50, 0.01, 0.20, off));
        [523, 659, 784].forEach((f, i) =>
            _tone(f, 'triangle', 0.15, 0.02, 0.80, i * 0.03));
    };
})();
