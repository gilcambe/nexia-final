'use strict';
const NexiaAuth = (() => {
  let _currentUser = null, _userProfile = null, _authCallbacks = [];
  // CORRIGIDO v38: flag para evitar múltiplos listeners (memory leak)
  let _authListenerRegistered = false;
  let _authUnsubscribe = null;

  function init() {
    const waitAuth = () => {
      if (!NEXIA._ready || !NEXIA.auth) { setTimeout(waitAuth, 200); return; }
      // Registra listener apenas uma vez — evita acúmulo em SPA
      if (_authListenerRegistered) return;
      _authListenerRegistered = true;
      NEXIA.auth.onAuthStateChanged(async user => {
        _currentUser = user;
        if (user) {
          try {
            const snap = await NEXIA.db.collection('users').doc(user.uid).get();
            if (snap.exists) {
              _userProfile = snap.data();
              const slug = _userProfile.tenantSlug || _userProfile.tenant;
              if (slug) NEXIA.setTenant(slug);
            } else {
              _userProfile = { uid: user.uid, email: user.email, displayName: user.displayName || user.email, tenantSlug: 'guest', role: 'user', createdAt: firebase.firestore.FieldValue.serverTimestamp() };
              await NEXIA.db.collection('users').doc(user.uid).set(_userProfile);
            }
          } catch(e) { NEXIA.log('Auth profile error: ' + e.message, 'warn'); }
        } else { _userProfile = null; }
        _authCallbacks.forEach(cb => { try { cb(_userProfile); } catch(e) {} });
      });
    };
    waitAuth();
  }

  async function login(email, password) {
    if (!NEXIA.auth) throw new Error('Serviço de autenticação indisponível. Tente novamente.');
    try {
      const cred = await NEXIA.auth.signInWithEmailAndPassword(email, password);
      return cred.user;
    } catch (e) {
      const msg = {
        'auth/user-not-found':      'E-mail não cadastrado.',
        'auth/wrong-password':      'Senha incorreta.',
        'auth/invalid-email':       'E-mail inválido.',
        'auth/user-disabled':       'Conta desativada. Contate o suporte.',
        'auth/too-many-requests':   'Muitas tentativas. Aguarde alguns minutos.',
        'auth/network-request-failed': 'Sem conexão com a internet.',
        'auth/invalid-credential':  'Credenciais inválidas.',
      }[e.code] || 'Erro ao fazer login. Tente novamente.';
      throw new Error(msg);
    }
  }

  async function register(email, password, displayName, tenantSlug = 'guest') {
    if (!NEXIA.auth) throw new Error('Auth indisponível');
    const cred = await NEXIA.auth.createUserWithEmailAndPassword(email, password);
    const user = cred.user;
    await user.updateProfile({ displayName });
    await NEXIA.db.collection('users').doc(user.uid).set({ uid: user.uid, email, displayName, tenantSlug, role: 'user', createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    await NEXIA.db.collection('tenants').doc(tenantSlug).collection('members').doc(user.uid).set({ uid: user.uid, email, displayName, role: 'user', joinedAt: firebase.firestore.FieldValue.serverTimestamp() });
    return user;
  }

  async function logout() {
    if (NEXIA.auth) await NEXIA.auth.signOut();
    _currentUser = null; _userProfile = null;
    window.location.href = '/login';
  }

  function requireAuth(redirectTo = '/login') {
    if (document.body) document.body.style.visibility = 'hidden';
    else document.addEventListener('DOMContentLoaded', () => { document.body.style.visibility = 'hidden'; });

    const waitCheck = () => {
      if (!NEXIA._ready) { setTimeout(waitCheck, 100); return; }
      if (!NEXIA.auth) { document.body.style.visibility = 'visible'; return; }

      // CORRIGIDO v38: cancela listener anterior antes de criar novo (evita memory leak)
      if (_authUnsubscribe) { _authUnsubscribe(); _authUnsubscribe = null; }

      _authUnsubscribe = NEXIA.auth.onAuthStateChanged(user => {
        // Unsubscribe after first check — listener must not persist (memory leak + spurious redirects)
        if (_authUnsubscribe) { _authUnsubscribe(); _authUnsubscribe = null; }
        if (!user) {
          window.location.href = redirectTo;
        } else {
          document.body.style.visibility = 'visible';
        }
      });
    };
    waitCheck();
  }

  function _autoGuard() {
    const path = window.location.pathname;
    // CORRIGIDO v38: vp-passenger, vp-guide e architect adicionados
    const PROTECTED = [
      /-admin\.html$/,              // *-admin.html (bezsan-admin, ces-admin, vp-admin, etc.)
      /\/nexia\//,                  // /nexia/* (todos os painéis master)
      /cortex-app\.html$/,
      /flow\.html$/,
      /studio\.html$/,
      /tenant-hub\.html$/,
      /my-panel\.html$/,
      /pabx-softphone\.html$/,
      /nexia-pay\.html$/,
      /nexia-store\.html$/,
      /swarm-control\.html$/,
      /pki-scanner\.html$/,
      /vp-passenger\.html$/,        // CORRIGIDO: estava sem proteção
      /vp-guide\.html$/,            // CORRIGIDO: estava sem proteção
      /architect\.html$/,           // CORRIGIDO: estava sem proteção (criação de tenant)
      /qa-test-center\.html$/,      // QA CENTER: acesso apenas para master,           // CORRIGIDO: estava sem proteção (criação de tenant)
    ];
    const isProtected = PROTECTED.some(rx => rx.test(path));
    const isLoginPage  = /\/login(\.html)?$/.test(path) || path === '/';
    if (isProtected && !isLoginPage) {
      requireAuth('/login?next=' + encodeURIComponent(path));
    }
  }

  function onChange(cb) { _authCallbacks.push(cb); }

  init(); _autoGuard();

  return {
    login,
    register,
    logout,
    onChange,
    requireAuth,
    getUser:       () => _currentUser,
    getProfile:    () => _userProfile,
    isLogged:      () => !!_currentUser,
    getTenantSlug: () => _userProfile?.tenantSlug || NEXIA.currentTenant?.slug || 'nexia'
  };
})();
window.NexiaAuth = NexiaAuth;
