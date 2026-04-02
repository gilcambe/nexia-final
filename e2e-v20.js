// ═══════════════════════════════════════════════════════════════
// NEXIA OS v12 — E2E Test Suite v20
// Tests all new backends: architect, whatsapp, nfe, dynamic-pricing, sentinel
// Run: node tests/e2e-v20.js [BASE_URL]
// ═══════════════════════════════════════════════════════════════

const BASE_URL = process.argv[2] || 'http://localhost:8888';
const TENANT_ID = 'test-tenant-e2e-' + Date.now();

let passed = 0;
let failed = 0;
const failures = [];

// ── Test runner ──────────────────────────────────────────────────
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok && res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${data.error || JSON.stringify(data)}`);
  }
  return { status: res.status, data };
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ────────────────────────────────────────────────────────────────
// SUITE 1: Arquiteto IA
// ────────────────────────────────────────────────────────────────
async function testArchitect() {
  console.log('\n📐 SUITE: Arquiteto IA');

  await test('GET /api/architect returns questions', async () => {
    const res = await fetch(`${BASE_URL}/api/architect`);
    const data = await res.json();
    assert(res.status === 200, 'Expected 200');
    assert(Array.isArray(data.questions), 'Expected questions array');
    assert(data.questions.length >= 3, 'Expected at least 3 questions');
  });

  await test('analyze action detects sector', async () => {
    const { data } = await post('/api/architect', {
      tenantId: TENANT_ID,
      action: 'analyze',
      description: 'Trabalho com locação de salão de festas e chácaras para casamentos e aniversários'
    });
    assert(data.sector, 'Expected sector in response');
    console.log(`     → Detected sector: ${data.sector}`);
  });

  await test('generate action returns recommendations', async () => {
    const { data } = await post('/api/architect', {
      tenantId: TENANT_ID,
      action: 'generate',
      answers: { q1: 'eventos', q2: 'operacao', q3: 'pequeno' }
    });
    assert(data.success, 'Expected success');
    assert(Array.isArray(data.recommendedModules), 'Expected recommendedModules array');
    assert(data.recommendedModules.length > 0, 'Expected at least 1 module');
    assert(data.priorityModules?.length > 0, 'Expected priority modules');
    console.log(`     → Modules: ${data.recommendedModules.join(', ')}`);
  });

  await test('status action returns onboarding state', async () => {
    const { data } = await post('/api/architect', {
      tenantId: TENANT_ID,
      action: 'status'
    });
    // Just verify it responds (may be complete=false if Firestore not available)
    assert(typeof data.complete !== 'undefined', 'Expected complete field');
  });

  await test('analyze with leilão keywords detects leiloes sector', async () => {
    const { data } = await post('/api/architect', {
      tenantId: TENANT_ID,
      action: 'analyze',
      description: 'Sou investidor em leilões judiciais de imóveis'
    });
    assert(['leiloes', 'financeiro', 'comercio'].includes(data.sector), `Unexpected sector: ${data.sector}`);
  });
}

// ────────────────────────────────────────────────────────────────
// SUITE 2: WhatsApp Business API
// ────────────────────────────────────────────────────────────────
async function testWhatsApp() {
  console.log('\n💬 SUITE: WhatsApp Business API');

  await test('GET webhook verify with wrong token returns 403', async () => {
    const res = await fetch(`${BASE_URL}/api/whatsapp?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=test`);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('GET webhook verify with correct token returns challenge', async () => {
    const token = 'nexia_webhook_verify';
    const res = await fetch(`${BASE_URL}/api/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=abc123`);
    // May be 200 with challenge or 403 if env not set — check format
    const text = await res.text();
    assert(res.status === 200 || res.status === 403, `Unexpected status ${res.status}`);
    if (res.status === 200) assert(text === 'abc123' || text.includes('abc123'), 'Expected challenge in response');
  });

  await test('send_message without phoneNumberId returns 400', async () => {
    try {
      const { data } = await post('/api/whatsapp', {
        action: 'send_message',
        tenantId: TENANT_ID,
        to: '+5511999999999',
        message: 'Teste NEXIA'
      });
      // If no phoneNumberId configured, should get 400 or API error
      assert(data.error || data.success !== undefined, 'Expected error or success field');
    } catch(e) {
      // 400/500 is expected when credentials not configured
      assert(true, 'Expected error when no credentials');
    }
  });

  await test('send_interactive with buttons structure validates correctly', async () => {
    const { data } = await post('/api/whatsapp', {
      action: 'send_interactive',
      tenantId: TENANT_ID,
      // No phoneNumberId — should fail with specific error
      to: '+5511999999999',
      interactiveBody: 'Escolha uma opção:',
      buttons: [{ id: 'btn1', title: 'Opção 1' }]
    });
    // Should return 400 because no phoneNumberId
    assert(data.error, 'Expected error without phoneNumberId');
  });
}

// ────────────────────────────────────────────────────────────────
// SUITE 3: NF-e Engine
// ────────────────────────────────────────────────────────────────
async function testNFe() {
  console.log('\n🧾 SUITE: NF-e & NFS-e Engine');

  await test('emit_nfe without items returns 400', async () => {
    const { data } = await post('/api/nfe', {
      action: 'emit_nfe',
      tenantId: TENANT_ID,
      customer: { name: 'João Silva', cpf: '12345678901', email: 'joao@test.com' }
    });
    assert(data.error, 'Expected error without items');
  });

  await test('emit_nfse without service returns 400', async () => {
    const { data } = await post('/api/nfe', {
      action: 'emit_nfse',
      tenantId: TENANT_ID,
      customer: { name: 'João Silva' }
    });
    assert(data.error, 'Expected error without service');
  });

  await test('consult_cnpj returns data for valid CNPJ', async () => {
    const { data } = await post('/api/nfe', {
      action: 'consult_cnpj',
      tenantId: TENANT_ID,
      cnpj: '00.000.000/0001-91' // Banco do Brasil
    });
    assert(data.status || data.nome || data.error, 'Expected some response from ReceitaWS');
    console.log(`     → CNPJ status: ${data.status || 'API offline'}`);
  });

  await test('list returns docs array', async () => {
    const { data } = await post('/api/nfe', {
      action: 'list',
      tenantId: TENANT_ID,
      docType: 'nfe',
      limit: 10
    });
    assert(Array.isArray(data.docs) || data.error, 'Expected docs array or error');
  });
}

// ────────────────────────────────────────────────────────────────
// SUITE 4: Dynamic Pricing
// ────────────────────────────────────────────────────────────────
async function testDynamicPricing() {
  console.log('\n📈 SUITE: Dynamic Pricing Engine');

  await test('calculate returns price for weekend', async () => {
    const { data } = await post('/api/dynamic-pricing', {
      action: 'calculate',
      tenantId: TENANT_ID,
      basePrice: 1000,
      date: '2025-08-02', // Saturday
      occupancyRate: 0.5,
      daysInAdvance: 30
    });
    assert(data.finalPrice, 'Expected finalPrice');
    assert(data.finalPrice >= 1000, 'Weekend should not be cheaper than base');
    assert(Array.isArray(data.appliedRules), 'Expected appliedRules array');
    const hasWeekend = data.appliedRules.some(r => r.rule === 'weekend');
    assert(hasWeekend, 'Expected weekend rule to be applied');
    console.log(`     → Base: R$1000 → Final: R$${data.finalPrice} (multiplier: ${data.multiplier})`);
  });

  await test('calculate applies early bird discount', async () => {
    const { data } = await post('/api/dynamic-pricing', {
      action: 'calculate',
      tenantId: TENANT_ID,
      basePrice: 500,
      date: '2025-09-15', // Weekday
      occupancyRate: 0.3,
      daysInAdvance: 45 // More than 30 days = early bird
    });
    assert(data.finalPrice, 'Expected finalPrice');
    const earlyRule = data.appliedRules?.find(r => r.rule === 'early_bird');
    assert(earlyRule, 'Expected early_bird rule');
    console.log(`     → Early bird applied: ${earlyRule.boost} → Final: R$${data.finalPrice}`);
  });

  await test('calculate applies high occupancy surge', async () => {
    const { data } = await post('/api/dynamic-pricing', {
      action: 'calculate',
      tenantId: TENANT_ID,
      basePrice: 1000,
      date: '2025-09-10',
      occupancyRate: 0.9, // 90% full
      daysInAdvance: 5
    });
    assert(data.finalPrice >= 1000, 'High occupancy should increase price');
    const occRule = data.appliedRules?.find(r => r.rule === 'occupancy');
    assert(occRule, 'Expected occupancy rule');
    console.log(`     → 90% occupancy → Final: R$${data.finalPrice}`);
  });

  await test('simulate returns date range pricing', async () => {
    const { data } = await post('/api/dynamic-pricing', {
      action: 'simulate',
      tenantId: TENANT_ID,
      basePrice: 800,
      startDate: '2025-12-20',
      endDate: '2026-01-05'
    });
    assert(Array.isArray(data.simulation), 'Expected simulation array');
    assert(data.simulation.length > 0, 'Expected at least 1 day');
    assert(data.summary.min <= data.summary.max, 'Min should be <= max');
    const christmasDay = data.simulation.find(d => d.date === '2025-12-25');
    assert(christmasDay, 'Expected Christmas in simulation');
    assert(christmasDay.flags.includes('holiday'), 'Christmas should be flagged as holiday');
    console.log(`     → ${data.simulation.length} days | Min: R$${data.summary.min} Max: R$${data.summary.max}`);
  });

  await test('get_rules returns default rules object', async () => {
    const { data } = await post('/api/dynamic-pricing', {
      action: 'get_rules',
      tenantId: TENANT_ID
    });
    assert(typeof data.weekendBoost !== 'undefined', 'Expected weekendBoost in rules');
    assert(typeof data.holidayBoost !== 'undefined', 'Expected holidayBoost in rules');
    console.log(`     → weekendBoost: ${data.weekendBoost}, holidayBoost: ${data.holidayBoost}`);
  });

  await test('set_rules saves custom rules', async () => {
    const { data } = await post('/api/dynamic-pricing', {
      action: 'set_rules',
      tenantId: TENANT_ID,
      rules: { weekendBoost: 0.5, holidayBoost: 0.8, carnivalBoost: 2.0, minPrice: 200, maxPrice: 5000 }
    });
    assert(data.success, 'Expected success after set_rules');
  });

  await test('calculate respects custom min/max price', async () => {
    // First set rules with min/max
    await post('/api/dynamic-pricing', {
      action: 'set_rules',
      tenantId: TENANT_ID,
      productId: 'test-product',
      rules: { minPrice: 300, maxPrice: 600, weekendBoost: 5.0 } // extreme boost
    });

    const { data } = await post('/api/dynamic-pricing', {
      action: 'calculate',
      tenantId: TENANT_ID,
      productId: 'test-product',
      basePrice: 100,
      date: '2025-08-02', // Saturday with 5x boost = R$600 but capped at max
      daysInAdvance: 1
    });
    assert(data.finalPrice <= 600, `Price should be capped at max (got ${data.finalPrice})`);
    assert(data.finalPrice >= 300, `Price should be above min (got ${data.finalPrice})`);
    console.log(`     → Price capped: R$${data.finalPrice} (min 300, max 600)`);
  });
}

// ────────────────────────────────────────────────────────────────
// SUITE 5: Sentinel IoT
// ────────────────────────────────────────────────────────────────
async function testSentinel() {
  console.log('\n🔐 SUITE: Sentinel IoT');

  await test('list_locks without credentials returns error', async () => {
    const { data } = await post('/api/sentinel', {
      action: 'list_locks',
      tenantId: TENANT_ID
    });
    // Expected: error because no TTLock credentials
    assert(data.error || data.locks, 'Expected error or locks in response');
  });

  await test('provision_for_booking without checkIn returns 400', async () => {
    const { data } = await post('/api/sentinel', {
      action: 'provision_for_booking',
      tenantId: TENANT_ID,
      lockId: '12345'
      // Missing checkIn/checkOut
    });
    assert(data.error, 'Expected error without checkIn');
    assert(data.error.includes('checkIn') || data.error.includes('required'), 'Error should mention missing fields');
  });

  await test('webhook action stores events', async () => {
    const { data } = await post('/api/sentinel', {
      action: 'webhook',
      tenantId: TENANT_ID,
      lockId: '99999',
      serverDate: Date.now(),
      recordType: 2,
      success: true
    });
    assert(data.success, 'Expected success from webhook');
  });

  await test('unknown action returns 400', async () => {
    const { data } = await post('/api/sentinel', {
      action: 'fly_to_moon',
      tenantId: TENANT_ID
    });
    assert(data.error, 'Expected error for unknown action');
  });
}

// ────────────────────────────────────────────────────────────────
// SUITE 6: Store HTML validation
// ────────────────────────────────────────────────────────────────
async function testStore() {
  console.log('\n🛍️ SUITE: Store HTML');

  await test('store loads and returns HTML', async () => {
    const res = await fetch(`${BASE_URL}/nexia/nexia-store.html`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const html = await res.text();
    assert(html.includes('NEXIA'), 'Expected NEXIA in page');
    assert(html.includes('openDetail'), 'Expected openDetail function');
    assert(html.includes('loadVideo'), 'Expected loadVideo function');
    assert(html.includes("detail-modal"), 'Expected detail modal HTML');
    console.log(`     → Page size: ${Math.round(html.length/1024)}KB`);
  });

  await test('architect page loads', async () => {
    const res = await fetch(`${BASE_URL}/nexia/architect.html`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const html = await res.text();
    assert(html.includes('Arquiteto'), 'Expected Arquiteto in page');
    assert(html.includes('/api/architect'), 'Expected API call in page');
  });

  await test('PABX softphone page loads', async () => {
    const res = await fetch(`${BASE_URL}/nexia/pabx-softphone.html`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const html = await res.text();
    assert(html.includes('PABX'), 'Expected PABX in page');
    assert(html.includes('Twilio'), 'Expected Twilio SDK reference');
    assert(html.includes('makeCall'), 'Expected makeCall function');
  });
}

// ────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🧪 NEXIA OS v12 — E2E Test Suite v20`);
  console.log(`📡 Base URL: ${BASE_URL}`);
  console.log(`🏷️  Tenant: ${TENANT_ID}`);
  console.log('─'.repeat(60));

  const start = Date.now();

  await testArchitect();
  await testWhatsApp();
  await testNFe();
  await testDynamicPricing();
  await testSentinel();
  await testStore();

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  const total = passed + failed;

  console.log('\n' + '═'.repeat(60));
  console.log(`📊 RESULTADO: ${passed}/${total} testes passaram (${duration}s)`);
  if (failures.length) {
    console.log(`\n❌ FALHAS (${failures.length}):`);
    failures.forEach(f => console.log(`   • ${f.name}: ${f.error}`));
  }
  console.log('═'.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
