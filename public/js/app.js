// ============================================
// AlphaSignal Pro - Frontend Application
// 100% Client-Side (GitHub Pages compatible)
// ============================================

// ==================== FIREBASE CONFIG ====================
const firebaseConfig = {
    apiKey: "AIzaSyC0vTDfbIwPKUvSH9L_ArwhYS0H48Gt5Yo",
    authDomain: "alphasignal-pro.firebaseapp.com",
    projectId: "alphasignal-pro",
    storageBucket: "alphasignal-pro.firebasestorage.app",
    messagingSenderId: "1038193993643",
    appId: "1:1038193993643:web:383bf3b8911e1df3f114ee",
    measurementId: "G-EEGG4KT63V"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ==================== CONFIG ====================
const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';
const BINANCE_API = 'https://api.binance.com/api/v3';
const SYMBOLS = [
    'btcusdt', 'ethusdt', 'bnbusdt', 'solusdt', 'xrpusdt',
    'dogeusdt', 'adausdt', 'avaxusdt', 'dotusdt', 'maticusdt',
    'linkusdt', 'atomusdt', 'ltcusdt', 'nearusdt', 'aptusdt',
    'filusdt', 'arbusdt', 'opusdt', 'injusdt', 'suiusdt'
];
let KLINE_INTERVAL = '1m';
const ADMIN_EMAIL = 'f1098749586@gmail.com';

// ==================== STATE ====================
let binanceWs = null;
let isPresent = true;
let signals = [];
let prices = {};
let priceHistory = {};
let countdownIntervals = {};
let reconnectAttempts = 0;
let todaySignalCount = 0;
let alertAudio = null;
let signalEngine = null;

// ==================== INIT ====================
let isAdmin = false;
let allUsers = [];

auth.onAuthStateChanged(async (user) => {
    if (user) {
        isAdmin = (user.email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase();
        console.log('👤 User:', user.email, '| Admin:', isAdmin, '| UID:', user.uid);

        // Ensure admin has a user document in Firestore
        if (isAdmin) {
            try {
                const adminDoc = await db.collection('users').doc(user.uid).get();
                if (!adminDoc.exists) {
                    await db.collection('users').doc(user.uid).set({
                        email: user.email,
                        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                        plan: 'premium',
                        active: true,
                        role: 'admin'
                    });
                    console.log('👑 Admin document created in Firestore');
                }
            } catch (e) { console.error('Error creating admin doc:', e); }
        }

        // Check if user is approved (admin always approved)
        if (!isAdmin) {
            try {
                const userDoc = await db.collection('users').doc(user.uid).get();
                const data = userDoc.exists ? userDoc.data() : null;
                
                // Block if: no document, active is false, active is 'blocked', or active is not exactly true
                if (!data || data.active !== true) {
                    let msg = 'Tu cuenta está pendiente de aprobación por el administrador.';
                    if (data && data.active === 'blocked') {
                        msg = 'Tu cuenta ha sido bloqueada. Contacta al administrador.';
                    }
                    await auth.signOut();
                    const errorEl = document.getElementById('loginError');
                    errorEl.textContent = msg;
                    errorEl.classList.remove('hidden');
                    console.log('🚫 Acceso denegado:', user.email, '| active:', data?.active);
                    return;
                }
                console.log('✅ Usuario aprobado:', user.email);
            } catch (e) {
                console.error('Error checking user status:', e);
                // If we can't verify, block access for safety
                await auth.signOut();
                const errorEl = document.getElementById('loginError');
                errorEl.textContent = 'Error al verificar tu cuenta. Intenta de nuevo.';
                errorEl.classList.remove('hidden');
                return;
            }
        }

        showDashboard();
        await loadUserConfig();
        applyFavoritesToEngine();
        connectWebSocket();
        initAudio();
        requestNotificationPermission();
        await loadSignalsFromFirestore();
        await loadTrackRecordFromFirestore();
        verifyPendingSignals(); // Check old unverified signals immediately
        await loadLessonsFromFirestore();
        await loadAutoTradingState();

        // Show admin tab if admin + run cleanup
        if (isAdmin) {
            const adminTab = document.getElementById('tab-admin');
            if (adminTab) adminTab.classList.remove('hidden');
            console.log('👑 Admin tab visible');
            cleanupOldSignals();
        }
        cleanupOldTrackRecord();
    } else {
        showLogin();
        isAdmin = false;
        const adminTab = document.getElementById('tab-admin');
        if (adminTab) adminTab.classList.add('hidden');
    }
});

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// ==================== AUTH ====================
function showLogin() {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('dashboard').classList.add('hidden');
}

function showDashboard() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
}

async function handleLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');

    if (!email || !password) {
        errorEl.textContent = 'Ingresa correo y contraseña';
        errorEl.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando...';
    errorEl.classList.add('hidden');

    try {
        await auth.signInWithEmailAndPassword(email, password);
        showToast('¡Bienvenido a AlphaSignal Pro!', 'success');
    } catch (error) {
        let msg = 'Error de autenticación';
        if (error.code === 'auth/user-not-found') msg = 'Usuario no encontrado';
        else if (error.code === 'auth/wrong-password') msg = 'Contraseña incorrecta';
        else if (error.code === 'auth/invalid-email') msg = 'Correo inválido';
        else if (error.code === 'auth/too-many-requests') msg = 'Demasiados intentos. Espera un momento.';
        else if (error.code === 'auth/invalid-credential') msg = 'Correo o contraseña incorrectos';
        
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Acceder al Dashboard';
    }
}

// ==================== USER REGISTRATION ====================
let isRegistering = false;

function toggleRegisterMode() {
    isRegistering = !isRegistering;
    const btn = document.getElementById('loginBtn');
    const toggleLink = document.getElementById('toggleAuthMode');
    const title = document.getElementById('authTitle');
    const subtitle = document.getElementById('authSubtitle');

    if (isRegistering) {
        btn.innerHTML = '<i class="fas fa-user-plus"></i> Crear Cuenta';
        btn.setAttribute('onclick', 'handleRegister()');
        toggleLink.innerHTML = '¿Ya tienes cuenta? <span class="text-[#00ff41] cursor-pointer">Inicia sesión</span>';
        if (title) title.textContent = 'Crear Cuenta';
        if (subtitle) subtitle.textContent = 'Regístrate para acceder al dashboard';
    } else {
        btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Acceder al Dashboard';
        btn.setAttribute('onclick', 'handleLogin()');
        toggleLink.innerHTML = '¿No tienes cuenta? <span class="text-[#00ff41] cursor-pointer">Regístrate</span>';
        if (title) title.textContent = 'AlphaSignal Pro';
        if (subtitle) subtitle.textContent = 'Ingresa tus credenciales';
    }
}

async function handleRegister() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');

    if (!email || !password) {
        errorEl.textContent = 'Ingresa correo y contraseña';
        errorEl.classList.remove('hidden');
        return;
    }

    if (password.length < 6) {
        errorEl.textContent = 'La contraseña debe tener mínimo 6 caracteres';
        errorEl.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creando cuenta...';
    errorEl.classList.add('hidden');

    try {
        const cred = await auth.createUserWithEmailAndPassword(email, password);
        // Save user profile to Firestore - pending approval
        await db.collection('users').doc(cred.user.uid).set({
            email: email,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            plan: 'free',
            active: false
        });
        // Sign out immediately - needs admin approval
        await auth.signOut();
        const errorEl = document.getElementById('loginError');
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
        showToast('🎉 Cuenta creada. El administrador debe aprobarla para que puedas ingresar.', 'warning');
    } catch (error) {
        let msg = 'Error al crear cuenta';
        if (error.code === 'auth/email-already-in-use') msg = 'Este correo ya tiene una cuenta';
        else if (error.code === 'auth/weak-password') msg = 'La contraseña es muy débil (mínimo 6 caracteres)';
        else if (error.code === 'auth/invalid-email') msg = 'Correo inválido';
        
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-user-plus"></i> Crear Cuenta';
    }
}

function handleLogout() {
    if (binanceWs) binanceWs.close();
    auth.signOut();
    showToast('Sesión cerrada', 'info');
}

function togglePasswordVisibility() {
    const input = document.getElementById('loginPassword');
    const icon = document.getElementById('passToggleIcon');
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}

// Enter key login
document.getElementById('loginPassword')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
});

// ==================== BINANCE WEBSOCKET (Direct from Browser) ====================
function connectWebSocket() {
    signalEngine = new SignalEngine();
    SYMBOLS.forEach(s => { priceHistory[s] = []; prices[s] = { price: 0, change24h: 0 }; });

    // Fetch initial 24h ticker data
    fetch24hTickers();

    // Load historical klines for signal engine
    loadHistoricalKlines();

    const streams = SYMBOLS.map(s => `${s}@kline_${KLINE_INTERVAL}/${s}@miniTicker`).join('/');
    const wsUrl = `${BINANCE_WS_BASE}/${streams}`;

    console.log('🔌 Conectando a Binance WebSocket...');
    binanceWs = new WebSocket(wsUrl);

    binanceWs.onopen = () => {
        console.log('✅ Conectado a Binance');
        reconnectAttempts = 0;
        updateConnectionStatus(true);
    };

    binanceWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'kline') handleKline(data);
            else if (data.e === '24hrMiniTicker') handleMiniTicker(data);
        } catch (e) {}
    };

    binanceWs.onclose = () => {
        console.log('❌ Binance WS desconectado');
        updateConnectionStatus(false);
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts++;
        setTimeout(connectWebSocket, delay);
    };

    binanceWs.onerror = () => console.error('⚠️ Binance WS error');

    // Expiration checker
    setInterval(() => {
        let changed = false;
        signals.forEach(s => {
            if (!s.expired && (Date.now() - s.timestamp) > 120000) { s.expired = true; changed = true; }
        });
        if (changed) { renderSignals(); updateStats(); }
    }, 5000);

    // Latency ping
    setInterval(() => {
        const start = Date.now();
        fetch(`${BINANCE_API}/ping`).then(() => {
            const ms = Date.now() - start;
            document.getElementById('latencyDisplay').innerHTML = `${ms}<span class="text-sm text-gray-500">ms</span>`;
        }).catch(() => {});
    }, 15000);
}

async function fetch24hTickers() {
    try {
        const resp = await fetch(`${BINANCE_API}/ticker/24hr?symbols=${JSON.stringify(SYMBOLS.map(s => s.toUpperCase()))}`);
        const data = await resp.json();
        data.forEach(t => {
            const sym = t.symbol.toLowerCase();
            if (prices[sym]) {
                prices[sym].price = parseFloat(t.lastPrice);
                prices[sym].change24h = parseFloat(t.priceChangePercent);
                prices[sym].high24h = parseFloat(t.highPrice);
                prices[sym].low24h = parseFloat(t.lowPrice);
                prices[sym].volume24h = parseFloat(t.volume);
            }
        });
        renderPrices();
    } catch (e) {
        console.error('Error fetching 24h tickers:', e);
        // Render empty grid anyway
        renderPrices();
    }
}

async function loadHistoricalKlines() {
    for (const symbol of SYMBOLS) {
        try {
            const resp = await fetch(`${BINANCE_API}/klines?symbol=${symbol.toUpperCase()}&interval=${KLINE_INTERVAL}&limit=50`);
            const data = await resp.json();
            priceHistory[symbol] = data.map(k => ({
                time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
                low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
            }));
        } catch (e) {
            console.error(`Error loading klines for ${symbol}:`, e);
        }
    }
    console.log('📊 Datos históricos cargados para análisis');
}

function handleKline(data) {
    const symbol = data.s.toLowerCase();
    const k = data.k;
    const close = parseFloat(k.c);
    const high = parseFloat(k.h);
    const low = parseFloat(k.l);
    const volume = parseFloat(k.v);
    const isClosed = k.x;

    // Update live price
    const prevPrice = prices[symbol]?.price || close;
    if (!prices[symbol]) prices[symbol] = {};
    prices[symbol].price = close;

    updatePriceDOM(symbol, close, prevPrice);

    if (isClosed) {
        if (!priceHistory[symbol]) priceHistory[symbol] = [];
        priceHistory[symbol].push({ close, high, low, volume, time: k.t, open: parseFloat(k.o) });
        if (priceHistory[symbol].length > 100) priceHistory[symbol] = priceHistory[symbol].slice(-100);

        // Run signal analysis
        if (priceHistory[symbol].length >= 50 && signalEngine) {
            const signal = signalEngine.analyze(symbol, priceHistory[symbol]);
            if (signal) {
                handleNewSignal(signal);
                console.log(`🚀 SEÑAL: ${signal.direction} ${signal.symbol} @ ${signal.price} | Fuerza: ${signal.strength.value}%`);
            }
        }
    }
}

function handleMiniTicker(data) {
    const symbol = data.s.toLowerCase();
    if (prices[symbol]) {
        const openPrice = parseFloat(data.o);
        const closePrice = parseFloat(data.c);
        prices[symbol].change24h = openPrice > 0 ? ((closePrice - openPrice) / openPrice) * 100 : 0;

        const changeEl = document.querySelector(`#price-${symbol} .price-change`);
        if (changeEl) {
            const change = prices[symbol].change24h;
            changeEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
            changeEl.className = `price-change text-xs font-mono ${change >= 0 ? 'text-[#00ff41]' : 'text-red-400'}`;
        }
    }
}

function updatePriceDOM(symbol, price, prevPrice) {
    const el = document.getElementById(`price-${symbol}`);
    if (!el) return;

    const valueEl = el.querySelector('.price-value');
    if (valueEl) {
        valueEl.textContent = formatPrice(price);
        el.classList.remove('price-flash-up', 'price-flash-down');
        if (price > prevPrice) {
            el.classList.add('price-flash-up');
            valueEl.className = 'price-value text-lg font-bold font-mono price-up';
        } else if (price < prevPrice) {
            el.classList.add('price-flash-down');
            valueEl.className = 'price-value text-lg font-bold font-mono price-down';
        }
        setTimeout(() => el.classList.remove('price-flash-up', 'price-flash-down'), 300);
    }
}

function updateConnectionStatus(connected) {
    const dot = document.getElementById('connectionDot');
    const text = document.getElementById('connectionText');

    if (connected) {
        dot.className = 'w-2 h-2 rounded-full bg-[#00ff41] animate-pulse';
        text.textContent = 'Conectado';
        text.className = 'text-[10px] text-[#00ff41] font-mono';
    } else {
        dot.className = 'w-2 h-2 rounded-full bg-red-500 animate-pulse';
        text.textContent = 'Desconectado';
        text.className = 'text-[10px] text-red-400 font-mono';
    }
}

