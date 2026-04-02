// ═══════════════════════════════════════════════════════════════
// NEXIA Dynamic Pricing Engine — Yield Management
// POST /api/dynamic-pricing
// actions: calculate, get_rules, set_rules, simulate,
//          apply_to_event, get_history, ai_suggest_rules
// ═══════════════════════════════════════════════════════════════
let admin, db;
try {
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    const saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!saRaw && !saB64) throw new Error('FIREBASE_SERVICE_ACCOUNT não configurada');
    const saJson = saRaw || Buffer.from(saB64, 'base64').toString('utf8');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)) });
  }
  db = admin.firestore();
} catch (e) {
  console.warn('[NEXIA] Firebase indisponivel:', e.message);
  db = null;
}

// ── Feriados nacionais brasileiros 2024-2026 ────────────────────
const NATIONAL_HOLIDAYS = new Set([
  '01-01','04-21','05-01','09-07','10-12','11-02','11-15','11-20','12-25',
  // Carnaval 2025
  '2025-03-03','2025-03-04','2025-03-05',
  // Carnaval 2026
  '2026-02-16','2026-02-17','2026-02-18',
  // Semana Santa 2025
  '2025-04-17','2025-04-18','2025-04-19','2025-04-20',
  // Semana Santa 2026
  '2026-04-02','2026-04-03','2026-04-05',
]);

