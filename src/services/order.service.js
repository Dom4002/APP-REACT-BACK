// 📁 backend/src/services/order.service.js
 
const { supabase } = require('./supabase.service');
const { createNotification } = require('./notification.service');

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
// 📊 DOUBLE CONTRÔLE ET SYNCHRONISATION DYNAMIQUE DU QUOTA
// ============================================================

/**
 * Recalcule et synchronise en direct le nombre réel de livraisons actives d'un aidant
 * Évite les désynchronisations ou blocages à vie du quota d'intervenant
 * @param {string} aidantUserId - UUID de l'aidant
 */
const syncAidantOrderCount = async (aidantUserId) => {
  try {
    const { data: aidant } = await supabase
      .from('aidants')
      .select('id')
      .eq('user_id', aidantUserId)
      .single();

    if (!aidant) return;

    // Recenser uniquement les commandes réelles au statut 'en_cours'
    const { count, error } = await supabase
      .from('commandes')
      .select('id', { count: 'exact', head: true })
      .eq('aidant_id', aidant.id)
      .eq('status', ORDER_STATUS.IN_PROGRESS);

    if (!error) {
      await supabase
        .from('aidants')
        .update({ current_orders: count || 0 })
        .eq('id', aidant.id);
      console.log(`📊 [Quota] Recalcul synchrone pour ${aidantUserId} : ${count || 0} commande(s) active(s)`);
    }
  } catch (err) {
    console.error('❌ Erreur recalcul quota syncAidantOrderCount:', err);
  }
};

/**
 * Vérifie le quota de commandes en cours d'un aidant
 * @param {string} aidantUserId - UUID de l'aidant (user_id)
 * @returns {Promise<Object>} - { canTake, current, max, available }
 */
