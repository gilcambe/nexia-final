// ═══════════════════════════════════════════════════════════════
// NEXIA WhatsApp Business API — Integração real Meta Graph API
// POST /api/whatsapp
// Suporta: send_template, send_message, send_interactive,
//          create_template, get_templates, webhook_verify, webhook_receive
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

const META_API_BASE = 'https://graph.facebook.com/v18.0';

// ── Meta API caller ─────────────────────────────────────────────
async function metaCall(path, method = 'GET', body = null, token = null) {
  const accessToken = token || process.env.META_WHATSAPP_TOKEN;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${META_API_BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Meta API error ${res.status}`);
  return data;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': (process.env.NEXIA_APP_URL ? process.env.NEXIA_APP_URL.split(',')[0].trim() : '*'),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  // ── Webhook verification (GET from Meta) ─────────────────────
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const mode = params['hub.mode'];
    const token = params['hub.verify_token'];
    const challenge = params['hub.challenge'];
    const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (!expected) {
      console.error('[NEXIA] META_WEBHOOK_VERIFY_TOKEN não configurado no ambiente.');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Webhook não configurado.' }) };
    }

    if (mode === 'subscribe' && token === expected) {
      if (process.env.NODE_ENV !== 'production') console.warn('Webhook verified by Meta');
      return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: challenge };
    }
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // ── Webhook receive (POST from Meta — incoming messages) ──────
  if (event.httpMethod === 'POST' && event.headers['x-hub-signature-256']) {
    // Validate HMAC-SHA256 signature from Meta
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret) {
      console.error('[WhatsApp] META_APP_SECRET não configurado — webhook HMAC desabilitado, rejeitando por segurança');
      return { statusCode: 503, headers, body: JSON.stringify({ error: 'Webhook security not configured' }) };
    }
    {
      const crypto = require('crypto');
      const signature = event.headers['x-hub-signature-256'] || '';
      const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(event.body || '').digest('hex');
      if (signature !== expected) {
        console.warn('[WhatsApp] Webhook signature inválida — possível spoofing');
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
      }
    }
    return await handleWebhookReceive(event, headers);
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, tenantId, phoneNumberId, to, templateName, languageCode, components,
            message, interactiveType, interactiveBody, buttons, rows, header, footer } = body;

    if (!action) return { statusCode: 400, headers, body: JSON.stringify({ error: 'action required' }) };

    // Get tenant WhatsApp config from Firestore if not provided
    let resolvedPhoneId = phoneNumberId;
    let resolvedToken = null;

    if (tenantId && !phoneNumberId) {
      const tenantDoc = await db.collection('tenants').doc(tenantId).get();
      const cfg = tenantDoc.data()?.whatsappConfig || {};
      resolvedPhoneId = cfg.phoneNumberId;
      resolvedToken = cfg.accessToken; // tenant-specific token (optional)
    }

    if (!resolvedPhoneId && action !== 'get_business_profile') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'phoneNumberId required (or set in tenant config)' }) };
    }

    // ── ACTION: send_template ─────────────────────────────────
    if (action === 'send_template') {
      if (!to || !templateName) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'to and templateName required' }) };
      }

      const payload = {
        messaging_product: 'whatsapp',
        to: sanitizePhone(to),
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode || 'pt_BR' },
          components: components || []
        }
      };

      const result = await metaCall(`/${resolvedPhoneId}/messages`, 'POST', payload, resolvedToken);

      // Log to Firestore
      if (tenantId) {
        await db.collection('tenants').doc(tenantId)
          .collection('whatsapp_logs').add({
            type: 'template',
            to: sanitizePhone(to),
            templateName,
            messageId: result.messages?.[0]?.id,
            status: 'sent',
            timestamp: FieldValue.serverTimestamp()
          });
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId: result.messages?.[0]?.id, result }) };
    }

    // ── ACTION: send_message (text) ───────────────────────────
    if (action === 'send_message') {
      if (!to || !message) return { statusCode: 400, headers, body: JSON.stringify({ error: 'to and message required' }) };

      const payload = {
        messaging_product: 'whatsapp',
        to: sanitizePhone(to),
        type: 'text',
        text: { body: message, preview_url: true }
      };

      const result = await metaCall(`/${resolvedPhoneId}/messages`, 'POST', payload, resolvedToken);

      if (tenantId) {
        await db.collection('tenants').doc(tenantId)
          .collection('whatsapp_logs').add({
            type: 'text',
            to: sanitizePhone(to),
            message,
            messageId: result.messages?.[0]?.id,
            status: 'sent',
            timestamp: FieldValue.serverTimestamp()
          });
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId: result.messages?.[0]?.id }) };
    }

    // ── ACTION: send_interactive (buttons or list) ────────────
    if (action === 'send_interactive') {
      if (!to) return { statusCode: 400, headers, body: JSON.stringify({ error: 'to required' }) };

      let interactive;
      if (interactiveType === 'button' || (!interactiveType && buttons?.length)) {
        // Up to 3 reply buttons
        interactive = {
          type: 'button',
          body: { text: interactiveBody || message || 'Escolha uma opção:' },
          action: {
            buttons: (buttons || []).slice(0, 3).map((btn, i) => ({
              type: 'reply',
              reply: { id: btn.id || `btn_${i}`, title: btn.title.substring(0, 20) }
            }))
          }
        };
      } else {
        // List message (up to 10 rows)
        interactive = {
          type: 'list',
          header: header ? { type: 'text', text: header } : undefined,
          body: { text: interactiveBody || message || 'Escolha uma opção:' },
          footer: footer ? { text: footer } : undefined,
          action: {
            button: 'Ver opções',
            sections: [{
              title: 'Opções disponíveis',
              rows: (rows || []).slice(0, 10).map((row, i) => ({
                id: row.id || `row_${i}`,
                title: row.title.substring(0, 24),
                description: (row.description || '').substring(0, 72)
              }))
            }]
          }
        };
      }

      const payload = {
        messaging_product: 'whatsapp',
        to: sanitizePhone(to),
        type: 'interactive',
        interactive
      };

      const result = await metaCall(`/${resolvedPhoneId}/messages`, 'POST', payload, resolvedToken);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId: result.messages?.[0]?.id }) };
    }

    // ── ACTION: get_templates ─────────────────────────────────
    if (action === 'get_templates') {
      const wabaId = body.wabaId || process.env.META_WABA_ID;
      if (!wabaId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'wabaId required' }) };
      const result = await metaCall(`/${wabaId}/message_templates?limit=20`, 'GET', null, resolvedToken);
      return { statusCode: 200, headers, body: JSON.stringify({ templates: result.data || [] }) };
    }

    // ── ACTION: create_template ───────────────────────────────
    if (action === 'create_template') {
      const { wabaId, name, category, language, bodyText, headerText, footerText, buttons: tplBtns } = body;
      if (!wabaId || !name || !bodyText) return { statusCode: 400, headers, body: JSON.stringify({ error: 'wabaId, name, bodyText required' }) };

      const components = [{ type: 'BODY', text: bodyText }];
      if (headerText) components.unshift({ type: 'HEADER', format: 'TEXT', text: headerText });
      if (footerText) components.push({ type: 'FOOTER', text: footerText });
      if (tplBtns?.length) {
        components.push({
          type: 'BUTTONS',
          buttons: tplBtns.map(b => ({
            type: b.type || 'QUICK_REPLY',
            text: b.text
          }))
        });
      }

      const result = await metaCall(`/${wabaId}/message_templates`, 'POST', {
        name,
        category: category || 'MARKETING',
        language: language || 'pt_BR',
        components
      }, resolvedToken);

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, templateId: result.id, status: result.status }) };
    }

    // ── ACTION: mark_as_read ──────────────────────────────────
    if (action === 'mark_as_read') {
      const { messageId: msgId } = body;
      if (!msgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'messageId required' }) };
      await metaCall(`/${resolvedPhoneId}/messages`, 'POST', {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: msgId
      }, resolvedToken);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── ACTION: get_business_profile ──────────────────────────
    if (action === 'get_business_profile') {
      const pid = resolvedPhoneId || body.phoneNumberId;
      const result = await metaCall(`/${pid}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`, 'GET', null, resolvedToken);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error('WhatsApp API error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Webhook: receive incoming messages from Meta ────────────────
async function handleWebhookReceive(event, headers) {
  try {
    const body = JSON.parse(event.body || '{}');
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value) return { statusCode: 200, headers, body: 'OK' };

    // Process each message
    const messages = value.messages || [];
    for (const msg of messages) {
      const from = msg.from;
      const msgId = msg.id;
      const timestamp = msg.timestamp;
      const phoneNumberId = value.metadata?.phone_number_id;

      // Find tenant by phoneNumberId
      const tenantsSnap = await db.collectionGroup('configs')
        .where('whatsappPhoneNumberId', '==', phoneNumberId).limit(1).get();

      const tenantId = tenantsSnap.docs[0]?.ref?.parent?.parent?.id || 'unknown';

      const msgData = {
        from,
        messageId: msgId,
        phoneNumberId,
        tenantId,
        timestamp: new Date(parseInt(timestamp) * 1000).toISOString(),
        direction: 'inbound',
        status: 'received'
      };

      // Extract message content by type
      if (msg.type === 'text') {
        msgData.type = 'text';
        msgData.text = msg.text?.body;
      } else if (msg.type === 'interactive') {
        msgData.type = 'interactive_reply';
        msgData.reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
      } else if (msg.type === 'button') {
        msgData.type = 'button_reply';
        msgData.payload = msg.button?.payload;
        msgData.text = msg.button?.text;
      } else if (msg.type === 'audio') {
        msgData.type = 'audio';
        msgData.mediaId = msg.audio?.id;
      } else if (msg.type === 'image') {
        msgData.type = 'image';
        msgData.mediaId = msg.image?.id;
        msgData.caption = msg.image?.caption;
      } else {
        msgData.type = msg.type;
        msgData.raw = msg;
      }

      // Save to Firestore inbox
      await db.collection('whatsapp_inbox').add(msgData);

      // Also save to tenant's inbox if known
      if (tenantId !== 'unknown') {
        await db.collection('tenants').doc(tenantId)
          .collection('whatsapp_inbox').add(msgData);
      }

      if (process.env.NODE_ENV !== 'production') console.warn(`Received WA message from ${from}: ${msgData.type}`);
    }

    // Process status updates
    const statuses = value.statuses || [];
    for (const status of statuses) {
      await db.collection('whatsapp_statuses').add({
        messageId: status.id,
        recipientId: status.recipient_id,
        status: status.status, // sent, delivered, read, failed
        timestamp: new Date(parseInt(status.timestamp) * 1000).toISOString(),
        errors: status.errors || []
      });
    }

    return { statusCode: 200, headers, body: 'OK' };
  } catch (err) {
    console.error('Webhook receive error:', err);
    return { statusCode: 200, headers, body: 'OK' }; // Always 200 to Meta
  }
}

function sanitizePhone(phone) {
  return phone.replace(/\D/g, '').replace(/^0/, '55');
}
