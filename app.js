// 1. Tages-Token (?token=...) und getrennte Herkunft (?from=...) sofort auslesen und aus der Adresszeile entfernen
const DAILY_TOKEN_KEY = 'pinplay_daily_token';
const NAV_DETAIL_ORIGIN_KEY = 'pinplay_origin_detail';
const NAV_HS_SUBMIT_ORIGIN_KEY = 'pinplay_origin_hs_submit';
const BACK_NAV_FLAG_KEY = 'pinplay_is_back_nav';
const POST_LOGIN_REDIRECT_KEY = 'pinplay_post_login_redirect';

let navOriginDetail = sessionStorage.getItem(NAV_DETAIL_ORIGIN_KEY) || '';
let navOriginHsSubmit = sessionStorage.getItem(NAV_HS_SUBMIT_ORIGIN_KEY) || '';
let navOriginFrom = navOriginDetail;

(function cleanUrlParameters() {
    const params = new URLSearchParams(window.location.search);
    const path = window.location.pathname;
    let urlChanged = false;

    const scannedToken = params.get('token');
    if (scannedToken && scannedToken.trim() !== '') {
        localStorage.setItem(DAILY_TOKEN_KEY, scannedToken.trim().toUpperCase());
        params.delete('token');
        urlChanged = true;
    }

    const isHighscoresPage = path.endsWith('highscores') || path.endsWith('highscores.html');
    const isDetailPage = path.endsWith('detail') || path.endsWith('detail.html') || path.endsWith('tech-detail') || path.endsWith('tech-detail.html');

    if (params.has('from')) {
        const fromVal = params.get('from') || '';
        if (isHighscoresPage) {
            navOriginHsSubmit = fromVal;
            sessionStorage.setItem(NAV_HS_SUBMIT_ORIGIN_KEY, fromVal);
        } else {
            navOriginDetail = fromVal;
            navOriginFrom = fromVal;
            sessionStorage.setItem(NAV_DETAIL_ORIGIN_KEY, fromVal);
        }
        params.delete('from');
        urlChanged = true;
    } else if (!isHighscoresPage && !isDetailPage) {
        navOriginDetail = '';
        navOriginHsSubmit = '';
        navOriginFrom = '';
        sessionStorage.removeItem(NAV_DETAIL_ORIGIN_KEY);
        sessionStorage.removeItem(NAV_HS_SUBMIT_ORIGIN_KEY);
    }

    if (urlChanged) {
        const cleanQuery = params.toString();
        const cleanUrl = window.location.pathname + (cleanQuery ? `?${cleanQuery}` : '') + window.location.hash;
        window.history.replaceState({}, '', cleanUrl);
    }
})();


// Supabase initialisieren (inkl. Übergabe des gespeicherten Tages-Tokens im Header)
const supabaseUrl = 'https://gwvxctkowtiyfrhoozhj.supabase.co';
const supabaseKey = 'sb_publishable__H6Yjq1-Tift6S7NHxSGcw_ihus2Zbw';
const currentDailyToken = localStorage.getItem(DAILY_TOKEN_KEY) || '';
const db = window.supabase.createClient(supabaseUrl, supabaseKey, {
    global: {
        headers: {
            'x-pinplay-token': currentDailyToken
        }
    }
});

const OFFICIAL_HOMEPAGE_URL = './';
const CACHE_KEY_STATE = 'pinplay_full_data_cache_v8';
const CACHE_TTL_MS = 15 * 1000;
const LIVE_SYNC_INTERVAL_MS = 15 * 1000;

// Globale Datenspeicher
let pinballs = [];
let reportsDB = [];
let highscoresDB = [];
let feedbackDB = [];
let playersDB = [];
let partsOrdersDB = [];
let partsCatalogDB = [];
let partsTagsDB = [];
let accountsDB = [];
let currentUserAccount = null;
let isLoggedIn = false;
let isTechMode = false;
let hasValidDailyToken = false;
let currentPageUpdateCallback = null;
let liveSyncTimer = null;
let isRestoringScroll = true;

// --- GRANULARES BERECHTIGUNGSSYSTEM ---

function hasPerm(permKey) {
    if (!isLoggedIn || !currentUserAccount) return false;
    // Admin besitzt automatisch sämtliche Rechte
    if (currentUserAccount.perm_manage_accounts === true) return true;

    switch (permKey) {
        case 'admin':
        case 'manage_accounts':
            return false;
        case 'no_qr':
            return currentUserAccount.perm_no_qr === true;
        case 'power_off':
            return currentUserAccount.perm_power_off === true;
        case 'auto_verify_reports':
            return currentUserAccount.perm_auto_verify_reports === true
                || currentUserAccount.perm_view_reports === true
                || currentUserAccount.perm_manage_reports === true;
        case 'view_reports':
            return currentUserAccount.perm_view_reports === true
                || currentUserAccount.perm_manage_reports === true;
        case 'manage_reports':
            return currentUserAccount.perm_manage_reports === true;
        case 'auto_verify_highscores':
            return currentUserAccount.perm_auto_verify_highscores === true
                || currentUserAccount.perm_verify_highscores === true;
        case 'verify_highscores':
            return currentUserAccount.perm_verify_highscores === true;
        case 'request_parts':
            return currentUserAccount.perm_request_parts === true
                || currentUserAccount.perm_manage_parts === true;
        case 'manage_parts':
            return currentUserAccount.perm_manage_parts === true;
        case 'view_feedback':
            return currentUserAccount.perm_view_feedback === true;
        case 'manage_players_qr':
            return currentUserAccount.perm_manage_players_qr === true;
        default: {
            const col = permKey.startsWith('perm_') ? permKey : `perm_${permKey}`;
            return currentUserAccount[col] === true;
        }
    }
}

