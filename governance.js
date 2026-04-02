/**
 * ═══════════════════════════════════════════════════════════════════
 * NEXIA OS — GLOBAL GOVERNANCE & PERMISSIONS ENGINE v5.0
 * Controle de Acesso Soberano por Nível de Clearance
 * ═══════════════════════════════════════════════════════════════════
 */

const NexiaGovernance = {

    // GOD_MODE (100): Henrique / dono da plataforma — acesso total irrestrito
    // TENANT_ADMIN (50): Rafael (CES Brasil 2027/CES), admins de agência
    // OPERATOR (20): Guias, coordenadores de campo
    // PASSENGER (5): Usuário final do Super App
    levels: {
        GOD_MODE:     100,
        TENANT_ADMIN:  50,
        OPERATOR:      20,
        PASSENGER:      5
    },

    accessRules: {
        "NEXIA_MASTER": {
            requiredLevel:      100,
            canViewAllTenants:  true,
            canEditCore:        true,
            canAccessAppStore:  true,
            canManageUsers:     true,
            canViewBilling:     true,
            modules:            ["all"]
        },
        "VIAJANTE_PRO": {
            requiredLevel:      50,
            canViewAllTenants:  false,
            canEditCore:        false,
            canManageUsers:     true,
            canViewBilling:     true,
            modules:            ["turismo", "financeiro", "logistica", "passageiros", "guias"]
        },
        "CES": {
            requiredLevel:      50,
            canViewAllTenants:  false,
            canEditCore:        false,
            canManageUsers:     true,
            canViewBilling:     false,
            modules:            ["eventos", "compliance", "matchmaking", "despesas"]
        }
    },

    // Perfis de referência para Firebase Auth custom claims
    profiles: {
        "henrique@viajantepro.com.br": {
            clearance:   100,
            tenant:      "VP_AGENCIA_01",
            role:        "God Mode — Dono da Plataforma",
            canDelegate: true
        },
        "rafael@techbr.com.br": {
            clearance:   50,
            tenant:      "CES_2027_BR",
            role:        "Admin CES — CES Brasil 2027 Ventures",
            canDelegate: false
        }
    },

    validateAccess(user, required, redirect) {
        if (!user || typeof user.clearance !== 'number') {
            NEXIA.log('ACESSO NEGADO — usuário não autenticado', 'err');
            window.location.href = redirect || '/nexia/index.html';
            return false;
        }
        if (user.clearance < required) {
            NEXIA.log(`ACESSO NEGADO — clearance ${user.clearance} < requerido ${required}`, 'err');
            window.location.href = redirect || '/nexia/index.html';
            return false;
        }
        NEXIA.log(`Acesso autorizado — clearance ${user.clearance}`, 'ok');
        return true;
    },

    can(user, required) {
        return !!(user && typeof user.clearance === 'number' && user.clearance >= required);
    },

    getRules(tenantId) {
        const map = {
            "VP_AGENCIA_01": "VIAJANTE_PRO",
            "CES_2027_BR":   "CES",
            "NEXIA_MASTER":  "NEXIA_MASTER"
        };
        const key = map[tenantId] || tenantId;
        return this.accessRules[key] || null;
    },

    canAccessModule(user, tenantId, module) {
        if (!user) return false;
        if (user.clearance >= this.levels.GOD_MODE) return true;
        const rules = this.getRules(tenantId);
        if (!rules) return false;
        return rules.modules.includes('all') || rules.modules.includes(module);
    },

    // Esconde elementos DOM que o usuário não tem clearance para ver.
    // Uso: <div data-requires-level="100"> → escondido para não-GOD_MODE
    applyUIRules(user) {
        document.querySelectorAll('[data-requires-level]').forEach(el => {
            const required = parseInt(el.dataset.requiresLevel, 10);
            if (!this.can(user, required)) {
                el.style.display = 'none';
                el.setAttribute('aria-hidden', 'true');
            }
        });
        NEXIA.log('UI rules aplicadas', 'ok');
    }
};

NEXIA.log('Escudo de Governança Soberano Ativo — v5.0', 'ok');