// 遊戲主程式:連線、輸出、狀態列、地圖、設定、選單、輸入。由 index.html 載入 (一般 script,與 casino.js 共用全域範圍)
// connect() 由 index.html 在所有腳本載入後呼叫
const $ = id => document.getElementById(id);

// 優先順序: 本機才允許 ?server=ws://host:port  >  本機用開發機  >  正式機
// 正式站不接受 ?server= 覆寫,避免釣魚伺服器透過連結竊取自動登入的帳密
const SERVER_URL = (() => {
    const host = location.hostname;
    const isLocal = location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1';
    if (isLocal) {
        const override = new URLSearchParams(location.search).get('server');
        if (override && /^wss?:\/\/[\w.\-]+(:\d+)?$/.test(override)) return override;
    }
    return isLocal ? 'ws://localhost:9999' : 'wss://wssmo.myctw.cc:443';
})();
const outputContainer = $('output-container');
const outputTop = $('output-top');
const outputDiv = $('output');
const inputBox = $('inputBox');
const chatArea = $('chatArea');
const bossEventButton = $('bossEventButton');
const interactButton = $('interactButton');
const actionMenu = $('actionMenu');
const actionMenuTitle = $('actionMenuTitle');
const actionMenuBody = $('actionMenuBody');
// 目前開啟選單的元素 ([互動] 按鈕或 .entity-link) 與取得錨點位置的函式;放在這裡宣告,避免版面初始化時讀到 TDZ
let actionMenuOwner = null;
let actionMenuAnchor = null;
const MAX_CHAT_LINES = 7;
const MAX_OUTPUT_LINES = 200;
const MAX_COMMAND_HISTORY = 10;
const IDLE_LOGOUT_MS = 300000;
const RECONNECT_MS = 10000;
const MOBILE_QUERY = '(max-width: 768px)';

let ws;
let inputMode = null;
let isPasswordInput = false;
let inactivityTimer;
let reconnectTimer = null;
const commandHistory = [];
let currentHistoryIndex = -1;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

const isMobileLayout = () => window.matchMedia(MOBILE_QUERY).matches;
// 回傳給 server 的顯示模式,依視窗寬度判斷 (與 mobile layout 斷點一致)
const getClientView = () => isMobileLayout() ? 'mobile' : 'web';
const isOpen = () => ws && ws.readyState === WebSocket.OPEN;
const scrollOutputToBottom = () => { outputDiv.scrollTop = outputDiv.scrollHeight; };

// 讓元素可用滑鼠點擊或 Enter / 空白鍵觸發
function makeActivatable(element, label, action) {
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    element.setAttribute('aria-label', label);
    element.addEventListener('click', action);
    element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            action();
        }
    });
}

// ---- 連線診斷:回報給 server 的 db/log/conn_diag 日誌 ----
const DIAG_PING_MS = 30000;
const diag = {
    sessionId: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    events: [], socket: null, openedAt: 0, lastServerMsgAt: 0,
    rtt: { min: null, max: null, sum: 0, n: 0, last: null },
    seq: 0, sent: {}, timer: null, hiddenSince: null, hiddenTotalMs: 0
};
const storageGet = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } };
const storageSet = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ } };

function diagNetInfo() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return c ? { et: c.effectiveType, dl: c.downlink, nrtt: c.rtt, nt: c.type, sd: c.saveData } : null;
}

function diagEvent(type, x) {
    diag.events.push({
        t: Date.now(), type, vis: document.visibilityState, online: navigator.onLine,
        x: x === undefined ? undefined : String(x).slice(0, 60)
    });
    if (diag.events.length > 40) diag.events.shift();
}

function diagSaveReport(event, source) {
    const now = Date.now();
    const r = diag.rtt;
    storageSet('marsDiagReport', {
        closeSource: source || (diag.socket && diag.socket.__closeSource) || 'remote_or_network',
        code: event ? event.code : null,
        reason: event ? event.reason : null,
        wasClean: event ? event.wasClean : null,
        closedAt: now,
        connDurationMs: diag.openedAt ? now - diag.openedAt : null,
        lastServerMsgAgoMs: diag.lastServerMsgAt ? now - diag.lastServerMsgAt : null,
        vis: document.visibilityState,
        online: navigator.onLine,
        net: diagNetInfo(),
        hiddenTotalMs: diag.hiddenTotalMs + (diag.hiddenSince ? now - diag.hiddenSince : 0),
        rtt: r.n ? { min: r.min, max: r.max, avg: Math.round(r.sum / r.n), n: r.n, last: r.last } : null,
        pendingPings: Object.keys(diag.sent).length,
        events: diag.events.slice(-30)
    });
}

function diagSendPing(socket, drift) {
    if (socket !== ws || !isOpen()) return;
    const id = ++diag.seq;
    const now = Date.now();
    diag.sent[id] = now;
    const keys = Object.keys(diag.sent);
    if (keys.length > 10) delete diag.sent[keys[0]];
    const r = diag.rtt;
    socket.send(JSON.stringify({
        type: 'ping', id, t: now, drift,
        vis: document.visibilityState, online: navigator.onLine,
        ...diagNetInfo(),
        lost: Object.keys(diag.sent).length - 1,
        rtt: r.last, rttMin: r.min, rttMax: r.max,
        rttAvg: r.n ? Math.round(r.sum / r.n) : null, rttN: r.n
    }));
    storageSet('marsDiagAlive', { t: now, vis: document.visibilityState });
}

function diagOnOpen(socket) {
    const now = Date.now();
    Object.assign(diag, {
        socket, openedAt: now, lastServerMsgAt: now, sent: {}, hiddenTotalMs: 0,
        rtt: { min: null, max: null, sum: 0, n: 0, last: null },
        hiddenSince: document.visibilityState === 'hidden' ? now : null
    });
    diagEvent('open');

    let report = storageGet('marsDiagReport');
    const alive = storageGet('marsDiagAlive');
    if (report && alive) {
        report.prevLastAliveAt = alive.t;
        report.prevLastAliveVis = alive.vis;
    } else if (alive) {
        // 上一個頁面沒有留下任何關閉紀錄 (瀏覽器直接殺掉分頁 / 當機)
        report = { closeSource: 'previous_page_killed_no_event', closedAt: alive.t,
            prevLastAliveAt: alive.t, prevLastAliveVis: alive.vis, events: [] };
    }
    const { et, dl, nrtt, nt } = diagNetInfo() || {};
    try {
        socket.send(JSON.stringify({
            type: 'clientDiag', sessionId: diag.sessionId, view: getClientView(), report,
            current: { vis: document.visibilityState, online: navigator.onLine, et, dl, nrtt, nt }
        }));
        localStorage.removeItem('marsDiagReport');
    } catch (e) { /* ignore */ }

    clearInterval(diag.timer);
    let expected = now + DIAG_PING_MS;
    diag.timer = setInterval(() => {
        const t = Date.now();
        const drift = Math.max(0, t - expected); // 背景分頁被節流時會變很大
        expected = t + DIAG_PING_MS;
        diagSendPing(socket, drift);
    }, DIAG_PING_MS);
    setTimeout(() => diagSendPing(socket, 0), 3000); // 先快速量一次 RTT
}

function diagOnPong(data) {
    let obj;
    try { obj = JSON.parse(data); } catch (e) { return; }
    if (!obj || typeof obj.t !== 'number') return;
    const rtt = Date.now() - obj.t;
    const r = diag.rtt;
    r.last = rtt; r.n++; r.sum += rtt;
    if (r.min === null || rtt < r.min) r.min = rtt;
    if (r.max === null || rtt > r.max) r.max = rtt;
    delete diag.sent[obj.id];
}

document.addEventListener('visibilitychange', () => {
    const now = Date.now();
    if (document.visibilityState === 'hidden') diag.hiddenSince = now;
    else if (diag.hiddenSince) { diag.hiddenTotalMs += now - diag.hiddenSince; diag.hiddenSince = null; }
    diagEvent('visibility', document.visibilityState);
});
window.addEventListener('online', () => diagEvent('online'));
window.addEventListener('offline', () => diagEvent('offline'));
window.addEventListener('pageshow', e => diagEvent('pageshow', e.persisted ? 'bfcache' : ''));
window.addEventListener('pagehide', e => {
    diagEvent('pagehide', e.persisted ? 'bfcache' : '');
    diagSaveReport(null, 'page_unload');
});
document.addEventListener('freeze', () => diagEvent('freeze'));
document.addEventListener('resume', () => diagEvent('resume'));
navigator.connection?.addEventListener?.('change', () => {
    const i = diagNetInfo();
    diagEvent('netchange', i ? i.et + '/' + i.dl + '/' + i.nrtt : '');
});

// ===== 地圖 =====
const mapState = { data: null, view: 'nearby' };
const NEARBY_MAP_VIEW_BOX = '50 40 900 520';
const VERTICAL_DIRECTIONS = ['up', 'down'];
const mapDirectionNames = { north: '北', east: '東', south: '南', west: '西', up: '上', down: '下' };
const mapDirectionOffsets = {
    north: { x: 0, y: -1 }, east: { x: 1, y: 0 }, south: { x: 0, y: 1 },
    west: { x: -1, y: 0 }, up: { x: 1, y: -1 }, down: { x: -1, y: 1 }
};
const mapSvg = $('mapSvg');
let drawTarget = mapSvg; // 目前繪圖的 SVG(附近地圖或區域全圖視窗)
let areaWin = null;

function svgElement(name, attributes = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
}

function addMapNode(room, { x, y }, isCurrent, direction) {
    const width = 156;
    const height = 64;
    const group = svgElement('g', {
        class: `map-room-node${isCurrent ? ' current' : ''}${direction ? ' neighbor' : ''}`,
        transform: `translate(${x - width / 2}, ${y - height / 2})`
    });
    const title = svgElement('text', {
        x: width / 2, y: height / 2, 'text-anchor': 'middle', 'dominant-baseline': 'middle'
    });
    title.textContent = Array.from(room.name || `房間 ${room.id}`).slice(0, 5).join('');
    group.append(svgElement('rect', { x: 0, y: 0, width, height, rx: 12 }), title);
    VERTICAL_DIRECTIONS.forEach((vertical, index) => {
        if (!room.connections?.[vertical]) return;
        const indicator = svgElement('text', {
            class: 'map-vertical-indicators',
            x: width / 2 + (index === 0 ? -12 : 12),
            y: 61,
            'text-anchor': 'middle'
        });
        indicator.textContent = vertical === 'up' ? '↑' : '↓';
        // 只有目前房間的上下樓可以點擊移動
        if (isCurrent) makeActivatable(indicator, `${mapDirectionNames[vertical]}：移動`, () => sendMessage(vertical));
        group.append(indicator);
    });
    if (direction) {
        makeActivatable(group, `${mapDirectionNames[direction]}：${room.name}，按下移動`, () => sendMessage(direction));
    }
    drawTarget.append(group);
}

function addMapLink(from, to, direction, vertical) {
    const line = svgElement('line', {
        class: `map-link${vertical ? ' vertical' : ''}`,
        x1: from.x, y1: from.y, x2: to.x, y2: to.y
    });
    const label = svgElement('text', {
        class: 'map-direction-label',
        x: (from.x + to.x) / 2,
        y: (from.y + to.y) / 2 - 8,
        'text-anchor': 'middle'
    });
    label.textContent = mapDirectionNames[direction] || direction;
    drawTarget.append(line, label);
}

