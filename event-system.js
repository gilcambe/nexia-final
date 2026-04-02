/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — EVENT SYSTEM v7.0                               ║
 * ║  Fila de eventos assíncrona · Pub/Sub · Execução sob demanda ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
'use strict';

const NexiaEventSystem = (() => {

  // ── Fila local em memória ─────────────────────────────────────
  const _queue    = [];
  const _handlers = {};
  let   _processing = false;
  let   _paused     = false;

  // ── EVENT TYPES ───────────────────────────────────────────────
  const EVENTS = {
    // Auth
    AUTH_LOGIN:       'auth:login',
    AUTH_LOGOUT:      'auth:logout',
    // Data
    DATA_CREATED:     'data:created',
    DATA_UPDATED:     'data:updated',
    DATA_DELETED:     'data:deleted',
    // AI / Agents
    AGENT_ACTIVATED:  'agent:activated',
    AGENT_COMPLETED:  'agent:completed',
    AGENT_ERROR:      'agent:error',
    SWARM_STARTED:    'swarm:started',
    SWARM_COMPLETED:  'swarm:completed',
    ACTION_EXECUTED:  'action:executed',
    ACTION_FAILED:    'action:failed',
    // System
    ERROR:            'system:error',
    LOG:              'system:log',
    TENANT_CHANGED:   'tenant:changed'
  };

  // ── Subscribe a um evento ─────────────────────────────────────
  function on(eventType, handler) {
    if (!_handlers[eventType]) _handlers[eventType] = [];
    _handlers[eventType].push(handler);
    return () => off(eventType, handler); // retorna unsubscribe
  }

  function off(eventType, handler) {
    if (!_handlers[eventType]) return;
    _handlers[eventType] = _handlers[eventType].filter(h => h !== handler);
  }

  // ── Emite evento (adiciona à fila) ────────────────────────────
  function emit(eventType, data = {}) {
    const event = {
      id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      type:      eventType,
      data,
      tenant:    NEXIA?.currentTenant?.slug || 'unknown',
      timestamp: Date.now(),
      status:    'pending'
    };
    _queue.push(event);

    // Persiste no Firestore se disponível
    _persistEvent(event);

    // Processa a fila
    if (!_paused) _processQueue();

    return event.id;
  }

  // ── Emite e aguarda todos os handlers ─────────────────────────
  async function emitAsync(eventType, data = {}) {
    const eventId = emit(eventType, data);
    return new Promise(resolve => {
      const unsub = on(eventType + ':done', result => {
        if (result.eventId === eventId) { unsub(); resolve(result); }
      });
      setTimeout(() => { unsub(); resolve({ eventId, timeout: true }); }, 10000);
    });
  }

  // ── Processa fila de eventos ──────────────────────────────────
  async function _processQueue() {
    if (_processing || _paused || !_queue.length) return;
    _processing = true;

    while (_queue.length && !_paused) {
      const event = _queue.shift();
      event.status = 'processing';

      const handlers = [
        ...(_handlers[event.type] || []),
        ...(_handlers['*'] || [])
      ];

      for (const handler of handlers) {
        try {
          await Promise.resolve(handler(event));
        } catch(e) {
          console.error(`[EVENT SYSTEM] Handler error for ${event.type}:`, e.message);
          _persistEvent({ ...event, type: 'system:error', data: { originalEvent: event.type, error: e.message } });
        }
      }

      event.status = 'done';
    }

    _processing = false;
  }

  // ── Persiste evento no Firestore ──────────────────────────────
  function _persistEvent(event) {
    if (!NEXIA?.db) return;
    NEXIA.db.collection('event_queue').add({
      ...event,
      firestoreTimestamp: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
  }

  // ── Controle de fluxo ─────────────────────────────────────────
  function pause()  { _paused = true; }
  function resume() { _paused = false; _processQueue(); }
  function clear()  { _queue.length = 0; }
  function size()   { return _queue.length; }

  return { on, off, emit, emitAsync, pause, resume, clear, size, EVENTS };
})();

// ────────────────────────────────────────────────────────────────
// NexiaLogger — Logs estruturados com níveis e persistência
// ────────────────────────────────────────────────────────────────
const NexiaLogger = (() => {

  const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  const COLORS  = { debug:'#6B7280', info:'#00E5FF', warn:'#F59E0B', error:'#FF3D5A', ok:'#2ED080' };
  let   _minLevel = 1; // info por padrão
  let   _buffer   = []; // buffer local para batch write

  // ── Escreve log ───────────────────────────────────────────────
  function _write(level, module, message, meta = {}) {
    if ((LEVELS[level] ?? 0) < _minLevel) return;

    const entry = {
      level,
      module,
      message,
      meta,
      tenant:    NEXIA?.currentTenant?.slug || 'unknown',
      timestamp: new Date().toISOString(),
      ts:        Date.now()
    };

    // Console colorido
    const color = COLORS[level] || COLORS.info;
    console.log(
      `%c[${level.toUpperCase()}]%c [${module}] %c${message}`,
      `color:${color};font-weight:bold`,
      'color:#8A9DC0;font-weight:bold',
      'color:#C4D4EE'
    );

    // Buffer para batch write
    _buffer.push(entry);
    if (_buffer.length >= 5) _flushBuffer();

    // Emite evento de log
    NexiaEventSystem.emit(NexiaEventSystem.EVENTS.LOG, entry);

    return entry;
  }

  // ── Flush do buffer para Firestore ────────────────────────────
  async function _flushBuffer() {
    if (!NEXIA?.db || !_buffer.length) return;
    const toWrite = _buffer.splice(0, _buffer.length);
    try {
      const batch = NEXIA.db.batch();
      toWrite.forEach(entry => {
        const ref = NEXIA.db.collection('system_logs').doc();
        batch.set(ref, {
          ...entry,
          firestoreTs: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      await batch.commit();
    } catch(e) {
      // Se falhar, não perde os logs — apenas avisa no console
      console.warn('[LOGGER] Flush failed:', e.message);
    }
  }

  // ── API pública ───────────────────────────────────────────────
  function debug(module, msg, meta) { return _write('debug', module, msg, meta); }
  function info (module, msg, meta) { return _write('info',  module, msg, meta); }
  function warn (module, msg, meta) { return _write('warn',  module, msg, meta); }
  function error(module, msg, meta) { return _write('error', module, msg, meta); }
  function ok   (module, msg, meta) { return _write('ok',    module, msg, meta); }

  // ── Mede performance de uma operação ─────────────────────────
  function time(module, label) {
    const start = performance.now();
    return {
      end: (meta = {}) => {
        const ms = Math.round(performance.now() - start);
        info(module, `${label} concluído em ${ms}ms`, { ...meta, ms });
        return ms;
      }
    };
  }

  // ── Consulta logs do Firestore ────────────────────────────────
  async function query(options = {}) {
    if (!NEXIA?.db) return [];
    let q = NEXIA.db.collection('system_logs');
    if (options.level)  q = q.where('level', '==', options.level);
    if (options.module) q = q.where('module', '==', options.module);
    if (options.tenant) q = q.where('tenant', '==', options.tenant);
    q = q.orderBy('ts', 'desc').limit(options.limit || 100);
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  // ── Watch logs em tempo real ──────────────────────────────────
  function watchLogs(callback, options = {}) {
    if (!NEXIA?.db) return () => {};
    let q = NEXIA.db.collection('system_logs').orderBy('ts', 'desc').limit(options.limit || 50);
    if (options.level) q = q.where('level', '==', options.level);
    return q.onSnapshot(snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }

  function setMinLevel(level) { _minLevel = LEVELS[level] ?? 1; }
  function flush() { _flushBuffer(); }

  // Flush ao fechar a página
  window.addEventListener('beforeunload', () => _flushBuffer());

  return { debug, info, warn, error, ok, time, query, watchLogs, setMinLevel, flush };
})();

window.NexiaEventSystem = NexiaEventSystem;
window.NexiaLogger      = NexiaLogger;
