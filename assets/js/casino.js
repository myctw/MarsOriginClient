// 符文轉輪機與賭桌 (輪盤 / 哥布林二十一點 / 矮人高低骰) 的前端畫面。由 index.html 在 game.js 之後載入
// 使用 game.js 的 $、isOpen、sendMessage、inputBox
// ===== 自動下注節奏 (轉輪機與賭桌共用) =====
// 結果停留 AUTO_HOLD_MS,再倒數 AUTO_COUNTDOWN_S 秒才下一注;倒數期間按下按鈕可立刻下注
const AUTO_HOLD_MS = 5000;
const AUTO_COUNTDOWN_S = 5;

// onTick(剩餘秒數):倒數開始與每秒呼叫,停止或時間到時傳 0;onFire:倒數結束時下注
function createAutoTimer(onTick, onFire) {
    let timer = null;
    const count = seconds => {
        onTick(seconds);
        if (seconds <= 0) {
            timer = null;
            onFire();
            return;
        }
        timer = setTimeout(() => count(seconds - 1), 1000);
    };
    return {
        start() {
            clearTimeout(timer);
            timer = setTimeout(() => count(AUTO_COUNTDOWN_S), AUTO_HOLD_MS);
        },
        stop() {
            clearTimeout(timer);
            timer = null;
            onTick(0);
        }
    };
}

// ===== 符文轉輪機 (slot) =====
// 伺服器送 { type: 'slot', action }:
//   open   { title, floor, tier, bet, paytable, gold, chips }  開啟面板 (下注額 bet 由機台決定;tier 1~3 是樓層主題)
//   result { reels, combo, label, multiplier, winCells, bet, winAmount, gold, chips }  轉動結果
//   error  { message, close }                      下注失敗 (close: 已不在轉輪機旁)
// SPIN / 自動轉動都是靜默送出 "slot spin";結果由伺服器決定,前端只負責轉動動畫
// 轉輪上 7 的位置畫成符文 (SLOT_RUNE),不顯示數字
const slotPanel = $('slotPanel');
const slotStrips = Array.from(slotPanel.querySelectorAll('.slot-strip'));
const slotWinline = slotPanel.querySelector('.slot-winline');
const slotBanner = $('slotBanner');
const slotSpinButton = $('slotSpin');
const slotAutoButton = $('slotAuto');
const SLOT_REEL_DURATIONS = [1650, 2175, 2700];  // 三個轉輪依序停下
const SLOT_REEL_FILLERS = [24, 33, 42];          // 轉動期間經過的數字數量 (隨時間等比增加,轉速不變)
const SLOT_MIN_ROUND_MS = 2800;                  // 一輪最短時間,不短於伺服器的轉動冷卻 (2 秒)
const SLOT_PENDING_TIMEOUT_MS = 6000;
const slotReduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const SLOT_RUNE = 7;
const SLOT_RUNE_NAME = '符文';
// 符文 (原創圖樣):直立的符文杖穿過菱形外框,頂端分叉,中央嵌一顆寶石;顏色由 CSS 的 --slot-rune 決定
const SLOT_RUNE_SVG = '<svg class="slot-rune" viewBox="0 0 40 48" aria-hidden="true" focusable="false">'
    + '<path class="slot-rune-stroke" d="M20 9V45M12 3l8 7 8-7M20 11l13 14-13 14L7 25z"/>'
    + '<path class="slot-rune-gem" d="M20 19l5.5 6-5.5 6-5.5-6z"/></svg>';
const slot = {
    bet: 10000,
    digits: [SLOT_RUNE, SLOT_RUNE, SLOT_RUNE],
    gold: 0,
    chips: 0,
    pending: false,
    spinning: false,
    auto: false,
    requestedAt: 0,
    pendingTimer: null,
    countdown: 0            // 自動轉動倒數中的剩餘秒數 (0:沒有在倒數)
};
const slotFormat = value => Number(value || 0).toLocaleString('en-US');
const slotWait = ms => new Promise(resolve => setTimeout(resolve, ms));
// 轉輪視窗顯示三格:上一個、中央、下一個數字
const slotWindowDigits = digit => [(digit + 9) % 10, digit, (digit + 1) % 10];

const slotReelName = d => (d === SLOT_RUNE ? SLOT_RUNE_NAME : String(d));

function slotCellsHtml(digits) {
    return digits.map(d => (d === SLOT_RUNE
        ? `<div class="slot-cell is-rune">${SLOT_RUNE_SVG}</div>`
        : `<div class="slot-cell">${Number(d)}</div>`)).join('');
}

function renderSlotReel(index, digit) {
    const strip = slotStrips[index];
    strip.style.transition = 'none';
    strip.style.transform = 'translateY(0)';
    strip.innerHTML = slotCellsHtml(slotWindowDigits(digit));
}

// 轉一個轉輪到 target:數字帶由「目前三格 + 隨機數字 + 目標三格」組成,以 transform 往上捲動
// 分頁在背景時 transitionend 可能不觸發,以計時器保底,動畫沒結束也一定會停在正確數字
function spinSlotReel(index, target) {
    return new Promise(resolve => {
        const strip = slotStrips[index];
        const fillers = Array.from({ length: SLOT_REEL_FILLERS[index] }, () => Math.floor(Math.random() * 10));
        const digits = [...slotWindowDigits(slot.digits[index]), ...fillers, ...slotWindowDigits(target)];
        strip.style.transition = 'none';
        strip.style.transform = 'translateY(0)';
        strip.innerHTML = slotCellsHtml(digits);
        const cellHeight = strip.firstElementChild.getBoundingClientRect().height;
        strip.getBoundingClientRect(); // 先套用起點,再開始轉動
        const duration = SLOT_REEL_DURATIONS[index];
        strip.style.transition = `transform ${duration}ms var(--slot-ease-stop)`;
        strip.style.transform = `translateY(${-(digits.length - 3) * cellHeight}px)`;
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            renderSlotReel(index, target);
            resolve();
        };
        strip.addEventListener('transitionend', finish, { once: true });
        setTimeout(finish, duration + 200);
    });
}