// 畫出房間與連線;pointFor(room) 回傳房間座標;markVertical 時上下樓連線用虛線
function drawMapRooms(rooms, currentRoom, pointFor, markVertical) {
    const roomById = new Map(rooms.map(room => [String(room.id), room]));
    const drawnLinks = new Set();
    for (const room of rooms) {
        for (const [direction, target] of Object.entries(room.connections || {})) {
            const targetRoom = roomById.get(String(target.id));
            if (!targetRoom) continue;
            const key = [String(room.id), String(target.id)].sort().join(':');
            if (drawnLinks.has(key)) continue;
            drawnLinks.add(key);
            addMapLink(pointFor(room), pointFor(targetRoom), direction,
                markVertical && VERTICAL_DIRECTIONS.includes(direction));
        }
    }
    const exitByRoomId = new Map(
        Object.entries(currentRoom.connections || {}).reverse().map(([direction, target]) => [String(target.id), direction])
    );
    for (const room of rooms) {
        addMapNode(room, pointFor(room), String(room.id) === String(currentRoom.id), exitByRoomId.get(String(room.id)));
    }
}

// 區域全圖:從目前房間開始依出口方向 BFS 排版,位置衝突時往外找空位
function getAreaMapPositions(rooms, currentRoomId) {
    const roomById = new Map(rooms.map(room => [String(room.id), room]));
    const positions = new Map();
    const occupied = new Set();
    const pending = [];

    function place(id, desired) {
        let { x, y } = desired;
        for (let radius = 1; occupied.has(`${x},${y}`); radius++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const dy = radius - Math.abs(dx);
                const free = (dy === 0 ? [[dx, 0]] : [[dx, dy], [dx, -dy]])
                    .find(([ox, oy]) => !occupied.has(`${desired.x + ox},${desired.y + oy}`));
                if (free) {
                    [x, y] = [desired.x + free[0], desired.y + free[1]];
                    break;
                }
            }
        }
        occupied.add(`${x},${y}`);
        positions.set(String(id), { x, y });
        pending.push(String(id));
    }

    function visitReachableRooms() {
        while (pending.length > 0) {
            const id = pending.shift();
            const position = positions.get(id);
            for (const [direction, target] of Object.entries(roomById.get(id).connections || {})) {
                const targetId = String(target.id);
                const offset = mapDirectionOffsets[direction];
                if (!offset || !roomById.has(targetId) || positions.has(targetId)) continue;
                place(targetId, { x: position.x + offset.x, y: position.y + offset.y });
            }
        }
    }

    if (roomById.has(String(currentRoomId))) place(currentRoomId, { x: 0, y: 0 });
    visitReachableRooms();
    rooms.forEach((room, index) => {
        if (positions.has(String(room.id))) return;
        place(room.id, { x: index * 2, y: 0 });
        visitReachableRooms();
    });
    return positions;
}

const areaWinOpen = () => Boolean(areaWin && !areaWin.closed);

function renderMap() {
    const data = mapState.data;
    const currentRoom = data?.currentRoom;
    $('mapTitle').textContent = data ? data.areaName : '地圖';
    mapSvg.replaceChildren();
    mapSvg.hidden = !currentRoom;
    if (!currentRoom) {
        if (areaWinOpen()) areaWin.close();
        return;
    }

    // 區域全圖資料只有 wizard 會收到(伺服器端判斷),沒有 areaRooms 就不提供
    const hasArea = Boolean(data.canViewAreaMap && data.areaRooms);
    const areaButton = document.querySelector('[data-map-view="area"]');
    areaButton.hidden = !hasArea;
    if (!hasArea && areaWinOpen()) areaWin.close();
    areaButton.classList.toggle('active', areaWinOpen());

    drawTarget = mapSvg;
    drawMapRooms(data.rooms, currentRoom, room => ({ x: 500 + room.x * 175, y: 300 + room.y * 100 }), false);
    mapSvg.setAttribute('viewBox', NEARBY_MAP_VIEW_BOX);

    if (hasArea && areaWinOpen()) renderAreaMap(data);
}

