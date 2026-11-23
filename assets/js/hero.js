// 英雄額外屬性點數的分配畫面 (英雄聖殿廣場的英靈導師,train 指令)。由 index.html 在 game.js 之後載入
// 使用 game.js 的 $、sendMessage、inputBox
// 伺服器送 { type: 'heroAttr', action }:
//   open  { title, points, attributes: [{ key, label, current }] }  開啟畫面 (每項起始分配都是 0)
//   done  { gains }                                                 分配完成,關閉畫面
//   error { message, close }                                        分配失敗 (close: 已不能分配)
// 確認時靜默送出 "train <str> <int> <wis> <dex> <con>";只能分配一次,所以確認按鈕要按兩次
const HERO_ATTR_CONFIRM_WINDOW_MS = 4000;

const heroAttrPanel = $('heroAttrPanel');
const heroAttrList = $('heroAttrList');
const heroAttrConfirm = $('heroAttrConfirm');
const heroAttrBanner = $('heroAttrBanner');

const heroAttr = {
    points: 0,
    attributes: [], // [{ key, label, current, add }]
    armed: false,   // 已按過一次確認,等待第二次
    armTimer: null,
    pending: false  // 已送出,等待伺服器回應
};

function heroAttrRemaining() {
    return heroAttr.points - heroAttr.attributes.reduce((sum, a) => sum + a.add, 0);
}

function renderHeroAttrList() {
    heroAttrList.textContent = '';
    for (const attr of heroAttr.attributes) {
        const row = document.createElement('li');
        row.className = 'hero-attr-row';
        row.dataset.key = attr.key;
        row.innerHTML = `
            <span class="hero-attr-name"><span class="hero-attr-label"></span><span class="hero-attr-key"></span></span>
            <span class="hero-attr-value"><span class="hero-attr-cur"></span><span class="hero-attr-arrow" aria-hidden="true">→</span><strong class="hero-attr-new"></strong></span>
            <button class="hero-attr-btn" type="button" data-step="-1">−</button>
            <output class="hero-attr-add" aria-live="off"></output>
            <button class="hero-attr-btn is-plus" type="button" data-step="1">+</button>`;
        row.querySelector('.hero-attr-label').textContent = attr.label;
        row.querySelector('.hero-attr-key').textContent = attr.key.toUpperCase();
        row.querySelector('.hero-attr-cur').textContent = attr.current;
        row.querySelector('[data-step="-1"]').setAttribute('aria-label', `${attr.label} 減少 1 點`);
        row.querySelector('[data-step="1"]').setAttribute('aria-label', `${attr.label} 增加 1 點`);
        heroAttrList.appendChild(row);
    }
    updateHeroAttr();
}

function setHeroAttrArmed(armed) {
    clearTimeout(heroAttr.armTimer);
    heroAttr.armed = armed;
    heroAttrConfirm.classList.toggle('is-armed', armed);
    heroAttrConfirm.textContent = armed ? '再按一次確認' : '確認分配';
    if (armed) heroAttr.armTimer = setTimeout(() => setHeroAttrArmed(false), HERO_ATTR_CONFIRM_WINDOW_MS);
}

function updateHeroAttr() {
    const remaining = heroAttrRemaining();
    $('heroAttrRemain').textContent = remaining;
    $('heroAttrTotal').textContent = heroAttr.points;
    heroAttrPanel.classList.toggle('is-complete', remaining === 0);
    for (const attr of heroAttr.attributes) {
        const row = heroAttrList.querySelector(`[data-key="${attr.key}"]`);
        if (!row) continue;
        row.classList.toggle('has-add', attr.add > 0);
        row.querySelector('.hero-attr-new').textContent = attr.current + attr.add;
        row.querySelector('.hero-attr-add').textContent = `+${attr.add}`;
        row.querySelector('[data-step="-1"]').disabled = heroAttr.pending || attr.add <= 0;
        row.querySelector('[data-step="1"]').disabled = heroAttr.pending || remaining <= 0;
    }
    $('heroAttrReset').disabled = heroAttr.pending || remaining === heroAttr.points;
    heroAttrConfirm.disabled = heroAttr.pending || remaining !== 0;
    if (remaining !== 0 && heroAttr.armed) setHeroAttrArmed(false);
}

function setHeroAttrBanner(message) {
    heroAttrBanner.textContent = message || '';
    heroAttrBanner.hidden = !message;
}

function openHeroAttrPanel(data) {
    heroAttr.points = Number(data.points) || 0;
    heroAttr.attributes = (data.attributes || []).map(a => ({
        key: String(a.key),
        label: String(a.label),
        current: Number(a.current) || 0,
        add: 0
    }));
    heroAttr.pending = false;
    if (data.title) $('heroAttrTitle').textContent = data.title;
    setHeroAttrBanner('');
    setHeroAttrArmed(false);
    renderHeroAttrList();
    heroAttrPanel.hidden = false;
    heroAttrList.querySelector('.is-plus')?.focus();
}

function closeHeroAttrPanel() {
    heroAttrPanel.hidden = true;
    heroAttr.pending = false;
    setHeroAttrArmed(false);
}

function confirmHeroAttr() {
    if (heroAttr.pending || heroAttrRemaining() !== 0) return;
    if (!heroAttr.armed) {
        setHeroAttrArmed(true);
        return;
    }
    setHeroAttrArmed(false);
    if (!isOpen()) {
        setHeroAttrBanner('尚未連線，請稍後再試');
        return;
    }
    heroAttr.pending = true;
    setHeroAttrBanner('');
    updateHeroAttr();
    sendMessage(`train ${heroAttr.attributes.map(a => a.add).join(' ')}`, { silent: true });
}

function updateHeroAttrPanel(data) {
    if (data.action === 'open') {
        openHeroAttrPanel(data);
    } else if (data.action === 'done') {
        closeHeroAttrPanel();
        inputBox.focus();
    } else if (data.action === 'error') {
        if (data.close) {
            closeHeroAttrPanel();
            return;
        }
        heroAttr.pending = false;
        setHeroAttrBanner(data.message || '分配失敗');
        updateHeroAttr();
    }
}

heroAttrList.addEventListener('click', event => {
    const button = event.target.closest('.hero-attr-btn');
    if (!button || button.disabled) return;
    const attr = heroAttr.attributes.find(a => a.key === button.closest('.hero-attr-row').dataset.key);
    if (!attr) return;
    const step = Number(button.dataset.step);
    if (step > 0 && heroAttrRemaining() <= 0) return;
    attr.add = Math.max(0, attr.add + step);
    updateHeroAttr();
});
$('heroAttrReset').addEventListener('click', () => {
    heroAttr.attributes.forEach(a => { a.add = 0; });
    setHeroAttrBanner('');
    updateHeroAttr();
});
heroAttrConfirm.addEventListener('click', confirmHeroAttr);
$('heroAttrClose').addEventListener('click', closeHeroAttrPanel);
heroAttrPanel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        event.stopPropagation();
        closeHeroAttrPanel();
        inputBox.focus();
    }
});