function getReportAccessLevel(acc = currentUserAccount) {
    if (!acc) return 0;
    if (acc.perm_manage_accounts || acc.perm_manage_reports) return 3;
    if (acc.perm_view_reports) return 2;
    if (acc.perm_auto_verify_reports) return 1;
    return 0;
}

function hasAnyAdminAreaAccess() {
    if (!isLoggedIn || !currentUserAccount) return false;
    return !!(
        currentUserAccount.perm_manage_accounts ||
        currentUserAccount.perm_power_off ||
        currentUserAccount.perm_view_reports ||
        currentUserAccount.perm_manage_reports ||
        currentUserAccount.perm_verify_highscores ||
        currentUserAccount.perm_request_parts ||
        currentUserAccount.perm_manage_parts ||
        currentUserAccount.perm_view_feedback ||
        currentUserAccount.perm_manage_players_qr
    );
}

// --- SCROLL-POSITION SPEICHERN & BEIM ZURÜCK-BUTTON WIEDERHERSTELLEN ---

function getNormalizedPageKey() {
    let p = window.location.pathname.replace(/\.html$/, '');
    if (p.endsWith('/')) p += 'index';
    return 'pinplay_scroll_' + p;
}

function saveCurrentScrollPos() {
    try {
        sessionStorage.setItem(getNormalizedPageKey(), String(window.scrollY || 0));
    } catch (e) {}
}

window.addEventListener('scroll', () => {
    if (!isRestoringScroll) saveCurrentScrollPos();
}, { passive: true });

function navigateBackTo(targetUrl) {
    sessionStorage.setItem(BACK_NAV_FLAG_KEY, 'true');
    window.location.href = targetUrl;
}

function restoreScrollPositionIfNeeded() {
    const navEntries = performance.getEntriesByType && performance.getEntriesByType('navigation');
    const isBrowserBackForward = navEntries && navEntries.length > 0 && navEntries[0].type === 'back_forward';
    const isCustomBack = sessionStorage.getItem(BACK_NAV_FLAG_KEY) === 'true';

    if (isCustomBack || isBrowserBackForward) {
        sessionStorage.removeItem(BACK_NAV_FLAG_KEY);
        const savedY = parseInt(sessionStorage.getItem(getNormalizedPageKey()) || '0', 10);
        if (savedY > 0) {
            isRestoringScroll = true;
            requestAnimationFrame(() => {
                window.scrollTo({ top: savedY, behavior: 'instant' });
                setTimeout(() => {
                    window.scrollTo({ top: savedY, behavior: 'instant' });
                    isRestoringScroll = false;
                }, 80);
            });
            return;
        }
    }
    setTimeout(() => { isRestoringScroll = false; }, 80);
}

// --- VISUELLES TOAST-BANNER ---

function showActionToast(message, type = 'success', durationMs = 3500) {
    let container = document.getElementById('pinplay-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'pinplay-toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    const extraClass = type === 'error' ? 'toast-error' : (type === 'info' ? 'toast-info' : '');
    toast.className = `pinplay-toast ${extraClass}`;
    toast.innerText = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.transition = 'opacity 0.25s ease';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 260);
    }, durationMs);
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

function normalizeReportStatus(rawStatus) {
    if (!rawStatus) return 'offen';
    const lower = String(rawStatus).trim().toLowerCase();
    if (lower === 'behoben' || lower === 'erledigt' || lower === 'geschlossen') return 'behoben';
    return 'offen';
}

function getStatusColorClass(status) {
    if (status.includes("Defekt")) return "status-rot";
    if (status.includes("Wartung") || status.includes("Eingeschränkt")) return "status-orange";
    return "status-grün";
}

function stylePowerButton(btnElement, powerState) {
    if (!btnElement) return;
    btnElement.disabled = false;
    btnElement.classList.remove('btn-busy');
    btnElement.style.display = 'inline-block';
    btnElement.innerText = powerState;
    btnElement.style.backgroundColor = powerState === 'ON' ? '#16261b' : '#3b1818';
    btnElement.style.color = powerState === 'ON' ? '#3fb950' : '#ff7b72';
    btnElement.style.borderColor = powerState === 'ON' ? '#2ea043' : '#cf3432';
}

