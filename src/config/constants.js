// 📁 backend/src/config/constants.js

// ============================================================
// CONSTANTES GLOBALES - SOURCE UNIQUE DE VÉRITÉ
// ============================================================

// ============================================================
// 1. STATUTS DES VISITES
// ============================================================

const VISIT_STATUS = {
  // ✅ Statuts standards
  PLANNED: 'planifiee',
  PENDING: 'en_attente',
  ACCEPTED: 'acceptee',
  IN_PROGRESS: 'en_cours',
  COMPLETED: 'terminee',
  VALIDATED: 'validee',
  CANCELLED: 'annulee',
  REFUSED: 'refusee',
  EXPIRED: 'expire',
  
  // ✅ Statuts spéciaux
  DRAFT: 'brouillon',
  WAITING_AIDANT: 'en_attente_aidant',
  WAITING_PAYMENT: 'attente_paiement',
  NO_SHOW: 'no_show',
  RESCHEDULED: 'replanifiee',
};

const VISIT_STATUS_LABELS = {
  [VISIT_STATUS.PLANNED]: 'Planifiée',
  [VISIT_STATUS.PENDING]: 'En attente',
  [VISIT_STATUS.ACCEPTED]: 'Acceptée',
  [VISIT_STATUS.IN_PROGRESS]: 'En cours',
  [VISIT_STATUS.COMPLETED]: 'Terminée',
  [VISIT_STATUS.VALIDATED]: 'Validée',
  [VISIT_STATUS.CANCELLED]: 'Annulée',
  [VISIT_STATUS.REFUSED]: 'Refusée',
  [VISIT_STATUS.EXPIRED]: 'Expirée',
  [VISIT_STATUS.DRAFT]: '💳 En attente paiement',
  [VISIT_STATUS.WAITING_AIDANT]: '🦸 En attente aidant',
  [VISIT_STATUS.WAITING_PAYMENT]: '💳 En attente paiement',
  [VISIT_STATUS.NO_SHOW]: 'Absent',
  [VISIT_STATUS.RESCHEDULED]: 'Replanifiée',
};

const VISIT_STATUS_COLORS = {
  [VISIT_STATUS.PLANNED]: '#4CAF50',
  [VISIT_STATUS.PENDING]: '#FF9800',
  [VISIT_STATUS.ACCEPTED]: '#2196F3',
  [VISIT_STATUS.IN_PROGRESS]: '#2196F3',
  [VISIT_STATUS.COMPLETED]: '#9C27B0',
  [VISIT_STATUS.VALIDATED]: '#4CAF50',
  [VISIT_STATUS.CANCELLED]: '#F44336',
  [VISIT_STATUS.REFUSED]: '#F44336',
  [VISIT_STATUS.EXPIRED]: '#795548',
  [VISIT_STATUS.DRAFT]: '#F59E0B',
  [VISIT_STATUS.WAITING_AIDANT]: '#FF5722',
  [VISIT_STATUS.WAITING_PAYMENT]: '#8b5cf6',
  [VISIT_STATUS.NO_SHOW]: '#795548',
  [VISIT_STATUS.RESCHEDULED]: '#FF5722',
};

// ============================================================
// 2. STATUTS DES COMMANDES
// ============================================================

const ORDER_STATUS = {
  CREATED: 'creee',
  PENDING: 'en_attente',
  AVAILABLE: 'disponible',
  IN_PROGRESS: 'en_cours',
  DELIVERED: 'livree',
  VALIDATED: 'validee',
  CANCELLED: 'annulee',
  WAITING_PAYMENT: 'attente_paiement',
};

const ORDER_STATUS_LABELS = {
  [ORDER_STATUS.CREATED]: 'Créée',
  [ORDER_STATUS.PENDING]: 'En attente',
  [ORDER_STATUS.AVAILABLE]: '🚨 Disponible',
  [ORDER_STATUS.IN_PROGRESS]: 'En cours',
  [ORDER_STATUS.DELIVERED]: 'Livrée',
  [ORDER_STATUS.VALIDATED]: 'Validée',
  [ORDER_STATUS.CANCELLED]: 'Annulée',
  [ORDER_STATUS.WAITING_PAYMENT]: '💳 En attente paiement',
};

