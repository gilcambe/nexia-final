'use strict';
// NEXIA OS — CORE CONFIGURATION ENGINE v8.0 CORRIGIDO
const XSS_PATTERNS = [/<script[\s>]/i, /<\/script>/i, /javascript\s*:/i, /on\w+\s*=/i];
class NexiaCore {
  sanitize(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
  }
}
const NEXIA = new NexiaCore();
window.NEXIA = NEXIA;