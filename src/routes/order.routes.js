// 📁 backend/src/routes/order.routes.js
// ✅ GESTION DES COMMANDES - ACCÈS ET VISIBILITÉ EN TEMPS RÉEL COMPLETS POUR LES AIDANTS DISPONIBLES

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
// 1️⃣ TOUTES LES ROUTES STATIQUES (SANS :id) - PLACÉES TOUT EN HAUT
// =============================================

// ✅ 1.1 OBTENIR LES COMMANDES DISPONIBLES (POUR LES AIDANTS)
router.get('/available', async (req, res) => {
  try {
    const { user, profile } = req;

    if (profile.role !== 'aidant') {
      return res.status(403).json({ 
        error: 'Seuls les aidants peuvent voir les commandes disponibles' 
      });
    }

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

// ✅ 1.2 OBTENIR TOUTES LES COMMANDES
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
        // ✅ CORRECTIF DE VISIBILITÉ SÉCURISÉ : L'aidant voit ses propres commandes assignées 
        // ET les nouvelles commandes disponibles non assignées (aidant_id nul)
        query = query.or(`aidant_id.eq.${aidant.id},and(aidant_id.is.null,status.in.(creee,en_attente,disponible))`);
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
// 2️⃣ ROUTES DE MANIPULATION D'ÉCRITURE (AVEC ROUTE COORDONNÉE '/')
// =============================================

// ✅ 2.1 CRÉER UNE COMMANDE (Avec détection asynchrone flexible pour proches/personnel)
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
      wizard_choice = null,
      selected_aidant_id = null,
    } = req.body;

    const { user, profile } = req;

    if (profile.role === 'aidant') {
      return res.status(403).json({ error: 'Les aidants ne peuvent pas créer de commandes' });
    }

    if (!type || !description || !address) {
      return res.status(400).json({ error: 'Les champs obligatoires sont manquants' });
    }

    // ✅ DÉTERMINER DE MANIÈRE FLEXIBLE LA CIBLE (Retrait du bloc "hasPatient" restrictif)
    let finalPatientId = null;
    let finalTargetType = 'personal';
    let finalTargetName = target_name || null;
    let targetHasPatient = false;
    let familyId = user.id;

    if (patient_id) {
      const { data: patient, error: patientError } = await supabase
        .from('patients')
        .select('id, first_name, last_name, category, created_by')
        .eq('id', patient_id)
        .single();

      if (patientError || !patient) {
        return res.status(404).json({ error: 'Patient non trouvé' });
      }

      finalPatientId = patient_id;
      finalTargetType = 'patient';
      finalTargetName = `${patient.first_name} ${patient.last_name}`;
      targetHasPatient = true;
    } else {
      finalPatientId = null;
      finalTargetType = 'personal';
      finalTargetName = profile.full_name || 'Personnel';
      targetHasPatient = false;
    }

    // ✅ LOGIQUE UNIFIÉE - VÉRIFICATION DE L'ABONNEMENT
    let status = 'creee';
    let requiresPayment = false;
    let paymentAmount = 0;
    let subscriptionId = null;

    const subscriptionCheck = await checkSubscriptionForOrders(user.id);
    console.log('📊 Vérification abonnement pour commande:', {
      hasActiveSubscription: subscriptionCheck.hasActiveSubscription,
      remainingOrders: subscriptionCheck.remainingOrders,
    });

    if (is_ponctual || order_type === 'ponctual') {
      requiresPayment = true;
      status = 'attente_paiement';
      paymentAmount = getPonctualOrderPriceLocal(type, items);
    } else if (subscriptionCheck.hasActiveSubscription && subscriptionCheck.remainingOrders > 0) {
      status = 'creee';
      requiresPayment = false;
      subscriptionId = subscriptionCheck.subscription?.id || null;
    } else if (subscriptionCheck.hasActiveSubscription && subscriptionCheck.remainingOrders === 0) {
      requiresPayment = true;
      status = 'attente_paiement';
      paymentAmount = getPonctualOrderPriceLocal(type, items);
    } else {
      requiresPayment = true;
      status = 'attente_paiement';
      paymentAmount = getPonctualOrderPriceLocal(type, items);
    }

    let finalAidantId = null;

    if (status !== 'attente_paiement') {
      const targetTypeForAidant = finalPatientId ? 'patient' : 'personal_account';
      const targetIdForAidant = finalPatientId || user.id;
      
      let foundId = await getActiveAidantForTarget(targetTypeForAidant, targetIdForAidant, familyId);

      if (foundId) {
        const convertedId = await getAidantIdFromUserIdOrId(foundId);
        if (convertedId) {
          finalAidantId = convertedId;
          console.log(`✅ Aidant automatique trouvé pour la commande: ${finalAidantId}`);
        }
      } else if (selected_aidant_id && wizard_choice) {
        const selectedAidantId = await getAidantIdFromUserIdOrId(selected_aidant_id);
        if (selectedAidantId) {
          if (wizard_choice === 'ponctuelle') {
            finalAidantId = selectedAidantId;
          } else if (wizard_choice === 'permanente') {
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
                  error: `Cet aidant a déjà ${current}/${max} assignations.`,
                  code: 'AIDANT_FULL',
                });
              }
            }
            finalAidantId = selectedAidantId;
          }
        }
      } else {
        if (wizard_choice === 'without_aidant' && ['admin', 'coordinator'].includes(profile.role)) {
          finalAidantId = null;
        }
      }
    }

    const orderData = {
      user_id: user.id,
      patient_id: finalPatientId,
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

    const { data, error } = await supabase
      .from('commandes')
      .insert(orderData)
      .select('*')
      .single();

    if (error) {
      console.error('❌ Erreur Supabase insertion:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('✅ Commande créée avec succès, ID:', data.id);

    let patient = null;
    if (data.patient_id) {
      const { data: patientData } = await supabase.from('patients').select('*').eq('id', data.patient_id).single();
      patient = patientData;
    }

    let family = null;
    if (data.family_id) {
      const { data: familyData } = await supabase.from('profiles').select('*').eq('id', data.family_id).single();
      family = familyData;
    }

    const fullOrder = { ...data, patient, family };
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
      if (finalAidantId) {
        // ✅ CORRECTION : Utiliser le user_id de l'aidant
        const { data: aidantProfile } = await supabase.from('aidants').select('user_id').eq('id', finalAidantId).maybeSingle();
        if (aidantProfile?.user_id) {
          await createNotification({
            userId: aidantProfile.user_id, // ✅ Profiles.id au lieu de aidant_id
            title: '🛒 Nouvelle commande assignée automatiquement',
            body: `Commande de ${targetDisplay} - ${description}`,
            type: 'commande',
            data: { order_id: data.id, action: 'take', auto_assigned: true },
          });
        }
      } else {
        const { data: aidants } = await supabase.from('aidants').select('user_id').eq('available', true).eq('is_verified', true);
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
              userId: aidant.user_id, // ✅ Correct (profiles.id)
              title: '🛒 Nouvelle commande disponible',
              body: `Commande de ${targetDisplay} - ${description}`,
              type: 'commande',
              data: { order_id: data.id, action: 'take' },
            });
          }
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
// 3️⃣ ROUTES DYNAMIQUES (AVEC PARAMÈTRE :id)
// =============================================

// ✅ 3.1 DÉTAILS D'UNE COMMANDE PAR ID
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
      const { data: patientData } = await supabase.from('patients').select('*').eq('id', data.patient_id).single();
      patient = patientData;
    }

    let family = null;
    if (data.family_id) {
      const { data: familyData } = await supabase.from('profiles').select('*').eq('id', data.family_id).single();
      family = familyData;
    }

    let aidant = null;
    if (data.aidant_id) {
      const { data: aidantData } = await supabase.from('aidants').select('*, user:profiles(*)').eq('id', data.aidant_id).single();
      aidant = aidantData;
    }

    const fullOrder = { ...data, patient, family, aidant };
    res.json(fullOrder);
  } catch (error) {
    console.error('❌ Get order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.2 CONFIRMER PAIEMENT COMMANDE PONCTUELLE et NOTIFIER EN DIRECT
router.post('/:id/confirm-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { transaction_id } = req.body;

    const { data: order, error: orderError } = await supabase.from('commandes').select('*').eq('id', id).single();
    if (orderError) throw orderError;

    if (order.status !== 'attente_paiement') {
      return res.status(400).json({ error: 'Cette commande n\'est pas en attente de paiement' });
    }

    const targetType = order.patient_id ? 'patient' : 'personal_account';
    const targetId = order.patient_id || order.user_id;
    const familyId = order.family_id || order.user_id;

    let aidantId = order.aidant_id || null;

    if (aidantId) {
      const convertedId = await getAidantIdFromUserIdOrId(aidantId);
      if (convertedId) aidantId = convertedId;
      else aidantId = null;
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

    // ✅ NOTIFICATION AUTOMATIQUE EN DIRECT AUX AIDANTS APRES PAIEMENT
    const targetDisplay = order.target_name || 'un client';

    if (aidantId) {
      // ✅ CORRECTION : Récupérer le user_id de l'aidant
      const { data: aidantProfile } = await supabase.from('aidants').select('user_id').eq('id', aidantId).maybeSingle();
      if (aidantProfile?.user_id) {
        await createNotification({
          userId: aidantProfile.user_id, // ✅ ID de profil (profiles.id) à la place de l'aidant_id
          title: '🛒 Nouvelle commande à prendre',
          body: `Commande de ${targetDisplay} - ${order.description}`,
          type: 'commande',
          data: { order_id: id, action: 'take', assigned_after_payment: true },
        });
      }
    } else {
      const { data: aidants } = await supabase.from('aidants').select('user_id').eq('available', true).eq('is_verified', true);
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
            userId: aidant.user_id, // ✅ Correct (profiles.id)
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

// ✅ 3.3 PRENDRE UNE COMMANDE (par un aidant) - AVEC QUOTA
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
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Statut invalide' });

    const { data: existingOrder, error: checkError } = await supabase.from('commandes').select('status, family_id, aidant_id, user_id, target_name').eq('id', id).single();
    if (checkError) return res.status(404).json({ error: 'Commande non trouvée' });

    if (existingOrder.status === 'validee' || existingOrder.status === 'annulee') {
      return res.status(400).json({ error: 'Action impossible sur une commande finalisée' });
    }

    const { data, error } = await supabase.from('commandes').update({ status, updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
    if (error) throw error;

    if (status === 'disponible') {
      const { data: aidants } = await supabase.from('aidants').select('user_id').eq('available', true).eq('is_verified', true);
      const availableAidants = [];
      for (const aidant of aidants || []) {
        const quotaCheck = await checkAidantOrderQuota(aidant.user_id);
        if (quotaCheck.canTake) availableAidants.push(aidant);
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

// ✅ 3.5 LIVRER UNE COMMANDE
router.post('/:id/deliver', async (req, res) => {
  try {
    const { id } = req.params;
    const { proof_url, location } = req.body;

    const { data: existingOrder, error: checkError } = await supabase.from('commandes').select('status, family_id, target_name, metadata, aidant_id').eq('id', id).single();
    if (checkError) return res.status(404).json({ error: 'Commande non trouvée' });

    if (existingOrder.status !== 'en_cours') return res.status(400).json({ error: 'Commande non éligible à la livraison' });

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

    if (existingOrder.aidant_id) {
      const { data: aidant } = await supabase.from('aidants').select('user_id').eq('id', existingOrder.aidant_id).single();
      if (aidant) await decrementAidantOrders(aidant.user_id);
    }

    if (existingOrder.family_id) {
      await createNotification({
        userId: existingOrder.family_id,
        title: '📦 Commande livrée',
        body: `Votre commande pour ${existingOrder.target_name || 'un client'} a été livrée avec succès !`,
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

// ✅ 3.6 ANNULER UNE COMMANDE
router.post('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const { user, profile } = req;

    const { data: existingOrder, error: checkError } = await supabase.from('commandes').select('status, family_id, user_id, metadata, aidant_id').eq('id', id).single();
    if (checkError) return res.status(404).json({ error: 'Commande non trouvée' });

    const canCancel = ['admin', 'coordinator'].includes(profile.role);
    if (!canCancel && profile.role === 'family' && existingOrder.user_id !== user.id) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    if (existingOrder.status === 'validee' || existingOrder.status === 'annulee') {
      return res.status(400).json({ error: 'Action impossible sur une commande validée ou annulée' });
    }

    if (existingOrder.aidant_id && existingOrder.status === 'en_cours') {
      const { data: informants } = await supabase.from('aidants').select('user_id').eq('id', existingOrder.aidant_id).single();
      if (informants) await decrementAidantOrders(informants.user_id);
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

// ✅ 3.7 AUTO-VALIDATION D'UNE COMMANDE (après 12h)
router.post('/:id/auto-validate', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { data: order, error: fetchError } = await supabase.from('commandes').select('*').eq('id', id).single();
    if (fetchError) return res.status(404).json({ error: 'Commande non trouvée' });

    if (order.status !== 'livree') return res.status(400).json({ error: 'Seules les commandes livrées peuvent être auto-validées' });

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

module.exports = router;