function setSlotBanner(text, state = '') {
    slotBanner.textContent = text;
    slotBanner.className = `slot-banner${state ? ` ${state}` : ''}`;
}

function clearSlotWin() {
    slotPanel.classList.remove('is-jackpot');
    slotWinline.classList.remove('is-on');
    slotPanel.querySelectorAll('.slot-cell.is-hit').forEach(cell => cell.classList.remove('is-hit'));
}

// 中獎:標亮中獎轉輪的中央數字,並從第一個中獎轉輪畫線到最後一個
function showSlotWin(winCells, jackpot) {
    winCells.forEach(index => slotStrips[index].children[1]?.classList.add('is-hit'));
    const reelBoxes = slotPanel.querySelectorAll('.slot-reel');
    const first = reelBoxes[Math.min(...winCells)];
    const last = reelBoxes[Math.max(...winCells)];
    if (!first || !last) return;
    const left = first.offsetLeft + first.offsetWidth * 0.12;
    slotWinline.style.left = `${left}px`;
    slotWinline.style.width = `${last.offsetLeft + last.offsetWidth * 0.88 - left}px`;
    slotWinline.classList.remove('is-on');
    slotWinline.getBoundingClientRect(); // 重新播放畫線動畫
    slotWinline.classList.add('is-on');
    if (jackpot) slotPanel.classList.add('is-jackpot');
}

function updateSlotBalance() {
    $('slotGold').textContent = slotFormat(slot.gold);
    $('slotChips').textContent = slotFormat(slot.chips);
}

function updateSlotControls() {
    const busy = slot.pending || slot.spinning;
    slotSpinButton.disabled = busy;
    slotSpinButton.firstChild.textContent = busy ? '轉動中' : (slot.countdown > 0 ? String(slot.countdown) : 'SPIN');
    $('slotSpinHint').textContent = slot.countdown > 0 ? '秒後自動轉動' : `下注 ${slotFormat(slot.bet)}`;
    slotAutoButton.setAttribute('aria-checked', String(slot.auto));
    $('slotAutoState').textContent = slot.auto ? '開' : '關';
}

// 下注額由機台 (樓層) 決定,畫面只顯示
function setSlotStake(bet, floor) {
    slot.bet = bet;
    $('slotStake').textContent = slotFormat(bet);
    $('slotFloor').textContent = floor ? `${floor}機台` : '';
    updateSlotControls();
}

function renderSlotPaytable(paytable) {
    const body = $('slotPaytable');
    body.innerHTML = '';
    (Array.isArray(paytable) ? paytable : []).forEach(row => {
        const tr = document.createElement('tr');
        const name = document.createElement('td');
        name.textContent = row.label;
        const pay = document.createElement('td');
        pay.textContent = `×${row.multiplier}`;
        tr.append(name, pay);
        body.appendChild(tr);
    });
}

const slotAutoTimer = createAutoTimer(seconds => {
    slot.countdown = seconds;
    updateSlotControls();
}, () => slotSpin());

function setSlotAuto(on) {
    slot.auto = on;
    slotAutoTimer.stop();
    updateSlotControls();
    if (on && !slot.pending && !slot.spinning) slotSpin();
}

function slotSpin() {
    if (slotPanel.hidden || slot.pending || slot.spinning) return;
    slotAutoTimer.stop(); // 倒數中手動按下:立刻轉,不再等倒數
    if (!isOpen()) {
        setSlotBanner('尚未連線，請稍候再試', 'is-error');
        setSlotAuto(false);
        return;
    }
    if (slot.gold < slot.bet) {
        setSlotBanner(`金幣不足，需要 ${slotFormat(slot.bet)} 金幣`, 'is-error');
        setSlotAuto(false);
        return;
    }
    clearSlotWin();
    slot.pending = true;
    slot.requestedAt = Date.now();
    setSlotBanner('轉輪啟動中…');
    updateSlotControls();
    sendMessage('slot spin', { silent: true });
    slot.pendingTimer = setTimeout(() => {
        slot.pending = false;
        setSlotAuto(false);
        setSlotBanner('沒有收到結果，請再試一次', 'is-error');
    }, SLOT_PENDING_TIMEOUT_MS);
}

async function showSlotResult(data) {
    // 面板關著 (例如在輸入框手動打 slot spin) 時只看文字結果;上一輪還在轉時不重疊
    if (slotPanel.hidden || slot.spinning) return;
    if (!slot.pending) slot.requestedAt = Date.now();
    clearTimeout(slot.pendingTimer);
    slot.pending = false;
    slot.spinning = true;
    updateSlotControls();
    const reels = (Array.isArray(data.reels) ? data.reels : []).map(Number);
    if (reels.length !== 3 || reels.some(d => !Number.isInteger(d) || d < 0 || d > 9)) {
        slot.spinning = false;
        setSlotAuto(false);
        return;
    }
    setSlotBanner('轉動中…');
    if (slotReduceMotion.matches) {
        reels.forEach((digit, index) => renderSlotReel(index, digit));
    } else {
        await Promise.all(reels.map((digit, index) => spinSlotReel(index, digit)));
    }
    slot.digits = reels;
    // 開著面板走到別層的機台再按 SPIN 時,伺服器以那台的下注額轉動
    if (Number(data.bet) > 0 && Number(data.bet) !== slot.bet) setSlotStake(Number(data.bet), '');
    slot.gold = Number(data.gold) || 0;
    slot.chips = Number(data.chips) || 0;
    updateSlotBalance();

    const winAmount = Number(data.winAmount) || 0;
    if (winAmount > 0) {
        const jackpot = data.combo === 'jackpot';
        showSlotWin(Array.isArray(data.winCells) ? data.winCells : [], jackpot);
        setSlotBanner(`${data.label} ×${data.multiplier}，獲得 ${slotFormat(winAmount)} 賭場代幣`, jackpot ? 'is-win is-jackpot' : 'is-win');
    } else {
        setSlotBanner(`${reels.map(slotReelName).join(' - ')}，沒有中獎`);
    }

    // 一輪不短於伺服器冷卻,避免減少動態效果時連點被伺服器擋下
    const remaining = SLOT_MIN_ROUND_MS - (Date.now() - slot.requestedAt);
    if (remaining > 0) await slotWait(remaining);
    slot.spinning = false;
    updateSlotControls();
    if (slot.auto && !slotPanel.hidden) {
        slotAutoTimer.start();
    }
}

