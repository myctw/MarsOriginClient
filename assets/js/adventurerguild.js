// 冒險者商會的畫面 (各王國主城的服務生,adventurerGuild 指令)。由 index.html 在 game.js 之後載入
// 使用 game.js 的 $、ws、isOpen、getClientView、resetInactivityTimer
// 伺服器送 { type: 'adventurerGuild', action }:
//   account { mail, limit, removeFee, gold, members: [角色], others: [角色], message? }   帳號角色畫面
//   locker  { capacity, withdrawFee, gold, inventoryMax, locker: [物品], inventory: [物品], message? }  寄物櫃畫面
//   error   { message, close }
//   角色 { name, cnName, level, className, online, self };物品 { uid, label, count, locked?, reason? }
//   兩種畫面另外帶 storedGold (寄物櫃存款)、subscription (訂閱擴充:level、fees[1~10]、paidUntil…)、suspended (欠費暫停中)
// 點選名稱 / 物品在兩區之間移動 (只改畫面),按儲存 / 確認才送出結構化訊息:
//   { adventurerGuild: { action: 'saveAccount', members: [name] } }
//   { adventurerGuild: { action: 'applyLocker', deposit: [uid], withdraw: [uid] } }
// 存款與訂閱立即送出 (訂閱 / 取消要按兩次確認):
//   { adventurerGuild: { action: 'depositGold' | 'withdrawGold', amount } }
//   { adventurerGuild: { action: 'subscribe', kind, level } }、{ adventurerGuild: { action: 'cancelSubscription', kind } }
const adventurerGuildPanel = $('adventurerGuildPanel');
const adventurerGuildConfirm = $('adventurerGuildConfirm');
const adventurerGuildBanner = $('adventurerGuildBanner');

const adventurerGuild = {
    mode: '',            // 'account' | 'locker'
    data: null,          // 伺服器送來的原始資料
    left: [],            // 帳號角色 / 寄物櫃
    right: [],           // 非帳號角色 / 背包
    pending: false
};

const adventurerGuildFormat = value => Number(value || 0).toLocaleString('en-US');

function sendAdventurerGuild(payload) {
    if (!isOpen()) return false;
    ws.send(JSON.stringify({ adventurerGuild: payload, view: getClientView() }));
    resetInactivityTimer();
    return true;
}

function setAdventurerGuildBanner(message, state = '') {
    adventurerGuildBanner.hidden = !message;
    adventurerGuildBanner.textContent = message || '';
    adventurerGuildBanner.className = `adventurerguild-banner${state ? ` is-${state}` : ''}`;
}

// 帳號模式:原本在帳號內、現在不在的角色 = 移出
function adventurerGuildRemovedCount() {
    const original = new Set(adventurerGuild.data.members.map(c => c.name));
    return [...original].filter(name => !adventurerGuild.left.some(c => c.name === name)).length;
}

// 寄物櫃模式:原本在寄物櫃、現在在背包的物品 = 取出
function adventurerGuildWithdrawUids() {
    const original = new Set(adventurerGuild.data.locker.map(i => i.uid));
    return adventurerGuild.right.filter(i => original.has(i.uid)).map(i => i.uid);
}

function adventurerGuildDepositUids() {
    const original = new Set(adventurerGuild.data.inventory.map(i => i.uid));
    return adventurerGuild.left.filter(i => original.has(i.uid)).map(i => i.uid);
}

function adventurerGuildCost() {
    if (!adventurerGuild.data) return 0;
    return adventurerGuild.mode === 'account'
        ? adventurerGuildRemovedCount() * adventurerGuild.data.removeFee
        : adventurerGuildWithdrawUids().length * adventurerGuild.data.withdrawFee;
}

function adventurerGuildChanged() {
    if (!adventurerGuild.data) return false;
    if (adventurerGuild.mode === 'account') {
        return adventurerGuild.left.map(c => c.name).join('\n') !== adventurerGuild.data.members.map(c => c.name).join('\n');
    }
    return adventurerGuildWithdrawUids().length > 0 || adventurerGuildDepositUids().length > 0;
}