// Prüft, ob Account vom QR-Code befreit ist (perm_no_qr / Admin) ODER ein gültiges Tages-QR-Token gescannt wurde
function ensureWritePermission() {
    if (hasPerm('no_qr') || hasValidDailyToken) {
        return true;
    }
    showActionToast("Zugangssperre: Bitte scanne zuerst den aktuellen Tages-QR-Code vor Ort im Pin&Play!", "error", 4500);
    return false;
}

// --- SPIELER-ALIAS & FLIPPER-SPEZIFISCHE NAMENS-VERKNÜPFUNG ---

function resolvePlayerProfile(rawInput) {
    if (!rawInput) return null;
    const norm = String(rawInput).trim().toUpperCase();
    if (!norm) return null;

    return playersDB.find(pl => {
        if (pl.displayName.toUpperCase() === norm) return true;
        if (pl.shortInitials.toUpperCase() === norm) return true;
        if (pl.aliases.some(a => a.toUpperCase() === norm)) return true;
        if (pl.flipperTags && Object.values(pl.flipperTags).some(v => String(v).toUpperCase() === norm)) return true;
        return false;
    }) || null;
}

function isSamePlayerIdentity(nameA, nameB) {
    const normA = String(nameA || '').trim().toUpperCase();
    const normB = String(nameB || '').trim().toUpperCase();
    if (!normA || !normB) return false;
    if (normA === normB) return true;
    const profA = resolvePlayerProfile(normA);
    const profB = resolvePlayerProfile(normB);
    return !!(profA && profB && profA.id === profB.id);
}

function getProfileNameForPinball(prof, pin) {
    if (!prof || !pin) return '';
    const effectiveMaxLen = pin.hsMaxLength === 0 ? 3 : pin.hsMaxLength;
    if (effectiveMaxLen <= 3) {
        return (prof.shortInitials || prof.displayName).toUpperCase().substring(0, 3);
    }
    const customForPin = prof.flipperTags ? prof.flipperTags[String(pin.id)] : null;
    if (customForPin && String(customForPin).trim() !== '') {
        return String(customForPin).trim().toUpperCase().substring(0, effectiveMaxLen);
    }
    return prof.displayName.toUpperCase().substring(0, effectiveMaxLen);
}

function getFormattedPlayerDisplay(rawInitials) {
    const prof = resolvePlayerProfile(rawInitials);
    if (!prof) return rawInitials;
    const upperRaw = String(rawInitials).trim().toUpperCase();
    if (upperRaw === prof.displayName.toUpperCase()) return prof.displayName;
    return `${upperRaw} (${prof.displayName})`;
}

// --- AUFGERÄUMTES HEADER-BANNER MIT DROPDOWNS ---

function getActiveNavTab() {
    const path = window.location.pathname;
    if (path.endsWith('highscores') || path.endsWith('highscores.html')) return 'highscores';
    if (path.endsWith('tech-feed') || path.endsWith('tech-feed.html')) return 'tech-feed';
    if (path.endsWith('tech-parts') || path.endsWith('tech-parts.html')) return 'tech-parts';
    if (path.endsWith('tech-feedback') || path.endsWith('tech-feedback.html')) return 'tech-feedback';
    if (path.endsWith('tech-players') || path.endsWith('tech-players.html')) return 'tech-players';
    if (path.endsWith('tech-accounts') || path.endsWith('tech-accounts.html')) return 'tech-accounts';
    return 'overview';
}

