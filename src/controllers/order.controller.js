// 📁 backend/src/controllers/order.controller.js

const { supabase } = require('../services/supabase.service');
const {
  createOrder,
  takeOrder,
  deliverOrder,
  confirmCashPayment,  
  autoValidateOrder,
  ORDER_STATUS,
} = require('../services/order.service');
const { createNotification } = require('../services/notification.service');
const { asyncWrapper } = require('../utils/errorHandler');

// ============================================================
// CRÉER UNE COMMANDE
// ============================================================
const createOrderController = asyncWrapper(async (req, res) => {
  try {
    const { user, profile } = req;
    const {
      patient_id,
      target_type,
      target_name,
      type,
      description,
      address,
      purchase_amount = 0,         // ✅ Montant estimé des achats
      withdrawal_operator = null,  // ✅ Opérateur GSM ('mtn_moov' ou 'celtiis')
      prescription_url,
      is_ponctual = false,
      wizard_choice = null,
      selected_aidant_id = null,
    } = req.body;

    // ✅ Vérifier les permissions
    if (profile.role === 'aidant') {
      return res.status(403).json({
        success: false,
        error: 'Les aidants ne peuvent pas créer de commandes',
      });
    }

    if (!type || !description || !address) {
      return res.status(400).json({
        success: false,
        error: 'Type, description et adresse sont obligatoires',
      });
    }

    const result = await createOrder({
      userId: user.id,
      patientId: patient_id || null,
      targetType: target_type || (patient_id ? 'patient' : 'personal'),
      targetName: target_name || (patient_id ? null : profile.full_name),
      type,
      description,
      address,
      purchaseAmount: Number(purchase_amount || 0),
      withdrawalOperator: withdrawal_operator,
      prescriptionUrl: prescription_url || null,
      isPonctual: is_ponctual || false,
      wizardChoice: wizard_choice || null,
      selectedAidantId: selected_aidant_id || null,
      profile,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
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
    console.error('❌ createOrderController error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la création de la commande',
    });
  }
});

// ============================================================
// PRENDRE UNE COMMANDE (AIDANT)
// ============================================================
const takeOrderController = asyncWrapper(async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { lat, lng } = req.body; // Récupère le checkpoint GPS de départ

    const result = await takeOrder(id, userId, lat, lng);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
        current: result.current,
        max: result.max,
      });
    }

    res.json({
      success: true,
      message: 'Commande prise en charge',
      order: result.order,
      quota: result.quota,
    });
  } catch (error) {
    console.error('❌ takeOrderController error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la prise de commande',
    });
  }
});

// ============================================================
// LIVRER UNE COMMANDE (AVEC DOUBLE MODALITÉ SÉCURISÉE)
// ============================================================
const deliverOrderController = asyncWrapper(async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { 
      proof_url, 
      lat, 
      lng, 
      delivery_fee, 
      payment_method, 
      cash_amount_received 
    } = req.body;

    if (!payment_method) {
      return res.status(400).json({
        success: false,
        error: 'Le moyen de paiement est obligatoire (online ou cash)',
      });
    }

    const location = lat && lng ? { lat, lng } : null;

    const result = await deliverOrder(
      id, 
      userId, 
      proof_url, 
      location,
      Number(delivery_fee || 0),
      payment_method,
      Number(cash_amount_received || 0)
    );

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

    res.json({
      success: true,
      message: 'Livraison de la commande enregistrée avec succès',
      order: result.order,
      auto_validation_at: result.auto_validation_at,
    });
  } catch (error) {
    console.error('❌ deliverOrderController error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la livraison',
    });
  }
});

// ============================================================
// ✅ NOUVEAU : CONFIRMER OU CONTESTER LE PAIEMENT CASH (FAMILLE)
// ============================================================
const confirmCashPaymentController = asyncWrapper(async (req, res) => {
  try {
    const { id } = req.params;
    const { is_confirmed } = req.body;
    const userId = req.user.id;

    if (is_confirmed === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Le paramètre is_confirmed (booléen) est requis',
      });
    }

    const result = await confirmCashPayment(id, userId, is_confirmed);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      message: is_confirmed ? 'Paiement en espèces validé' : 'Litige de paiement espèces enregistré',
      order: result.order,
    });
  } catch (error) {
    console.error('❌ confirmCashPaymentController error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la validation du paiement espèces',
    });
  }
});