const AREA_WIN_HTML = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>區域全圖</title><style>
    html, body { margin: 0; height: 100%; background: #17191e; color: #eadbb8; font: 16px sans-serif; }
    body { display: flex; flex-direction: column; }
    header { padding: 8px 12px; border-bottom: 1px solid #443a29; }
    main { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px; }
    svg { display: block; min-width: 100%; min-height: 100%; border: 1px solid #39352c; border-radius: 8px;
        background-color: #111318; background-image: radial-gradient(#4b4230 1px, transparent 1px); background-size: 24px 24px; }
    .map-link { stroke: #8d7951; stroke-width: 3; }
    .map-link.vertical { stroke: #7196aa; stroke-dasharray: 8 6; }
    .map-direction-label { fill: #d7c18d; font: 14px sans-serif; paint-order: stroke; stroke: #111318; stroke-width: 4px; }
    .map-room-node { cursor: pointer; }
    .map-room-node rect { fill: #292b30; stroke: #766442; stroke-width: 2; }
    .map-room-node.current rect { fill: #514326; stroke: #e4c36e; stroke-width: 3; }
    .map-room-node.neighbor:hover rect { fill: #3e4a4b; stroke: #a7d1d6; }
    .map-room-node text { fill: #f0e6cf; font: 28px sans-serif; pointer-events: none; }
    .map-room-node .map-vertical-indicators { fill: #8db9c9; font-size: 16px; }
</style></head><body><header><strong id="t">區域全圖</strong></header>
<main><svg id="s" xmlns="http://www.w3.org/2000/svg"></svg></main></body></html>`;

// 區域全圖:真正獨立的瀏覽器視窗(可拖到其他螢幕),以原始尺寸繪製,超出時捲動
function renderAreaMap(data) {
    const doc = areaWin.document;
    const svg = doc.getElementById('s');
    if (!svg) return;
    const rooms = data.areaRooms || [];
    doc.getElementById('t').textContent = `${data.areaName} 區域全圖(${rooms.length} 間)`;
    svg.replaceChildren();
    if (!rooms.length) return;
    const positions = getAreaMapPositions(rooms, data.currentRoom.id);
    const all = [...positions.values()];
    const minX = Math.min(...all.map(p => p.x));
    const minY = Math.min(...all.map(p => p.y));
    drawTarget = svg;
    drawMapRooms(rooms, data.currentRoom, room => {
        const p = positions.get(String(room.id));
        return { x: 130 + (p.x - minX) * 190, y: 130 + (p.y - minY) * 120 };
    }, true);
    drawTarget = mapSvg;
    const bounds = svg.getBBox();
    if (!bounds.width || !bounds.height) return;
    const padding = 12;
    const w = Math.ceil(bounds.width + padding * 2);
    const h = Math.ceil(bounds.height + padding * 2);
    svg.setAttribute('viewBox', `${bounds.x - padding} ${bounds.y - padding} ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
}

function updateMap(data) {
    mapState.data = data.available ? data : null;
    renderMap();
}

function openAreaMapWindow() {
    if (!mapState.data?.areaRooms) return;
    if (areaWinOpen()) { areaWin.focus(); return; }
    areaWin = window.open('', 'marsAreaMap', 'popup=yes,width=1200,height=800');
    if (!areaWin) { alert('瀏覽器擋住了彈出視窗,請允許此網站開啟彈出視窗'); return; }
    areaWin.document.open();
    areaWin.document.write(AREA_WIN_HTML);
    areaWin.document.close();
    areaWin.addEventListener('pagehide', () => setTimeout(renderMap, 0));
    renderMap();
}
document.querySelector('[data-map-view="area"]').addEventListener('click', openAreaMapWindow);
window.addEventListener('beforeunload', () => { if (areaWinOpen()) areaWin.close(); });
$('mapCollapse').addEventListener('click', event => {
    const collapsed = document.querySelector('.map-window').classList.toggle('collapsed');
    event.currentTarget.textContent = collapsed ? '顯示地圖' : '隱藏地圖';
    event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
});

// ===== 輸出區捲動:使用者往上捲時分割成上下兩個視窗 =====
let isSplitting = false;
let isUserScrolling = false;
let scrollTimer;
let userScrollIntentUntil = 0;
let isOutputPointerDown = false;
const markUserScrollIntent = () => { userScrollIntentUntil = Date.now() + 800; };
const hasUserScrollIntent = () => isOutputPointerDown || Date.now() < userScrollIntentUntil;

function splitOutput() {
    if (isMobileLayout()) return mergeOutput();
    if (isSplitting) return;
    outputTop.innerHTML = outputDiv.innerHTML;
    const scrollRatio = outputDiv.scrollTop / (outputDiv.scrollHeight - outputDiv.clientHeight);
    outputTop.scrollTop = (outputTop.scrollHeight - outputTop.clientHeight) * (1 - scrollRatio);
    outputContainer.classList.add('split-view');
    isSplitting = true;
    scrollOutputToBottom();
}

function mergeOutput() {
    if (!isSplitting) return;
    outputContainer.classList.remove('split-view');
    isSplitting = false;
    outputTop.innerHTML = '';
    scrollOutputToBottom();
}

// 頂部視窗捲到底時合併
function handleTopScroll() {
    if (outputTop.scrollHeight - outputTop.scrollTop - outputTop.clientHeight < 10) mergeOutput();
}

outputDiv.addEventListener('scroll', () => {
    if (isSplitting) return;
    // 非使用者捲動 (例如調整視窗大小) 不開啟 output-top,維持在底部
    if (!hasUserScrollIntent()) return scrollOutputToBottom();
    if (outputDiv.scrollTop < outputDiv.scrollHeight - outputDiv.clientHeight - 10) splitOutput();
});
outputTop.addEventListener('scroll', handleTopScroll);
// 只有使用者主動捲動才允許開啟 output-top (視窗縮放造成的 scroll 事件不算)
['touchmove', 'keydown'].forEach(type => {
    outputDiv.addEventListener(type, markUserScrollIntent, { passive: true });
});
outputDiv.addEventListener('pointerdown', () => { isOutputPointerDown = true; });
['pointerup', 'pointercancel'].forEach(type => {
    window.addEventListener(type, () => { isOutputPointerDown = false; });
});
outputDiv.addEventListener('wheel', () => {
    markUserScrollIntent();
    isUserScrolling = true;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { isUserScrolling = false; }, 1000);
});
// 定期維持在底部 (例如圖片載入後內容變高)
setInterval(() => {
    if (!isUserScrolling && !isSplitting) scrollOutputToBottom();
}, 100);
window.addEventListener('resize', () => {
    if (isMobileLayout()) mergeOutput();
});

// ===== 版面:底部區塊高度 / 寬度與輸出區對齊 =====
const bottomContainer = document.querySelector('.bottom-container');
const leftPanel = document.querySelector('.left-panel');
const rightPanel = document.querySelector('.right-panel');
const rightPanelResizer = $('rightPanelResizer');

function setChatAreaHeight() {
    reserveSelfNameWidth(); // 主題 / 寬度改變會影響字型大小
    const mobile = isMobileLayout();
    const leftContentHeight = $('inputArea').offsetHeight + $('statusBar').offsetHeight + $('targetInfoBar').offsetHeight;
    // mobile: chatArea 固定為視窗高度的 20%
    const chatHeight = mobile ? Math.round(window.innerHeight * 0.2) : leftContentHeight;
    const leftPanelHeight = Math.max(leftContentHeight, leftPanel.scrollHeight);
    const styles = getComputedStyle(bottomContainer);
    const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const bottomHeight = mobile
        ? leftPanelHeight + chatHeight + parseFloat(styles.rowGap) + verticalPadding
        : Math.max(leftPanelHeight, chatHeight) + verticalPadding;

    chatArea.style.height = `${chatHeight}px`;
    bottomContainer.style.height = `${bottomHeight}px`;
    outputContainer.style.marginBottom = `${bottomHeight}px`;

    const outputRect = outputDiv.getBoundingClientRect();
    bottomContainer.style.left = `${outputRect.left}px`;
    bottomContainer.style.width = `${outputRect.width}px`;

    // right-panel 隱藏時一併隱藏拖移控制
    rightPanelResizer.hidden = getComputedStyle(rightPanel).display === 'none';

    layoutNumpad();
    layoutBossEventButton();
    layoutQuickBar();
    layoutInteractButton();
}
const relayout = () => window.requestAnimationFrame(setChatAreaHeight);

// ===== 可拖曳的浮動元件 (懸浮按鈕、快捷指令列、手機方向鍵) =====
// 整個元件都能拖:移動超過門檻才算拖曳 (觸控 10px,滑鼠 4px),拖曳結束的那次 click 不送出指令。
// 拖曳過的位置存 localStorage (storageKey),沒拖曳過時用 getDefault() 回傳的 { left / right / top / bottom } (px)。
// 位置一律限制在視窗內;旋轉螢幕或視窗變小時重新 layout 會拉回畫面中。
// 開始拖曳後才 setPointerCapture:一開始就捕捉的話,點群組裡的按鈕時 click 會落在外層元件,按鈕收不到。
// anchor: 'top' 以上緣定位 (預設);'bottom' 以下緣定位,元件變高時往上長 (快捷指令列展開時下緣不動)
// enabled: 回傳 false 時不能拖、也不設定位置 (例如手機版 [互動] 按鈕放進快捷指令列,由外層一起拖)
const DRAG_THRESHOLD = { touch: 10, pen: 6, mouse: 4 };
const draggables = [];
function makeDraggable(el, storageKey, getDefault, { onDragStart, anchor = 'top', enabled = () => true } = {}) {
    const fromBottom = anchor === 'bottom';
    const yKey = fromBottom ? 'bottom' : 'top';
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(storageKey)); } catch (e) { /* ignore */ }
    const hasPos = () => pos && Number.isFinite(pos.left) && Number.isFinite(pos[yKey]);
    const clearStyle = value => { el.style.left = el.style.top = el.style.right = el.style.bottom = value; };
    // y:anchor 為 top 時是上緣到視窗頂端的距離,bottom 時是下緣到視窗底端的距離
    const yOf = rect => fromBottom ? window.innerHeight - rect.bottom : rect.top;

    function place(left, y) {
        const maxLeft = Math.max(0, window.innerWidth - el.offsetWidth);
        const maxY = Math.max(0, window.innerHeight - el.offsetHeight);
        clearStyle('auto');
        el.style.left = `${Math.round(Math.min(Math.max(0, left), maxLeft))}px`;
        el.style[yKey] = `${Math.round(Math.min(Math.max(0, y), maxY))}px`;
    }

    function layout() {
        if (!enabled()) {
            clearStyle('');
            return;
        }
        if (hasPos()) {
            place(pos.left, pos[yKey]);
            return;
        }
        const preset = getDefault() || {};
        clearStyle('auto');
        for (const side of ['left', 'right', 'top', 'bottom']) {
            if (Number.isFinite(preset[side])) el.style[side] = `${Math.round(preset[side])}px`;
        }
        // 預設位置也不能超出視窗 (例如手機橫向時輸出區很矮,快捷列從輸入區往上排會超過畫面頂端)
        if (!el.offsetWidth) return;
        const rect = el.getBoundingClientRect();
        if (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
            place(rect.left, yOf(rect));
        }
    }

    function reset() {
        pos = null;
        try { localStorage.removeItem(storageKey); } catch (e) { /* ignore */ }
        layout();
    }

    let start = null;
    let dragged = false;
    el.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (!enabled()) return;
        const rect = el.getBoundingClientRect();
        start = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, posY: yOf(rect), type: event.pointerType };
        dragged = false;
    });
    el.addEventListener('pointermove', event => {
        if (!start || event.pointerId !== start.id) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!dragged) {
            if (Math.hypot(dx, dy) < (DRAG_THRESHOLD[start.type] ?? 4)) return;
            dragged = true;
            el.classList.add('is-dragging');
            try { el.setPointerCapture(event.pointerId); } catch (e) { /* 指標已放開 */ }
            onDragStart?.();
        }
        event.preventDefault();
        pos = { left: start.left + dx, [yKey]: start.posY + (fromBottom ? -dy : dy) };
        place(pos.left, pos[yKey]);
    });
    const finish = event => {
        if (!start || event.pointerId !== start.id) return;
        if (dragged) {
            const rect = el.getBoundingClientRect();
            pos = { left: rect.left, [yKey]: yOf(rect) };
            try { localStorage.setItem(storageKey, JSON.stringify(pos)); } catch (e) { /* ignore */ }
            el.classList.remove('is-dragging');
            // 觸控拖曳結束不一定會產生 click:下一輪就清掉旗標,免得吃掉之後真正的點擊
            setTimeout(() => { dragged = false; }, 0);
        }
        start = null;
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    // 觸控移動時取消瀏覽器預設的捲動手勢:否則拖曳放開時會被當成甩動 (fling),
    // 下一次點擊會被拿去「停止甩動」而沒有 click,看起來就是拖完後第一下按不動
    el.addEventListener('touchmove', event => {
        if (start && event.cancelable) event.preventDefault();
    }, { passive: false });
    // capture 階段攔下拖曳結束的 click,不讓按鈕自己的 click 處理與 document 的指令送出收到
    el.addEventListener('click', event => {
        if (!dragged) return;
        dragged = false;
        event.stopImmediatePropagation();
        event.preventDefault();
    }, true);

    const handle = { el, layout, reset };
    draggables.push(handle);
    return handle;
}

// 所有可拖曳元件回到預設位置 (設定面板的「預設」)
function resetDraggablePositions() {
    draggables.forEach(handle => handle.reset());
    positionActionMenu();
}

// ===== 手機方向鍵 (九宮格):預設在右上角,可拖曳 =====
const NUMPAD_MARGIN = 8;
const numpad = document.querySelector('.mobile-numpad');
const numpadDrag = makeDraggable(numpad, 'marsII.numpadPos', () => ({ top: NUMPAD_MARGIN, right: NUMPAD_MARGIN }));
function layoutNumpad() {
    numpadDrag.layout();
}
// 方向鍵預設位置的下緣 (懸浮按鈕預設排在它下面;方向鍵被拖走後懸浮按鈕留在原處,不跟著跑)
const numpadDefaultBottom = () => NUMPAD_MARGIN + numpad.offsetHeight;

// 懸浮按鈕 (活動傳送、互動) 預設在 chatArea 正上方 (位置依 chatArea 實際位置即時計算)
// 沒拖曳過時:桌機在 chatArea 右上方,手機在畫面右上方 (方向鍵預設位置的下方)
// slot: 預設位置從右邊數來第幾格 (0 = 最右),避免多個按鈕疊在一起
// onDragStart: 開始拖曳時呼叫 (例如收起按鈕的選單)
function makeFloatingButton(button, storageKey, slot, { onDragStart, enabled } = {}) {
    const SLOT_WIDTH = 52;
    return makeDraggable(button, storageKey, () => {
        if (isMobileLayout()) {
            return { right: 8 + slot * SLOT_WIDTH, top: numpadDefaultBottom() + 8 };
        }
        const rect = chatArea.getBoundingClientRect();
        return {
            right: Math.max(8, window.innerWidth - rect.right + 10) + slot * SLOT_WIDTH,
            bottom: Math.max(8, window.innerHeight - rect.top + 8)
        };
    }, { onDragStart, enabled });
}

// [互動] 按鈕:桌機是獨立的懸浮按鈕;手機版移進快捷指令列最下面,跟著快捷列一起拖 (見 syncInteractButtonHost)
const interactButtonHome = { parent: interactButton.parentNode, next: interactButton.nextSibling };
const isInteractInQuickBar = () => interactButton.parentNode === $('quickBar');
const bossEventFloat = makeFloatingButton(bossEventButton, 'marsII.bossEventButtonPos', 0);
const interactFloat = makeFloatingButton(interactButton, 'marsII.interactButtonPos', 1, {
    onDragStart: () => { if (actionMenuOwner === interactButton) hideActionMenu(); },
    enabled: () => !isInteractInQuickBar()
});
function layoutBossEventButton() {
    bossEventFloat.layout();
}
function syncInteractButtonHost() {
    const wantInBar = isMobileLayout();
    if (wantInBar === isInteractInQuickBar()) return;
    if (wantInBar) quickBar.prepend(interactButton);
    else interactButtonHome.parent.insertBefore(interactButton, interactButtonHome.next);
}
function layoutInteractButton() {
    syncInteractButtonHost();
    interactFloat.layout();
    positionActionMenu();
}

// ===== 快捷指令列 (手機版) =====
// 直向排列,由下往上:[互動]、攻擊、開關,展開時狀態 / 物品 / 裝備 / 任務從開關上方往上長出來,再點開關收回。
// 預設收合,在輸出區右下角;整組一起拖曳,以下緣定位 (展開、收合時開關與攻擊不會移動)。
// 「攻擊」開啟房內可攻擊對象的卷軸選單 (資料來自 [互動] 的 roomInteract 清單),其他按鈕直接送出 data-cmd
const quickBar = $('quickBar');
const quickBarItems = $('quickBarItems');
const quickBarToggle = $('quickBarToggle');
const quickKillButton = $('quickKill');
const QUICK_BAR_EXPANDED_KEY = 'marsII.quickBarExpanded';
const QUICK_BAR_MARGIN = 8;
const quickBarDrag = makeDraggable(quickBar, 'marsII.quickBarPos', () => ({
    right: Math.max(QUICK_BAR_MARGIN, window.innerWidth - outputDiv.getBoundingClientRect().right + QUICK_BAR_MARGIN),
    bottom: Math.max(QUICK_BAR_MARGIN, window.innerHeight - bottomContainer.getBoundingClientRect().top + QUICK_BAR_MARGIN)
}), {
    anchor: 'bottom',
    onDragStart: () => {
        if (actionMenuOwner === quickKillButton || actionMenuOwner === interactButton) hideActionMenu();
    }
});
function layoutQuickBar() {
    quickBarDrag.layout();
}

function isQuickBarCollapsed() {
    return quickBar.classList.contains('is-collapsed');
}
function setQuickBarCollapsed(collapsed, { save = true } = {}) {
    quickBar.classList.toggle('is-collapsed', collapsed);
    quickBarItems.hidden = collapsed;
    quickBarToggle.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? '展開快捷指令' : '收合快捷指令';
    quickBarToggle.setAttribute('aria-label', label);
    quickBarToggle.title = label;
    if (save) {
        try { localStorage.setItem(QUICK_BAR_EXPANDED_KEY, collapsed ? '0' : '1'); } catch (e) { /* ignore */ }
    }
    // 高度改變:拖曳過的位置要重新限制在視窗內
    layoutQuickBar();
    positionActionMenu();
}
(function restoreQuickBarCollapsed() {
    let expanded = false;
    try { expanded = localStorage.getItem(QUICK_BAR_EXPANDED_KEY) === '1'; } catch (e) { /* ignore */ }
    setQuickBarCollapsed(!expanded, { save: false });
})();
quickBarToggle.addEventListener('click', () => setQuickBarCollapsed(!isQuickBarCollapsed()));
// 進入遊戲 (伺服器送 profile.loggedIn) 才顯示:登入前按「狀態」會把 score 當成帳號送出
function setQuickBarVisible(visible) {
    if (quickBar.hidden === !visible) return;
    quickBar.hidden = !visible;
    if (!visible && (actionMenuOwner === quickKillButton || (actionMenuOwner === interactButton && isInteractInQuickBar()))) {
        hideActionMenu();
    }
    if (visible) {
        syncInteractButtonHost();
        layoutQuickBar();
    }
}

// ===== right-panel 寬度拖移 =====
(function initRightPanelResizer() {
    const RIGHT_PANEL_WIDTH_KEY = 'marsII.rightPanelWidth';
    const MIN_WIDTH = 280;
    const MIN_OUTPUT_WIDTH = 360;
    const root = document.documentElement;
    let pendingFrame = 0;
    const currentWidth = () => parseInt(getComputedStyle(root).getPropertyValue('--right-panel-width'), 10);
    const clampWidth = width => Math.round(Math.min(Math.max(width, MIN_WIDTH),
        Math.max(MIN_WIDTH, window.innerWidth - MIN_OUTPUT_WIDTH)));

    function applyWidth(width) {
        root.style.setProperty('--right-panel-width', `${clampWidth(width)}px`);
        if (!pendingFrame) {
            pendingFrame = window.requestAnimationFrame(() => {
                pendingFrame = 0;
                // 觸發 resize,讓地圖與底部區塊重新計算
                window.dispatchEvent(new Event('resize'));
            });
        }
    }

    const saved = parseInt(storageGet(RIGHT_PANEL_WIDTH_KEY), 10);
    if (Number.isFinite(saved)) applyWidth(saved);

    rightPanelResizer.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        rightPanelResizer.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing-right-panel');
    });
    rightPanelResizer.addEventListener('pointermove', event => {
        if (rightPanelResizer.hasPointerCapture(event.pointerId)) applyWidth(window.innerWidth - event.clientX);
    });
    rightPanelResizer.addEventListener('pointerup', event => {
        if (rightPanelResizer.hasPointerCapture(event.pointerId)) rightPanelResizer.releasePointerCapture(event.pointerId);
    });
    // pointerup / pointercancel 後都會觸發
    rightPanelResizer.addEventListener('lostpointercapture', () => {
        document.body.classList.remove('is-resizing-right-panel');
        storageSet(RIGHT_PANEL_WIDTH_KEY, currentWidth());
    });
    // 視窗縮小時確保寬度仍在範圍內
    window.addEventListener('resize', () => {
        const clamped = clampWidth(currentWidth());
        if (clamped !== currentWidth()) root.style.setProperty('--right-panel-width', `${clamped}px`);
    });
})();

// ===== 物品 / 裝備分頁 =====
document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(t => {
            const active = t === tab;
            t.classList.toggle('active', active);
            document.querySelector(`.${t.dataset.panel}-panel`).classList.toggle('active', active);
        });
    });
});