function isHoliday(date) {
  const d = new Date(date);
  const mmdd = `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const yyyymmdd = `${d.getFullYear()}-${mmdd}`;
  return NATIONAL_HOLIDAYS.has(mmdd) || NATIONAL_HOLIDAYS.has(yyyymmdd);
}

function isWeekend(date) {
  const d = new Date(date);
  return d.getDay() === 0 || d.getDay() === 6;
}

function isCarnival(date) {
  const d = new Date(date);
  const yyyymmdd = d.toISOString().split('T')[0];
  const carnaval = ['2025-03-03','2025-03-04','2025-03-05','2026-02-16','2026-02-17','2026-02-18'];
  return carnaval.includes(yyyymmdd);
}

function isHighSeason(date) {
  const d = new Date(date);
  const month = d.getMonth() + 1;
  // Jul-Ago, Dez-Jan são alta temporada
  return [1, 7, 8, 12].includes(month);
}

function isLowSeason(date) {
  const d = new Date(date);
  const month = d.getMonth() + 1;
  // Mar, Mai, Jun são baixa temporada
  return [3, 5, 6].includes(month);
}

// ── Core pricing algorithm ──────────────────────────────────────
function calculatePrice(basePrice, context, rules) {
  const {
    date,
    occupancyRate = 0,      // 0.0 to 1.0
    daysInAdvance = 0,      // how far in advance booking is
    leadCount = 0,           // how many people looking at same slot
    historicalDemand = 0.5   // avg occupancy for this slot historically
  } = context;

  let multiplier = 1.0;
  const appliedRules = [];

  // ── Rule: Weekend ─────────────────────────────────────────────
  if (isWeekend(date) && rules.weekendBoost !== 0) {
    const boost = rules.weekendBoost ?? 0.3;
    multiplier += boost;
    appliedRules.push({ rule: 'weekend', boost, desc: 'Fim de semana' });
  }

  // ── Rule: Holiday ─────────────────────────────────────────────
  if (isHoliday(date) && rules.holidayBoost !== 0) {
    const boost = rules.holidayBoost ?? 0.5;
    multiplier += boost;
    appliedRules.push({ rule: 'holiday', boost, desc: 'Feriado nacional' });
  }

  // ── Rule: Carnival ────────────────────────────────────────────
  if (isCarnival(date) && rules.carnivalBoost !== 0) {
    const boost = rules.carnivalBoost ?? 1.5;
    multiplier += boost;
    appliedRules.push({ rule: 'carnival', boost, desc: 'Carnaval' });
  }

  // ── Rule: High season ─────────────────────────────────────────
  if (isHighSeason(date) && rules.highSeasonBoost !== 0) {
    const boost = rules.highSeasonBoost ?? 0.2;
    multiplier += boost;
    appliedRules.push({ rule: 'high_season', boost, desc: 'Alta temporada' });
  }

  // ── Rule: Low season ──────────────────────────────────────────
  if (isLowSeason(date) && rules.lowSeasonDiscount !== 0) {
    const discount = -(rules.lowSeasonDiscount ?? 0.15);
    multiplier += discount;
    appliedRules.push({ rule: 'low_season', boost: discount, desc: 'Baixa temporada' });
  }

  // ── Rule: Occupancy-based dynamic pricing ─────────────────────
  if (occupancyRate > 0 && rules.occupancyPricing !== false) {
    const thresholds = rules.occupancyThresholds || [
      { min: 0.8, boost: 0.25, desc: 'Ocupação alta (+80%)' },
      { min: 0.6, boost: 0.10, desc: 'Ocupação moderada (+60%)' },
      { min: 0,   boost: 0,    desc: 'Ocupação normal' }
    ];
    const matched = thresholds.find(t => occupancyRate >= t.min);
    if (matched && matched.boost !== 0) {
      multiplier += matched.boost;
      appliedRules.push({ rule: 'occupancy', boost: matched.boost, desc: matched.desc });
    }
  }

  // ── Rule: Early bird discount ─────────────────────────────────
  if (daysInAdvance > 0 && rules.earlyBirdDiscount !== 0) {
    const earlyDays = rules.earlyBirdDays || 30;
    const earlyDiscount = -(rules.earlyBirdDiscount ?? 0.1);
    if (daysInAdvance >= earlyDays) {
      multiplier += earlyDiscount;
      appliedRules.push({ rule: 'early_bird', boost: earlyDiscount, desc: `Reserva antecipada (+${earlyDays} dias)` });
    }
  }

  // ── Rule: Last minute surge ───────────────────────────────────
  if (daysInAdvance >= 0 && daysInAdvance <= 3 && rules.lastMinuteSurge !== 0) {
    const surge = rules.lastMinuteSurge ?? 0.2;
    multiplier += surge;
    appliedRules.push({ rule: 'last_minute', boost: surge, desc: 'Reserva de última hora' });
  }

  // ── Rule: High demand (many leads viewing same slot) ──────────
  if (leadCount > 0 && rules.demandSurge !== false) {
    const surgeThreshold = rules.demandSurgeThreshold || 5;
    if (leadCount >= surgeThreshold) {
      const surge = rules.demandSurgeBoost ?? 0.15;
      multiplier += surge;
      appliedRules.push({ rule: 'high_demand', boost: surge, desc: `Alta demanda (${leadCount} interessados)` });
    }
  }

  // ── Apply min/max price bounds ────────────────────────────────
  const minPrice = rules.minPrice || basePrice * 0.5;
  const maxPrice = rules.maxPrice || basePrice * 3;
  const rawPrice = basePrice * Math.max(0.1, multiplier);
  const finalPrice = Math.min(maxPrice, Math.max(minPrice, Math.round(rawPrice / 10) * 10));

  return {
    basePrice,
    multiplier: Math.round(multiplier * 100) / 100,
    calculatedPrice: Math.round(rawPrice),
    finalPrice,
    discount: finalPrice < basePrice ? basePrice - finalPrice : 0,
    premium: finalPrice > basePrice ? finalPrice - basePrice : 0,
    appliedRules,
    context: { date, occupancyRate, daysInAdvance, leadCount }
  };
}

const { requireBearerAuth, makeHeaders} = require('./middleware');

exports.handler = async (event) => {
  const headers = makeHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  // CORRIGIDO v38: regras de pricing são dados sensíveis de negócio
    const _authErr = await requireBearerAuth(event);
  if (_authErr) return _authErr;
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, tenantId } = body;

    if (!action || !tenantId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'action and tenantId required' }) };

    // ── ACTION: calculate ─────────────────────────────────────
    if (action === 'calculate') {
      const { basePrice, date, occupancyRate, daysInAdvance, leadCount, productId } = body;
      if (!basePrice || !date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'basePrice and date required' }) };

      // Load tenant rules
      const rulesDoc = await db.collection('tenants').doc(tenantId)
        .collection('pricing_rules').doc(productId || 'default').get();
      const rules = rulesDoc.exists ? rulesDoc.data() : {};

      const result = calculatePrice(basePrice, {
        date, occupancyRate: occupancyRate || 0,
        daysInAdvance: daysInAdvance ?? 30, leadCount: leadCount || 0
      }, rules);

      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── ACTION: simulate — Preview pricing for a date range ───
    if (action === 'simulate') {
      const { basePrice, startDate, endDate, productId } = body;
      if (!basePrice || !startDate || !endDate) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'basePrice, startDate, endDate required' }) };
      }

      const rulesDoc = await db.collection('tenants').doc(tenantId)
        .collection('pricing_rules').doc(productId || 'default').get();
      const rules = rulesDoc.exists ? rulesDoc.data() : {};

      const simulation = [];
      const start = new Date(startDate);
      const end = new Date(endDate);
      const maxDays = 90;
      let count = 0;

      for (let d = new Date(start); d <= end && count < maxDays; d.setDate(d.getDate() + 1), count++) {
        const dateStr = d.toISOString().split('T')[0];
        const result = calculatePrice(basePrice, { date: dateStr, occupancyRate: 0, daysInAdvance: 30 }, rules);
        simulation.push({
          date: dateStr,
          dayOfWeek: ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][d.getDay()],
          finalPrice: result.finalPrice,
          multiplier: result.multiplier,
          flags: [
            isWeekend(dateStr) ? 'weekend' : null,
            isHoliday(dateStr) ? 'holiday' : null,
            isCarnival(dateStr) ? 'carnival' : null,
            isHighSeason(dateStr) ? 'high_season' : null,
            isLowSeason(dateStr) ? 'low_season' : null
          ].filter(Boolean)
        });
      }

      const minP = Math.min(...simulation.map(s => s.finalPrice));
      const maxP = Math.max(...simulation.map(s => s.finalPrice));
      const avgP = Math.round(simulation.reduce((s, d) => s + d.finalPrice, 0) / simulation.length);

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ simulation, summary: { min: minP, max: maxP, avg: avgP, days: simulation.length } })
      };
    }

    // ── ACTION: get_rules ──────────────────────────────────────
    if (action === 'get_rules') {
      const { productId } = body;
      const snap = await db.collection('tenants').doc(tenantId)
        .collection('pricing_rules').doc(productId || 'default').get();

      const defaultRules = {
        weekendBoost: 0.3,
        holidayBoost: 0.5,
        carnivalBoost: 1.5,
        highSeasonBoost: 0.2,
        lowSeasonDiscount: 0.15,
        occupancyPricing: true,
        occupancyThresholds: [
          { min: 0.8, boost: 0.25, desc: 'Ocupação alta' },
          { min: 0.6, boost: 0.10, desc: 'Ocupação moderada' }
        ],
        earlyBirdDiscount: 0.10,
        earlyBirdDays: 30,
        lastMinuteSurge: 0.20,
        demandSurge: true,
        demandSurgeThreshold: 5,
        demandSurgeBoost: 0.15,
        minPrice: null,
        maxPrice: null
      };

      return {
        statusCode: 200, headers,
        body: JSON.stringify(snap.exists ? snap.data() : defaultRules)
      };
    }

    // ── ACTION: set_rules ──────────────────────────────────────
    if (action === 'set_rules') {
      const { productId, rules } = body;
      if (!rules) return { statusCode: 400, headers, body: JSON.stringify({ error: 'rules required' }) };

      await db.collection('tenants').doc(tenantId)
        .collection('pricing_rules').doc(productId || 'default')
        .set({ ...rules, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── ACTION: apply_to_event ─────────────────────────────────
    if (action === 'apply_to_event') {
      const { eventId, basePrice, productId } = body;
      if (!eventId || !basePrice) return { statusCode: 400, headers, body: JSON.stringify({ error: 'eventId and basePrice required' }) };

      const eventDoc = await db.collection('tenants').doc(tenantId)
        .collection('events').doc(eventId).get();
      if (!eventDoc.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event not found' }) };

      const eventData = eventDoc.data();
      const eventDate = eventData.date || eventData.startDate;
      const occupancyRate = eventData.confirmedCount / (eventData.capacity || 100);
      const daysInAdvance = Math.max(0, Math.floor((new Date(eventDate) - new Date()) / (1000 * 60 * 60 * 24)));

      const rulesDoc = await db.collection('tenants').doc(tenantId)
        .collection('pricing_rules').doc(productId || 'default').get();
      const rules = rulesDoc.exists ? rulesDoc.data() : {};

      const result = calculatePrice(basePrice, { date: eventDate, occupancyRate, daysInAdvance }, rules);

      // Apply price to event
      await eventDoc.ref.update({
        dynamicPrice: result.finalPrice,
        basePrice,
        priceMultiplier: result.multiplier,
        priceAppliedRules: result.appliedRules,
        priceUpdatedAt: FieldValue.serverTimestamp()
      });

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...result }) };
    }

    // ── ACTION: ai_suggest_rules ───────────────────────────────
    if (action === 'ai_suggest_rules') {
      // Load historical booking data
      const historySnap = await db.collection('tenants').doc(tenantId)
        .collection('events')
        .where('status', '==', 'completed')
        .orderBy('createdAt', 'desc')
        .limit(50).get();

      const history = historySnap.docs.map(d => {
        const data = d.data();
        return {
          date: data.date || data.startDate,
          occupancyRate: (data.confirmedCount || 0) / (data.capacity || 100),
          revenue: data.revenue || 0,
          basePrice: data.basePrice || 0,
          dynamicPrice: data.dynamicPrice || data.basePrice || 0
        };
      });

      // If no Anthropic key, return smart defaults based on data
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY || history.length < 5) {
        return {
          statusCode: 200, headers,
          body: JSON.stringify({
            suggestedRules: {
              weekendBoost: 0.35,
              holidayBoost: 0.60,
              carnivalBoost: 1.80,
              highSeasonBoost: 0.25,
              lowSeasonDiscount: 0.12,
              occupancyPricing: true,
              earlyBirdDiscount: 0.10,
              lastMinuteSurge: 0.25,
              demandSurge: true
            },
            explanation: 'Regras padrão recomendadas para o seu setor com base nas melhores práticas de yield management.',
            basedOnEvents: history.length
          })
        };
      }

      // Use Claude to analyze and suggest optimal rules
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `Você é um especialista em yield management. Analise estes dados históricos de eventos e sugira as melhores regras de precificação dinâmica.

Dados dos últimos ${history.length} eventos (sample):
${JSON.stringify(history.slice(0, 10), null, 2)}

Retorne APENAS um JSON válido com estas chaves e valores numéricos:
{
  "weekendBoost": 0.0-1.0,
  "holidayBoost": 0.0-2.0,
  "carnivalBoost": 0.5-3.0,
  "highSeasonBoost": 0.0-0.5,
  "lowSeasonDiscount": 0.0-0.3,
  "earlyBirdDiscount": 0.0-0.2,
  "earlyBirdDays": 7-60,
  "lastMinuteSurge": 0.0-0.5,
  "demandSurgeBoost": 0.0-0.3,
  "explanation": "texto curto explicando as escolhas"
}`
          }]
        })
      });

      const aiData = await res.json();
      let suggested = {};
      try {
        const raw = aiData.content?.[0]?.text || '{}';
        suggested = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch (e) {
        suggested = { explanation: 'Não foi possível gerar sugestão personalizada.' };
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          suggestedRules: suggested,
          explanation: suggested.explanation,
          basedOnEvents: history.length
        })
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error('Dynamic pricing error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
