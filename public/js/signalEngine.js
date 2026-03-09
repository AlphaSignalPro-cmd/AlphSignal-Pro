// ============================================
// AlphaSignal Pro - Motor de Señales v2.0
// RSI + EMA(9/21/50) + ATR + MACD Real + Volume
// Filtro de tendencia + volatilidad dinámica
// ============================================

class SignalEngine {
    constructor() {
        this.lastSignals = {};
        this.cooldown = 60000;
    }

    // ==================== INDICADORES ====================

    calculateRSI(closes, period = 14) {
        if (closes.length < period + 1) return null;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const change = closes[i] - closes[i - 1];
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }
        let avgGain = gains / period;
        let avgLoss = losses / period;
        for (let i = period + 1; i < closes.length; i++) {
            const change = closes[i] - closes[i - 1];
            avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
            avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
        }
        if (avgLoss === 0) return 100;
        return 100 - (100 / (1 + avgGain / avgLoss));
    }

    calculateEMA(closes, period) {
        if (closes.length < period) return null;
        const multiplier = 2 / (period + 1);
        let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < closes.length; i++) {
            ema = (closes[i] - ema) * multiplier + ema;
        }
        return ema;
    }

    calculateEMASeries(closes, period) {
        if (closes.length < period) return [];
        const multiplier = 2 / (period + 1);
        let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
        const series = [ema];
        for (let i = period; i < closes.length; i++) {
            ema = (closes[i] - ema) * multiplier + ema;
            series.push(ema);
        }
        return series;
    }

    calculateMACD(closes) {
        if (closes.length < 35) return null;
        const ema12Series = this.calculateEMASeries(closes, 12);
        const ema26Series = this.calculateEMASeries(closes, 26);
        if (ema12Series.length === 0 || ema26Series.length === 0) return null;
        // Align series: ema12 starts at index 12, ema26 at index 26
        // MACD line values start where both exist
        const offset = 26 - 12; // ema12 has 14 more values
        const macdLine = [];
        const len26 = ema26Series.length;
        for (let i = 0; i < len26; i++) {
            macdLine.push(ema12Series[i + offset] - ema26Series[i]);
        }
        // Signal line = EMA(9) of MACD line
        if (macdLine.length < 9) return { macd: macdLine[macdLine.length - 1] || 0, signal: 0, histogram: 0 };
        const signalSeries = this.calculateEMASeries(macdLine, 9);
        const macdValue = macdLine[macdLine.length - 1];
        const signalValue = signalSeries[signalSeries.length - 1];
        const histogram = macdValue - signalValue;
        // Previous values for crossover detection
        const prevMacd = macdLine.length >= 2 ? macdLine[macdLine.length - 2] : macdValue;
        const prevSignal = signalSeries.length >= 2 ? signalSeries[signalSeries.length - 2] : signalValue;
        return {
            macd: macdValue,
            signal: signalValue,
            histogram,
            crossUp: prevMacd <= prevSignal && macdValue > signalValue,
            crossDown: prevMacd >= prevSignal && macdValue < signalValue,
            bullish: macdValue > signalValue,
            bearish: macdValue < signalValue
        };
    }

    calculateATR(candles, period = 14) {
        if (candles.length < period + 1) return null;
        const trueRanges = [];
        for (let i = 1; i < candles.length; i++) {
            const high = candles[i].high;
            const low = candles[i].low;
            const prevClose = candles[i - 1].close;
            trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
        }
        if (trueRanges.length < period) return null;
        let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < trueRanges.length; i++) {
            atr = (atr * (period - 1) + trueRanges[i]) / period;
        }
        return atr;
    }

    analyzeVolume(candles) {
        if (candles.length < 20) return { spike: false, ratio: 1 };
        const recentVol = candles.slice(-5).reduce((a, c) => a + c.volume, 0) / 5;
        const avgVol = candles.slice(-20).reduce((a, c) => a + c.volume, 0) / 20;
        const ratio = avgVol > 0 ? recentVol / avgVol : 1;
        return { spike: ratio > 1.5, ratio: Math.round(ratio * 100) / 100 };
    }

    detectLevels(candles, atr) {
        if (candles.length < 20) return { support: 0, resistance: 0 };
        const recent = candles.slice(-20);
        const lows = recent.map(c => c.low).sort((a, b) => a - b);
        const highs = recent.map(c => c.high).sort((a, b) => b - a);
        let support = lows[Math.floor(lows.length * 0.1)];
        let resistance = highs[Math.floor(highs.length * 0.1)];
        // Use ATR for minimum spread if available, otherwise 0.5% of price
        const currentPrice = recent[recent.length - 1].close;
        const minSpread = atr ? atr * 1.5 : currentPrice * 0.005;
        if (resistance - support < minSpread) {
            const mid = (support + resistance) / 2;
            support = mid - minSpread / 2;
            resistance = mid + minSpread / 2;
        }
        return { support, resistance };
    }

    // ==================== STRENGTH ====================

    calculateStrength(rsi, emaCross, volumeSpike, macd, trendAligned) {
        let score = 0;
        // RSI in extreme zone (max 25)
        if (rsi < 25 || rsi > 75) score += 25;
        else if (rsi < 30 || rsi > 70) score += 20;
        else if (rsi < 35 || rsi > 65) score += 15;
        else if (rsi < 40 || rsi > 60) score += 5;
        // EMA cross (max 20)
        if (emaCross) score += 20;
        // Volume confirmation (max 15)
        if (volumeSpike) score += 15;
        // MACD real confirmation (max 25)
        if (macd) {
            if (macd.crossUp || macd.crossDown) score += 25;
            else if (Math.abs(macd.histogram) > 0) score += 10;
        }
        // Trend alignment with EMA50 (max 15)
        if (trendAligned) score += 15;
        const percentage = Math.min(score, 100);
        if (percentage >= 75) return { value: percentage, label: 'Muy Fuerte', risk: 'low' };
        if (percentage >= 55) return { value: percentage, label: 'Fuerte', risk: 'low' };
        if (percentage >= 35) return { value: percentage, label: 'Moderada', risk: 'medium' };
        return { value: percentage, label: 'Débil', risk: 'high' };
    }

    // ==================== ANÁLISIS PRINCIPAL ====================

    analyze(symbol, candles) {
        if (candles.length < 50) return null;
        const now = Date.now();
        if (this.lastSignals[symbol] && (now - this.lastSignals[symbol]) < this.cooldown) return null;

        const closes = candles.map(c => c.close);
        const rsi = this.calculateRSI(closes);
        const ema9 = this.calculateEMA(closes, 9);
        const ema21 = this.calculateEMA(closes, 21);
        const ema50 = this.calculateEMA(closes, 50);
        const prevCloses = closes.slice(0, -1);
        const prevEma9 = this.calculateEMA(prevCloses, 9);
        const prevEma21 = this.calculateEMA(prevCloses, 21);
        const macd = this.calculateMACD(closes);
        const atr = this.calculateATR(candles);
        const volume = this.analyzeVolume(candles);
        const levels = this.detectLevels(candles, atr);

        if (rsi === null || ema9 === null || ema21 === null) return null;

        const emaCrossUp = ema9 > ema21 && prevEma9 !== null && prevEma21 !== null && prevEma9 <= prevEma21;
        const emaCrossDown = ema9 < ema21 && prevEma9 !== null && prevEma21 !== null && prevEma9 >= prevEma21;
        const currentPrice = closes[closes.length - 1];

        // Trend filter: EMA50 direction
        const trendUp = ema50 !== null && currentPrice > ema50;
        const trendDown = ema50 !== null && currentPrice < ema50;

        let direction = null;
        let reasons = [];
        let eli5Reasons = [];
        let trendAligned = false;

        // ===== BUY CONDITIONS =====
        if (rsi < 35 && ema9 > ema21) {
            direction = 'BUY';
            reasons.push(`RSI sobrevendido (${rsi.toFixed(1)})`);
            eli5Reasons.push('💚 El precio bajó tanto que es como encontrar algo en oferta');
            reasons.push('EMA rápida por encima de la lenta');
            eli5Reasons.push('🏃 La corriente del río va hacia arriba con fuerza');
        } else if (emaCrossUp && rsi < 55) {
            direction = 'BUY';
            reasons.push('Cruce de EMAs alcista');
            eli5Reasons.push('🚦 El semáforo cambió a verde: la corriente del río empuja hacia arriba');
            if (volume.spike) {
                reasons.push(`Volumen alto (${volume.ratio}x)`);
                eli5Reasons.push('📢 Mucha gente está comprando, hay mucho ruido en el mercado');
            }
        } else if (rsi < 25) {
            direction = 'BUY';
            reasons.push(`RSI extremo (${rsi.toFixed(1)})`);
            eli5Reasons.push('🎯 El precio está TAN bajo que es como un resorte a punto de saltar');
        }

        // ===== SELL CONDITIONS =====
        if (!direction) {
            if (rsi > 70 && ema9 < ema21) {
                direction = 'SELL';
                reasons.push(`RSI sobrecomprado (${rsi.toFixed(1)})`);
                eli5Reasons.push('🔴 El precio subió demasiado, como un globo a punto de reventar');
                reasons.push('EMA rápida por debajo de la lenta');
                eli5Reasons.push('⬇️ La corriente del río cambió de dirección, va hacia abajo');
            } else if (emaCrossDown && rsi > 50) {
                direction = 'SELL';
                reasons.push('Cruce de EMAs bajista');
                eli5Reasons.push('🚦 El semáforo cambió a rojo: la corriente del río empuja hacia abajo');
                if (volume.spike) {
                    reasons.push(`Volumen alto (${volume.ratio}x)`);
                    eli5Reasons.push('📢 Mucha gente está vendiendo, hay pánico en el mercado');
                }
            } else if (rsi > 80) {
                direction = 'SELL';
                reasons.push(`RSI extremo (${rsi.toFixed(1)})`);
                eli5Reasons.push('🎈 El globo está SUPER inflado, puede reventar en cualquier momento');
            }
        }

        if (!direction) return null;

        // ===== MACD CONFIRMATION =====
        if (macd) {
            if (direction === 'BUY' && macd.bullish) {
                reasons.push(`MACD alcista (H: ${macd.histogram.toFixed(4)})`);
                eli5Reasons.push('📊 El motor interno del precio empuja hacia arriba');
            } else if (direction === 'SELL' && macd.bearish) {
                reasons.push(`MACD bajista (H: ${macd.histogram.toFixed(4)})`);
                eli5Reasons.push('📊 El motor interno del precio empuja hacia abajo');
            }
        }

        // ===== TREND FILTER (EMA50) =====
        if (direction === 'BUY' && trendUp) {
            trendAligned = true;
            reasons.push('Tendencia mayor alcista (EMA50)');
            eli5Reasons.push('🌊 La marea grande también sube, eso es buena señal');
        } else if (direction === 'SELL' && trendDown) {
            trendAligned = true;
            reasons.push('Tendencia mayor bajista (EMA50)');
            eli5Reasons.push('🌊 La marea grande también baja, eso confirma la caída');
        } else if (ema50 !== null) {
            reasons.push('⚠ Contra-tendencia (EMA50)');
            eli5Reasons.push('⚠️ Cuidado: vas contra la corriente grande, más riesgo');
        }

        // ===== ATR-BASED TP/SL =====
        let support = levels.support;
        let resistance = levels.resistance;
        if (atr) {
            if (direction === 'BUY') {
                support = Math.min(support, currentPrice - atr * 1.5);
                resistance = Math.max(resistance, currentPrice + atr * 2);
            } else {
                support = Math.min(support, currentPrice - atr * 2);
                resistance = Math.max(resistance, currentPrice + atr * 1.5);
            }
        }

        const emaCross = emaCrossUp || emaCrossDown;
        const strength = this.calculateStrength(rsi, emaCross, volume.spike, macd, trendAligned);

        // ===== RISK LEVEL =====
        let riskLevel = 'yellow';
        if (strength.value >= 65 && trendAligned && volume.ratio > 1.2) riskLevel = 'green';
        else if (strength.value < 35 || (!trendAligned && !volume.spike)) riskLevel = 'red';

        // ===== FILTER: discard weak signals without trend =====
        if (strength.value < 25) return null;

        this.lastSignals[symbol] = now;

        return {
            id: `${symbol}_${now}`,
            symbol: symbol.replace('usdt', '').toUpperCase() + '/USDT',
            symbolRaw: symbol,
            direction,
            price: currentPrice,
            rsi: Math.round(rsi * 10) / 10,
            ema9: Math.round(ema9 * 100) / 100,
            ema21: Math.round(ema21 * 100) / 100,
            ema50: ema50 ? Math.round(ema50 * 100) / 100 : null,
            macd: macd ? Math.round(macd.macd * 10000) / 10000 : 0,
            macdSignal: macd ? Math.round(macd.signal * 10000) / 10000 : 0,
            macdHistogram: macd ? Math.round(macd.histogram * 10000) / 10000 : 0,
            atr: atr ? Math.round(atr * 10000) / 10000 : 0,
            volume: volume.ratio,
            volumeSpike: volume.spike,
            support: Math.round(support * 100) / 100,
            resistance: Math.round(resistance * 100) / 100,
            trendAligned,
            strength,
            riskLevel,
            reasons,
            eli5Reasons,
            eli5Summary: direction === 'BUY'
                ? '🟢 Parece buen momento para comprar. El precio está bajo y las señales dicen que puede subir.'
                : '🔴 Parece buen momento para vender. El precio está alto y las señales dicen que puede bajar.',
            timestamp: now,
            expired: false,
            aiValidated: false,
            aiComment: 'Módulo de IA pendiente de configurar'
        };
    }
}
