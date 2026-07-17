// 📁 backend/src/services/order.service.js
// ✅ SERVICE DE COMMANDES COMPLET : CORRECTION DES RÉFÉRENCES DE VARIABLES CAMELCASE DANS LES MÉTADONNÉES

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

const AUTO_VALIDATION_HOURS = 48; // Clôture automatique du cash après 48 heures d'inactivité

// ============================================================
// 📊 ALGORITHME DE CALCUL DES FRAIS DE RETRAIT MOBILE MONEY (BÉNIN)
// ============================================================

/**
 * Calcule les frais de retrait Mobile Money officiels au Bénin.
 * Supports: MTN, Moov et Celtiis Cash.
 * @param {number} amount - Montant d'achat prévisionnel
 * @param {string} operator - 'mtn_moov' ou 'celtiis'
 * @returns {number} Frais de retrait en FCFA
 */
const calculateWithdrawalFee = (amount, operator) => {
  if (amount <= 0) return 0;

  const amt = Math.round(amount);

  if (operator === 'celtiis') {
    if (amt <= 500) return 50;
    if (amt <= 5000) return 120;
    if (amt <= 10000) return 200;
    if (amt <= 20000) return 300;
    if (amt <= 50000) return 600;
    if (amt <= 75000) return 900;
    if (amt <= 100000) return 1000;
    if (amt <= 200000) return 2000;
    if (amt <= 300000) return 3000;
    if (amt <= 500000) return 3500;
    if (amt <= 750000) return 5000;
    if (amt <= 1000000) return 5800;
    if (amt <= 1500000) return 7800;
    return 9800; // Limite maximale (jusqu'à 2 000 000 F)
  } else {
    // MTN & Moov
    if (amt <= 500) return 50;
    if (amt <= 5000) return 125;
    if (amt <= 10000) return 225;
    if (amt <= 20000) return 375;
    if (amt <= 50000) return 700;
    if (amt <= 100000) return 1000;
    if (amt <= 200000) return 2000;
    if (amt <= 300000) return 3000;
    if (amt <= 500000) return 3500;
    if (amt <= 750000) return 5000;
    if (amt <= 1000000) return 6000;
    if (amt <= 1500000) return 8000;
    return 9900; // Limite maximale (jusqu'à 2 000 000 F)
  }
};

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
        canTake: true, 
      };
    }

    const current = aidant.current_orders || 0;

    return {
      success: true,
      current,
      max: 999,
      available: 999,
      canTake: true,
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
  purchaseAmount = 0,        
  withdrawalOperator = null,  
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

    // Calcul automatique des frais de retrait Mobile Money s'il y a achat
    const withdrawalFee = purchaseAmount > 0 && withdrawalOperator 
      ? calculateWithdrawalFee(purchaseAmount, withdrawalOperator)
      : 0;

    const requiresAdvancePayment = purchaseAmount > 0;

    let status = ORDER_STATUS.CREATED;
    let requiresPayment = false;  
    let paymentAmount = 0;
    let subscriptionId = null;

    if (requiresAdvancePayment) {
      requiresPayment = true;
      status = ORDER_STATUS.WAITING_PAYMENT; // Bloqué en attente du paiement de l'avance (achats + retrait)
      paymentAmount = purchaseAmount + withdrawalFee;
    } else if (isPonctual) {
      requiresPayment = false; // Pas d'avance requise s'il n'y a pas d'achat physique
      status = ORDER_STATUS.CREATED;
    } else if (hasActiveSubscription && remainingOrders > 0) {
      status = ORDER_STATUS.CREATED;
      requiresPayment = false;
      subscriptionId = subscription?.id || null;
    } else if (hasActiveSubscription && remainingOrders === 0) {
      requiresPayment = false;
      status = ORDER_STATUS.CREATED;
    } else {
      requiresPayment = false;
      status = ORDER_STATUS.CREATED;
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
      estimated_amount: requiresAdvancePayment ? paymentAmount : 0,
      items: [],
      prescription_url: prescriptionUrl || null,
      status: status,
      order_type: requiresAdvancePayment || isPonctual ? ORDER_TYPES.PONCTUAL : ORDER_TYPES.SUBSCRIPTION,
      is_paid: !requiresAdvancePayment,
      aidant_id: finalAidantId,
      subscription_id: subscriptionId,
      
      // Stockage de la provision MM
      purchase_amount: purchaseAmount,
      withdrawal_operator: withdrawalOperator,
      withdrawal_fee: withdrawalFee,

      metadata: {
        requires_payment: requiresAdvancePayment,
        purchase_amount: purchaseAmount,  
        withdrawal_operator: withdrawalOperator,  
        withdrawal_fee: withdrawalFee,
        created_by: userId,
        created_at: new Date().toISOString(),
        auto_assigned_aidant: false,
        payment_amount: requiresAdvancePayment ? paymentAmount : null,
        subscription_used: subscriptionId ? true : false,
        ponctual_mode: requiresAdvancePayment || isPonctual,
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

    if (requiresAdvancePayment) {
      await createNotification({
        userId: userId,
        title: '💳 Provision d\'achats requise',
        body: `Un paiement d'avance de ${paymentAmount} FCFA est requis pour valider votre commande "${description}".`,
        type: 'commande',
        data: {
          order_id: order.id,
          status: ORDER_STATUS.WAITING_PAYMENT,
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
      requires_payment: requiresAdvancePayment,
      payment_amount: requiresAdvancePayment ? paymentAmount : null,
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
// LIVRAISON DE COMMANDE (DOUBLE MODALITÉ ESPÈCES VS EN LIGNE)
// ============================================================

const deliverOrder = async (
  orderId, 
  aidantUserId, 
  proofUrl = null, 
  location = null,
  deliveryFee = 0,            
  paymentMethod = 'online',    
  cashAmountReceived = 0        
) => {
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

    const isSubscriptionUsed = !!order.subscription_id;

    // Si abonnement utilisé : livraison gratuite et validation immédiate sans attente
    const isCompletedImmediately = isSubscriptionUsed;
    const status = isCompletedImmediately ? ORDER_STATUS.VALIDATED : ORDER_STATUS.DELIVERED;

    const autoValidationAt = new Date(Date.now() + AUTO_VALIDATION_HOURS * 60 * 60 * 1000);

    const { data: updatedOrder, error: updateError } = await supabase
      .from('commandes')
      .update({
        status: status,
        proof_url: proofUrl || null,
        delivery_fee: isSubscriptionUsed ? 0 : Number(deliveryFee),
        delivery_time: new Date().toISOString(),
        cash_amount_received: paymentMethod === 'cash' ? Number(cashAmountReceived) : 0,
        delivery_payment_method: isSubscriptionUsed ? 'subscription' : paymentMethod,
        cash_confirmation_status: paymentMethod === 'cash' ? 'pending' : null,
        cash_confirmation_expires_at: paymentMethod === 'cash' ? autoValidationAt.toISOString() : null,
        is_paid: isCompletedImmediately, // Payé d'avance uniquement si abonnement
        updated_at: new Date().toISOString(),
        metadata: {
          ...(order.metadata || {}),
          location_end: location || null,
          delivery_completed_at: new Date().toISOString(),
          delivery_payment_method: paymentMethod,
          delivery_fee_paid: isCompletedImmediately,
          cash_confirmation_status: paymentMethod === 'cash' ? 'pending' : null,
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
      if (isCompletedImmediately) {
        await createNotification({
          userId: order.family_id,
          title: '📦 Commande livrée et validée !',
          body: `Votre commande pour ${targetDisplay} a été livrée avec succès (frais couverts par votre abonnement).`,
          type: 'commande',
          data: { order_id: orderId, status: ORDER_STATUS.VALIDATED },
        });
      } else if (paymentMethod === 'cash') {
        await createNotification({
          userId: order.family_id,
          title: '💵 Confirmation de paiement espèces requise',
          body: `Le livreur déclare avoir reçu ${cashAmountReceived} FCFA en mains propres. Confirmez-vous ce paiement ?`,
          type: 'commande',
          data: { order_id: orderId, action: 'confirm_cash', amount: cashAmountReceived },
        });
      } else {
        // Règlement en ligne en attente
        await createNotification({
          userId: order.family_id,
          title: '📦 Commande livrée — Frais de livraison en attente',
          body: `Votre commande pour ${targetDisplay} a été déposée. Veuillez régler les frais de transport de ${deliveryFee} FCFA en ligne.`,
          type: 'commande',
          data: { order_id: orderId, action: 'pay_delivery_fee', amount: deliveryFee },
        });
      }
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
// ✅ SÉCURITÉ CASH : CLIENT VALIDE OU LITIGE LA REMISE EN MAINS PROPRES
// ============================================================

const confirmCashPayment = async (orderId, userId, isConfirmed) => {
  try {
    const { data: order, error } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', orderId)
      .single();

    if (error || !order) return { success: false, error: 'Commande non trouvée' };
    if (order.family_id !== userId) return { success: false, error: 'Action non autorisée' };

    const status = isConfirmed ? 'confirmed' : 'disputed';
    const finalOrderStatus = isConfirmed ? ORDER_STATUS.VALIDATED : ORDER_STATUS.DELIVERED;

    const { data: updatedOrder, error: updateError } = await supabase
      .from('commandes')
      .update({
        status: finalOrderStatus,
        is_paid: isConfirmed,
        cash_confirmation_status: status,
        updated_at: new Date().toISOString(),
        metadata: {
          ...(order.metadata || {}),
          cash_confirmation_status: status,
          delivery_fee_paid: isConfirmed,
          disputed: !isConfirmed,
          disputed_at: !isConfirmed ? new Date().toISOString() : null,
        }
      })
      .eq('id', orderId)
      .select('*')
      .single();

    if (updateError) throw updateError;

    // Notifier le livreur
    if (order.aidant_id) {
      const { data: aidant } = await supabase.from('aidants').select('user_id').eq('id', order.aidant_id).single();
      if (aidant) {
        await createNotification({
          userId: aidant.user_id,
          title: isConfirmed ? '✅ Paiement espèces validé' : '⚠️ Litige sur paiement espèces',
          body: isConfirmed 
            ? `Le client a confirmé vous avoir remis la somme de ${order.cash_amount_received} FCFA.`
            : `Le client conteste vous avoir remis la somme déclarée de ${order.cash_amount_received} FCFA.`,
          type: 'system',
          data: { order_id: orderId },
        });
      }
    }

    const fullOrder = await enrichOrderWithRelations(updatedOrder);
    return { success: true, order: fullOrder };
  } catch (error) {
    console.error('❌ confirmCashPayment error:', error);
    return { success: false, error: error.message };
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
// AUTO-VALIDATION DU CASH APRÈS EXPIRATION DE 48H
// ============================================================

const autoValidateExpiredCashOrders = async () => {
  try {
    const now = new Date().toISOString();
    const { data: expiredOrders, error } = await supabase
      .from('commandes')
      .select('*')
      .eq('status', ORDER_STATUS.DELIVERED)
      .eq('delivery_payment_method', 'cash')
      .eq('cash_confirmation_status', 'pending')
      .lte('cash_confirmation_expires_at', now);

    if (error) throw error;

    let count = 0;
    for (const order of expiredOrders) {
      await supabase
        .from('commandes')
        .update({
          status: ORDER_STATUS.VALIDATED,
          cash_confirmation_status: 'auto_confirmed',
          is_paid: true,
          metadata: {
            ...(order.metadata || {}),
            delivery_fee_paid: true,
            auto_validated_48h: true,
          }
        })
        .eq('id', order.id);

      count++;
    }
    return count;
  } catch (error) {
    console.error('❌ autoValidateExpiredCashOrders error:', error);
    return 0;
  }
};

// ============================================================
// ✅ TRAITEMENT WEBHOOK : REDIRECTION ET MISE À JOUR COMMANDE AVANCE OU FINALE
// ============================================================

const processOrderPaymentFromWebhook = async (orderId, transactionId) => {
  try {
    const { data: order, error } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', orderId)
      .single();

    if (error || !order) {
      console.error('❌ Commande introuvable pour traitement paiement:', orderId);
      return null;
    }

    if (order.status === ORDER_STATUS.WAITING_PAYMENT) {
      // Cas 1 : Paiement d'avance pour achats validé
      const { data: updatedOrder } = await supabase
        .from('commandes')
        .update({
          status: ORDER_STATUS.CREATED,
          is_paid: true,
          updated_at: new Date().toISOString(),
          metadata: {
            ...(order.metadata || {}),
            payment_confirmed_at: new Date().toISOString(),
            transaction_id: transactionId,
            paid_at: new Date().toISOString(),
          }
        })
        .eq('id', orderId)
        .select()
        .single();

      // Diffuser la commande approuvée aux aidants disponibles
      const targetDisplay = order.target_name || 'un client';
      await notifyAvailableAidantsForOrder(orderId, {
        targetDisplay,
        description: order.description,
      });

      return updatedOrder;

    } else if (order.status === ORDER_STATUS.DELIVERED) {
      // Cas 2 : Paiement en ligne de fin de livraison validé
      const { data: updatedOrder } = await supabase
        .from('commandes')
        .update({
          status: ORDER_STATUS.VALIDATED,
          is_paid: true,
          updated_at: new Date().toISOString(),
          metadata: {
            ...(order.metadata || {}),
            delivery_fee_paid: true,
            delivery_fee_payment_confirmed_at: new Date().toISOString(),
            delivery_fee_transaction_id: transactionId,
          }
        })
        .eq('id', orderId)
        .select()
        .single();

      // Notifier le livreur
      if (order.aidant_id) {
        const { data: aidant } = await supabase.from('aidants').select('user_id').eq('id', order.aidant_id).single();
        if (aidant) {
          await createNotification({
            userId: aidant.user_id,
            title: '✅ Frais de livraison réglés',
            body: `Le client a réglé les frais de livraison de ${order.delivery_fee} FCFA en ligne.`,
            type: 'system',
            data: { order_id: orderId },
          });
        }
      }

      return updatedOrder;
    }

    return order;
  } catch (err) {
    console.error('❌ Erreur processOrderPaymentFromWebhook:', err.message);
    return null;
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
  calculateWithdrawalFee,
  autoValidateExpiredCashOrders,
  processOrderPaymentFromWebhook, 
  syncAidantOrderCount,  
  checkAidantOrderQuota,
  incrementAidantOrders,
  decrementAidantOrders,
  createOrder,
  takeOrder,
  deliverOrder,
  confirmCashPayment,
  autoValidateOrder,
  notifyAvailableAidantsForOrder,
  enrichOrderWithRelations,
  getPonctualOrderPrice,
  getAidantIdFromUserIdOrId,
  checkSubscriptionForOrders,
};
