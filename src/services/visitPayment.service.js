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
};
