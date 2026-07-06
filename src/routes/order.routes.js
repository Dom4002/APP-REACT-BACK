// 📁 backend/src/routes/order.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');
const { createNotification } = require('../services/notification.service');
const { 
  getActiveAidantForTarget,
  getAvailableAidantsForFamily,
} = require('../services/aidantAssignment.service');
const {
  getPonctualOrderPrice,
  checkSubscriptionForOrders,
  decrementOrder,
} = require('../services/visitPayment.service');

router.use(authMiddleware);

// =============================================
// CONSTANTES
// =============================================

const ORDER_PONCTUAL_PRICES = {
  medicaments: 5000,
  produits_bebe: 5000,
  produits_hygiene: 4000,
  courses: 3000,
  repas: 4000,
  autre: 5000,
};

const DEFAULT_ORDER_PRICE = 2500;

// ✅ QUOTA MAX DE COMMANDES EN COURS PAR AIDANT
const MAX_ORDERS_IN_PROGRESS = 2;

const getPonctualOrderPriceLocal = (type, items) => {
  if (items && items.length > 0) {
    const total = items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
    if (total > 0) return total;
  }
  return ORDER_PONCTUAL_PRICES[type] || DEFAULT_ORDER_PRICE;
};

// =============================================
// RÉCUPÉRER L'AIDANT_ID
// =============================================
const getAidantIdFromUserIdOrId = async (userIdOrId) => {
  const { data: aidantById, error: errorById } = await supabase
    .from('aidants')
    .select('id')
    .eq('id', userIdOrId)
    .maybeSingle();

  if (!errorById && aidantById) {
    return aidantById.id;
  }

  const { data: aidantByUser, error: errorByUser } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userIdOrId)
    .maybeSingle();

  if (!errorByUser && aidantByUser) {
    return aidantByUser.id;
  }

  return null;
};

