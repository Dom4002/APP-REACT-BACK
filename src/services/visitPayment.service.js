// 📁 backend/src/services/visitPayment.service.js

const { supabase } = require('./supabase.service');
const { createNotification } = require('./notification.service');

// ============================================================
// CONSTANTES - SOURCE UNIQUE DE VÉRITÉ
// ============================================================

const VISIT_STATUS = {
  DRAFT: 'brouillon',
  PLANNED: 'planifiee',
  PENDING: 'en_attente',
  ACCEPTED: 'acceptee',
  IN_PROGRESS: 'en_cours',
  COMPLETED: 'terminee',
  VALIDATED: 'validee',
  CANCELLED: 'annulee',
  REFUSED: 'refusee',
  EXPIRED: 'expire',
  WAITING_AIDANT: 'en_attente_aidant',
  WAITING_PAYMENT: 'attente_paiement',
};

const VISIT_PAYMENT_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REFUNDED: 'refunded',
};

// ✅ PRIX DES VISITES PONCTUELLES - SOURCE UNIQUE
const VISIT_PONCTUAL_PRICES = {
  '30': 5000,
  '45': 6000,
  '60': 7500,
  '90': 10000,
  '120': 12500,
};

const DEFAULT_VISIT_PRICE = 7500;
const DRAFT_EXPIRY_HOURS = 24;

// ✅ EXPORTER LES CONSTANTES
module.exports.VISIT_PONCTUAL_PRICES = VISIT_PONCTUAL_PRICES;
module.exports.DEFAULT_VISIT_PRICE = DEFAULT_VISIT_PRICE;
module.exports.VISIT_STATUS = VISIT_STATUS;
module.exports.VISIT_PAYMENT_STATUS = VISIT_PAYMENT_STATUS;
module.exports.DRAFT_EXPIRY_HOURS = DRAFT_EXPIRY_HOURS;

/**
 * Calcule le prix d'une visite ponctuelle en fonction de sa durée
 * @param {number} durationMinutes - Durée en minutes (30, 45, 60, 90, 120)
 * @returns {number} Prix en FCFA
 */
const getVisitPrice = (durationMinutes = 60) => {
  const price = VISIT_PONCTUAL_PRICES[durationMinutes.toString()];
  if (price) return price;
  return Math.round((durationMinutes / 60) * DEFAULT_VISIT_PRICE);
};

module.exports.getVisitPrice = getVisitPrice;

// ============================================================
// FONCTIONS DE PRIX POUR LES COMMANDES PONCTUELLES
// ============================================================

/**
 * Calcule le prix d'une commande ponctuelle
 * @param {Array} items - Liste des articles
 * @param {string} type - Type de commande
 * @returns {number} Prix en FCFA
 */
const getPonctualOrderPrice = (items = [], type = 'autre') => {
  // Si des articles sont fournis, calculer le total
  if (items && items.length > 0) {
    const total = items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
    if (total > 0) return total;
  }
  
  // Sinon, prix forfaitaire selon le type
  const orderPrices = {
    medicaments: 5000,
    produits_bebe: 5000,
    produits_hygiene: 4000,
    courses: 3000,
    repas: 4000,
    autre: 5000,
  };
  return orderPrices[type] || 5000;
};

module.exports.getPonctualOrderPrice = getPonctualOrderPrice;

// ============================================================
// VÉRIFICATION DE L'ABONNEMENT
// ============================================================

/**
 * Vérifie si l'utilisateur a un abonnement actif avec des visites disponibles
 * @param {string} userId - ID de l'utilisateur
 * @returns {Promise<{hasActiveSubscription: boolean, remainingVisits: number, subscription: any}>}
 */