function adventurerGuildItemLabel(item) {
    if (adventurerGuild.mode === 'account') {
        const tags = [item.self ? '目前角色' : '', item.online ? '在線上' : ''].filter(Boolean).join('・');
        return { main: `${item.cnName || item.name}(${item.name})`, sub: `Lv${item.level} ${item.className || ''}${tags ? `・${tags}` : ''}` };
    }
    return { main: item.label, sub: [item.count > 1 ? `×${item.count}` : '', item.reason || ''].filter(Boolean).join('・') };
}

function renderAdventurerGuildList(listEl, items, side) {
    listEl.textContent = '';
    if (items.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'adventurerguild-empty';
        empty.textContent = '(空)';
        listEl.appendChild(empty);
        return;
    }
    items.forEach((item, index) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'adventurerguild-item';
        const { main, sub } = adventurerGuildItemLabel(item);
        const mainEl = document.createElement('span');
        mainEl.className = 'adventurerguild-item-main';
        mainEl.textContent = main;
        const subEl = document.createElement('span');
        subEl.className = 'adventurerguild-item-sub';
        subEl.textContent = sub;
        button.append(mainEl, subEl);
        const moved = adventurerGuild.mode === 'account'
            ? (side === 'left') !== adventurerGuild.data.members.some(c => c.name === item.name)
            : (side === 'left') !== adventurerGuild.data.locker.some(i => i.uid === item.uid);
        if (moved) button.classList.add('is-moved');
        if (item.locked) {
            button.disabled = true;
            button.title = item.reason || '';
        }
        const target = adventurerGuild.mode === 'account'
            ? (side === 'left' ? '非帳號角色區' : '帳號角色區')
            : (side === 'left' ? '背包' : '寄物櫃');
        button.setAttribute('aria-label', `${main}，移到${target}`);
        button.addEventListener('click', () => moveAdventurerGuildItem(side, index));
        li.appendChild(button);
        listEl.appendChild(li);
    });
}

function moveAdventurerGuildItem(side, index) {
    if (adventurerGuild.pending) return;
    const from = side === 'left' ? adventurerGuild.left : adventurerGuild.right;
    const to = side === 'left' ? adventurerGuild.right : adventurerGuild.left;
    const item = from[index];
    if (!item || item.locked) return;
    if (side === 'right') {
        // 移入帳號 / 寄物櫃:檢查上限
        const limit = adventurerGuild.mode === 'account' ? adventurerGuild.data.limit : adventurerGuild.data.capacity;
        if (adventurerGuild.left.length >= limit) {
            setAdventurerGuildBanner(adventurerGuild.mode === 'account' ? `帳號最多 ${limit} 個角色` : `寄物櫃只有 ${limit} 格`, 'error');
            return;
        }
    } else if (adventurerGuild.mode === 'locker' && adventurerGuild.data.inventoryMax && adventurerGuild.right.length >= adventurerGuild.data.inventoryMax) {
        setAdventurerGuildBanner(`背包只能放 ${adventurerGuild.data.inventoryMax} 件`, 'error');
        return;
    }
    from.splice(index, 1);
    to.push(item);
    setAdventurerGuildBanner('');
    renderAdventurerGuild();
}