function closeAllHeaderDropdowns() {
    document.querySelectorAll('.nav-dropdown-menu').forEach(m => m.classList.add('hidden'));
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

    const canUseTechArea = hasAnyAdminAreaAccess();
    const techActive = isLoggedIn && isTechMode && canUseTechArea;

    if (techActive) header.classList.add('tech-mode');
    else header.classList.remove('tech-mode');

    const activeTab = getActiveNavTab();
    const cls = (tab) => activeTab === tab ? 'btn-nav-page btn-nav-active' : 'btn-nav-page';

    let primaryTechHtml = '';
    let manageMenuItems = [];

    if (techActive) {
        // 1. News-Feed direkt sichtbar
        if (hasPerm('view_reports') || hasPerm('verify_highscores')) {
            const unverifReps = hasPerm('view_reports') ? reportsDB.filter(r => r.status === 'offen' && !r.verifiziert).length : 0;
            const unverifHs = hasPerm('verify_highscores') ? highscoresDB.filter(h => !h.verifiziert).length : 0;
            const totalUnverif = unverifReps + unverifHs;
            const feedBadge = totalUnverif > 0 ? `<span class="badge-nav-count">${totalUnverif}</span>` : '';
            primaryTechHtml += `<button class="${cls('tech-feed')}" onclick="window.location.href='tech-feed'">News-Feed${feedBadge}</button>`;
        }

        // 2. Ersatzteile & Inventar direkt sichtbar
        if (hasPerm('request_parts') || hasPerm('manage_parts') || hasPerm('view_reports')) {
            const openParts = partsOrdersDB.filter(p => p.status === 'benoetigt').length;
            const partsBadge = openParts > 0 ? `<span class="badge-nav-count count-gold">${openParts}</span>` : '';
            primaryTechHtml += `<button class="${cls('tech-parts')}" onclick="window.location.href='tech-parts'">Ersatzteile${partsBadge}</button>`;
        }

        // 3. Seltener genutzte Verwaltungsseiten sauber im "Verwaltung ▾"-Menü bündeln
        if (hasPerm('view_feedback')) {
            const fbBadge = feedbackDB.length > 0 ? `<span class="badge-nav-count count-gold">${feedbackDB.length}</span>` : '';
            manageMenuItems.push(`<button class="nav-dropdown-item ${activeTab === 'tech-feedback' ? 'item-active' : ''}" onclick="window.location.href='tech-feedback'"><span>Spieler-Feedback</span>${fbBadge}</button>`);
        }
        if (hasPerm('manage_players_qr')) {
            manageMenuItems.push(`<button class="nav-dropdown-item ${activeTab === 'tech-players' ? 'item-active' : ''}" onclick="window.location.href='tech-players'"><span>Kürzel &amp; Tages-QR</span></button>`);
            manageMenuItems.push(`<button class="nav-dropdown-item" onclick="window.open('tv-highscores', '_blank')"><span>100"-TV Highscores</span><span>↗</span></button>`);
        }
        if (hasPerm('manage_accounts')) {
            manageMenuItems.push(`<button class="nav-dropdown-item ${activeTab === 'tech-accounts' ? 'item-active' : ''}" onclick="window.location.href='tech-accounts'"><span>Accounts &amp; Rechte</span></button>`);
        }

        if (manageMenuItems.length > 0) {
            const manageActive = ['tech-feedback', 'tech-players', 'tech-accounts'].includes(activeTab);
            const manageBtnClass = manageActive ? 'btn-nav-page btn-nav-active' : 'btn-nav-page';
            const manageCount = hasPerm('view_feedback') ? feedbackDB.length : 0;
            const manageBadge = manageCount > 0 ? `<span class="badge-nav-count count-gold">${manageCount}</span>` : '';

            primaryTechHtml += `
                <div class="nav-dropdown">
                    <button class="${manageBtnClass}" onclick="toggleHeaderDropdown('header-manage-menu', event)">Verwaltung${manageBadge} ▾</button>
                    <div id="header-manage-menu" class="nav-dropdown-menu hidden" onclick="event.stopPropagation()">
                        ${manageMenuItems.join('')}
                    </div>
                </div>
            `;
        }
    }

    // Kompakter Account-Button rechts (bündelt Techniker-Modus-Schalter & Logout)
    let accountMenuHtml = '';
    if (isLoggedIn) {
        const displayName = (currentUserAccount && currentUserAccount.display_name) ? currentUserAccount.display_name : 'Account';
        const roleLabel = (currentUserAccount && currentUserAccount.role_label) ? currentUserAccount.role_label : '';
        const safeName = displayName.replace(/</g, '&lt;');
        const safeRole = roleLabel.replace(/</g, '&lt;');

        const techSwitchItem = canUseTechArea
            ? `<button class="nav-dropdown-item" onclick="toggleTechMode()"><span>Techniker Modus</span><strong style="color:${isTechMode ? '#7ee787' : '#ff7b72'};">${isTechMode ? 'AN' : 'AUS'}</strong></button>`
            : '';

        accountMenuHtml = `
            <div class="nav-dropdown">
                <button class="btn-nav-util" onclick="toggleHeaderDropdown('header-account-menu', event)">${safeName} ▾</button>
                <div id="header-account-menu" class="nav-dropdown-menu hidden" onclick="event.stopPropagation()">
                    <div class="nav-dropdown-header">
                        <strong>${safeName}</strong>
                        <span>${safeRole || 'Eingeloggt'}</span>
                    </div>
                    ${techSwitchItem}
                    <button class="nav-dropdown-item item-danger" onclick="doLogout()"><span>Logout</span></button>
                </div>
            </div>
        `;
    }

    header.innerHTML = `
        <a href="${OFFICIAL_HOMEPAGE_URL}" class="logo" title="Zur offiziellen Pin&Play Homepage">
            <img src="logo.png" alt="Pin & Play Retro Gaming" class="logo-img">
        </a>
        <div class="quick-actions">
            <button class="${cls('overview')}" onclick="goHome()">Übersicht</button>
            <button class="${cls('highscores')}" onclick="window.location.href='highscores'">Highscores</button>
            ${primaryTechHtml}
            ${accountMenuHtml}
        </div>
    `;
}

// --- LOGIN / LOGOUT ---

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
                <p id="login-error" style="color: #ff7b72; display: none; margin-top: 15px; font-weight: bold;"></p>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

function checkHashLogin() {
    ensureLoginModalExists();
    const modal = document.getElementById('global-login-modal');
    if (window.location.hash === '#login') {
        if (isLoggedIn) {
            window.location.hash = '';
            const savedRedirect = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
            if (savedRedirect) {
                sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
                window.location.href = savedRedirect;
                return;
            }
            if (hasAnyAdminAreaAccess()) {
                localStorage.setItem('pinplay_tech_mode', 'true');
                window.location.href = 'techniker';
            } else {
                window.location.href = './';
            }
        } else {
            modal.classList.remove('hidden');
        }
    }
}