function openSlotPanel(data) {
    closeCasinoPanel();
    if (data.title) $('slotTitle').textContent = data.title;
    slotPanel.dataset.tier = String([1, 2, 3].includes(Number(data.tier)) ? Number(data.tier) : 1);
    setSlotStake(Number(data.bet) || slot.bet, data.floor || '');
    slot.gold = Number(data.gold) || 0;
    slot.chips = Number(data.chips) || 0;
    renderSlotPaytable(data.paytable);
    updateSlotBalance();
    if (slotPanel.hidden) {
        slot.digits.forEach((digit, index) => renderSlotReel(index, digit));
        clearSlotWin();
        setSlotBanner('按下 SPIN 開始轉動');
    }
    updateSlotControls();
    slotPanel.hidden = false;
    slotSpinButton.focus();
}

function closeSlotPanel() {
    slotPanel.hidden = true;
    clearTimeout(slot.pendingTimer);
    slotAutoTimer.stop();
    slot.pending = false;
    slot.auto = false;
    updateSlotControls();
}

function updateSlot(data) {
    if (data.action === 'open') {
        openSlotPanel(data);
    } else if (data.action === 'result') {
        showSlotResult(data);
    } else if (data.action === 'error') {
        clearTimeout(slot.pendingTimer);
        slot.pending = false;
        setSlotAuto(false);
        if (data.close) closeSlotPanel();
        else setSlotBanner(data.message || '下注失敗', 'is-error');
    }
}

slotSpinButton.addEventListener('click', slotSpin);
slotAutoButton.addEventListener('click', () => setSlotAuto(!slot.auto));
$('slotClose').addEventListener('click', closeSlotPanel);
slotPanel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        event.stopPropagation();
        closeSlotPanel();
        inputBox.focus();
    }
});

// ===== 賭桌 (輪盤 / 哥布林二十一點 / 矮人高低骰) =====
// 伺服器送 { type: 'casino', action, game }:
//   open   { title, dealer, bet, playLabel, options: [{ label, cmd, number? }], paytable, note, gold, chips }
//   result { bet, winAmount, summary, detail, gold, chips }  (detail 依遊戲不同,見各舞台的 play)
//   error  { message, close }
// 下注額由荷官 (樓層) 決定;選項的 cmd 靜默送出,'{number}' 換成號碼輸入框的值
const casinoPanel = $('casinoPanel');
const casinoStage = $('casinoStage');
const casinoBanner = $('casinoBanner');
const casinoPlayButton = $('casinoPlay');
const casinoAutoButton = $('casinoAuto');
const casinoNumberInput = $('casinoNumber');
const CASINO_MIN_ROUND_MS = 3200;       // 一輪最短時間,不短於伺服器的下注冷卻 (3 秒)
const CASINO_PENDING_TIMEOUT_MS = 7000;
const casino = {
    game: '',
    options: [],
    option: 0,
    bet: 0,
    gold: 0,
    chips: 0,
    pending: false,
    busy: false,
    auto: false,
    requestedAt: 0,
    pendingTimer: null,
    countdown: 0,           // 自動下注倒數中的剩餘秒數 (0:沒有在倒數)
    autoPlay: true,         // 這張賭桌是否提供自動下注 (德州撲克要自己決定,不提供)
    requiredGold: 0,        // 開局需要的金幣 (德州撲克 = 底注 × 3)
    minRoundMs: 0,
    phase: 'idle',          // 德州撲克:'decide' = 已發牌,等待跟注 / 棄牌
    callAmount: 0,
    decideLeft: 0,
    decideTimer: null
};
const casinoDecision = $('casinoDecision');
const casinoRandomDigit = () => Math.floor(Math.random() * 10);

// 數字帶捲動 (矮人計數器):視窗只顯示一格,由 from 捲到 to;以計時器保底,動畫沒跑完也停在正確數字
function casinoRollStrip(strip, from, to, duration, fillerCount) {
    return new Promise(resolve => {
        const digits = [from, ...Array.from({ length: fillerCount }, casinoRandomDigit), to];
        const cell = d => `<div class="dw-cell">${Number(d)}</div>`;
        strip.style.transition = 'none';
        strip.style.transform = 'translateY(0)';
        strip.innerHTML = digits.map(cell).join('');
        const cellHeight = strip.firstElementChild.getBoundingClientRect().height;
        strip.getBoundingClientRect();
        strip.style.transition = `transform ${duration}ms var(--c-ease-stop)`;
        strip.style.transform = `translateY(${-(digits.length - 1) * cellHeight}px)`;
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            strip.style.transition = 'none';
            strip.style.transform = 'translateY(0)';
            strip.innerHTML = cell(to);
            resolve();
        };
        strip.addEventListener('transitionend', finish, { once: true });
        setTimeout(finish, duration + 200);
    });
}

