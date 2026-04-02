/**
 * NEXIA OS — SET MASTER ROLE
 * Uso: node set-master-role.js <uid_do_usuario>
 *
 * Rode DEPOIS de criar o usuário master no Firebase Auth Console.
 */
'use strict';
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccount.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const uid = process.argv[2];
if (!uid) {
  console.error('❌ Uso: node set-master-role.js <uid>');
  process.exit(1);
}

async function setMaster() {
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Cria/atualiza o doc do usuário como master
  await db.collection('users').doc(uid).set({
    uid,
    role: 'master',
    tenantSlug: 'nexia',
    displayName: 'NEXIA Master Admin',
    email: 'admin@nexia.app',
    createdAt: now,
    updatedAt: now,
  }, { merge: true });

  // Adiciona como membro do tenant nexia com role master
  await db.collection('tenants').doc('nexia').collection('members').doc(uid).set({
    uid,
    role: 'master',
    tenantSlug: 'nexia',
    joinedAt: now,
  }, { merge: true });

  console.log(`✅ Usuário ${uid} configurado como MASTER do tenant nexia`);
  console.log('   Agora pode fazer login e acessar o Cortex com permissões completas.');
  process.exit(0);
}

setMaster().catch(err => { console.error(err); process.exit(1); });
