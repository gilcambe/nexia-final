/**
 * ✦ NEXIA OS — Universal Splash Screen + i18n v1.0
 * Injeta automaticamente em qualquer página que inclua este script.
 * Uso: <script src="../core/nexia-splash.js"></script>
 */
(function(){
  // ── i18n ──────────────────────────────────────────────────
  const TRANSLATIONS = {
    'pt-BR': {
      splash_loading: 'Inicializando',
      nav_home: 'Início', nav_about: 'Sobre', nav_contact: 'Contato',
      nav_register: 'Inscrever-se', nav_login: 'Entrar',
      btn_cta: 'Saiba Mais', btn_register: 'Quero Participar',
      footer_rights: 'Todos os direitos reservados',
    },
    'en': {
      splash_loading: 'Initializing',
      nav_home: 'Home', nav_about: 'About', nav_contact: 'Contact',
      nav_register: 'Register', nav_login: 'Login',
      btn_cta: 'Learn More', btn_register: 'I Want to Join',
      footer_rights: 'All rights reserved',
    },
    'es': {
      splash_loading: 'Iniciando',
      nav_home: 'Inicio', nav_about: 'Nosotros', nav_contact: 'Contacto',
      nav_register: 'Inscribirse', nav_login: 'Entrar',
      btn_cta: 'Más Información', btn_register: 'Quiero Participar',
      footer_rights: 'Todos los derechos reservados',
    }
  };

  // Detecta idioma salvo ou do browser
  function detectLang() {
    return localStorage.getItem('nexia_lang') ||
      (navigator.language || 'pt-BR').substring(0,2) === 'en' ? 'en' :
      (navigator.language || 'pt-BR').substring(0,2) === 'es' ? 'es' : 'pt-BR';
  }

  window.NEXIA_LANG = detectLang();
  window.t = function(key) {
    return (TRANSLATIONS[window.NEXIA_LANG] || TRANSLATIONS['pt-BR'])[key] || key;
  };
  window.setLang = function(lang) {
    window.NEXIA_LANG = lang;
    localStorage.setItem('nexia_lang', lang);
    // Re-render i18n elements
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.placeholder = window.t(key);
      else el.textContent = window.t(key);
    });
  };

  // ── Splash Injection ──────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #_nexia-splash{position:fixed;inset:0;background:#07090E;z-index:99999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;transition:opacity .6s .2s,transform .5s .2s;font-family:'Inter',sans-serif}
    #_nexia-splash.hide{opacity:0;transform:scale(1.06);pointer-events:none}
    ._nx-hex{width:58px;height:58px;background:linear-gradient(135deg,rgb(184,134,11),rgb(218,165,32));border-radius:14px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:22px;color:#fff;animation:_nx-pulse 1s ease infinite}
    @keyframes _nx-pulse{0%,100%{box-shadow:0 0 0 0 rgba(218,165,32,.4)}50%{box-shadow:0 0 0 14px rgba(218,165,32,0)}}
    ._nx-title{font-size:18px;font-weight:700;color:#f8fafc;letter-spacing:.3px}
    ._nx-sub{font-size:11px;color:rgb(218,165,32);letter-spacing:2px;text-transform:uppercase}
    ._nx-bar{width:120px;height:2px;background:rgba(255,255,255,.08);border-radius:1px;margin-top:4px;overflow:hidden}
    ._nx-progress{height:100%;background:linear-gradient(90deg,rgb(218,165,32),rgba(218,165,32,.4));border-radius:1px;animation:_nx-load 1s ease-out forwards}
    @keyframes _nx-load{from{width:0}to{width:100%}}
    /* Lang switcher */
    ._nx-lang{position:fixed;top:16px;right:16px;z-index:100;display:flex;gap:6px}
    ._nx-lang button{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:rgba(226,232,240,.6);padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .2s}
    ._nx-lang button:hover,._nx-lang button.active{background:rgba(218,165,32,.15);border-color:rgba(218,165,32,.3);color:rgb(218,165,32)}
  `;
  document.head.appendChild(style);

  // Create splash
  const splash = document.createElement('div');
  splash.id = '_nexia-splash';
  splash.innerHTML = `
    <div class="_nx-hex">✦</div>
    <div>
      <div class="_nx-title">NEXIA OS</div>
      <div class="_nx-sub" id="_nx-sub-text">Inicializando</div>
    </div>
    <div class="_nx-bar"><div class="_nx-progress"></div></div>
  `;
  document.body.appendChild(splash);

  // Create lang switcher
  const langBar = document.createElement('div');
  langBar.className = '_nx-lang';
  langBar.innerHTML = `
    <button onclick="setLang('pt-BR')" class="${window.NEXIA_LANG==='pt-BR'?'active':''}">PT</button>
    <button onclick="setLang('en')" class="${window.NEXIA_LANG==='en'?'active':''}">EN</button>
    <button onclick="setLang('es')" class="${window.NEXIA_LANG==='es'?'active':''}">ES</button>
  `;
  document.body.appendChild(langBar);

  // Update lang buttons on change
  const origSetLang = window.setLang;
  window.setLang = function(lang){
    origSetLang(lang);
    document.querySelectorAll('._nx-lang button').forEach((b,i)=>{
      b.classList.toggle('active', ['pt-BR','en','es'][i]===lang);
    });
  };

  // Auto-hide after 1.2s
  window.addEventListener('load', function(){
    setTimeout(function(){
      splash.classList.add('hide');
      setTimeout(()=>{ if(splash.parentNode) splash.parentNode.removeChild(splash); }, 700);
    }, 1200);
  });
  // Fallback: hide after 2.5s regardless
  setTimeout(function(){
    splash.classList.add('hide');
  }, 2500);

  // Apply i18n on DOM ready
  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('[data-i18n]').forEach(el=>{
      const key=el.getAttribute('data-i18n');
      if(el.tagName==='INPUT'||el.tagName==='TEXTAREA') el.placeholder=window.t(key);
      else el.textContent=window.t(key);
    });
  });

})();
