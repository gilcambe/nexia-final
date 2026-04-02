/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — DATA LAYER v7.0                                 ║
 * ║  CRUD Firestore · Multi-Tenant · clients/tasks/meetings     ║
 * ╚══════════════════════════════════════════════════════════════╝
 * Estrutura: data/{tenantSlug}/{collection}/{docId}
 */
'use strict';

const NexiaData = (() => {
  // ── Referência de coleção com tenant correto ───────────────────
  function col(name) {
    return NEXIA.getCollection(name);
  }

  // ── Timestamp do servidor ──────────────────────────────────────
  function ts() {
    return firebase.firestore.FieldValue.serverTimestamp();
  }

  // ═══════════════════════════════════════════════════════
  // GENÉRICO — CRUD base
  // ═══════════════════════════════════════════════════════
  async function create(collection, data) {
    const payload = { ...data, createdAt: ts(), updatedAt: ts() };
    const ref = await col(collection).add(payload);
    return { id: ref.id, ...payload };
  }

  async function update(collection, id, data) {
    const payload = { ...data, updatedAt: ts() };
    await col(collection).doc(id).update(payload);
    return { id, ...payload };
  }

  async function remove(collection, id) {
    await col(collection).doc(id).delete();
    return { id };
  }

  async function getOne(collection, id) {
    const snap = await col(collection).doc(id).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  async function getAll(collection, options = {}) {
    let q = col(collection);
    if (options.orderBy) q = q.orderBy(options.orderBy, options.orderDir || 'asc');
    if (options.limit)   q = q.limit(options.limit);
    if (options.where)   for (const [f, op, v] of options.where) q = q.where(f, op, v);
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  function subscribe(collection, callback, options = {}) {
    let q = col(collection);
    if (options.orderBy) q = q.orderBy(options.orderBy, options.orderDir || 'asc');
    if (options.where)   for (const [f, op, v] of options.where) q = q.where(f, op, v);
    return q.onSnapshot(snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(docs);
    });
  }

  // ═══════════════════════════════════════════════════════
  // CLIENTS
  // ═══════════════════════════════════════════════════════
  const clients = {
    create: (data) => create('clients', { ...data, status: data.status || 'ativo' }),
    update: (id, data) => update('clients', id, data),
    delete: (id) => remove('clients', id),
    get:    (id) => getOne('clients', id),
    list:   (opts) => getAll('clients', { orderBy:'createdAt', orderDir:'desc', ...opts }),
    watch:  (cb, opts) => subscribe('clients', cb, { orderBy:'createdAt', orderDir:'desc', ...opts })
  };

  // ═══════════════════════════════════════════════════════
  // TASKS
  // ═══════════════════════════════════════════════════════
  const tasks = {
    create: (data) => create('tasks', { ...data, status: data.status || 'pendente', priority: data.priority || 'normal' }),
    update: (id, data) => update('tasks', id, data),
    delete: (id) => remove('tasks', id),
    get:    (id) => getOne('tasks', id),
    list:   (opts) => getAll('tasks', { orderBy:'createdAt', orderDir:'desc', ...opts }),
    watch:  (cb, opts) => subscribe('tasks', cb, { orderBy:'createdAt', orderDir:'desc', ...opts }),
    complete: (id) => update('tasks', id, { status: 'concluida', completedAt: ts() })
  };

  // ═══════════════════════════════════════════════════════
  // MEETINGS
  // ═══════════════════════════════════════════════════════
  const meetings = {
    create: (data) => create('meetings', { ...data, status: data.status || 'agendada' }),
    update: (id, data) => update('meetings', id, data),
    delete: (id) => remove('meetings', id),
    get:    (id) => getOne('meetings', id),
    list:   (opts) => getAll('meetings', { orderBy:'date', orderDir:'asc', ...opts }),
    watch:  (cb, opts) => subscribe('meetings', cb, { orderBy:'date', orderDir:'asc', ...opts })
  };

  // ═══════════════════════════════════════════════════════
  // FINANCE
  // ═══════════════════════════════════════════════════════
  const finance = {
    create: (data) => create('finance', { ...data, type: data.type || 'receita' }),
    update: (id, data) => update('finance', id, data),
    delete: (id) => remove('finance', id),
    get:    (id) => getOne('finance', id),
    list:   (opts) => getAll('finance', { orderBy:'createdAt', orderDir:'desc', ...opts }),
    watch:  (cb, opts) => subscribe('finance', cb, { orderBy:'createdAt', orderDir:'desc', ...opts }),
    getSummary: async () => {
      const items = await getAll('finance');
      return items.reduce((acc, item) => {
        if (item.type === 'receita') acc.receitas += (item.amount || 0);
        else acc.despesas += (item.amount || 0);
        acc.total = acc.receitas - acc.despesas;
        return acc;
      }, { receitas: 0, despesas: 0, total: 0 });
    }
  };

  // ═══════════════════════════════════════════════════════
  // AGENTS (para o Swarm)
  // ═══════════════════════════════════════════════════════
  const agents = {
    create: (data) => NEXIA.db.collection('agents').doc(data.id || NEXIA.db.collection('agents').doc().id).set({
      ...data, status: 'sleeping', createdAt: ts(), updatedAt: ts()
    }),
    update: (id, data) => NEXIA.db.collection('agents').doc(id).update({ ...data, updatedAt: ts() }),
    get:    (id) => NEXIA.db.collection('agents').doc(id).get().then(s => s.exists ? { id:s.id, ...s.data() } : null),
    list:   () => NEXIA.db.collection('agents').get().then(s => s.docs.map(d => ({ id:d.id, ...d.data() }))),
    setStatus: (id, status) => NEXIA.db.collection('agents').doc(id).update({ status, updatedAt: ts() })
  };

  // ═══════════════════════════════════════════════════════
  // LOGS DO SISTEMA
  // ═══════════════════════════════════════════════════════
  const logs = {
    write: (data) => NEXIA.db.collection('system_logs').add({
      ...data,
      tenant: NEXIA.currentTenant?.slug || 'unknown',
      timestamp: ts()
    }),
    list: (limit = 100) => NEXIA.db.collection('system_logs')
      .orderBy('timestamp', 'desc').limit(limit).get()
      .then(s => s.docs.map(d => ({ id: d.id, ...d.data() }))),
    watch: (cb, limit = 50) => NEXIA.db.collection('system_logs')
      .orderBy('timestamp', 'desc').limit(limit)
      .onSnapshot(s => cb(s.docs.map(d => ({ id:d.id, ...d.data() }))))
  };

  return { clients, tasks, meetings, finance, agents, logs, create, update, remove, getOne, getAll, subscribe };
})();

window.NexiaData = NexiaData;
