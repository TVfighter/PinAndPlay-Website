// 1. Tages-Token aus QR-Code-Scan (?token=...) sofort auslesen und speichern
const DAILY_TOKEN_KEY = 'pinplay_daily_token';
(function captureQrTokenFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const scannedToken = params.get('token');
    if (scannedToken && scannedToken.trim() !== '') {
        localStorage.setItem(DAILY_TOKEN_KEY, scannedToken.trim().toUpperCase());
        params.delete('token');
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

// Ziel-URL für das Pin&Play-Logo (Offizielle Homepage)
const OFFICIAL_HOMEPAGE_URL = 'index.html';

// Schlüssel für den dauerhaften Browser-Speicher
const CACHE_KEY_STATE = 'pinplay_full_data_cache_v5';
const CACHE_TTL_MS = 5 * 60 * 1000;

// Globale Variablen
let pinballs = [];
let reportsDB = [];
let highscoresDB = [];
let feedbackDB = [];
let playersDB = [];
let isLoggedIn = false;
let isTechMode = false;
let hasValidDailyToken = false;

function formatScore(num) {
    return Number(num || 0).toLocaleString('de-DE');
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
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed;
    }
    const { data } = db.storage.from('flipper-fotos').getPublicUrl(trimmed);
    return data ? data.publicUrl : null;
}

function normalizeReportStatus(rawStatus) {
    if (!rawStatus) return 'offen';
    const lower = String(rawStatus).trim().toLowerCase();
    if (lower === 'behoben' || lower === 'erledigt' || lower === 'geschlossen') {
        return 'behoben';
    }
    return 'offen';
}

function getStatusColorClass(status) {
    if (status.includes("Defekt")) return "status-rot";
    if (status.includes("Wartung") || status.includes("Eingeschränkt")) return "status-orange";
    return "status-grün";
}

function stylePowerButton(btnElement, powerState) {
    if (!btnElement) return;
    btnElement.style.display = 'inline-block';
    btnElement.innerText = powerState;
    btnElement.style.backgroundColor = powerState === 'ON' ? '#16261b' : '#3b1818';
    btnElement.style.color = powerState === 'ON' ? '#3fb950' : '#ff7b72';
    btnElement.style.borderColor = powerState === 'ON' ? '#2ea043' : '#cf3432';
}

// Prüft vor dem Eintragen (Highscore, Defekt, Feedback), ob ein gültiger Tages-QR-Code gescannt wurde
function ensureWritePermission() {
    if (isLoggedIn || isTechMode || hasValidDailyToken) {
        return true;
    }
    alert("Zugangssperre: Um Highscores, Defekte oder Feedback einzureichen, scanne bitte zuerst den aktuellen Tages-QR-Code vor Ort im Pin&Play!");
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

// Ermittelt den genauen Namen, den ein Spielerprofil an einem bestimmten Flipper nutzt
function getProfileNameForPinball(prof, pin) {
    if (!prof || !pin) return '';
    const effectiveMaxLen = pin.hsMaxLength === 0 ? 3 : pin.hsMaxLength;

    // 1. Alle Flipper mit max. 3 Zeichen (inkl. 0) nutzen immer das 3er-Standardkürzel
    if (effectiveMaxLen <= 3) {
        return (prof.shortInitials || prof.displayName).toUpperCase().substring(0, 3);
    }

    // 2. Bei längeren Namen (z.B. Stern vs. JJP): Prüfen, ob für diesen Flipper ein eigener Name hinterlegt ist
    const customForPin = prof.flipperTags ? prof.flipperTags[String(pin.id)] : null;
    if (customForPin && String(customForPin).trim() !== '') {
        return String(customForPin).trim().toUpperCase().substring(0, effectiveMaxLen);
    }

    // 3. Fallback für lange Flipper ohne Sondereintrag: Haupt-Anzeigename
    return prof.displayName.toUpperCase().substring(0, effectiveMaxLen);
}

function getFormattedPlayerDisplay(rawInitials) {
    const prof = resolvePlayerProfile(rawInitials);
    if (!prof) return rawInitials;
    const upperRaw = String(rawInitials).trim().toUpperCase();
    if (upperRaw === prof.displayName.toUpperCase()) {
        return prof.displayName;
    }
    return `${upperRaw} (${prof.displayName})`;
}

// Ermittelt, welcher Haupt-Tab oben im Banner gerade aktiv ist
function getActiveNavTab() {
    const path = window.location.pathname;
    if (path.endsWith('highscores.html') || path.endsWith('/highscores')) return 'highscores';
    if (path.endsWith('tech-feedback.html') || path.endsWith('/tech-feedback')) return 'tech-feedback';
    if (path.endsWith('tech-players.html') || path.endsWith('/tech-players')) return 'tech-players';
    return 'overview';
}

function renderSharedHeader() {
    const header = document.getElementById('main-header');
    if (!header) return;

    if (isTechMode) header.classList.add('tech-mode');
    else header.classList.remove('tech-mode');

    const activeTab = getActiveNavTab();
    const overviewClass = activeTab === 'overview' ? 'btn-nav-page btn-nav-active' : 'btn-nav-page';
    const highscoresClass = activeTab === 'highscores' ? 'btn-nav-page btn-nav-active' : 'btn-nav-page';
    const techFeedbackClass = activeTab === 'tech-feedback' ? 'btn-nav-page btn-nav-active' : 'btn-nav-page';
    const techPlayersClass = activeTab === 'tech-players' ? 'btn-nav-page btn-nav-active' : 'btn-nav-page';

    const fbCountSuffix = feedbackDB.length > 0 ? ` (${feedbackDB.length})` : '';
    const techExtraBtnsHtml = (isLoggedIn && isTechMode)
        ? `
            <button class="${techPlayersClass}" onclick="window.location.href='tech-players.html'">Kürzel &amp; QR-Code</button>
            <button class="${techFeedbackClass}" onclick="window.location.href='tech-feedback.html'">Spieler-Feedback${fbCountSuffix}</button>
        `
        : '';

    header.innerHTML = `
        <a href="${OFFICIAL_HOMEPAGE_URL}" class="logo" title="Zur offiziellen Pin&Play Homepage">
            <img src="logo.png" alt="Pin & Play Retro Gaming" class="logo-img">
        </a>
        <div class="quick-actions">
            <button class="${overviewClass}" onclick="goHome()">Flipper Übersicht</button>
            <button class="${highscoresClass}" onclick="window.location.href='highscores.html'">Highscores</button>
            ${techExtraBtnsHtml}
            <button class="btn-nav-page" onclick="toggleTechMode()" id="tech-toggle" style="display: ${isLoggedIn ? 'inline-block' : 'none'};">
                Techniker Modus: ${isTechMode ? 'AN' : 'AUS'}
            </button>
            <button class="btn-nav-util ${isLoggedIn ? '' : 'hidden'}" onclick="doLogout()" id="logout-btn">Logout</button>
        </div>
    `;
}

function ensureLoginModalExists() {
    if (document.getElementById('global-login-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'global-login-modal';
    modal.className = 'modal-overlay hidden';
    modal.innerHTML = `
        <div class="modal-box" style="max-width: 400px;">
            <div class="detail-header">
                <h2 style="margin: 0;">Techniker Login</h2>
                <button class="btn-switch" onclick="closeLoginModal()">Schließen</button>
            </div>
            <div class="report-form">
                <label><strong>Benutzerkennung (E-Mail)</strong></label>
                <input type="email" id="login-email" placeholder="techniker@pinplay.lokal">
                <label><strong>Passwort</strong></label>
                <input type="password" id="login-pwd">
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
            localStorage.setItem('pinplay_tech_mode', 'true');
            window.location.href = 'techniker.html';
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

async function doLogin() {
    const email = document.getElementById('login-email').value;
    const pwd = document.getElementById('login-pwd').value;
    const errDisplay = document.getElementById('login-error');

    const { error } = await db.auth.signInWithPassword({ email, password: pwd });
    if (error) {
        errDisplay.innerText = "Login fehlgeschlagen: " + error.message;
        errDisplay.style.display = 'block';
    } else {
        errDisplay.style.display = 'none';
        window.location.hash = '';
        localStorage.setItem('pinplay_logged_in', 'true');
        localStorage.setItem('pinplay_tech_mode', 'true');
        localStorage.removeItem(CACHE_KEY_STATE);
        window.location.href = 'techniker.html';
    }
}

async function doLogout() {
    if (!confirm("Möchtest du dich wirklich ausloggen?")) return;
    await db.auth.signOut();
    localStorage.removeItem('pinplay_tech_mode');
    localStorage.removeItem('pinplay_logged_in');
    localStorage.removeItem(CACHE_KEY_STATE);
    window.location.href = 'index.html';
}

function goHome() {
    if (isTechMode) window.location.href = 'techniker.html';
    else window.location.href = 'index.html';
}

function toggleTechMode() {
    if (!isLoggedIn) return;
    isTechMode = !isTechMode;
    localStorage.setItem('pinplay_tech_mode', isTechMode ? 'true' : 'false');

    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const fromSuffix = params.get('from') ? `&from=${params.get('from')}` : '';

    if (isTechMode) {
        if ((path.endsWith('detail.html') || path.endsWith('/detail')) && id) {
            window.location.href = `tech-detail.html?id=${id}${fromSuffix}`;
        } else if (path.endsWith('highscores.html') || path.endsWith('/highscores')) {
            window.location.reload();
        } else {
            window.location.href = 'techniker.html';
        }
    } else {
        if ((path.endsWith('tech-detail.html') || path.endsWith('/tech-detail')) && id) {
            window.location.href = `detail.html?id=${id}${fromSuffix}`;
        } else if (path.endsWith('highscores.html') || path.endsWith('/highscores')) {
            window.location.reload();
        } else {
            window.location.href = 'index.html';
        }
    }
}

window.addEventListener('hashchange', checkHashLogin);

function saveStateToCache() {
    try {
        localStorage.setItem(CACHE_KEY_STATE, JSON.stringify({
            pinballs,
            reportsDB,
            highscoresDB,
            feedbackDB,
            playersDB,
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
            hasValidDailyToken = parsed.hasValidDailyToken === true;
            const age = Date.now() - (parsed.timestamp || 0);
            return { loaded: true, isFresh: age < CACHE_TTL_MS };
        }
    } catch (e) {}
    return { loaded: false, isFresh: false };
}

async function verifyDailyTokenStatus() {
    if (isLoggedIn) {
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

async function initSharedApp(onBackgroundUpdate = null) {
    isLoggedIn = localStorage.getItem('pinplay_logged_in') === 'true';
    isTechMode = isLoggedIn && localStorage.getItem('pinplay_tech_mode') === 'true';
    const cacheStatus = restoreStateFromCache();
    renderSharedHeader();
    checkHashLogin();

    if (cacheStatus.loaded) {
        verifyDailyTokenStatus();
        if (!cacheStatus.isFresh) {
            (async () => {
                await syncSessionInBackground();
                await loadAllDatabaseData();
                renderSharedHeader();
                if (typeof onBackgroundUpdate === 'function') onBackgroundUpdate();
            })();
        } else {
            syncSessionInBackground();
        }
        return;
    }

    await syncSessionInBackground();
    await verifyDailyTokenStatus();
    await loadAllDatabaseData();
    renderSharedHeader();
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
                feedbackDB = [];
            } else {
                localStorage.setItem('pinplay_logged_in', 'true');
                hasValidDailyToken = true;
            }
            renderSharedHeader();
        }
    } catch (e) {}
}

async function loadAllDatabaseData() {
    const queries = [
        db.from('flipper').select('*').order('name', { ascending: true }),
        db.from('designer').select('*'),
        db.from('highscore').select('*').order('score', { ascending: false }),
        db.from('players').select('*').order('display_name', { ascending: true })
    ];

    if (isLoggedIn) {
        queries.push(db.from('reports').select('*'));
        queries.push(db.from('feedback').select('*').order('created_at', { ascending: false }));
    }

    const results = await Promise.all(queries);
    const dbPins = results[0].data;
    const dbDes = results[1].data;
    const dbHs = results[2].data;
    const dbPlayers = results[3] && !results[3].error ? results[3].data : [];
    const dbReps = (isLoggedIn && results[4]) ? results[4].data : [];
    const dbFb = (isLoggedIn && results[5]) ? results[5].data : [];

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
            loesung_foto_url: r.loesung_foto_url || ''
        };
    });

    if (isLoggedIn) {
        feedbackDB = (dbFb || []).map(f => ({
            id: f.id,
            date: f.created_at,
            text: f.nachricht || '',
            email: f.email || '',
            foto: f.foto || ''
        }));
    }

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

async function uploadIncomingPhoto(folder, file) {
    if (!file) return '';
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = `${folder}/${Date.now()}_${safeName}`;
    const { error } = await db.storage.from('fotos-incoming').upload(filePath, file);
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
        if (imgBox.innerHTML !== desiredHtml) {
            imgBox.innerHTML = desiredHtml;
        }
    }
}

async function togglePinballPower(pinballId, btnElement, onDone = null) {
    const targetPin = pinballs.find(p => p.id === pinballId);
    if (!targetPin) return;

    if (!isTechMode && !targetPin.isAktiv) {
        alert("Sicherheitssperre: Inaktive Flipper können nicht eingeschaltet werden!");
        return;
    }

    if (!isTechMode && !ensureWritePermission()) {
        return;
    }

    const isCurrentlyOn = targetPin.power === 'ON';
    if (isCurrentlyOn && !isTechMode) {
        alert("Sicherheitssperre: Nur Techniker dürfen Flipper wieder ausschalten!");
        return;
    }

    const newState = !isCurrentlyOn;
    if (btnElement) btnElement.innerText = "...";

    const { error } = await db.from('flipper').update({ an: newState }).eq('id', targetPin.id);
    if (error) {
        alert("Fehler beim Speichern: " + error.message);
        if (typeof onDone === 'function') onDone(targetPin);
        return;
    }

    targetPin.power = newState ? 'ON' : 'OFF';
    saveStateToCache();
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
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}