// ===== 設定 =====
const SETTINGS_STORAGE_KEY = 'marsII.clientSettings';
const LEGACY_THEME_STORAGE_KEY = 'terminalThemeColor';
const STATUS_OPTIONS = [
    ['hp', '生命'], ['mana', '法力'], ['move', '體力'], ['gold', '金幣'], ['food', '飽食'], ['drink', '口渴'],
    ['armor', '護甲'], ['damroll', '傷害'], ['hitroll', '命中'], ['str', '力量'], ['int', '智力'], ['dex', '敏捷'],
    ['wis', '學識'], ['con', '體質'], ['poison', '中毒'], ['burn', '灼傷'], ['bleed', '流血'], ['level', '等級']
];
const STATUS_KEYS = STATUS_OPTIONS.map(([key]) => key);
const EFFECT_KEYS = ['poison', 'burn', 'bleed'];
const COMBAT_KEYS = ['armor', 'damroll', 'hitroll', 'str', 'int', 'dex', 'wis', 'con'];
const THEMES = { green: 'green', white: 'rgb(255, 255, 255)', 'dark-fantasy': null, diablo: null };
const allStatusVisible = () => Object.fromEntries(STATUS_KEYS.map(key => [key, true]));
const currentSettings = {
    account: '', password: '', notifyChat: false, dotAnim: true, hotAnim: true,
    status: allStatusVisible(), theme: 'green'
};
// 持續傷害 / 持續治療動畫開關 (預設開啟)
const ANIM_SETTINGS = { dotAnim: $('dotAnimSetting'), hotAnim: $('hotAnimSetting') };
// 「記住我」的帳號 / 密碼由登入畫面 (auth.js) 透過 saveCredentials 存入;設定面板只顯示與清除
const savedAccountLabel = $('savedAccountLabel');
const forgetAccountButton = $('forgetAccount');
const notifySetting = $('chatNotificationSetting');
const themeSelect = $('themeColor');
const settingsError = $('settingsError');
let settingsSaveTimer;
let settingsSaveChain = Promise.resolve();
let encryptedSavedPassword = null;
let passwordChanged = false;

// 建立狀態列顯示的勾選框
const statusCheckboxes = {};
for (const [key, label] of STATUS_OPTIONS) {
    const row = document.createElement('label');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'form-check-input m-0' });
    box.addEventListener('change', () => {
        applyStatusSettings();
        queueSettingsSave();
    });
    statusCheckboxes[key] = box;
    row.append(box, label);
    $('statusOptions').append(row);
}

function showSettingsError(message) {
    settingsError.textContent = message;
    if (message) console.error(message);
}

function applyTheme(themeKey) {
    const theme = Object.hasOwn(THEMES, themeKey) ? themeKey : 'green';
    // diablo 主題疊加在 dark-fantasy 的版面之上,因此兩個 class 同時啟用
    document.body.classList.toggle('theme-dark-fantasy', theme === 'dark-fantasy' || theme === 'diablo');
    document.body.classList.toggle('theme-diablo', theme === 'diablo');
    outputDiv.style.color = THEMES[theme] || '';
    themeSelect.value = theme;
    currentSettings.theme = theme;
    relayout();
}

function setStatusCheckboxes(status) {
    STATUS_KEYS.forEach(key => { statusCheckboxes[key].checked = status[key]; });
}

function applyStatusSettings() {
    const status = currentSettings.status;
    STATUS_KEYS.forEach(key => {
        status[key] = statusCheckboxes[key].checked;
        document.querySelector(`[data-status-key="${key}"]`).hidden = !status[key];
    });
    document.querySelector('.status-effects').hidden = !EFFECT_KEYS.some(key => status[key]);
    document.querySelector('.status-combat').hidden = !COMBAT_KEYS.some(key => status[key]);
    relayout();
}

// 密碼以 AES-GCM 加密後存在 localStorage,金鑰 (不可匯出) 存在 IndexedDB
function idbRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getCredentialKey(createIfMissing) {
    const openRequest = indexedDB.open('marsII-settings', 1);
    openRequest.onupgradeneeded = () => openRequest.result.createObjectStore('keys');
    const database = await idbRequest(openRequest);
    try {
        const existingKey = await idbRequest(database.transaction('keys', 'readonly').objectStore('keys').get('credentials'));
        if (existingKey || !createIfMissing) return existingKey;
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await new Promise((resolve, reject) => {
            const transaction = database.transaction('keys', 'readwrite');
            transaction.objectStore('keys').put(key, 'credentials');
            transaction.oncomplete = resolve;
            transaction.onerror = transaction.onabort = () => reject(transaction.error);
        });
        return key;
    } finally {
        database.close();
    }
}

const bytesToBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const base64ToBytes = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));

async function encryptPassword(password) {
    if (!password) return null;
    if (!window.crypto?.subtle || !window.indexedDB) {
        throw new Error('此瀏覽器不支援安全的密碼儲存，密碼未被保存。');
    }
    const key = await getCredentialKey(true);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(password));
    return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) };
}

async function decryptPassword(encryptedPassword) {
    if (!window.crypto?.subtle || !window.indexedDB) {
        throw new Error('此瀏覽器不支援解密已儲存的密碼。');
    }
    const key = await getCredentialKey(false);
    if (!key) throw new Error('找不到密碼解密金鑰，請重新輸入密碼。');
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(encryptedPassword.iv) },
        key,
        base64ToBytes(encryptedPassword.ciphertext)
    );
    return new TextDecoder().decode(plaintext);
}

function queueSettingsSave() {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(() => {
        settingsSaveChain = settingsSaveChain.then(async () => {
            const passwordToSave = currentSettings.password;
            const shouldSavePassword = passwordChanged;
            const encryptedPassword = shouldSavePassword ? await encryptPassword(passwordToSave) : encryptedSavedPassword;
            const settings = {
                account: currentSettings.account,
                password: encryptedPassword,
                notifyChat: notifySetting.checked,
                dotAnim: ANIM_SETTINGS.dotAnim.checked,
                hotAnim: ANIM_SETTINGS.hotAnim.checked,
                status: { ...currentSettings.status },
                theme: themeSelect.value
            };
            localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
            currentSettings.notifyChat = settings.notifyChat;
            encryptedSavedPassword = encryptedPassword;
            showSettingsError('');
            applyTheme(settings.theme);
            if (!shouldSavePassword) return;
            if (currentSettings.password === passwordToSave) {
                passwordChanged = false;
            } else {
                queueSettingsSave(); // 儲存期間密碼又被修改
            }
        }).catch(error => showSettingsError(`設定儲存失敗：${error.message}`));
    }, 180);
}

function disableChatNotification(message) {
    notifySetting.checked = false;
    currentSettings.notifyChat = false;
    showSettingsError(message);
}

async function onChatNotificationChange() {
    if (notifySetting.checked) {
        if (!('Notification' in window)) {
            disableChatNotification('此瀏覽器不支援桌面通知。');
        } else {
            try {
                const permission = Notification.permission === 'default'
                    ? await Notification.requestPermission()
                    : Notification.permission;
                if (permission === 'granted') {
                    currentSettings.notifyChat = true;
                    showSettingsError('');
                } else {
                    disableChatNotification('瀏覽器通知權限未開啟，訊息提醒已停用。');
                }
            } catch (error) {
                disableChatNotification(`無法啟用瀏覽器通知：${error.message}`);
            }
        }
    } else {
        currentSettings.notifyChat = false;
    }
    queueSettingsSave();
}