// ---------- 巨龍輪盤 ----------
// 歐式輪盤的號碼順序;轉盤把開出的號碼轉到上方龍牙指針下,珠子反向繞行後停在同一個位置
const RL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const RL_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const RL_STEP = 360 / RL_ORDER.length;
const RL_SPIN_MS = 3000;
const RL_COLOR_NAMES = { red: '紅', black: '黑', green: '綠' };
const rouletteStage = {
    wheelRot: 0,
    ballRot: 0,
    mount() {
        const polar = (r, deg) => {
            const rad = deg * Math.PI / 180;
            return `${(r * Math.sin(rad)).toFixed(2)} ${(-r * Math.cos(rad)).toFixed(2)}`;
        };
        const pockets = RL_ORDER.map((num, i) => {
            const a = i * RL_STEP;
            const a0 = a - RL_STEP / 2;
            const a1 = a + RL_STEP / 2;
            const color = num === 0 ? 'green' : (RL_RED.has(num) ? 'red' : 'black');
            return `<path class="rl-pocket rl-${color}" data-num="${num}" d="M ${polar(118, a0)} A 118 118 0 0 1 ${polar(118, a1)} L ${polar(78, a1)} A 78 78 0 0 0 ${polar(78, a0)} Z"></path>`
                + `<text data-num="${num}" transform="rotate(${a.toFixed(2)}) translate(0 -105)">${num}</text>`;
        }).join('');
        casinoStage.innerHTML = `
            <div class="rl-stage">
                <div class="rl-wheel-box">
                    <svg class="rl-wheel" viewBox="-130 -130 260 260">
                        <defs>
                            <radialGradient id="rlEye" cx="50%" cy="50%" r="50%">
                                <stop offset="0" stop-color="#ffe08a"></stop>
                                <stop offset=".55" stop-color="#f08a1c"></stop>
                                <stop offset="1" stop-color="#7a1d06"></stop>
                            </radialGradient>
                        </defs>
                        <circle r="128" fill="#2a0f08" stroke="#d9963a" stroke-width="3"></circle>
                        <circle r="123" fill="none" stroke="#7a2a12" stroke-width="7" stroke-dasharray="5 3"></circle>
                        ${pockets}
                        <circle r="78" fill="#120907" stroke="#d9963a" stroke-width="2"></circle>
                        <circle r="66" fill="none" stroke="#5a1a0c" stroke-width="6" stroke-dasharray="2 4"></circle>
                        <ellipse rx="44" ry="30" fill="url(#rlEye)" stroke="#2a0a04" stroke-width="3"></ellipse>
                        <ellipse rx="6" ry="27" fill="#120403"></ellipse>
                        <ellipse cx="-12" cy="-10" rx="7" ry="4" fill="#fff6" transform="rotate(-25 -12 -10)"></ellipse>
                    </svg>
                    <div class="rl-ball-track"><span class="rl-ball"></span></div>
                    <svg class="rl-pointer" viewBox="0 0 24 30" aria-hidden="true">
                        <path d="M12 29 L3 5 Q12 -1 21 5 Z" fill="#f3e2c0" stroke="#5a2a10" stroke-width="1.5"></path>
                    </svg>
                </div>
                <div class="rl-readout"><span class="rl-number">–</span><span class="rl-color">等待開盤</span></div>
            </div>`;
        this.applyRotation(false);
    },
    applyRotation(animate) {
        const wheel = casinoStage.querySelector('.rl-wheel');
        const track = casinoStage.querySelector('.rl-ball-track');
        const transition = animate ? `transform ${RL_SPIN_MS}ms var(--c-ease-stop)` : 'none';
        wheel.style.transition = transition;
        track.style.transition = animate ? `transform ${RL_SPIN_MS}ms cubic-bezier(.2, .7, .2, 1)` : 'none';
        wheel.style.transform = `rotate(${this.wheelRot}deg)`;
        track.style.transform = `rotate(${this.ballRot}deg)`;
    },
    reset() {
        casinoStage.querySelectorAll('.is-hit').forEach(el => el.classList.remove('is-hit'));
    },
    async play(detail, { reduceMotion }) {
        const num = Number(detail.winningNumber);
        const index = RL_ORDER.indexOf(num);
        if (index < 0) return;
        // 轉盤:順時針多轉 4 圈,停在開出的號碼朝上;珠子:逆時針多繞 6 圈,停在正上方
        const target = -index * RL_STEP;
        const current = ((this.wheelRot % 360) + 360) % 360;
        const delta = ((target - current) % 360 + 360) % 360;
        this.wheelRot += 360 * 4 + delta;
        this.ballRot -= 360 * 6 + (((this.ballRot % 360) + 360) % 360);
        casinoStage.querySelector('.rl-number').textContent = '…';
        casinoStage.querySelector('.rl-color').textContent = '龍焰轉動中';
        if (!reduceMotion) {
            this.applyRotation(true);
            await new Promise(resolve => setTimeout(resolve, RL_SPIN_MS + 100));
        }
        // 分頁在背景時 CSS 動畫可能沒跑完,一律直接套用最終角度,確保開出的號碼停在指針下
        this.applyRotation(false);
        casinoStage.querySelectorAll(`[data-num="${num}"]`).forEach(el => el.classList.add('is-hit'));
        casinoStage.querySelector('.rl-number').textContent = String(num);
        casinoStage.querySelector('.rl-color').textContent = `${RL_COLOR_NAMES[detail.winningColor] || ''}色`;
    }
};