function closeLoginModal() {
    window.location.hash = '';
    const modal = document.getElementById('global-login-modal');
    if (modal) modal.classList.add('hidden');
}

function redirectToLoginWithReturn() {
    try {
        sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, window.location.href);
    } catch (e) {}
    window.location.href = './#login';
}

async function doLogin() {
    const email = document.getElementById('login-email').value.trim();
    const pwd = document.getElementById('login-pwd').value;
    const errDisplay = document.getElementById('login-error');

    const { data, error } = await db.auth.signInWithPassword({ email, password: pwd });
    if (error) {
        errDisplay.innerText = "Login fehlgeschlagen: " + error.message;
        errDisplay.style.display = 'block';
    } else {
        errDisplay.style.display = 'none';
        window.location.hash = '';
        isLoggedIn = true;
        localStorage.setItem('pinplay_logged_in', 'true');
        localStorage.removeItem(CACHE_KEY_STATE);

        await loadCurrentUserAccount(data?.user?.id);
        const canAdmin = hasAnyAdminAreaAccess();
        localStorage.setItem('pinplay_tech_mode', canAdmin ? 'true' : 'false');

        const savedRedirect = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
        if (savedRedirect) {
            sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
            window.location.href = savedRedirect;
            return;
        }

        window.location.href = canAdmin ? 'techniker' : './';
    }
}

async function doLogout() {
    if (!confirm("Möchtest du dich wirklich ausloggen?")) return;
    await db.auth.signOut();
    localStorage.removeItem('pinplay_tech_mode');
    localStorage.removeItem('pinplay_logged_in');
    localStorage.removeItem(CACHE_KEY_STATE);
    window.location.href = './';
}

function goHome() {
    if (isTechMode && hasAnyAdminAreaAccess()) window.location.href = 'techniker';
    else window.location.href = './';
}

function toggleTechMode() {
    if (!isLoggedIn || !hasAnyAdminAreaAccess()) return;
    isTechMode = !isTechMode;
    localStorage.setItem('pinplay_tech_mode', isTechMode ? 'true' : 'false');

    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const fromSuffix = navOriginDetail ? `&from=${navOriginDetail}` : '';

    if (isTechMode) {
        if ((path.endsWith('detail') || path.endsWith('/detail') || path.endsWith('detail.html')) && id) {
            window.location.href = `tech-detail?id=${id}${fromSuffix}`;
        } else if (path.endsWith('highscores') || path.endsWith('/highscores') || path.endsWith('highscores.html')) {
            window.location.reload();
        } else {
            window.location.href = 'techniker';
        }
    } else {
        if ((path.endsWith('tech-detail') || path.endsWith('/tech-detail') || path.endsWith('tech-detail.html')) && id) {
            window.location.href = `detail?id=${id}${fromSuffix}`;
        } else if (path.endsWith('highscores') || path.endsWith('/highscores') || path.endsWith('highscores.html')) {
            window.location.reload();
        } else {
            window.location.href = './';
        }
    }
}

window.addEventListener('hashchange', checkHashLogin);

// --- CACHE, SESSION & 15-SEKUNDEN-SYNC ---

function saveStateToCache() {
    try {
        localStorage.setItem(CACHE_KEY_STATE, JSON.stringify({
            pinballs,
            reportsDB,
            highscoresDB,
            feedbackDB,
            playersDB,
            partsOrdersDB,
            partsCatalogDB,
            partsTagsDB,
            accountsDB,
            currentUserAccount,
            hasValidDailyToken,
            timestamp: Date.now()
        }));
    } catch (e) {}
}

function restoreStateFromCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY_STATE);
        if (!raw) return { loaded: false, isFresh: false };
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.pinballs) && parsed.pinballs.length > 0) {
            pinballs = parsed.pinballs;
            reportsDB = parsed.reportsDB || [];
            highscoresDB = parsed.highscoresDB || [];
            feedbackDB = parsed.feedbackDB || [];
            playersDB = parsed.playersDB || [];
            partsOrdersDB = parsed.partsOrdersDB || [];
            partsCatalogDB = parsed.partsCatalogDB || [];
            partsTagsDB = parsed.partsTagsDB || [];
            accountsDB = parsed.accountsDB || [];
            currentUserAccount = parsed.currentUserAccount || null;
            hasValidDailyToken = parsed.hasValidDailyToken === true;
            const age = Date.now() - (parsed.timestamp || 0);
            return { loaded: true, isFresh: age < CACHE_TTL_MS };
        }
    } catch (e) {}
    return { loaded: false, isFresh: false };
}