async function initializeSettings() {
    let stored = null;
    try {
        stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || 'null');
    } catch (error) {
        showSettingsError(`無法讀取已儲存的設定：${error.message}`);
    }

    if (stored && typeof stored === 'object') {
        currentSettings.account = typeof stored.account === 'string' ? stored.account : '';
        currentSettings.notifyChat = stored.notifyChat === true;
        for (const [key, box] of Object.entries(ANIM_SETTINGS)) {
            currentSettings[key] = box.checked = stored[key] !== false;
        }
        currentSettings.status = Object.fromEntries(STATUS_KEYS.map(key => [
            key, typeof stored.status?.[key] === 'boolean' ? stored.status[key] : true
        ]));
        notifySetting.checked = currentSettings.notifyChat;
        applyTheme(stored.theme);
    } else {
        applyTheme(localStorage.getItem(LEGACY_THEME_STORAGE_KEY));
    }
    setStatusCheckboxes(currentSettings.status);
    applyStatusSettings();

    if (stored?.password) {
        encryptedSavedPassword = stored.password;
        try {
            currentSettings.password = await decryptPassword(stored.password);
        } catch (error) {
            showSettingsError(`無法解密已儲存的密碼：${error.message}`);
        }
    }
    updateSavedAccountLabel();
}

function updateSavedAccountLabel() {
    const remembered = Boolean(currentSettings.account && currentSettings.password);
    savedAccountLabel.textContent = remembered
        ? `已記住帳號:${currentSettings.account}`
        : '尚未記住帳號 (在登入畫面勾選「記住我」)';
    forgetAccountButton.hidden = !remembered;
}

// 登入畫面 (auth.js) 呼叫:登入成功且勾選「記住我」時記住帳密,未勾選時清除
function saveCredentials(account, password) {
    if (currentSettings.account === account && currentSettings.password === password) return;
    currentSettings.account = account;
    currentSettings.password = password;
    passwordChanged = true;
    updateSavedAccountLabel();
    queueSettingsSave();
}

function clearCredentials() {
    saveCredentials('', '');
}

forgetAccountButton.addEventListener('click', clearCredentials);
notifySetting.addEventListener('change', onChatNotificationChange);
for (const [key, box] of Object.entries(ANIM_SETTINGS)) {
    box.addEventListener('change', () => {
        currentSettings[key] = box.checked;
        queueSettingsSave();
    });
}
themeSelect.addEventListener('change', () => {
    applyTheme(themeSelect.value);
    queueSettingsSave();
});

const settingsReady = initializeSettings().catch(error => {
    showSettingsError(`設定初始化失敗：${error.message}`);
});

// ===== 設定面板開關 / 拖移 =====
const settingsButton = $('themeSelector');
const settingsPanel = $('settingsPanel');
const platformName = navigator.userAgentData?.platform || navigator.platform || '';
settingsPanel.classList.toggle('is-macos', /mac/i.test(platformName));

function placeSettingsPanel(left, top) {
    if (settingsPanel.hidden) return;
    const maxLeft = Math.max(0, window.innerWidth - settingsPanel.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - settingsPanel.offsetHeight);
    settingsPanel.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    settingsPanel.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
}
const clampSettingsPanel = () => placeSettingsPanel(settingsPanel.offsetLeft, settingsPanel.offsetTop);

function setSettingsPanelOpen(open) {
    settingsPanel.hidden = !open;
    settingsButton.setAttribute('aria-expanded', String(open));
    if (open) {
        placeSettingsPanel((window.innerWidth - settingsPanel.offsetWidth) / 2,
            (window.innerHeight - settingsPanel.offsetHeight) / 2);
    }
}

settingsButton.addEventListener('click', () => setSettingsPanelOpen(settingsPanel.hidden));
$('settingsClose').addEventListener('click', () => setSettingsPanelOpen(false));
(function enableSettingsDrag() {
    const header = settingsPanel.querySelector('.settings-header');
    let drag = null;
    header.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;
        drag = { dx: event.clientX - settingsPanel.offsetLeft, dy: event.clientY - settingsPanel.offsetTop };
        header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', event => {
        if (drag) placeSettingsPanel(event.clientX - drag.dx, event.clientY - drag.dy);
    });
    const endDrag = () => { drag = null; };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', clampSettingsPanel);
    new ResizeObserver(clampSettingsPanel).observe(settingsPanel);
})();
$('settingsReset').addEventListener('click', () => {
    notifySetting.checked = false;
    currentSettings.notifyChat = false;
    for (const [key, box] of Object.entries(ANIM_SETTINGS)) currentSettings[key] = box.checked = true;
    currentSettings.account = '';
    currentSettings.password = '';
    passwordChanged = true;
    updateSavedAccountLabel();
    setStatusCheckboxes(allStatusVisible());
    applyStatusSettings();
    applyTheme('dark-fantasy');
    queueSettingsSave();
    // 方向鍵、快捷列、懸浮按鈕回到預設位置,快捷列回到預設的收合狀態 (拖到不好按的地方時的退路)
    setQuickBarCollapsed(true);
    resetDraggablePositions();
});
document.addEventListener('click', event => {
    if (!settingsPanel.hidden && !settingsPanel.contains(event.target) && !settingsButton.contains(event.target)) {
        setSettingsPanelOpen(false);
    }
});
window.addEventListener('resize', setChatAreaHeight);
// 手機瀏覽器工具列收合/展開時,visualViewport 會變動但 window resize 不一定觸發
window.visualViewport?.addEventListener('resize', setChatAreaHeight);
relayout();

// ===== 伺服器訊息處理 =====
const DOT_ICONS = {
    bleed: './assets/images/bleeding-wound.svg',
    burn: './assets/images/burning-dot.svg',
    poison: './assets/images/death-skull.svg'
};
const HEAL_ICON = './assets/images/heal.svg';
const dotFloatLayer = $('dotFloatLayer');

// 每個 tick 的浮動數值動畫(蓋在 output-container 上,1 秒後移除)
function spawnFloat(parent, className, icon, text) {
    const el = document.createElement('div');
    el.className = `dot-float ${className}`;
    const img = document.createElement('img');
    img.src = icon;
    const span = document.createElement('span');
    span.textContent = text;
    el.append(img, span);
    parent.append(el);
    setTimeout(() => el.remove(), 1100);
    return el;
}

// 浮動列放在玩家名稱上方:玩家區與「名稱 (血量%)」同寬,DOT 靠左、HOT 靠右;
// 目標 DOT 欄盡量對齊目標名稱 (玩家區被撐寬時往右移,不重疊)
// 名稱列被隱藏 (mobile) 時放在左下角
function layoutFloatRow() {
    const row = $('floatRow');
    const layerRect = dotFloatLayer.getBoundingClientRect();
    const self = $('targetTargetName').getBoundingClientRect();
    const hasName = self.width > 0;
    const rowLeft = hasName ? Math.max(0, self.left - layerRect.left) : 12;
    row.style.left = `${rowLeft}px`;
    row.style.bottom = `${hasName ? Math.max(0, layerRect.bottom - self.top + 2) : 12}px`;
    $('selfFloats').style.minWidth = hasName
        ? `${Math.max(self.width, $('targetTargetHp').getBoundingClientRect().right - self.left)}px`
        : '6em';

    const targetLane = $('targetDotLane');
    const target = $('targetName').getBoundingClientRect();
    targetLane.style.marginLeft = '0px';
    if (target.width > 0) {
        const desired = target.left - layerRect.left - rowLeft;
        targetLane.style.marginLeft = `${Math.max(0, desired - targetLane.offsetLeft)}px`;
    }
}

function showFloat(laneId, className, icon, text) {
    layoutFloatRow();
    spawnFloat($(laneId), className, icon, text);
}

function showDotFloat(data) {
    const icon = DOT_ICONS[data.dotType];
    if (!icon || !currentSettings.dotAnim) return;
    showFloat(data.onSelf ? 'selfDotLane' : 'targetDotLane', data.dotType, icon, `-${data.damage}`);
}

function showHotFloat(data) {
    if (currentSettings.hotAnim) showFloat('selfHotLane', 'heal', HEAL_ICON, `+${data.value}`);
}

function updateChat(data) {
    chatArea.insertAdjacentHTML('beforeend', `<p>${data.msg}</p>`);
    if (currentSettings.notifyChat && 'Notification' in window && Notification.permission === 'granted') {
        const message = chatArea.lastElementChild?.textContent?.trim();
        if (message) {
            try {
                const notification = new Notification('Mars: Origin', { body: message, icon: './assets/images/MO_ICON2.png' });
                setTimeout(() => notification.close(), 8000);
            } catch (error) {
                console.error('無法顯示訊息通知:', error);
            }
        }
    }
    while (chatArea.childNodes.length > MAX_CHAT_LINES) chatArea.firstChild.remove();
}

// 每日王城活動的 [參加活動] 浮動按鈕:同時可能有多場活動,只顯示最早開始的一場;
// action 'start' 表示活動開始 (或補送登入時仍在進行中的活動),'end'/'joined' 表示要把它從清單移除
const activeBossEvents = new Map();
function bossEventKey(data) {
    return `${data.eventId}-${data.idx}-${data.dateKey}`;
}
function refreshBossEventButton() {
    const next = activeBossEvents.values().next().value;
    if (!next) {
        bossEventButton.hidden = true;
        bossEventButton.dataset.cmd = '';
        return;
    }
    bossEventButton.dataset.cmd = `joinbossevent ${next.eventId} ${next.idx} ${next.dateKey}`;
    bossEventButton.title = `參加「${next.name || '活動'}」`;
    bossEventButton.hidden = false;
    layoutBossEventButton();
}
const eventNotifySound = new Audio('./assets/images/event-notify.mp3');
function updateBossEvent(data) {
    const key = bossEventKey(data);
    if (data.action === 'start') {
        // sound 由伺服器依玩家的「活動提醒音效」設定決定,只在活動首次開始時為 true
        if (data.sound) {
            eventNotifySound.currentTime = 0;
            eventNotifySound.play().catch(() => {}); // 瀏覽器可能在使用者互動前擋掉自動播放
        }
        activeBossEvents.set(key, data);
    } else {
        activeBossEvents.delete(key);
    }
    refreshBossEventButton();
}

// 房間的 [互動] 浮動按鈕:伺服器在 look 房間時送來 { items: [...] };
// 房內 NPC 死亡 / 移動、玩家進出時也會推送 { items, refresh: true }
//   NPC / 其他玩家:{ label, actions: [{ label, cmd }] } (點了進入子選單:查看 / 攻擊)
//   裝飾物:{ label, cmd } (點了直接送出)
// 0 個:收起;只有 1 個裝飾物:按鈕直接送出;只有 1 個 NPC/玩家:直接開它的選單;多個:開清單選擇
let roomInteractItems = [];
function isValidActionCmd(action) {
    return !!action && typeof action.cmd === 'string' && action.cmd !== '';
}
function updateRoomInteract(data) {
    roomInteractItems = (Array.isArray(data.items) ? data.items : [])
        .map(item => item && Array.isArray(item.actions)
            ? { label: item.label, actions: item.actions.filter(isValidActionCmd) }
            : item)
        .filter(item => isValidActionCmd(item) || item?.actions?.length > 0);
    if (data.refresh) {
        // 房內異動:已開啟的選單保留,只換成最新內容 (對象已離開時收起)
        refreshOpenActionMenu();
    } else {
        // 換房間 / 重新 look:舊的 NPC、玩家、物件選單都已失效
        hideActionMenu();
    }
    if (roomInteractItems.length === 0) {
        interactButton.hidden = true;
        interactButton.dataset.cmd = '';
        return;
    }
    const single = roomInteractItems.length === 1;
    interactButton.dataset.cmd = single && roomInteractItems[0].cmd ? roomInteractItems[0].cmd : '';
    interactButton.title = single
        ? `互動:${roomInteractItems[0].label || ''}`
        : `互動 (${roomInteractItems.length} 個對象)`;
    interactButton.hidden = false;
    layoutInteractButton();
}