// ---------- 哥布林二十一點 ----------
const GB_STOP_MS = { player: [900, 1200, 1500], dealer: [1900, 2200, 2500] };
const goblinStage = {
    mount() {
        const die = '<div class="gb-die" data-face="1">' + '<i></i>'.repeat(9) + '</div>';
        const row = (side, who) => `
            <div class="gb-row" data-side="${side}">
                <span class="gb-who">${who}</span>
                <div class="gb-dice">${die.repeat(3)}</div>
                <span class="gb-total">–</span>
            </div>`;
        casinoStage.innerHTML = `<div class="gb-stage">${row('player', '你')}<div class="gb-vs">VS</div>${row('dealer', '哥布林莊家')}</div>`;
    },
    reset() {
        casinoStage.querySelectorAll('.gb-row').forEach(row => {
            row.classList.remove('is-win', 'is-bust');
            row.querySelector('.gb-total').textContent = '–';
        });
        casinoStage.querySelectorAll('.gb-die').forEach(die => die.classList.remove('is-devil'));
    },
    async play(detail, { reduceMotion }) {
        const sides = {
            player: { rolls: detail.playerRolls || [], total: detail.playerTotal },
            dealer: { rolls: detail.dealerRolls || [], total: detail.dealerTotal }
        };
        const rowOf = side => casinoStage.querySelector(`.gb-row[data-side="${side}"]`);
        const settle = side => {
            const dice = rowOf(side).querySelectorAll('.gb-die');
            sides[side].rolls.forEach((face, i) => { if (dice[i]) dice[i].dataset.face = String(face); });
            rowOf(side).querySelector('.gb-total').textContent = String(sides[side].total ?? '–');
        };
        if (reduceMotion) {
            settle('player');
            settle('dealer');
        } else {
            // 骰子翻滾:每 90 毫秒換一面,依序停在結果
            const allDice = Object.keys(sides).flatMap(side =>
                Array.from(rowOf(side).querySelectorAll('.gb-die')).map((die, i) => ({ side, die, i })));
            allDice.forEach(({ die }) => die.classList.add('is-rolling'));
            const shuffle = setInterval(() => {
                allDice.forEach(({ die }) => {
                    if (die.classList.contains('is-rolling')) die.dataset.face = String(1 + Math.floor(Math.random() * 6));
                });
            }, 90);
            await Promise.all(allDice.map(({ side, die, i }) => new Promise(resolve => setTimeout(() => {
                die.classList.remove('is-rolling');
                die.dataset.face = String(sides[side].rolls[i] ?? 1);
                if (i === 2) rowOf(side).querySelector('.gb-total').textContent = String(sides[side].total ?? '–');
                resolve();
            }, GB_STOP_MS[side][i]))));
            clearInterval(shuffle);
        }
        const outcome = detail.outcome;
        if (outcome === 'bust') rowOf('player').classList.add('is-bust');
        if (outcome === 'dealerBust') rowOf('dealer').classList.add('is-bust');
        if (['jackpot', 'dealerBust', 'win'].includes(outcome)) rowOf('player').classList.add('is-win');
        if (['push', 'lose'].includes(outcome)) rowOf('dealer').classList.add('is-win');
        if (outcome === 'jackpot') rowOf('player').querySelectorAll('.gb-die').forEach(die => die.classList.add('is-devil'));
    }
};

// ---------- 矮人地窖高低骰 ----------
const DW_BASE_MS = 1000;
const DW_RESULT_MS = [1600, 2100, 2600];  // 百位、十位、個位依序停下
const DW_RELATION = { high: ['▲', '高'], low: ['▼', '低'], exact: ['=', '同點'] };
const dwarfStage = {
    values: { base: 0, result: 0 },
    mount() {
        const counter = role => `
            <div class="dw-tablet" data-role="${role}">
                <span class="dw-cap">${role === 'base' ? '基準' : '結果'}</span>
                <div class="dw-counter">${'<div class="dw-reel"><div class="dw-strip"><div class="dw-cell">0</div></div></div>'.repeat(3)}</div>
            </div>`;
        casinoStage.innerHTML = `
            <div class="dw-stage">
                ${counter('base')}
                <div class="dw-relation"><span class="dw-rel-symbol">?</span><span class="dw-rel-text">高或低</span></div>
                ${counter('result')}
            </div>`;
        this.values = { base: 0, result: 0 };
    },
    reset() {
        casinoStage.querySelectorAll('.is-win').forEach(el => el.classList.remove('is-win'));
        casinoStage.querySelector('.dw-rel-symbol').textContent = '?';
        casinoStage.querySelector('.dw-rel-text').textContent = '高或低';
    },
    digitsOf(value) {
        return String(Math.max(0, Math.min(999, Number(value) || 0))).padStart(3, '0').split('').map(Number);
    },
    roll(role, value, durations, reduceMotion) {
        const strips = casinoStage.querySelectorAll(`.dw-tablet[data-role="${role}"] .dw-strip`);
        const from = this.digitsOf(this.values[role]);
        const to = this.digitsOf(value);
        this.values[role] = value;
        if (reduceMotion) {
            strips.forEach((strip, i) => { strip.innerHTML = `<div class="dw-cell">${to[i]}</div>`; });
            return Promise.resolve();
        }
        return Promise.all(Array.from(strips).map((strip, i) =>
            casinoRollStrip(strip, from[i], to[i], durations[i], Math.round(durations[i] / 80))));
    },
    async play(detail, { reduceMotion, winAmount }) {
        const base = this.roll('base', detail.baseNumber, [DW_BASE_MS, DW_BASE_MS, DW_BASE_MS], reduceMotion);
        const result = this.roll('result', detail.resultNumber, DW_RESULT_MS, reduceMotion);
        await Promise.all([base, result]);
        const [symbol, text] = DW_RELATION[detail.relation] || ['?', ''];
        casinoStage.querySelector('.dw-rel-symbol').textContent = symbol;
        casinoStage.querySelector('.dw-rel-text').textContent = text;
        if (winAmount > 0) {
            casinoStage.querySelector('.dw-relation').classList.add('is-win');
            casinoStage.querySelector('.dw-tablet[data-role="result"]').classList.add('is-win');
        }
    }
};

