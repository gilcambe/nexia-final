/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — BRIDGE v6.0  (Firebase Real · Zero Hardcode)            ║
 * ║  Motor de Sincronização em Tempo Real                                ║
 * ║  Firestore onSnapshot · White-Label · Audit · Pub/Sub               ║
 * ║  Sprint 1: Tenant detectado dinamicamente via NEXIA.currentTenant   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const NexiaBridge = (() => {
    const _listeners   = {};   // { key: unsubscribeFn }
    const _cache       = {};   // último dado por evento
    const _subscribers = {};   // { event: [callbacks] }

    // ── PUB/SUB ────────────────────────────────────────────────────
    function on(event, cb) {
        if (!_subscribers[event]) _subscribers[event] = [];
        _subscribers[event].push(cb);
        if (_cache[event] !== undefined) {
            try { cb(_cache[event]); } catch(e) {}
        }
    }

    function off(event, cb) {
        if (!_subscribers[event]) return;
        _subscribers[event] = _subscribers[event].filter(f => f !== cb);
    }

    function _emit(event, data) {
        _cache[event] = data;
        (_subscribers[event] || []).forEach(cb => { try { cb(data); } catch(e) {} });
    }

    // ── HELPERS ────────────────────────────────────────────────────
    function _isReady() {
        return typeof NEXIA !== 'undefined' && NEXIA._ready && NEXIA.db !== null;
    }

    function _log(msg, type = 'info') {
        if (typeof NEXIA !== 'undefined') NEXIA.log(`[BRIDGE] ${msg}`, type);
    }

    // Retorna o slug do tenant atual (nunca retorna ID hardcoded)
    function _tenantSlug() {
        return window.NEXIA?.currentTenant?.slug || null;
    }

    // Monta referência de doc Firestore por caminho livre
    function _buildRef(path) {
        const parts = path.split('/');
        let ref = firebase.firestore();
        parts.forEach((seg, i) => {
            if (i % 2 === 0) ref = ref.collection(seg);
            else             ref = ref.doc(seg);
        });
        return ref;
    }

    // ── GENERIC REALTIME SYNC ──────────────────────────────────────
    /**
     * syncRealtime(path, callback)
     * Escuta qualquer documento do Firestore em tempo real.
     * path: 'tenants/viajante-pro/config/brand'
     */
    function syncRealtime(path, callback) {
        if (!_isReady()) { setTimeout(() => syncRealtime(path, callback), 400); return; }
        const key = 'sync:' + path;
        if (_listeners[key]) return;

        _listeners[key] = _buildRef(path).onSnapshot(snap => {
            const data = snap.data ? snap.data() : null;
            _log(`syncRealtime update: ${path}`, 'ok');
            callback(data);
            _emit(key, data);
        }, err => {
            _log(`syncRealtime error [${path}]: ${err.message}`, 'err');
        });
        _log(`syncRealtime ativo: ${path}`, 'info');
    }

    // ── FIRESTORE COLLECTION LISTENERS ────────────────────────────
    // Todos os listeners usam _tenantSlug() — sem ID hardcoded

    function watchPassengers(slug) {
        if (!slug) { _log('watchPassengers: slug indefinido', 'warn'); return; }
        const key = `passengers:${slug}`;
        if (_listeners[key] || !_isReady()) {
            if (!_isReady()) setTimeout(() => watchPassengers(slug), 400);
            return;
        }
        const ref = firebase.firestore()
            .collection('tenants').doc(slug)
            .collection('passengers').orderBy('createdAt', 'desc');

        _listeners[key] = ref.onSnapshot(snap => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            _emit('passengers:update', list);
        }, err => _emit('passengers:error', err));
        _log(`Listener ativo: passengers/${slug}`, 'ok');
    }

    function watchExpenses(slug, filters = {}) {
        if (!slug) return;
        const key = `expenses:${slug}`;
        if (_listeners[key] || !_isReady()) {
            if (!_isReady()) setTimeout(() => watchExpenses(slug, filters), 400);
            return;
        }
        let ref = firebase.firestore()
            .collection('tenants').doc(slug)
            .collection('expenses').orderBy('date', 'desc');
        if (filters.status) ref = ref.where('status', '==', filters.status);

        _listeners[key] = ref.onSnapshot(snap => {
            const items = []; let totalBRL = 0;
            snap.forEach(d => {
                const x = { id: d.id, ...d.data() };
                items.push(x);
                totalBRL += parseFloat(x.valueBRL || x.valueUSD || 0);
            });
            _emit('expenses:update', { items, totalBRL });
        }, err => _emit('expenses:error', err));
        _log(`Listener ativo: expenses/${slug}`, 'ok');
    }

    function watchMeetings(slug) {
        if (!slug) return;
        const key = `meetings:${slug}`;
        if (_listeners[key] || !_isReady()) {
            if (!_isReady()) setTimeout(() => watchMeetings(slug), 400);
            return;
        }
        const ref = firebase.firestore()
            .collection('tenants').doc(slug)
            .collection('meetings').orderBy('date', 'asc');

        _listeners[key] = ref.onSnapshot(snap => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            _emit('meetings:update', list);
        }, err => _log(`meetings error: ${err.message}`, 'err'));
        _log(`Listener ativo: meetings/${slug}`, 'ok');
    }

    function watchCadastros(slug) {
        if (!slug) return;
        const key = `cadastros:${slug}`;
        if (_listeners[key] || !_isReady()) {
            if (!_isReady()) setTimeout(() => watchCadastros(slug), 400);
            return;
        }
        const ref = firebase.firestore()
            .collection('tenants').doc(slug)
            .collection('cadastros').orderBy('criadoEm', 'desc');

        _listeners[key] = ref.onSnapshot(snap => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            _emit('cadastros:update', list);
        }, err => _emit('cadastros:error', err));
        _log(`Listener ativo: cadastros/${slug}`, 'ok');
    }

    function watchAlerts(slug) {
        if (!slug) return;
        const key = `alerts:${slug}`;
        if (_listeners[key] || !_isReady()) {
            if (!_isReady()) setTimeout(() => watchAlerts(slug), 400);
            return;
        }
        const ref = firebase.firestore()
            .collection('tenants').doc(slug)
            .collection('alerts')
            .where('active', '==', true)
            .orderBy('createdAt', 'desc')
            .limit(10);

        _listeners[key] = ref.onSnapshot(snap => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            _emit('alerts:update', list);
        }, err => _log(`alerts error: ${err.message}`, 'err'));
    }

    // ── AUTO-BOOTSTRAP: liga listeners conforme tenant atual ───────
    function bootstrapTenantListeners() {
        const slug = _tenantSlug();
        if (!slug || slug === 'guest') return;

        const tenant = window.NEXIA?.currentTenant;
        if (!tenant) return;

        const modules = tenant.modules || [];
        const hasAll  = modules.includes('all');

        if (hasAll || modules.includes('turismo'))    watchPassengers(slug);
        if (hasAll || modules.includes('financeiro')) watchExpenses(slug);
        if (hasAll || modules.includes('eventos'))    { watchMeetings(slug); watchCadastros(slug); }
        if (hasAll || modules.includes('compliance')) watchCadastros(slug);

        watchAlerts(slug);
        _log(`Bootstrap completo para tenant: ${slug}`, 'ok');
    }

    // ── WRITE OPERATIONS ──────────────────────────────────────────

    async function saveCadastro(slug, dados) {
        if (!_isReady() || !slug) throw new Error('NEXIA não pronto ou slug ausente');
        const ref = firebase.firestore()
            .collection('tenants').doc(slug)
            .collection('cadastros');
        const doc = await ref.add({
            ...dados,
            criadoEm: firebase.firestore.FieldValue.serverTimestamp(),
            status:   'pendente'
        });
        _log(`Cadastro salvo: ${doc.id} em tenants/${slug}/cadastros`, 'ok');
        return doc.id;
    }

    async function savePassenger(slug, dados) {
        if (!_isReady() || !slug) throw new Error('NEXIA não pronto ou slug ausente');
        const ref = firebase.firestore()
            .collection('tenants').doc(slug)
            .collection('passengers');
        const doc = await ref.add({
            ...dados,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        _log(`Passageiro salvo: ${doc.id}`, 'ok');
        return doc.id;
    }

    async function updateDoc(path, data) {
        if (!_isReady()) throw new Error('NEXIA não pronto');
        await _buildRef(path).update({
            ...data,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        _log(`Documento atualizado: ${path}`, 'ok');
    }

    // ── AUDIT LOG ─────────────────────────────────────────────────
    async function audit(action, payload = {}) {
        if (!_isReady()) return;
        const slug = _tenantSlug();
        if (!slug || slug === 'guest') return;
        try {
            await firebase.firestore()
                .collection('tenants').doc(slug)
                .collection('audit')
                .add({
                    action,
                    payload,
                    user:      firebase.auth?.()?.currentUser?.email || 'anon',
                    timestamp: firebase.firestore.FieldValue.serverTimestamp()
                });
        } catch(e) {
            _log(`Audit falhou: ${e.message}`, 'warn');
        }
    }

    // ── REALTIME STATS ────────────────────────────────────────────
    function watchStats(slug, cb) {
        syncRealtime(`tenants/${slug}/config/stats`, cb);
    }

    // ── DESTRUCTOR ────────────────────────────────────────────────
    function destroy(key) {
        if (_listeners[key]) { _listeners[key](); delete _listeners[key]; }
    }

    function destroyAll() {
        Object.keys(_listeners).forEach(k => { try { _listeners[k](); } catch(e) {} });
        Object.keys(_listeners).forEach(k => delete _listeners[k]);
    }

    // ── INIT ──────────────────────────────────────────────────────
    if (typeof NEXIA !== 'undefined') {
        NEXIA.onReady(bootstrapTenantListeners);
    } else {
        // Aguarda NEXIA carregar
        const iv = setInterval(() => {
            if (typeof NEXIA !== 'undefined') {
                clearInterval(iv);
                NEXIA.onReady(bootstrapTenantListeners);
            }
        }, 200);
    }

    // ── PUBLIC API ────────────────────────────────────────────────
    return {
        on,
        off,
        syncRealtime,
        watchPassengers,
        watchExpenses,
        watchMeetings,
        watchCadastros,
        watchAlerts,
        watchStats,
        saveCadastro,
        savePassenger,
        updateDoc,
        audit,
        destroy,
        destroyAll,
        getTenantSlug: _tenantSlug
    };
})();

window.NexiaBridge = NexiaBridge;
