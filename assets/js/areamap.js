// 城鎮地圖檢視 (查看 / 使用地圖物品)。由 index.html 在 game.js 之後載入,使用 game.js 的 $、inputBox
// 伺服器送 { type: 'areaMap', title, image, currentRoomId }
//   image 是 assets/maps/*.svg (tools/build_area_maps.js 產生),房間節點帶 data-room="房間id"
//   currentRoomId 不是 null 時,在該房間加上紅色閃爍標記並置中
// 優先把 SVG 內嵌進頁面 (才能標出位置);讀取失敗 (例如以 file:// 開啟) 時退回 <img>,只是沒有位置標記
const AREA_MAP_MIN_READABLE_SCALE = 0.62; // 預設至少放大到看得清楚名字的比例 (地點名稱約 13px)
const AREA_MAP_MAX_SCALE = 1.6;
const AREA_MAP_ZOOM_STEP = 1.4;

const areaMapPanel = $('areaMapPanel');
const areaMapViewport = $('areaMapViewport');
const areaMapCanvas = $('areaMapCanvas');

const areaMap = {
    width: 0,
    height: 0,
    scale: 1,
    requestId: 0,
    drag: null
};

function areaMapFitScale() {
    if (!areaMap.width || !areaMap.height) return 1;
    return Math.min(areaMapViewport.clientWidth / areaMap.width, areaMapViewport.clientHeight / areaMap.height);
}

// 以畫面中心 (或指定點) 為基準縮放
function setAreaMapScale(scale, focus) {
    const fit = areaMapFitScale();
    const next = Math.min(Math.max(scale, Math.min(fit, AREA_MAP_MAX_SCALE)), AREA_MAP_MAX_SCALE);
    const vw = areaMapViewport.clientWidth;
    const vh = areaMapViewport.clientHeight;
    const point = focus || { x: vw / 2, y: vh / 2 };
    const mapX = (areaMapViewport.scrollLeft + point.x) / areaMap.scale;
    const mapY = (areaMapViewport.scrollTop + point.y) / areaMap.scale;
    areaMap.scale = next;
    areaMapCanvas.style.width = `${Math.round(areaMap.width * next)}px`;
    areaMapCanvas.style.height = `${Math.round(areaMap.height * next)}px`;
    areaMapViewport.scrollLeft = mapX * next - point.x;
    areaMapViewport.scrollTop = mapY * next - point.y;
    $('areaMapZoomOut').disabled = next <= fit + 0.001;
    $('areaMapZoomIn').disabled = next >= AREA_MAP_MAX_SCALE - 0.001;
}

function centerAreaMapOn(mapX, mapY) {
    areaMapViewport.scrollLeft = mapX * areaMap.scale - areaMapViewport.clientWidth / 2;
    areaMapViewport.scrollTop = mapY * areaMap.scale - areaMapViewport.clientHeight / 2;
}

// 在目前房間加上閃爍的紅圈;回傳房間中心 (地圖座標) 或 null
function markAreaMapRoom(svg, roomId) {
    if (!roomId) return null;
    const node = svg.querySelector(`[data-room="${CSS.escape(String(roomId))}"]`);
    if (!node) return null;
    node.classList.add('am-here');
    const box = node.getBBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('class', 'am-pin');
    ring.setAttribute('cx', cx);
    ring.setAttribute('cy', cy);
    ring.setAttribute('r', Math.max(box.width, box.height) / 2 + 16);
    svg.appendChild(ring);
    return { x: cx, y: cy };
}

function layoutAreaMap(here) {
    // 大地圖在小螢幕上「全圖」會小到看不清,預設放大到可讀並以目前位置 (或中心) 為準;按「全圖」可看整張
    const start = Math.max(areaMapFitScale(), AREA_MAP_MIN_READABLE_SCALE);
    areaMap.scale = start;
    setAreaMapScale(start);
    if (here) centerAreaMapOn(here.x, here.y);
    else centerAreaMapOn(areaMap.width / 2, areaMap.height / 2);
}