// ---------- 精靈德州撲克 ----------
// 一手分兩段:deal (你的 2 張 + 翻牌 3 張,莊家蓋牌) → settle (轉牌、河牌、莊家手牌,標出勝方最好的 5 張)
// 牌以 'As'、'Td' 表示:點數 23456789TJQKA + 花色 shdc
const HD_SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const HD_DEAL_STEP_MS = 160;
const HD_REVEAL_STEP_MS = 320;
const HD_OUTCOME_TEXT = {
    win: '你贏了', lose: '莊家贏了', push: '平手', noQualify: '莊家不合格', fold: '你棄牌了', timeout: '逾時棄牌'
};
const holdemStage = {
    mount() {
        const slots = (n, cls = '') => `<div class="hd-card is-empty${cls}"></div>`.repeat(n);
        const row = (side, who) => `
            <div class="hd-row" data-side="${side}">
                <span class="hd-who">${who}</span>
                <div class="hd-cards">${slots(2)}</div>
                <span class="hd-hand"></span>
            </div>`;
        casinoStage.innerHTML = `
            <div class="hd-stage">
                ${row('dealer', '發牌員')}
                <div class="hd-board">${slots(5)}</div>
                ${row('player', '你')}
            </div>`;
    },
    reset() {
        this.mount();
    },
    cardsOf(selector) {
        return Array.from(casinoStage.querySelectorAll(`${selector} .hd-card`));
    },
    setCard(el, card) {
        el.className = 'hd-card';
        el.removeAttribute('data-card');
        el.innerHTML = '';
        if (card === 'back') {
            el.classList.add('is-back');
        } else if (!card) {
            el.classList.add('is-empty');
        } else {
            const rank = card[0] === 'T' ? '10' : card[0];
            const suit = card[1];
            el.dataset.card = card;
            el.classList.add(suit === 'h' || suit === 'd' ? 'is-red' : 'is-black');
            el.innerHTML = `<span class="hd-rank">${rank}</span><span class="hd-suit">${HD_SUIT[suit] || ''}</span>`;
        }
    },
    // 依序翻開:steps 為 [元素, 牌] 陣列
    async reveal(steps, stepMs, reduceMotion) {
        for (const [el, card] of steps) {
            this.setCard(el, card);
            if (!reduceMotion && card && card !== 'back') {
                el.classList.add('is-dealt');
                await slotWait(stepMs);
            }
        }
    },
    setLabel(side, text) {
        casinoStage.querySelector(`.hd-row[data-side="${side}"] .hd-hand`).textContent = text || '';
    },
    async play(detail, { reduceMotion }) {
        const playerEls = this.cardsOf('.hd-row[data-side="player"]');
        const dealerEls = this.cardsOf('.hd-row[data-side="dealer"]');
        const boardEls = this.cardsOf('.hd-board');
        const player = detail.player || [];
        const board = detail.board || [];
        if (detail.phase === 'deal') {
            this.mount();
            const els = {
                player: this.cardsOf('.hd-row[data-side="player"]'),
                dealer: this.cardsOf('.hd-row[data-side="dealer"]'),
                board: this.cardsOf('.hd-board')
            };
            els.dealer.forEach(el => this.setCard(el, 'back'));
            await this.reveal([
                [els.player[0], player[0]], [els.player[1], player[1]],
                [els.board[0], board[0]], [els.board[1], board[1]], [els.board[2], board[2]]
            ], HD_DEAL_STEP_MS, reduceMotion);
            this.setLabel('player', detail.handName);
            return;
        }
        // settle:補齊公牌與莊家手牌 (重新整理後也能從頭畫)
        const steps = [];
        player.forEach((card, i) => { if (playerEls[i]?.dataset.card !== card) steps.push([playerEls[i], card]); });
        board.forEach((card, i) => { if (boardEls[i]?.dataset.card !== card) steps.push([boardEls[i], card]); });
        (detail.dealer || []).forEach((card, i) => steps.push([dealerEls[i], card]));
        await this.reveal(steps, HD_REVEAL_STEP_MS, reduceMotion);
        this.setLabel('player', detail.playerHand?.name || '');
        this.setLabel('dealer', detail.dealerHand ? `${detail.dealerHand.name}${detail.qualifies === false ? '(不合格)' : ''}` : '');

        const rowOf = side => casinoStage.querySelector(`.hd-row[data-side="${side}"]`);
        const markBest = (side, best5) => {
            const scope = [...this.cardsOf(`.hd-row[data-side="${side}"]`), ...boardEls];
            (best5 || []).forEach(card => scope.find(el => el.dataset.card === card)?.classList.add('is-best'));
        };
        const outcome = detail.outcome;
        if (outcome === 'win' || outcome === 'noQualify') {
            rowOf('player').classList.add('is-win');
            markBest('player', detail.playerHand?.best5);
        } else if (outcome === 'lose') {
            rowOf('dealer').classList.add('is-win');
            markBest('dealer', detail.dealerHand?.best5);
        } else if (outcome === 'fold' || outcome === 'timeout') {
            rowOf('player').classList.add('is-fold');
        }
        casinoStage.querySelector('.hd-stage').dataset.outcome = HD_OUTCOME_TEXT[outcome] || '';
    }
};

const CASINO_STAGES = { roulette: rouletteStage, goblin21: goblinStage, dwarfMine: dwarfStage, holdem: holdemStage };
const casinoReduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function setCasinoBanner(text, state = '') {
    casinoBanner.textContent = text;
    casinoBanner.className = `casino-banner${state ? ` ${state}` : ''}`;
}

function updateCasinoBalance() {
    $('casinoGold').textContent = slotFormat(casino.gold);
    $('casinoChips').textContent = slotFormat(casino.chips);
}