const checkAidantOrderQuota = async (aidantUserId) => {
  try {
    // 1️⃣ Forcer la synchronisation dynamique en direct
    await syncAidantOrderCount(aidantUserId);

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

// ============================================================
// CRÉATION DE COMMANDE
// ============================================================

const createOrder = async ({
  userId,
  patientId,
  targetType,
  targetName,
  type,
  description,
  address,
  latitude = null,
  longitude = null,
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
      status = ORDER_STATUS.PENDING; // 'en_attente' de paiement
      paymentAmount = getPonctualOrderPrice(type, items);
    } else if (hasActiveSubscription && remainingOrders > 0) {
      status = ORDER_STATUS.CREATED;
      requiresPayment = false;
      subscriptionId = subscription?.id || null;
    } else {
      requiresPayment = true;
      status = ORDER_STATUS.PENDING;
      paymentAmount = getPonctualOrderPrice(type, items);
    }

    // ✅ RECTIFICATION DE SÉCURITÉ UX : Les commandes partent vierges (aidant_id = null)
    // Aucun aidant lié (comme getActiveAidantForTarget) n'est pré-assigné d'office à la création.
    let finalAidantId = null;

    if (selectedAidantId) {
      const convertedId = await getAidantIdFromUserIdOrId(selectedAidantId);
      if (convertedId) {
        finalAidantId = convertedId;
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
      latitude: latitude,
      longitude: longitude,
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
        auto_assigned_aidant: false, // Plus d'assignation automatique d'office
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

    const targetDisplay = finalTargetName || 'un proche';

    if (requiresPayment) {
      await createNotification({
        userId: userId,
        title: '💳 Paiement requis pour la commande',
        body: `Un paiement de ${paymentAmount} FCFA est requis pour valider votre commande "${description}".`,
        type: 'commande',
        data: {
          order_id: order.id,
          status: ORDER_STATUS.PENDING,
          action: 'pay',
          amount: paymentAmount,
        },
      });
    } else {
      // ✅ Diffuser à tous les aidants disponibles du pool
      await notifyAvailableAidantsForOrder(order.id, {
        targetDisplay,
        description,
      });
    }

    const fullOrder = await enrichOrderWithRelations(order);

    return {
      success: true,
      order: fullOrder,
      requires_payment: requiresPayment,
      payment_amount: requiresPayment ? paymentAmount : null,
      subscription_used: !!subscriptionId,
      auto_assigned_aidant: false,
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
        error: `Cette commande n'est plus disponible. Statut: ${order.status}`,
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
        error: 'Votre compte n\'est pas disponible ou vérifié',
        code: 'AIDANT_NOT_AVAILABLE',
      };
    }

    // Contrôler le quota en direct
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

    // Mettre à jour l'aidant gérant de la commande
    const { data: updatedOrder, error: updateError } = await supabase
      .from('commandes')
      .update({
        status: ORDER_STATUS.IN_PROGRESS, // Passe au statut 'en_cours'
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
      return {
        success: false,
        error: updateError.message,
        code: 'UPDATE_ERROR',
      };
    }

    // Réajuster de manière dynamique le quota
    await syncAidantOrderCount(aidantUserId);

    const targetDisplay = order.target_name || 'un client';
    if (order.family_id) {
      await createNotification({
        userId: order.family_id,
        title: '✅ Commande prise en charge',
        body: `L'intervenant a pris en charge votre commande "${order.description}" pour ${targetDisplay}.`,
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

    if (order.status !== ORDER_STATUS.IN_PROGRESS) {
      return {
        success: false,
        error: `Seules les commandes en cours de traitement peuvent être livrées.`,
        code: 'INVALID_STATUS',
      };
    }

    const autoValidationAt = new Date(Date.now() + AUTO_VALIDATION_HOURS * 60 * 60 * 1000);

    const { data: updatedOrder, error: updateError } = await supabase
      .from('commandes')
      .update({
        status: ORDER_STATUS.DELIVERED, // Passe au statut 'livree'
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
      return {
        success: false,
        error: updateError.message,
        code: 'UPDATE_ERROR',
      };
    }

    // ✅ Libérer dynamiquement le quota de l'aidant
    await syncAidantOrderCount(aidantUserId);

    const targetDisplay = order.target_name || 'un client';
    if (order.family_id) {
      await createNotification({
        userId: order.family_id,
        title: '📦 Commande livrée',
        body: `Votre commande pour ${targetDisplay} a été livrée !`,
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
        error: `Action impossible. Statut: ${order.status}`,
        code: 'INVALID_STATUS',
      };
    }

    const { data: updatedOrder, error: updateError } = await supabase
      .from('commandes')
      .update({
        status: ORDER_STATUS.VALIDATED, // Passe au statut 'validee'
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

    // Réaligner le quota par sécurité de la commande validée
    if (order.aidant_id) {
      const { data: aidant } = await supabase.from('aidants').select('user_id').eq('id', order.aidant_id).single();
      if (aidant) {
        await syncAidantOrderCount(aidant.user_id);
      }
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
// NOTIFICATIONS ET RE-RENDUS
// ============================================================

const notifyAvailableAidantsForOrder = async (orderId, { targetDisplay, description }) => {
  try {
    const { data: aidants } = await supabase
      .from('aidants')
      .select('user_id')
      .eq('available', true)
      .eq('is_verified', true)
      .eq('status', 'approved');

    if (!aidants || aidants.length === 0) return;

    for (const aidant of aidants) {
      const quotaCheck = await checkAidantOrderQuota(aidant.user_id);
      if (quotaCheck.canTake) {
        await createNotification({
          userId: aidant.user_id,
          title: '🛒 Nouvelle commande disponible',
          body: `Commande de ${targetDisplay} - ${description}`,
          type: 'commande',
          data: { order_id: orderId, action: 'take' },
        });
      }
    }
  } catch (error) {
    console.error('❌ notifyAvailableAidantsForOrder error:', error);
  }
};

// ============================================================
// FONCTIONS DE LIENS ET D'ENVELOPPES
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
