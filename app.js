const DAILY_TOKEN_KEY = 'pinplay_daily_token';
const BACK_NAV_FLAG_KEY = 'pinplay_is_back_nav';
const POST_LOGIN_REDIRECT_KEY = 'pinplay_post_login_redirect';
const NAV_ORIGIN_KEY = 'pinplay_nav_origin';
const CACHE_KEY_STATE = 'pinplay_state_cache_v10';
const CACHE_TTL_MS = 15 * 1000;
const LIVE_SYNC_INTERVAL_MS = 15 * 1000;
const ROOT_ACCOUNT_EMAIL = 'technik@pinandplay.de';

// Check-In-Token sofort aus sauberer URL (/checkin/TOKEN) oder Alt-URL (?token=...) übernehmen
(function extractDailyToken() {
    const pathMatch = window.location.pathname.match(/^\/checkin\/([^/]+)\/?$/i);
    if (pathMatch && pathMatch[1]) {
        localStorage.setItem(DAILY_TOKEN_KEY, decodeURIComponent(pathMatch[1]).trim().toUpperCase());
        window.history.replaceState({}, '', '/');
        return;
    }
    const params = new URLSearchParams(window.location.search);
    const legacyToken = params.get('token');
    if (legacyToken && legacyToken.trim()) {
        localStorage.setItem(DAILY_TOKEN_KEY, legacyToken.trim().toUpperCase());
        window.history.replaceState({}, '', window.location.pathname);
    }
})();

// Supabase Client
const supabaseUrl = 'https://gwvxctkowtiyfrhoozhj.supabase.co';
const supabaseKey = 'sb_publishable__H6Yjq1-Tift6S7NHxSGcw_ihus2Zbw';
const currentDailyToken = localStorage.getItem(DAILY_TOKEN_KEY) || '';
const db = window.supabase.createClient(supabaseUrl, supabaseKey, {
    global: { headers: { 'x-pinplay-token': currentDailyToken } }
});

// Globale Datenspeicher
let pinballs = [];
let reportsDB = [];
let highscoresDB = [];
let feedbackDB = [];
let playerTagsDB = [];
let partsOrdersDB = [];
let partsCatalogDB = [];
let partsTagsDB = [];
let accountsDB = [];
let currentUserAccount = null;
let isLoggedIn = false;
let hasValidDailyToken = false;
let currentPageUpdateCallback = null;
let liveSyncTimer = null;
let isRestoringScroll = true;

// --- HILFSFUNKTIONEN FÜR FORMATIERUNG & ROUTING ---

function escHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escJsArg(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getPathSegments() {
    return window.location.pathname
        .replace(/\.html$/i, '')
        .split('/')
        .filter(Boolean);
}

function setNavOrigin(url) {
    try { sessionStorage.setItem(NAV_ORIGIN_KEY, url); } catch (e) {}
}

function getNavOrigin(fallback = '/') {
    try { return sessionStorage.getItem(NAV_ORIGIN_KEY) || fallback; } catch (e) { return fallback; }
}

function formatScore(num) {
    return Number(num || 0).toLocaleString('de-DE');
}

function formatEuro(val) {
    if (val === null || val === undefined || val === '' || isNaN(Number(val))) return '';
    return Number(val).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

function formatDateTime(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('de-DE') + ' um ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}

function getFlipperImageUrl(rawValue) {
    if (!rawValue || rawValue.trim() === '') return null;
    const trimmed = rawValue.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    const { data } = db.storage.from('flipper-fotos').getPublicUrl(trimmed);
    return data ? data.publicUrl : null;
}

function normalizeReportStatus(raw) {
    const l = String(raw || '').trim().toLowerCase();
    return (l === 'behoben' || l === 'erledigt' || l === 'geschlossen') ? 'behoben' : 'offen';
}

function getStatusColorClass(status) {
    if (status.includes('Defekt')) return 'status-rot';
    if (status.includes('Wartung') || status.includes('Eingeschränkt')) return 'status-orange';
    return 'status-grün';
}

function stylePowerButton(btn, state) {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('btn-busy');
    btn.style.display = 'inline-block';
    btn.innerText = state;
    btn.style.backgroundColor = state === 'ON' ? '#16261b' : '#3b1818';
    btn.style.color = state === 'ON' ? '#3fb950' : '#ff7b72';
    btn.style.borderColor = state === 'ON' ? '#2ea043' : '#cf3432';
}

// --- RECHTESYSTEM (EXAKT SYNCHRON MIT SUPABASE RLS) ---

function isRootAccount(acc = currentUserAccount) {
    return !!(acc && String(acc.email || '').trim().toLowerCase() === ROOT_ACCOUNT_EMAIL);
}

function hasPerm(permKey) {
    if (!isLoggedIn || !currentUserAccount) return false;
    if (isRootAccount(currentUserAccount) || currentUserAccount.perm_manage_accounts === true) return true;

    switch (permKey) {
        case 'admin':
        case 'manage_accounts':
            return false;
        case 'no_qr':
            return currentUserAccount.perm_no_qr === true;
        case 'power_off':
            return currentUserAccount.perm_power_off === true;
        case 'auto_verify_reports':
            return currentUserAccount.perm_auto_verify_reports === true;
        case 'view_reports':
            return currentUserAccount.perm_view_reports === true || currentUserAccount.perm_manage_reports === true;
        case 'manage_reports':
            return currentUserAccount.perm_manage_reports === true;
        case 'auto_verify_highscores':
            return currentUserAccount.perm_auto_verify_highscores === true;
        case 'verify_highscores':
            return currentUserAccount.perm_verify_highscores === true;
        case 'request_parts':
            return currentUserAccount.perm_request_parts === true || currentUserAccount.perm_manage_parts === true;
        case 'manage_parts':
            return currentUserAccount.perm_manage_parts === true;
        case 'view_feedback':
            return currentUserAccount.perm_view_feedback === true;
        case 'manage_qr':
        case 'manage_players_qr':
            return currentUserAccount.perm_manage_players_qr === true;
        case 'view_logs':
            return !!(
                currentUserAccount.perm_power_off ||
                currentUserAccount.perm_view_reports ||
                currentUserAccount.perm_manage_reports ||
                currentUserAccount.perm_verify_highscores ||
                currentUserAccount.perm_request_parts ||
                currentUserAccount.perm_manage_parts ||
                currentUserAccount.perm_view_feedback
            );
        default:
            return false;
    }
}

function hasAnyTechCenterAccess() {
    return hasPerm('power_off') || hasPerm('view_reports') || hasPerm('verify_highscores') || hasPerm('view_feedback') || hasPerm('view_logs');
}

function hasPinballTechViewAccess() {
    return hasPerm('view_reports') || hasPerm('verify_highscores');
}

function getDefaultTechUrl() {
    if (hasPerm('power_off') || hasPerm('view_reports') || hasPerm('verify_highscores')) return '/technik';
    if (hasPerm('view_feedback')) return '/technik/feedback';
    return '/technik/logs';
}

function ensureWritePermission() {
    if (hasPerm('no_qr') || hasValidDailyToken) return true;
    showActionToast('Zugangssperre: Bitte scanne zuerst den aktuellen Tages-QR-Code vor Ort im Pin&Play!', 'error', 4500);
    return false;
}

// --- ACCOUNT-INITIALEN (ERSETZEN SPIELERPROFILE & PINS) ---

function resolveAccountTag(rawInput, pinballId = null) {
    const norm = String(rawInput || '').trim().toUpperCase();
    if (!norm) return null;
    const pinKey = pinballId !== null && pinballId !== undefined ? String(pinballId) : null;

    return playerTagsDB.find((t) => {
        if (t.shortTag && t.shortTag === norm) return true;
        if (pinKey && t.flipperTags && String(t.flipperTags[pinKey] || '').toUpperCase() === norm) return true;
        if (!pinKey && t.flipperTags && Object.values(t.flipperTags).some((v) => String(v).toUpperCase() === norm)) return true;
        return false;
    }) || null;
}

function getAccountInitialsForPinball(acc, pin) {
    if (!acc || !pin) return '';
    const maxLen = pin.hsMaxLength === 0 ? 3 : pin.hsMaxLength;
    const shortTag = String(acc.short_tag || acc.shortTag || '').trim().toUpperCase();
    const fTags = acc.flipper_tags || acc.flipperTags || {};

    if (maxLen > 3) {
        const custom = String(fTags[String(pin.id)] || '').trim().toUpperCase();
        if (custom) return custom.substring(0, maxLen);
    }
    return shortTag.substring(0, Math.min(3, maxLen));
}

function isSamePlayerIdentity(nameA, nameB, pinballId = null) {
    const a = String(nameA || '').trim().toUpperCase();
    const b = String(nameB || '').trim().toUpperCase();
    if (!a || !b) return false;
    if (a === b) return true;
    const accA = resolveAccountTag(a, pinballId);
    const accB = resolveAccountTag(b, pinballId);
    return !!(accA && accB && accA.userId === accB.userId);
}

function getFormattedPlayerDisplay(rawInitials, pinballId = null) {
    const upper = String(rawInitials || '').trim().toUpperCase();
    const acc = resolveAccountTag(upper, pinballId);
    if (!acc || !acc.displayName) return upper;
    if (upper === acc.displayName.toUpperCase()) return acc.displayName;
    return `${upper} (${acc.displayName})`;
}

function isInitialsReservedByOther(rawInitials, pinballId) {
    const acc = resolveAccountTag(rawInitials, pinballId);
    if (!acc) return null;
    if (isLoggedIn && currentUserAccount && acc.userId === currentUserAccount.user_id) return null;
    return acc;
}

// --- SCROLL-POSITION & TOASTS ---

function getScrollKey() {
    return 'pinplay_scroll_' + (window.location.pathname || '/');
}

function saveCurrentScrollPos() {
    try { sessionStorage.setItem(getScrollKey(), String(window.scrollY || 0)); } catch (e) {}
}

window.addEventListener('scroll', () => {
    if (!isRestoringScroll) saveCurrentScrollPos();
}, { passive: true });

function navigateBackTo(targetUrl) {
    sessionStorage.setItem(BACK_NAV_FLAG_KEY, 'true');
    window.location.href = targetUrl;
}

function restoreScrollPositionIfNeeded() {
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation');
    const isBrowserBack = nav && nav.length > 0 && nav[0].type === 'back_forward';
    const isCustomBack = sessionStorage.getItem(BACK_NAV_FLAG_KEY) === 'true';

    if (isCustomBack || isBrowserBack) {
        sessionStorage.removeItem(BACK_NAV_FLAG_KEY);
        const y = parseInt(sessionStorage.getItem(getScrollKey()) || '0', 10);
        if (y > 0) {
            isRestoringScroll = true;
            requestAnimationFrame(() => {
                window.scrollTo({ top: y, behavior: 'instant' });
                setTimeout(() => { window.scrollTo({ top: y, behavior: 'instant' }); isRestoringScroll = false; }, 70);
            });
            return;
        }
    }
    setTimeout(() => { isRestoringScroll = false; }, 70);
}

function showActionToast(message, type = 'success', durationMs = 3500) {
    let box = document.getElementById('pinplay-toast-container');
    if (!box) {
        box = document.createElement('div');
        box.id = 'pinplay-toast-container';
        document.body.appendChild(box);
    }
    const toast = document.createElement('div');
    toast.className = `pinplay-toast ${type === 'error' ? 'toast-error' : (type === 'info' ? 'toast-info' : '')}`;
    toast.innerText = message;
    box.appendChild(toast);
    setTimeout(() => {
        toast.style.transition = 'opacity 0.25s ease';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 260);
    }, durationMs);
}

// --- HEADER & GEMEINSAME TECHNIK-NAVIGATION ---

function getActiveTopSection() {
    const seg = getPathSegments()[0] || '';
    if (seg === 'highscores') return 'highscores';
    if (seg === 'technik') return 'technik';
    if (seg === 'ersatzteile') return 'ersatzteile';
    if (seg === 'qr' || seg === 'accounts') return 'verwaltung';
    if (seg === 'konto') return 'konto';
    return 'overview';
}

function closeAllHeaderDropdowns() {
    document.querySelectorAll('.nav-dropdown-menu').forEach((m) => m.classList.add('hidden'));
}

function toggleHeaderDropdown(menuId, event) {
    if (event) event.stopPropagation();
    const target = document.getElementById(menuId);
    if (!target) return;
    const wasHidden = target.classList.contains('hidden');
    closeAllHeaderDropdowns();
    if (wasHidden) target.classList.remove('hidden');
}

document.addEventListener('click', () => closeAllHeaderDropdowns());

function renderSharedHeader() {
    const header = document.getElementById('main-header');
    if (!header) return;

    const isStaff = isLoggedIn && (hasAnyTechCenterAccess() || hasPerm('request_parts') || hasPerm('manage_qr') || hasPerm('manage_accounts'));
    header.classList.toggle('staff-header', isStaff);

    const active = getActiveTopSection();
    const cls = (key) => (active === key ? 'btn-nav-page btn-nav-active' : 'btn-nav-page');

    let navHtml = '';
    if (isLoggedIn) {
        if (hasAnyTechCenterAccess()) {
            const unverifReps = hasPerm('view_reports') ? reportsDB.filter((r) => r.status === 'offen' && !r.verifiziert).length : 0;
            const unverifHs = hasPerm('verify_highscores') ? highscoresDB.filter((h) => !h.verifiziert).length : 0;
            const badge = (unverifReps + unverifHs) > 0 ? `<span class="badge-nav-count">${unverifReps + unverifHs}</span>` : '';
            navHtml += `<button class="${cls('technik')}" onclick="window.location.href='${getDefaultTechUrl()}'">Technik${badge}</button>`;
        }

        if (hasPerm('request_parts') || hasPerm('manage_parts') || hasPerm('view_reports')) {
            const openParts = partsOrdersDB.filter((p) => p.status === 'benoetigt').length;
            const badge = openParts > 0 ? `<span class="badge-nav-count count-gold">${openParts}</span>` : '';
            navHtml += `<button class="${cls('ersatzteile')}" onclick="window.location.href='/ersatzteile'">Ersatzteile${badge}</button>`;
        }

        const manageItems = [];
        const seg = getPathSegments()[0] || '';
        if (hasPerm('manage_qr')) {
            manageItems.push(`<button class="nav-dropdown-item ${seg === 'qr' ? 'item-active' : ''}" onclick="window.location.href='/qr'"><span>Tages-QR</span></button>`);
            manageItems.push(`<button class="nav-dropdown-item" onclick="window.open('/tv', '_blank')"><span>TV-Display</span><span>↗</span></button>`);
        }
        if (hasPerm('manage_accounts')) {
            manageItems.push(`<button class="nav-dropdown-item ${seg === 'accounts' ? 'item-active' : ''}" onclick="window.location.href='/accounts'"><span>Accounts</span></button>`);
        }
        if (manageItems.length > 0) {
            navHtml += `
                <div class="nav-dropdown">
                    <button class="${cls('verwaltung')}" onclick="toggleHeaderDropdown('header-manage-menu', event)">Verwaltung ▾</button>
                    <div id="header-manage-menu" class="nav-dropdown-menu hidden" onclick="event.stopPropagation()">
                        ${manageItems.join('')}
                    </div>
                </div>
            `;
        }

        const name = escHtml((currentUserAccount && currentUserAccount.display_name) || 'Account');
        const role = escHtml((currentUserAccount && currentUserAccount.role_label) || 'Eingeloggt');
        navHtml += `
            <div class="nav-dropdown">
                <button class="btn-nav-util" onclick="toggleHeaderDropdown('header-account-menu', event)">${name} ▾</button>
                <div id="header-account-menu" class="nav-dropdown-menu hidden" onclick="event.stopPropagation()">
                    <div class="nav-dropdown-header">
                        <strong>${name}</strong>
                        <span>${role}</span>
                    </div>
                    <button class="nav-dropdown-item ${active === 'konto' ? 'item-active' : ''}" onclick="window.location.href='/konto'"><span>Initialen</span></button>
                    <button class="nav-dropdown-item item-danger" onclick="doLogout()"><span>Logout</span></button>
                </div>
            </div>
        `;
    }

    header.innerHTML = `
        <a href="/" class="logo" title="Pin&Play Übersicht">
            <img src="/logo.png" alt="Pin & Play Retro Gaming" class="logo-img">
        </a>
        <div class="quick-actions">
            <button class="${cls('overview')}" onclick="window.location.href='/'">Übersicht</button>
            <button class="${cls('highscores')}" onclick="window.location.href='/highscores'">Highscores</button>
            ${navHtml}
        </div>
    `;
}

// Gemeinsame Tab-Leiste für das aufgeteilte Technik-Center (ohne ? in der URL)
function renderTechSubnav(containerId, activeKey) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const canRep = hasPerm('view_reports');
    const canHs = hasPerm('verify_highscores');
    const canDash = hasPerm('power_off') || canRep || canHs;
    const canFb = hasPerm('view_feedback');
    const canLogs = hasPerm('view_logs');

    const unverif = (canRep ? reportsDB.filter((r) => r.status === 'offen' && !r.verifiziert).length : 0)
        + (canHs ? highscoresDB.filter((h) => !h.verifiziert).length : 0);
    const openCnt = canRep ? reportsDB.filter((r) => r.status === 'offen').length : 0;
    const resCnt = canRep ? reportsDB.filter((r) => r.status === 'behoben').length : 0;
    const hsCnt = canHs ? highscoresDB.length : 0;
    const fbCnt = canFb ? feedbackDB.length : 0;

    const tabs = [];
    if (canDash) tabs.push({ key: 'dashboard', href: '/technik', label: 'Flipper', cls: 'active-open' });
    if (canRep || canHs) tabs.push({ key: 'eingang', href: '/technik/eingang', label: `Eingang (${unverif})`, cls: 'active-highscore' });
    if (canRep) tabs.push({ key: 'defekte', href: '/technik/defekte', label: `Defekte (${openCnt})`, cls: 'active-open' });
    if (canRep) tabs.push({ key: 'archiv', href: '/technik/archiv', label: `Archiv (${resCnt})`, cls: 'active-resolved' });
    if (canHs) tabs.push({ key: 'highscores', href: '/technik/highscores', label: `Highscores (${hsCnt})`, cls: 'active-highscore' });
    if (canFb) tabs.push({ key: 'feedback', href: '/technik/feedback', label: `Feedback (${fbCnt})`, cls: 'active-open' });
    if (canLogs) tabs.push({ key: 'logs', href: '/technik/logs', label: 'Logs', cls: 'active-open' });

    el.innerHTML = tabs.map((t) =>
        `<a href="${t.href}" class="report-tab-btn ${activeKey === t.key ? t.cls : ''}">${t.label}</a>`
    ).join('');
}

// --- LOGIN / LOGOUT (KEIN NEBENKLICK-SCHLIESSEN) ---

function ensureLoginModalExists() {
    if (document.getElementById('global-login-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'global-login-modal';
    modal.className = 'modal-overlay hidden';
    modal.innerHTML = `
        <div class="modal-box" style="max-width: 400px;">
            <div class="detail-header">
                <h2 style="margin: 0;">Account Login</h2>
                <button class="btn-switch" onclick="closeLoginModal()">Schließen</button>
            </div>
            <div class="report-form">
                <label><strong>Benutzerkennung (E-Mail)</strong></label>
                <input type="email" id="login-email" placeholder="name@pinplay.lokal">
                <label><strong>Passwort</strong></label>
                <input type="password" id="login-pwd" onkeydown="if(event.key==='Enter') doLogin()">
                <button class="btn-green" style="width: 100%; padding: 14px;" onclick="doLogin()">Einloggen</button>
                <p id="login-error" style="color: #ff7b72; display: none; margin-top: 14px; font-weight: bold;"></p>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

function checkLoginRoute() {
    ensureLoginModalExists();
    const modal = document.getElementById('global-login-modal');
    const isLoginPath = window.location.pathname.replace(/\/$/, '') === '/login' || window.location.hash === '#login';
    if (!isLoginPath) return;

    if (isLoggedIn) {
        const saved = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
        if (saved) {
            sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
            window.location.href = saved;
            return;
        }
        window.history.replaceState({}, '', '/');
        if (hasAnyTechCenterAccess()) window.location.href = getDefaultTechUrl();
    } else {
        modal.classList.remove('hidden');
    }
}

function closeLoginModal() {
    const modal = document.getElementById('global-login-modal');
    if (modal) modal.classList.add('hidden');
    if (window.location.pathname.replace(/\/$/, '') === '/login' || window.location.hash === '#login') {
        window.history.replaceState({}, '', '/');
    }
}

function redirectToLoginWithReturn() {
    try { sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, window.location.pathname); } catch (e) {}
    window.location.href = '/login';
}

async function doLogin() {
    const email = document.getElementById('login-email').value.trim();
    const pwd = document.getElementById('login-pwd').value;
    const errEl = document.getElementById('login-error');

    const { data, error } = await db.auth.signInWithPassword({ email, password: pwd });
    if (error) {
        errEl.innerText = 'Login fehlgeschlagen: ' + error.message;
        errEl.style.display = 'block';
        return;
    }

    errEl.style.display = 'none';
    isLoggedIn = true;
    localStorage.setItem('pinplay_logged_in', 'true');
    localStorage.removeItem(CACHE_KEY_STATE);
    await loadCurrentUserAccount(data?.user?.id);

    const saved = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
    if (saved) {
        sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
        window.location.href = saved;
        return;
    }
    window.location.href = hasAnyTechCenterAccess() ? getDefaultTechUrl() : '/';
}

async function doLogout() {
    if (!confirm('Möchtest du dich wirklich ausloggen?')) return;
    await db.auth.signOut();
    localStorage.removeItem('pinplay_logged_in');
    localStorage.removeItem(CACHE_KEY_STATE);
    window.location.href = '/';
}

window.addEventListener('hashchange', checkLoginRoute);

// --- CACHE, DATENBANK-SYNC & MEDIEN ---

function saveStateToCache() {
    try {
        localStorage.setItem(CACHE_KEY_STATE, JSON.stringify({
            pinballs, reportsDB, highscoresDB, feedbackDB, playerTagsDB,
            partsOrdersDB, partsCatalogDB, partsTagsDB, accountsDB,
            currentUserAccount, hasValidDailyToken, timestamp: Date.now()
        }));
    } catch (e) {}
}

function restoreStateFromCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY_STATE);
        if (!raw) return { loaded: false, isFresh: false };
        const p = JSON.parse(raw);
        if (!Array.isArray(p.pinballs) || p.pinballs.length === 0) return { loaded: false, isFresh: false };
        pinballs = p.pinballs;
        reportsDB = p.reportsDB || [];
        highscoresDB = p.highscoresDB || [];
        feedbackDB = p.feedbackDB || [];
        playerTagsDB = p.playerTagsDB || [];
        partsOrdersDB = p.partsOrdersDB || [];
        partsCatalogDB = p.partsCatalogDB || [];
        partsTagsDB = p.partsTagsDB || [];
        accountsDB = p.accountsDB || [];
        currentUserAccount = p.currentUserAccount || null;
        hasValidDailyToken = p.hasValidDailyToken === true;
        return { loaded: true, isFresh: (Date.now() - (p.timestamp || 0)) < CACHE_TTL_MS };
    } catch (e) {
        return { loaded: false, isFresh: false };
    }
}

async function verifyDailyTokenStatus() {
    if (isLoggedIn && hasPerm('no_qr')) {
        hasValidDailyToken = true;
        return;
    }
    const token = localStorage.getItem(DAILY_TOKEN_KEY) || '';
    if (!token) { hasValidDailyToken = false; return; }
    try {
        const { data, error } = await db.rpc('check_my_daily_token', { p_token: token });
        hasValidDailyToken = !error && data === true;
        if (!hasValidDailyToken) localStorage.removeItem(DAILY_TOKEN_KEY);
    } catch (e) {
        hasValidDailyToken = false;
    }
}

async function loadCurrentUserAccount(explicitUid = null) {
    if (!isLoggedIn) { currentUserAccount = null; return; }
    try {
        let uid = explicitUid;
        if (!uid) {
            const { data } = await db.auth.getSession();
            uid = data?.session?.user?.id || null;
        }
        if (!uid) { currentUserAccount = null; return; }
        const { data: acc, error } = await db.from('user_accounts').select('*').eq('user_id', uid).maybeSingle();
        currentUserAccount = (!error && acc) ? acc : null;
    } catch (e) {}
}

function startLiveSyncPolling() {
    if (liveSyncTimer) clearInterval(liveSyncTimer);
    liveSyncTimer = setInterval(async () => {
        if (document.hidden || (!isLoggedIn && !hasValidDailyToken)) return;
        try {
            await loadAllDatabaseData();
            renderSharedHeader();
            if (typeof currentPageUpdateCallback === 'function') currentPageUpdateCallback();
        } catch (e) {}
    }, LIVE_SYNC_INTERVAL_MS);
}

async function initSharedApp(onBackgroundUpdate = null) {
    currentPageUpdateCallback = onBackgroundUpdate;
    isLoggedIn = localStorage.getItem('pinplay_logged_in') === 'true';
    const cacheStatus = restoreStateFromCache();
    renderSharedHeader();
    checkLoginRoute();

    if (cacheStatus.loaded) {
        if (isLoggedIn && !currentUserAccount) {
            await loadCurrentUserAccount();
            renderSharedHeader();
        }
        if (!hasValidDailyToken && (hasPerm('no_qr') || localStorage.getItem(DAILY_TOKEN_KEY))) {
            await verifyDailyTokenStatus();
            saveStateToCache();
        }
        startLiveSyncPolling();
        setTimeout(restoreScrollPositionIfNeeded, 20);

        if (!cacheStatus.isFresh) {
            (async () => {
                await syncSessionInBackground();
                await loadAllDatabaseData();
                await verifyDailyTokenStatus();
                renderSharedHeader();
                if (typeof currentPageUpdateCallback === 'function') currentPageUpdateCallback();
            })();
        } else {
            syncSessionInBackground();
        }
        return;
    }

    await syncSessionInBackground();
    await loadAllDatabaseData();
    await verifyDailyTokenStatus();
    renderSharedHeader();
    setTimeout(restoreScrollPositionIfNeeded, 20);
    startLiveSyncPolling();
}

async function syncSessionInBackground() {
    try {
        const { data } = await db.auth.getSession();
        const real = data.session !== null;
        if (real !== isLoggedIn) {
            isLoggedIn = real;
            if (!isLoggedIn) {
                localStorage.removeItem('pinplay_logged_in');
                currentUserAccount = null;
                feedbackDB = []; reportsDB = []; partsOrdersDB = []; partsCatalogDB = []; partsTagsDB = []; accountsDB = [];
            } else {
                localStorage.setItem('pinplay_logged_in', 'true');
                await loadCurrentUserAccount(data.session.user.id);
                if (hasPerm('no_qr')) hasValidDailyToken = true;
            }
            renderSharedHeader();
        } else if (isLoggedIn && !currentUserAccount && data.session) {
            await loadCurrentUserAccount(data.session.user.id);
            renderSharedHeader();
        }
    } catch (e) {}
}

async function loadAllDatabaseData() {
    if (isLoggedIn) await loadCurrentUserAccount();

    const canRep = hasPerm('view_reports');
    const canFb = hasPerm('view_feedback');
    const canParts = hasPerm('request_parts') || hasPerm('manage_parts') || hasPerm('view_reports');
    const canAcc = hasPerm('manage_accounts');

    const res = await Promise.all([
        db.from('flipper').select('*').order('name', { ascending: true }),
        db.from('designer').select('*'),
        db.from('highscore').select('*').order('score', { ascending: false }),
        db.rpc('get_public_player_tags'),
        canRep ? db.from('reports').select('*') : Promise.resolve({ data: [] }),
        canFb ? db.from('feedback').select('*').order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
        canParts ? db.from('parts_orders').select('*').order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
        canParts ? db.from('parts_catalog').select('*').order('part_name', { ascending: true }) : Promise.resolve({ data: [] }),
        canParts ? db.from('parts_tags').select('*').order('name', { ascending: true }) : Promise.resolve({ data: [] }),
        canAcc ? db.from('user_accounts').select('*').order('display_name', { ascending: true }) : Promise.resolve({ data: [] })
    ]);

    const dbPins = res[0].data || [];
    const dbDes = res[1].data || [];
    const dbHs = res[2].data || [];
    const dbTags = (!res[3].error && res[3].data) ? res[3].data : [];
    const dbReps = (!res[4].error && res[4].data) ? res[4].data : [];
    const dbFb = (!res[5].error && res[5].data) ? res[5].data : [];
    const dbOrders = (!res[6].error && res[6].data) ? res[6].data : [];
    const dbCatalog = (!res[7].error && res[7].data) ? res[7].data : [];
    const dbPartTags = (!res[8].error && res[8].data) ? res[8].data : [];
    const dbAccs = (!res[9].error && res[9].data) ? res[9].data : [];

    playerTagsDB = dbTags.map((t) => ({
        userId: t.user_id,
        displayName: t.display_name || '',
        shortTag: String(t.short_tag || '').trim().toUpperCase(),
        flipperTags: (t.flipper_tags && typeof t.flipper_tags === 'object') ? t.flipper_tags : {}
    }));

    highscoresDB = dbHs.map((h) => ({
        id: h.id,
        pinballId: h.flipper_id,
        initials: String(h.initials || '???').toUpperCase(),
        score: Number(h.score || 0),
        verifiziert: h.verifiziert === true,
        beweisfoto: h.beweisfoto || '',
        date: h.created_at
    }));

    reportsDB = dbReps.map((r) => {
        const p = parseInt(r.intensitaet, 10);
        const mc = parseInt(r.merge_count, 10);
        return {
            id: r.id,
            pinballId: r.flipper_id,
            date: r.created_at,
            behobenAm: r.behoben_am || null,
            prio: (p >= 1 && p <= 3) ? p : 0,
            status: normalizeReportStatus(r.status),
            verifiziert: r.verifiziert === true,
            email: r.email || '',
            foto_url: r.foto_url || '',
            text: r.meldung || '',
            ursache: r.ursache || '',
            loesungsweg: r.loesungsweg || '',
            loesung_foto_url: r.loesung_foto_url || '',
            mergeCount: (!isNaN(mc) && mc >= 1) ? mc : 1
        };
    });

    feedbackDB = dbFb.map((f) => ({
        id: f.id,
        date: f.created_at,
        text: f.nachricht || '',
        email: f.email || '',
        foto: f.foto || ''
    }));

    partsOrdersDB = dbOrders.map((o) => ({
        id: o.id,
        partId: o.part_id || null,
        pinballId: o.flipper_id || null,
        reportId: o.report_id || null,
        partName: o.part_name || '',
        quantity: Number(o.quantity || 1),
        unitPrice: (o.unit_price !== null && o.unit_price !== undefined) ? Number(o.unit_price) : null,
        shopName: o.shop_name || '',
        shopUrl: o.shop_url || '',
        status: o.status || 'benoetigt',
        notes: o.notes || '',
        createdBy: o.created_by || '',
        date: o.created_at,
        orderedAt: o.ordered_at || null,
        deliveredAt: o.delivered_at || null
    }));

    partsCatalogDB = dbCatalog.map((c) => ({
        id: c.id,
        partName: c.part_name || '',
        tags: Array.isArray(c.tags) ? c.tags.filter(Boolean) : [],
        shopName: c.shop_name || '',
        shopUrl: c.shop_url || '',
        partNumber: c.part_number || '',
        price: (c.price !== null && c.price !== undefined) ? Number(c.price) : null,
        stockQty: Number(c.stock_qty || 0),
        notes: c.notes || ''
    }));

    partsTagsDB = dbPartTags.map((t) => ({ id: t.id, name: t.name || '' }));
    accountsDB = dbAccs;

    pinballs = dbPins.map((p) => {
        const designers = p.designer_id
            ? p.designer_id.map((id) => dbDes.find((d) => d.designer_id == id)?.designer).filter(Boolean).join(', ')
            : 'Unbekannt';
        const isAktiv = p.aktiv === true;
        const verified = highscoresDB.filter((h) => h.pinballId === p.id && h.verifiziert).sort((a, b) => b.score - a.score);
        const topScore = verified.length > 0
            ? `${formatScore(verified[0].score)} (${getFormattedPlayerDisplay(verified[0].initials, p.id)})`
            : 'Noch kein Rekord';
        const maxLen = (p.hs_max_length !== null && p.hs_max_length !== undefined && p.hs_max_length !== '') ? Number(p.hs_max_length) : 3;

        return {
            id: p.id,
            short: p.abbreviation || p.name.substring(0, 3).toUpperCase(),
            name: p.name,
            year: p['manufacture year'] || '-',
            maker: p.manufacturer || '-',
            designer: designers,
            prod: p.production || '-',
            score: topScore,
            status: isAktiv ? 'Spielbereit' : 'Wartung (Inaktiv)',
            power: p.an ? 'ON' : 'OFF',
            desc: p['georgs text'] || '',
            isAktiv,
            imgUrl: getFlipperImageUrl(p.foto_url || p.foto || p.bild || ''),
            hsMaxLength: (!isNaN(maxLen) && maxLen >= 0) ? maxLen : 3,
            hsAllowNumbers: p.hs_allow_numbers === true,
            hsAllowSpecial: p.hs_allow_special === true
        };
    });

    saveStateToCache();
}

// --- BILDKOMPRIMIERUNG, POWER, FOTOS & SCORE-BEREINIGUNG ---

async function compressImageFile(file, maxDim = 1600, quality = 0.78) {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => {
                let { width: w, height: h } = img;
                if (w > maxDim || h > maxDim) {
                    if (w >= h) { h = Math.round((h * maxDim) / w); w = maxDim; }
                    else { w = Math.round((w * maxDim) / h); h = maxDim; }
                }
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                c.toBlob((blob) => {
                    if (!blob) { resolve(file); return; }
                    const base = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
                    resolve(new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }));
                }, 'image/jpeg', quality);
            };
            img.onerror = () => resolve(file);
            img.src = ev.target.result;
        };
        reader.onerror = () => resolve(file);
        reader.readAsDataURL(file);
    });
}

async function uploadIncomingPhoto(folder, file) {
    if (!file) return '';
    const compressed = await compressImageFile(file);
    const safeName = compressed.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${folder}/${Date.now()}_${safeName}`;
    const { error } = await db.storage.from('fotos-incoming').upload(path, compressed);
    if (error) throw error;
    return path;
}

function populatePinballInfoBox(pin, prefix) {
    if (!pin) return;
    document.getElementById(`${prefix}-title`).innerText = pin.name;
    document.getElementById(`${prefix}-score`).innerText = pin.score;
    document.getElementById(`${prefix}-year`).innerText = pin.year;
    document.getElementById(`${prefix}-maker`).innerText = pin.maker;
    document.getElementById(`${prefix}-designer`).innerText = pin.designer;
    document.getElementById(`${prefix}-prod`).innerText = pin.prod;

    const imgBox = document.getElementById(`${prefix}-img-box`);
    if (imgBox) {
        const html = pin.imgUrl ? `<img src="${pin.imgUrl}" alt="${escHtml(pin.name)}">` : '';
        if (imgBox.innerHTML !== html) imgBox.innerHTML = html;
    }
}

async function togglePinballPower(pinballId, btnEl, onDone = null) {
    const pin = pinballs.find((p) => p.id === pinballId);
    if (!pin) return;

    const canPowerOff = hasPerm('power_off');
    if (!canPowerOff && !pin.isAktiv) {
        showActionToast('Sicherheitssperre: Inaktive Flipper können nicht eingeschaltet werden!', 'error');
        return;
    }
    if (!canPowerOff && !ensureWritePermission()) return;

    const isOn = pin.power === 'ON';
    if (isOn && !canPowerOff) {
        showActionToast(`„${pin.name}“ ist bereits eingeschaltet!`, 'info');
        return;
    }

    const next = !isOn;
    if (btnEl) {
        btnEl.disabled = true;
        btnEl.classList.add('btn-busy');
        btnEl.innerText = next ? '⏳ Schalte ein...' : '⏳ Schalte aus...';
    }

    const { error } = await db.from('flipper').update({ an: next }).eq('id', pin.id);
    if (error) {
        if (btnEl) { btnEl.disabled = false; btnEl.classList.remove('btn-busy'); }
        showActionToast('Fehler beim Schalten: ' + error.message, 'error');
        if (typeof onDone === 'function') onDone(pin);
        return;
    }

    pin.power = next ? 'ON' : 'OFF';
    saveStateToCache();
    showActionToast(next ? `✓ „${pin.name}“ eingeschaltet (ON)!` : `„${pin.name}“ ausgeschaltet (OFF).`, next ? 'success' : 'info');
    if (typeof onDone === 'function') onDone(pin);
}

async function togglePrivatePhoto(boxId, btnId, filePath, showText, hideText, labelText = '') {
    if (!filePath) return;
    const box = document.getElementById(boxId);
    const btn = document.getElementById(btnId);
    if (!box) return;

    if (box.style.display === 'block') {
        box.style.display = 'none';
        if (btn) btn.innerText = showText;
        return;
    }

    box.style.display = 'block';
    if (btn) btn.innerText = hideText;
    if (box.dataset.loaded === 'true') return;

    box.innerHTML = '<i>Lade geschütztes Foto...</i>';
    const { data, error } = await db.storage.from('fotos-incoming').createSignedUrl(filePath, 300);
    if (error || !data?.signedUrl) {
        box.innerHTML = `<span style="color:var(--red);">Fehler beim Laden: ${escHtml(error ? error.message : 'Unbekannt')}</span>`;
        return;
    }

    box.dataset.loaded = 'true';
    const label = labelText ? `<div style="font-size:12px; font-weight:bold; color:var(--muted); margin-bottom:4px;">${escHtml(labelText)}:</div>` : '';
    box.innerHTML = `${label}<a href="${data.signedUrl}" target="_blank" title="In voller Größe öffnen"><img src="${data.signedUrl}" style="max-width:100%; max-height:350px; border-radius:6px; border:1px solid var(--border-l); margin-top:4px;"></a>`;
}

async function removeOldLowerPlayerScores(pinballId, playerInitials, keepScoreId, newScoreValue) {
    if (hasPerm('verify_highscores')) {
        const old = highscoresDB.filter(
            (h) => h.pinballId === pinballId && h.id !== keepScoreId && isSamePlayerIdentity(h.initials, playerInitials, pinballId) && h.score <= newScoreValue
        );
        for (const item of old) {
            if (item.beweisfoto) await db.storage.from('fotos-incoming').remove([item.beweisfoto]);
            await db.from('highscore').delete().eq('id', item.id);
        }
    } else if (hasPerm('auto_verify_highscores') && keepScoreId) {
        await db.rpc('cleanup_lower_scores_for_entry', { p_keep_id: keepScoreId });
    }
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
}