function updateCasinoControls() {
    const busy = casino.pending || casino.busy;
    const deciding = casino.phase === 'decide';
    casinoPlayButton.hidden = deciding;
    casinoDecision.hidden = !deciding;
    $('casinoCall').disabled = busy;
    $('casinoFold').disabled = busy;
    $('casinoCallHint').textContent = `再下 ${slotFormat(casino.callAmount)}`;
    $('casinoFoldHint').textContent = casino.decideLeft > 0 ? `${casino.decideLeft} 秒後自動棄牌` : '輸掉底注';
    casinoAutoButton.hidden = !casino.autoPlay;
    casinoPlayButton.disabled = busy;
    $('casinoPlayText').textContent = busy ? '進行中' : (casino.countdown > 0 ? String(casino.countdown) : (casino.playLabel || '下注'));
    $('casinoPlayHint').textContent = casino.countdown > 0 ? '秒後自動下注' : `下注 ${slotFormat(casino.bet)}`;
    casinoAutoButton.setAttribute('aria-checked', String(casino.auto));
    $('casinoAutoState').textContent = casino.auto ? '開' : '關';
    const option = casino.options[casino.option];
    $('casinoNumberRow').hidden = !option?.number;
}

function renderCasinoOptions() {
    const container = $('casinoOptions');
    container.innerHTML = '';
    container.dataset.count = String(casino.options.length);
    $('casinoOptionLabel').hidden = casino.options.length <= 1;
    casino.options.forEach((option, index) => {
        const label = document.createElement('label');
        label.className = `casino-option${option.number ? ' is-wide' : ''}`;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'casinoOption';
        input.checked = index === casino.option;
        input.addEventListener('change', () => {
            casino.option = index;
            updateCasinoControls();
        });
        const text = document.createElement('span');
        text.textContent = option.label;
        label.append(input, text);
        container.appendChild(label);
    });
}

function renderCasinoPaytable(rows, note) {
    const body = $('casinoPaytable');
    body.innerHTML = '';
    (Array.isArray(rows) ? rows : []).forEach(row => {
        const tr = document.createElement('tr');
        const name = document.createElement('td');
        name.textContent = row.label;
        const pay = document.createElement('td');
        pay.textContent = row.pay;
        tr.append(name, pay);
        body.appendChild(tr);
    });
    $('casinoNote').textContent = note || '';
}

// 目前選項要送出的指令;號碼不合法時回傳 null
function getCasinoCommand() {
    const option = casino.options[casino.option];
    if (!option?.cmd) return null;
    if (!option.number) return option.cmd;
    const value = Number(casinoNumberInput.value);
    if (!Number.isInteger(value) || value < option.number.min || value > option.number.max) return null;
    return option.cmd.replace('{number}', String(value));
}

const casinoAutoTimer = createAutoTimer(seconds => {
    casino.countdown = seconds;
    updateCasinoControls();
}, () => casinoPlay());

function setCasinoAuto(on) {
    casino.auto = on;
    casinoAutoTimer.stop();
    updateCasinoControls();
    if (on && !casino.pending && !casino.busy) casinoPlay();
}

function casinoPlay() {
    if (casinoPanel.hidden || casino.pending || casino.busy) return;
    casinoAutoTimer.stop(); // 倒數中手動按下:立刻下注,不再等倒數
    const command = getCasinoCommand();
    if (!command) {
        const range = casino.options[casino.option]?.number;
        setCasinoBanner(range ? `請輸入 ${range.min}~${range.max} 的號碼` : '請選擇押注', 'is-error');
        setCasinoAuto(false);
        return;
    }
    if (!isOpen()) {
        setCasinoBanner('尚未連線，請稍候再試', 'is-error');
        setCasinoAuto(false);
        return;
    }
    const required = casino.requiredGold || casino.bet;
    if (casino.gold < required) {
        setCasinoBanner(`金幣不足，需要 ${slotFormat(required)} 金幣`, 'is-error');
        setCasinoAuto(false);
        return;
    }
    casinoPanel.classList.remove('is-jackpot');
    CASINO_STAGES[casino.game]?.reset();
    casino.pending = true;
    casino.requestedAt = Date.now();
    setCasinoBanner('下注中…');
    updateCasinoControls();
    sendMessage(command, { silent: true });
    casino.pendingTimer = setTimeout(() => {
        casino.pending = false;
        setCasinoAuto(false);
        setCasinoBanner('沒有收到結果，請再試一次', 'is-error');
    }, CASINO_PENDING_TIMEOUT_MS);
}

// 大獎:輪盤押中單一號碼、哥布林 6-6-6、矮人同點
function isCasinoJackpot(game, detail, winAmount) {
    if (winAmount <= 0) return false;
    return (game === 'roulette' && detail.betType === 'number')
        || (game === 'goblin21' && detail.outcome === 'jackpot')
        || (game === 'dwarfMine' && detail.betType === 'exact')
        || (game === 'holdem' && Number(detail.playerHand?.rank) >= 7); // 四條以上
}

// 德州撲克:發牌後的決定倒數 (伺服器逾時會自動棄牌,這裡只是顯示)
function startCasinoDecision(detail) {
    clearInterval(casino.decideTimer);
    casino.phase = 'decide';
    casino.callAmount = Number(detail.call) || casino.bet * 2;
    casino.decideLeft = Number(detail.timeoutSec) || 0;
    if (casino.decideLeft > 0) {
        casino.decideTimer = setInterval(() => {
            casino.decideLeft = Math.max(0, casino.decideLeft - 1);
            if (casino.decideLeft === 0) clearInterval(casino.decideTimer);
            updateCasinoControls();
        }, 1000);
    }
    updateCasinoControls();
}

function stopCasinoDecision() {
    clearInterval(casino.decideTimer);
    casino.decideTimer = null;
    casino.decideLeft = 0;
    casino.phase = 'idle';
}

function casinoDecide(command) {
    if (casinoPanel.hidden || casino.pending || casino.busy || casino.phase !== 'decide') return;
    if (!isOpen()) {
        setCasinoBanner('尚未連線，請稍候再試', 'is-error');
        return;
    }
    if (command === 'bet call' && casino.gold < casino.callAmount) {
        setCasinoBanner(`金幣不足，跟注需要 ${slotFormat(casino.callAmount)} 金幣`, 'is-error');
        return;
    }
    casino.pending = true;
    casino.requestedAt = Date.now();
    setCasinoBanner(command === 'bet call' ? '跟注中…' : '棄牌中…');
    updateCasinoControls();
    sendMessage(command, { silent: true });
    casino.pendingTimer = setTimeout(() => {
        casino.pending = false;
        updateCasinoControls();
        setCasinoBanner('沒有收到結果，請再試一次', 'is-error');
    }, CASINO_PENDING_TIMEOUT_MS);
}