const ORDER_STATUS_COLORS = {
  [ORDER_STATUS.CREATED]: '#9E9E9E',
  [ORDER_STATUS.PENDING]: '#FF9800',
  [ORDER_STATUS.AVAILABLE]: '#F44336',
  [ORDER_STATUS.IN_PROGRESS]: '#2196F3',
  [ORDER_STATUS.DELIVERED]: '#2196F3',
  [ORDER_STATUS.VALIDATED]: '#4CAF50',
  [ORDER_STATUS.CANCELLED]: '#9E9E9E',
  [ORDER_STATUS.WAITING_PAYMENT]: '#8b5cf6',
};

// ============================================================
// 3. STATUTS DES PAIEMENTS
// ============================================================

const PAYMENT_STATUS = {
  PENDING: 'en_attente',
  VALIDATED: 'valide',
  FAILED: 'echoue',
  REFUNDED: 'rembourse',
  CANCELLED: 'annule',
  WAITING_CONFIRMATION: 'en_attente_de_confirmation',
};

const PAYMENT_STATUS_LABELS = {
  [PAYMENT_STATUS.PENDING]: 'En attente',
  [PAYMENT_STATUS.VALIDATED]: 'Validé ✅',
  [PAYMENT_STATUS.FAILED]: 'Échoué ❌',
  [PAYMENT_STATUS.REFUNDED]: 'Remboursé 🔄',
  [PAYMENT_STATUS.CANCELLED]: 'Annulé ❌',
  [PAYMENT_STATUS.WAITING_CONFIRMATION]: 'En attente de confirmation ⏳',
};

// ============================================================
// 4. STATUTS DES ABONNEMENTS
// ============================================================

const SUBSCRIPTION_STATUS = {
  PENDING: 'en_attente',
  ACTIVE: 'actif',
  EXPIRED: 'expire',
  CANCELLED: 'annule',
  SUSPENDED: 'suspendu',
  RENEWING: 'en_cours_de_renouvellement',
};

const SUBSCRIPTION_STATUS_LABELS = {
  [SUBSCRIPTION_STATUS.PENDING]: 'En attente ⏳',
  [SUBSCRIPTION_STATUS.ACTIVE]: 'Actif 🟢',
  [SUBSCRIPTION_STATUS.EXPIRED]: 'Expiré 🔴',
  [SUBSCRIPTION_STATUS.CANCELLED]: 'Annulé 🚫',
  [SUBSCRIPTION_STATUS.SUSPENDED]: 'Suspendu ⏸️',
  [SUBSCRIPTION_STATUS.RENEWING]: 'Renouvellement 🔄',
};

// ============================================================
// 5. TYPES DE CIBLES (ASSIGNATIONS)
// ============================================================

const TARGET_TYPES = {
  PATIENT: 'patient',
  PERSONAL_ACCOUNT: 'personal_account',
  FAMILY: 'family',
};

const TARGET_TYPES_LABELS = {
  [TARGET_TYPES.PATIENT]: 'Patient 👤',
  [TARGET_TYPES.PERSONAL_ACCOUNT]: 'Compte personnel 👤',
  [TARGET_TYPES.FAMILY]: 'Famille 👨‍👩‍👦',
};

// ============================================================
// 6. TYPES D'ASSIGNATION
// ============================================================

const ASSIGNMENT_TYPES = {
  PRIMARY: 'primary',
  SECONDARY: 'secondary',
  TEMPORARY: 'temporary',
};

const ASSIGNMENT_TYPES_LABELS = {
  [ASSIGNMENT_TYPES.PRIMARY]: '📌 Permanente',
  [ASSIGNMENT_TYPES.SECONDARY]: '⚡ Ponctuelle',
  [ASSIGNMENT_TYPES.TEMPORARY]: '⏳ Temporaire',
};

const ASSIGNMENT_TYPES_COLORS = {
  [ASSIGNMENT_TYPES.PRIMARY]: '#10B981',
  [ASSIGNMENT_TYPES.SECONDARY]: '#3B82F6',
  [ASSIGNMENT_TYPES.TEMPORARY]: '#F59E0B',
};

