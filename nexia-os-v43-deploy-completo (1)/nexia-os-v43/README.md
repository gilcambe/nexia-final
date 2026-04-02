# NEXIA OS v43 — Projeto Completo para Deploy

30 bugs corrigidos. Estrutura:
- netlify/functions/ — 9 functions JS (backend)
- nexia/ — cortex-app.html, architect.html
- tenants/ — ces.html, viajante-pro.html, splash.html, bezsan.html
- index.html, cortex-lab.html, netlify.toml, package.json, firestore.rules

Tenants incluidos:
- CES Brasil 2027 (eventos, matchmaking, compliance)
- Viajante Pro (turismo, roteiros, financeiro, logistica)
- Splash (marketing digital, campanhas, analytics)
- Bezsan Leiloes (leiloes ao vivo, financeiro, CORTEX)

Variaveis de ambiente (Netlify):
FIREBASE_SERVICE_ACCOUNT, GROQ_API_KEY, GEMINI_API_KEY, NEXIA_APP_URL

Deploy: git push ou drag-and-drop no Netlify.
Teste: node test-endpoints.js https://seu-site.netlify.app nexia