// ==================== PRICES ====================
function renderPrices() {
    const grid = document.getElementById('priceGrid');
    const symbolNames = {
        btcusdt: { name: 'BTC', full: 'Bitcoin', icon: '₿' },
        ethusdt: { name: 'ETH', full: 'Ethereum', icon: 'Ξ' },
        bnbusdt: { name: 'BNB', full: 'BNB Chain', icon: '◆' },
        solusdt: { name: 'SOL', full: 'Solana', icon: '◎' },
        xrpusdt: { name: 'XRP', full: 'Ripple', icon: '✕' },
        dogeusdt: { name: 'DOGE', full: 'Dogecoin', icon: 'Ð' },
        adausdt: { name: 'ADA', full: 'Cardano', icon: '₳' },
        avaxusdt: { name: 'AVAX', full: 'Avalanche', icon: '▲' }
    };

    grid.innerHTML = Object.keys(prices).map(symbol => {
        const info = symbolNames[symbol] || { name: symbol.replace('usdt', '').toUpperCase(), full: symbol, icon: '●' };
        const p = prices[symbol];
        const change = p.change24h || 0;
        const priceDisplay = formatPrice(p.price || 0);

        return `
            <div id="price-${symbol}" class="price-card glass-card rounded-lg p-3 cursor-pointer hover:border-gray-600/50 transition">
                <div class="flex items-center justify-between mb-1">
                    <div class="flex items-center gap-2">
                        <span class="text-gray-500 text-xs font-mono">${info.icon}</span>
                        <span class="text-white text-sm font-semibold">${info.name}</span>
                    </div>
                    <span class="price-change text-xs font-mono ${change >= 0 ? 'text-[#00ff41]' : 'text-red-400'}">
                        ${change >= 0 ? '+' : ''}${change.toFixed(2)}%
                    </span>
                </div>
                <p class="price-value text-lg font-bold font-mono ${change >= 0 ? 'price-up' : 'price-down'}">
                    ${priceDisplay}
                </p>
                <p class="text-[10px] text-gray-600 font-mono mt-0.5">${info.full}/USDT</p>
            </div>
        `;
    }).join('');
}

function formatPrice(price) {
    if (price >= 1000) return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 1) return '$' + price.toFixed(4);
    return '$' + price.toFixed(6);
}

// ==================== SIGNALS ====================
function handleNewSignal(signal) {
    // Duplicate check: skip if same symbol+direction exists within 60s
    const isDuplicate = signals.some(s =>
        s.symbol === signal.symbol &&
        s.direction === signal.direction &&
        Math.abs((s.timestamp || 0) - (signal.timestamp || Date.now())) < 60000
    );
    if (isDuplicate) return;

    signals.unshift(signal);
    if (signals.length > 50) signals = signals.slice(0, 50);

    todaySignalCount++;
    renderSignals();
    updateStats();
    updateRiskSemaphore(signal);
    saveSignalToFirestore(signal);

    // ALWAYS play sound and send notification (even in other tabs)
    playAlertSound(signal);
    sendBrowserNotification(signal);

    if (isPresent) {
        triggerVisualAlert(signal);
    }
    showToast(`📡 Señal ${signal.direction}: ${signal.symbol} @ ${formatPrice(signal.price)}`, signal.direction === 'BUY' ? 'success' : 'error');

    // Add to history
    addToHistory(signal);

    // Auto Trading: execute paper trade if enabled
    paperTradeSignal(signal);
}

function renderSignals() {
    const list = document.getElementById('signalsList');
    const activeSignals = signals.filter(s => !s.expired);
    const expiredSignals = signals.filter(s => s.expired).slice(0, 5);

    document.getElementById('activeSignalsCount').textContent = activeSignals.length;

    if (signals.length === 0) {
        list.innerHTML = `
            <div class="text-center py-12">
                <i class="fas fa-satellite-dish text-gray-700 text-4xl mb-3"></i>
                <p class="text-gray-600 text-sm">Esperando señales del mercado...</p>
                <p class="text-gray-700 text-xs mt-1">Las señales aparecerán aquí cuando el motor detecte oportunidades</p>
            </div>`;
        return;
    }

    list.innerHTML = [
        ...activeSignals.map(s => renderSignalCard(s, false)),
        ...expiredSignals.map(s => renderSignalCard(s, true))
    ].join('');

    // Start countdown timers for active signals
    activeSignals.forEach(s => startCountdown(s));
}

function renderSignalCard(signal, expired) {
    const isBuy = signal.direction === 'BUY';
    const elapsed = Math.floor((Date.now() - signal.timestamp) / 1000);
    const remaining = Math.max(0, 120 - elapsed);
    const progress = Math.max(0, (remaining / 120) * 100);

    let timerClass = 'countdown-fresh';
    if (remaining < 30) timerClass = 'countdown-hot';
    else if (remaining < 60) timerClass = 'countdown-warm';
    if (expired || remaining === 0) timerClass = 'countdown-expired';

    const riskColors = {
        green: { bg: 'bg-green-500/20', text: 'text-green-400', label: '🟢 Seguro' },
        yellow: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', label: '🟡 Precaución' },
        red: { bg: 'bg-red-500/20', text: 'text-red-400', label: '🔴 Peligro' }
    };
    const risk = riskColors[signal.riskLevel] || riskColors.yellow;

    return `
        <div class="signal-card ${isBuy ? 'buy' : 'sell'} ${expired ? 'expired' : ''} glass-card rounded-xl p-4" id="signal-${signal.id}">
            <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                    <span class="px-2.5 py-1 rounded-lg text-xs font-bold ${isBuy ? 'bg-[#00ff41]/15 text-[#00ff41]' : 'bg-red-500/15 text-red-400'}">
                        <i class="fas fa-${isBuy ? 'arrow-up' : 'arrow-down'} mr-1"></i>${signal.direction}
                    </span>
                    <span class="text-white font-bold text-sm">${signal.symbol}</span>
                    <span class="px-2 py-0.5 rounded-full text-[10px] ${risk.bg} ${risk.text}">${risk.label}</span>
                </div>
                <div class="text-right">
                    <p class="text-white font-bold font-mono text-sm">${formatPrice(signal.price)}</p>
                    ${expired ? '<span class="text-[10px] text-gray-600">EXPIRADA</span>' : `<span class="text-[10px] text-gray-500 font-mono" id="timer-${signal.id}">${formatTime(remaining)}</span>`}
                </div>
            </div>

            <!-- Countdown bar -->
            <div class="countdown-bar bg-gray-800 rounded-full mb-3" style="height: 3px">
                <div class="${timerClass} rounded-full" style="width: ${progress}%; height: 100%; transition: width 1s linear" id="bar-${signal.id}"></div>
            </div>

            <!-- Indicators -->
            <div class="grid grid-cols-4 gap-2 mb-2">
                <div class="text-center">
                    <p class="text-[10px] text-gray-600 uppercase">RSI</p>
                    <p class="text-xs font-mono ${signal.rsi < 30 ? 'text-[#00ff41]' : signal.rsi > 70 ? 'text-red-400' : 'text-gray-300'}">${signal.rsi}</p>
                </div>
                <div class="text-center">
                    <p class="text-[10px] text-gray-600 uppercase">EMA 9</p>
                    <p class="text-xs font-mono text-gray-300">${formatPrice(signal.ema9)}</p>
                </div>
                <div class="text-center">
                    <p class="text-[10px] text-gray-600 uppercase">EMA 21</p>
                    <p class="text-xs font-mono text-gray-300">${formatPrice(signal.ema21)}</p>
                </div>
                <div class="text-center">
                    <p class="text-[10px] text-gray-600 uppercase">Vol</p>
                    <p class="text-xs font-mono ${signal.volumeSpike ? 'text-amber-400' : 'text-gray-300'}">${signal.volume}x</p>
                </div>
            </div>

            <!-- Strength bar -->
            <div class="flex items-center gap-2 mb-2">
                <span class="text-[10px] text-gray-600">Fuerza:</span>
                <div class="strength-bar flex-1">
                    <div class="strength-fill ${isBuy ? 'bg-[#00ff41]' : 'bg-red-500'}" style="width: ${signal.strength.value}%"></div>
                </div>
                <span class="text-[10px] font-mono ${signal.strength.value >= 70 ? 'text-[#00ff41]' : signal.strength.value >= 40 ? 'text-amber-400' : 'text-red-400'}">${signal.strength.value}%</span>
            </div>

            <!-- ELI5 Reasons -->
            ${signal.eli5Reasons && signal.eli5Reasons.length > 0 ? `
                <div class="mt-2 pt-2 border-t border-gray-800/50">
                    <p class="text-[10px] text-gray-600 mb-1"><i class="fas fa-lightbulb text-amber-500 mr-1"></i>¿Qué significa?</p>
                    ${signal.eli5Reasons.map(r => `<p class="text-[11px] text-gray-400 leading-relaxed">${r}</p>`).join('')}
                </div>
            ` : ''}

            <!-- Support/Resistance -->
            <div class="flex items-center gap-4 mt-2 pt-2 border-t border-gray-800/50 text-[10px]">
                <span class="text-gray-600"><i class="fas fa-level-down-alt text-[#00ff41] mr-1"></i>Soporte: <span class="text-gray-400 font-mono">${formatPrice(signal.support)}</span></span>
                <span class="text-gray-600"><i class="fas fa-level-up-alt text-red-400 mr-1"></i>Resistencia: <span class="text-gray-400 font-mono">${formatPrice(signal.resistance)}</span></span>
            </div>

            <!-- XM Action Button -->
            ${!expired && signal.riskLevel !== 'red' ? `
            <button onclick='showSignalXmGuide(${JSON.stringify({
                symbol: signal.symbol,
                direction: signal.direction,
                price: signal.price,
                support: signal.support,
                resistance: signal.resistance,
                riskLevel: signal.riskLevel,
                strength: signal.strength.value,
                rsi: signal.rsi
            }).replace(/'/g, "&#39;")})' 
            class="w-full mt-3 py-2 text-[11px] font-medium rounded-lg ${isBuy ? 'bg-[#00ff41]/10 text-[#00ff41] hover:bg-[#00ff41]/20' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'} transition flex items-center justify-center gap-2">
                <i class="fas fa-book-open"></i> ¿Cómo opero esto en XM?
            </button>
            ` : ''}
        </div>
    `;
}

// ==================== COUNTDOWN ====================
function startCountdown(signal) {
    if (countdownIntervals[signal.id]) clearInterval(countdownIntervals[signal.id]);

    countdownIntervals[signal.id] = setInterval(() => {
        const elapsed = Math.floor((Date.now() - signal.timestamp) / 1000);
        const remaining = Math.max(0, 120 - elapsed);
        const progress = Math.max(0, (remaining / 120) * 100);

        const timerEl = document.getElementById(`timer-${signal.id}`);
        const barEl = document.getElementById(`bar-${signal.id}`);

        if (timerEl) timerEl.textContent = formatTime(remaining);
        if (barEl) {
            barEl.style.width = `${progress}%`;
            barEl.className = remaining <= 0 ? 'countdown-expired rounded-full' 
                : remaining < 30 ? 'countdown-hot rounded-full' 
                : remaining < 60 ? 'countdown-warm rounded-full' 
                : 'countdown-fresh rounded-full';
            barEl.style.height = '100%';
            barEl.style.transition = 'width 1s linear';
        }

        if (remaining <= 0) {
            clearInterval(countdownIntervals[signal.id]);
            signal.expired = true;
            const card = document.getElementById(`signal-${signal.id}`);
            if (card) card.classList.add('expired');
            updateStats();
        }
    }, 1000);
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ==================== RISK SEMAPHORE ====================
function updateRiskSemaphore(signal) {
    const greenEl = document.getElementById('riskGreen');
    const yellowEl = document.getElementById('riskYellow');
    const redEl = document.getElementById('riskRed');
    const msgEl = document.getElementById('riskMessage');

    // Reset all
    [greenEl, yellowEl, redEl].forEach(el => {
        el.classList.remove('active-green', 'active-yellow', 'active-red');
    });

    const isBuy = signal.direction === 'BUY';

    if (signal.riskLevel === 'green') {
        greenEl.classList.add('active-green');
        msgEl.innerHTML = `<span class="text-green-400 font-semibold">🟢 Señal segura.</span> ${isBuy ? 'Buen momento para considerar compra.' : 'Buen momento para considerar venta.'}`;
    } else if (signal.riskLevel === 'yellow') {
        yellowEl.classList.add('active-yellow');
        msgEl.innerHTML = `<span class="text-yellow-400 font-semibold">🟡 Precaución.</span> La señal es moderada. ${isBuy ? 'Puedes comprar pero con un stop loss ajustado.' : 'Puedes vender pero vigila de cerca.'}`;
    } else {
        redEl.classList.add('active-red');
        msgEl.innerHTML = `<span class="text-red-400 font-semibold">🔴 ¡Peligro!</span> Señal débil. No es recomendable entrar ahora. Espera una mejor oportunidad.`;
    }
}

// ==================== PRESENT/AWAY MODE ====================
function toggleMode() {
    isPresent = !isPresent;
    updateModeUI();
    if (isPresent) {
        showToast('🔊 Modo Presente activado. Recibirás alertas sonoras y visuales.', 'success');
    } else {
        showToast('📱 Modo Away activado. Recibirás notificaciones Push.', 'info');
    }
    saveUserConfig();
}

// ==================== ALERTS ====================
function initAudio() {
    // Create audio context for alert sounds
    alertAudio = new (window.AudioContext || window.webkitAudioContext)();
}

function playAlertSound(signal) {
    if (!alertAudio) return;
    // Resume audio context if suspended (browser policy)
    if (alertAudio.state === 'suspended') alertAudio.resume();

    try {
        const oscillator = alertAudio.createOscillator();
        const gainNode = alertAudio.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(alertAudio.destination);

        if (signal.direction === 'BUY') {
            // Ascending tone for BUY
            oscillator.frequency.setValueAtTime(440, alertAudio.currentTime);
            oscillator.frequency.linearRampToValueAtTime(880, alertAudio.currentTime + 0.3);
            oscillator.type = 'sine';
        } else {
            // Descending tone for SELL
            oscillator.frequency.setValueAtTime(880, alertAudio.currentTime);
            oscillator.frequency.linearRampToValueAtTime(440, alertAudio.currentTime + 0.3);
            oscillator.type = 'sine';
        }

        gainNode.gain.setValueAtTime(0.3, alertAudio.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, alertAudio.currentTime + 0.5);

        oscillator.start(alertAudio.currentTime);
        oscillator.stop(alertAudio.currentTime + 0.5);
    } catch (e) {
        console.log('Audio alert failed:', e);
    }
}

function sendBrowserNotification(signal) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const isBuy = signal.direction === 'BUY';
    const emoji = isBuy ? '🟢' : '🔴';
    const risk = signal.riskLevel === 'green' ? 'Seguro' : signal.riskLevel === 'yellow' ? 'Precaución' : 'Peligro';

    const notification = new Notification(`${emoji} ${signal.direction} ${signal.symbol}`, {
        body: `Precio: ${formatPrice(signal.price)}\nFuerza: ${signal.strength.value}% | Riesgo: ${risk}`,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="%230a0a0f"/><text x="50" y="65" text-anchor="middle" font-size="50" fill="%2300ff41">⚡</text></svg>',
        tag: `signal-${signal.id}`,
        requireInteraction: true,
        vibrate: [200, 100, 200],
    });

    notification.onclick = () => {
        window.focus();
        notification.close();
    };

    // Auto close after 30 seconds
    setTimeout(() => notification.close(), 30000);
}

function triggerVisualAlert(signal) {
    if (!isPresent) return;

    const overlay = document.getElementById('alertOverlay');
    const flash = overlay.querySelector('.signal-flash');

    overlay.classList.remove('hidden');
    flash.classList.remove('flash-buy', 'flash-sell');
    
    setTimeout(() => {
        flash.classList.add(signal.direction === 'BUY' ? 'flash-buy' : 'flash-sell');
    }, 10);

    setTimeout(() => {
        overlay.classList.add('hidden');
        flash.classList.remove('flash-buy', 'flash-sell');
    }, 2000);
}