function showAreaMapImage(src) {
    const img = new Image();
    img.alt = $('areaMapTitle').textContent;
    img.onload = () => {
        areaMap.width = img.naturalWidth || 1600;
        areaMap.height = img.naturalHeight || 1200;
        layoutAreaMap(null);
    };
    areaMapCanvas.replaceChildren(img);
    img.src = src;
}

async function openAreaMap(data) {
    const requestId = ++areaMap.requestId;
    $('areaMapTitle').textContent = data.title || '地圖';
    $('areaMapHint').textContent = data.currentRoomId
        ? '紅圈是你目前的位置;拖曳移動地圖,用 + / − 縮放'
        : '拖曳移動地圖;用 + / − 縮放';
    areaMapCanvas.replaceChildren();
    areaMapPanel.hidden = false;
    areaMapViewport.focus({ preventScroll: true });
    const src = String(data.image || '');
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (requestId !== areaMap.requestId) return;
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const svg = doc.documentElement;
        if (svg.nodeName !== 'svg') throw new Error('not svg');
        const [, , w, h] = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
        areaMap.width = w || Number(svg.getAttribute('width')) || 1600;
        areaMap.height = h || Number(svg.getAttribute('height')) || 1200;
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        const inline = document.importNode(svg, true);
        areaMapCanvas.replaceChildren(inline);
        layoutAreaMap(markAreaMapRoom(inline, data.currentRoomId));
    } catch (error) {
        if (requestId !== areaMap.requestId) return;
        showAreaMapImage(src);
    }
}

function closeAreaMap() {
    areaMap.requestId++;
    areaMapPanel.hidden = true;
    areaMapCanvas.replaceChildren();
    inputBox.focus();
}

function updateAreaMap(data) {
    openAreaMap(data);
}

$('areaMapClose').addEventListener('click', closeAreaMap);
$('areaMapZoomIn').addEventListener('click', () => setAreaMapScale(areaMap.scale * AREA_MAP_ZOOM_STEP));
$('areaMapZoomOut').addEventListener('click', () => setAreaMapScale(areaMap.scale / AREA_MAP_ZOOM_STEP));
$('areaMapFit').addEventListener('click', () => setAreaMapScale(areaMapFitScale()));
areaMapPanel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        event.stopPropagation();
        closeAreaMap();
    } else if (event.key === '+' || event.key === '=') {
        setAreaMapScale(areaMap.scale * AREA_MAP_ZOOM_STEP);
    } else if (event.key === '-') {
        setAreaMapScale(areaMap.scale / AREA_MAP_ZOOM_STEP);
    }
});
// Ctrl / ⌘ + 滾輪縮放 (一般滾輪照常捲動)
areaMapViewport.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = areaMapViewport.getBoundingClientRect();
    const factor = event.deltaY < 0 ? AREA_MAP_ZOOM_STEP : 1 / AREA_MAP_ZOOM_STEP;
    setAreaMapScale(areaMap.scale * factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
}, { passive: false });
// 滑鼠拖曳移動 (觸控用原生捲動)
areaMapViewport.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    areaMap.drag = { x: event.clientX, y: event.clientY, left: areaMapViewport.scrollLeft, top: areaMapViewport.scrollTop };
    areaMapViewport.setPointerCapture(event.pointerId);
    areaMapViewport.classList.add('is-dragging');
});
areaMapViewport.addEventListener('pointermove', event => {
    if (!areaMap.drag) return;
    areaMapViewport.scrollLeft = areaMap.drag.left - (event.clientX - areaMap.drag.x);
    areaMapViewport.scrollTop = areaMap.drag.top - (event.clientY - areaMap.drag.y);
});
const endAreaMapDrag = () => {
    areaMap.drag = null;
    areaMapViewport.classList.remove('is-dragging');
};
areaMapViewport.addEventListener('pointerup', endAreaMapDrag);
areaMapViewport.addEventListener('pointercancel', endAreaMapDrag);
window.addEventListener('resize', () => {
    if (!areaMapPanel.hidden && areaMap.width) setAreaMapScale(areaMap.scale);
});