function renderAdventurerGuild() {
    const isAccount = adventurerGuild.mode === 'account';
    const d = adventurerGuild.data;
    $('adventurerGuildTitle').textContent = isAccount ? '帳號角色' : "冒險者寄物櫃";
    $('adventurerGuildSub').textContent = isAccount ? `冒險者商會・${d.mail}` : "冒險者商會・Adventurer's Locker (帳號共用)";
    $('adventurerGuildLeftName').textContent = isAccount ? '帳號角色區' : '寄物櫃';
    $('adventurerGuildRightName').textContent = isAccount ? '非帳號角色區' : '背包';
    $('adventurerGuildLeftCount').textContent = `${adventurerGuild.left.length}/${isAccount ? d.limit : d.capacity}`;
    $('adventurerGuildRightCount').textContent = isAccount ? `${adventurerGuild.right.length}` : `${adventurerGuild.right.length}/${d.inventoryMax ?? '-'}`;
    $('adventurerGuildNote').textContent = isAccount
        ? `點選角色名稱即可在兩區之間移動，按「儲存」才生效。帳號最多 ${d.limit} 個角色；每移出一個角色需要 ${adventurerGuildFormat(d.removeFee)} 金幣，移入免費。`
        : `點選物品即可在寄物櫃與背包之間移動，按「確認」才生效。存入免費；取出每件需要 ${adventurerGuildFormat(d.withdrawFee)} 金幣 (等級 × 100)。已綁定的物品不能存入。`;
    renderAdventurerGuildList($('adventurerGuildLeftList'), adventurerGuild.left, 'left');
    renderAdventurerGuildList($('adventurerGuildRightList'), adventurerGuild.right, 'right');

    const cost = adventurerGuildCost();
    const enough = (d.gold || 0) >= cost;
    const suspended = Boolean(d.suspended);
    $('adventurerGuildCost').textContent = adventurerGuildFormat(cost);
    $('adventurerGuildCost').classList.toggle('is-short', !enough);
    $('adventurerGuildGold').textContent = adventurerGuildFormat(d.gold);
    adventurerGuildConfirm.textContent = adventurerGuild.pending ? '處理中…' : (isAccount ? '儲存' : '確認');
    adventurerGuildConfirm.disabled = adventurerGuild.pending || suspended || !adventurerGuildChanged() || !enough;
    $('adventurerGuildReset').disabled = adventurerGuild.pending || !adventurerGuildChanged();
    if (adventurerGuildChanged() && !enough) setAdventurerGuildBanner(`金幣不足，需要 ${adventurerGuildFormat(cost)} 金幣`, 'error');
    renderAdventurerGuildGold();
    renderAdventurerGuildSubscription();
}

// ---------- 寄物櫃存款 ----------
function renderAdventurerGuildGold() {
    const box = $('adventurerGuildGoldBox');
    box.hidden = adventurerGuild.mode !== 'locker';
    if (box.hidden) return;
    $('adventurerGuildStored').textContent = adventurerGuildFormat(adventurerGuild.data.storedGold);
    $('adventurerGuildGoldIn').disabled = adventurerGuild.pending;
    // 暫停中只能存入 (補繳),不能提領
    $('adventurerGuildGoldOut').disabled = adventurerGuild.pending || Boolean(adventurerGuild.data.suspended);
}

function sendAdventurerGuildGold(action) {
    if (adventurerGuild.pending) return;
    const amount = Number($('adventurerGuildGoldInput').value);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        setAdventurerGuildBanner('請輸入正確的金額', 'error');
        return;
    }
    if (action === 'depositGold' && amount > (adventurerGuild.data.gold || 0)) {
        setAdventurerGuildBanner(`你身上只有 ${adventurerGuildFormat(adventurerGuild.data.gold)} 金幣`, 'error');
        return;
    }
    if (action === 'withdrawGold' && amount > (adventurerGuild.data.storedGold || 0)) {
        setAdventurerGuildBanner(`寄物櫃存款只有 ${adventurerGuildFormat(adventurerGuild.data.storedGold)} 金幣`, 'error');
        return;
    }
    if (!sendAdventurerGuild({ action, amount })) {
        setAdventurerGuildBanner('尚未連線，請稍候再試', 'error');
        return;
    }
    adventurerGuild.pending = true;
    setAdventurerGuildBanner('處理中…');
    renderAdventurerGuild();
}

// ---------- 訂閱擴充 ----------
// 按兩次才送出:第一次按下改成「再按一次確認」,4 秒內再按才送出
const GUILD_ARM_MS = 4000;
let adventurerGuildArmed = null; // { key, timer }

