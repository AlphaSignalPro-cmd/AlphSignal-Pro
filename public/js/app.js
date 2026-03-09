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
const SYMBOLS = ['btcusdt', 'ethusdt', 'bnbusdt', 'solusdt', 'xrpusdt', 'dogeusdt', 'adausdt', 'avaxusdt'];
const KLINE_INTERVAL = '1m';

// ==================== STATE ====================
let binanceWs = null;
let isPresent = false;
let signals = [];
let prices = {};
let priceHistory = {};
let countdownIntervals = {};
let reconnectAttempts = 0;
let todaySignalCount = 0;
let alertAudio = null;
let signalEngine = null;

// ==================== INIT ====================
auth.onAuthStateChanged(async (user) => {
    if (user) {
        showDashboard();
        connectWebSocket();
        initAudio();
        requestNotificationPermission();
        await loadTrackRecordFromFirestore();
        await loadLessonsFromFirestore();
    } else {
        showLogin();
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
        // Save user profile to Firestore
        await db.collection('users').doc(cred.user.uid).set({
            email: email,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            plan: 'free',
            active: true
        });
        showToast('🎉 ¡Cuenta creada exitosamente!', 'success');
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
        if (priceHistory[symbol].length >= 26 && signalEngine) {
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
    const toggle = document.getElementById('modeToggle');
    const label = document.getElementById('modeLabel');
    const icon = document.getElementById('modeIcon');

    if (isPresent) {
        toggle.classList.add('active');
        label.textContent = 'Presente';
        label.className = 'text-xs text-[#00ff41] hidden sm:inline';
        icon.className = 'fas fa-sun text-[8px]';
        showToast('🔊 Modo Presente activado. Recibirás alertas sonoras y visuales.', 'success');
    } else {
        toggle.classList.remove('active');
        label.textContent = 'Away';
        label.className = 'text-xs text-gray-400 hidden sm:inline';
        icon.className = 'fas fa-moon text-[8px] text-gray-700';
        showToast('📱 Modo Away activado. Recibirás notificaciones Push.', 'info');
    }
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
        await db.collection('signals').add({
            ...signal,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            userId: auth.currentUser?.uid
        });
    } catch (error) {
        console.error('Error saving signal to Firestore:', error);
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
    const views = ['dashboard', 'chart', 'trackrecord', 'academia', 'config'];
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
    if (tabName === 'config') loadConfigValues();
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
            .orderBy('timestamp', 'desc').limit(100).get();
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
    const entry = {
        id: signal.id,
        symbol: signal.symbol,
        direction: signal.direction,
        price: signal.price,
        strength: signal.strength.value,
        riskLevel: signal.riskLevel,
        rsi: signal.rsi,
        timestamp: signal.timestamp,
        verified: false,
        result: null,
        priceAfter: null,
    };
    trackRecord.unshift(entry);
    saveTrackRecordEntry(entry);

    // Schedule verification after 5 minutes
    setTimeout(() => verifySignal(entry.id), 5 * 60 * 1000);

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

async function verifySignal(signalId) {
    const entry = trackRecord.find(t => t.id === signalId);
    if (!entry || entry.verified) return;

    try {
        const resp = await fetch(`${BINANCE_API}/ticker/price?symbol=${entry.symbol.toUpperCase()}`);
        const data = await resp.json();
        const currentPrice = parseFloat(data.price);

        entry.priceAfter = currentPrice;
        entry.verified = true;

        if (entry.direction === 'BUY') {
            entry.result = currentPrice > entry.price ? 'win' : 'loss';
        } else {
            entry.result = currentPrice < entry.price ? 'win' : 'loss';
        }

        entry.changePercent = ((currentPrice - entry.price) / entry.price * 100).toFixed(2);

        saveTrackRecordEntry(entry);
        renderTrackRecord();
        showToast(`📊 Señal verificada: ${entry.symbol} → ${entry.result === 'win' ? '✅ Acierto' : '❌ Fallo'}`, entry.result === 'win' ? 'success' : 'error');
    } catch (e) {
        console.error('Error verifying signal:', e);
    }
}

function renderTrackRecord() {
    const verified = trackRecord.filter(t => t.verified);
    const wins = verified.filter(t => t.result === 'win').length;
    const losses = verified.filter(t => t.result === 'loss').length;
    const total = verified.length;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '--';

    // Calculate streak
    let streak = 0;
    let streakType = '';
    for (const t of verified) {
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
    renderPerformanceChart(verified);

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
            resultBadge = t.result === 'win'
                ? `<span class="text-[10px] text-[#00ff41] px-2 py-0.5 rounded-full bg-[#00ff41]/10">✅ +${Math.abs(t.changePercent)}%</span>`
                : `<span class="text-[10px] text-red-400 px-2 py-0.5 rounded-full bg-red-500/10">❌ ${t.changePercent}%</span>`;
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
function saveGeminiConfig() {
    const key = document.getElementById('geminiApiKey').value.trim();
    if (!key) { showToast('Ingresa tu API Key de Gemini', 'warning'); return; }
    localStorage.setItem('alphaGeminiKey', key);
    showToast('🤖 Gemini AI activado. Las señales serán validadas con IA.', 'success');
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
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${key}`, {
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

console.log(`
╔══════════════════════════════════════════╗
║     ⚡ AlphaSignal Pro v2.0             ║
║     Full Suite Loaded Successfully      ║
║     Chart + Track Record + Academia     ║
║     Telegram + Gemini AI + PWA          ║
╚══════════════════════════════════════════╝
`);