// 目前清單中名稱為 label 的 NPC / 玩家的指令;同名的有多個時優先選指令完全相同的那個
// (同名 NPC 有一隻死亡後,剩下那隻的 "2.orc" 會變成 "orc",要用最新的指令)
function findCurrentActions(label, previousActions) {
    const candidates = roomInteractItems.filter(item => item.actions && item.label === label);
    if (!candidates.length) return null;
    const previous = JSON.stringify(previousActions || []);
    return (candidates.find(item => JSON.stringify(item.actions) === previous) || candidates[0]).actions;
}

function refreshOpenActionMenu() {
    if (actionMenu.hidden || !actionMenuAnchor?.view) return;
    const { owner, getRect, preferAbove, view } = actionMenuAnchor;
    const options = { preferAbove, animate: false };
    if (view.type === 'kill') {
        openQuickKillMenu(options);
        return;
    }
    if (view.type === 'list') {
        if (roomInteractItems.length) openInteractListMenu(options);
        else hideActionMenu();
        return;
    }
    const actions = findCurrentActions(view.label, view.actions);
    if (actions) openEntityMenu(owner, getRect, view.label, actions, { ...options, fromList: view.fromList });
    else if (view.fromList && roomInteractItems.length) openInteractListMenu(options);
    else hideActionMenu();
}

// ===== 羊皮卷軸選單 (actionMenu) =====
// 選單項目前的線條圖示 (固定字串,依指令動詞挑選;不使用 emoji)
const ACTION_MENU_ICONS = {
    look: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    kill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/></svg>',
    interact: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9z"/><path d="M19 17v4M17 19h4"/></svg>',
    target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>',
    more: '<svg class="scroll-menu-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>'
};

// item 四種:{ label, cmd } 送出指令;{ label, actions } 進入子選單;{ label, onSelect } 選單內的動作 (返回);
//          { label, note: true } 不可點的說明文字
function buildActionMenuItem(item) {
    if (item.note) {
        const note = document.createElement('div');
        note.className = 'scroll-menu-note';
        note.textContent = item.label;
        return note;
    }
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'scroll-menu-item';
    el.setAttribute('role', 'menuitem');
    let icon;
    if (item.cmd) {
        const verb = String(item.cmd).split(' ')[0];
        el.classList.add('item-link');
        el.dataset.cmd = item.cmd;
        el.dataset.silent = 'true';
        if (verb === 'kill') el.classList.add('is-danger');
        icon = ACTION_MENU_ICONS[verb] || ACTION_MENU_ICONS.interact;
    } else if (item.actions) {
        el.setAttribute('aria-haspopup', 'menu');
        el.addEventListener('click', () => openActionSubMenu(item));
        icon = ACTION_MENU_ICONS.target;
    } else {
        el.classList.add('is-back');
        el.addEventListener('click', item.onSelect);
        icon = ACTION_MENU_ICONS.back;
    }
    el.insertAdjacentHTML('afterbegin', icon);
    const label = document.createElement('span');
    label.textContent = item.label || item.cmd || '';
    el.append(label);
    if (item.actions) el.insertAdjacentHTML('beforeend', ACTION_MENU_ICONS.more);
    el.title = label.textContent;
    return el;
}

const getInteractButtonRect = () => interactButton.getBoundingClientRect();

// [互動] 按鈕的清單 (NPC、玩家、裝飾物)
function openInteractListMenu({ preferAbove = true, animate = true } = {}) {
    openActionMenu(interactButton, getInteractButtonRect, '互動', roomInteractItems,
        { preferAbove, animate, view: { type: 'list' } });
}

// 某個 NPC / 玩家的選單;從清單進入時 (fromList) 最後附「返回」
function openEntityMenu(owner, getRect, label, actions, { preferAbove = false, animate = true, fromList = false } = {}) {
    const items = fromList
        ? [...actions, { label: '返回', onSelect: () => openInteractListMenu({ preferAbove }) }]
        : actions;
    openActionMenu(owner, getRect, label, items,
        { preferAbove, animate, view: { type: 'entity', label, actions, fromList } });
}

// 從清單進入某個 NPC / 玩家的子選單
function openActionSubMenu(item) {
    if (!actionMenuAnchor) return;
    const { owner, getRect, preferAbove } = actionMenuAnchor;
    openEntityMenu(owner, getRect, item.label, item.actions, { preferAbove, fromList: true });
}

// owner: 開啟選單的元素;getAnchorRect: 回傳選單要貼齊的位置;items: 見 buildActionMenuItem
// view: 目前顯示的內容 (清單 / 某個對象),房內異動時 refreshOpenActionMenu 依此重畫
function openActionMenu(owner, getAnchorRect, title, items, { preferAbove = false, animate = true, view = null } = {}) {
    const scrollTop = actionMenuBody.scrollTop;
    actionMenuTitle.textContent = title || '';
    actionMenuTitle.hidden = !title;
    actionMenuBody.replaceChildren(...items.map(buildActionMenuItem));
    // 刷新時保留捲動位置,不重播展開動畫
    actionMenuBody.scrollTop = animate ? 0 : scrollTop;
    actionMenuOwner = owner;
    actionMenuAnchor = { owner, getRect: getAnchorRect, preferAbove, view };
    if (animate) {
        actionMenu.hidden = true;
        void actionMenu.offsetWidth;
    }
    actionMenu.hidden = false;
    positionActionMenu();
}

function hideActionMenu() {
    actionMenu.hidden = true;
    actionMenuBody.replaceChildren();
    actionMenuOwner = null;
    actionMenuAnchor = null;
}

// 水平置中對齊錨點;垂直依 preferAbove 放上方或下方,空間不夠時改放另一側;都限制在視窗內 (捲軸木軸凸出 9px)
function positionActionMenu() {
    if (actionMenu.hidden || !actionMenuAnchor) return;
    const rect = actionMenuAnchor.getRect();
    const menuW = actionMenu.offsetWidth;
    const menuH = actionMenu.offsetHeight;
    const margin = 12;
    const gap = 10;
    // 快捷列 (手機版直排,含 [互動]) 開的選單:貼在按鈕左側、下緣對齊往上長,不蓋住快捷列的其他按鈕
    // (快捷列的圖層在選單之上,蓋住的話按鈕會壓在選單文字上);左側放不下時退回一般的上下擺放
    if (actionMenuAnchor.owner?.closest?.('#quickBar') && rect.left - gap - menuW >= margin) {
        const sideTop = Math.min(Math.max(margin, rect.bottom - menuH), window.innerHeight - menuH - margin);
        actionMenu.style.left = `${rect.left - gap - menuW}px`;
        actionMenu.style.top = `${Math.max(margin, sideTop)}px`;
        return;
    }
    const left = Math.min(Math.max(margin, rect.left + rect.width / 2 - menuW / 2), window.innerWidth - menuW - margin);
    const aboveTop = rect.top - menuH - gap;
    const belowTop = rect.bottom + gap;
    const fitsAbove = aboveTop >= margin;
    const fitsBelow = belowTop + menuH <= window.innerHeight - margin;
    let top = actionMenuAnchor.preferAbove
        ? (fitsAbove || !fitsBelow ? aboveTop : belowTop)
        : (fitsBelow || !fitsAbove ? belowTop : aboveTop);
    top = Math.min(Math.max(margin, top), window.innerHeight - menuH - margin);
    actionMenu.style.left = `${Math.max(margin, left)}px`;
    actionMenu.style.top = `${Math.max(margin, top)}px`;
}
window.addEventListener('resize', positionActionMenu);

// [互動] 按鈕沒有 data-cmd 時 (多個對象,或唯一的對象是 NPC/玩家),點擊切換選單
interactButton.addEventListener('click', () => {
    if (interactButton.dataset.cmd) return; // 單一裝飾物:交給 document 的指令連結處理
    if (!actionMenu.hidden && actionMenuOwner === interactButton) {
        hideActionMenu();
        return;
    }
    const only = roomInteractItems.length === 1 ? roomInteractItems[0] : null;
    if (only?.actions) openEntityMenu(interactButton, getInteractButtonRect, only.label, only.actions, { preferAbove: true });
    else openInteractListMenu();
});

// 快捷列的「攻擊」:房內可攻擊的對象 ([互動] 清單中有 kill 指令的 NPC) 列成卷軸選單,點了送出 kill;
// 沒有對象時顯示說明。房內異動 (refresh) 時依最新清單重畫,NPC 死亡後的 "2.orc" 編號也會跟著更新
// 同名的怪物 (兩隻野豬) 加上編號「#2」,玩家才分得出來;編號與 kill 指令的 "2.boar" 順序一致
function getKillTargets() {
    const targets = roomInteractItems.flatMap(item => {
        const kill = item.actions?.find(action => action.cmd.split(' ')[0] === 'kill');
        return kill ? [{ label: item.label, cmd: kill.cmd }] : [];
    });
    const total = new Map();
    targets.forEach(t => total.set(t.label, (total.get(t.label) || 0) + 1));
    const seen = new Map();
    return targets.map(t => {
        if (total.get(t.label) < 2) return t;
        const n = (seen.get(t.label) || 0) + 1;
        seen.set(t.label, n);
        return { ...t, label: `${t.label} #${n}` };
    });
}
const getQuickKillRect = () => quickKillButton.getBoundingClientRect();
function openQuickKillMenu({ preferAbove = true, animate = true } = {}) {
    const targets = getKillTargets();
    const items = targets.length ? targets : [{ label: '這裡沒有可以攻擊的對象', note: true }];
    openActionMenu(quickKillButton, getQuickKillRect, '攻擊', items, { preferAbove, animate, view: { type: 'kill' } });
}
quickKillButton.addEventListener('click', () => {
    if (!actionMenu.hidden && actionMenuOwner === quickKillButton) {
        hideActionMenu();
        return;
    }
    openQuickKillMenu();
});

// look 房間時 NPC / 其他玩家行尾的 [互動] (.entity-link):點擊跳出卷軸選單 (NPC:查看/攻擊;玩家:查看)
document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('.entity-link') : null;
    if (!link) return;
    // 拖曳選取文字時不開選單
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (!actionMenu.hidden && actionMenuOwner === link) {
        hideActionMenu();
        return;
    }
    let actions;
    try {
        actions = JSON.parse(link.dataset.actions || '[]');
    } catch {
        return;
    }
    actions = Array.isArray(actions) ? actions.filter(isValidActionCmd) : [];
    if (!actions.length) return;
    const title = link.dataset.title;
    const getRect = () => link.getBoundingClientRect();
    // 舊訊息裡的連結:以房間目前的清單為準 (NPC 死亡後編號會變);對象已不在房間時不送舊指令,避免打到別的目標
    const current = findCurrentActions(title, actions);
    if (current) openEntityMenu(link, getRect, title, current);
    else openActionMenu(link, getRect, title, [{ label: '已不在這裡', note: true }]);
});