// ============================================================
// 7. STATUTS DES ASSIGNATIONS
// ============================================================

const ASSIGNMENT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  EXPIRED: 'expired',
};

// ============================================================
// 8. RÔLES UTILISATEURS
// ============================================================

const USER_ROLES = {
  FAMILY: 'family',
  AIDANT: 'aidant',
  COORDINATOR: 'coordinator',
  ADMIN: 'admin',
};

const USER_ROLES_LABELS = {
  [USER_ROLES.FAMILY]: '👨‍👩‍👦 Famille',
  [USER_ROLES.AIDANT]: '🦸 Aidant',
  [USER_ROLES.COORDINATOR]: '👔 Coordinateur',
  [USER_ROLES.ADMIN]: '👑 Administrateur',
};

// ============================================================
// 9. TYPES DE NOTIFICATIONS
// ============================================================

const NOTIFICATION_TYPES = {
  VISIT: 'visite',
  MESSAGE: 'message',
  ORDER: 'commande',
  PAYMENT: 'paiement',
  SYSTEM: 'system',
  ALERT: 'alert',
  REMINDER: 'reminder',
  PROMOTION: 'promotion',
};

// ============================================================
// 10. QUOTAS ET LIMITES
// ============================================================

const QUOTAS = {
  // Assignations permanentes
  MAX_ASSIGNMENTS_PER_AIDANT: 4,
  
  // Commandes en cours
  MAX_ORDERS_IN_PROGRESS: 2,
  
  // Visites par abonnement (valeur par défaut)
  DEFAULT_VISITS_PER_SUBSCRIPTION: 4,
  
  // Commandes par abonnement (valeur par défaut)
  DEFAULT_ORDERS_PER_SUBSCRIPTION: 4,
};

// ============================================================
// 11. PRIX ET TARIFS
// ============================================================

const PRICES = {
  // Visites ponctuelles
  VISIT_PONCTUAL: {
    '30': 5000,
    '45': 6000,
    '60': 7500,
    '90': 10000,
    '120': 12500,
  },
  DEFAULT_VISIT_PRICE: 7500,
  
  // Commandes ponctuelles
  ORDER_PONCTUAL: {
    medicaments: 5000,
    produits_bebe: 5000,
    produits_hygiene: 4000,
    courses: 3000,
    repas: 4000,
    autre: 5000,
  },
  DEFAULT_ORDER_PRICE: 2500,
};

// ============================================================
// 12. DÉLAIS ET EXPIRATIONS
// ============================================================

const DELAYS = {
  // Brouillons
  DRAFT_EXPIRY_HOURS: 24,
  
  // Auto-validation des commandes
  AUTO_VALIDATION_HOURS: 12,
  
  // Visites sans réponse
  VISIT_NO_RESPONSE_HOURS: 24,
  
  // Commandes sans réponse
  ORDER_NO_RESPONSE_MINUTES: 30,
};

// ============================================================
// 13. PRIORITÉS
// ============================================================

const PRIORITY = {
  PATIENT: 1,
  PERSONAL_ACCOUNT: 2,
  FAMILY: 3,
};

const PRIORITY_LABELS = {
  [PRIORITY.PATIENT]: 'P1 - Patient',
  [PRIORITY.PERSONAL_ACCOUNT]: 'P2 - Compte personnel',
  [PRIORITY.FAMILY]: 'P3 - Famille',
};

// ============================================================
// 14. RÈGLES D'ASSIGNATION
// ============================================================