// ==================== FIRESTORE ====================
async function saveSignalToFirestore(signal) {
    try {
        const docId = signal.id || `${signal.symbol}_${signal.direction}_${Date.now()}`;
        await db.collection('signals').doc(docId).set({
            ...signal,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            userId: auth.currentUser?.uid
        });
    } catch (error) {
        console.error('Error saving signal to Firestore:', error);
    }
}

async function loadSignalsFromFirestore() {
    try {
        const cutoff = new Date();
        cutoff.setHours(cutoff.getHours() - 24);

        const snap = await db.collection('signals')
            .where('timestamp', '>', cutoff)
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get();

        if (snap.empty) {
            console.log('📭 No hay señales guardadas en las últimas 24h');
            return;
        }

        const loaded = [];
        snap.docs.forEach(doc => {
            const data = doc.data();
            // Reconstruct signal, mark expired if older than 2 min
            const signalTime = data.timestamp?.toDate?.() || new Date(data.timestamp);
            const ageMs = Date.now() - signalTime.getTime();
            const expired = ageMs > 120000;

            loaded.push({
                ...data,
                id: doc.id,
                timestamp: signalTime.getTime(),
                expired: expired
            });
        });

        // Merge with existing signals (avoid duplicates by id)
        const existingIds = new Set(signals.map(s => s.id));
        const newSignals = loaded.filter(s => !existingIds.has(s.id));
        signals = [...newSignals, ...signals].slice(0, 50);
        todaySignalCount = signals.length;

        renderSignals();
        updateStats();
        console.log(`📡 ${newSignals.length} señales cargadas desde Firestore (${loaded.length} totales en 24h)`);
    } catch (e) {
        console.error('Error loading signals from Firestore:', e);
    }
}

// Auto-cleanup: delete signals older than 24 hours
async function cleanupOldSignals() {
    try {
        const cutoff = new Date();
        cutoff.setHours(cutoff.getHours() - 24);

        const oldSignals = await db.collection('signals')
            .where('timestamp', '<', cutoff)
            .limit(100)
            .get();

        if (oldSignals.empty) {
            console.log('🧹 No hay señales antiguas para limpiar');
            return;
        }

        const batch = db.batch();
        oldSignals.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log(`🧹 Limpieza: ${oldSignals.size} señales antiguas eliminadas`);
    } catch (e) {
        console.error('Error cleaning up signals:', e);
    }
}

// Cleanup old track record entries (keep only last 200 per user)
async function cleanupOldTrackRecord() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
        const snap = await db.collection('users').doc(uid).collection('trackRecord')
            .orderBy('timestamp', 'desc')
            .get();

        if (snap.size <= 200) return;

        const toDelete = snap.docs.slice(200);
        const batch = db.batch();
        toDelete.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log(`🧹 Track record limpiado: ${toDelete.length} entradas antiguas eliminadas`);
    } catch (e) {
        console.error('Error cleaning track record:', e);
    }
}

// ==================== SIGNAL HISTORY ====================
function addToHistory(signal) {
    const container = document.getElementById('signalHistory');
    const isBuy = signal.direction === 'BUY';
    const time = new Date(signal.timestamp).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const entry = document.createElement('div');
    entry.className = 'flex items-center justify-between py-1.5 px-2 rounded-lg bg-gray-800/30 animate-slide-in';
    entry.innerHTML = `
        <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full ${isBuy ? 'bg-[#00ff41]' : 'bg-red-500'}"></span>
            <span class="text-xs text-white font-medium">${signal.symbol}</span>
            <span class="text-[10px] ${isBuy ? 'text-[#00ff41]' : 'text-red-400'}">${signal.direction}</span>
        </div>
        <div class="flex items-center gap-2">
            <span class="text-xs text-gray-400 font-mono">${formatPrice(signal.price)}</span>
            <span class="text-[10px] text-gray-600">${time}</span>
        </div>
    `;

    // Remove placeholder
    if (container.querySelector('p')) container.innerHTML = '';

    container.prepend(entry);

    // Keep max 20 entries
    while (container.children.length > 20) {
        container.lastChild.remove();
    }
}

// ==================== STATS ====================
function updateStats() {
    const active = signals.filter(s => !s.expired).length;
    document.getElementById('activeSignalsCount').textContent = active;
    document.getElementById('todaySignalsCount').textContent = todaySignalCount;
    document.getElementById('pairsCount').textContent = Object.keys(prices).length || 8;
}

// ==================== HELP MODAL ====================
function toggleHelp() {
    const modal = document.getElementById('helpModal');
    modal.classList.toggle('hidden');
}

// Close help on backdrop click
document.getElementById('helpModal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('helpModal')) {
        toggleHelp();
    }
});

// ==================== XM GUIDE ====================
function toggleXmGuide() {
    const modal = document.getElementById('xmGuideModal');
    modal.classList.toggle('hidden');
}

document.getElementById('xmGuideModal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('xmGuideModal')) {
        toggleXmGuide();
    }
});

// Contextual XM guide for a specific signal
function showSignalXmGuide(signal) {
    const isBuy = signal.direction === 'BUY';
    const xmSymbol = signal.symbol.replace('USDT', 'USD');
    const price = signal.price;

    // Calculate TP and SL based on support/resistance and direction
    // Ensure SL is always on the correct side of the entry price
    const fallbackDist = price * 0.005; // 0.5% fallback distance
    let tp, sl, tpDistance, slDistance;
    if (isBuy) {
        tp = signal.resistance > price ? signal.resistance : price + fallbackDist * 2;
        sl = signal.support < price ? signal.support : price - fallbackDist;
        slDistance = price - sl;
        tpDistance = tp - price;
    } else {
        tp = signal.support < price ? signal.support : price - fallbackDist * 2;
        sl = signal.resistance > price ? signal.resistance : price + fallbackDist;
        slDistance = sl - price;
        tpDistance = price - tp;
    }
    // Final safety: ensure distances are positive
    if (slDistance <= 0) { sl = isBuy ? price - fallbackDist : price + fallbackDist; slDistance = fallbackDist; }
    if (tpDistance <= 0) { tp = isBuy ? price + fallbackDist * 2 : price - fallbackDist * 2; tpDistance = fallbackDist * 2; }

    // Risk/Reward ratio
    const rr = slDistance > 0 ? (tpDistance / slDistance).toFixed(1) : '—';

    // Lot recommendation based on risk level and strength
    let lotRec, lotExplain;
    if (signal.riskLevel === 'green' && signal.strength >= 70) {
        lotRec = '0.03 - 0.05';
        lotExplain = 'Señal fuerte y segura. Puedes usar un lote moderado.';
    } else if (signal.riskLevel === 'green') {
        lotRec = '0.02 - 0.03';
        lotExplain = 'Señal segura pero moderada. Lote conservador recomendado.';
    } else {
        lotRec = '0.01 - 0.02';
        lotExplain = 'Señal con precaución. Usa el lote mínimo para proteger tu capital.';
    }

    // Estimated profit/loss with 0.03 lots
    const pipValue = price >= 1000 ? 0.01 : price >= 1 ? 0.0001 : 0.000001;
    const estProfit = (tpDistance * 0.03 / pipValue * 0.01).toFixed(2);
    const estLoss = (slDistance * 0.03 / pipValue * 0.01).toFixed(2);

    const modal = document.createElement('div');
    modal.id = 'signalXmModal';
    modal.className = 'fixed inset-0 bg-black/90 backdrop-blur-sm z-[75] flex items-center justify-center p-4';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.innerHTML = `
        <div class="glass-card rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto custom-scrollbar">
            <div class="sticky top-0 bg-[#12121a] p-4 border-b border-gray-800/50 rounded-t-2xl z-10">
                <div class="flex items-center justify-between">
                    <div>
                        <h2 class="text-sm font-bold text-white flex items-center gap-2">
                            <span class="px-2 py-0.5 rounded text-xs font-bold ${isBuy ? 'bg-[#00ff41]/15 text-[#00ff41]' : 'bg-red-500/15 text-red-400'}">
                                <i class="fas fa-${isBuy ? 'arrow-up' : 'arrow-down'} mr-1"></i>${signal.direction}
                            </span>
                            ${signal.symbol} → ${xmSymbol} en XM
                        </h2>
                        <p class="text-gray-500 text-[10px] mt-1">Guía específica para esta señal</p>
                    </div>
                    <button onclick="this.closest('#signalXmModal').remove()" class="text-gray-400 hover:text-white transition text-lg">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </div>

            <div class="p-4 space-y-4">

                <!-- Signal Summary -->
                <div class="bg-${isBuy ? '[#00ff41]' : 'red-500'}/5 border border-${isBuy ? '[#00ff41]' : 'red-500'}/20 rounded-xl p-3">
                    <div class="grid grid-cols-3 gap-3 text-center">
                        <div>
                            <p class="text-[10px] text-gray-500 uppercase">Entrada</p>
                            <p class="text-white text-sm font-bold font-mono">${formatPrice(price)}</p>
                        </div>
                        <div>
                            <p class="text-[10px] text-gray-500 uppercase">Take Profit</p>
                            <p class="text-[#00ff41] text-sm font-bold font-mono">${formatPrice(tp)}</p>
                        </div>
                        <div>
                            <p class="text-[10px] text-gray-500 uppercase">Stop Loss</p>
                            <p class="text-red-400 text-sm font-bold font-mono">${formatPrice(sl)}</p>
                        </div>
                    </div>
                    <div class="flex items-center justify-center gap-4 mt-2 pt-2 border-t border-gray-800/30">
                        <span class="text-[10px] text-gray-400">R/R: <strong class="text-white">${rr}:1</strong></span>
                        <span class="text-[10px] text-gray-400">Lotes: <strong class="text-amber-400">${lotRec}</strong></span>
                        <span class="text-[10px] text-gray-400">Riesgo: <strong class="${signal.riskLevel === 'green' ? 'text-[#00ff41]' : 'text-amber-400'}">${signal.riskLevel === 'green' ? 'Bajo' : 'Moderado'}</strong></span>
                    </div>
                </div>

                <!-- Step 1 -->
                <div class="flex gap-3">
                    <div class="w-6 h-6 rounded-full bg-[#00ff41] flex items-center justify-center text-black font-bold text-[10px] shrink-0 mt-0.5">1</div>
                    <div>
                        <p class="text-white text-xs font-bold">Abre XM → Mercados → busca "${xmSymbol}"</p>
                        <p class="text-gray-400 text-[11px] mt-1">Usa la lupa 🔍 y escribe <strong class="text-white">${xmSymbol}</strong>. Tócalo para abrir el gráfico.</p>
                    </div>
                </div>

                <!-- Step 2 -->
                <div class="flex gap-3">
                    <div class="w-6 h-6 rounded-full bg-[#00ff41] flex items-center justify-center text-black font-bold text-[10px] shrink-0 mt-0.5">2</div>
                    <div>
                        <p class="text-white text-xs font-bold">Toca el botón ${isBuy ? '<span class="text-[#00ff41]">COMPRA</span> (verde)' : '<span class="text-red-400">VENTA</span> (rojo)'}</p>
                        <p class="text-gray-400 text-[11px] mt-1">Abajo del gráfico verás dos botones grandes. Toca el de la ${isBuy ? 'derecha (COMPRA)' : 'izquierda (VENTA)'}.</p>
                    </div>
                </div>

                <!-- Step 3 -->
                <div class="flex gap-3">
                    <div class="w-6 h-6 rounded-full bg-[#00ff41] flex items-center justify-center text-black font-bold text-[10px] shrink-0 mt-0.5">3</div>
                    <div>
                        <p class="text-white text-xs font-bold">Configura los lotes: <span class="text-amber-400">${lotRec}</span></p>
                        <p class="text-gray-400 text-[11px] mt-1">${lotExplain}</p>
                        <p class="text-gray-400 text-[11px] mt-1">Selecciona <strong class="text-white">"Lotes"</strong> arriba y ajusta con los botones + y -.</p>
                    </div>
                </div>

                <!-- Step 4 -->
                <div class="flex gap-3">
                    <div class="w-6 h-6 rounded-full bg-amber-500 flex items-center justify-center text-black font-bold text-[10px] shrink-0 mt-0.5">4</div>
                    <div>
                        <p class="text-white text-xs font-bold">Activa TP/SL <span class="text-amber-400">(MUY IMPORTANTE)</span></p>
                        <p class="text-gray-400 text-[11px] mt-1">Activa el interruptor <strong class="text-white">TP/SL</strong> y selecciona <strong class="text-white">"Precio"</strong>.</p>
                        <div class="bg-gray-800/40 rounded-lg p-2 mt-2 space-y-1">
                            <p class="text-[11px]"><span class="text-[#00ff41]">Take Profit:</span> <strong class="text-white font-mono">${formatPrice(tp)}</strong></p>
                            <p class="text-[11px]"><span class="text-red-400">Stop Loss:</span> <strong class="text-white font-mono">${formatPrice(sl)}</strong></p>
                        </div>
                        <p class="text-gray-500 text-[10px] mt-1">Copia estos valores exactos en los campos de XM.</p>
                    </div>
                </div>

                <!-- Step 5 -->
                <div class="flex gap-3">
                    <div class="w-6 h-6 rounded-full bg-[#00ff41] flex items-center justify-center text-black font-bold text-[10px] shrink-0 mt-0.5">5</div>
                    <div>
                        <p class="text-white text-xs font-bold">Toca "${isBuy ? 'Colocar orden en...' : 'Colocar orden en...'}" <span class="${isBuy ? 'text-[#00ff41]' : 'text-red-400'}">(${isBuy ? 'verde' : 'rojo'})</span></p>
                        <p class="text-gray-400 text-[11px] mt-1">El botón grande de abajo. ¡Tu orden queda activa!</p>
                    </div>
                </div>

                <!-- What to expect -->
                <div class="bg-[#1a1a2e]/60 rounded-xl p-3 border border-gray-800/50">
                    <p class="text-gray-500 text-[10px] uppercase font-bold mb-2">¿Qué esperar?</p>
                    <ul class="text-[11px] text-gray-400 space-y-1">
                        <li class="flex items-start gap-2"><span class="text-[#00ff41]">✓</span> Si el precio llega a <strong class="text-[#00ff41]">${formatPrice(tp)}</strong>, XM cierra automáticamente y ganas.</li>
                        <li class="flex items-start gap-2"><span class="text-red-400">✗</span> Si el precio llega a <strong class="text-red-400">${formatPrice(sl)}</strong>, XM cierra automáticamente y pierdes poco.</li>
                        <li class="flex items-start gap-2"><span class="text-blue-400">ℹ</span> Puedes cerrar manualmente en cualquier momento desde "Operaciones" en XM.</li>
                    </ul>
                </div>

                <!-- Warning -->
                <div class="bg-amber-900/10 border border-amber-800/20 rounded-xl p-3">
                    <p class="text-amber-400 text-[10px] font-bold flex items-center gap-1"><i class="fas fa-exclamation-triangle"></i> Recuerda</p>
                    <p class="text-gray-400 text-[10px] mt-1">Esta es una guía basada en el análisis automático de AlphaSignal Pro. No es consejo financiero. Siempre opera con dinero que puedas permitirte perder.</p>
                </div>

                <button onclick="this.closest('#signalXmModal').remove()" class="w-full py-2.5 text-xs font-medium rounded-xl ${isBuy ? 'bg-[#00ff41]/10 text-[#00ff41]' : 'bg-red-500/10 text-red-400'} transition">
                    <i class="fas fa-check-circle mr-1"></i> Entendido
                </button>
            </div>
        </div>
    `;

    // Remove existing modal if any
    document.getElementById('signalXmModal')?.remove();
    document.body.appendChild(modal);
}