async function showCasinoResult(data) {
    // 面板關著 (在輸入框手動打 bet) 或不是這張賭桌的結果時,只看文字訊息
    if (casinoPanel.hidden || casino.busy || data.game !== casino.game) return;
    if (!casino.pending) casino.requestedAt = Date.now();
    clearTimeout(casino.pendingTimer);
    casino.pending = false;
    casino.busy = true;
    updateCasinoControls();
    const winAmount = Number(data.winAmount) || 0;
    const detail = data.detail || {};
    const isDeal = data.phase === 'deal';
    if (!isDeal) stopCasinoDecision();
    setCasinoBanner(isDeal ? '發牌中…' : '開獎中…');
    await CASINO_STAGES[casino.game]?.play(detail, { reduceMotion: casinoReduceMotion.matches, winAmount });
    casino.gold = Number(data.gold) || 0;
    casino.chips = Number(data.chips) || 0;
    updateCasinoBalance();
    if (isDeal) {
        // 德州撲克發完翻牌:等玩家決定,不走自動下注
        casino.busy = false;
        setCasinoBanner(`${data.summary || ''}。跟注 ${slotFormat(detail.call)} 金幣，或棄牌`);
        startCasinoDecision(detail);
        $('casinoCall').focus();
        return;
    }
    if (winAmount > 0) {
        const jackpot = isCasinoJackpot(casino.game, detail, winAmount);
        setCasinoBanner(`${data.summary}，獲得 ${slotFormat(winAmount)} 賭場代幣`, jackpot ? 'is-win is-jackpot' : 'is-win');
        if (jackpot) casinoPanel.classList.add('is-jackpot');
    } else {
        setCasinoBanner(data.summary || '沒有中獎');
    }
    const remaining = (casino.minRoundMs || CASINO_MIN_ROUND_MS) - (Date.now() - casino.requestedAt);
    if (remaining > 0) await slotWait(remaining);
    casino.busy = false;
    updateCasinoControls();
    if (casino.auto && casino.autoPlay && !casinoPanel.hidden) casinoAutoTimer.start();
}

function openCasinoPanel(data) {
    const stage = CASINO_STAGES[data.game];
    if (!stage) return;
    closeSlotPanel();
    const sameTable = !casinoPanel.hidden && casino.game === data.game && casino.bet === Number(data.bet);
    casino.game = data.game;
    casino.bet = Number(data.bet) || 0;
    casino.playLabel = data.playLabel || '下注';
    casino.options = Array.isArray(data.options) ? data.options.filter(o => o && typeof o.cmd === 'string') : [];
    if (casino.option >= casino.options.length || !sameTable) casino.option = 0;
    casino.gold = Number(data.gold) || 0;
    casino.chips = Number(data.chips) || 0;
    casino.autoPlay = data.autoPlay !== false;
    casino.requiredGold = Number(data.requiredGold) || casino.bet;
    casino.minRoundMs = Number(data.minRoundMs) || CASINO_MIN_ROUND_MS;
    casinoPanel.dataset.game = data.game;
    $('casinoTitle').textContent = data.title || '';
    $('casinoDealer').textContent = `${data.dealer || ''}・本桌每注 ${slotFormat(casino.bet)} 金幣`;
    renderCasinoOptions();
    renderCasinoPaytable(data.paytable, data.note);
    updateCasinoBalance();
    if (!sameTable) {
        stopCasinoDecision();
        stage.mount();
        casinoPanel.classList.remove('is-jackpot');
        setCasinoBanner(casino.options.length > 1 ? '選擇押注，按下按鈕開始' : '按下按鈕開始');
    }
    if (data.pending) {
        // 德州撲克還沒決定的牌局:直接畫出來,接著決定
        stage.play(data.pending, { reduceMotion: true, winAmount: 0 });
        setCasinoBanner(`目前牌型：${data.pending.handName || ''}。跟注 ${slotFormat(data.pending.call)} 金幣，或棄牌`);
        startCasinoDecision(data.pending);
    } else if (casino.phase === 'decide') {
        stopCasinoDecision();
    }
    updateCasinoControls();
    casinoPanel.hidden = false;
    casinoPlayButton.focus();
}

function closeCasinoPanel() {
    casinoPanel.hidden = true;
    clearTimeout(casino.pendingTimer);
    casinoAutoTimer.stop();
    stopCasinoDecision(); // 牌局仍在伺服器上,重新打開畫面會接著顯示
    casino.pending = false;
    casino.auto = false;
    updateCasinoControls();
}

function updateCasino(data) {
    if (data.action === 'open') {
        openCasinoPanel(data);
    } else if (data.action === 'result') {
        showCasinoResult(data);
    } else if (data.action === 'error') {
        if (casinoPanel.hidden) return;
        clearTimeout(casino.pendingTimer);
        casino.pending = false;
        setCasinoAuto(false);
        if (data.close) closeCasinoPanel();
        else setCasinoBanner(data.message || '下注失敗', 'is-error');
    }
}

casinoPlayButton.addEventListener('click', casinoPlay);
$('casinoCall').addEventListener('click', () => casinoDecide('bet call'));
$('casinoFold').addEventListener('click', () => casinoDecide('bet fold'));
casinoAutoButton.addEventListener('click', () => setCasinoAuto(!casino.auto));
$('casinoClose').addEventListener('click', closeCasinoPanel);
casinoNumberInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        casinoPlay();
    }
});
casinoPanel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        event.stopPropagation();
        closeCasinoPanel();
        inputBox.focus();
    }
});
