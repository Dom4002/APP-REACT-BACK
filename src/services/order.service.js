// 📁 backend/src/services/order.service.js

const { supabase } = require('./supabase.service');
const { createNotification } = require('./notification.service');
const { getActiveAidantForTarget } = require('./aidantAssignment.service');

// ============================================================
// CONSTANTES
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

const ORDER_TYPES = {
  SUBSCRIPTION: 'subscription',
  PONCTUAL: 'ponctual',
};

const MAX_ORDERS_IN_PROGRESS = 2;
const AUTO_VALIDATION_HOURS = 12;

// ============================================================
// QUOTA DES COMMANDES EN COURS
// ============================================================

/**
 * Vérifie le quota de commandes en cours d'un aidant
 * @param {string} aidantUserId - UUID de l'aidant (user_id)
 * @returns {Promise<Object>} - { canTake, current, max, available }
 */
const checkAidantOrderQuota = async (aidantUserId) => {
  try {
    const { data: aidant, error } = await supabase
      .from('aidants')
      .select('id, current_orders, max_orders')
      .eq('user_id', aidantUserId)
      .single();

    if (error || !aidant) {
      return {
        success: false,
        error: 'Aidant non trouvé',
        current: 0,
        max: MAX_ORDERS_IN_PROGRESS,
        available: 0,
        canTake: false,
      };
    }

    const current = aidant.current_orders || 0;
    const max = aidant.max_orders || MAX_ORDERS_IN_PROGRESS;
    const available = max - current;

    return {
      success: true,
      current,
      max,
      available,
      canTake: current < max,
    };
  } catch (error) {
    console.error('❌ checkAidantOrderQuota error:', error);
    return {
      success: false,
      error: error.message,
      current: 0,
      max: MAX_ORDERS_IN_PROGRESS,
      available: 0,
      canTake: false,
    };
  }
};

/**
 * Incrémente le nombre de commandes en cours d'un aidant
 * @param {string} aidantUserId - UUID de l'aidant (user_id)
 * @returns {Promise<boolean>}
 */