// ==================== TOAST ====================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const colors = {
        success: 'bg-[#00ff41]/90 text-black',
        error: 'bg-red-500/90 text-white',
        warning: 'bg-amber-500/90 text-black',
        info: 'bg-blue-500/90 text-white'
    };
    const icons = {
        success: 'check-circle',
        error: 'times-circle',
        warning: 'exclamation-triangle',
        info: 'info-circle'
    };

    const toast = document.createElement('div');
    toast.className = `toast ${colors[type] || colors.info} px-4 py-3 rounded-xl shadow-2xl flex items-center gap-2 text-sm font-medium max-w-sm`;
    toast.innerHTML = `<i class="fas fa-${icons[type] || icons.info}"></i><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ==================== KEYBOARD SHORTCUTS ====================
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const helpModal = document.getElementById('helpModal');
        if (!helpModal.classList.contains('hidden')) toggleHelp();
    }
    // Toggle mode with 'P' key
    if (e.key === 'p' && !e.target.matches('input, textarea')) {
        toggleMode();
    }
});

// ==================== TAB NAVIGATION ====================
function switchTab(tabName) {
    const views = ['dashboard', 'chart', 'trackrecord', 'academia', 'backtest', 'mercados', 'autotrading', 'config', 'admin'];
    views.forEach(v => {
        const el = document.getElementById(`view-${v}`);
        const btn = document.getElementById(`tab-${v}`);
        if (el) el.classList.toggle('hidden', v !== tabName);
        if (btn) btn.classList.toggle('active', v === tabName);
    });

    // Initialize chart when tab is first opened
    if (tabName === 'chart' && !tvChart) initTradingViewChart();
    if (tabName === 'trackrecord') renderTrackRecord();
    if (tabName === 'academia') loadAcademiaProgress();
    if (tabName === 'mercados') loadMarkets();
    if (tabName === 'autotrading') renderAutoTrading();
    if (tabName === 'config') { loadConfigValues(); updateTimeframeUI(); }
    if (tabName === 'admin' && isAdmin) loadAdminUsers();
}

// ==================== ADMIN PANEL ====================
async function loadAdminUsers() {
    if (!isAdmin) return;
    const container = document.getElementById('adminUserList');
    container.innerHTML = '<p class="text-gray-600 text-xs text-center py-4"><i class="fas fa-spinner fa-spin"></i> Cargando...</p>';

    try {
        const snap = await db.collection('users').get();
        allUsers = snap.docs.map(doc => ({ uid: doc.id, ...doc.data() }));
        console.log('👑 Admin: ' + allUsers.length + ' usuarios encontrados');
        renderAdminUsers(allUsers);
    } catch (e) {
        console.error('Error loading users:', e);
        if (e.code === 'permission-denied') {
            container.innerHTML = `
                <div class="text-center py-6 space-y-3">
                    <i class="fas fa-lock text-red-400 text-3xl"></i>
                    <p class="text-red-400 text-xs font-bold">Permisos insuficientes</p>
                    <p class="text-gray-500 text-[11px]">Debes actualizar las reglas de Firestore para permitir al admin leer todos los usuarios.<br>Ve a Firebase Console → Firestore → Rules</p>
                </div>`;
        } else {
            container.innerHTML = '<p class="text-red-400 text-xs text-center py-4">Error al cargar usuarios: ' + e.message + '</p>';
        }
    }
}

function renderAdminUsers(users) {
    const container = document.getElementById('adminUserList');
    const total = users.length;
    const active = users.filter(u => u.active === true).length;
    const pending = users.filter(u => u.active === false).length;
    const blocked = users.filter(u => u.active === 'blocked').length;

    document.getElementById('adminTotalUsers').textContent = total;
    document.getElementById('adminActiveUsers').textContent = active;
    document.getElementById('adminPendingUsers').textContent = pending;
    document.getElementById('adminBlockedUsers').textContent = blocked;

    if (users.length === 0) {
        container.innerHTML = '<p class="text-gray-600 text-xs text-center py-8">No hay usuarios registrados</p>';
        return;
    }

    container.innerHTML = users.map(u => {
        const isAdminUser = u.email === ADMIN_EMAIL;
        const date = u.createdAt ? new Date(u.createdAt.seconds * 1000).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }) : 'N/A';
        
        let statusBadge, statusColor;
        if (isAdminUser) {
            statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] bg-amber-500/20 text-amber-400"><i class="fas fa-crown mr-1"></i>Admin</span>';
            statusColor = 'border-amber-500/20';
        } else if (u.active === true) {
            statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] bg-[#00ff41]/15 text-[#00ff41]"><i class="fas fa-check-circle mr-1"></i>Activo</span>';
            statusColor = 'border-[#00ff41]/20';
        } else if (u.active === 'blocked') {
            statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] bg-red-500/15 text-red-400"><i class="fas fa-ban mr-1"></i>Bloqueado</span>';
            statusColor = 'border-red-500/20';
        } else {
            statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] bg-amber-500/15 text-amber-400"><i class="fas fa-clock mr-1"></i>Pendiente</span>';
            statusColor = 'border-amber-500/20';
        }

        const planBadge = u.plan === 'premium'
            ? '<span class="px-2 py-0.5 rounded-full text-[10px] bg-purple-500/15 text-purple-400">Premium</span>'
            : '<span class="px-2 py-0.5 rounded-full text-[10px] bg-gray-700/50 text-gray-400">Free</span>';

        const actions = isAdminUser ? '' : `
            <div class="flex items-center gap-1 mt-2">
                ${u.active !== true ? `<button onclick="adminSetUserStatus('${u.uid}', true)" class="px-2 py-1 text-[10px] rounded bg-[#00ff41]/15 text-[#00ff41] hover:bg-[#00ff41]/25 transition"><i class="fas fa-check"></i> Aprobar</button>` : ''}
                ${u.active !== 'blocked' ? `<button onclick="adminSetUserStatus('${u.uid}', 'blocked')" class="px-2 py-1 text-[10px] rounded bg-red-500/15 text-red-400 hover:bg-red-500/25 transition"><i class="fas fa-ban"></i> Bloquear</button>` : ''}
                ${u.active === 'blocked' ? `<button onclick="adminSetUserStatus('${u.uid}', true)" class="px-2 py-1 text-[10px] rounded bg-[#00ff41]/15 text-[#00ff41] hover:bg-[#00ff41]/25 transition"><i class="fas fa-unlock"></i> Desbloquear</button>` : ''}
                <button onclick="adminSetUserPlan('${u.uid}', '${u.plan === 'premium' ? 'free' : 'premium'}')" class="px-2 py-1 text-[10px] rounded bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 transition"><i class="fas fa-star"></i> ${u.plan === 'premium' ? 'Quitar Premium' : 'Dar Premium'}</button>
                <button onclick="adminDeleteUser('${u.uid}', '${u.email}')" class="px-2 py-1 text-[10px] rounded bg-red-900/30 text-red-500 hover:bg-red-900/50 transition"><i class="fas fa-trash"></i></button>
            </div>
        `;

        return `
            <div class="bg-[#1a1a2e]/60 rounded-xl p-3 border ${statusColor}">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <div class="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-xs text-white font-bold">
                            ${u.email ? u.email[0].toUpperCase() : '?'}
                        </div>
                        <div>
                            <p class="text-white text-xs font-medium">${u.email || 'Sin correo'}</p>
                            <p class="text-gray-600 text-[10px]">Registro: ${date}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        ${planBadge}
                        ${statusBadge}
                    </div>
                </div>
                ${actions}
            </div>
        `;
    }).join('');
}

function filterAdminUsers() {
    const filter = document.getElementById('adminFilterStatus').value;
    let filtered = allUsers;
    if (filter === 'active') filtered = allUsers.filter(u => u.active === true);
    else if (filter === 'pending') filtered = allUsers.filter(u => u.active === false);
    else if (filter === 'blocked') filtered = allUsers.filter(u => u.active === 'blocked');
    renderAdminUsers(filtered);
}

async function adminSetUserStatus(uid, status) {
    if (!isAdmin) return;
    try {
        await db.collection('users').doc(uid).update({ active: status });
        const label = status === true ? 'aprobado' : 'bloqueado';
        showToast(`Usuario ${label} correctamente`, 'success');
        loadAdminUsers();
    } catch (e) {
        console.error('Error updating user:', e);
        showToast('Error al actualizar usuario', 'error');
    }
}

async function adminSetUserPlan(uid, plan) {
    if (!isAdmin) return;
    try {
        await db.collection('users').doc(uid).update({ plan: plan });
        showToast(`Plan cambiado a ${plan}`, 'success');
        loadAdminUsers();
    } catch (e) {
        console.error('Error updating plan:', e);
        showToast('Error al cambiar plan', 'error');
    }
}

async function adminDeleteUser(uid, email) {
    if (!isAdmin) return;
    if (!confirm(`\u00bfSeguro que quieres eliminar a ${email}? Esta acci\u00f3n no se puede deshacer.`)) return;
    try {
        await db.collection('users').doc(uid).delete();
        showToast(`Usuario ${email} eliminado`, 'info');
        loadAdminUsers();
    } catch (e) {
        console.error('Error deleting user:', e);
        showToast('Error al eliminar usuario', 'error');
    }
}

// ==================== TRADINGVIEW LIGHTWEIGHT CHART ====================
let tvChart = null;
let tvCandleSeries = null;
let tvEma9Series = null;
let tvEma21Series = null;
let tvVolumeSeries = null;
let chartWs = null;
let chartSignalMarkers = [];

function initTradingViewChart() {
    const container = document.getElementById('tvChartContainer');
    if (!container || typeof LightweightCharts === 'undefined') {
        console.error('Chart container or LightweightCharts not found');
        return;
    }

    tvChart = LightweightCharts.createChart(container, {
        layout: {
            background: { color: '#0a0a0f' },
            textColor: '#6b7280',
            fontSize: 11,
        },
        grid: {
            vertLines: { color: 'rgba(255,255,255,0.03)' },
            horzLines: { color: 'rgba(255,255,255,0.03)' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: 'rgba(0,255,65,0.3)', width: 1 },
            horzLine: { color: 'rgba(0,255,65,0.3)', width: 1 },
        },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: true, secondsVisible: false },
        handleScroll: { vertTouchDrag: false },
    });

    tvCandleSeries = tvChart.addCandlestickSeries({
        upColor: '#00ff41',
        downColor: '#ff3b3b',
        borderUpColor: '#00ff41',
        borderDownColor: '#ff3b3b',
        wickUpColor: '#00ff41',
        wickDownColor: '#ff3b3b',
    });

    tvEma9Series = tvChart.addLineSeries({ color: '#00ff41', lineWidth: 1, title: 'EMA 9' });
    tvEma21Series = tvChart.addLineSeries({ color: '#ff6d00', lineWidth: 1, title: 'EMA 21' });

    tvVolumeSeries = tvChart.addHistogramSeries({
        color: '#26a69a',
        priceFormat: { type: 'volume' },
        priceScaleId: '',
    });
    tvVolumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    loadChartData();

    // Responsive resize
    const ro = new ResizeObserver(() => { tvChart.applyOptions({ width: container.clientWidth }); });
    ro.observe(container);
}

async function loadChartData() {
    const symbol = document.getElementById('chartSymbol')?.value || 'btcusdt';
    const interval = document.getElementById('chartInterval')?.value || '15m';

    try {
        const resp = await fetch(`${BINANCE_API}/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=300`);
        const data = await resp.json();

        const candles = data.map(k => ({
            time: Math.floor(k[0] / 1000),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
        }));

        const volumes = data.map(k => ({
            time: Math.floor(k[0] / 1000),
            value: parseFloat(k[5]),
            color: parseFloat(k[4]) >= parseFloat(k[1]) ? 'rgba(0,255,65,0.2)' : 'rgba(255,59,59,0.2)',
        }));

        if (tvCandleSeries) tvCandleSeries.setData(candles);
        if (tvVolumeSeries) tvVolumeSeries.setData(volumes);

        // Calculate and draw EMAs
        const closes = candles.map(c => c.close);
        const ema9Data = calcEMAArray(closes, 9).map((v, i) => ({ time: candles[i].time, value: v })).filter(d => d.value);
        const ema21Data = calcEMAArray(closes, 21).map((v, i) => ({ time: candles[i].time, value: v })).filter(d => d.value);

        if (tvEma9Series) tvEma9Series.setData(ema9Data);
        if (tvEma21Series) tvEma21Series.setData(ema21Data);

        // Add signal markers from track record
        applyChartMarkers();

        tvChart.timeScale().fitContent();

        // Connect real-time updates
        connectChartWs(symbol, interval);

    } catch (e) {
        console.error('Error loading chart data:', e);
    }
}

function calcEMAArray(data, period) {
    const result = [];
    const k = 2 / (period + 1);
    let ema = null;
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) { result.push(null); continue; }
        if (ema === null) {
            ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
        } else {
            ema = data[i] * k + ema * (1 - k);
        }
        result.push(parseFloat(ema.toFixed(8)));
    }
    return result;
}

function connectChartWs(symbol, interval) {
    if (chartWs) chartWs.close();
    const url = `${BINANCE_WS_BASE}/${symbol}@kline_${interval}`;
    chartWs = new WebSocket(url);
    chartWs.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg.e === 'kline') {
                const k = msg.k;
                const candle = {
                    time: Math.floor(k.t / 1000),
                    open: parseFloat(k.o),
                    high: parseFloat(k.h),
                    low: parseFloat(k.l),
                    close: parseFloat(k.c),
                };
                if (tvCandleSeries) tvCandleSeries.update(candle);
                if (tvVolumeSeries) tvVolumeSeries.update({
                    time: candle.time,
                    value: parseFloat(k.v),
                    color: candle.close >= candle.open ? 'rgba(0,255,65,0.2)' : 'rgba(255,59,59,0.2)',
                });
            }
        } catch (err) {}
    };
}

function changeChartSymbol() { if (tvChart) loadChartData(); }
function changeChartInterval() { if (tvChart) loadChartData(); }

function applyChartMarkers() {
    if (!tvCandleSeries || chartSignalMarkers.length === 0) return;
    tvCandleSeries.setMarkers(chartSignalMarkers.sort((a, b) => a.time - b.time));
}

// ==================== TRACK RECORD ====================
let trackRecord = [];

async function loadTrackRecordFromFirestore() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
        const snap = await db.collection('users').doc(uid).collection('trackRecord')
            .orderBy('timestamp', 'desc').limit(200).get();
        trackRecord = snap.docs.map(d => d.data());
        console.log(`📊 Track record cargado: ${trackRecord.length} señales`);
    } catch (e) {
        console.error('Error loading track record:', e);
        // Fallback to localStorage
        trackRecord = JSON.parse(localStorage.getItem('alphaTrackRecord') || '[]');
    }
}

async function saveTrackRecordEntry(entry) {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
        await db.collection('users').doc(uid).collection('trackRecord').doc(entry.id).set(entry);
    } catch (e) {
        console.error('Error saving track record entry:', e);
    }
    // Also save to localStorage as backup
    localStorage.setItem('alphaTrackRecord', JSON.stringify(trackRecord));
}

function addSignalToTrackRecord(signal) {
    // Calculate TP/SL for verification
    const price = signal.price;
    const fallbackDist = price * 0.005;
    let tp, sl;
    if (signal.direction === 'BUY') {
        tp = signal.resistance > price ? signal.resistance : price + fallbackDist * 2;
        sl = signal.support < price ? signal.support : price - fallbackDist;
    } else {
        tp = signal.support < price ? signal.support : price - fallbackDist * 2;
        sl = signal.resistance > price ? signal.resistance : price + fallbackDist;
    }

    const entry = {
        id: signal.id,
        symbol: signal.symbol,
        symbolRaw: signal.symbolRaw || signal.symbol.replace('/USDT', '').toLowerCase() + 'usdt',
        direction: signal.direction,
        price: signal.price,
        tp: tp,
        sl: sl,
        strength: signal.strength.value,
        riskLevel: signal.riskLevel,
        rsi: signal.rsi,
        timestamp: signal.timestamp,
        verified: false,
        result: null,
        priceAfter: null,
        changePercent: null,
    };
    trackRecord.unshift(entry);
    saveTrackRecordEntry(entry);

    // Add marker to chart
    chartSignalMarkers.push({
        time: Math.floor(signal.timestamp / 1000),
        position: signal.direction === 'BUY' ? 'belowBar' : 'aboveBar',
        color: signal.direction === 'BUY' ? '#00ff41' : '#ff3b3b',
        shape: signal.direction === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: `${signal.direction} ${signal.strength.value}%`,
    });
    applyChartMarkers();
}

async function verifySignal(entry) {
    if (!entry || entry.verified) return false;

    // Need at least 3 minutes since signal
    const age = Date.now() - entry.timestamp;
    if (age < 3 * 60 * 1000) return false;

    try {
        const sym = (entry.symbolRaw || entry.symbol.replace('/USDT', '').toLowerCase() + 'usdt').toUpperCase();

        // Fetch klines since signal was created to check if TP/SL was hit
        const startTime = entry.timestamp;
        const resp = await fetch(`${BINANCE_API}/klines?symbol=${sym}&interval=1m&startTime=${startTime}&limit=60`);
        const klines = await resp.json();
        if (!Array.isArray(klines) || klines.length === 0) return false;

        let tpHit = false, slHit = false;
        let exitPrice = parseFloat(klines[klines.length - 1][4]); // latest close

        for (const k of klines) {
            const high = parseFloat(k[2]);
            const low = parseFloat(k[3]);

            if (entry.tp && entry.sl) {
                if (entry.direction === 'BUY') {
                    if (high >= entry.tp) { tpHit = true; exitPrice = entry.tp; break; }
                    if (low <= entry.sl) { slHit = true; exitPrice = entry.sl; break; }
                } else {
                    if (low <= entry.tp) { tpHit = true; exitPrice = entry.tp; break; }
                    if (high >= entry.sl) { slHit = true; exitPrice = entry.sl; break; }
                }
            }
        }

        entry.priceAfter = exitPrice;
        entry.verified = true;

        if (tpHit) {
            entry.result = 'win';
        } else if (slHit) {
            entry.result = 'loss';
        } else if (age > 30 * 60 * 1000) {
            // After 30 min without hitting TP/SL, resolve by current price direction
            if (entry.direction === 'BUY') {
                entry.result = exitPrice > entry.price ? 'win' : 'loss';
            } else {
                entry.result = exitPrice < entry.price ? 'win' : 'loss';
            }
        } else {
            // Not enough time, don't verify yet
            entry.verified = false;
            return false;
        }

        entry.changePercent = ((exitPrice - entry.price) / entry.price * 100).toFixed(2);

        saveTrackRecordEntry(entry);
        return true;
    } catch (e) {
        console.error('Error verifying signal:', e);
        return false;
    }
}

async function verifyPendingSignals() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const pending = trackRecord.filter(t => !t.verified && (now - t.timestamp) < maxAge);

    // Auto-expire very old signals (>24h) that were never verified
    trackRecord.forEach(t => {
        if (!t.verified && (now - t.timestamp) >= maxAge) {
            t.verified = true;
            t.result = 'expired';
            t.priceAfter = null;
            t.changePercent = '0.00';
            saveTrackRecordEntry(t);
        }
    });

    if (pending.length === 0) {
        renderTrackRecord();
        return;
    }

    console.log(`🔍 Verificando ${pending.length} señales pendientes...`);
    let verified = 0;

    for (const entry of pending) {
        const success = await verifySignal(entry);
        if (success) verified++;
        // Small delay between API calls to avoid rate limiting
        await new Promise(r => setTimeout(r, 300));
    }

    if (verified > 0) {
        console.log(`✅ ${verified} señales verificadas de ${pending.length} pendientes`);
    }
    renderTrackRecord();
}

// Periodic verification: check pending signals every 60 seconds
setInterval(() => {
    if (auth.currentUser && trackRecord.some(t => !t.verified)) {
        verifyPendingSignals();
    }
}, 60 * 1000);

function renderTrackRecord() {
    const resolved = trackRecord.filter(t => t.verified && (t.result === 'win' || t.result === 'loss'));
    const wins = resolved.filter(t => t.result === 'win').length;
    const losses = resolved.filter(t => t.result === 'loss').length;
    const total = resolved.length;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '--';

    // Calculate streak
    let streak = 0;
    let streakType = '';
    for (const t of resolved) {
        if (!streakType) { streakType = t.result; streak = 1; }
        else if (t.result === streakType) streak++;
        else break;
    }

    document.getElementById('trTotalSignals').textContent = trackRecord.length;
    document.getElementById('trWins').textContent = wins;
    document.getElementById('trLosses').textContent = losses;
    document.getElementById('trWinRate').textContent = winRate + '%';
    document.getElementById('trStreak').textContent = (streakType === 'win' ? '+' : '-') + streak;

    // Render performance chart
    renderPerformanceChart(resolved);

    // Render table
    const table = document.getElementById('trackRecordTable');
    if (trackRecord.length === 0) {
        table.innerHTML = '<p class="text-gray-600 text-xs text-center py-8"><i class="fas fa-clock text-2xl mb-2 block"></i>Las señales aparecerán aquí con su resultado verificado</p>';
        return;
    }

    table.innerHTML = trackRecord.slice(0, 50).map(t => {
        const time = new Date(t.timestamp).toLocaleString('es-CO', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const isBuy = t.direction === 'BUY';
        let resultBadge = '<span class="text-[10px] text-gray-600 px-2 py-0.5 rounded-full bg-gray-800">⏳ Pendiente</span>';
        if (t.verified) {
            if (t.result === 'win') {
                resultBadge = `<span class="text-[10px] text-[#00ff41] px-2 py-0.5 rounded-full bg-[#00ff41]/10">✅ +${Math.abs(t.changePercent)}%</span>`;
            } else if (t.result === 'loss') {
                resultBadge = `<span class="text-[10px] text-red-400 px-2 py-0.5 rounded-full bg-red-500/10">❌ ${t.changePercent}%</span>`;
            } else if (t.result === 'expired') {
                resultBadge = '<span class="text-[10px] text-gray-500 px-2 py-0.5 rounded-full bg-gray-800">⌛ Expirada</span>';
            }
        }
        return `
            <div class="tr-row flex items-center justify-between py-2.5 px-3 rounded-lg bg-gray-800/20 border border-gray-800/30">
                <div class="flex items-center gap-3">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold ${isBuy ? 'bg-[#00ff41]/15 text-[#00ff41]' : 'bg-red-500/15 text-red-400'}">${t.direction}</span>
                    <span class="text-white text-xs font-medium">${t.symbol}</span>
                    <span class="text-gray-500 text-[10px] font-mono">${formatPrice(t.price)}</span>
                </div>
                <div class="flex items-center gap-3">
                    ${resultBadge}
                    <span class="text-gray-600 text-[10px]">${time}</span>
                </div>
            </div>
        `;
    }).join('');
}

function renderPerformanceChart(verified) {
    const container = document.getElementById('performanceChart');
    if (!container || typeof LightweightCharts === 'undefined' || verified.length === 0) return;

    container.innerHTML = '';
    const perfChart = LightweightCharts.createChart(container, {
        layout: { background: { color: '#0a0a0f' }, textColor: '#6b7280', fontSize: 10 },
        grid: { vertLines: { color: 'rgba(255,255,255,0.02)' }, horzLines: { color: 'rgba(255,255,255,0.02)' } },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: true },
        handleScroll: { vertTouchDrag: false },
    });

    let cumulative = 0;
    const lineData = verified.reverse().map(t => {
        cumulative += t.result === 'win' ? 1 : -1;
        return { time: Math.floor(t.timestamp / 1000), value: cumulative };
    });

    const lineSeries = perfChart.addLineSeries({
        color: cumulative >= 0 ? '#00ff41' : '#ff3b3b',
        lineWidth: 2,
    });
    lineSeries.setData(lineData);

    // Zero line
    const zeroLine = perfChart.addLineSeries({ color: 'rgba(255,255,255,0.1)', lineWidth: 1, lineStyle: 2 });
    if (lineData.length >= 2) {
        zeroLine.setData([
            { time: lineData[0].time, value: 0 },
            { time: lineData[lineData.length - 1].time, value: 0 },
        ]);
    }

    perfChart.timeScale().fitContent();
    const ro = new ResizeObserver(() => perfChart.applyOptions({ width: container.clientWidth }));
    ro.observe(container);
}

async function clearTrackRecord() {
    if (confirm('¿Seguro que quieres borrar todo el historial de señales?')) {
        // Delete from Firestore
        const uid = auth.currentUser?.uid;
        if (uid) {
            try {
                const snap = await db.collection('users').doc(uid).collection('trackRecord').get();
                const batch = db.batch();
                snap.docs.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
            } catch (e) { console.error('Error clearing track record:', e); }
        }
        trackRecord = [];
        chartSignalMarkers = [];
        localStorage.removeItem('alphaTrackRecord');
        renderTrackRecord();
        showToast('Historial borrado', 'info');
    }
}

// ==================== ACADEMIA ====================
let completedLessons = [];

async function loadLessonsFromFirestore() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
        const doc = await db.collection('users').doc(uid).get();
        if (doc.exists && doc.data().completedLessons) {
            completedLessons = doc.data().completedLessons;
        }
        console.log(`🎓 Lecciones cargadas: ${completedLessons.length} completadas`);
    } catch (e) {
        console.error('Error loading lessons:', e);
        completedLessons = JSON.parse(localStorage.getItem('alphaLessons') || '[]');
    }
}

async function completeLesson(num) {
    if (!completedLessons.includes(num)) {
        completedLessons.push(num);
        // Save to Firestore
        const uid = auth.currentUser?.uid;
        if (uid) {
            try {
                await db.collection('users').doc(uid).set(
                    { completedLessons: completedLessons },
                    { merge: true }
                );
            } catch (e) { console.error('Error saving lesson:', e); }
        }
        localStorage.setItem('alphaLessons', JSON.stringify(completedLessons));
        showToast(`🎓 ¡Lección ${num} completada!`, 'success');
    }
    loadAcademiaProgress();
}

function loadAcademiaProgress() {
    const completed = completedLessons;
    const total = 6;

    document.getElementById('academiaProgress').textContent = `${completed.length}/${total} lecciones`;
    document.getElementById('academiaProgressBar').style.width = `${(completed.length / total) * 100}%`;

    for (let i = 1; i <= total; i++) {
        const badge = document.getElementById(`lesson${i}-badge`);
        const card = document.querySelector(`.lesson-card[data-lesson="${i}"]`);
        if (completed.includes(i)) {
            if (badge) badge.classList.remove('hidden');
            if (card) card.classList.add('completed');
        } else {
            if (badge) badge.classList.add('hidden');
            if (card) card.classList.remove('completed');
        }
    }

    if (completed.length === total) {
        showToast('🏆 ¡Felicidades! Has completado toda la Academia de Trading', 'success');
    }
}

// ==================== TELEGRAM INTEGRATION ====================
function saveTelegramConfig() {
    const token = document.getElementById('telegramBotToken').value.trim();
    const chatId = document.getElementById('telegramChatId').value.trim();

    if (!token || !chatId) {
        showToast('Ingresa el Bot Token y Chat ID', 'warning');
        return;
    }

    localStorage.setItem('alphaTelegramToken', token);
    localStorage.setItem('alphaTelegramChatId', chatId);
    saveUserConfig();

    // Test connection
    testTelegramConnection(token, chatId);
}

async function testTelegramConnection(token, chatId) {
    try {
        const msg = '✅ *AlphaSignal Pro* conectado correctamente\\!\n\nRecibirás señales de trading aquí\\.';
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'MarkdownV2' }),
        });
        const data = await resp.json();
        if (data.ok) {
            showToast('✅ Telegram conectado correctamente. Revisa tu chat!', 'success');
        } else {
            showToast('❌ Error: ' + (data.description || 'Token o Chat ID inválido'), 'error');
        }
    } catch (e) {
        showToast('❌ Error de conexión con Telegram', 'error');
    }
}

async function sendTelegramSignal(signal) {
    const token = localStorage.getItem('alphaTelegramToken');
    const chatId = localStorage.getItem('alphaTelegramChatId');
    if (!token || !chatId) return;

    const emoji = signal.direction === 'BUY' ? '🟢' : '🔴';
    const risk = signal.riskLevel === 'green' ? '🟢 Seguro' : signal.riskLevel === 'yellow' ? '🟡 Precaución' : '🔴 Peligro';

    const text = `${emoji} *SEÑAL ${signal.direction}*\n\n` +
        `Moneda: *${signal.symbol}*\n` +
        `Precio: \`${formatPrice(signal.price)}\`\n` +
        `Fuerza: ${signal.strength.value}%\n` +
        `Riesgo: ${risk}\n` +
        `RSI: ${signal.rsi}\n\n` +
        `⏱️ Válida por 2 minutos\n` +
        `🤖 _AlphaSignal Pro_`;

    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (e) {
        console.error('Telegram send error:', e);
    }
}

