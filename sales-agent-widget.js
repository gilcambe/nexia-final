/**
 * NEXIA OS — AI SALES AGENT WIDGET v1.0
 * Embed em qualquer landing page com 1 linha:
 * <script src="/core/sales-agent-widget.js" data-tenant="nexia"></script>
 */
(function () {
  'use strict';

  const tenantId = document.currentScript?.dataset?.tenant || 'nexia';
  const agentName = document.currentScript?.dataset?.name || 'ARIA';
  const accentColor = document.currentScript?.dataset?.color || '#00e5ff';
  const position = document.currentScript?.dataset?.position || 'right';

  const STORAGE_KEY = `nexia_sales_session_${tenantId}`;
  let sessionId = localStorage.getItem(STORAGE_KEY) || null;
  let history = [];
  let isOpen = false;
  let isTyping = false;

  // ── CSS ─────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #nsa-fab {
      position: fixed; bottom: 24px; ${position}: 24px; z-index: 99999;
      width: 60px; height: 60px; border-radius: 50%;
      background: ${accentColor}; border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s; font-size: 26px;
    }
    #nsa-fab:hover { transform: scale(1.08); }
    #nsa-badge {
      position: absolute; top: -4px; right: -4px;
      background: #ff3d71; color: #fff; font-size: 10px; font-weight: 700;
      border-radius: 50%; width: 18px; height: 18px;
      display: flex; align-items: center; justify-content: center;
    }
    #nsa-window {
      position: fixed; bottom: 96px; ${position}: 24px; z-index: 99998;
      width: 360px; max-height: 520px;
      background: #0d1117; border: 1px solid #1e2736;
      border-radius: 16px; display: flex; flex-direction: column;
      box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      transform: scale(0.9) translateY(10px); opacity: 0;
      transition: all 0.25s cubic-bezier(0.34,1.56,0.64,1);
      pointer-events: none;
    }
    #nsa-window.open { transform: scale(1) translateY(0); opacity: 1; pointer-events: all; }
    #nsa-header {
      padding: 14px 16px; background: #111827; border-radius: 16px 16px 0 0;
      border-bottom: 1px solid #1e2736;
      display: flex; align-items: center; gap: 10px;
    }
    #nsa-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: ${accentColor}22; border: 2px solid ${accentColor};
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
    }
    #nsa-agent-name { font-weight: 600; color: #e5e7eb; font-size: 14px; }
    #nsa-status { font-size: 11px; color: #22c55e; }
    #nsa-msgs {
      flex: 1; overflow-y: auto; padding: 12px;
      display: flex; flex-direction: column; gap: 8px;
      scrollbar-width: thin; scrollbar-color: #1e2736 transparent;
    }
    .nsa-msg { display: flex; gap: 8px; align-items: flex-end; }
    .nsa-msg.user { flex-direction: row-reverse; }
    .nsa-bubble {
      max-width: 260px; padding: 10px 13px; border-radius: 14px;
      font-size: 13px; line-height: 1.5; color: #e5e7eb;
    }
    .nsa-msg.bot .nsa-bubble { background: #1e2736; border-bottom-left-radius: 4px; }
    .nsa-msg.user .nsa-bubble { background: ${accentColor}22; border: 1px solid ${accentColor}44; border-bottom-right-radius: 4px; color: #fff; }
    .nsa-time { font-size: 10px; color: #6b7280; padding: 2px 4px; }
    #nsa-typing { display: flex; gap: 4px; padding: 10px 13px; background: #1e2736; border-radius: 14px; width: fit-content; }
    #nsa-typing span { width: 6px; height: 6px; background: #6b7280; border-radius: 50%; animation: nsa-dot 1.2s infinite; }
    #nsa-typing span:nth-child(2) { animation-delay: 0.2s; }
    #nsa-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes nsa-dot { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-5px)} }
    #nsa-input-row {
      padding: 10px 12px; border-top: 1px solid #1e2736;
      display: flex; gap: 8px; align-items: center;
    }
    #nsa-input {
      flex: 1; background: #1e2736; border: 1px solid #2d3748;
      border-radius: 22px; padding: 9px 14px; color: #e5e7eb;
      font-size: 13px; outline: none; resize: none;
      font-family: inherit; max-height: 80px;
    }
    #nsa-input:focus { border-color: ${accentColor}66; }
    #nsa-send {
      width: 36px; height: 36px; border-radius: 50%; border: none;
      background: ${accentColor}; color: #000; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px; flex-shrink: 0; transition: transform 0.15s;
    }
    #nsa-send:hover { transform: scale(1.1); }
    #nsa-quick-btns { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; }
    .nsa-quick { background: transparent; border: 1px solid ${accentColor}44; color: ${accentColor};
      border-radius: 14px; padding: 5px 11px; font-size: 12px; cursor: pointer;
      transition: background 0.15s; }
    .nsa-quick:hover { background: ${accentColor}22; }
    @media(max-width:420px) { #nsa-window { width: calc(100vw - 32px); } }
  `;
  document.head.appendChild(style);

  // ── DOM ─────────────────────────────────────────────────────────
  const fab = document.createElement('button');
  fab.id = 'nsa-fab';
  fab.innerHTML = '🤖<div id="nsa-badge">1</div>';
  fab.title = `Falar com ${agentName}`;

  const win = document.createElement('div');
  win.id = 'nsa-window';
  win.innerHTML = `
    <div id="nsa-header">
      <div id="nsa-avatar">🤖</div>
      <div>
        <div id="nsa-agent-name">${agentName}</div>
        <div id="nsa-status">● Online agora</div>
      </div>
    </div>
    <div id="nsa-msgs"></div>
    <div id="nsa-quick-btns">
      <button class="nsa-quick" onclick="nsaSend('Quero ver os planos')">Ver planos</button>
      <button class="nsa-quick" onclick="nsaSend('Como funciona?')">Como funciona?</button>
      <button class="nsa-quick" onclick="nsaSend('Quero agendar uma demo')">Agendar demo</button>
    </div>
    <div id="nsa-input-row">
      <textarea id="nsa-input" placeholder="Digite sua mensagem..." rows="1"></textarea>
      <button id="nsa-send" onclick="nsaSend()">➤</button>
    </div>
  `;

  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.appendChild(fab);
      document.body.appendChild(win);
    });
  } else {
    document.body.appendChild(fab);
    document.body.appendChild(win);
  }

  // ── Funções globais ──────────────────────────────────────────────
  window.nsaToggle = function () {
    isOpen = !isOpen;
    win.classList.toggle('open', isOpen);
    fab.innerHTML = isOpen ? '✕' : '🤖';
    const badge = document.getElementById('nsa-badge'); if (badge) badge.style.display = 'none';
    const _msgs = document.getElementById('nsa-msgs'); if (isOpen && _msgs && _msgs.children.length === 0) {
      nsaGreet();
    }
    if (isOpen) setTimeout(() => document.getElementById('nsa-input')?.focus(), 300);
  };

  window.nsaSend = async function (override) {
    if (isTyping) return;
    const input = document.getElementById('nsa-input');
    const text = (override || input?.value || '').trim();
    if (!text) return;
    if (input) input.value = '';
    appendMsg(text, 'user');
    history.push({ role: 'user', content: text });
    showTyping();

    try {
      const res = await fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId, message: text, sessionId, history: history.slice(-8) })
      });
      const data = await res.json();
      if (data.sessionId) {
        sessionId = data.sessionId;
        localStorage.setItem(STORAGE_KEY, sessionId);
      }
      hideTyping();
      const reply = data.reply || 'Desculpe, ocorreu um erro. Tente novamente.';
      appendMsg(reply, 'bot');
      history.push({ role: 'assistant', content: reply });
    } catch {
      hideTyping();
      appendMsg('Ops! Sem conexão. Tente novamente em instantes.', 'bot');
    }
  };

  function nsaGreet() {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
    appendMsg(`${greeting}! 👋 Sou ${agentName}, consultora de IA da plataforma. Como posso te ajudar hoje?`, 'bot');
  }

  function appendMsg(text, role) {
    const msgs = document.getElementById('nsa-msgs');
    const now = new Date();
    const time = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
    const div = document.createElement('div');
    div.className = `nsa-msg ${role}`;
    div.innerHTML = `<div class="nsa-bubble">${text.replace(/\n/g, '<br>')}</div><div class="nsa-time">${time}</div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    isTyping = false;
  }

  function showTyping() {
    isTyping = true;
    const msgs = document.getElementById('nsa-msgs');
    const div = document.createElement('div');
    div.className = 'nsa-msg bot'; div.id = 'nsa-typing-row';
    div.innerHTML = '<div id="nsa-typing"><span></span><span></span><span></span></div>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function hideTyping() {
    document.getElementById('nsa-typing-row')?.remove();
  }

  // Enter para enviar
  document.getElementById('nsa-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); nsaSend(); }
  });

  fab.addEventListener('click', nsaToggle);

  // Abre automaticamente após 8 segundos se o usuário não interagiu
  if (!sessionId) {
    setTimeout(() => {
      if (!isOpen) nsaToggle();
    }, 8000);
  }
  // Guard: only init once DOM is ready
})();