// ============================================================
// AUTO-VALIDER UNE COMMANDE (ADMIN)
// ============================================================
const autoValidateOrderController = asyncWrapper(async (req, res) => {
  try {
    const { id } = req.params;

    const result = await autoValidateOrder(id);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
        remainingHours: result.remainingHours,
      });
    }

    res.json({
      success: true,
      message: 'Commande auto-validée avec succès',
      order: result.order,
    });
  } catch (error) {
    console.error('❌ autoValidateOrderController error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de l\'auto-validation',
    });
  }
});

// ============================================================
// RÉCUPÉRER LES COMMANDES DISPONIBLES (AIDANT)
// ============================================================
const getAvailableOrders = asyncWrapper(async (req, res) => {
  try {
    const userId = req.user.id;

    // Vérifier que l'utilisateur est un aidant
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, current_orders, max_orders')
      .eq('user_id', userId)
      .single();

    if (aidantError || !aidant) {
      return res.status(404).json({
        success: false,
        error: 'Aidant non trouvé',
      });
    }

    const current = aidant.current_orders || 0;
    const max = aidant.max_orders || 2;

    if (current >= max) {
      return res.json({
        success: true,
        data: [],
        canTake: false,
        current,
        max,
        message: `Vous avez déjà ${current} commande(s) en cours (maximum ${max})`,
      });
    }

    const { data: orders, error } = await supabase
      .from('commandes')
      .select(`
        *,
        patient:patients(*)
      `)
      .in('status', ['creee', 'en_attente', 'disponible'])
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: orders || [],
      canTake: true,
      current,
      max,
      available: max - current,
    });
  } catch (error) {
    console.error('❌ getAvailableOrders error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des commandes',
    });
  }
});

// ============================================================
// METTRE À JOUR LE STATUT D'UNE COMMANDE (ADMIN)
// ============================================================
const updateOrderStatus = asyncWrapper(async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        error: 'Le statut est obligatoire',
      });
    }

    const validStatuses = Object.values(ORDER_STATUS);
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Statut invalide. Statuts acceptés: ${validStatuses.join(', ')}`,
      });
    }

    const { data: existingOrder, error: checkError } = await supabase
      .from('commandes')
      .select('status, family_id, user_id, aidant_id')
      .eq('id', id)
      .single();

    if (checkError || !existingOrder) {
      return res.status(404).json({
        success: false,
        error: 'Commande non trouvée',
      });
    }

    if (existingOrder.status === ORDER_STATUS.VALIDATED || 
        existingOrder.status === ORDER_STATUS.CANCELLED) {
      return res.status(400).json({
        success: false,
        error: `Impossible de modifier une commande ${existingOrder.status}`,
      });
    }

    const { data: updatedOrder, error: updateError } = await supabase
      .from('commandes')
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    // ✅ Si la commande devient disponible, notifier les aidants
    if (status === ORDER_STATUS.AVAILABLE) {
      const targetDisplay = existingOrder.target_name || 'un client';
      const { data: aidants } = await supabase
        .from('aidants')
        .select('user_id')
        .eq('available', true)
        .eq('is_verified', true);

      if (aidants && aidants.length > 0) {
        for (const aidant of aidants) {
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

    res.json({
      success: true,
      message: `Commande ${status}`,
      order: updatedOrder,
    });
  } catch (error) {
    console.error('❌ updateOrderStatus error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la mise à jour',
    });
  }
});

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  createOrderController,
  takeOrderController,
  deliverOrderController,
  confirmCashPaymentController,  
  autoValidateOrderController,
  getAvailableOrders,
  updateOrderStatus,
};