// ==================== GEMINI AI INTEGRATION ====================
async function saveGeminiConfig() {
    const key = document.getElementById('geminiApiKey').value.trim();
    if (!key) { showToast('Ingresa tu API Key de Gemini', 'warning'); return; }

    showToast('🔄 Verificando API Key con Google...', 'info');

    try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'Responde solo: OK' }] }] }),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            const msg = err?.error?.message || `Error ${resp.status}`;
            if (resp.status === 400 || resp.status === 403) {
                showToast('❌ API Key inválida. Verifica que la copiaste bien.', 'error');
            } else if (resp.status === 429) {
                showToast('⚠️ Key válida pero con límite alcanzado. Intenta más tarde.', 'warning');
                localStorage.setItem('alphaGeminiKey', key);
                saveUserConfig();
            } else {
                showToast(`❌ Error de Google: ${msg}`, 'error');
            }
            return;
        }

        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            localStorage.setItem('alphaGeminiKey', key);
            saveUserConfig();
            showToast('✅ Gemini AI verificado y activado correctamente.', 'success');
        } else {
            showToast('❌ La API respondió pero sin contenido. Verifica tu key.', 'error');
        }
    } catch (e) {
        showToast('❌ No se pudo conectar con Google. Verifica tu conexión.', 'error');
        console.error('Gemini validation error:', e);
    }
}