// =============================================
// VÉRIFIER LE QUOTA DE COMMANDES EN COURS
// =============================================
const checkAidantOrderQuota = async (aidantUserId) => {
  try {
    // Récupérer l'aidant
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, current_orders, max_orders')
      .eq('user_id', aidantUserId)
      .single();

    if (aidantError || !aidant) {
      return { 
        success: false, 
        error: 'Aidant non trouvé',
        current: 0,
        max: MAX_ORDERS_IN_PROGRESS,
        available: 0,
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

// =============================================
// INC/DEC CURRENT_ORDERS
// =============================================
const incrementAidantOrders = async (aidantUserId) => {
  try {
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, current_orders, max_orders')
      .eq('user_id', aidantUserId)
      .single();

    if (aidantError || !aidant) return false;

    const newCount = (aidant.current_orders || 0) + 1;
    const maxOrders = aidant.max_orders || MAX_ORDERS_IN_PROGRESS;

    const { error } = await supabase
      .from('aidants')
      .update({
        current_orders: newCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', aidant.id);

    if (error) {
      console.error('❌ incrementAidantOrders error:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('❌ incrementAidantOrders error:', error);
    return false;
  }
};

const decrementAidantOrders = async (aidantUserId) => {
  try {
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, current_orders, max_orders')
      .eq('user_id', aidantUserId)
      .single();

    if (aidantError || !aidant) return false;

    const newCount = Math.max(0, (aidant.current_orders || 0) - 1);

    const { error } = await supabase
      .from('aidants')
      .update({
        current_orders: newCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', aidant.id);

    if (error) {
      console.error('❌ decrementAidantOrders error:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('❌ decrementAidantOrders error:', error);
    return false;
  }
};

// =============================================
// ✅ LISTE DES COMMANDES - AVEC FILTRE DISPONIBLE
// =============================================
 
 router.get('/', async (req, res) => {
  try {
    const { user, profile } = req;
    const { status, available } = req.query;

    let query = supabase
      .from('commandes')
      .select(`
        *,
        patient:patients(*),
        aidant:aidants!commandes_aidant_id_fkey(*, user:profiles(*))
      `);

    // Filtre par rôle
    if (profile.role === 'family') {
      query = query.eq('user_id', user.id);
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();

      if (aidant) {
        query = query.eq('aidant_id', aidant.id);
      } else {
        return res.json([]);
      }
    }

    // Filtre par statut
    if (status) {
      query = query.eq('status', status);
    }

    // Filtre "disponible" pour les aidants
    if (available === 'true' && profile.role === 'aidant') {
      query = query.in('status', ['creee', 'en_attente', 'disponible']);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ GET orders error:', error);
    res.status(500).json({ error: error.message });
  }
});
// =============================================
// ✅ LISTE DES COMMANDES DISPONIBLES (POUR AIDANTS)
// =============================================
router.get('/available', async (req, res) => {
  try {
    const { user, profile } = req;

    if (profile.role !== 'aidant') {
      return res.status(403).json({ 
        error: 'Seuls les aidants peuvent voir les commandes disponibles' 
      });
    }

    // Vérifier le quota de l'aidant
    const quotaCheck = await checkAidantOrderQuota(user.id);
    if (!quotaCheck.canTake) {
      return res.json({
        data: [],
        message: `Vous avez déjà ${quotaCheck.current} commande(s) en cours (max ${quotaCheck.max})`,
        canTake: false,
        current: quotaCheck.current,
        max: quotaCheck.max,
      });
    }

    const { data, error } = await supabase
      .from('commandes')
      .select(`
        *,
        patient:patients(*)
      `)
      .in('status', ['creee', 'en_attente', 'disponible'])
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({
      data: data || [],
      canTake: true,
      current: quotaCheck.current,
      max: quotaCheck.max,
      available: quotaCheck.available,
    });
  } catch (error) {
    console.error('❌ Get available orders error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ CRÉER UNE COMMANDE - LOGIQUE UNIFIÉE AVEC ABONNEMENT
// =============================================
router.post('/', async (req, res) => {
  try {
    console.log('📥 Création commande - Body reçu:', JSON.stringify(req.body, null, 2));

    const { 
      patient_id,
      target_type,
      target_name,
      type,
      description,
      address,
      estimated_amount,
      items,
      prescription_url,
      order_type,
      is_paid,
      is_ponctual = false,
      // ✅ NOUVEAU : Wizard pour les commandes
      wizard_choice = null, // 'ponctuelle' | 'permanente' | 'without_aidant'
      selected_aidant_id = null,
    } = req.body;

    const { user, profile } = req;

    // ✅ Vérifier les permissions
    if (profile.role === 'aidant') {
      return res.status(403).json({ error: 'Les aidants ne peuvent pas créer de commandes' });
    }

    if (!type) {
      return res.status(400).json({ error: 'Le champ "type" est obligatoire' });
    }
    if (!description) {
      return res.status(400).json({ error: 'Le champ "description" est obligatoire' });
    }
    if (!address) {
      return res.status(400).json({ error: 'Le champ "address" est obligatoire' });
    }

    // ✅ Déterminer target_type et target_name
    const finalTargetType = target_type || (patient_id ? 'patient' : 'personal');
    const finalTargetName = target_name || (patient_id ? null : profile.full_name);
    const familyId = user.id;

    // ✅ LOGIQUE UNIFIÉE - VÉRIFICATION DE L'ABONNEMENT
    let status = 'creee';
    let requiresPayment = false;
    let paymentAmount = 0;
    let subscriptionId = null;

    // ✅ Vérifier l'abonnement
    const subscriptionCheck = await checkSubscriptionForOrders(user.id);
    console.log('📊 Vérification abonnement pour commande:', {
      hasActiveSubscription: subscriptionCheck.hasActiveSubscription,
      remainingOrders: subscriptionCheck.remainingOrders,
    });

    if (is_ponctual || order_type === 'ponctual') {
      // ✅ CAS 1 : Commande explicitement ponctuelle → Paiement requis
      requiresPayment = true;
      status = 'attente_paiement';
      paymentAmount = getPonctualOrderPriceLocal(type, items);
      console.log('⚡ Commande ponctuelle explicitement demandée');
      
    } else if (subscriptionCheck.hasActiveSubscription && subscriptionCheck.remainingOrders > 0) {
      // ✅ CAS 2 : Abonnement actif avec commandes disponibles
      status = 'creee';
      requiresPayment = false;
      subscriptionId = subscriptionCheck.subscription?.id || null;
      console.log('✅ Commande avec abonnement - décompte à la validation');
      
    } else if (subscriptionCheck.hasActiveSubscription && subscriptionCheck.remainingOrders === 0) {
      // ✅ CAS 3 : Abonnement actif mais plus de commandes
      requiresPayment = true;
      status = 'attente_paiement';
      paymentAmount = getPonctualOrderPriceLocal(type, items);
      console.log('⚠️ Abonnement actif mais plus de commandes - mode ponctuel');
      
    } else {
      // ✅ CAS 4 : Pas d'abonnement → Mode ponctuel
      requiresPayment = true;
      status = 'attente_paiement';
      paymentAmount = getPonctualOrderPriceLocal(type, items);
      console.log('❌ Pas d\'abonnement - mode ponctuel');
    }

    // ✅ DÉTERMINER L'AIDANT À ASSIGNER
    let finalAidantId = null;

    if (status !== 'attente_paiement') {
      const targetTypeForAidant = patient_id ? 'patient' : 'personal_account';
      const targetIdForAidant = patient_id || user.id;
      
      // 1. Vérifier si un aidant est déjà assigné à la cible
      let foundId = await getActiveAidantForTarget(
        targetTypeForAidant,
        targetIdForAidant,
        familyId
      );

      if (foundId) {
        const convertedId = await getAidantIdFromUserIdOrId(foundId);
        if (convertedId) {
          finalAidantId = convertedId;
          console.log(`✅ Aidant automatique trouvé pour la commande: ${finalAidantId}`);
        }
      } else if (selected_aidant_id && wizard_choice) {
        // 2. L'utilisateur a choisi un aidant via le wizard
        const selectedAidantId = await getAidantIdFromUserIdOrId(selected_aidant_id);
        if (selectedAidantId) {
          if (wizard_choice === 'ponctuelle') {
            // ⚡ Commande ponctuelle - NE CONSOMME PAS DE QUOTA
            finalAidantId = selectedAidantId;
            console.log(`⚡ Commande ponctuelle assignée à l'aidant: ${finalAidantId}`);
          } else if (wizard_choice === 'permanente') {
            // 📌 Commande permanente - CONSOMME 1 QUOTA
            // Vérifier le quota avant d'assigner
            const { data: aidant, error } = await supabase
              .from('aidants')
              .select('current_assignments, max_assignments')
              .eq('user_id', selected_aidant_id)
              .single();

            if (!error && aidant) {
              const current = aidant.current_assignments || 0;
              const max = aidant.max_assignments || 4;
              if (current >= max) {
                return res.status(400).json({
                  success: false,
                  error: `Cet aidant a déjà ${current}/${max} assignations. Choisissez un autre aidant ou passez en mode ponctuel.`,
                  code: 'AIDANT_FULL',
                });
              }
            }
            finalAidantId = selectedAidantId;
            console.log(`📌 Assignation permanente pour l'aidant: ${finalAidantId}`);
          }
        }
      } else {
        console.log(`ℹ️ Aucun aidant actif trouvé pour la cible ${targetTypeForAidant}/${targetIdForAidant}`);
        
        // ✅ Si admin et wizard_choice === 'without_aidant' → Commande sans aidant
        if (wizard_choice === 'without_aidant' && ['admin', 'coordinator'].includes(profile.role)) {
          finalAidantId = null;
          console.log('📋 Commande créée sans aidant assigné');
        }
      }
    }

    const orderData = {
      user_id: user.id,
      patient_id: patient_id || null,
      target_type: finalTargetType,
      target_name: finalTargetName,
      family_id: user.id,
      type: type,
      description: description,
      address: address,
      estimated_amount: estimated_amount || 0,
      items: items || [],
      prescription_url: prescription_url || null,
      status: status,
      order_type: order_type || (requiresPayment ? 'ponctual' : 'subscription'),
      is_paid: !requiresPayment,
      aidant_id: finalAidantId,
      subscription_id: subscriptionId,
      metadata: {
        requires_payment: requiresPayment,
        created_by: user.id,
        created_at: new Date().toISOString(),
        auto_assigned_aidant: !!finalAidantId && !selected_aidant_id,
        payment_amount: requiresPayment ? paymentAmount : null,
        subscription_used: subscriptionId ? true : false,
        ponctual_mode: requiresPayment ? true : false,
        wizard_choice: wizard_choice || null,
        selected_aidant: selected_aidant_id || null,
      }
    };

    console.log('📦 Données à insérer:', JSON.stringify(orderData, null, 2));

    const { data, error } = await supabase
      .from('commandes')
      .insert(orderData)
      .select('*')
      .single();

    if (error) {
      console.error('❌ Erreur Supabase insertion:', error);
      return res.status(500).json({ error: error.message, details: error });
    }

    console.log('✅ Commande créée avec succès, ID:', data.id);

    // ✅ Récupérer les relations
    let patient = null;
    if (data.patient_id) {
      const { data: patientData } = await supabase
        .from('patients')
        .select('*')
        .eq('id', data.patient_id)
        .single();
      patient = patientData;
    }

    let family = null;
    if (data.family_id) {
      const { data: familyData } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', data.family_id)
        .single();
      family = familyData;
    }

    const fullOrder = {
      ...data,
      patient,
      family,
    };

    // ✅ NOTIFICATION SELON LE STATUT
    const targetDisplay = finalTargetName || (patient ? `${patient.first_name} ${patient.last_name}` : 'Personnel');

    if (requiresPayment) {
      await createNotification({
        userId: user.id,
        title: '💳 Paiement requis pour la commande',
        body: `Un paiement de ${paymentAmount} FCFA est requis pour valider votre commande "${description}" pour ${targetDisplay}.`,
        type: 'commande',
        data: { 
          order_id: data.id, 
          status: 'attente_paiement', 
          action: 'pay',
          amount: paymentAmount,
        },
      });
    } else {
      // ✅ Si un aidant a été assigné automatiquement
      if (finalAidantId) {
        await createNotification({
          userId: finalAidantId,
          title: '🛒 Nouvelle commande assignée automatiquement',
          body: `Commande de ${targetDisplay} - ${description}`,
          type: 'commande',
          data: { order_id: data.id, action: 'take', auto_assigned: true },
        });
      } else {
        // ✅ Notifier tous les aidants disponibles
        const { data: aidants } = await supabase
          .from('aidants')
          .select('user_id')
          .eq('available', true)
          .eq('is_verified', true);

        // ✅ Filtrer ceux qui ont de la place (current_orders < max_orders)
        const availableAidants = [];
        for (const aidant of aidants || []) {
          const quotaCheck = await checkAidantOrderQuota(aidant.user_id);
          if (quotaCheck.canTake) {
            availableAidants.push(aidant);
          }
        }

        if (availableAidants.length > 0) {
          for (const aidant of availableAidants) {
            await createNotification({
              userId: aidant.user_id,
              title: '🛒 Nouvelle commande disponible',
              body: `Commande de ${targetDisplay} - ${description}`,
              type: 'commande',
              data: { order_id: data.id, action: 'take' },
            });
          }
        } else {
          console.log('ℹ️ Aucun aidant disponible pour prendre la commande');
        }
      }
    }

    res.status(201).json({
      success: true,
      order: fullOrder,
      auto_assigned_aidant: !!finalAidantId && !selected_aidant_id,
      requires_payment: requiresPayment,
      payment_amount: requiresPayment ? paymentAmount : null,
      subscription_used: !!subscriptionId,
    });

  } catch (error) {
    console.error('❌ Create order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ CONFIRMER PAIEMENT COMMANDE PONCTUELLE
// =============================================
router.post('/:id/confirm-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { transaction_id } = req.body;

    const { data: order, error: orderError } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', id)
      .single();

    if (orderError) throw orderError;

    // ✅ Vérifier que la commande est en attente de paiement
    if (order.status !== 'attente_paiement') {
      return res.status(400).json({ 
        error: 'Cette commande n\'est pas en attente de paiement. Statut actuel: ' + order.status 
      });
    }

    // ✅ Récupérer l'aidant actif après paiement
    const targetType = order.patient_id ? 'patient' : 'personal_account';
    const targetId = order.patient_id || order.user_id;
    const familyId = order.family_id || order.user_id;

    let aidantId = order.aidant_id || null;

    if (aidantId) {
      const convertedId = await getAidantIdFromUserIdOrId(aidantId);
      if (convertedId) {
        aidantId = convertedId;
      } else {
        aidantId = null;
      }
    }

    if (!aidantId) {
      let foundId = await getActiveAidantForTarget(targetType, targetId, familyId);
      if (foundId) {
        const convertedId = await getAidantIdFromUserIdOrId(foundId);
        if (convertedId) {
          aidantId = convertedId;
          console.log(`✅ Aidant trouvé après paiement de la commande: ${aidantId}`);
        }
      }
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({
        status: 'creee',
        is_paid: true,
        aidant_id: aidantId,
        metadata: {
          ...(order.metadata || {}),
          payment_confirmed_at: new Date().toISOString(),
          transaction_id: transaction_id,
          aidant_assigned_after_payment: !!aidantId,
          paid_at: new Date().toISOString(),
        }
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // ✅ Notification
    const targetDisplay = order.target_name || 'un client';

    if (aidantId) {
      await createNotification({
        userId: aidantId,
        title: '🛒 Nouvelle commande à prendre',
        body: `Commande de ${targetDisplay} - ${order.description}`,
        type: 'commande',
        data: { order_id: id, action: 'take', assigned_after_payment: true },
      });
    } else {
      const { data: aidants } = await supabase
        .from('aidants')
        .select('user_id')
        .eq('available', true)
        .eq('is_verified', true);

      const availableAidants = [];
      for (const aidant of aidants || []) {
        const quotaCheck = await checkAidantOrderQuota(aidant.user_id);
        if (quotaCheck.canTake) {
          availableAidants.push(aidant);
        }
      }

      if (availableAidants.length > 0) {
        for (const aidant of availableAidants) {
          await createNotification({
            userId: aidant.user_id,
            title: '🛒 Nouvelle commande disponible',
            body: `Commande de ${targetDisplay} - ${order.description}`,
            type: 'commande',
            data: { order_id: id, action: 'take' },
          });
        }
      }
    }

    if (order.family_id) {
      await createNotification({
        userId: order.family_id,
        title: '✅ Paiement confirmé',
        body: `Votre paiement pour la commande "${order.description}" a été confirmé.`,
        type: 'commande',
        data: { order_id: id, status: 'creee' },
      });
    }

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Confirm payment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ VALIDER UNE COMMANDE (avec décompte)
// =============================================
router.post('/:id/validate', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { comment } = req.body;
    const now = new Date().toISOString();

    const { data: existingOrder, error: checkError } = await supabase
      .from('commandes')
      .select('status, family_id, user_id, patient_id, order_type, is_paid, metadata, subscription_id, aidant_id')
      .eq('id', id)
      .single();

    if (checkError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    if (existingOrder.status !== 'livree') {
      return res.status(400).json({ 
        error: 'Seules les commandes livrées peuvent être validées' 
      });
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({ 
        status: 'validee',
        updated_at: now,
        metadata: {
          ...(existingOrder.metadata || {}),
          validated_by: req.user.id,
          validated_at: now,
          validation_comment: comment || null,
        }
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    // ✅ DÉCOMPTER UNIQUEMENT SI CE N'EST PAS PONCTUEL PAYÉ
    const isPonctual = existingOrder.order_type === 'ponctual' || existingOrder.metadata?.ponctual_mode === true;
    const wasPaid = existingOrder.is_paid === true;

    // ✅ Si commande ponctuelle payée, NE PAS DÉCOMPTER
    if (!isPonctual || !wasPaid) {
      // ✅ Si abonnement associé, décompter
      if (existingOrder.subscription_id) {
        const result = await decrementOrder(existingOrder.subscription_id);
        if (result.success) {
          console.log(`✅ Commande ${id} décomptée de l'abonnement ${existingOrder.subscription_id}`);
        } else {
          console.warn(`⚠️ Échec décompte commande ${id}:`, result.error);
        }
      } else {
        // ✅ Rechercher un abonnement actif
        const { data: subscription, error: subError } = await supabase
          .from('abonnements')
          .select('id, remaining_orders, used_orders, total_orders, user_id')
          .eq('user_id', existingOrder.user_id)
          .eq('status', 'actif')
          .maybeSingle();

        if (subscription && !subError && subscription.remaining_orders > 0) {
          const result = await decrementOrder(subscription.id);
          if (result.success) {
            console.log(`✅ Commande ${id} décomptée de l'abonnement ${subscription.id}`);
          }
        }
      }
    } else {
      console.log(`ℹ️ Commande ponctuelle payée - Pas de décompte d'abonnement pour la commande ${id}`);
    }

    // ✅ Décrémenter current_orders de l'aidant
    if (existingOrder.aidant_id) {
      const { data: aidant, error: aidantError } = await supabase
        .from('aidants')
        .select('user_id')
        .eq('id', existingOrder.aidant_id)
        .single();

      if (!aidantError && aidant) {
        await decrementAidantOrders(aidant.user_id);
        console.log(`✅ current_orders décrémenté pour l'aidant ${aidant.user_id}`);
      }
    }

    // ✅ Notification à la famille
    const targetDisplay = data.target_name || 'un client';

    if (data.family_id) {
      await createNotification({
        userId: data.family_id,
        title: '✅ Commande validée',
        body: `La commande pour ${targetDisplay} a été validée.`,
        type: 'commande',
        data: { order_id: id, status: 'validee' },
      });
    }

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Validate order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ PRENDRE UNE COMMANDE (par un aidant) - AVEC QUOTA
// =============================================
router.post('/:id/take', async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;

    const { data: order, error: fetchError } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    // ✅ Statuts acceptables pour la prise
    const availableStatuses = ['creee', 'en_attente', 'disponible'];
    if (!availableStatuses.includes(order.status)) {
      return res.status(400).json({ 
        error: 'Cette commande n\'est pas disponible. Statut actuel: ' + order.status 
      });
    }

    // ✅ Vérifier que l'aidant est disponible
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, available, is_verified, current_assignments, max_assignments')
      .eq('user_id', user.id)
      .single();

    if (aidantError || !aidant) {
      return res.status(404).json({ error: 'Aidant non trouvé' });
    }

    if (!aidant.available || !aidant.is_verified) {
      return res.status(403).json({ error: 'Vous n\'êtes pas disponible ou vérifié' });
    }

    // ✅ Vérifier le quota de commandes EN COURS (max 2)
    const quotaCheck = await checkAidantOrderQuota(user.id);
    if (!quotaCheck.canTake) {
      return res.status(403).json({ 
        error: `Vous avez déjà ${quotaCheck.current} commande(s) en cours (maximum ${quotaCheck.max})`,
        current: quotaCheck.current,
        max: quotaCheck.max,
        code: 'QUOTA_EXCEEDED',
      });
    }

    // ✅ Si la commande a déjà un aidant assigné
    if (order.aidant_id && order.aidant_id !== aidant.id) {
      return res.status(403).json({ error: 'Cette commande est déjà assignée à un autre aidant' });
    }

    // ✅ Incrémenter current_orders
    const incremented = await incrementAidantOrders(user.id);
    if (!incremented) {
      console.error('❌ Échec incrémentation current_orders');
      return res.status(500).json({ error: 'Erreur lors de la prise de commande' });
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({
        status: 'en_cours',
        aidant_id: aidant.id,
        current_aidant_id: aidant.id,
        taken_at: new Date().toISOString(),
        taken_by: user.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      // Rollback: décrémenter si erreur
      await decrementAidantOrders(user.id);
      throw error;
    }

    // ✅ Notification à la famille
    const targetDisplay = order.target_name || (order.patient ? `${order.patient.first_name} ${order.patient.last_name}` : 'Personnel');

    if (order.family_id) {
      await createNotification({
        userId: order.family_id,
        title: '✅ Commande prise en charge',
        body: `Un aidant a pris votre commande "${order.description}" pour ${targetDisplay}.`,
        type: 'commande',
        data: { order_id: id, status: 'en_cours' },
      });
    }

    res.json({ 
      success: true, 
      order: data,
      quota: {
        current: quotaCheck.current + 1,
        max: quotaCheck.max,
        available: quotaCheck.available - 1,
      },
    });
  } catch (error) {
    console.error('❌ Take order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ METTRE À JOUR LE STATUT D'UNE COMMANDE
// =============================================
router.post('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    console.log(`📥 Mise à jour statut commande ${id} -> ${status}`);

    if (!status) {
      return res.status(400).json({ error: 'Le champ "status" est obligatoire' });
    }

    const validStatuses = ['creee', 'en_attente', 'en_cours', 'livree', 'validee', 'annulee', 'disponible'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: `Statut invalide. Statuts acceptés: ${validStatuses.join(', ')}` 
      });
    }

    const { data: existingOrder, error: checkError } = await supabase
      .from('commandes')
      .select('status, family_id, aidant_id, user_id, target_name, metadata')
      .eq('id', id)
      .single();

    if (checkError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    if (existingOrder.status === 'validee' || existingOrder.status === 'annulee') {
      return res.status(400).json({ 
        error: `Impossible de modifier une commande ${existingOrder.status}` 
      });
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({ 
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('❌ Erreur mise à jour statut:', error);
      throw error;
    }

    console.log(`✅ Commande ${id} mise à jour -> ${status}`);

    // ✅ Si la commande devient disponible, notifier tous les aidants disponibles
    if (status === 'disponible') {
      const { data: aidants } = await supabase
        .from('aidants')
        .select('user_id')
        .eq('available', true)
        .eq('is_verified', true);

      const availableAidants = [];
      for (const aidant of aidants || []) {
        const quotaCheck = await checkAidantOrderQuota(aidant.user_id);
        if (quotaCheck.canTake) {
          availableAidants.push(aidant);
        }
      }

      if (availableAidants.length > 0) {
        const targetDisplay = existingOrder.target_name || 'un client';
        for (const aidant of availableAidants) {
          await createNotification({
            userId: aidant.user_id,
            title: '🚨 Commande urgente disponible',
            body: `Commande pour ${targetDisplay} - Premier arrivé, premier servi !`,
            type: 'commande',
            data: { order_id: id, action: 'take', urgency: 'high' },
          });
        }
      }
    }

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Update status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ LIVRER UNE COMMANDE - DÉCRÉMENTE CURRENT_ORDERS
// =============================================
router.post('/:id/deliver', async (req, res) => {
  try {
    const { id } = req.params;
    const { proof_url, location } = req.body;

    const { data: existingOrder, error: checkError } = await supabase
      .from('commandes')
      .select('status, family_id, target_name, metadata, aidant_id')
      .eq('id', id)
      .single();

    if (checkError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    if (existingOrder.status !== 'en_cours') {
      return res.status(400).json({ error: 'Seules les commandes en cours peuvent être livrées' });
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({ 
        status: 'livree',
        proof_url: proof_url || null,
        updated_at: new Date().toISOString(),
        auto_validation_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        metadata: {
          ...(existingOrder.metadata || {}),
          delivered_at: new Date().toISOString(),
          delivery_location: location || null,
        }
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    // ✅ Décrémenter current_orders de l'aidant
    if (existingOrder.aidant_id) {
      const { data: aidant, error: aidantError } = await supabase
        .from('aidants')
        .select('user_id')
        .eq('id', existingOrder.aidant_id)
        .single();

      if (!aidantError && aidant) {
        await decrementAidantOrders(aidant.user_id);
        console.log(`✅ current_orders décrémenté pour l'aidant ${aidant.user_id}`);
      }
    }

    // ✅ Notification à la famille
    const targetDisplay = existingOrder.target_name || 'un client';

    if (existingOrder.family_id) {
      await createNotification({
        userId: existingOrder.family_id,
        title: '📦 Commande livrée',
        body: `Votre commande pour ${targetDisplay} a été livrée avec succès !`,
        type: 'commande',
        data: { order_id: id, status: 'livree' },
      });
    }

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Deliver order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ ANNULER UNE COMMANDE
// =============================================
router.post('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const { user, profile } = req;

    const { data: existingOrder, error: checkError } = await supabase
      .from('commandes')
      .select('status, family_id, user_id, metadata, aidant_id')
      .eq('id', id)
      .single();

    if (checkError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    // ✅ Seul admin/coord ou famille peuvent annuler
    const canCancel = ['admin', 'coordinator'].includes(profile.role);
    if (!canCancel) {
      if (profile.role === 'family' && existingOrder.user_id !== user.id) {
        return res.status(403).json({ error: 'Non autorisé' });
      }
    }

    if (existingOrder.status === 'validee') {
      return res.status(400).json({ error: 'Impossible d\'annuler une commande validée' });
    }

    if (existingOrder.status === 'annulee') {
      return res.status(400).json({ error: 'Commande déjà annulée' });
    }

    // ✅ Si l'aidant avait pris la commande, décrémenter current_orders
    if (existingOrder.aidant_id && existingOrder.status === 'en_cours') {
      const { data: aidant, error: aidantError } = await supabase
        .from('aidants')
        .select('user_id')
        .eq('id', existingOrder.aidant_id)
        .single();

      if (!aidantError && aidant) {
        await decrementAidantOrders(aidant.user_id);
        console.log(`✅ current_orders décrémenté pour l'aidant ${aidant.user_id}`);
      }
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({ 
        status: 'annulee',
        updated_at: new Date().toISOString(),
        metadata: {
          ...(existingOrder.metadata || {}),
          cancelled_by: user.id,
          cancelled_at: new Date().toISOString(),
          cancellation_reason: reason || null,
        }
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    // ✅ Notification à la famille
    if (data.family_id && data.family_id !== user.id) {
      await createNotification({
        userId: data.family_id,
        title: '❌ Commande annulée',
        body: `Votre commande "${data.description}" a été annulée${reason ? ` : ${reason}` : ''}.`,
        type: 'commande',
        data: { order_id: id, status: 'annulee' },
      });
    }

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Cancel order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ AUTO-VALIDATION D'UNE COMMANDE (après 12h)
// =============================================
router.post('/:id/auto-validate', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;

    const { data: order, error: fetchError } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    if (order.status !== 'livree') {
      return res.status(400).json({ 
        error: 'Seules les commandes livrées peuvent être auto-validées' 
      });
    }

    // ✅ Vérifier que 12h se sont écoulées
    const deliveredAt = new Date(order.metadata?.delivered_at || order.updated_at);
    const now = new Date();
    const diffHours = (now.getTime() - deliveredAt.getTime()) / (1000 * 60 * 60);

    if (diffHours < 12) {
      return res.status(400).json({
        error: `Auto-validation possible après 12h (${Math.round(12 - diffHours)}h restantes)`,
      });
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({
        status: 'validee',
        is_auto_validated: true,
        updated_at: new Date().toISOString(),
        metadata: {
          ...(order.metadata || {}),
          auto_validated_at: new Date().toISOString(),
        }
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Auto-validate order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// RÉCUPÉRER UNE COMMANDE PAR ID
// =============================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, profile } = req;

    const { data, error } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Commande non trouvée' });
      }
      throw error;
    }

    // ✅ Vérification d'accès
    let hasAccess = false;

    if (['admin', 'coordinator'].includes(profile.role)) {
      hasAccess = true;
    } else if (profile.role === 'family') {
      hasAccess = data.user_id === user.id;
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();
      
      if (aidant) {
        hasAccess = data.aidant_id === aidant.id || data.status === 'disponible';
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    let patient = null;
    if (data.patient_id) {
      const { data: patientData } = await supabase
        .from('patients')
        .select('*')
        .eq('id', data.patient_id)
        .single();
      patient = patientData;
    }

    let family = null;
    if (data.family_id) {
      const { data: familyData } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', data.family_id)
        .single();
      family = familyData;
    }

    let aidant = null;
    if (data.aidant_id) {
      const { data: aidantData } = await supabase
        .from('aidants')
        .select('*, user:profiles(*)')
        .eq('id', data.aidant_id)
        .single();
      aidant = aidantData;
    }

    const fullOrder = {
      ...data,
      patient,
      family,
      aidant,
    };

    res.json(fullOrder);
  } catch (error) {
    console.error('❌ Get order error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
