/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  NEXIA OS — AUTH v10.0  (NOVO)                              ║
 * ║  Firebase Auth integration · Perfil · Tenant onboarding     ║
 * ║  FASE 2: Auth real — cada user isolado no seu tenant        ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * POST /api/auth
 *   action: "verify"      → verifica token Firebase e retorna perfil
 *   action: "register"    → onboarding: cria tenant + perfil de admin
 *   action: "profile"     → retorna/atualiza perfil do user
 *   action: "invite"      → convida membro para o tenant (requer admin)
 *   action: "accept"      → aceita convite e vincula user ao tenant
 */


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
const now = () => admin && admin.firestore
  ? admin.firestore.FieldValue.serverTimestamp()
  : new Date().toISOString();
const { HEADERS, makeHeaders } = require('./middleware');


// ── Verifica token Firebase ID ────────────────────────────────
async function verifyToken(token) {
  if (!token) throw new Error('Token ausente');
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded;
}


// ── Busca ou cria perfil do usuário ───────────────────────────
async function getOrCreateProfile(uid, email, displayName) {
  const ref  = db.collection('users').doc(uid);
  const snap = await ref.get();


  if (snap.exists) {
    // Atualiza lastSeen
    await ref.update({ lastSeen: now() });
    return snap.data();
  }


  // Novo usuário — perfil básico sem tenant ainda
  const profile = {
    uid, email: email || '',
    displayName: displayName || email?.split('@')[0] || 'Usuário',
    role: 'user',
    tenantSlug: null,
    plan: 'free',
    onboarded: false,
    createdAt: now(),
    lastSeen: now()
  };
  await ref.set(profile);
  return profile;
}


// ── Onboarding: cria tenant + define user como admin ─────────
async function registerTenant(uid, email, tenantName, tenantSlug) {
  // Valida slug
  const slug = tenantSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);


  // Verifica se slug já existe
  const existing = await db.collection('tenants').doc(slug).get();
  if (existing.exists) throw new Error(`Tenant "${slug}" já existe. Escolha outro nome.`);


  const batch = db.batch();


  // Cria tenant
  const tenantRef = db.collection('tenants').doc(slug);
  batch.set(tenantRef, {
    id: slug, name: tenantName, slug,
    plan: 'free', ownerId: uid,
    createdAt: now(), updatedAt: now(),
    settings: { language: 'pt-BR', timezone: 'America/Sao_Paulo' },
    ragDocsCount: 0,
    membersCount: 1
  });


  // Cria member record
  const memberRef = tenantRef.collection('members').doc(uid);
  batch.set(memberRef, { userId: uid, email, role: 'admin', joinedAt: now() });


  // Atualiza perfil do user
  const userRef = db.collection('users').doc(uid);
  batch.update(userRef, {
    tenantSlug: slug, role: 'admin',
    onboarded: true, updatedAt: now()
  });


  await batch.commit();


  return { tenantId: slug, role: 'admin' };
}


// ── Convida membro ─────────────────────────────────────────────
async function inviteMember(tenantId, inviterUid, inviteEmail, role = 'member') {
  // Verifica se inviter é admin
  const memberDoc = await db.collection('tenants').doc(tenantId).collection('members').doc(inviterUid).get();
  if (!memberDoc.exists) throw new Error('Inviter não é membro deste tenant');
  const inviterRole = memberDoc.data().role;
  if (!['master', 'admin'].includes(inviterRole)) throw new Error('Apenas admins podem convidar membros');


  // Cria convite
  const inviteRef = await db.collection('tenants').doc(tenantId).collection('invites').add({
    email: inviteEmail, role, invitedBy: inviterUid,
    status: 'pending', tenantId,
    createdAt: now(),
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 3600_000))
  });


  return { inviteId: inviteRef.id, email: inviteEmail, role };
}