function armAdventurerGuild(key, button, label, send) {
    if (adventurerGuildArmed?.key === key) {
        clearTimeout(adventurerGuildArmed.timer);
        adventurerGuildArmed = null;
        send();
        return;
    }
    if (adventurerGuildArmed) clearTimeout(adventurerGuildArmed.timer);
    button.textContent = '再按一次確認';
    button.classList.add('is-armed');
    adventurerGuildArmed = {
        key,
        timer: setTimeout(() => {
            adventurerGuildArmed = null;
            button.textContent = label;
            button.classList.remove('is-armed');
        }, GUILD_ARM_MS)
    };
}

function adventurerGuildDate(ms) {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderAdventurerGuildSubscription() {
    const sub = adventurerGuild.data.subscription;
    const box = $('adventurerGuildSubBox');
    box.hidden = !sub;
    if (!sub) return;
    if (adventurerGuildArmed) {
        clearTimeout(adventurerGuildArmed.timer);
        adventurerGuildArmed = null;
    }
    const canManage = adventurerGuild.mode === 'locker' || adventurerGuild.data.isMember;
    const base = adventurerGuild.mode === 'locker' ? adventurerGuild.data.baseCapacity : adventurerGuild.data.baseLimit;
    $('adventurerGuildSubTitle').textContent = `訂閱${sub.title}`;
    $('adventurerGuildSubState').textContent = sub.level
        ? `目前 Lv${sub.level} (+${sub.level * sub.perLevel} ${sub.unit})，已付費到 ${adventurerGuildDate(sub.paidUntil)}`
        : '未訂閱';
    $('adventurerGuildSubRule').textContent =
        `每一級增加 ${sub.perLevel} ${sub.unit} (基本 ${base}，最多 Lv${sub.maxLevel})。訂閱時立即從寄物櫃存款扣除一期費用，`
        + `之後每 ${sub.periodDays} 天從寄物櫃存款扣款一次。不會自動扣款：帳號內的角色使用寄物櫃、存款或帳號角色功能時，才一次補扣已到期的期數。`
        + `存款不足時暫停冒險者商會的所有功能，帳號被處以罰金 (觸發角色的等級 × ${adventurerGuildFormat(sub.penaltyPerLevel)});`
        + '罰金綁定帳號，帳號角色前往冒險者商會時自動從身上扣除，直到繳清。暫停中只能存入存款 (自動補繳訂閱費) 或取消訂閱 (已到期未付的費用仍要繳);'
        + '訂閱費與罰金都繳清才恢復，恢復前不能再訂閱。變更等級從當下重新起算，取消與變更都不退還剩餘天數的費用。'
        + (canManage ? '' : ' (只有帳號內的角色可以變更訂閱)');

    const tbody = $('adventurerGuildSubTable');
    tbody.textContent = '';
    sub.fees.forEach(({ level, fee }) => {
        const tr = document.createElement('tr');
        if (level === sub.level) tr.className = 'is-current';
        const cells = [`Lv${level}`, `+${level * sub.perLevel} ${sub.unit}`, `${adventurerGuildFormat(fee)} 金幣`];
        cells.forEach(text => {
            const td = document.createElement('td');
            td.textContent = text;
            tr.appendChild(td);
        });
        const td = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'adventurerguild-mini';
        const label = level === sub.level ? '目前等級' : (sub.level ? '變更' : '訂閱');
        button.textContent = label;
        button.disabled = !canManage || adventurerGuild.pending || level === sub.level || Boolean(adventurerGuild.data.suspended);
        button.setAttribute('aria-label', `${label}${sub.title} Lv${level}，每 ${sub.periodDays} 天 ${adventurerGuildFormat(fee)} 金幣`);
        button.addEventListener('click', () => armAdventurerGuild(`sub-${level}`, button, label, () => sendAdventurerGuildSub({ action: 'subscribe', kind: sub.kind, level })));
        td.appendChild(button);
        tr.appendChild(td);
        tbody.appendChild(tr);
    });
    const cancel = $('adventurerGuildSubCancel');
    cancel.textContent = '取消訂閱';
    cancel.classList.remove('is-armed');
    cancel.hidden = !sub.level;
    cancel.disabled = !canManage || adventurerGuild.pending;
    cancel.onclick = () => armAdventurerGuild('cancel', cancel, '取消訂閱', () => sendAdventurerGuildSub({ action: 'cancelSubscription', kind: sub.kind }));
}

function sendAdventurerGuildSub(payload) {
    if (adventurerGuild.pending) return;
    if (!sendAdventurerGuild(payload)) {
        setAdventurerGuildBanner('尚未連線，請稍候再試', 'error');
        return;
    }
    adventurerGuild.pending = true;
    setAdventurerGuildBanner('處理中…');
    renderAdventurerGuild();
}

function openAdventurerGuildPanel(mode, data) {
    adventurerGuild.mode = mode;
    adventurerGuild.data = data;
    adventurerGuild.pending = false;
    if (mode === 'account') {
        adventurerGuild.left = [...(data.members || [])];
        adventurerGuild.right = [...(data.others || [])];
    } else {
        adventurerGuild.left = [...(data.locker || [])];
        adventurerGuild.right = [...(data.inventory || [])];
    }
    adventurerGuildPanel.dataset.mode = mode;
    setAdventurerGuildBanner(data.message || '', data.suspended ? 'error' : (data.message ? 'ok' : ''));
    if (data.message) $('adventurerGuildGoldInput').value = '';
    renderAdventurerGuild();
    adventurerGuildPanel.hidden = false;
    $('adventurerGuildClose').focus();
}

function closeAdventurerGuildPanel() {
    adventurerGuildPanel.hidden = true;
    adventurerGuild.pending = false;
}

function resetAdventurerGuild() {
    if (!adventurerGuild.data || adventurerGuild.pending) return;
    openAdventurerGuildPanel(adventurerGuild.mode, { ...adventurerGuild.data, message: '' });
}

function confirmAdventurerGuild() {
    if (!adventurerGuild.data || adventurerGuild.pending || !adventurerGuildChanged()) return;
    const payload = adventurerGuild.mode === 'account'
        ? { action: 'saveAccount', members: adventurerGuild.left.map(c => c.name) }
        : { action: 'applyLocker', deposit: adventurerGuildDepositUids(), withdraw: adventurerGuildWithdrawUids() };
    if (!sendAdventurerGuild(payload)) {
        setAdventurerGuildBanner('尚未連線，請稍候再試', 'error');
        return;
    }
    adventurerGuild.pending = true;
    setAdventurerGuildBanner('處理中…');
    renderAdventurerGuild();
}

function updateAdventurerGuildPanel(data) {
    if (data.action === 'account' || data.action === 'locker') {
        openAdventurerGuildPanel(data.action, data);
    } else if (data.action === 'error') {
        if (adventurerGuildPanel.hidden) return;
        adventurerGuild.pending = false;
        if (data.close) {
            closeAdventurerGuildPanel();
            return;
        }
        setAdventurerGuildBanner(data.message || '操作失敗', 'error');
        renderAdventurerGuild();
    }
}

adventurerGuildConfirm.addEventListener('click', confirmAdventurerGuild);
$('adventurerGuildGoldIn').addEventListener('click', () => sendAdventurerGuildGold('depositGold'));
$('adventurerGuildGoldOut').addEventListener('click', () => sendAdventurerGuildGold('withdrawGold'));
$('adventurerGuildReset').addEventListener('click', resetAdventurerGuild);
$('adventurerGuildClose').addEventListener('click', closeAdventurerGuildPanel);
adventurerGuildPanel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        event.stopPropagation();
        closeAdventurerGuildPanel();
        inputBox.focus();
    }
});
