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
const {
  checkAidantOrderQuota,
  incrementAidantOrders,
  decrementAidantOrders,
  createOrder,
  takeOrder,
  deliverOrder,
  autoValidateOrder,
  enrichOrderWithRelations,
  syncAidantOrderCount,
} = require('../services/order.service');

router.use(authMiddleware);

// =============================================
// CONSTANTES - TARIFS ET QUOTAS
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
const MAX_ORDERS_IN_PROGRESS = 2;

const getPonctualOrderPriceLocal = (type, items) => {
  if (items && items.length > 0) {
    const total = items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
    if (total > 0) return total;
  }
  return ORDER_PONCTUAL_PRICES[type] || DEFAULT_ORDER_PRICE;
};

// ============================================================
// UTILITAIRES AIDANTS ET QUOTAS
// ============================================================
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
// 1️⃣ ROUTES STATIQUES (SANS PARAMÈTRE :id)
// =============================================

// ✅ 1.1 COMMANDES DISPONIBLES (AIDANTS UNIQUEMENT)
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

// ✅ 1.2 OBTENIR TOUTES LES COMMANDES CHRONOLOGIQUES (AVEC FILTRE JAVASCRIPT ROBUSTE)
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

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    let filteredData = data || [];

    if (profile.role === 'family') {
      filteredData = filteredData.filter(order => order.user_id === user.id);
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();

      if (aidant) {
        filteredData = filteredData.filter(order => {
          const isAssignedToMe = order.aidant_id === aidant.id || order.taken_by === user.id;
          const isAvailableToAll = !order.aidant_id && ['creee', 'en_attente', 'disponible'].includes(order.status);
          return isAssignedToMe || isAvailableToAll;
        });
      } else {
        filteredData = [];
      }
    }

    if (available === 'true' && profile.role === 'aidant') {
      filteredData = filteredData.filter(order => ['creee', 'en_attente', 'disponible'].includes(order.status));
    }

    res.json(filteredData);
  } catch (error) {
    console.error('❌ GET orders error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// 2️⃣ ROUTE DE CRÉATION DE COMMANDE (POST '/')
// =============================================

router.post('/', async (req, res) => {
  try {
    const { user, profile } = req;
    const { 
      patient_id,
      target_type,
      target_name,
      type,
      description,
      address,
      latitude = null,
      longitude = null,
      estimated_amount,
      items,
      prescription_url,
      order_type,
      is_ponctual = false,
      wizard_choice = null,
      selected_aidant_id = null,
    } = req.body;

    if (profile.role === 'aidant') {
      return res.status(403).json({ error: 'Les aidants ne peuvent pas créer de commandes' });
    }

    const result = await createOrder({
      userId: user.id,
      patientId: patient_id || null,
      targetType: target_type || (patient_id ? 'patient' : 'personal'),
      targetName: target_name || null,
      type,
      description,
      address,
      latitude,
      longitude,
      estimatedAmount: estimated_amount || 0,
      items: items || [],
      prescriptionUrl: prescription_url || null,
      isPonctual: is_ponctual || order_type === 'ponctual',
      wizardChoice: wizard_choice,
      selectedAidantId: selected_aidant_id,
      profile,
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    res.status(201).json({
      success: true,
      order: result.order,
      requires_payment: result.requires_payment,
      payment_amount: result.payment_amount,
      subscription_used: result.subscription_used,
      auto_assigned_aidant: result.auto_assigned_aidant,
    });
  } catch (error) {
    console.error('❌ Erreur création de commande (route):', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// 3️⃣ ROUTES DYNAMIQUES (AVEC PARAMÈTRE :id)
// =============================================

// ✅ 3.1 DÉTAILS D'UNE COMMANDE PAR ID (AVEC ENRICHISSEMENT)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, profile } = req;

    const { data: order, error } = await supabase
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
      hasAccess = order.user_id === user.id;
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();
      
      if (aidant) {
        hasAccess = order.aidant_id === aidant.id || order.status === 'disponible';
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    let patient = null;
    if (order.patient_id) {
      const { data: patientData } = await supabase.from('patients').select('*').eq('id', order.patient_id).single();
      patient = patientData;
    }

    let family = null;
    if (order.family_id) {
      const { data: familyData } = await supabase.from('profiles').select('*').eq('id', order.family_id).single();
      family = familyData;
    }

    let aidant = null;
    if (order.aidant_id) {
      const { data: aidantData } = await supabase.from('aidants').select('*, user:profiles(*)').eq('id', order.aidant_id).single();
      aidant = aidantData;
    }

    res.json({ ...order, patient, family, aidant });
  } catch (error) {
    console.error('❌ Get order detail route error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.2 CONFIRMER LE PAIEMENT D'UNE COMMANDE PONCTUELLE
router.post('/:id/confirm-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { transaction_id } = req.body;

    const { data: order, error: orderError } = await supabase.from('commandes').select('*').eq('id', id).single();
    if (orderError) throw orderError;

    if (order.status !== 'attente_paiement') {
      return res.status(400).json({ error: 'Cette commande n\'est pas en attente de paiement' });
    }

    let aidantId = order.aidant_id || null;

    if (aidantId) {
      const convertedId = await getAidantIdFromUserIdOrId(aidantId);
      if (convertedId) aidantId = convertedId;
      else aidantId = null;
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

    const targetDisplay = order.target_name || 'un client';

    if (!aidantId) {
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
            userId: aidant.user_id,
            title: '🛒 Nouvelle commande disponible',
            body: `Commande de ${targetDisplay} - ${order.description}`,
            type: 'commande',
            data: { order_id: id, action: 'take' },
          });
        }
      }
    } else {
      const { data: aidantProfile } = await supabase.from('aidants').select('user_id').eq('id', aidantId).maybeSingle();
      // ✅ CORRECTIF SYNTAXIQUE : Remplacement de antProfile par aidantProfile
      if (aidantProfile?.user_id) {
        await createNotification({
          userId: aidantProfile.user_id,
          title: '🛒 Nouvelle commande à prendre',
          body: `Commande de ${targetDisplay} - ${order.description}`,
          type: 'commande',
          data: { order_id: id, action: 'take', assigned_after_payment: true },
        });
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
    console.error('❌ Confirm payment route error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.3 PRENDRE UNE COMMANDE (AIDANT - CAPTURE GPS DE PRISE SÉCURISÉE)
router.post('/:id/take', async (req, res) => {
  try {
    const { id } = req.params;
    const aidantUserId = req.user.id;
    // 🟢 CORRECTIF : Extraction sécurisée de lat et lng envoyées par le mobile
    const { lat, lng } = req.body; 

    const { takeOrder } = require('../services/order.service');
    const result = await takeOrder(id, aidantUserId, lat, lng); // 🟢 Transmission des coordonnées GPS au service

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

    res.json({
      success: true,
      message: 'Commande prise en charge avec succès',
      order: result.order,
    });
  } catch (error) {
    console.error('❌ Take order route error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.4 CHANGEMENT DE STATUT GÉNÉRIQUE (ADMIN/COORDINATION) AVEC RECALCUL DU QUOTA ET RÉCRÉDIT
router.post('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const { data: order, error: fetchError } = await supabase.from('commandes').select('*').eq('id', id).single();
    if (fetchError) throw fetchError;

    const { data, error } = await supabase
      .from('commandes')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // ✅ RÉCRÉDITER SI L'ADMIN UTILISE LE STATUT GÉNÉRIQUE POUR ANNULER UNE COMMANDE COMPTÉE
    const wasDelivered = order.status === 'livree' || order.status === 'validee';
    if (wasDelivered && status === 'annulee' && order.subscription_id) {
      const { incrementOrder } = require('../services/visitPayment.service');
      const result = await incrementOrder(order.subscription_id);
      if (result.success) {
        console.log(`📈 [Récrédit] Forfait récrédité (+1 commande) suite à l'annulation de statut.`);
      }
    }

    if (order.aidant_id) {
      const { data: aidant } = await supabase.from('aidants').select('user_id').eq('id', order.aidant_id).single();
      if (aidant) {
        await syncAidantOrderCount(aidant.user_id);
      }
    }

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Update status route error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.5 LIVRAISON DE LA COMMANDE (AVEC DÉCOMPTE FORFAIT IMMÉDIAT ET LOCATION DU DÉPÔT)
router.post('/:id/deliver', async (req, res) => {
  try {
    const { id } = req.params;
    const { proof_url, location } = req.body;
    const aidantUserId = req.user.id;

    // Récupérer la commande pour vérifier s'il s'agit d'un abonnement actif
    const { data: order, error: orderError } = await supabase
      .from('commandes')
      .select('subscription_id')
      .eq('id', id)
      .single();

    if (orderError) throw orderError;

    const { deliverOrder } = require('../services/order.service');
    const result = await deliverOrder(id, aidantUserId, proof_url, location);

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    // ✅ DÉCOMPTE IMMÉDIAT LORS DE LA LIVRAISON DE LA COMMANDE SANS ATTENDRE LA VALIDATION ADMIN
    if (order.subscription_id) {
      const { decrementOrder } = require('../services/visitPayment.service');
      const decResult = await decrementOrder(order.subscription_id);
      if (decResult.success) {
        console.log(`📉 [Décompte] Commande décomptée de l'abonnement ${order.subscription_id} lors de la livraison.`);
      } else {
        console.warn(`⚠️ [Décompte] Échec du décompte immédiat de commande:`, decResult.error);
      }
    }

    res.json({
      success: true,
      message: 'Commande livrée avec succès',
      order: result.order,
    });
  } catch (error) {
    console.error('❌ Deliver order route error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.6 ANNULER UNE COMMANDE ET RESTITUER LE QUOTA ET CRÉDIT (+1 !)
router.post('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const { user, profile } = req;

    const { data: order, error: fetchError } = await supabase.from('commandes').select('*').eq('id', id).single();
    if (fetchError) throw fetchError;

    const canCancel = ['admin', 'coordinator'].includes(profile.role) || order.user_id === user.id;
    if (!canCancel) {
      return res.status(403).json({ error: 'Non autorisé à annuler cette commande' });
    }

    const { data: updatedOrder, error: updateError } = await supabase
      .from('commandes')
      .update({
        status: 'annulee',
        updated_at: new Date().toISOString(),
        metadata: {
          ...(order.metadata || {}),
          cancelled_by: user.id,
          cancelled_at: new Date().toISOString(),
          cancellation_reason: reason || 'Annulée par l\'utilisateur',
        }
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    // ✅ RÉCRÉDITER (+1) L'ABONNEMENT EN CAS D'ANNULATION D'UNE COMMANDE DÉJÀ LIVRÉE OU VALIDÉE
    const wasDelivered = order.status === 'livree' || order.status === 'validee';
    if (wasDelivered && order.subscription_id) {
      const { incrementOrder } = require('../services/visitPayment.service');
      const result = await incrementOrder(order.subscription_id);
      if (result.success) {
        console.log(`📈 [Récrédit] Forfait récrédité (+1 commande) suite à l'annulation.`);
      }
    }

    if (order.aidant_id) {
      const { data: aidant } = await supabase.from('aidants').select('user_id').eq('id', order.aidant_id).single();
      if (aidant) {
        await syncAidantOrderCount(aidant.user_id);
      }
    }

    res.json({ success: true, order: updatedOrder });
  } catch (error) {
    console.error('❌ Cancel order route error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.7 AUTO-VALIDATION ADMIN (PLUS DE DECOMPTE REDONDANT ICI !)
router.post('/:id/auto-validate', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;

    const { autoValidateOrder } = require('../services/order.service');
    const result = await autoValidateOrder(id);

    res.json({
      success: true,
      message: 'Commande validée avec succès',
      order: result.order,
    });
  } catch (error) {
    console.error('❌ Auto-validate route error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