// ── Aceita convite ────────────────────────────────────────────
async function acceptInvite(uid, email, inviteId) {
  const inviteRef = db.collection('tenants').doc('*'); // será resolvido por query


  // Busca convite por id em todos os tenants (via collectionGroup)
  const snap = await db.collectionGroup('invites').where(admin.firestore.FieldPath.documentId(), '==', inviteId).get();
  if (snap.empty) throw new Error('Convite não encontrado');


  const inviteDoc = snap.docs[0];
  const invite    = inviteDoc.data();
  if (invite.status !== 'pending') throw new Error('Convite já foi usado ou expirou');
  if (invite.email !== email) throw new Error('Este convite não pertence a este email');


  const now_ = now();
  const batch = db.batch();


  // Cria member
  const memberRef = db.collection('tenants').doc(invite.tenantId).collection('members').doc(uid);
  batch.set(memberRef, { userId: uid, email, role: invite.role, joinedAt: now_ });


  // Atualiza user
  const userRef = db.collection('users').doc(uid);
  batch.update(userRef, { tenantSlug: invite.tenantId, role: invite.role, onboarded: true, updatedAt: now_ });


  // Marca convite como aceito
  batch.update(inviteDoc.ref, { status: 'accepted', acceptedAt: now_, acceptedBy: uid });


  // Incrementa membersCount
  batch.update(db.collection('tenants').doc(invite.tenantId), {
    membersCount: admin.firestore.FieldValue.increment(1), updatedAt: now_
  });


  await batch.commit();
  return { tenantId: invite.tenantId, role: invite.role };
}


// ── HANDLER ───────────────────────────────────────────────────
// P3 FIX: IP-based rate limit map (in-memory, resets on cold start — complementa Firebase throttle)
const _authRLMap = new Map();
function _checkAuthRateLimit(ip) {
  const now = Date.now();
  const WINDOW_MS = 15 * 60 * 1000; // 15 min
  const MAX_ATTEMPTS = 20;           // 20 tentativas por IP por janela
  const entry = _authRLMap.get(ip);
  if (!entry || (now - entry.windowStart) > WINDOW_MS) {
    _authRLMap.set(ip, { count: 1, windowStart: now });
    return { ok: true };
  }
  if (entry.count >= MAX_ATTEMPTS) {
    return { ok: false, retryAfter: Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000) };
  }
  entry.count++;
  return { ok: true };
}

exports.handler = async (event) => {
  const headers = makeHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  // P3 FIX: Rate limit por IP — protege contra brute-force / enumeração
  const clientIp = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || event.headers?.['client-ip']
    || 'unknown';
  const rl = _checkAuthRateLimit(clientIp);
  if (!rl.ok) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Muitas tentativas. Aguarde antes de tentar novamente.', retryAfter: rl.retryAfter }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, token, userId, email, displayName } = body;


    // Verifica token em todas as ações exceto verify público
    let decoded = null;
    if (token) {
      try { decoded = await verifyToken(token); } catch (e) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token inválido ou expirado' }) };
      }
    }


    // uid is only used from verified decoded token — never from body (VULN-02 prevention)
    const uid = decoded?.uid;


    if (action === 'verify') {
      if (!decoded) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token necessário' }) };
      const profile = await getOrCreateProfile(decoded.uid, decoded.email, decoded.name);
      return { statusCode: 200, headers, body: JSON.stringify({ uid: decoded.uid, ...profile }) };
    }


    if (action === 'register') {
      // FIXED: register MUST have a valid Firebase token — uid from body alone is not trusted
      if (!decoded) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token Firebase obrigatório para registro' }) };
      const { tenantName, tenantSlug } = body;
      if (!tenantName || !tenantSlug) throw new Error('tenantName e tenantSlug são obrigatórios');
      const result = await registerTenant(decoded.uid, decoded.email, tenantName, tenantSlug);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
    }


    if (action === 'profile') {
      // FIXED: IDOR fix — profile always returns the authenticated caller's own profile
      if (!decoded) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token obrigatório para acessar perfil' }) };
      const profile = await getOrCreateProfile(decoded.uid, decoded.email, decoded.name || displayName);
      return { statusCode: 200, headers, body: JSON.stringify(profile) };
    }


    if (action === 'invite') {
      // FIXED: require verified token to send invites
      if (!decoded) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token obrigatório para convidar membros' }) };
      const { tenantId, inviteEmail, role } = body;
      const result = await inviteMember(tenantId, decoded.uid, inviteEmail, role);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
    }


    if (action === 'accept') {
      // FIXED VULN-02: require a verified Firebase token — never trust uid/email from body alone
      if (!decoded) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token Firebase obrigatório para aceitar convite' }) };
      const { inviteId } = body;
      const result = await acceptInvite(decoded.uid, decoded.email, inviteId);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
    }


    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ação não reconhecida' }) };


  } catch (err) {
    console.error('[AUTH] ❌', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};