async function verifyDailyTokenStatus() {
    if (isLoggedIn && hasPerm('no_qr')) {
        hasValidDailyToken = true;
        return;
    }
    const token = localStorage.getItem(DAILY_TOKEN_KEY) || '';
    if (!token) {
        hasValidDailyToken = false;
        return;
    }
    try {
        const { data, error } = await db.rpc('check_my_daily_token', { p_token: token });
        hasValidDailyToken = !error && data === true;
        if (!hasValidDailyToken) {
            localStorage.removeItem(DAILY_TOKEN_KEY);
        }
    } catch (e) {
        hasValidDailyToken = false;
    }
}

async function loadCurrentUserAccount(explicitUserId = null) {
    if (!isLoggedIn) {
        currentUserAccount = null;
        return;
    }
    try {
        let uid = explicitUserId;
        if (!uid) {
            const { data } = await db.auth.getSession();
            uid = data?.session?.user?.id || null;
        }
        if (!uid) {
            currentUserAccount = null;
            return;
        }
        const { data: accData, error } = await db
            .from('user_accounts')
            .select('*')
            .eq('user_id', uid)
            .maybeSingle();

        if (!error && accData) {
            currentUserAccount = accData;
        } else {
            currentUserAccount = null;
        }
    } catch (e) {}
}

function startLiveSyncPolling() {
    if (liveSyncTimer) clearInterval(liveSyncTimer);
    liveSyncTimer = setInterval(async () => {
        if (document.hidden) return;
        if (!isLoggedIn && !hasValidDailyToken) return;
        try {
            await loadAllDatabaseData();
            renderSharedHeader();
            if (typeof currentPageUpdateCallback === 'function') {
                currentPageUpdateCallback();
            }
        } catch (e) {}
    }, LIVE_SYNC_INTERVAL_MS);
}