async function validateSignalWithGemini(signal) {
    const key = localStorage.getItem('alphaGeminiKey');
    if (!key) return null;

    const prompt = `Eres un analista de trading experto. Analiza esta señal de trading y responde en español con máximo 2 oraciones simples:

Señal: ${signal.direction} ${signal.symbol}
Precio: ${signal.price}
RSI: ${signal.rsi}
Fuerza: ${signal.strength.value}%
Riesgo: ${signal.riskLevel}

¿Es una buena señal? ¿Qué debería tener en cuenta el trader?`;

    try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        const data = await resp.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) {
        console.error('Gemini error:', e);
        return null;
    }
}

// ==================== CONFIG ====================
function loadConfigValues() {
    const tgToken = localStorage.getItem('alphaTelegramToken') || '';
    const tgChat = localStorage.getItem('alphaTelegramChatId') || '';
    const geminiKey = localStorage.getItem('alphaGeminiKey') || '';

    document.getElementById('telegramBotToken').value = tgToken;
    document.getElementById('telegramChatId').value = tgChat;
    document.getElementById('geminiApiKey').value = geminiKey;
}

let alertSoundEnabled = true;
function toggleAlertSound() {
    alertSoundEnabled = !alertSoundEnabled;
    const btn = document.getElementById('soundToggle');
    if (alertSoundEnabled) {
        btn.textContent = 'Activado';
        btn.className = 'px-3 py-1.5 text-[10px] rounded-lg bg-[#00ff41]/20 text-[#00ff41]';
    } else {
        btn.textContent = 'Desactivado';
        btn.className = 'px-3 py-1.5 text-[10px] rounded-lg bg-gray-600/20 text-gray-500';
    }
}

function requestPushPermission() {
    if ('Notification' in window) {
        Notification.requestPermission().then(p => {
            if (p === 'granted') {
                document.getElementById('pushToggle').textContent = 'Activado ✓';
                document.getElementById('pushToggle').className = 'px-3 py-1.5 text-[10px] rounded-lg bg-[#00ff41]/20 text-[#00ff41]';
                showToast('🔔 Notificaciones Push activadas', 'success');
            } else {
                showToast('Notificaciones denegadas por el navegador', 'warning');
            }
        });
    }
}

// ==================== PWA INSTALL ====================
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('pwaInstallBtn');
    if (btn) btn.classList.remove('hidden');
});

document.getElementById('pwaInstallBtn')?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    if (result.outcome === 'accepted') {
        showToast('📱 ¡App instalada en tu dispositivo!', 'success');
    }
    deferredPrompt = null;
    document.getElementById('pwaInstallBtn').classList.add('hidden');
});

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('firebase-messaging-sw.js').then(() => {
        console.log('📱 Service Worker registrado para PWA');
    }).catch(e => console.log('SW registration failed:', e));
}

// ==================== ENHANCED SIGNAL HANDLER ====================
// Override handleNewSignal to include track record, telegram, and Gemini
const _originalHandleNewSignal = handleNewSignal;
handleNewSignal = async function(signal) {
    _originalHandleNewSignal(signal);

    // Add to track record
    addSignalToTrackRecord(signal);

    // Send to Telegram
    sendTelegramSignal(signal);

    // Validate with Gemini AI
    const geminiResult = await validateSignalWithGemini(signal);
    if (geminiResult) {
        // Append AI analysis to the signal card
        const card = document.getElementById(`signal-${signal.id}`);
        if (card) {
            const aiDiv = document.createElement('div');
            aiDiv.className = 'mt-2 pt-2 border-t border-purple-800/30';
            aiDiv.innerHTML = `
                <p class="text-[10px] text-purple-400 mb-1"><i class="fas fa-robot mr-1"></i>Análisis Gemini AI:</p>
                <p class="text-[11px] text-gray-400 leading-relaxed">${geminiResult}</p>
            `;
            card.appendChild(aiDiv);
        }
        showToast('🤖 Gemini AI ha validado la señal', 'info');
    }
};

// ==================== MERCADOS (MARKET EXPLORER) ====================
let allMarketPairs = [];
let marketCategory = 'all';
let marketsLoaded = false;

const CRYPTO_CATEGORIES = {
    top: ['btcusdt','ethusdt','bnbusdt','solusdt','xrpusdt','dogeusdt','adausdt','avaxusdt','dotusdt','maticusdt','linkusdt','atomusdt','ltcusdt','nearusdt','aptusdt','filusdt','arbusdt','opusdt','injusdt','suiusdt'],
    defi: ['uniusdt','aaveusdt','mkrusdt','compusdt','snxusdt','sushiusdt','crvusdt','1inchusdt','yfiusdt','ldousdt','pendleusdt','dydxusdt','gmxusdt','rndrusdt','jupusdt'],
    layer1: ['btcusdt','ethusdt','solusdt','avaxusdt','dotusdt','atomusdt','nearusdt','aptusdt','suiusdt','algousdt','ftmusdt','egldusdt','icpusdt','hbarusdt','tonusdt','seiusdt','tiausdt'],
    meme: ['dogeusdt','shibusdt','pepeusdt','flokiusdt','bonkusdt','wifusdt','memeusdt','1000satsusdt','bomeusdt','peopleusdt'],
    gaming: ['axsusdt','sandusdt','manausdt','galausdt','enjusdt','imxusdt','rndrusdt','flowusdt','illusdt','pixelusdt','portalusdt']
};

function getFavorites() {
    try {
        return JSON.parse(localStorage.getItem('alphasignal_favorites') || '[]');
    } catch { return []; }
}

function saveFavorites(favs) {
    localStorage.setItem('alphasignal_favorites', JSON.stringify(favs));
    updateFavCount();
}

function toggleFavorite(symbol) {
    let favs = getFavorites();
    if (favs.includes(symbol)) {
        favs = favs.filter(f => f !== symbol);
        showToast(`⭐ ${symbol.replace('usdt','').toUpperCase()}/USDT eliminado de favoritos`, 'info');
    } else {
        favs.push(symbol);
        showToast(`⭐ ${symbol.replace('usdt','').toUpperCase()}/USDT agregado a favoritos`, 'success');
    }
    saveFavorites(favs);
    renderMarkets();
    applyFavoritesToEngine();
    saveUserConfig();
}

function updateFavCount() {
    const el = document.getElementById('favCountNum');
    if (el) el.textContent = getFavorites().length;
}

function applyFavoritesToEngine() {
    const favs = getFavorites();
    // Merge favorites with base SYMBOLS (no duplicates)
    const baseSymbols = ['btcusdt','ethusdt','bnbusdt','solusdt','xrpusdt','dogeusdt','adausdt','avaxusdt','dotusdt','maticusdt','linkusdt','atomusdt','ltcusdt','nearusdt','aptusdt','filusdt','arbusdt','opusdt','injusdt','suiusdt'];
    const merged = [...new Set([...baseSymbols, ...favs])];
    // Update global SYMBOLS (it's const but we can modify array contents)
    SYMBOLS.length = 0;
    merged.forEach(s => SYMBOLS.push(s));
    // Reconnect WebSocket to include new symbols
    if (binanceWs && binanceWs.readyState === WebSocket.OPEN) {
        binanceWs.onclose = null;
        binanceWs.close();
        connectWebSocket();
        console.log(`🔄 WebSocket reconectado con ${SYMBOLS.length} pares`);
    }
}

async function loadMarkets() {
    if (marketsLoaded && allMarketPairs.length > 0) {
        renderMarkets();
        return;
    }
    const loading = document.getElementById('marketsLoading');
    const grid = document.getElementById('marketsGrid');
    if (loading) loading.classList.remove('hidden');
    if (grid) grid.innerHTML = '';

    try {
        const resp = await fetch('https://api.binance.com/api/v3/ticker/24hr');
        const data = await resp.json();
        allMarketPairs = data
            .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 100000)
            .map(t => ({
                symbol: t.symbol.toLowerCase(),
                name: t.symbol.replace('USDT', ''),
                price: parseFloat(t.lastPrice),
                change: parseFloat(t.priceChangePercent),
                volume: parseFloat(t.quoteVolume)
            }))
            .sort((a, b) => b.volume - a.volume);

        marketsLoaded = true;
        const countEl = document.getElementById('marketCount');
        if (countEl) countEl.textContent = `${allMarketPairs.length} pares`;
        updateFavCount();
        renderMarkets();
    } catch (e) {
        console.error('Error loading markets:', e);
        if (grid) grid.innerHTML = '<div class="col-span-full glass-card rounded-xl p-4 text-center"><p class="text-red-400 text-xs">Error al cargar mercados de Binance</p></div>';
    } finally {
        if (loading) loading.classList.add('hidden');
    }
}

function filterMarkets() {
    renderMarkets();
}

function filterMarketCategory(cat) {
    marketCategory = cat;
    // Update button styles
    document.querySelectorAll('.market-cat-btn').forEach(btn => {
        const id = btn.id.replace('mcat-', '');
        const isActive = id === cat;
        btn.className = `market-cat-btn px-3 py-1.5 text-[10px] font-medium rounded-lg border transition flex items-center gap-1.5 ${
            isActive
                ? (cat === 'favorites' ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' : 'bg-blue-500/10 border-blue-500/30 text-blue-400')
                : 'bg-[#1a1a2e] border-gray-700/30 text-gray-400'
        }`;
    });
    renderMarkets();
}

function renderMarkets() {
    const grid = document.getElementById('marketsGrid');
    if (!grid) return;

    const search = (document.getElementById('marketSearch')?.value || '').toLowerCase().trim();
    const favs = getFavorites();
    let filtered = [...allMarketPairs];

    // Apply category filter
    if (marketCategory === 'favorites') {
        filtered = filtered.filter(p => favs.includes(p.symbol));
    } else if (marketCategory !== 'all' && CRYPTO_CATEGORIES[marketCategory]) {
        const catSymbols = CRYPTO_CATEGORIES[marketCategory];
        filtered = filtered.filter(p => catSymbols.includes(p.symbol));
    }

    // Apply search
    if (search) {
        filtered = filtered.filter(p => p.name.toLowerCase().includes(search) || p.symbol.includes(search));
    }

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div class="col-span-full glass-card rounded-xl p-6 text-center">
                <i class="fas fa-${marketCategory === 'favorites' ? 'star' : 'search'} text-gray-600 text-2xl mb-2"></i>
                <p class="text-gray-500 text-xs">${
                    marketCategory === 'favorites'
                        ? 'No tienes favoritos. Ve a "Todas" y agrega pares con la estrella ⭐'
                        : 'No se encontraron pares con ese filtro'
                }</p>
            </div>`;
        return;
    }

    grid.innerHTML = filtered.map(p => {
        const isFav = favs.includes(p.symbol);
        const isUp = p.change >= 0;
        const volM = (p.volume / 1e6).toFixed(1);
        return `
            <div class="glass-card rounded-xl p-3 hover:border-gray-600/50 transition cursor-pointer group relative" onclick="toggleFavorite('${p.symbol}')">
                <div class="absolute top-2 right-2">
                    <i class="fas fa-star text-xs ${isFav ? 'text-amber-400' : 'text-gray-700 group-hover:text-gray-500'} transition"></i>
                </div>
                <div class="flex items-center gap-2 mb-2">
                    <div class="w-7 h-7 rounded-full bg-gradient-to-br ${isUp ? 'from-[#00ff41]/20 to-[#00ff41]/5' : 'from-red-500/20 to-red-500/5'} flex items-center justify-center">
                        <span class="text-[10px] font-bold ${isUp ? 'text-[#00ff41]' : 'text-red-400'}">${p.name.substring(0, 3)}</span>
                    </div>
                    <div>
                        <p class="text-white text-[11px] font-bold">${p.name}/USDT</p>
                        <p class="text-gray-600 text-[9px]">Vol: $${volM}M</p>
                    </div>
                </div>
                <div class="flex items-center justify-between">
                    <p class="text-white text-[11px] font-mono">${formatPrice(p.price)}</p>
                    <span class="text-[10px] font-bold ${isUp ? 'text-[#00ff41]' : 'text-red-400'}">
                        ${isUp ? '+' : ''}${p.change.toFixed(2)}%
                    </span>
                </div>
            </div>`;
    }).join('');
}

// ==================== AUTO TRADING (PAPER TRADING) ====================
let autoTradingEnabled = false;
let paperBalance = 10000;
let paperPositions = []; // open positions
let paperTrades = []; // closed trades history
let paperPnl = 0;

const AT_DEFAULTS = {
    riskPercent: 2,
    maxPositions: 3,
    minStrength: 60,
    riskFilter: 'green'
};

function getATConfig() {
    return {
        riskPercent: parseInt(document.getElementById('atRiskPercent')?.value || AT_DEFAULTS.riskPercent),
        maxPositions: parseInt(document.getElementById('atMaxPositions')?.value || AT_DEFAULTS.maxPositions),
        minStrength: parseInt(document.getElementById('atMinStrength')?.value || AT_DEFAULTS.minStrength),
        riskFilter: document.getElementById('atRiskFilter')?.value || AT_DEFAULTS.riskFilter,
    };
}

function toggleAutoTrading() {
    autoTradingEnabled = !autoTradingEnabled;
    const toggle = document.getElementById('atToggle');
    const label = document.getElementById('atStatusLabel');
    const icon = document.getElementById('atIcon');
    const knob = document.getElementById('atKnob');

    if (autoTradingEnabled) {
        toggle.classList.add('active');
        label.textContent = 'ACTIVO';
        label.className = 'text-[10px] text-[#00ff41] font-bold';
        icon.className = 'fas fa-robot text-[8px]';
        knob.className = 'absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-[#00ff41] transition-all duration-300 flex items-center justify-center';
        showToast('🤖 Auto Trading ACTIVADO. El sistema operará automáticamente con cada señal.', 'success');
    } else {
        toggle.classList.remove('active');
        label.textContent = 'Desactivado';
        label.className = 'text-[10px] text-gray-500';
        icon.className = 'fas fa-power-off text-[8px] text-gray-700';
        knob.className = 'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-gray-400 transition-all duration-300 flex items-center justify-center';
        showToast('🤖 Auto Trading desactivado.', 'info');
    }
    saveAutoTradingState();
}

function paperTradeSignal(signal) {
    if (!autoTradingEnabled) return;

    const cfg = getATConfig();

    // Filter by strength
    if (signal.strength.value < cfg.minStrength) return;

    // Filter by risk level (semaphore)
    if (cfg.riskFilter === 'green' && signal.riskLevel !== 'green') return;
    if (cfg.riskFilter === 'yellow' && signal.riskLevel === 'red') return;

    // Max positions check
    if (paperPositions.length >= cfg.maxPositions) return;

    // Don't open duplicate position on same symbol+direction
    if (paperPositions.some(p => p.symbolRaw === signal.symbolRaw && p.direction === signal.direction)) return;

    // Calculate position size based on risk
    const riskAmount = paperBalance * (cfg.riskPercent / 100);
    const price = signal.price;
    const fallbackDist = price * 0.005;

    let tp, sl;
    if (signal.direction === 'BUY') {
        tp = signal.resistance > price ? signal.resistance : price + fallbackDist * 2;
        sl = signal.support < price ? signal.support : price - fallbackDist;
    } else {
        tp = signal.support < price ? signal.support : price - fallbackDist * 2;
        sl = signal.resistance > price ? signal.resistance : price + fallbackDist;
    }

    // Position size: risk amount / distance to SL
    const slDist = Math.abs(price - sl);
    const quantity = slDist > 0 ? riskAmount / slDist : riskAmount / (price * 0.01);
    const positionValue = quantity * price;

    // Don't open if position value exceeds 50% of balance
    if (positionValue > paperBalance * 0.5) return;

    const position = {
        id: `pt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        symbol: signal.symbol,
        symbolRaw: signal.symbolRaw || signal.symbol.replace('/USDT', '').toLowerCase() + 'usdt',
        direction: signal.direction,
        entryPrice: price,
        quantity: quantity,
        positionValue: positionValue,
        tp: tp,
        sl: sl,
        strength: signal.strength.value,
        riskLevel: signal.riskLevel,
        openTime: Date.now(),
        currentPrice: price,
        unrealizedPnl: 0,
    };

    paperPositions.push(position);
    showToast(`🤖 Auto Trade: ${signal.direction} ${signal.symbol} @ ${formatPrice(price)} | TP: ${formatPrice(tp)} | SL: ${formatPrice(sl)}`, 'success');
    renderAutoTrading();
    saveAutoTradingState();
}