// 點送出指令的選單項目 (指令由 document 的指令連結處理送出) 或點選單以外的地方時收起;開啟選單的元素自己處理切換
// 用 composedPath (事件發生當下的路徑):子選單 / 返回會先替換選單內容,這時 target 已離開 DOM,closest 找不到選單
document.addEventListener('click', event => {
    if (actionMenu.hidden) return;
    const path = event.composedPath().filter(node => node instanceof Element);
    const opener = path.find(el => el.id === 'interactButton' || el.id === 'quickKill' || el.classList.contains('entity-link'));
    if (opener && (opener === actionMenuOwner || opener.classList.contains('entity-link'))) return;
    if (path.includes(actionMenu) && !path.some(el => el.classList.contains('scroll-menu-item') && el.dataset.cmd)) return;
    // 等 document 的指令連結處理讀完 data-cmd 再清空選單
    setTimeout(hideActionMenu, 0);
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !actionMenu.hidden) hideActionMenu();
});

// 名稱 + 生命百分比,例如「哥布林 (35%)」
function setNameAndHp(nameId, hpId, name, hp) {
    $(nameId).textContent = name || '';
    $(hpId).textContent = name && hp?.max > 0 ? `(${Math.round(hp.current / hp.max * 100)}%)` : '';
}

// 玩家名稱 / 血量保留 1.2 倍寬度,讓上方同時出現的 DOT、HOT 都留在玩家區內,不會像是目標的資訊
const SELF_NAME_WIDTH_RATIO = 1.2;
function reserveSelfNameWidth() {
    for (const id of ['targetTargetName', 'targetTargetHp']) {
        const el = $(id);
        el.style.minWidth = '';
        const width = el.getBoundingClientRect().width;
        if (width > 0) el.style.minWidth = `${Math.ceil(width * SELF_NAME_WIDTH_RATIO)}px`;
    }
}

const EMPTY_STATUS = {
    hp: { current: 0, max: 0 }, mana: { current: 0, max: 0 }, move: { current: 0, max: 0 },
    status: {}, target: {}, combat: {}, attributes: {}
};

function updateStatus(data) {
    EFFECT_KEYS.forEach(key => {
        document.querySelector(`.status-effect.${key}`).classList.toggle('active', !!data.status?.[key]);
    });

    const { targetName, targetHp } = data.target || {};
    setNameAndHp('targetName', 'targetHp', targetName, targetHp);
    // 左側固定顯示玩家自己的名稱與生命比例
    setNameAndHp('targetTargetName', 'targetTargetHp', data.playerName || '我', data.hp);
    reserveSelfNameWidth();
    // 沒有目標時隱藏箭頭
    document.querySelector('#targetInfoBar .target-arrow-icon').style.visibility = targetName ? 'visible' : 'hidden';

    for (const [key, id] of [['hp', 'Hp'], ['mana', 'Mana'], ['move', 'Move']]) {
        const { current, max } = data[key];
        $(`current${id}`).textContent = String(current);
        $(`max${id}`).textContent = String(max);
        document.querySelector(`.status-${key} .progress-bar`).style.width = `${max > 0 ? current / max * 100 : 0}%`;
    }

    const combat = data.combat || {};
    const attributes = data.attributes || {};
    const values = {
        level: data.level, gold: data.gold, armor: combat.armor, damroll: combat.damroll, hitRate: combat.hitRate,
        str: attributes.str, int: attributes.int, dex: attributes.dex, wis: attributes.wis, con: attributes.con
    };
    for (const [id, value] of Object.entries(values)) $(id).textContent = String(value || 0);
    $('thirsty').textContent = `${data.thirsty || 0}%`;
    $('hungry').textContent = `${data.hungry || 0}%`;
}

// 依行對應指令,把該行包成可點擊文字(cmds[i] 為空則不處理)
function linkifyLines(html, cmds) {
    if (!Array.isArray(cmds) || !cmds.length) return html;
    return html.split('\n').map((line, i) => {
        const cmd = cmds[i];
        if (!cmd || !line) return line;
        return `<span class="item-link" data-cmd="${cmd.replace(/"/g, '&quot;')}">${line}</span>`;
    }).join('\n');
}

function updateEqInv(data) {
    // 裝備每行前面的耐久度 (例如 85/100) 不顯示
    $('equipmentList').innerHTML = data.eq
        ? linkifyLines(data.eq.replace(/(^|\n)(?:<span\b[^>]*>)?(?:\d+\/\d+|---\/---)(?:<\/span>)?[ \t]*/gi, '$1'), data.eqCmds)
        : '無裝備';
    $('inventoryList').innerHTML = data.inv ? linkifyLines(data.inv, data.invCmds) : '無物品';
}

const accountSection = $('accountSection');
const cnNameInput = $('cnNameInput');
const configToggles = $('configToggles');
const CONFIG_TOGGLES = [
    [1, 'autoattack', '自動普通攻擊'],
    [2, 'seeOtherDmg', '檢視其他玩家的普通攻擊'],
    [3, 'autoloot', '自動拾取戰利品'],
    [4, 'displayRecover', '顯示每小時的自動恢復量'],
    [5, 'displayCooldown', '顯示冷卻中技能'],
    [6, 'displayStats', '顯示生命狀態'],
    [7, 'displayBody', '顯示身體機能'],
    [9, 'displayHint', '顯示遊戲訣竅'],
    [10, 'displayLoginOut', '顯示所有玩家登入與登出資訊'],
    [11, 'eventSound', '活動提醒音效'],
    [12, 'displayDayNight', '顯示晝夜變化訊息'],
    [13, 'displayWeather', '顯示天氣變化訊息']
];
CONFIG_TOGGLES.forEach(([id, key, label]) => {
    const row = document.createElement('label');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'form-check-input m-0' });
    box.dataset.configKey = key;
    box.addEventListener('change', () => sendMessage(`config ${box.checked ? '+' : '-'} ${id}`));
    row.append(box, label);
    configToggles.append(row);
});

function updateProfile(p) {
    accountSection.hidden = !p.loggedIn;
    setQuickBarVisible(p.loggedIn === true);
    if (!p.loggedIn) return;
    if (document.activeElement !== cnNameInput) cnNameInput.value = p.cnName || '';
    $('mailText').textContent = p.mail || '(未設定)';
    $('mailStatus').textContent = p.mailVerified ? '已驗證' : '未驗證';
    $('verifyRow').hidden = p.mailVerified || !p.mail;
    // 已經寄過驗證碼:按鈕改成「再次發送」(伺服器的訊息會說明還要等多久)
    $('sendVerifyMailButton').textContent = p.mailCodeSent ? '再次發送' : '發送驗證信';
    // 修改密碼:信箱驗證後才能用 (驗證碼寄到信箱)
    $('passwordChangeSection').hidden = !p.mailVerified;
    profileName = p.name || '';
    configToggles.querySelectorAll('input[data-config-key]').forEach(box => {
        box.checked = !!p.config?.[box.dataset.configKey];
    });
}

// 送出輸入框內容後清空,有值才執行 command(value)
function submitInput(input, command) {
    const value = input.value.trim();
    if (!value) return;
    sendMessage(command(value));
    input.value = '';
}
$('cnNameButton').addEventListener('click', () => {
    const name = cnNameInput.value.trim();
    if (name) sendMessage(`config + 0 ${name}`);
});
$('sendVerifyMailButton').addEventListener('click', () => sendMessage('verifymail send'));
const submitVerifyCode = () => submitInput($('verifyCodeInput'), code => `verifymail ${code}`);
$('submitVerifyCodeButton').addEventListener('click', submitVerifyCode);
$('verifyCodeInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        submitVerifyCode();
    }
});
// ===== 修改密碼 (冒險者設定) =====
// 1. 輸入新密碼 → { account: { action: 'requestPasswordChange' } },伺服器寄 6 位數驗證碼
// 2. 輸入驗證碼 → { account: { action: 'confirmPasswordChange' } }
// 伺服器回 { type: 'account', action: 'passwordChange', ok, stage: 'codeSent' | 'done', field, message }
// 走結構化訊息 (sendAccount):密碼不經過輸入框,不會顯示在畫面上或進指令歷史
let profileName = '';
let pendingNewPassword = null; // 驗證成功後,有「記住我」的話更新自動登入的密碼
function sendAccount(payload) {
    if (!isOpen()) return false;
    ws.send(JSON.stringify({ account: payload, view: getClientView() }));
    resetInactivityTimer();
    return true;
}
function setPasswordChangeStatus(message, state) {
    const status = $('passwordChangeStatus');
    status.textContent = message || '';
    status.classList.toggle('is-error', state === 'error');
    status.classList.toggle('is-ok', state === 'ok');
}
const PASSWORD_RULE = /^[A-Za-z0-9!@#$%^&*()_+={}[\]:<>.?/~`-]{5,10}$/;
$('requestPasswordChangeButton').addEventListener('click', () => {
    const newPassword = $('newPasswordInput').value;
    const confirmPassword = $('confirmPasswordInput').value;
    if (!PASSWORD_RULE.test(newPassword)) return setPasswordChangeStatus('新密碼需為 5~10 個英文、數字或符號 (不可含逗號與空白)', 'error');
    if (newPassword !== confirmPassword) return setPasswordChangeStatus('兩次輸入的新密碼不一樣', 'error');
    if (!sendAccount({ action: 'requestPasswordChange', newPassword, confirmPassword })) return setPasswordChangeStatus('尚未連線', 'error');
    pendingNewPassword = newPassword;
    setPasswordChangeStatus('寄送中…');
});
const confirmPasswordChange = () => {
    const code = $('passwordChangeCodeInput').value.trim();
    if (!/^\d{6}$/.test(code)) return setPasswordChangeStatus('請輸入信中的 6 位數驗證碼', 'error');
    if (!sendAccount({ action: 'confirmPasswordChange', code })) return setPasswordChangeStatus('尚未連線', 'error');
    setPasswordChangeStatus('驗證中…');
};
$('confirmPasswordChangeButton').addEventListener('click', confirmPasswordChange);
$('passwordChangeCodeInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        confirmPasswordChange();
    }
});
function updateAccount(data) {
    if (data.action !== 'passwordChange') return;
    setPasswordChangeStatus(data.message, data.ok ? 'ok' : 'error');
    if (data.ok && data.stage === 'codeSent') {
        $('passwordChangeCodeInput').focus();
    } else if (data.ok && data.stage === 'done') {
        // 有記住這個帳號的話,自動登入改用新密碼,下次才不會登入失敗
        if (pendingNewPassword && currentSettings.account && currentSettings.account === profileName.toLowerCase()) {
            saveCredentials(currentSettings.account, pendingNewPassword);
        }
        pendingNewPassword = null;
        for (const id of ['newPasswordInput', 'confirmPasswordInput', 'passwordChangeCodeInput']) $(id).value = '';
    } else if (data.field === 'code') {
        $('passwordChangeCodeInput').select();
    }
}