async function initSharedApp(onBackgroundUpdate = null) {
    currentPageUpdateCallback = onBackgroundUpdate;
    isLoggedIn = localStorage.getItem('pinplay_logged_in') === 'true';
    const cacheStatus = restoreStateFromCache();
    isTechMode = isLoggedIn && hasAnyAdminAreaAccess() && localStorage.getItem('pinplay_tech_mode') === 'true';
    renderSharedHeader();
    checkHashLogin();

    if (cacheStatus.loaded) {
        if (isLoggedIn && !currentUserAccount) {
            await loadCurrentUserAccount();
            isTechMode = isLoggedIn && hasAnyAdminAreaAccess() && localStorage.getItem('pinplay_tech_mode') === 'true';
            renderSharedHeader();
        }
        if (!hasValidDailyToken && (hasPerm('no_qr') || localStorage.getItem(DAILY_TOKEN_KEY))) {
            await verifyDailyTokenStatus();
            saveStateToCache();
        } else {
            verifyDailyTokenStatus().then(() => startLiveSyncPolling());
        }
        startLiveSyncPolling();
        setTimeout(restoreScrollPositionIfNeeded, 20);

        if (!cacheStatus.isFresh) {
            (async () => {
                await syncSessionInBackground();
                await loadAllDatabaseData();
                await verifyDailyTokenStatus();
                isTechMode = isLoggedIn && hasAnyAdminAreaAccess() && localStorage.getItem('pinplay_tech_mode') === 'true';
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
    isTechMode = isLoggedIn && hasAnyAdminAreaAccess() && localStorage.getItem('pinplay_tech_mode') === 'true';
    renderSharedHeader();
    setTimeout(restoreScrollPositionIfNeeded, 20);
    startLiveSyncPolling();
}

async function syncSessionInBackground() {
    try {
        const { data } = await db.auth.getSession();
        const realLoggedIn = data.session !== null;
        if (realLoggedIn !== isLoggedIn) {
            isLoggedIn = realLoggedIn;
            if (!isLoggedIn) {
                localStorage.removeItem('pinplay_tech_mode');
                localStorage.removeItem('pinplay_logged_in');
                isTechMode = false;
                currentUserAccount = null;
                feedbackDB = [];
                reportsDB = [];
                partsOrdersDB = [];
                partsCatalogDB = [];
                partsTagsDB = [];
                accountsDB = [];
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
    if (isLoggedIn) {
        await loadCurrentUserAccount();
    }

    const canReadReports = hasPerm('view_reports');
    const canReadFeedback = hasPerm('view_feedback');
    const canReadParts = hasPerm('request_parts') || hasPerm('manage_parts') || hasPerm('view_reports');
    const canReadAccounts = hasPerm('manage_accounts');

    const queries = [
        db.from('flipper').select('*').order('name', { ascending: true }),
        db.from('designer').select('*'),
        db.from('highscore').select('*').order('score', { ascending: false }),
        db.from('players').select('*').order('display_name', { ascending: true }),
        canReadReports ? db.from('reports').select('*') : Promise.resolve({ data: [] }),
        canReadFeedback ? db.from('feedback').select('*').order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
        canReadParts ? db.from('parts_orders').select('*').order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
        canReadParts ? db.from('parts_catalog').select('*').order('part_name', { ascending: true }) : Promise.resolve({ data: [] }),
        canReadParts ? db.from('parts_tags').select('*').order('name', { ascending: true }) : Promise.resolve({ data: [] }),
        canReadAccounts ? db.from('user_accounts').select('*').order('display_name', { ascending: true }) : Promise.resolve({ data: [] })
    ];

    const results = await Promise.all(queries);
    const dbPins = results[0].data;
    const dbDes = results[1].data;
    const dbHs = results[2].data;
    const dbPlayers = results[3] && !results[3].error ? results[3].data : [];
    const dbReps = (results[4] && !results[4].error) ? results[4].data : [];
    const dbFb = (results[5] && !results[5].error) ? results[5].data : [];
    const dbPartsOrders = (results[6] && !results[6].error) ? results[6].data : [];
    const dbPartsCatalog = (results[7] && !results[7].error) ? results[7].data : [];
    const dbPartsTags = (results[8] && !results[8].error) ? results[8].data : [];
    const dbAccounts = (results[9] && !results[9].error) ? results[9].data : [];

    playersDB = (dbPlayers || []).map(pl => ({
        id: pl.id,
        displayName: pl.display_name || '',
        shortInitials: (pl.short_tag || pl.short_initials || '').toUpperCase(),
        aliases: Array.isArray(pl.aliases) ? pl.aliases.map(a => String(a).toUpperCase()) : [],
        flipperTags: (pl.flipper_tags && typeof pl.flipper_tags === 'object') ? pl.flipper_tags : {},
        hasPin: pl.has_pin === true
    }));

    highscoresDB = (dbHs || []).map(h => ({
        id: h.id,
        pinballId: h.flipper_id,
        initials: (h.initials || '???').toUpperCase(),
        score: Number(h.score || 0),
        verifiziert: h.verifiziert === true,
        beweisfoto: h.beweisfoto || '',
        date: h.created_at
    }));

    reportsDB = (dbReps || []).map(r => {
        let prioNum = 0;
        if (r.intensitaet !== null && r.intensitaet !== undefined && r.intensitaet !== '') {
            const parsed = parseInt(r.intensitaet, 10);
            if (parsed >= 1 && parsed <= 3) prioNum = parsed;
        }
        const parsedMergeCount = parseInt(r.merge_count, 10);

        return {
            id: r.id,
            pinballId: r.flipper_id,
            date: r.created_at,
            behobenAm: r.behoben_am || null,
            prio: prioNum,
            status: normalizeReportStatus(r.status),
            verifiziert: r.verifiziert === true,
            email: r.email || '',
            foto_url: r.foto_url || '',
            text: r.meldung || '',
            ursache: r.ursache || '',
            loesungsweg: r.loesungsweg || '',
            loesung_foto_url: r.loesung_foto_url || '',
            mergeCount: (!isNaN(parsedMergeCount) && parsedMergeCount >= 1) ? parsedMergeCount : 1
        };
    });

    feedbackDB = (dbFb || []).map(f => ({
        id: f.id,
        date: f.created_at,
        text: f.nachricht || '',
        email: f.email || '',
        foto: f.foto || ''
    }));

    partsOrdersDB = (dbPartsOrders || []).map(o => ({
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

    partsCatalogDB = (dbPartsCatalog || []).map(c => ({
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

    partsTagsDB = (dbPartsTags || []).map(t => ({
        id: t.id,
        name: t.name || ''
    }));

    accountsDB = dbAccounts || [];

    pinballs = (dbPins || []).map(p => {
        const designerNames = p.designer_id
            ? p.designer_id.map(id => dbDes?.find(d => d.designer_id == id)?.designer).filter(Boolean).join(', ')
            : 'Unbekannt';

        const isAktiv = p.aktiv === true;
        const rawImg = p.foto_url || p.foto || p.bild || '';

        const verifiedForPin = highscoresDB
            .filter(h => h.pinballId === p.id && h.verifiziert)
            .sort((a, b) => b.score - a.score);

        const topScoreStr = verifiedForPin.length > 0
            ? `${formatScore(verifiedForPin[0].score)} (${getFormattedPlayerDisplay(verifiedForPin[0].initials)})`
            : "Noch kein Rekord";

        const parsedMaxLen = (p.hs_max_length !== null && p.hs_max_length !== undefined && p.hs_max_length !== '')
            ? Number(p.hs_max_length)
            : 3;

        return {
            id: p.id,
            short: p.abbreviation || p.name.substring(0, 3).toUpperCase(),
            name: p.name,
            year: p['manufacture year'] || '-',
            maker: p.manufacturer || '-',
            designer: designerNames,
            prod: p.production || '-',
            score: topScoreStr,
            owner: "-",
            status: isAktiv ? "Spielbereit" : "Wartung (Inaktiv)",
            power: p.an ? "ON" : "OFF",
            desc: p['georgs text'] || "",
            isAktiv: isAktiv,
            imgUrl: getFlipperImageUrl(rawImg),
            hsMaxLength: !isNaN(parsedMaxLen) && parsedMaxLen >= 0 ? parsedMaxLen : 3,
            hsAllowNumbers: p.hs_allow_numbers === true,
            hsAllowSpecial: p.hs_allow_special === true
        };
    });

    saveStateToCache();
}

// --- CLIENTSEITIGE BILDKOMPRIMIERUNG VOR DEM UPLOAD ---

async function compressImageFile(file, maxDimension = 1600, quality = 0.78) {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;

    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                let width = img.width;
                let height = img.height;

                if (width > maxDimension || height > maxDimension) {
                    if (width >= height) {
                        height = Math.round((height * maxDimension) / width);
                        width = maxDimension;
                    } else {
                        width = Math.round((width * maxDimension) / height);
                        height = maxDimension;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob((blob) => {
                    if (!blob) { resolve(file); return; }
                    const baseName = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
                    const compressedFile = new File([blob], `${baseName}.jpg`, {
                        type: 'image/jpeg',
                        lastModified: Date.now()
                    });
                    resolve(compressedFile);
                }, 'image/jpeg', quality);
            };
            img.onerror = () => resolve(file);
            img.src = event.target.result;
        };
        reader.onerror = () => resolve(file);
        reader.readAsDataURL(file);
    });
}

async function uploadIncomingPhoto(folder, file) {
    if (!file) return '';
    const compressed = await compressImageFile(file, 1600, 0.78);
    const safeName = compressed.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = `${folder}/${Date.now()}_${safeName}`;
    const { error } = await db.storage.from('fotos-incoming').upload(filePath, compressed);
    if (error) throw error;
    return filePath;
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
        const desiredHtml = pin.imgUrl ? `<img src="${pin.imgUrl}" alt="${pin.name}">` : '';
        if (imgBox.innerHTML !== desiredHtml) imgBox.innerHTML = desiredHtml;
    }
}

async function togglePinballPower(pinballId, btnElement, onDone = null) {
    const targetPin = pinballs.find(p => p.id === pinballId);
    if (!targetPin) return;

    const canPowerOff = hasPerm('power_off');

    if (!canPowerOff && !targetPin.isAktiv) {
        showActionToast("Sicherheitssperre: Inaktive Flipper können nicht eingeschaltet werden!", "error");
        return;
    }

    if (!canPowerOff && !ensureWritePermission()) {
        return;
    }

    const isCurrentlyOn = targetPin.power === 'ON';
    if (isCurrentlyOn && !canPowerOff) {
        showActionToast(`„${targetPin.name}“ ist bereits eingeschaltet!`, "info");
        return;
    }

    const newState = !isCurrentlyOn;
    if (btnElement) {
        btnElement.disabled = true;
        btnElement.classList.add('btn-busy');
        btnElement.innerText = newState ? "⏳ Schalte ein..." : "⏳ Schalte aus...";
    }

    const { error } = await db.from('flipper').update({ an: newState }).eq('id', targetPin.id);
    if (error) {
        if (btnElement) {
            btnElement.disabled = false;
            btnElement.classList.remove('btn-busy');
        }
        showActionToast("Fehler beim Schalten: " + error.message, "error");
        if (typeof onDone === 'function') onDone(targetPin);
        return;
    }

    targetPin.power = newState ? 'ON' : 'OFF';
    saveStateToCache();

    if (newState) {
        showActionToast(`✓ Flipper „${targetPin.name}“ wurde erfolgreich eingeschaltet!`, "success");
    } else {
        showActionToast(`Flipper „${targetPin.name}“ wurde ausgeschaltet (OFF).`, "info");
    }

    if (typeof onDone === 'function') onDone(targetPin);
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
        box.innerHTML = `<span style="color:var(--status-red);">Fehler beim Laden: ${error ? error.message : 'Unbekannt'}</span>`;
        return;
    }

    box.dataset.loaded = 'true';
    const labelHtml = labelText ? `<div style="font-size:12px; font-weight:bold; color:var(--text-muted); margin-bottom:4px;">${labelText}:</div>` : '';
    box.innerHTML = `
        ${labelHtml}
        <a href="${data.signedUrl}" target="_blank" title="In voller Größe öffnen">
            <img src="${data.signedUrl}" style="max-width: 100%; max-height: 350px; border-radius: 6px; border: 1px solid var(--border-light); margin-top: 4px;">
        </a>
    `;
}

async function removeOldLowerPlayerScores(pinballId, playerInitials, keepScoreId, newScoreValue) {
    if (hasPerm('verify_highscores')) {
        const oldEntries = highscoresDB.filter(
            h => h.pinballId === pinballId &&
                 h.id !== keepScoreId &&
                 isSamePlayerIdentity(h.initials, playerInitials) &&
                 h.score <= newScoreValue
        );
        for (const oldEntry of oldEntries) {
            if (oldEntry.beweisfoto) {
                await db.storage.from('fotos-incoming').remove([oldEntry.beweisfoto]);
            }
            await db.from('highscore').delete().eq('id', oldEntry.id);
        }
    } else if (hasPerm('auto_verify_highscores') && keepScoreId) {
        await db.rpc('cleanup_lower_scores_for_entry', { p_keep_id: keepScoreId });
    }
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}