function checkPaperPositions() {
    if (paperPositions.length === 0) return;

    let changed = false;
    const toClose = [];

    for (const pos of paperPositions) {
        const sym = pos.symbolRaw;
        const livePrice = prices[sym]?.price;
        if (!livePrice) continue;

        pos.currentPrice = livePrice;

        if (pos.direction === 'BUY') {
            pos.unrealizedPnl = (livePrice - pos.entryPrice) * pos.quantity;
            if (livePrice >= pos.tp) {
                toClose.push({ pos, reason: 'TP Hit', exitPrice: pos.tp });
            } else if (livePrice <= pos.sl) {
                toClose.push({ pos, reason: 'SL Hit', exitPrice: pos.sl });
            }
        } else {
            pos.unrealizedPnl = (pos.entryPrice - livePrice) * pos.quantity;
            if (livePrice <= pos.tp) {
                toClose.push({ pos, reason: 'TP Hit', exitPrice: pos.tp });
            } else if (livePrice >= pos.sl) {
                toClose.push({ pos, reason: 'SL Hit', exitPrice: pos.sl });
            }
        }
        changed = true;
    }

    for (const { pos, reason, exitPrice } of toClose) {
        closePaperPosition(pos, exitPrice, reason);
    }

    if (changed) renderAutoTrading();
}

function closePaperPosition(pos, exitPrice, reason) {
    let pnl;
    if (pos.direction === 'BUY') {
        pnl = (exitPrice - pos.entryPrice) * pos.quantity;
    } else {
        pnl = (pos.entryPrice - exitPrice) * pos.quantity;
    }

    paperBalance += pnl;
    paperPnl += pnl;

    const trade = {
        id: pos.id,
        symbol: pos.symbol,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice: exitPrice,
        quantity: pos.quantity,
        pnl: pnl,
        pnlPercent: ((pnl / pos.positionValue) * 100).toFixed(2),
        reason: reason,
        openTime: pos.openTime,
        closeTime: Date.now(),
        result: pnl >= 0 ? 'win' : 'loss',
    };

    paperTrades.unshift(trade);
    paperPositions = paperPositions.filter(p => p.id !== pos.id);

    const emoji = pnl >= 0 ? '✅' : '❌';
    showToast(`${emoji} Trade cerrado: ${pos.symbol} ${reason} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, pnl >= 0 ? 'success' : 'error');

    renderAutoTrading();
    saveAutoTradingState();
}

function renderAutoTrading() {
    // Portfolio summary
    const balEl = document.getElementById('atBalance');
    const pnlEl = document.getElementById('atPnl');
    const winsEl = document.getElementById('atWins');
    const lossesEl = document.getElementById('atLosses');

    const wins = paperTrades.filter(t => t.result === 'win').length;
    const losses = paperTrades.filter(t => t.result === 'loss').length;
    const unrealizedTotal = paperPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);

    if (balEl) {
        balEl.textContent = `$${paperBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        balEl.className = `text-lg font-bold font-mono ${paperBalance >= 10000 ? 'text-[#00ff41]' : paperBalance >= 9000 ? 'text-white' : 'text-red-400'}`;
    }
    if (pnlEl) {
        const totalPnl = paperPnl + unrealizedTotal;
        pnlEl.textContent = `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`;
        pnlEl.className = `text-lg font-bold font-mono ${totalPnl >= 0 ? 'text-[#00ff41]' : 'text-red-400'}`;
    }
    if (winsEl) winsEl.textContent = wins;
    if (lossesEl) lossesEl.textContent = losses;

    // Open positions
    const openEl = document.getElementById('atOpenPositions');
    const openCountEl = document.getElementById('atOpenCount');
    if (openCountEl) openCountEl.textContent = paperPositions.length;

    if (openEl) {
        if (paperPositions.length === 0) {
            openEl.innerHTML = '<p class="text-gray-600 text-[11px] text-center py-4"><i class="fas fa-inbox text-lg mb-2 block"></i>No hay posiciones abiertas. ' + (autoTradingEnabled ? 'Esperando señales...' : 'Activa el Auto Trading.') + '</p>';
        } else {
            openEl.innerHTML = paperPositions.map(p => {
                const pnlColor = p.unrealizedPnl >= 0 ? 'text-[#00ff41]' : 'text-red-400';
                const pnlSign = p.unrealizedPnl >= 0 ? '+' : '';
                const elapsed = Math.floor((Date.now() - p.openTime) / 60000);
                const isBuy = p.direction === 'BUY';
                const tpDist = ((Math.abs(p.tp - p.entryPrice) / p.entryPrice) * 100).toFixed(2);
                const slDist = ((Math.abs(p.sl - p.entryPrice) / p.entryPrice) * 100).toFixed(2);
                return `
                    <div class="bg-gray-800/30 border border-gray-700/30 rounded-lg p-3">
                        <div class="flex items-center justify-between mb-2">
                            <div class="flex items-center gap-2">
                                <span class="px-2 py-0.5 rounded text-[10px] font-bold ${isBuy ? 'bg-[#00ff41]/15 text-[#00ff41]' : 'bg-red-500/15 text-red-400'}">${p.direction}</span>
                                <span class="text-white text-xs font-bold">${p.symbol}</span>
                                <span class="text-gray-500 text-[10px]">${elapsed}min</span>
                            </div>
                            <span class="${pnlColor} text-xs font-bold font-mono">${pnlSign}$${p.unrealizedPnl.toFixed(2)}</span>
                        </div>
                        <div class="grid grid-cols-4 gap-2 text-[10px]">
                            <div><span class="text-gray-500">Entrada:</span> <span class="text-white font-mono">${formatPrice(p.entryPrice)}</span></div>
                            <div><span class="text-gray-500">Actual:</span> <span class="text-white font-mono">${formatPrice(p.currentPrice)}</span></div>
                            <div><span class="text-[#00ff41]">TP (${tpDist}%):</span> <span class="text-white font-mono">${formatPrice(p.tp)}</span></div>
                            <div><span class="text-red-400">SL (${slDist}%):</span> <span class="text-white font-mono">${formatPrice(p.sl)}</span></div>
                        </div>
                        <div class="mt-2 w-full bg-gray-700 rounded-full h-1">
                            ${(() => {
                                const range = Math.abs(p.tp - p.sl);
                                const progress = p.direction === 'BUY'
                                    ? ((p.currentPrice - p.sl) / range) * 100
                                    : ((p.sl - p.currentPrice) / range) * 100;
                                const clamped = Math.max(0, Math.min(100, progress));
                                const color = clamped > 50 ? 'bg-[#00ff41]' : 'bg-red-400';
                                return `<div class="${color} h-1 rounded-full transition-all" style="width: ${clamped}%"></div>`;
                            })()}
                        </div>
                    </div>`;
            }).join('');
        }
    }

    // Trade history
    const histEl = document.getElementById('atTradeHistory');
    const countEl = document.getElementById('atTradeCount');
    if (countEl) countEl.textContent = `${paperTrades.length} trades`;

    if (histEl) {
        if (paperTrades.length === 0) {
            histEl.innerHTML = '<p class="text-gray-600 text-[11px] text-center py-4"><i class="fas fa-inbox text-lg mb-2 block"></i>El historial aparecerá cuando se cierren posiciones.</p>';
        } else {
            histEl.innerHTML = paperTrades.slice(0, 50).map(t => {
                const isWin = t.result === 'win';
                const dur = Math.floor((t.closeTime - t.openTime) / 60000);
                const time = new Date(t.closeTime).toLocaleString('es-CO', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                return `
                    <div class="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-800/20 border border-gray-800/30">
                        <div class="flex items-center gap-2">
                            <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${t.direction === 'BUY' ? 'bg-[#00ff41]/15 text-[#00ff41]' : 'bg-red-500/15 text-red-400'}">${t.direction}</span>
                            <span class="text-white text-[11px] font-medium">${t.symbol}</span>
                            <span class="text-gray-600 text-[10px]">${dur}min</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="text-[10px] ${isWin ? 'text-[#00ff41]' : 'text-red-400'} font-bold font-mono">
                                ${isWin ? '+' : ''}$${t.pnl.toFixed(2)} (${t.pnlPercent}%)
                            </span>
                            <span class="text-[10px] px-2 py-0.5 rounded-full ${isWin ? 'bg-[#00ff41]/10 text-[#00ff41]' : 'bg-red-500/10 text-red-400'}">${t.reason}</span>
                            <span class="text-gray-600 text-[9px]">${time}</span>
                        </div>
                    </div>`;
            }).join('');
        }
    }
}

async function saveAutoTradingState() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
        await db.collection('users').doc(uid).collection('settings').doc('autotrading').set({
            enabled: autoTradingEnabled,
            balance: paperBalance,
            pnl: paperPnl,
            positions: paperPositions,
            trades: paperTrades.slice(0, 100),
            config: getATConfig(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) { console.error('Error saving auto trading state:', e); }
}

function saveAutoTradingConfig() {
    saveAutoTradingState();
}

async function loadAutoTradingState() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
        const doc = await db.collection('users').doc(uid).collection('settings').doc('autotrading').get();
        if (doc.exists) {
            const d = doc.data();
            autoTradingEnabled = d.enabled || false;
            paperBalance = d.balance ?? 10000;
            paperPnl = d.pnl ?? 0;
            paperPositions = Array.isArray(d.positions) ? d.positions : [];
            paperTrades = Array.isArray(d.trades) ? d.trades : [];

            // Restore config UI
            if (d.config) {
                const sel = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
                sel('atRiskPercent', d.config.riskPercent || AT_DEFAULTS.riskPercent);
                sel('atMaxPositions', d.config.maxPositions || AT_DEFAULTS.maxPositions);
                sel('atMinStrength', d.config.minStrength || AT_DEFAULTS.minStrength);
                sel('atRiskFilter', d.config.riskFilter || AT_DEFAULTS.riskFilter);
            }

            // Restore toggle UI
            if (autoTradingEnabled) {
                const toggle = document.getElementById('atToggle');
                const label = document.getElementById('atStatusLabel');
                const icon = document.getElementById('atIcon');
                const knob = document.getElementById('atKnob');
                if (toggle) toggle.classList.add('active');
                if (label) { label.textContent = 'ACTIVO'; label.className = 'text-[10px] text-[#00ff41] font-bold'; }
                if (icon) icon.className = 'fas fa-robot text-[8px]';
                if (knob) knob.className = 'absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-[#00ff41] transition-all duration-300 flex items-center justify-center';
            }

            console.log(`🤖 Auto Trading cargado: Balance=$${paperBalance.toFixed(2)} | Posiciones=${paperPositions.length} | Trades=${paperTrades.length}`);
        }
    } catch (e) { console.error('Error loading auto trading state:', e); }
}

function resetAutoTrading() {
    if (!confirm('¿Reiniciar balance a $10,000 y borrar todo el historial de Auto Trading?')) return;
    autoTradingEnabled = false;
    paperBalance = 10000;
    paperPnl = 0;
    paperPositions = [];
    paperTrades = [];

    const toggle = document.getElementById('atToggle');
    const label = document.getElementById('atStatusLabel');
    const icon = document.getElementById('atIcon');
    const knob = document.getElementById('atKnob');
    if (toggle) toggle.classList.remove('active');
    if (label) { label.textContent = 'Desactivado'; label.className = 'text-[10px] text-gray-500'; }
    if (icon) icon.className = 'fas fa-power-off text-[8px] text-gray-700';
    if (knob) knob.className = 'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-gray-400 transition-all duration-300 flex items-center justify-center';

    renderAutoTrading();
    saveAutoTradingState();
    showToast('🔄 Auto Trading reiniciado. Balance: $10,000', 'info');
}

// Check open positions every 3 seconds against live prices
setInterval(checkPaperPositions, 3000);

// ==================== TIMEFRAME SWITCHING ====================
function updateTimeframeUI() {
    document.querySelectorAll('.timeframe-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tf === KLINE_INTERVAL);
    });
    const el = document.getElementById('currentTimeframe');
    if (el) el.textContent = KLINE_INTERVAL;
}

function changeTimeframe(newInterval) {
    if (newInterval === KLINE_INTERVAL) {
        showToast(`✅ Ya estás usando la temporalidad ${newInterval}`, 'info');
        return;
    }
    KLINE_INTERVAL = newInterval;
    updateTimeframeUI();
    console.log(`⏱️ Temporalidad cambiada a ${newInterval}`);

    // Reset signals and price history
    signals = [];
    todaySignalCount = 0;
    SYMBOLS.forEach(s => { priceHistory[s] = []; });
    renderSignals();
    updateStats();

    // Reconnect WebSocket with new interval
    if (binanceWs) {
        binanceWs.onclose = null;
        binanceWs.close();
    }
    connectWebSocket();

    showToast(`⏱️ Temporalidad cambiada a ${newInterval}`, 'info');
    saveUserConfig();
}

// ==================== FIREBASE USER CONFIG (Portable) ====================
async function loadUserConfig() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
        const doc = await db.collection('users').doc(uid).collection('settings').doc('config').get();
        if (doc.exists) {
            const cfg = doc.data();
            // Restore timeframe
            if (cfg.timeframe && ['1m', '5m', '15m', '1h'].includes(cfg.timeframe)) {
                KLINE_INTERVAL = cfg.timeframe;
            }
            // Restore favorites
            if (Array.isArray(cfg.favorites)) {
                localStorage.setItem('alphasignal_favorites', JSON.stringify(cfg.favorites));
            }
            // Restore Telegram config
            if (cfg.telegramToken) localStorage.setItem('alphaTelegramToken', cfg.telegramToken);
            if (cfg.telegramChatId) localStorage.setItem('alphaTelegramChatId', cfg.telegramChatId);
            // Restore Gemini key
            if (cfg.geminiKey) localStorage.setItem('alphaGeminiKey', cfg.geminiKey);
            // Restore present mode
            if (typeof cfg.isPresent === 'boolean') {
                isPresent = cfg.isPresent;
                updateModeUI();
            }
            console.log('☁️ Config de usuario cargada desde Firebase');
        } else {
            // First time: migrate localStorage to Firebase
            await saveUserConfig();
            console.log('☁️ Config migrada a Firebase');
        }
    } catch (e) {
        console.error('Error loading user config:', e);
    }
}

