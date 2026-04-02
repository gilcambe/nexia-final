'use strict';
const NexiaActionEngine = {
    async execute(action, payload, tenantSlug = 'nexia') {
        console.log(`[ACTION ENGINE] Executando: ${action} no tenant: ${tenantSlug}`);
        const db = typeof NEXIA !== 'undefined' ? NEXIA.db : firebase.firestore();
        switch (action) {
            case 'create_lead':
            case 'createClient':
                const res = await db.collection('tenants').doc(tenantSlug).collection('cadastros').add({
                    ...payload, origem: 'CORTEX_AI', status: payload.status || 'Lead', criadoEm: firebase.firestore.FieldValue.serverTimestamp()
                });
                return res.id;
            case 'create_task':
                const taskRes = await db.collection('tenants').doc(tenantSlug).collection('tasks').add({
                    ...payload, status: 'pending', criadoEm: firebase.firestore.FieldValue.serverTimestamp()
                });
                return taskRes.id;
            default:
                throw new Error(`Ação desconhecida ou não suportada: ${action}`);
        }
    }
};
window.NexiaActionEngine = NexiaActionEngine;