const checkSubscriptionForVisits = async (userId) => {
  try {
    const { data: subscription, error } = await supabase
      .from('abonnements')
      .select('id, remaining_visits, status, total_visits, used_visits, offre_id, end_date')
      .eq('user_id', userId)
      .eq('status', 'actif')
      .maybeSingle();

    if (error) {
      console.error('❌ Erreur vérification abonnement:', error);
      return {
        hasActiveSubscription: false,
        remainingVisits: 0,
        subscription: null,
      };
    }

    if (!subscription) {
      return {
        hasActiveSubscription: false,
        remainingVisits: 0,
        subscription: null,
      };
    }

    const today = new Date();
    const endDate = new Date(subscription.end_date);
    const isExpired = endDate < today;

    if (isExpired) {
      // Mettre à jour le statut si expiré
      await supabase
        .from('abonnements')
        .update({ status: 'expire' })
        .eq('id', subscription.id);
      
      return {
        hasActiveSubscription: false,
        remainingVisits: 0,
        subscription: null,
      };
    }

    return {
      hasActiveSubscription: true,
      remainingVisits: subscription.remaining_visits || 0,
      subscription: subscription,
    };
  } catch (error) {
    console.error('❌ checkSubscriptionForVisits error:', error);
    return {
      hasActiveSubscription: false,
      remainingVisits: 0,
      subscription: null,
    };
  }
};

module.exports.checkSubscriptionForVisits = checkSubscriptionForVisits;

/**
 * Vérifie si l'utilisateur a un abonnement actif avec des commandes disponibles
 * @param {string} userId - ID de l'utilisateur
 * @returns {Promise<{hasActiveSubscription: boolean, remainingOrders: number, subscription: any}>}
 */
const checkSubscriptionForOrders = async (userId) => {
  try {
    const { data: subscription, error } = await supabase
      .from('abonnements')
      .select('id, remaining_orders, status, total_orders, used_orders, offre_id, end_date')
      .eq('user_id', userId)
      .eq('status', 'actif')
      .maybeSingle();

    if (error) {
      console.error('❌ Erreur vérification abonnement:', error);
      return {
        hasActiveSubscription: false,
        remainingOrders: 0,
        subscription: null,
      };
    }

    if (!subscription) {
      return {
        hasActiveSubscription: false,
        remainingOrders: 0,
        subscription: null,
      };
    }

    const today = new Date();
    const endDate = new Date(subscription.end_date);
    const isExpired = endDate < today;

    if (isExpired) {
      await supabase
        .from('abonnements')
        .update({ status: 'expire' })
        .eq('id', subscription.id);
      
      return {
        hasActiveSubscription: false,
        remainingOrders: 0,
        subscription: null,
      };
    }

    return {
      hasActiveSubscription: true,
      remainingOrders: subscription.remaining_orders || 0,
      subscription: subscription,
    };
  } catch (error) {
    console.error('❌ checkSubscriptionForOrders error:', error);
    return {
      hasActiveSubscription: false,
      remainingOrders: 0,
      subscription: null,
    };
  }
};

module.exports.checkSubscriptionForOrders = checkSubscriptionForOrders;

// ============================================================
// DÉCOMPTE DES VISITES/COMMANDES
// ============================================================

/**
 * Décompte une visite de l'abonnement
 * @param {string} subscriptionId - ID de l'abonnement
 * @returns {Promise<Object>} Résultat du décompte
 */