async function saveUserConfig() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
        await db.collection('users').doc(uid).collection('settings').doc('config').set({
            timeframe: KLINE_INTERVAL,
            favorites: getFavorites(),
            telegramToken: localStorage.getItem('alphaTelegramToken') || '',
            telegramChatId: localStorage.getItem('alphaTelegramChatId') || '',
            geminiKey: localStorage.getItem('alphaGeminiKey') || '',
            isPresent: isPresent,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (e) {
        console.error('Error saving user config:', e);
    }
}

function updateModeUI() {
    const toggle = document.getElementById('modeToggle');
    const label = document.getElementById('modeLabel');
    const icon = document.getElementById('modeIcon');
    if (!toggle || !label || !icon) return;
    if (isPresent) {
        toggle.classList.add('active');
        label.textContent = 'Presente';
        label.className = 'text-xs text-[#00ff41] hidden sm:inline';
        icon.className = 'fas fa-sun text-[8px]';
    } else {
        toggle.classList.remove('active');
        label.textContent = 'Away';
        label.className = 'text-xs text-gray-400 hidden sm:inline';
        icon.className = 'fas fa-moon text-[8px] text-gray-700';
    }
}

// ==================== BACKTESTING ENGINE ====================
let btRunning = false;

async function fetchBacktestKlines(symbol, interval, limit) {
    const resp = await fetch(`${BINANCE_API}/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`);
    const data = await resp.json();
    return data.map(k => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
    }));
}

function simulateTrade(signal, futureCandles) {
    const isBuy = signal.direction === 'BUY';
    const entry = signal.price;
    const tp = isBuy ? signal.resistance : signal.support;
    const sl = isBuy ? signal.support : signal.resistance;

    for (const candle of futureCandles) {
        if (isBuy) {
            if (candle.low <= sl) return { result: 'sl', exitPrice: sl, pnl: sl - entry };
            if (candle.high >= tp) return { result: 'tp', exitPrice: tp, pnl: tp - entry };
        } else {
            if (candle.high >= sl) return { result: 'sl', exitPrice: sl, pnl: entry - sl };
            if (candle.low <= tp) return { result: 'tp', exitPrice: tp, pnl: entry - tp };
        }
    }
    // Trade didn't close within the lookback period
    const lastClose = futureCandles[futureCandles.length - 1]?.close || entry;
    const openPnl = isBuy ? lastClose - entry : entry - lastClose;
    return { result: 'open', exitPrice: lastClose, pnl: openPnl };
}

async function runBacktest() {
    if (btRunning) return;
    btRunning = true;

    const pair = document.getElementById('btPair').value;
    const interval = document.getElementById('btInterval').value;
    const candles = parseInt(document.getElementById('btCandles').value);
    const lots = parseFloat(document.getElementById('btLots').value);
    const symbols = pair === 'all' ? SYMBOLS : [pair];

    // Show progress, hide previous results
    document.getElementById('btProgress').classList.remove('hidden');
    document.getElementById('btStats').classList.add('hidden');
    document.getElementById('btDetail').classList.add('hidden');
    document.getElementById('btRunBtn').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Ejecutando...';

    const engine = new SignalEngine();
    const allTrades = [];
    const pairStats = {};

    try {
        for (let si = 0; si < symbols.length; si++) {
            const sym = symbols[si];
            document.getElementById('btProgressText').textContent = `Analizando ${sym.toUpperCase()}... (${si + 1}/${symbols.length})`;
            document.getElementById('btProgressBar').style.width = `${((si) / symbols.length) * 100}%`;

            const klines = await fetchBacktestKlines(sym, interval, candles);
            if (klines.length < 30) continue;

            pairStats[sym] = { wins: 0, losses: 0, open: 0, pnl: 0 };
            const history = [];

            for (let i = 0; i < klines.length; i++) {
                history.push(klines[i]);
                if (history.length > 100) history.shift();

                if (history.length >= 50) {
                    const signal = engine.analyze(sym, history);
                    if (signal) {
                        // Look ahead up to 20 candles for TP/SL
                        const futureCandles = klines.slice(i + 1, i + 21);
                        if (futureCandles.length === 0) continue;

                        const trade = simulateTrade(signal, futureCandles);
                        const pnlDollar = trade.pnl * lots;

                        allTrades.push({
                            symbol: sym.toUpperCase(),
                            direction: signal.direction,
                            entry: signal.price,
                            tp: signal.direction === 'BUY' ? signal.resistance : signal.support,
                            sl: signal.direction === 'BUY' ? signal.support : signal.resistance,
                            exit: trade.exitPrice,
                            result: trade.result,
                            pnl: pnlDollar,
                            strength: signal.strength.value,
                            riskLevel: signal.riskLevel,
                            time: new Date(klines[i].time).toLocaleString('es-CO', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                        });

                        if (trade.result === 'tp') pairStats[sym].wins++;
                        else if (trade.result === 'sl') pairStats[sym].losses++;
                        else pairStats[sym].open++;
                        pairStats[sym].pnl += pnlDollar;

                        // Skip ahead to avoid overlapping signals
                        i += 5;
                    }
                }
            }
        }

        document.getElementById('btProgressBar').style.width = '100%';
        document.getElementById('btProgressText').textContent = 'Completado!';

        // Calculate results
        const totalTrades = allTrades.length;
        const wins = allTrades.filter(t => t.result === 'tp').length;
        const losses = allTrades.filter(t => t.result === 'sl').length;
        const totalPnl = allTrades.reduce((sum, t) => sum + t.pnl, 0);
        const winRate = totalTrades > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : 0;

        // Find best pair
        let bestPair = '—';
        let bestPnl = -Infinity;
        for (const [sym, stats] of Object.entries(pairStats)) {
            if (stats.pnl > bestPnl) { bestPnl = stats.pnl; bestPair = sym.toUpperCase().replace('USDT', ''); }
        }

        // Update stats
        document.getElementById('btTotalSignals').textContent = totalTrades;
        const winRateEl = document.getElementById('btWinRate');
        winRateEl.textContent = winRate + '%';
        winRateEl.className = `text-xl font-bold font-mono ${parseFloat(winRate) >= 50 ? 'text-[#00ff41]' : 'text-red-400'}`;
        const pnlEl = document.getElementById('btPnL');
        pnlEl.textContent = (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2);
        pnlEl.className = `text-xl font-bold font-mono ${totalPnl >= 0 ? 'text-[#00ff41]' : 'text-red-400'}`;
        document.getElementById('btBestPair').textContent = bestPair;

        // Render trade list
        const tradeList = document.getElementById('btTradeList');
        tradeList.innerHTML = allTrades.map(t => {
            const isBuy = t.direction === 'BUY';
            const resultColor = t.result === 'tp' ? 'text-[#00ff41]' : t.result === 'sl' ? 'text-red-400' : 'text-gray-500';
            const resultIcon = t.result === 'tp' ? 'check-circle' : t.result === 'sl' ? 'times-circle' : 'minus-circle';
            const pnlColor = t.pnl >= 0 ? 'text-[#00ff41]' : 'text-red-400';
            return `
                <div class="flex items-center justify-between py-1.5 px-2 rounded-lg bg-gray-800/30 text-[11px]">
                    <div class="flex items-center gap-2">
                        <i class="fas fa-${resultIcon} ${resultColor}"></i>
                        <span class="px-1.5 py-0.5 rounded text-[9px] font-bold ${isBuy ? 'bg-[#00ff41]/10 text-[#00ff41]' : 'bg-red-500/10 text-red-400'}">${t.direction}</span>
                        <span class="text-white font-medium">${t.symbol}</span>
                        <span class="text-gray-600">${t.time}</span>
                    </div>
                    <div class="flex items-center gap-3">
                        <span class="text-gray-500 font-mono">${formatPrice(t.entry)} → ${formatPrice(t.exit)}</span>
                        <span class="font-mono font-bold ${pnlColor}">${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}</span>
                    </div>
                </div>
            `;
        }).join('');

        // Show results
        setTimeout(() => {
            document.getElementById('btProgress').classList.add('hidden');
            document.getElementById('btStats').classList.remove('hidden');
            document.getElementById('btDetail').classList.remove('hidden');
        }, 500);

        console.log(`🧪 Backtest completado: ${totalTrades} señales, ${winRate}% win rate, P&L: $${totalPnl.toFixed(2)}`);

    } catch (e) {
        console.error('Error en backtest:', e);
        document.getElementById('btProgressText').textContent = 'Error: ' + e.message;
    }

    btRunning = false;
    document.getElementById('btRunBtn').innerHTML = '<i class="fas fa-play"></i> Ejecutar Backtest';
}

// ==================== TIMEFRAME ANALYSIS ====================
async function runTimeframeAnalysis() {
    if (btRunning) return;
    btRunning = true;

    const intervals = ['1m', '5m', '15m', '1h'];
    const candleCounts = { '1m': 500, '5m': 500, '15m': 500, '1h': 300 };
    const results = {};
    const testSymbols = ['btcusdt', 'ethusdt', 'solusdt'];

    document.getElementById('btProgress').classList.remove('hidden');
    document.getElementById('btTimeframeResults').classList.add('hidden');
    document.getElementById('btAnalyzeBtn').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analizando...';

    try {
        for (let ii = 0; ii < intervals.length; ii++) {
            const interval = intervals[ii];
            document.getElementById('btProgressText').textContent = `Probando ${interval}... (${ii + 1}/${intervals.length})`;
            document.getElementById('btProgressBar').style.width = `${((ii) / intervals.length) * 100}%`;

            const engine = new SignalEngine();
            let wins = 0, losses = 0, totalPnl = 0, totalSignals = 0;

            for (const sym of testSymbols) {
                const klines = await fetchBacktestKlines(sym, interval, candleCounts[interval]);
                if (klines.length < 30) continue;

                const history = [];
                for (let i = 0; i < klines.length; i++) {
                    history.push(klines[i]);
                    if (history.length > 100) history.shift();

                    if (history.length >= 50) {
                        const signal = engine.analyze(sym, history);
                        if (signal) {
                            const futureCandles = klines.slice(i + 1, i + 21);
                            if (futureCandles.length === 0) continue;
                            const trade = simulateTrade(signal, futureCandles);
                            totalSignals++;
                            if (trade.result === 'tp') wins++;
                            else if (trade.result === 'sl') losses++;
                            totalPnl += trade.pnl * 0.03;
                            i += 5;
                        }
                    }
                }
            }

            const decided = wins + losses;
            results[interval] = {
                signals: totalSignals,
                wins,
                losses,
                winRate: decided > 0 ? ((wins / decided) * 100).toFixed(1) : 0,
                pnl: totalPnl
            };
        }

        document.getElementById('btProgressBar').style.width = '100%';

        // Render timeframe comparison
        const grid = document.getElementById('btTimeframeGrid');
        let bestInterval = '1m';
        let bestScore = -Infinity;

        grid.innerHTML = intervals.map(tf => {
            const r = results[tf];
            const wr = parseFloat(r.winRate);
            // Score = winRate * 0.7 + (positive pnl bonus) * 0.3
            const score = wr * 0.7 + (r.pnl > 0 ? 30 : 0);
            if (score > bestScore) { bestScore = score; bestInterval = tf; }

            return `
                <div class="glass-card rounded-xl p-3 text-center ${tf === bestInterval ? 'border border-[#00ff41]/30' : ''}">
                    <p class="text-white font-bold text-lg mb-1">${tf}</p>
                    <p class="text-[10px] text-gray-500 mb-2">${r.signals} señales</p>
                    <p class="text-lg font-bold font-mono ${wr >= 50 ? 'text-[#00ff41]' : 'text-red-400'}">${r.winRate}%</p>
                    <p class="text-[10px] text-gray-500">Win Rate</p>
                    <p class="text-xs font-mono mt-1 ${r.pnl >= 0 ? 'text-[#00ff41]' : 'text-red-400'}">${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)}</p>
                    <p class="text-[9px] text-gray-600">P&L (0.03 lots)</p>
                </div>
            `;
        }).join('');

        // Re-render to apply best border after we know the actual best
        grid.innerHTML = intervals.map(tf => {
            const r = results[tf];
            const wr = parseFloat(r.winRate);
            const isBest = tf === bestInterval;
            return `
                <div class="glass-card rounded-xl p-3 text-center ${isBest ? 'border border-[#00ff41]/40 bg-[#00ff41]/5' : ''}">
                    <p class="text-white font-bold text-lg mb-1">${tf} ${isBest ? '⭐' : ''}</p>
                    <p class="text-[10px] text-gray-500 mb-2">${r.signals} señales</p>
                    <p class="text-lg font-bold font-mono ${wr >= 50 ? 'text-[#00ff41]' : 'text-red-400'}">${r.winRate}%</p>
                    <p class="text-[10px] text-gray-500">Win Rate</p>
                    <p class="text-xs font-mono mt-1 ${r.pnl >= 0 ? 'text-[#00ff41]' : 'text-red-400'}">${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)}</p>
                    <p class="text-[9px] text-gray-600">P&L (0.03 lots)</p>
                </div>
            `;
        }).join('');

        // Show recommendation
        document.getElementById('btTimeframeRec').innerHTML = `
            <div class="bg-[#00ff41]/5 border border-[#00ff41]/20 rounded-xl p-3 mt-3">
                <p class="text-[#00ff41] text-xs font-bold flex items-center justify-center gap-2">
                    <i class="fas fa-star"></i> Temporalidad recomendada: ${bestInterval}
                </p>
                <p class="text-gray-400 text-[10px] mt-1">Basado en win rate y P&L simulado con BTC, ETH y SOL en las últimas ${candleCounts[bestInterval]} velas.</p>
                <button onclick="changeTimeframe('${bestInterval}')" class="mt-2 px-4 py-1.5 text-[10px] font-bold rounded-lg bg-[#00ff41]/20 text-[#00ff41] hover:bg-[#00ff41]/30 transition">
                    <i class="fas fa-bolt mr-1"></i> Cambiar a ${bestInterval} ahora
                </button>
            </div>
        `;

        setTimeout(() => {
            document.getElementById('btProgress').classList.add('hidden');
            document.getElementById('btTimeframeResults').classList.remove('hidden');
        }, 300);

        console.log(`⏱️ Análisis de temporalidades completado. Mejor: ${bestInterval} (${results[bestInterval].winRate}% WR)`);

    } catch (e) {
        console.error('Error en análisis de temporalidades:', e);
        document.getElementById('btProgressText').textContent = 'Error: ' + e.message;
    }

    btRunning = false;
    document.getElementById('btAnalyzeBtn').innerHTML = '<i class="fas fa-search-plus"></i> Analizar Mejor Temporalidad';
}

console.log(`
╔══════════════════════════════════════════╗
║     ⚡ AlphaSignal Pro v3.0             ║
║     Full Suite Loaded Successfully      ║
║     Chart + Track Record + Academia     ║
║     Backtest + Mercados + Auto Trading  ║
║     Telegram + Gemini AI + PWA          ║
║     Firebase Portable User Config       ║
╚══════════════════════════════════════════╝
`);
