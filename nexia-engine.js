/**
 * ═══════════════════════════════════════════════════════════════════
 * NEXIA OS — MODULE ENGINE v5.2 (PRODUCTION)
 * core/nexia-engine.js
 *
 * Provides:
 *   NexiaTenantEngine   — detects and caches current tenant
 *   NexiaModuleEngine   — loads/registers active modules per tenant
 *   NexiaEventBus       — lightweight pub/sub for cross-module comms
 *   NexiaThemeEngine    — applies brand theme from Firestore
 *   NexiaRuntime        — master orchestrator (boot sequence)
 *
 * Include after core/config.js and core/bridge.js.
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

// ════════════════════════════════════════════════════════════════════
// 1. EVENT BUS
// ════════════════════════════════════════════════════════════════════
const NexiaEventBus = (() => {
  const _handlers = {};

  function on(event, handler) {
    if (!_handlers[event]) _handlers[event] = [];
    _handlers[event].push(handler);
  }

  function off(event, handler) {
    if (!_handlers[event]) return;
    _handlers[event] = _handlers[event].filter(h => h !== handler);
  }

  function emit(event, data) {
    (_handlers[event] || []).forEach(h => {
      try { h(data); } catch (e) { console.warn(`[EventBus] ${event}:`, e); }
    });
    // Wildcard listeners
    (_handlers['*'] || []).forEach(h => {
      try { h({ event, data }); } catch (e) {}
    });
  }

  function once(event, handler) {
    const wrapper = (data) => { handler(data); off(event, wrapper); };
    on(event, wrapper);
  }

  return { on, off, emit, once };
})();

window.NexiaEventBus = NexiaEventBus;

// ════════════════════════════════════════════════════════════════════
// 2. TENANT ENGINE
// ════════════════════════════════════════════════════════════════════
const NexiaTenantEngine = (() => {

  let _tenant = null;

  // ── Hard-coded known tenants (fast path, no Firestore call needed)
  const KNOWN_TENANTS = {
    'CES_2027_BR':   { id: 'CES_2027_BR',   name: 'CES Brasil 2027',   vertical: 'events',  color: '#0057FF' },
    'VP_AGENCIA_01': { id: 'VP_AGENCIA_01', name: 'Viajante Pro',      vertical: 'tourism', color: '#B8935A' },
    'NEXIA_MASTER':  { id: 'NEXIA_MASTER',  name: 'NEXIA Corporation', vertical: 'saas',    color: '#00E5FF' },
  };

  function detectFromPath() {
    const path = window.location.pathname.toLowerCase();
    if (path.includes('/ces/'))           return 'CES_2027_BR';
    if (path.includes('/viajante-pro/'))  return 'VP_AGENCIA_01';
    if (path.includes('/nexia/'))         return 'NEXIA_MASTER';
    if (path.includes('ces-'))            return 'CES_2027_BR';
    if (path.includes('vp-'))            return 'VP_AGENCIA_01';
    return null;
  }

  function detectFromURL() {
    const p = new URLSearchParams(window.location.search);
    return p.get('tenant') || p.get('tenantId') || null;
  }

  function detectFromSubdomain() {
    const host = window.location.hostname;
    const sub  = host.split('.')[0];
    if (sub && sub !== 'nexiaos' && sub !== 'localhost' && sub !== 'www') {
      return sub.toUpperCase().replace(/-/g, '_');
    }
    return null;
  }

  function detectFromSession() {
    const session = window._nexiaSession;
    if (session?.tenantId && session.tenantId !== '*') return session.tenantId;
    return null;
  }

  async function detect() {
    if (_tenant) return _tenant;

    // Priority: session > URL param > path > subdomain
    const id = detectFromSession()
            || detectFromURL()
            || detectFromPath()
            || detectFromSubdomain()
            || 'NEXIA_MASTER';

    // Known tenant fast path
    if (KNOWN_TENANTS[id]) {
      _tenant = { ...KNOWN_TENANTS[id] };
      NexiaEventBus.emit('tenant:ready', _tenant);
      return _tenant;
    }

    // Unknown tenant — fetch from Firestore
    if (typeof firebase !== 'undefined' && firebase.apps?.length) {
      try {
        const snap = await firebase.firestore().collection('tenants').doc(id).get();
        if (snap.exists) {
          const d = snap.data();
          _tenant = {
            id,
            name:     d.name     || id,
            vertical: d.vertical || 'default',
            color:    d.config?.primaryColor || '#0057FF',
            plan:     d.plan     || 'trial',
            status:   d.status   || 'active',
          };
          NexiaEventBus.emit('tenant:ready', _tenant);
          return _tenant;
        }
      } catch (e) {
        console.warn('[TenantEngine] Firestore:', e.message);
      }
    }

    // Fallback
    _tenant = { id, name: id, vertical: 'default', color: '#0057FF' };
    NexiaEventBus.emit('tenant:ready', _tenant);
    return _tenant;
  }

  function current() { return _tenant; }
  function reset()   { _tenant = null; }

  return { detect, current, reset, KNOWN_TENANTS };
})();

window.NexiaTenantEngine = NexiaTenantEngine;

// ════════════════════════════════════════════════════════════════════
// 3. MODULE ENGINE
// ════════════════════════════════════════════════════════════════════
const NexiaModuleEngine = (() => {

  const _registry  = {};   // { moduleId: { init, render, destroy } }
  const _active    = {};   // { moduleId: instanceData }
  const _listeners = [];   // cleanup fns

  // ── Register a module definition ─────────────────────────────────
  function register(id, definition) {
    if (_registry[id]) {
      console.warn(`[ModuleEngine] Module "${id}" already registered`);
    }
    _registry[id] = definition;
  }

  // ── Load active modules for a tenant from Firestore ──────────────
  async function loadForTenant(tenantId) {
    if (!tenantId) return [];

    let moduleIds = [];

    if (typeof firebase !== 'undefined' && firebase.apps?.length) {
      try {
        const snap = await firebase.firestore()
          .collection('tenants').doc(tenantId)
          .collection('modules').get();
        snap.forEach(d => {
          if (d.data().status !== 'inactive') moduleIds.push(d.id);
        });
      } catch (e) {
        console.info('[ModuleEngine] Firestore modules indisponível, usando defaults:', e.message);
        // Fall back to defaults
        moduleIds = ['notifications', 'payments', 'analytics'];
      }
    }

    // Boot each registered module that is active for this tenant
    for (const id of moduleIds) {
      if (_registry[id] && !_active[id]) {
        try {
          const instance = await _registry[id].init?.({ tenantId });
          _active[id] = instance || { id, tenantId, status: 'running' };
          NexiaEventBus.emit('module:loaded', { id, tenantId });
        } catch (e) {
          console.warn(`[ModuleEngine] Failed to init "${id}":`, e.message);
        }
      }
    }

    return moduleIds;
  }

  // ── Check if module is active ─────────────────────────────────────
  function isActive(id) { return !!_active[id]; }

  // ── Get module instance ───────────────────────────────────────────
  function get(id) { return _active[id] || null; }

  // ── Deactivate a module ───────────────────────────────────────────
  function deactivate(id) {
    if (_registry[id]?.destroy) {
      try { _registry[id].destroy(_active[id]); } catch (e) {}
    }
    delete _active[id];
    NexiaEventBus.emit('module:deactivated', { id });
  }

  function list() { return Object.keys(_active); }

  return { register, loadForTenant, isActive, get, deactivate, list };
})();

window.NexiaModuleEngine = NexiaModuleEngine;

// ════════════════════════════════════════════════════════════════════
// 4. THEME ENGINE
// ════════════════════════════════════════════════════════════════════
const NexiaThemeEngine = (() => {

  const LS_KEY = 'nexia_theme_v2_';

  function _hexToRgb(hex) {
    const h = hex.replace('#', '');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function _contrast(hex) {
    const { r, g, b } = _hexToRgb(hex);
    // WCAG relative luminance
    const luminance = 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
    return luminance > 0.5 ? '#000000' : '#FFFFFF';
  }

  function apply(cfg) {
    if (!cfg) return;
    const root = document.documentElement;
    const hex  = cfg.primaryColor || cfg.color || '#0057FF';
    const { r, g, b } = _hexToRgb(hex);
    const rgb = `${r},${g},${b}`;

    root.style.setProperty('--brand',          hex);
    root.style.setProperty('--brand-rgb',      rgb);
    root.style.setProperty('--brand-dim',      `rgba(${rgb},0.12)`);
    root.style.setProperty('--brand-glow',     `rgba(${rgb},0.25)`);
    root.style.setProperty('--brand-contrast', _contrast(hex));
    root.style.setProperty('--blue',           hex);
    root.style.setProperty('--gold',           hex);
    root.style.setProperty('--accent',         hex);

    if (cfg.secondaryColor) root.style.setProperty('--brand-secondary', cfg.secondaryColor);
    if (cfg.fontFamily)     root.style.setProperty('--ff', `'${cfg.fontFamily}',sans-serif`);
    if (cfg.buttonRadius)   root.style.setProperty('--radius-btn', cfg.buttonRadius);

    // Text content replacements
    if (cfg.brandName) {
      document.querySelectorAll('[data-brand-name]').forEach(el => { el.textContent = cfg.brandName; });
    }
    if (cfg.tagline) {
      document.querySelectorAll('[data-brand-tagline]').forEach(el => { el.textContent = cfg.tagline; });
    }
    if (cfg.logoUrl) {
      document.querySelectorAll('[data-brand-logo]').forEach(el => { el.src = cfg.logoUrl; });
    }

    NexiaEventBus.emit('theme:applied', cfg);
  }

  function loadAndApply(tenantId, appTarget) {
    const cacheKey = LS_KEY + tenantId + '_' + (appTarget || 'default');

    // Apply cached immediately (zero FOUC)
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) apply(JSON.parse(cached));
    } catch (e) {}

    // Then fetch live from Firestore
    if (typeof firebase === 'undefined' || !firebase.apps?.length) return;

    const docPath = `tenants/${tenantId}/config/brand${appTarget ? '_' + appTarget : ''}`;
    const parts   = docPath.split('/');
    let ref = firebase.firestore();
    parts.forEach((seg, i) => {
      ref = i % 2 === 0 ? ref.collection(seg) : ref.doc(seg);
    });

    ref.onSnapshot(snap => {
      if (!snap.exists) {
        // Fall back to theme doc
        firebase.firestore()
          .collection('tenants').doc(tenantId)
          .collection('config').doc('theme')
          .get().then(t => {
            if (t.exists) {
              const cfg = t.data();
              apply(cfg);
              try { localStorage.setItem(cacheKey, JSON.stringify(cfg)); } catch (e) {}
            }
          }).catch(() => {});
        return;
      }
      const cfg = snap.data();
      apply(cfg);
      try { localStorage.setItem(cacheKey, JSON.stringify(cfg)); } catch (e) {}
    }, () => {});
  }

  return { apply, loadAndApply, contrast: _contrast };
})();

window.NexiaThemeEngine = NexiaThemeEngine;
// Alias for compatibility with existing bridge.js
if (typeof NexiaTheme === 'undefined') window.NexiaTheme = NexiaThemeEngine;

// ════════════════════════════════════════════════════════════════════
// 5. LANDING PAGE RENDERER (JSON Layout → DOM)
// ════════════════════════════════════════════════════════════════════
const NexiaLandingRenderer = (() => {

  const BLOCK_RENDERERS = {

    hero({ data }) {
      const { headline = '', subheadline = '', cta = 'Começar', ctaUrl = '#', bgImage = '', bgColor = '#07090E' } = data;
      return `
        <section style="min-height:60vh;display:flex;align-items:center;justify-content:center;
          background:${bgImage ? `url('${bgImage}') center/cover` : bgColor};padding:80px 24px;text-align:center">
          <div style="max-width:700px">
            <h1 style="font-family:var(--ffd,Sora),sans-serif;font-size:clamp(2rem,5vw,3.5rem);
              color:#fff;margin:0 0 16px;line-height:1.1">${headline}</h1>
            ${subheadline ? `<p style="color:rgba(255,255,255,.65);font-size:clamp(14px,2vw,18px);margin:0 0 32px">${subheadline}</p>` : ''}
            ${cta ? `<a href="${ctaUrl}" style="display:inline-block;background:var(--brand,#0057FF);color:var(--brand-contrast,#fff);
              padding:14px 36px;border-radius:var(--radius-btn,8px);font-weight:600;font-size:15px;text-decoration:none;
              transition:opacity .2s" onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">${cta}</a>` : ''}
          </div>
        </section>`;
    },

    text({ data }) {
      const { content = '', align = 'left', maxWidth = '720px' } = data;
      return `
        <section style="padding:64px 24px;background:#fff">
          <div style="max-width:${maxWidth};margin:0 auto;text-align:${align};
            font-size:16px;line-height:1.75;color:#334155">${content}</div>
        </section>`;
    },

    image({ data }) {
      const { src = '', alt = '', caption = '', maxWidth = '900px' } = data;
      return `
        <section style="padding:48px 24px;background:#F8FAFC;text-align:center">
          <div style="max-width:${maxWidth};margin:0 auto">
            <img src="${src}" alt="${alt}" style="width:100%;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.08)">
            ${caption ? `<p style="margin-top:12px;font-size:13px;color:#94A3B8">${caption}</p>` : ''}
          </div>
        </section>`;
    },

    features({ data }) {
      const { title = '', items = [] } = data;
      const itemsHtml = items.map(it => `
        <div style="padding:28px;background:#fff;border-radius:12px;border:1px solid #E2E8F0;text-align:center">
          <div style="font-size:36px;margin-bottom:14px">${it.icon || '⚡'}</div>
          <h3 style="font-weight:600;color:#1F2937;margin:0 0 8px;font-size:16px">${it.title || ''}</h3>
          <p style="color:#64748B;font-size:14px;line-height:1.6;margin:0">${it.desc || ''}</p>
        </div>`).join('');
      return `
        <section style="padding:80px 24px;background:#F8FAFC">
          <div style="max-width:1100px;margin:0 auto">
            ${title ? `<h2 style="text-align:center;font-size:clamp(1.5rem,3vw,2.2rem);color:#1F2937;margin:0 0 48px">${title}</h2>` : ''}
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px">${itemsHtml}</div>
          </div>
        </section>`;
    },

    gallery({ data }) {
      const { title = '', images = [] } = data;
      const imgs = images.map(img =>
        `<img src="${img.src || img}" alt="${img.alt || ''}" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px">`
      ).join('');
      return `
        <section style="padding:64px 24px;background:#fff">
          <div style="max-width:1100px;margin:0 auto">
            ${title ? `<h2 style="text-align:center;margin:0 0 36px;color:#1F2937">${title}</h2>` : ''}
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px">${imgs}</div>
          </div>
        </section>`;
    },

    pricing({ data }) {
      const { title = 'Planos', plans = [] } = data;
      const plansHtml = plans.map(plan => `
        <div style="padding:32px;background:#fff;border-radius:16px;
          border:${plan.featured ? '2px solid var(--brand,#0057FF)' : '1px solid #E2E8F0'};
          ${plan.featured ? 'box-shadow:0 0 0 4px rgba(0,87,255,.08)' : ''}">
          ${plan.featured ? `<div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--brand,#0057FF);margin-bottom:12px">★ Mais popular</div>` : ''}
          <h3 style="margin:0 0 6px;font-size:18px;color:#1F2937">${plan.name || ''}</h3>
          <div style="font-size:2rem;font-weight:700;color:var(--brand,#0057FF);margin:12px 0">${plan.price || ''}</div>
          <p style="color:#64748B;font-size:13px;margin:0 0 20px">${plan.desc || ''}</p>
          <ul style="list-style:none;padding:0;margin:0 0 24px">
            ${(plan.features || []).map(f => `<li style="padding:7px 0;font-size:14px;color:#334155;border-bottom:1px solid #F1F5F9">✓ ${f}</li>`).join('')}
          </ul>
          <a href="${plan.ctaUrl || '#'}" style="display:block;text-align:center;padding:12px;
            background:${plan.featured ? 'var(--brand,#0057FF)' : 'transparent'};
            color:${plan.featured ? '#fff' : 'var(--brand,#0057FF)'};
            border:2px solid var(--brand,#0057FF);border-radius:8px;font-weight:600;text-decoration:none">
            ${plan.cta || 'Começar'}
          </a>
        </div>`).join('');
      return `
        <section style="padding:80px 24px;background:#F8FAFC">
          <div style="max-width:1100px;margin:0 auto">
            <h2 style="text-align:center;margin:0 0 48px;color:#1F2937">${title}</h2>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;align-items:start">${plansHtml}</div>
          </div>
        </section>`;
    },

    cta({ data }) {
      const { headline = '', subheadline = '', cta = 'Falar Conosco', ctaUrl = '#', bgColor = '' } = data;
      const bg = bgColor || 'linear-gradient(135deg,var(--brand,#0057FF),rgba(0,87,255,.7))';
      return `
        <section style="padding:96px 24px;background:${bg};text-align:center">
          <div style="max-width:600px;margin:0 auto">
            <h2 style="color:#fff;font-size:clamp(1.6rem,3vw,2.5rem);margin:0 0 14px">${headline}</h2>
            ${subheadline ? `<p style="color:rgba(255,255,255,.7);font-size:16px;margin:0 0 32px">${subheadline}</p>` : ''}
            <a href="${ctaUrl}" style="display:inline-block;background:#fff;color:var(--brand,#0057FF);
              padding:14px 40px;border-radius:99px;font-weight:700;font-size:15px;text-decoration:none">${cta}</a>
          </div>
        </section>`;
    },

    checkout({ data }) {
      const { title = 'Adquirir', productId = '', price = '' } = data;
      return `
        <section style="padding:64px 24px;background:#fff;text-align:center">
          <div style="max-width:440px;margin:0 auto;padding:36px;border:1px solid #E2E8F0;border-radius:16px">
            <h2 style="margin:0 0 8px;color:#1F2937">${title}</h2>
            ${price ? `<div style="font-size:2rem;font-weight:700;color:var(--brand,#0057FF);margin:12px 0">${price}</div>` : ''}
            <button onclick="NexiaPayment && NexiaPayment.initiateCheckout({productId:'${productId}'})"
              style="display:block;width:100%;padding:14px;background:var(--brand,#0057FF);color:#fff;
              border:none;border-radius:99px;font-size:15px;font-weight:600;cursor:pointer;margin-top:20px">
              Comprar Agora →
            </button>
          </div>
        </section>`;
    },
  };

  function render(layout, container) {
    if (!Array.isArray(layout) || !container) return;
    container.innerHTML = layout.map(block => {
      const renderer = BLOCK_RENDERERS[block.type];
      if (!renderer) return `<div style="padding:20px;background:#FEF2F2;color:#991B1B;font-size:12px">Unknown block: ${block.type}</div>`;
      try   { return renderer(block); }
      catch (e) { return `<div style="padding:20px;background:#FEF2F2;color:#991B1B;font-size:12px">Block error: ${e.message}</div>`; }
    }).join('');
  }

  async function loadAndRender(tenantId, pageId, container) {
    if (!tenantId || !container) return;

    // Show skeleton
    container.innerHTML = `<div style="padding:80px;text-align:center;color:#94A3B8">Carregando página...</div>`;

    if (typeof firebase === 'undefined' || !firebase.apps?.length) return;

    try {
      const snap = await firebase.firestore()
        .collection('tenants').doc(tenantId)
        .collection('pages').doc(pageId || 'landing')
        .get();

      if (!snap.exists) {
        container.innerHTML = `<div style="padding:80px;text-align:center;color:#94A3B8">Página não publicada ainda.</div>`;
        return;
      }

      const page = snap.data();
      render(page.layout || [], container);
      NexiaEventBus.emit('page:rendered', { tenantId, pageId, title: page.title });
    } catch (e) {
      console.warn('[LandingRenderer]', e.message);
    }
  }

  return { render, loadAndRender, BLOCK_RENDERERS };
})();

window.NexiaLandingRenderer = NexiaLandingRenderer;

// ════════════════════════════════════════════════════════════════════
// 6. NEXIA RUNTIME — Master Boot Sequence
// ════════════════════════════════════════════════════════════════════
const NexiaRuntime = (() => {

  let _booted = false;

  async function boot() {
    if (_booted) return;
    _booted = true;

    // Wait for Firebase
    await new Promise(resolve => {
      const check = () => {
        if (typeof firebase !== 'undefined' && firebase.apps?.length) resolve();
        else setTimeout(check, 100);
      };
      check();
      setTimeout(resolve, 5000); // max 5s
    });

    // 1. Detect tenant
    const tenant = await NexiaTenantEngine.detect();
    NexiaEventBus.emit('runtime:tenant', tenant);

    // 2. Apply theme
    if (tenant.id && tenant.id !== 'NEXIA_MASTER') {
      NexiaThemeEngine.loadAndApply(tenant.id, 'landing');
    }

    // 3. Load active modules
    const moduleIds = await NexiaModuleEngine.loadForTenant(tenant.id);
    NexiaEventBus.emit('runtime:modules', { tenant: tenant.id, modules: moduleIds });

    // 4. Register SW
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    NexiaEventBus.emit('runtime:ready', { tenant, modules: moduleIds });
    return { tenant, modules: moduleIds };
  }

  // Auto-boot on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    setTimeout(boot, 0);
  }

  return { boot };
})();

window.NexiaRuntime = NexiaRuntime;

// Register built-in modules
NexiaModuleEngine.register('payments', {
  init({ tenantId }) {
    return { id: 'payments', tenantId, ready: typeof NexiaPayment !== 'undefined' };
  }
});

NexiaModuleEngine.register('notifications', {
  init({ tenantId }) {
    return { id: 'notifications', tenantId, ready: typeof NexiaNotifications !== 'undefined' };
  }
});

NexiaModuleEngine.register('analytics', {
  async init({ tenantId }) {
    // Track page view in Firestore
    if (typeof firebase !== 'undefined' && firebase.apps?.length) {
      try {
        await firebase.firestore()
          .collection('tenants').doc(tenantId)
          .collection('analytics').doc('overview')
          .set({ visitors: firebase.firestore.FieldValue.increment(1), updatedAt: new Date() }, { merge: true });
      } catch (e) {}
    }
    return { id: 'analytics', tenantId };
  }
});

if (typeof NEXIA !== 'undefined' && NEXIA.log) {
  NEXIA.log('NexiaEngine v5.2 — TenantEngine + ModuleEngine + ThemeEngine + Runtime ONLINE', 'ok');
} else {
  console.log('%c[NexiaEngine] v5.2 online', 'color:#00E5FF;font-weight:bold');
}