const incrementAidantOrders = async (aidantUserId) => {
  try {
    const { data: aidant, error: fetchError } = await supabase
      .from('aidants')
      .select('id, current_orders, max_orders')
      .eq('user_id', aidantUserId)
      .single();

    if (fetchError || !aidant) {
      console.error('❌ incrementAidantOrders: aidant non trouvé');
      return false;
    }

    const newCount = (aidant.current_orders || 0) + 1;

    const { error: updateError } = await supabase
      .from('aidants')
      .update({
        current_orders: newCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', aidant.id);

    if (updateError) {
      console.error('❌ incrementAidantOrders error:', updateError);
      return false;
    }

    return true;
  } catch (error) {
    console.error('❌ incrementAidantOrders error:', error);
    return false;
  }
};

/**
 * Décrémente le nombre de commandes en cours d'un aidant
 * @param {string} aidantUserId - UUID de l'aidant (user_id)
 * @returns {Promise<boolean>}
 */
const decrementAidantOrders = async (aidantUserId) => {
  try {
    const { data: aidant, error: fetchError } = await supabase
      .from('aidants')
      .select('id, current_orders, max_orders')
      .eq('user_id', aidantUserId)
      .single();

    if (fetchError || !aidant) {
      console.error('❌ decrementAidantOrders: aidant non trouvé');
      return false;
    }

    const newCount = Math.max(0, (aidant.current_orders || 0) - 1);

    const { error: updateError } = await supabase
      .from('aidants')
      .update({
        current_orders: newCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', aidant.id);

    if (updateError) {
      console.error('❌ decrementAidantOrders error:', updateError);
      return false;
    }

    return true;
  } catch (error) {
    console.error('❌ decrementAidantOrders error:', error);
    return false;
  }
};

// ============================================================
// CRÉATION DE COMMANDE
// ============================================================

/**
 * Crée une commande avec gestion de l'abonnement et de l'aidant
 * @param {Object} params
 * @param {string} params.userId - UUID de l'utilisateur
 * @param {string} params.patientId - UUID du patient (optionnel)
 * @param {string} params.targetType - 'patient' | 'personal'
 * @param {string} params.targetName - Nom de la cible
 * @param {string} params.type - Type de commande
 * @param {string} params.description - Description
 * @param {string} params.address - Adresse
 * @param {number} params.latitude - Latitude (optionnel)
 * @param {number} params.longitude - Longitude (optionnel)
 * @param {number} params.estimatedAmount - Montant estimé
 * @param {Array} params.items - Articles
 * @param {string} params.prescriptionUrl - URL de prescription
 * @param {boolean} params.isPonctual - Mode ponctuel
 * @param {string} params.wizardChoice - 'ponctuelle' | 'permanente' | 'without_aidant'
 * @param {string} params.selectedAidantId - ID de l'aidant sélectionné
 * @param {Object} params.profile - Profil de l'utilisateur
 * @returns {Promise<Object>} - Résultat de la création
 */
const createOrder = async ({
  userId,
  patientId,
  targetType,
  targetName,
  type,
  description,
  address,
  latitude = null,   // ✅ AJOUT : Extraction de la latitude
  longitude = null,  // ✅ AJOUT : Extraction de la longitude
  estimatedAmount,
  items,
  prescriptionUrl,
  isPonctual = false,
  wizardChoice = null,
  selectedAidantId = null,
  profile,
}) => {
  try {
    const finalTargetType = targetType || (patientId ? 'patient' : 'personal');
    const finalTargetName = targetName || (patientId ? null : profile?.full_name);
    const familyId = userId;

    const { hasActiveSubscription, remainingOrders, subscription } = 
      await checkSubscriptionForOrders(userId);

    let status = ORDER_STATUS.CREATED;
    let requiresPayment = false;
    let paymentAmount = 0;
    let subscriptionId = null;

    if (isPonctual) {
      requiresPayment = true;
      status = ORDER_STATUS.WAITING_PAYMENT;
      paymentAmount = getPonctualOrderPrice(type, items);
    } else if (hasActiveSubscription && remainingOrders > 0) {
      status = ORDER_STATUS.CREATED;
      requiresPayment = false;
      subscriptionId = subscription?.id || null;
    } else if (hasActiveSubscription && remainingOrders === 0) {
      requiresPayment = true;
      status = ORDER_STATUS.WAITING_PAYMENT;
      paymentAmount = getPonctualOrderPrice(type, items);
    } else {
      requiresPayment = true;
      status = ORDER_STATUS.WAITING_PAYMENT;
      paymentAmount = getPonctualOrderPrice(type, items);
    }

    let finalAidantId = null;

    if (status !== ORDER_STATUS.WAITING_PAYMENT) {
      const targetTypeForAidant = patientId ? 'patient' : 'personal_account';
      const targetIdForAidant = patientId || userId;

      let foundId = await getActiveAidantForTarget(
        targetTypeForAidant,
        targetIdForAidant,
        familyId
      );

      if (foundId) {
        const convertedId = await getAidantIdFromUserIdOrId(foundId);
        if (convertedId) {
          finalAidantId = convertedId;
        }
      } else if (selectedAidantId && wizardChoice) {
        const convertedId = await getAidantIdFromUserIdOrId(selectedAidantId);
        if (convertedId) {
          if (wizardChoice === 'permanente') {
            const { data: aidant, error } = await supabase
              .from('aidants')
              .select('current_assignments, max_assignments')
              .eq('user_id', selectedAidantId)
              .single();

            if (!error && aidant) {
              const current = aidant.current_assignments || 0;
              const max = aidant.max_assignments || 4;
              if (current >= max) {
                return {
                  success: false,
                  error: `Cet aidant a déjà ${current}/${max} assignations`,
                  code: 'AIDANT_FULL',
                };
              }
            }
            finalAidantId = convertedId;
          } else if (wizardChoice === 'ponctuelle') {
            finalAidantId = convertedId;
          }
        }
      }
    }

    const orderData = {
      user_id: userId,
      patient_id: patientId || null,
      target_type: finalTargetType,
      target_name: finalTargetName,
      family_id: familyId,
      type: type,
      description: description,
      address: address,
      latitude: latitude,     // ✅ AJOUT : Insertion du paramètre dans le schéma de Supabase
      longitude: longitude,   // ✅ AJOUT : Insertion du paramètre dans le schéma de Supabase
      estimated_amount: estimatedAmount || 0,
      items: items || [],
      prescription_url: prescriptionUrl || null,
      status: status,
      order_type: requiresPayment ? ORDER_TYPES.PONCTUAL : ORDER_TYPES.SUBSCRIPTION,
      is_paid: !requiresPayment,
      aidant_id: finalAidantId,
      subscription_id: subscriptionId,
      metadata: {
        requires_payment: requiresPayment,
        created_by: userId,
        created_at: new Date().toISOString(),
        auto_assigned_aidant: !!finalAidantId && !selectedAidantId,
        payment_amount: requiresPayment ? paymentAmount : null,
        subscription_used: subscriptionId ? true : false,
        ponctual_mode: requiresPayment ? true : false,
        wizard_choice: wizardChoice || null,
        selected_aidant: selectedAidantId || null,
      },
    };

    const { data: order, error } = await supabase
      .from('commandes')
      .insert(orderData)
      .select('*')
      .single();

    if (error) {
      console.error('❌ createOrder error:', error);
      return {
        success: false,
        error: error.message,
        code: 'INSERT_ERROR',
      };
    }

    const targetDisplay = finalTargetName || 'un client';

    if (requiresPayment) {
      await createNotification({
        userId: userId,
        title: '💳 Paiement requis pour la commande',
        body: `Un paiement de ${paymentAmount} FCFA est requis pour valider votre commande "${description}" pour ${targetDisplay}.`,
        type: 'commande',
        data: {
          order_id: order.id,
          status: ORDER_STATUS.WAITING_PAYMENT,
          action: 'pay',
          amount: paymentAmount,
        },
      });
    } else {
      if (finalAidantId) {
        await createNotification({
          userId: finalAidantId,
          title: '🛒 Nouvelle commande assignée automatiquement',
          body: `Commande de ${targetDisplay} - ${description}`,
          type: 'commande',
          data: { order_id: order.id, action: 'take', auto_assigned: true },
        });
      } else {
        await notifyAvailableAidantsForOrder(order.id, {
          targetDisplay,
          description,
        });
      }
    }

    const fullOrder = await enrichOrderWithRelations(order);

    return {
      success: true,
      order: fullOrder,
      requires_payment: requiresPayment,
      payment_amount: requiresPayment ? paymentAmount : null,
      subscription_used: !!subscriptionId,
      auto_assigned_aidant: !!finalAidantId && !selectedAidantId,
    };
  } catch (error) {
    console.error('❌ createOrder error:', error);
    return {
      success: false,
      error: error.message,
      code: 'UNKNOWN_ERROR',
    };
  }
};

// ============================================================
// PRISE DE COMMANDE
// ============================================================

/**
 * Prend une commande (aidant)
 * @param {string} orderId - UUID de la commande
 * @param {string} aidantUserId - UUID de l'aidant
 * @returns {Promise<Object>}
 */
const takeOrder = async (orderId, aidantUserId) => {
  try {
    const { data: order, error: fetchError } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', orderId)
      .single();

    if (fetchError || !order) {
      return {
        success: false,
        error: 'Commande non trouvée',
        code: 'ORDER_NOT_FOUND',
      };
    }

    const availableStatuses = ['creee', 'en_attente', 'disponible'];
    if (!availableStatuses.includes(order.status)) {
      return {
        success: false,
        error: `Cette commande n'est pas disponible. Statut: ${order.status}`,
        code: 'ORDER_NOT_AVAILABLE',
      };
    }

    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, available, is_verified, current_assignments, max_assignments')
      .eq('user_id', aidantUserId)
      .single();

    if (aidantError || !aidant) {
      return {
        success: false,
        error: 'Aidant non trouvé',
        code: 'AIDANT_NOT_FOUND',
      };
    }

    if (!aidant.available || !aidant.is_verified) {
      return {
        success: false,
        error: 'Aidant non disponible ou non vérifié',
        code: 'AIDANT_NOT_AVAILABLE',
      };
    }

    const quotaCheck = await checkAidantOrderQuota(aidantUserId);
    if (!quotaCheck.canTake) {
      return {
        success: false,
        error: `Vous avez déjà ${quotaCheck.current} commande(s) en cours (maximum ${quotaCheck.max})`,
        code: 'QUOTA_EXCEEDED',
        current: quotaCheck.current,
        max: quotaCheck.max,
      };
    }

    if (order.aidant_id && order.aidant_id !== aidant.id) {
      return {
        success: false,
        error: 'Cette commande est déjà assignée à un autre aidant',
        code: 'ALREADY_ASSIGNED',
      };
    }

    const incremented = await incrementAidantOrders(aidantUserId);
    if (!incremented) {
      return {
        success: false,
        error: 'Erreur lors de l\'incrémentation du quota',
        code: 'QUOTA_INCREMENT_ERROR',
      };
    }

    const { data: updatedOrder, error: updateError } = await supabase
      .from('commandes')
      .update({
        status: ORDER_STATUS.IN_PROGRESS,
        aidant_id: aidant.id,
        current_aidant_id: aidant.id,
        taken_at: new Date().toISOString(),
        taken_by: aidantUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId)
      .select('*')
      .single();

    if (updateError) {
      await decrementAidantOrders(aidantUserId);
      return {
        success: false,
        error: updateError.message,
        code: 'UPDATE_ERROR',
      };
    }

    const targetDisplay = order.target_name || 'un client';
    if (order.family_id) {
      await createNotification({
        userId: order.family_id,
        title: '✅ Commande prise en charge',
        body: `Un aidant a pris votre commande "${order.description}" pour ${targetDisplay}.`,
        type: 'commande',
        data: { order_id: orderId, status: ORDER_STATUS.IN_PROGRESS },
      });
    }

    const fullOrder = await enrichOrderWithRelations(updatedOrder);

    return {
      success: true,
      order: fullOrder,
      quota: {
        current: quotaCheck.current + 1,
        max: quotaCheck.max,
        available: quotaCheck.available - 1,
      },
    };
  } catch (error) {
    console.error('❌ takeOrder error:', error);
    return {
      success: false,
      error: error.message,
      code: 'UNKNOWN_ERROR',
    };
  }
};

// ============================================================
// LIVRAISON DE COMMANDE
// ============================================================

/**
 * Livre une commande (aidant)
 * @param {string} orderId - UUID de la commande
 * @param {string} aidantUserId - UUID de l'aidant
 * @param {string} proofUrl - URL de la preuve de livraison
 * @param {Object} location - Coordonnées GPS
 * @returns {Promise<Object>}
 */
const deliverOrder = async (orderId, aidantUserId, proofUrl = null, location = null) => {
  try {
    const { data: order, error: fetchError } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', orderId)
      .single();

    if (fetchError || !order) {
      return {
        success: false,
        error: 'Commande non trouvée',
        code: 'ORDER_NOT_FOUND',
      };
    }

    if (order.aidant_id) {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('user_id')
        .eq('id', order.aidant_id)
        .single();

      if (aidant && aidant.user_id !== aidantUserId) {
        return {
          success: false,
          error: 'Vous n\'êtes pas l\'aidant assigné à cette commande',
          code: 'NOT_ASSIGNED',
        };
      }
    }

    if (order.status !== ORDER_STATUS.IN_PROGRESS) {
      return {
        success: false,
        error: `Seules les commandes en cours peuvent être livrées. Statut: ${order.status}`,
        code: 'INVALID_STATUS',
      };
    }

    await decrementAidantOrders(aidantUserId);

    const autoValidationAt = new Date(Date.now() + AUTO_VALIDATION_HOURS * 60 * 60 * 1000);

    const { data: updatedOrder, error: updateError } = await supabase
      .from('commandes')
      .update({
        status: ORDER_STATUS.DELIVERED,
        proof_url: proofUrl || null,
        updated_at: new Date().toISOString(),
        auto_validation_at: autoValidationAt.toISOString(),
        metadata: {
          ...(order.metadata || {}),
          delivered_at: new Date().toISOString(),
          delivery_location: location || null,
        },
      })
      .eq('id', orderId)
      .select('*')
      .single();

    if (updateError) {
      await incrementAidantOrders(aidantUserId);
      return {
        success: false,
        error: updateError.message,
        code: 'UPDATE_ERROR',
      };
    }

    const targetDisplay = order.target_name || 'un client';
    if (order.family_id) {
      await createNotification({
        userId: order.family_id,
        title: '📦 Commande livrée',
        body: `Votre commande pour ${targetDisplay} a été livrée avec succès !`,
        type: 'commande',
        data: { order_id: orderId, status: ORDER_STATUS.DELIVERED },
      });
    }

    const fullOrder = await enrichOrderWithRelations(updatedOrder);

    return {
      success: true,
      order: fullOrder,
      auto_validation_at: autoValidationAt,
    };
  } catch (error) {
    console.error('❌ deliverOrder error:', error);
    return {
      success: false,
      error: error.message,
      code: 'UNKNOWN_ERROR',
    };
  }
};

// ============================================================
// AUTO-VALIDATION
// ============================================================

/**
 * Auto-valide une commande après 12h
 * @param {string} orderId - UUID de la commande
 * @returns {Promise<Object>}
 */
const autoValidateOrder = async (orderId) => {
  try {
    const { data: order, error: fetchError } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', orderId)
      .single();

    if (fetchError || !order) {
      return {
        success: false,
        error: 'Commande non trouvée',
        code: 'ORDER_NOT_FOUND',
      };
    }

    if (order.status !== ORDER_STATUS.DELIVERED) {
      return {
        success: false,
        error: `Seules les commandes livrées peuvent être auto-validées. Statut: ${order.status}`,
        code: 'INVALID_STATUS',
      };
    }

    const deliveredAt = new Date(order.metadata?.delivered_at || order.updated_at);
    const now = new Date();
    const diffHours = (now.getTime() - deliveredAt.getTime()) / (1000 * 60 * 60);

    if (diffHours < AUTO_VALIDATION_HOURS) {
      return {
        success: false,
        error: `Auto-validation possible après ${AUTO_VALIDATION_HOURS}h (${Math.round(AUTO_VALIDATION_HOURS - diffHours)}h restantes)`,
        code: 'TOO_EARLY',
        remainingHours: Math.round(AUTO_VALIDATION_HOURS - diffHours),
      };
    }

    const { data: updatedOrder, error: updateError } = await supabase
      .from('commandes')
      .update({
        status: ORDER_STATUS.VALIDATED,
        is_auto_validated: true,
        updated_at: new Date().toISOString(),
        metadata: {
          ...(order.metadata || {}),
          auto_validated_at: new Date().toISOString(),
        },
      })
      .eq('id', orderId)
      .select('*')
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
      order: updatedOrder,
    };
  } catch (error) {
    console.error('❌ autoValidateOrder error:', error);
    return {
      success: false,
      error: error.message,
      code: 'UNKNOWN_ERROR',
    };
  }
};

// ============================================================
// NOTIFICATIONS
// ============================================================

const notifyAvailableAidantsForOrder = async (orderId, { targetDisplay, description }) => {
  try {
    const { data: aidants } = await supabase
      .from('aidants')
      .select('user_id')
      .eq('available', true)
      .eq('is_verified', true);

    if (!aidants || aidants.length === 0) return;

    const availableAidants = [];
    for (const aidant of aidants) {
      const quotaCheck = await checkAidantOrderQuota(aidant.user_id);
      if (quotaCheck.canTake) {
        availableAidants.push(aidant);
      }
    }

    for (const aidant of availableAidants) {
      await createNotification({
        userId: aidant.user_id,
        title: '🛒 Nouvelle commande disponible',
        body: `Commande de ${targetDisplay} - ${description}`,
        type: 'commande',
        data: { order_id: orderId, action: 'take' },
      });
    }
  } catch (error) {
    console.error('❌ notifyAvailableAidantsForOrder error:', error);
  }
};

// ============================================================
// FONCTIONS UTILITAIRES
// ============================================================

const enrichOrderWithRelations = async (order) => {
  let patient = null;
  if (order.patient_id) {
    const { data } = await supabase
      .from('patients')
      .select('*')
      .eq('id', order.patient_id)
      .single();
    patient = data;
  }

  let family = null;
  if (order.family_id) {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', order.family_id)
      .single();
    family = data;
  }

  let aidant = null;
  if (order.aidant_id) {
    const { data } = await supabase
      .from('aidants')
      .select(`
        *,
        user:profiles!aidants_user_id_fkey(
          id,
          full_name,
          email,
          phone,
          avatar_url
        )
      `)
      .eq('id', order.aidant_id)
      .single();
    aidant = data;
  }

  return {
    ...order,
    patient,
    family,
    aidant,
  };
};

const getPonctualOrderPrice = (type, items) => {
  const ORDER_PONCTUAL_PRICES = {
    medicaments: 5000,
    produits_bebe: 5000,
    produits_hygiene: 4000,
    courses: 3000,
    repas: 4000,
    autre: 2500,
  };

  if (items && items.length > 0) {
    const total = items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
    if (total > 0) return total;
  }
  return ORDER_PONCTUAL_PRICES[type] || 2500;
};

const getAidantIdFromUserIdOrId = async (userIdOrId) => {
  const { data: aidantById, error: errorById } = await supabase
    .from('aidants')
    .select('id')
    .eq('id', userIdOrId)
    .maybeSingle();

  if (!errorById && aidantById) return aidantById.id;

  const { data: aidantByUser, error: errorByUser } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userIdOrId)
    .maybeSingle();

  if (!errorByUser && aidantByUser) return aidantByUser.id;

  return null;
};

const checkSubscriptionForOrders = async (userId) => {
  try {
    const { data: subscription, error } = await supabase
      .from('abonnements')
      .select('id, remaining_orders, status, total_orders, used_orders, user_id')
      .eq('user_id', userId)
      .eq('status', 'actif')
      .gte('end_date', new Date().toISOString().split('T')[0])
      .maybeSingle();

    if (error || !subscription) {
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

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  ORDER_STATUS,
  ORDER_TYPES,
  MAX_ORDERS_IN_PROGRESS,
  AUTO_VALIDATION_HOURS,
  checkAidantOrderQuota,
  incrementAidantOrders,
  decrementAidantOrders,
  createOrder,
  takeOrder,
  deliverOrder,
  autoValidateOrder,
  notifyAvailableAidantsForOrder,
  enrichOrderWithRelations,
  getPonctualOrderPrice,
  getAidantIdFromUserIdOrId,
  checkSubscriptionForOrders,
};