const decrementVisit = async (subscriptionId) => {
  try {
    const { data: subscription, error: fetchError } = await supabase
      .from('abonnements')
      .select('remaining_visits, used_visits, user_id')
      .eq('id', subscriptionId)
      .single();

    if (fetchError) throw fetchError;

    if (subscription.remaining_visits <= 0) {
      return { success: false, error: 'Plus de visites disponibles' };
    }

    const { data, error } = await supabase
      .from('abonnements')
      .update({
        remaining_visits: subscription.remaining_visits - 1,
        used_visits: subscription.used_visits + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', subscriptionId)
      .select()
      .single();

    if (error) throw error;

    // Notification si plus de visites
    if (data.remaining_visits === 0) {
      await createNotification({
        userId: subscription.user_id,
        title: '⚠️ Plus de visites disponibles',
        body: 'Votre abonnement a atteint le nombre maximum de visites. Pensez à renouveler.',
        type: 'system',
        data: { subscription_id: subscriptionId },
      });
    }

    return { success: true, subscription: data };
  } catch (error) {
    console.error('❌ decrementVisit error:', error);
    return { success: false, error: error.message };
  }
};

module.exports.decrementVisit = decrementVisit;

/**
 * Décompte une commande de l'abonnement
 * @param {string} subscriptionId - ID de l'abonnement
 * @returns {Promise<Object>} Résultat du décompte
 */
const decrementOrder = async (subscriptionId) => {
  try {
    const { data: subscription, error: fetchError } = await supabase
      .from('abonnements')
      .select('remaining_orders, used_orders, user_id')
      .eq('id', subscriptionId)
      .single();

    if (fetchError) throw fetchError;

    if (subscription.remaining_orders <= 0) {
      return { success: false, error: 'Plus de commandes disponibles' };
    }

    const { data, error } = await supabase
      .from('abonnements')
      .update({
        remaining_orders: subscription.remaining_orders - 1,
        used_orders: subscription.used_orders + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', subscriptionId)
      .select()
      .single();

    if (error) throw error;

    if (data.remaining_orders === 0) {
      await createNotification({
        userId: subscription.user_id,
        title: '⚠️ Plus de commandes disponibles',
        body: 'Votre abonnement a atteint le nombre maximum de commandes. Pensez à renouveler.',
        type: 'system',
        data: { subscription_id: subscriptionId },
      });
    }

    return { success: true, subscription: data };
  } catch (error) {
    console.error('❌ decrementOrder error:', error);
    return { success: false, error: error.message };
  }
};

module.exports.decrementOrder = decrementOrder;

// ============================================================
// GESTION DES BROUILLONS
// ============================================================

/**
 * Nettoie les brouillons expirés (job cron)
 * @returns {Promise<number>} Nombre de brouillons nettoyés
 */
const cleanExpiredDrafts = async () => {
  try {
    const now = new Date().toISOString();

    const { data: expiredDrafts, error } = await supabase
      .from('visites')
      .select('id, user_id, target_name')
      .eq('status', VISIT_STATUS.DRAFT)
      .lt('draft_expires_at', now);

    if (error) {
      console.error('❌ Erreur récupération brouillons expirés:', error);
      return 0;
    }

    let count = 0;
    for (const draft of expiredDrafts) {
      await supabase
        .from('visites')
        .update({
          status: VISIT_STATUS.EXPIRED,
          metadata: {
            expired_reason: 'draft_expired_auto',
            expired_at: new Date().toISOString(),
          }
        })
        .eq('id', draft.id);

      await createNotification({
        userId: draft.user_id,
        title: '⏰ Brouillon de visite expiré',
        body: `Votre brouillon de visite pour ${draft.target_name || 'le patient'} a expiré. Vous pouvez en créer un nouveau.`,
        type: 'visite',
        data: { visit_id: draft.id, status: 'expired' },
      });

      count++;
    }

    if (count > 0) {
      console.log(`🗑️ ${count} brouillons expirés nettoyés`);
    }

    return count;
  } catch (error) {
    console.error('❌ cleanExpiredDrafts error:', error);
    return 0;
  }
};

module.exports.cleanExpiredDrafts = cleanExpiredDrafts;

// ============================================================
// 🆕 NOUVELLES FONCTIONS POUR LE SYSTÈME COMPLET
// ============================================================

/**
 * Vérifie si un aidant est disponible pour une visite
 * @param {string} targetType - 'patient' | 'personal_account'
 * @param {string} targetId - UUID de la cible
 * @param {string} familyId - UUID de la famille
 * @returns {Promise<Object>} - { hasAidant, aidantId, availableAidants, allFull }
 */
const checkAidantForVisit = async (targetType, targetId, familyId) => {
  try {
    const { getActiveAidantForTarget, getAvailableAidantsForFamily } = require('./aidantAssignment.service');

    // 1. Vérifier si un aidant est déjà assigné
    const aidantId = await getActiveAidantForTarget(targetType, targetId, familyId);

    if (aidantId) {
      return {
        hasAidant: true,
        aidantId: aidantId,
        availableAidants: [],
        allFull: false,
      };
    }

    // 2. Récupérer les aidants disponibles
    const availableAidants = await getAvailableAidantsForFamily(familyId);

    if (availableAidants.length > 0) {
      return {
        hasAidant: false,
        aidantId: null,
        availableAidants: availableAidants,
        allFull: false,
      };
    }

    // 3. Tous les aidants sont full
    return {
      hasAidant: false,
      aidantId: null,
      availableAidants: [],
      allFull: true,
    };
  } catch (error) {
    console.error('❌ checkAidantForVisit error:', error);
    return {
      hasAidant: false,
      aidantId: null,
      availableAidants: [],
      allFull: true,
      error: error.message,
    };
  }
};

module.exports.checkAidantForVisit = checkAidantForVisit;

/**
 * Récupère les options du wizard pour une visite
 * @param {string} targetType - 'patient' | 'personal_account'
 * @param {string} targetId - UUID de la cible
 * @param {string} familyId - UUID de la famille
 * @param {string} userRole - Rôle de l'utilisateur
 * @returns {Promise<Object>} - Options du wizard
 */
const getVisitWizardOptions = async (targetType, targetId, familyId, userRole = 'family') => {
  try {
    const { getAvailableAidantsForFamily, isAidantFull } = require('./aidantAssignment.service');
    const isAdmin = userRole === 'admin' || userRole === 'coordinator';

    // 1. Vérifier si un aidant est déjà assigné
    const { getActiveAidantForTarget } = require('./aidantAssignment.service');
    const aidantId = await getActiveAidantForTarget(targetType, targetId, familyId);

    if (aidantId) {
      return {
        hasAidant: true,
        aidantId: aidantId,
        hasAvailableAidants: false,
        aidants: [],
        options: [
          {
            type: 'auto',
            label: '✅ Aidant automatique',
            description: 'Un aidant est déjà assigné à ce compte',
            quota: 0,
          },
        ],
        canProceed: true,
        allFull: false,
      };
    }

    // 2. Récupérer les aidants disponibles
    const availableAidants = await getAvailableAidantsForFamily(familyId);

    if (availableAidants.length > 0) {
      const options = [
        {
          type: 'ponctuelle',
          label: '⚡ Pour cette visite uniquement',
          description: 'Ne consomme pas de quota',
          quota: 0,
        },
        {
          type: 'permanente',
          label: '📌 Permanent',
          description: 'Consomme 1 quota',
          quota: 1,
        },
      ];

      // ✅ Admin a une option supplémentaire
      if (isAdmin) {
        options.push({
          type: 'force',
          label: '👔 Force (Admin)',
          description: 'Ignore le quota (5/4, 6/4, etc.)',
          quota: 'illimité',
        });
      }

      return {
        hasAidant: false,
        aidantId: null,
        hasAvailableAidants: true,
        aidants: availableAidants,
        options: options,
        canProceed: true,
        allFull: false,
        isAdmin: isAdmin,
      };
    }

    // 3. Tous les aidants sont full
    const options = [
      {
        type: 'without_aidant',
        label: '⚡ Planifier sans aidant',
        description: "L'admin sera notifié pour assigner un aidant",
        quota: 0,
      },
    ];

    // ✅ Admin peut forcer même si full
    if (isAdmin) {
      options.push({
        type: 'force',
        label: '👔 Force (Admin)',
        description: 'Ignorer le quota (5/4, 6/4, etc.)',
        quota: 'illimité',
      });
    }

    return {
      hasAidant: false,
      aidantId: null,
      hasAvailableAidants: false,
      aidants: [],
      options: options,
      canProceed: true,
      allFull: true,
      isAdmin: isAdmin,
      message: 'Tous les aidants sont actuellement complets (4/4)',
    };
  } catch (error) {
    console.error('❌ getVisitWizardOptions error:', error);
    return {
      hasAidant: false,
      aidantId: null,
      hasAvailableAidants: false,
      aidants: [],
      options: [],
      canProceed: false,
      allFull: true,
      error: error.message,
    };
  }
};

module.exports.getVisitWizardOptions = getVisitWizardOptions;

/**
 * Valide une visite créée sans aidant
 * @param {string} visitId - UUID de la visite
 * @param {string} adminId - UUID de l'admin qui valide
 * @param {string} aidantId - UUID de l'aidant assigné (optionnel)
 * @param {string} assignmentType - 'permanente' | 'ponctuelle'
 * @returns {Promise<Object>}
 */
const validateVisitWithoutAidant = async ({
  visitId,
  adminId,
  aidantId = null,
  assignmentType = 'permanente',
}) => {
  try {
    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', visitId)
      .single();

    if (visitError || !visit) {
      return {
        success: false,
        error: 'Visite non trouvée',
        code: 'VISIT_NOT_FOUND',
      };
    }

    if (visit.status !== VISIT_STATUS.WAITING_AIDANT) {
      return {
        success: false,
        error: `La visite n'est pas en attente d'aidant. Statut: ${visit.status}`,
        code: 'INVALID_STATUS',
      };
    }

    // Si un aidant est fourni, l'assigner
    if (aidantId) {
      const { assignAidantToVisit } = require('./visit.service');
      const result = await assignAidantToVisit({
        visitId,
        aidantUserId: aidantId,
        assignmentType,
        adminId,
        force: true,
      });

      if (!result.success) {
        return result;
      }

      return {
        success: true,
        visit: result.visit,
        assigned: true,
        assignment_type: assignmentType,
      };
    }

    // Sinon, marquer comme planifiée sans aidant
    const { data: updatedVisit, error: updateError } = await supabase
      .from('visites')
      .update({
        status: VISIT_STATUS.PLANNED,
        metadata: {
          ...(visit.metadata || {}),
          validated_without_aidant: true,
          validated_without_aidant_at: new Date().toISOString(),
          validated_by: adminId,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', visitId)
      .select()
      .single();

    if (updateError) {
      return {
        success: false,
        error: updateError.message,
        code: 'UPDATE_ERROR',
      };
    }

    return {
      success: true,
      visit: updatedVisit,
      assigned: false,
    };
  } catch (error) {
    console.error('❌ validateVisitWithoutAidant error:', error);
    return {
      success: false,
      error: error.message,
      code: 'UNKNOWN_ERROR',
    };
  }
};

module.exports.validateVisitWithoutAidant = validateVisitWithoutAidant;

/**
 * Vérifie si une visite peut être créée sans aidant
 * @param {string} targetType - 'patient' | 'personal_account'
 * @param {string} targetId - UUID de la cible
 * @param {string} familyId - UUID de la famille
 * @param {string} userRole - Rôle de l'utilisateur
 * @returns {Promise<Object>}
 */
const canCreateVisitWithoutAidant = async (targetType, targetId, familyId, userRole = 'family') => {
  try {
    const wizardOptions = await getVisitWizardOptions(targetType, targetId, familyId, userRole);

    // ✅ Si un aidant est déjà assigné → on peut créer sans problème
    if (wizardOptions.hasAidant) {
      return {
        canCreate: true,
        reason: 'aidant_assigned',
        wizard: wizardOptions,
      };
    }

    // ✅ Si des aidants sont disponibles → on peut créer (l'utilisateur choisira)
    if (wizardOptions.hasAvailableAidants) {
      return {
        canCreate: true,
        reason: 'aidants_available',
        wizard: wizardOptions,
      };
    }

    // ✅ Si tous les aidants sont full → on peut créer sans aidant (famille) ou forcer (admin)
    if (wizardOptions.allFull) {
      const isAdmin = userRole === 'admin' || userRole === 'coordinator';
      return {
        canCreate: true,
        reason: isAdmin ? 'admin_force' : 'without_aidant',
        wizard: wizardOptions,
      };
    }

    return {
      canCreate: false,
      reason: 'unknown',
      wizard: wizardOptions,
    };
  } catch (error) {
    console.error('❌ canCreateVisitWithoutAidant error:', error);
    return {
      canCreate: false,
      reason: 'error',
      error: error.message,
    };
  }
};

module.exports.canCreateVisitWithoutAidant = canCreateVisitWithoutAidant;

// ============================================================
// EXPORTS PRINCIPAUX
// ============================================================

module.exports = {
  // Constantes
  VISIT_STATUS,
  VISIT_PAYMENT_STATUS,
  VISIT_PONCTUAL_PRICES,
  DEFAULT_VISIT_PRICE,
  DRAFT_EXPIRY_HOURS,
  
  // Fonctions de prix
  getVisitPrice,
  getPonctualOrderPrice,
  
  // Vérification d'abonnement
  checkSubscriptionForVisits,
  checkSubscriptionForOrders,
  
  // Décompte
  decrementVisit,
  decrementOrder,
  
  // Nettoyage
  cleanExpiredDrafts,

  // 🆕 Nouvelles fonctions
  checkAidantForVisit,
  getVisitWizardOptions,
  validateVisitWithoutAidant,
  canCreateVisitWithoutAidant,
};