$('deleteCharacterButton').addEventListener('click', () => {
    if (confirm('確定要永久刪除這個角色嗎？此動作無法復原。')) sendMessage('config deletenow');
});
const redeemCodeInput = $('redeemCodeInput');
const submitRedeemCode = () => submitInput(redeemCodeInput, code => `redeem ${code}`);
$('redeemCodeButton').addEventListener('click', submitRedeemCode);
redeemCodeInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        submitRedeemCode();
    }
});

// ===== 連線 =====
function appendOutput(html) {
    outputDiv.insertAdjacentHTML('beforeend', html);
    while (outputDiv.childNodes.length > MAX_OUTPUT_LINES) outputDiv.firstChild.remove();
    scrollOutputToBottom();
}

// server 通知目前是否在輸入密碼 (登入 / 建立角色)
function setPasswordInputMode(enabled) {
    isPasswordInput = enabled;
    inputBox.type = enabled ? 'password' : 'text';
    inputBox.setAttribute('autocomplete', enabled ? 'current-password' : 'off');
    if (enabled) inputBox.value = '';
}

const MESSAGE_HANDLERS = {
    status: updateStatus,
    eqinv: updateEqInv,
    chat: updateChat,
    mode: data => { inputMode = data.mode || null; },
    map: updateMap,
    profile: updateProfile,
    dot: showDotFloat,
    hot: showHotFloat,
    passwordInput: data => setPasswordInputMode(data.enabled === true),
    bossEvent: updateBossEvent,
    roomInteract: updateRoomInteract,
    account: updateAccount,
    // 轉輪機 / 賭桌在 casino.js:呼叫時才查找,game.js 本身不依賴載入順序
    slot: data => updateSlot(data),
    casino: data => updateCasino(data),
    // 英雄額外屬性點數的分配畫面在 hero.js
    heroAttr: data => updateHeroAttrPanel(data),
    // 登入 / 創角畫面在 auth.js (自動登入也在那裡,不再比對文字提示)
    auth: data => updateAuth(data),
    // 城鎮地圖 (查看 / 使用地圖物品) 在 areamap.js
    areaMap: data => updateAreaMap(data)
};

// 登入畫面的結構化訊息 (帳密不經過輸入框,不顯示、不記錄歷史)
function sendAuth(payload) {
    if (!isOpen()) return false;
    ws.send(JSON.stringify({ auth: payload, view: getClientView() }));
    resetInactivityTimer();
    return true;
}

function handleTextMessage(text) {
    appendOutput(`<p>${text}</p>`);
}

function connect() {
    inputMode = null;
    setPasswordInputMode(false);
    clearTimeout(reconnectTimer);
    const socket = new WebSocket(SERVER_URL);
    ws = socket;
    socket.onopen = () => {
        diagOnOpen(socket);
        // 原本指向不存在的 logo.jpg (404);改用與登入畫面、分享預覽相同的 og-image.jpg,相對路徑本機也看得到
        appendOutput('<p><img class="welcome-banner" src="./assets/images/og-image.jpg" width="1200" height="630" alt="瑪爾斯群英傳:起源 Mars: Origin"></p>');
        resetInactivityTimer();
        console.log(`[WS ${new Date().toISOString()}] OPEN url=${SERVER_URL}`);
    };

    socket.onmessage = async event => {
        if (socket !== ws) return; // 舊連線的殘留訊息
        diag.lastServerMsgAt = Date.now();
        const text = String(event.data);
        if (text.startsWith('{"type":"pong"')) return diagOnPong(text); // 診斷用 pong:不重設閒置計時器

        let data;
        try { data = JSON.parse(text); } catch (e) { data = undefined; }
        if (data === undefined) {
            await handleTextMessage(text);
        } else {
            MESSAGE_HANDLERS[data?.type]?.(data);
        }
        scrollOutputToBottom();
        resetInactivityTimer();
    };

    socket.onclose = event => {
        diagEvent('close', event.code);
        diagSaveReport(event, null);
        if (socket === diag.socket) clearInterval(diag.timer);
        console.log(`[WS ${new Date().toISOString()}] CLOSE`,
            { code: event.code, reason: event.reason, wasClean: event.wasClean, readyState: socket.readyState });
        // 已被新連線取代的舊 socket:不可影響目前的 ws
        if (socket !== ws) return;
        ws = null;
        inputMode = null;
        appendOutput('<span style="color: red;">與伺服器中斷連線。</span>');
        clearTimeout(inactivityTimer);
        resetUI();
        reconnectTimer = setTimeout(connect, RECONNECT_MS);
    };

    socket.onerror = error => {
        diagEvent('error');
        console.error('WebSocket 錯誤:', error);
    };
}

function sendRaw(command) {
    ws.send(JSON.stringify({ command, mode: inputMode, view: getClientView() }));
    resetInactivityTimer();
}

// 不帶參數時送出輸入框內容
// silent: true 時不回顯送出的指令文字、也不記錄到指令歷史 (給 [點擊參加] 連結、活動按鈕這類不是玩家手動輸入的指令用)
function sendMessage(message, { silent = false } = {}) {
    const fromInput = !message;
    if (fromInput) message = inputBox.value.trim();
    if (!message) return;
    if (!isOpen()) {
        appendOutput('<span style="color: red;">尚未連線，請稍候重新連線或重新整理頁面。</span>\n');
        return;
    }
    sendRaw(message);

    // 密碼輸入:不顯示在 output、不記錄歷史、清空輸入框
    if (isPasswordInput) {
        inputBox.value = '';
        return;
    }

    if (!silent) {
        appendOutput(`<span style="color: yellow;">${escapeHtml(message)}</span>\n`);
        if (!commandHistory.includes(message)) {
            commandHistory.unshift(message);
            if (commandHistory.length > MAX_COMMAND_HISTORY) commandHistory.pop();
        }
        currentHistoryIndex = -1;
    }
    if (fromInput) inputBox.select();
}

function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
        // 超過 300 秒沒有動作:登出並在 10 秒後自動重連
        if (isOpen()) appendOutput('<span style="color: yellow;">超過300秒沒有動作，系統已自動登出</span>');
        inputMode = null;
        const old = ws;
        ws = null; // 先清空,避免舊 socket 的 onclose 影響之後的新連線
        if (old) {
            old.__closeSource = 'idle_300s';
            try { old.close(); } catch (e) { /* ignore */ }
        }
        resetUI();
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, RECONNECT_MS);
    }, IDLE_LOGOUT_MS);
}

// 玩家中斷時重置 UI
function resetUI() {
    accountSection.hidden = true;
    setQuickBarVisible(false);
    inputBox.value = '';
    updateStatus(EMPTY_STATUS);
    setNameAndHp('targetTargetName', 'targetTargetHp', '', null);
    reserveSelfNameWidth();
    $('equipmentList').innerHTML = '';
    $('inventoryList').innerHTML = '';
    // 斷線期間可能活動已結束,重新連線後由伺服器依目前狀態補送,這裡先清空避免殘留
    activeBossEvents.clear();
    refreshBossEventButton();
    updateRoomInteract({ items: [] });
    closeSlotPanel();
    closeCasinoPanel();
}

// ===== 輸入 =====
$('sendButton').addEventListener('click', () => sendMessage());

// 裝備/物品清單的指令連結、活動按鈕與手機方向按鈕;data-silent="true" 的連結/按鈕不回顯送出的指令文字
document.addEventListener('click', event => {
    const target = event.target.closest?.('.item-link, .numpad-btn');
    if (target?.dataset.cmd) sendMessage(target.dataset.cmd, { silent: target.dataset.silent === 'true' });
});

// 點擊畫面後,游標自動回到輸入框,不必再用滑鼠點輸入框就能直接打指令
// 不處理的情況: 輸出區(方便選取複製文字,但 .item-link 指令連結除外)、有選取文字、
//              設定面板內部(要打字,但「關閉」「預設」按鈕除外)、其他輸入元件
// 觸控裝置不處理(避免虛擬鍵盤一直彈出),發送按鈕、方向按鈕(numpad)與指令連結例外
(function refocusInputAfterClick() {
    const focusInput = () => {
        if (document.activeElement !== inputBox) inputBox.focus({ preventScroll: true });
    };
    const refocusSoon = () => {
        // 等元件自己的處理(切分頁、重繪地圖、關閉設定)完成後再聚焦;再補一次避免被瀏覽器的按鈕焦點覆蓋
        setTimeout(focusInput, 0);
        requestAnimationFrame(focusInput);
    };
    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        // 沒有 data-cmd 的 (例如多個物件時的 [互動] 按鈕,只負責開選單) 不算指令連結,避免手機彈出鍵盤蓋住選單
        const isCommandLink = !!target.closest('.item-link:not([data-cmd=""])');
        const isSend = !!target.closest('#sendButton, .mobile-numpad');
        if (event.pointerType === 'touch' && !isCommandLink && !isSend) return;
        // 快捷列是為了不用打字:觸控點擊後不聚焦輸入框,避免虛擬鍵盤彈出蓋住畫面
        if (event.pointerType === 'touch' && target.closest('#quickBar')) return;
        if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (target.closest('#settingsPanel') && !target.closest('#settingsClose, #settingsReset')) return;
        // 轉輪機 / 賭桌 / 英雄屬性 / 登入畫面:焦點留在面板內,鍵盤可以直接操作
        if (target.closest('#slotPanel, #casinoPanel, #heroAttrPanel, #authPanel, #areaMapPanel')) return;
        if (!isCommandLink && target.closest('#output-container, #chatArea')) return;
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && !isCommandLink) return;
        refocusSoon();
    });
    // Esc 關閉設定面板後也回到輸入框
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && $('authPanel').hidden) refocusSoon();
    });
})();

inputBox.addEventListener('keypress', event => {
    if (event.key === 'Enter') {
        sendMessage();
        event.preventDefault();
    }
});

// 上下鍵切換命令歷史
inputBox.addEventListener('keydown', event => {
    const step = { ArrowUp: 1, ArrowDown: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = currentHistoryIndex + step;
    if (next < -1 || next >= commandHistory.length) return;
    currentHistoryIndex = next;
    inputBox.value = next === -1 ? '' : commandHistory[next];
    inputBox.select();
});

const NUMPAD_COMMANDS = {
    Numpad4: 'west', Numpad5: 'look', Numpad6: 'east', Numpad8: 'north',
    Numpad2: 'south', Numpad9: 'up', Numpad3: 'down'
};
// 互動模式 (鐵匠維修 / 商店購買、販售):數字鍵直接送出
const DIGIT_MODES = ['blacksmith', 'shop-buy', 'shop-sell'];
document.addEventListener('keydown', event => {
    // 登入畫面輸入帳密時,數字鍵盤要能正常打字,不送出方向指令
    if (!$('authPanel').hidden) return;
    let command = null;
    if (event.key === 'Escape' && !settingsPanel.hidden) {
        setSettingsPanelOpen(false);
        settingsButton.focus();
    } else if (event.code === 'ScrollLock') {
        handleTopScroll();
        event.preventDefault();
    } else if (DIGIT_MODES.includes(inputMode) && event.code.startsWith('Digit') && /^[0-9]$/.test(event.key)) {
        command = event.key;
    } else {
        command = NUMPAD_COMMANDS[event.code];
    }
    if (command) {
        sendMessage(command);
        event.preventDefault();
    }
});
