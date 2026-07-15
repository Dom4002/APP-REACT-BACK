// 📁 backend/src/services/order.service.js
// ✅ SERVICE DE COMMANDES COMPLET : SYNCHRONISATION DYNAMIQUE DES QUOTAS ET CHECKPOINTS GPS FIXES EN METADATA

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

const AUTO_VALIDATION_HOURS = 12;

// ============================================================
// 📊 ALGORITHME DE SYNCHRONISATION DES QUOTAS DE COMMANDES ACTIVES
// ============================================================

/**
 * Recalcule et synchronise en direct le nombre réel de livraisons actives (en_cours) d'un aidant.
 * @param {string} aidantUserId - UUID de l'aidant (user_id)
 */
const syncAidantOrderCount = async (aidantUserId) => {
  try {
    const { data: aidant } = await supabase
      .from('aidants')
      .select('id')
      .eq('user_id', aidantUserId)
      .single();

    if (!aidant) return;

    // Compter les commandes actuellement en cours ('en_cours') de cet aidant en base de données
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
      console.log(`📊 [Quota Service] Recalcul synchrone pour l'aidant ${aidantUserId} : ${count || 0} commande(s) active(s)`);
    }
  } catch (err) {
    console.error('❌ Erreur sync quota syncAidantOrderCount:', err);
  }
};

/**
 * Vérifie l'activité de commandes en cours d'un aidant (Toujours autorisé : canTake = true)
 * @param {string} aidantUserId - UUID de l'aidant (user_id)
 * @returns {Promise<Object>} - { canTake: true, current, max: Infinity, available: Infinity }
 */
const checkAidantOrderQuota = async (aidantUserId) => {
  try {
    // Forcer le recalcul dynamique en direct
    await syncAidantOrderCount(aidantUserId);

    const { data: aidant, error } = await supabase
      .from('aidants')
      .select('id, current_orders')
      .eq('user_id', aidantUserId)
      .single();

    if (error || !aidant) {
      return {
        success: false,
        error: 'Aidant non trouvé',
        current: 0,
        max: 999,
        available: 999,
        canTake: true, // ✅ Toujours autorisé : plus de blocage de quota
      };
    }

    const current = aidant.current_orders || 0;

    return {
      success: true,
      current,
      max: 999,
      available: 999,
      canTake: true, // ✅ Toujours autorisé : plus de blocage de quota
    };
  } catch (error) {
    console.error('❌ checkAidantOrderQuota error:', error);
    return {
      success: false,
      error: error.message,
      current: 0,
      max: 999,
      available: 999,
      canTake: true,
    };
  }
};

/**
 * Incrémente le nombre de commandes (délégué au sync)
 */
const incrementAidantOrders = async (aidantUserId) => {
  await syncAidantOrderCount(aidantUserId);
  return true;
};

/**
 * Décrémente le nombre de commandes (délégué au sync)
 */
const decrementAidantOrders = async (aidantUserId) => {
  await syncAidantOrderCount(aidantUserId);
  return true;
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
      status = ORDER_STATUS.PENDING;
      paymentAmount = getPonctualOrderPrice(type, items);
    } else if (hasActiveSubscription && remainingOrders > 0) {
      status = ORDER_STATUS.CREATED;
      requiresPayment = false;
      subscriptionId = subscription?.id || null;
    } else if (hasActiveSubscription && remainingOrders === 0) {
      requiresPayment = true;
      status = ORDER_STATUS.PENDING;
      paymentAmount = getPonctualOrderPrice(type, items);
    } else {
      requiresPayment = true;
      status = ORDER_STATUS.PENDING;
      paymentAmount = getPonctualOrderPrice(type, items);
    }

    let finalAidantId = null;

    if (selectedAidantId) {
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
                error: `Cet aidant est complet (${current}/${max} assignations)`,
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
        auto_assigned_aidant: false,
        payment_amount: requiresPayment ? paymentAmount : null,
        subscription_used: subscriptionId ? true : false,
        ponctual_mode: requiresPayment ? true : false,
        wizard_choice: wizardChoice || null,
        selected_aidant: selectedAidantId || null,
      },
    };

    const { data: order, error: error } = await supabase
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
// PRISE DE COMMANDE AVEC ENREGISTREMENT GPS DU DÉPART
// ============================================================

const takeOrder = async (orderId, aidantUserId, lat = null, lng = null) => {
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
      .select('id, available, is_verified')
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

    if (order.aidant_id && order.aidant_id !== aidant.id) {
      return {
        success: false,
        error: 'Cette commande est déjà attribuée à un autre aidant',
        code: 'ALREADY_ASSIGNED',
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
        // ✅ ENREGISTREMENT GPS DU CHECKPOINT DE DÉPART DE LA LIVRAISON EN METADATA
        metadata: {
          ...(order.metadata || {}),
          location_start: lat && lng ? { lat, lng } : null,
          delivery_started_at: new Date().toISOString(),
        }
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

    await syncAidantOrderCount(aidantUserId);

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
        max: 999,
        available: 999,
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
// LIVRAISON DE COMMANDE AVEC ENREGISTREMENT GPS DE L'ARRIVÉE
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
        error: `Seules les commandes en cours de livraison peuvent être finalisées.`,
        code: 'INVALID_STATUS',
      };
    }

    const autoValidationAt = new Date(Date.now() + AUTO_VALIDATION_HOURS * 60 * 60 * 1000);

    const { data: updatedOrder, error: updateError } = await supabase
      .from('commandes')
      .update({
        status: ORDER_STATUS.DELIVERED,
        proof_url: proofUrl || null,
        updated_at: new Date().toISOString(),
        auto_validation_at: autoValidationAt.toISOString(),
        // ✅ ENREGISTREMENT GPS DU CHECKPOINT DE FIN DE LA LIVRAISON EN METADATA (LOCATION REÇU EN ARGUMENT)
        metadata: {
          ...(order.metadata || {}),
          location_end: location || null,
          delivery_completed_at: new Date().toISOString(),
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

    await syncAidantOrderCount(aidantUserId);

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
// AUTO-VALIDATION (LIBÉRATION DU QUOTA)
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
        error: `Seules les commandes livrées peuvent être validées automatiquement.`,
        code: 'INVALID_STATUS',
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
// NOTIFICATIONS ET RE-RENDUS GLOBAUX
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
// FONCTIONS UTILITAIRES ET DE LIENS RELATIONS
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
  AUTO_VALIDATION_HOURS,
  syncAidantOrderCount,  
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
