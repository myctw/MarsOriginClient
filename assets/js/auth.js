// 登入 / 創角畫面。由 index.html 在 game.js 之後載入
// 使用 game.js 的 $、sendAuth、settingsReady、currentSettings、saveCredentials、clearCredentials、inputBox
// 伺服器送 { type: 'auth', action }:
//   show       { classes, genders, attributes, points, base, maxPerAttr, rules }  連線時開啟畫面
//   nameStatus { name, valid, available, message }                              創角帳號檢查
//   error      { form: 'login' | 'create', field, message }                    失敗 (field 為 null 時顯示在表單底部)
//   success    {}                                                              已進入遊戲,關閉畫面
//   forgotResult { ok, message }                                               忘記密碼的回覆 (不透露帳號是否存在)
// 送出 { auth: { action: 'login' | 'checkName' | 'create' | 'forgotPassword', ... } } (sendAuth);本地檢查只用來提示,以伺服器驗證為準
// 規則與伺服器 (src/service/authUi.js、str_util) 相同
const AUTH_RULES = {
    name: /^[A-Za-z]{3,10}$/,
    password: /^[A-Za-z0-9!@#$%^&*()_+={}[\]:<>.?/~`-]{5,10}$/,
    cnName: /^[一-龥A-Za-z0-9]{1,8}$/,
    mail: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
};
const AUTH_NAME_CHECK_DELAY_MS = 400;
const AUTH_STEP_COUNT = 5;
// 伺服器回傳的錯誤欄位 → 所在步驟與提示元素
const AUTH_FIELD_STEPS = { name: 1, password: 1, password2: 1, cnName: 2, gender: 2, classId: 3, attrs: 4, mail: 5 };
const AUTH_FIELD_HINTS = {
    name: 'authNameHint', password: 'authPasswordHint', password2: 'authPassword2Hint', cnName: 'authCnNameHint',
    gender: 'authGenderHint', classId: 'authClassHint', attrs: 'authAttrHint', mail: 'authMailHint'
};
const AUTH_FIELD_INPUTS = { name: 'authName', password: 'authPassword', password2: 'authPassword2', cnName: 'authCnName', mail: 'authMail' };

const authPanel = $('authPanel');
const authLoginForm = $('authLoginForm');
const authCreateForm = $('authCreateForm');
const authForgotForm = $('authForgotForm');

const auth = {
    config: null,        // show 送來的職業、性別、屬性與規則
    step: 1,
    attrs: {},           // { str: 0, ... } 額外分配的點數
    pending: null,       // { form, name, password, remember } 等待伺服器回應
    nameStatus: null,    // 最近一次帳號檢查結果
    nameTimer: null,
    autoLoginFailed: false,
    defaultHints: {}     // 每個提示元素的預設文字 (錯誤清除後還原)
};

// ===== 共用 =====
function setAuthHint(hintId, message, state) {
    const hint = $(hintId);
    if (!hint) return;
    hint.textContent = message ?? auth.defaultHints[hintId] ?? '';
    hint.classList.toggle('is-error', state === 'error');
    hint.classList.toggle('is-ok', state === 'ok');
}

function setFieldError(field, message) {
    const hintId = AUTH_FIELD_HINTS[field];
    if (hintId) setAuthHint(hintId, message, message ? 'error' : null);
    const input = $(AUTH_FIELD_INPUTS[field]);
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function setFormError(element, message) {
    element.textContent = message || '';
    element.hidden = !message;
}

function setAuthBusy(busy) {
    authPanel.classList.toggle('is-busy', busy);
    authPanel.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    if (!busy) updateAuthAttrs();
}

// view: 'login' | 'create' | 'forgot'
function showAuthView(view) {
    authPanel.dataset.view = view; // 創角時橫幅裁短 (auth.css)
    authLoginForm.hidden = view !== 'login';
    authCreateForm.hidden = view !== 'create';
    authForgotForm.hidden = view !== 'forgot';
    $('authTitle').textContent = { login: '登入', create: '建立新角色', forgot: '忘記密碼' }[view];
    setFormError($('authLoginError'), '');
    setFormError($('authCreateError'), '');
    setFormError($('authForgotError'), '');
    if (view === 'login') {
        $(currentAuthLoginFocus()).focus();
    } else if (view === 'create') {
        showAuthStep(1);
    } else {
        // 從登入畫面帶入已輸入的帳號
        if (!$('authForgotName').value) $('authForgotName').value = $('authLoginName').value.trim();
        setFormError($('authForgotResult'), '');
        $(($('authForgotName').value ? 'authForgotMail' : 'authForgotName')).focus();
    }
}

// ===== 忘記密碼 =====
function submitForgot() {
    const name = $('authForgotName').value.trim();
    const mail = $('authForgotMail').value.trim();
    setFormError($('authForgotError'), '');
    setFormError($('authForgotResult'), '');
    setAuthHint('authForgotNameHint', '');
    setAuthHint('authForgotMailHint', '');
    if (!AUTH_RULES.name.test(name)) return setAuthHint('authForgotNameHint', '角色 ID 為 3~10 個英文字母', 'error');
    if (!AUTH_RULES.mail.test(mail)) return setAuthHint('authForgotMailHint', '請輸入正確的信箱', 'error');
    if (!sendAuthOrFail({ action: 'forgotPassword', name, mail }, $('authForgotError'))) return;
    auth.pending = { form: 'forgot' };
    setAuthBusy(true);
    $('authForgotSubmit').textContent = '寄送中…';
}

function onAuthForgotResult(data) {
    auth.pending = null;
    setAuthBusy(false);
    $('authForgotSubmit').textContent = '寄送臨時密碼';
    if (data.ok) {
        setFormError($('authForgotResult'), data.message);
        // 寄出後回登入畫面時帶入帳號,方便直接輸入臨時密碼
        $('authLoginName').value = $('authForgotName').value.trim();
        $('authLoginPassword').value = '';
    } else {
        setFormError($('authForgotError'), data.message || '處理失敗，請稍後再試');
    }
}

function currentAuthLoginFocus() {
    return $('authLoginName').value ? 'authLoginPassword' : 'authLoginName';
}

function closeAuthPanel() {
    authPanel.hidden = true;
    auth.pending = null;
    setAuthBusy(false);
}

function sendAuthOrFail(payload, errorElement) {
    if (sendAuth(payload)) return true;
    setFormError(errorElement, '尚未連線,請稍候重新連線或重新整理頁面。');
    return false;
}

// ===== 登入 =====
function submitLogin({ auto = false } = {}) {
    const name = $('authLoginName').value.trim();
    const password = $('authLoginPassword').value;
    setFormError($('authLoginError'), '');
    setAuthHint('authLoginNameHint', '');
    setAuthHint('authLoginPasswordHint', '');
    if (!name) return setAuthHint('authLoginNameHint', '請輸入帳號', 'error');
    if (!password) return setAuthHint('authLoginPasswordHint', '請輸入密碼', 'error');
    const remember = $('authRemember').checked;
    if (!sendAuthOrFail({ action: 'login', name, password }, $('authLoginError'))) return;
    auth.pending = { form: 'login', name, password, remember, auto };
    setAuthBusy(true);
    $('authLoginSubmit').textContent = auto ? '自動登入中…' : '登入中…';
}

// 有記住的帳密時自動登入 (每次連線最多一次;失敗後本頁不再自動嘗試)
async function tryAutoLogin() {
    await settingsReady;
    if (auth.autoLoginFailed || authPanel.hidden) return;
    if (!currentSettings.account || !currentSettings.password) return;
    $('authLoginName').value = currentSettings.account;
    $('authLoginPassword').value = currentSettings.password;
    $('authRemember').checked = true;
    submitLogin({ auto: true });
}

// ===== 創角:步驟 =====
function showAuthStep(step) {
    auth.step = Math.min(Math.max(step, 1), AUTH_STEP_COUNT);
    authCreateForm.querySelectorAll('.auth-step').forEach(fieldset => {
        fieldset.hidden = Number(fieldset.dataset.step) !== auth.step;
    });
    authCreateForm.querySelectorAll('.auth-steps li').forEach(li => {
        const n = Number(li.dataset.step);
        li.classList.toggle('is-current', n === auth.step);
        li.classList.toggle('is-done', n < auth.step);
        if (n === auth.step) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
    });
    $('authPrev').hidden = auth.step === 1;
    $('authNext').textContent = auth.step === AUTH_STEP_COUNT ? '建立角色' : '下一步';
    setFormError($('authCreateError'), '');
    if (auth.step === AUTH_STEP_COUNT) renderAuthSummary();
    // 只聚焦文字欄位;職業 / 性別 / 屬性步驟不預先聚焦,避免焦點框看起來像已選了第一項
    authCreateForm.querySelector(`.auth-step[data-step="${auth.step}"]`)
        ?.querySelector('input[type="text"], input[type="password"], input[type="email"]')
        ?.focus();
}

// 檢查目前步驟;不通過時標出欄位並回傳 false
function validateAuthStep(step) {
    if (step === 1) {
        const name = $('authName').value.trim();
        const password = $('authPassword').value;
        let ok = true;
        if (!AUTH_RULES.name.test(name)) {
            setFieldError('name', `帳號格式不符:${auth.config.rules.name}`);
            ok = false;
        } else if (auth.nameStatus?.name.toLowerCase() === name.toLowerCase() && !auth.nameStatus.available) {
            setFieldError('name', auth.nameStatus.message);
            ok = false;
        } else if ($('authName').getAttribute('aria-invalid') === 'true') {
            setFieldError('name', null);
        }
        if (!AUTH_RULES.password.test(password)) {
            setFieldError('password', `密碼格式不符:${auth.config.rules.password}`);
            ok = false;
        } else {
            setFieldError('password', null);
        }
        if (password !== $('authPassword2').value) {
            setFieldError('password2', '兩次輸入的密碼不一樣');
            ok = false;
        } else {
            setFieldError('password2', null);
        }
        return ok;
    }
    if (step === 2) {
        let ok = true;
        if (!AUTH_RULES.cnName.test($('authCnName').value.trim())) {
            setFieldError('cnName', `中文名字格式不符:${auth.config.rules.cnName}`);
            ok = false;
        } else {
            setFieldError('cnName', null);
        }
        if (getCheckedValue('authGender') === null) {
            setFieldError('gender', '請選擇性別');
            ok = false;
        } else {
            setFieldError('gender', null);
        }
        return ok;
    }
    if (step === 3) {
        const ok = getCheckedValue('authClass') !== null;
        setFieldError('classId', ok ? null : '請選擇職業');
        return ok;
    }
    if (step === 4) {
        const remaining = authAttrRemaining();
        setFieldError('attrs', remaining === 0 ? null : `還有 ${remaining} 點沒有分配`);
        return remaining === 0;
    }
    if (step === 5) {
        const ok = AUTH_RULES.mail.test($('authMail').value.trim());
        setFieldError('mail', ok ? null : '信箱格式不符');
        return ok;
    }
    return true;
}

function getCheckedValue(name) {
    const checked = authPanel.querySelector(`input[name="${name}"]:checked`);
    return checked ? Number(checked.value) : null;
}

function onAuthCreateSubmit(event) {
    event.preventDefault();
    if (auth.pending || !validateAuthStep(auth.step)) return;
    if (auth.step < AUTH_STEP_COUNT) {
        showAuthStep(auth.step + 1);
        return;
    }
    const payload = {
        action: 'create',
        name: $('authName').value.trim(),
        password: $('authPassword').value,
        cnName: $('authCnName').value.trim(),
        gender: getCheckedValue('authGender'),
        classId: getCheckedValue('authClass'),
        attrs: { ...auth.attrs },
        mail: $('authMail').value.trim()
    };
    if (!sendAuthOrFail(payload, $('authCreateError'))) return;
    auth.pending = { form: 'create', name: payload.name, password: payload.password, remember: $('authCreateRemember').checked };
    setAuthBusy(true);
    $('authNext').textContent = '建立中…';
}

// ===== 創角:帳號即時檢查 =====
function onAuthNameInput() {
    clearTimeout(auth.nameTimer);
    auth.nameStatus = null;
    const name = $('authName').value.trim();
    if (!name) return setFieldError('name', null);
    if (!AUTH_RULES.name.test(name)) {
        setAuthHint('authNameHint', `格式:${auth.config.rules.name}`, null);
        return;
    }
    setAuthHint('authNameHint', '檢查中…', null);
    auth.nameTimer = setTimeout(() => sendAuth({ action: 'checkName', name }), AUTH_NAME_CHECK_DELAY_MS);
}

function onAuthNameStatus(data) {
    if (String(data.name).toLowerCase() !== $('authName').value.trim().toLowerCase()) return;
    auth.nameStatus = { name: String(data.name), available: data.valid && data.available, message: data.message };
    setAuthHint('authNameHint', data.message, auth.nameStatus.available ? 'ok' : 'error');
}

// ===== 創角:選項 =====
function renderAuthChoices() {
    const genders = $('authGenders');
    genders.textContent = '';
    for (const gender of auth.config.genders) {
        const label = document.createElement('label');
        label.className = 'auth-choice';
        label.innerHTML = '<input type="radio" name="authGender"><span></span>';
        label.querySelector('input').value = gender.id;
        label.querySelector('span').textContent = gender.label;
        genders.appendChild(label);
    }
    const classes = $('authClasses');
    classes.textContent = '';
    for (const cls of auth.config.classes) {
        const label = document.createElement('label');
        label.className = 'auth-class';
        label.innerHTML = '<input type="radio" name="authClass"><strong></strong><span></span>';
        label.querySelector('input').value = cls.id;
        label.querySelector('strong').textContent = cls.cnName;
        label.querySelector('span').textContent = cls.description;
        classes.appendChild(label);
    }
}

// ===== 創角:屬性分配 (與英雄屬性畫面 hero.js 相同的列) =====
function authAttrRemaining() {
    if (!auth.config) return 0;
    return auth.config.points - Object.values(auth.attrs).reduce((sum, v) => sum + v, 0);
}

function renderAuthAttrs() {
    const list = $('authAttrList');
    list.textContent = '';
    auth.attrs = {};
    for (const attr of auth.config.attributes) {
        auth.attrs[attr.key] = 0;
        const row = document.createElement('li');
        row.className = 'auth-attr-row';
        row.dataset.key = attr.key;
        row.innerHTML = `
            <span class="auth-attr-name"><span class="auth-attr-label"></span><span class="auth-attr-key"></span></span>
            <strong class="auth-attr-value"></strong>
            <button class="auth-attr-btn" type="button" data-step="-1">−</button>
            <output class="auth-attr-add"></output>
            <button class="auth-attr-btn is-plus" type="button" data-step="1">+</button>`;
        row.querySelector('.auth-attr-label').textContent = attr.label;
        row.querySelector('.auth-attr-key').textContent = attr.key.toUpperCase();
        row.querySelector('[data-step="-1"]').setAttribute('aria-label', `${attr.label} 減少 1 點`);
        row.querySelector('[data-step="1"]').setAttribute('aria-label', `${attr.label} 增加 1 點`);
        list.appendChild(row);
    }
    updateAuthAttrs();
}

function updateAuthAttrs() {
    if (!auth.config) return;
    const remaining = authAttrRemaining();
    $('authAttrRemain').textContent = remaining;
    $('authAttrTotal').textContent = auth.config.points;
    authPanel.classList.toggle('is-attr-complete', remaining === 0);
    const busy = Boolean(auth.pending);
    for (const [key, add] of Object.entries(auth.attrs)) {
        const row = $('authAttrList').querySelector(`[data-key="${key}"]`);
        if (!row) continue;
        row.classList.toggle('has-add', add > 0);
        row.querySelector('.auth-attr-value').textContent = auth.config.base + add;
        row.querySelector('.auth-attr-add').textContent = `+${add}`;
        row.querySelector('[data-step="-1"]').disabled = busy || add <= 0;
        row.querySelector('[data-step="1"]').disabled = busy || remaining <= 0 || add >= auth.config.maxPerAttr;
    }
}

function renderAuthSummary() {
    const cfg = auth.config;
    const gender = cfg.genders.find(g => g.id === getCheckedValue('authGender'));
    const cls = cfg.classes.find(c => c.id === getCheckedValue('authClass'));
    const attrs = cfg.attributes.map(a => `${a.label} ${cfg.base + auth.attrs[a.key]}`).join('、');
    const rows = [
        ['帳號', $('authName').value.trim()],
        ['中文名字', $('authCnName').value.trim()],
        ['性別', gender?.label || ''],
        ['職業', cls?.cnName || ''],
        ['屬性', attrs]
    ];
    const summary = $('authSummary');
    summary.textContent = '';
    for (const [term, value] of rows) {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = term;
        dd.textContent = value;
        summary.append(dt, dd);
    }
}

function resetAuthCreateForm() {
    authCreateForm.reset();
    auth.nameStatus = null;
    Object.keys(AUTH_FIELD_HINTS).forEach(field => setFieldError(field, null));
    renderAuthAttrs();
}

// ===== 伺服器訊息 =====
function openAuthPanel(data) {
    auth.config = {
        classes: Array.isArray(data.classes) ? data.classes : [],
        genders: Array.isArray(data.genders) ? data.genders : [],
        attributes: Array.isArray(data.attributes) ? data.attributes : [],
        points: Number(data.points) || 0,
        base: Number(data.base) || 0,
        maxPerAttr: Number(data.maxPerAttr) || 0,
        rules: data.rules || {}
    };
    auth.defaultHints = {
        authNameHint: `格式:${auth.config.rules.name || ''}`,
        authPasswordHint: `格式:${auth.config.rules.password || ''}`,
        authCnNameHint: `格式:${auth.config.rules.cnName || ''}`,
        authMailHint: auth.config.rules.mail || '',
        authAttrHint: $('authAttrHint').dataset.default || $('authAttrHint').textContent
    };
    $('authAttrHint').dataset.default = auth.defaultHints.authAttrHint;
    renderAuthChoices();
    resetAuthCreateForm();
    auth.pending = null;
    setAuthBusy(false);
    $('authLoginSubmit').textContent = '登入';
    authPanel.hidden = false;
    showAuthView('login');
    tryAutoLogin();
}

function onAuthError(data) {
    const pending = auth.pending;
    auth.pending = null;
    setAuthBusy(false);
    $('authLoginSubmit').textContent = '登入';
    if (data.form === 'create') {
        $('authNext').textContent = auth.step === AUTH_STEP_COUNT ? '建立角色' : '下一步';
        const step = AUTH_FIELD_STEPS[data.field];
        if (step) {
            showAuthStep(step);
            setFieldError(data.field, data.message);
            $(AUTH_FIELD_INPUTS[data.field])?.focus();
        } else {
            setFormError($('authCreateError'), data.message || '建立角色失敗');
        }
        return;
    }
    if (pending?.auto) {
        auth.autoLoginFailed = true;
        $('authLoginPassword').value = '';
    }
    if (data.field === 'name' || data.field === 'password') {
        const hintId = data.field === 'name' ? 'authLoginNameHint' : 'authLoginPasswordHint';
        setAuthHint(hintId, data.message, 'error');
        $(data.field === 'name' ? 'authLoginName' : 'authLoginPassword').select();
    } else {
        setFormError($('authLoginError'), data.message || '登入失敗');
    }
}

function onAuthSuccess() {
    const pending = auth.pending;
    if (pending?.remember) saveCredentials(pending.name.toLowerCase(), pending.password);
    else if (pending) clearCredentials();
    $('authLoginPassword').value = '';
    resetAuthCreateForm();
    closeAuthPanel();
    inputBox.focus();
}

function updateAuth(data) {
    if (data.action === 'show') openAuthPanel(data);
    else if (data.action === 'nameStatus') onAuthNameStatus(data);
    else if (data.action === 'error') onAuthError(data);
    else if (data.action === 'success') onAuthSuccess();
    else if (data.action === 'forgotResult') onAuthForgotResult(data);
}

// ===== 事件 =====
authLoginForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!auth.pending) submitLogin();
});
authCreateForm.addEventListener('submit', onAuthCreateSubmit);
$('authToCreate').addEventListener('click', () => showAuthView('create'));
$('authToLogin').addEventListener('click', () => showAuthView('login'));
$('authToForgot').addEventListener('click', () => showAuthView('forgot'));
$('authForgotBack').addEventListener('click', () => showAuthView('login'));
authForgotForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!auth.pending) submitForgot();
});
$('authPrev').addEventListener('click', () => showAuthStep(auth.step - 1));
$('authName').addEventListener('input', onAuthNameInput);
authPanel.querySelectorAll('[data-auth-text]').forEach(button => {
    button.addEventListener('click', () => {
        closeAuthPanel();
        inputBox.focus();
    });
});
$('authAttrList').addEventListener('click', event => {
    const button = event.target.closest('.auth-attr-btn');
    if (!button || button.disabled) return;
    const key = button.closest('.auth-attr-row').dataset.key;
    const step = Number(button.dataset.step);
    if (step > 0 && (authAttrRemaining() <= 0 || auth.attrs[key] >= auth.config.maxPerAttr)) return;
    auth.attrs[key] = Math.max(0, auth.attrs[key] + step);
    setFieldError('attrs', null);
    updateAuthAttrs();
});