const ASSIGNMENT_RULES = {
  // Ordre de priorité pour la recherche d'aidant
  PRIORITY_ORDER: [
    TARGET_TYPES.PATIENT,
    TARGET_TYPES.PERSONAL_ACCOUNT,
    TARGET_TYPES.FAMILY,
  ],
  
  // Types d'assignation autorisés par rôle
  ALLOWED_ASSIGNMENTS: {
    [USER_ROLES.FAMILY]: [
      ASSIGNMENT_TYPES.PRIMARY,
      ASSIGNMENT_TYPES.SECONDARY,
    ],
    [USER_ROLES.ADMIN]: [
      ASSIGNMENT_TYPES.PRIMARY,
      ASSIGNMENT_TYPES.SECONDARY,
      ASSIGNMENT_TYPES.TEMPORARY,
    ],
    [USER_ROLES.COORDINATOR]: [
      ASSIGNMENT_TYPES.PRIMARY,
      ASSIGNMENT_TYPES.SECONDARY,
      ASSIGNMENT_TYPES.TEMPORARY,
    ],
  },
  
  // Quotas par rôle
  QUOTAS_BY_ROLE: {
    [USER_ROLES.FAMILY]: {
      maxAssignments: QUOTAS.MAX_ASSIGNMENTS_PER_AIDANT,
      maxOrders: QUOTAS.MAX_ORDERS_IN_PROGRESS,
    },
    [USER_ROLES.ADMIN]: {
      maxAssignments: null, // Illimité
      maxOrders: null, // Illimité
    },
    [USER_ROLES.COORDINATOR]: {
      maxAssignments: null, // Illimité
      maxOrders: null, // Illimité
    },
  },
};

// ============================================================
// 15. STATUTS D'INSCRIPTION
// ============================================================

const REGISTRATION_STATUS = {
  PENDING: 'en_attente',
  VALIDATED: 'validee',
  REFUSED: 'refusee',
  INFO_REQUIRED: 'info_requise',
  PROCESSING: 'en_cours_de_traitement',
};

const REGISTRATION_STATUS_LABELS = {
  [REGISTRATION_STATUS.PENDING]: 'En attente ⏳',
  [REGISTRATION_STATUS.VALIDATED]: 'Validée ✅',
  [REGISTRATION_STATUS.REFUSED]: 'Refusée ❌',
  [REGISTRATION_STATUS.INFO_REQUIRED]: 'Info requise ℹ️',
  [REGISTRATION_STATUS.PROCESSING]: 'En cours 🔄',
};

// ============================================================
// 16. TYPES DE VISITES
// ============================================================

const VISIT_TYPES = {
  PATIENT: 'patient',
  PERSONAL: 'personal',
};

const VISIT_TYPES_LABELS = {
  [VISIT_TYPES.PATIENT]: 'Proche 👤',
  [VISIT_TYPES.PERSONAL]: 'Personnel 👤',
};

// ============================================================
// 17. TYPES DE COMMANDES
// ============================================================

const ORDER_TYPES = {
  SUBSCRIPTION: 'subscription',
  PONCTUAL: 'ponctual',
};

// ============================================================
// 18. JOURS DE LA SEMAINE
// ============================================================

const DAYS_OF_WEEK = [
  { value: 'monday', label: 'Lundi' },
  { value: 'tuesday', label: 'Mardi' },
  { value: 'wednesday', label: 'Mercredi' },
  { value: 'thursday', label: 'Jeudi' },
  { value: 'friday', label: 'Vendredi' },
  { value: 'saturday', label: 'Samedi' },
  { value: 'sunday', label: 'Dimanche' },
];

// ============================================================
// 19. MÉTHODES DE PAIEMENT
// ============================================================

const PAYMENT_METHODS = {
  MOBILE_MONEY: 'mobile_money',
  CARD: 'card',
  BANK_TRANSFER: 'bank_transfer',
  CASH: 'cash',
  WALLET: 'wallet',
};

// ============================================================
// 20. SOURCES D'INSCRIPTION
// ============================================================

const REGISTRATION_SOURCES = {
  WEB: 'web',
  APP: 'app',
  ADMIN: 'admin',
  API: 'api',
};

// ============================================================
// 21. CATÉGORIES DE PATIENTS
// ============================================================

const PATIENT_CATEGORIES = {
  SENIOR: 'senior',
  MAMAN_BEBE: 'maman_bebe',
};

const PATIENT_CATEGORIES_LABELS = {
  [PATIENT_CATEGORIES.SENIOR]: '👴 Senior',
  [PATIENT_CATEGORIES.MAMAN_BEBE]: '👶 Maman & Bébé',
};

// ============================================================
// 22. SPÉCIALITÉS DES AIDANTS
// ============================================================

const AIDANT_SPECIALTIES = {
  SENIOR: 'senior',
  MAMAN_BEBE: 'maman_bebe',
  ACCOMPAGNEMENT: 'accompagnement',
  AUTRE: 'autre',
};

const AIDANT_SPECIALTIES_LABELS = {
  [AIDANT_SPECIALTIES.SENIOR]: '👴 Senior',
  [AIDANT_SPECIALTIES.MAMAN_BEBE]: '👶 Maman & Bébé',
  [AIDANT_SPECIALTIES.ACCOMPAGNEMENT]: '🤝 Accompagnement',
  [AIDANT_SPECIALTIES.AUTRE]: '📝 Autre',
};

// ============================================================
// 23. ZONES D'INTERVENTION
// ============================================================

const ZONES = [
  'Cotonou',
  'Abomey-Calavi',
  'Porto-Novo',
  'Ouidah',
  'Bohicon',
  'Parakou',
  'Autre',
];

// ============================================================
// 24. ACTIONS DE VISITE
// ============================================================

const VISIT_ACTIONS = {
  // Senior
  SENIOR: [
    { id: 'presence', label: 'Présence', icon: '👤' },
    { id: 'aide_quotidien', label: 'Aide au quotidien', icon: '🤝' },
    { id: 'rappel_medicament', label: 'Rappel médicament', icon: '💊' },
    { id: 'verification_generale', label: 'Vérification générale', icon: '✅' },
    { id: 'accompagnement', label: 'Accompagnement', icon: '🚶' },
    { id: 'discussion', label: 'Discussion', icon: '💬' },
    { id: 'rangement_leger', label: 'Rangement léger', icon: '🧹' },
    { id: 'observation', label: 'Observation', icon: '👀' },
    { id: 'prise_constants', label: 'Prise des constants', icon: '🩺' },
    { id: 'aide_repas', label: 'Aide au repas', icon: '🍽️' },
  ],
  
  // Maman & Bébé
  MAMAN: [
    { id: 'aide_organisation', label: 'Aide organisation', icon: '📋' },
    { id: 'soutien_moral', label: 'Soutien moral', icon: '💝' },
    { id: 'aide_repas', label: 'Aide repas simple', icon: '🍲' },
    { id: 'observation_bebe', label: 'Observation bébé', icon: '👶' },
    { id: 'conseils', label: 'Conseils non médicaux', icon: '📖' },
    { id: 'accompagnement_retour', label: 'Accompagnement retour maison', icon: '🏠' },
    { id: 'presence_rassurante', label: 'Présence rassurante', icon: '🤗' },
    { id: 'coordination_familiale', label: 'Coordination familiale', icon: '👨‍👩‍👦' },
    { id: 'aide_allaitement', label: "Aide à l'allaitement", icon: '🍼' },
    { id: 'ecoute_active', label: 'Écoute active', icon: '👂' },
  ],
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Statuts
  VISIT_STATUS,
  VISIT_STATUS_LABELS,
  VISIT_STATUS_COLORS,
  ORDER_STATUS,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_COLORS,
  PAYMENT_STATUS,
  PAYMENT_STATUS_LABELS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUS_LABELS,
  REGISTRATION_STATUS,
  REGISTRATION_STATUS_LABELS,
  
  // Types
  TARGET_TYPES,
  TARGET_TYPES_LABELS,
  ASSIGNMENT_TYPES,
  ASSIGNMENT_TYPES_LABELS,
  ASSIGNMENT_TYPES_COLORS,
  ASSIGNMENT_STATUS,
  USER_ROLES,
  USER_ROLES_LABELS,
  NOTIFICATION_TYPES,
  VISIT_TYPES,
  VISIT_TYPES_LABELS,
  ORDER_TYPES,
  PATIENT_CATEGORIES,
  PATIENT_CATEGORIES_LABELS,
  AIDANT_SPECIALTIES,
  AIDANT_SPECIALTIES_LABELS,
  PAYMENT_METHODS,
  REGISTRATION_SOURCES,
  
  // Quotas
  QUOTAS,
  
  // Prix
  PRICES,
  
  // Délais
  DELAYS,
  
  // Priorités
  PRIORITY,
  PRIORITY_LABELS,
  
  // Règles
  ASSIGNMENT_RULES,
  
  // Listes
  DAYS_OF_WEEK,
  ZONES,
  VISIT_ACTIONS,
};
