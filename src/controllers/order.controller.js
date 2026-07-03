// 📁 backend/src/controllers/order.controller.js

const { supabase } = require('../services/supabase.service');
const { asyncWrapper, NotFoundError } = require('../utils/errorHandler');
const { createNotification } = require('../services/notification.service');

// ============================================================
// RÉCUPÉRER TOUTES LES COMMANDES
// ============================================================
const getOrders = asyncWrapper(async (req, res) => {
  const userId = req.user.id;
  const userRole = req.profile?.role;

  let query = supabase.from('commandes').select('*');

  if (userRole === 'family') {
    query = query.eq('user_id', userId);
  } else if (userRole === 'aidant') {
    const { data: aidant } = await supabase
      .from('aidants')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (aidant) {
      query = query.eq('aidant_id', aidant.id);
    } else {
      return res.json({ success: true, data: [], count: 0 });
    }
  }

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;

  res.json({ success: true, data: data || [], count: data?.length || 0 });
});

// ============================================================
// RÉCUPÉRER UNE COMMANDE PAR ID
// ============================================================
const getOrderById = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const userRole = req.profile?.role;

  const { data: order, error } = await supabase
    .from('commandes')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !order) {
    throw new NotFoundError('Commande');
  }

  // ✅ Vérifier l'accès
  let hasAccess = ['admin', 'coordinator'].includes(userRole);

  if (!hasAccess && userRole === 'family') {
    hasAccess = order.user_id === userId;
  }

  if (!hasAccess && userRole === 'aidant') {
    const { data: aidant } = await supabase
      .from('aidants')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (aidant) {
      hasAccess = order.aidant_id === aidant.id;
    }
  }

  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      error: 'Accès non autorisé',
    });
  }

  res.json({ success: true, data: order });
});

// ============================================================
// CRÉER UNE COMMANDE
// ============================================================
const createOrder = asyncWrapper(async (req, res) => {
  const userId = req.user.id;
  const userRole = req.profile?.role;

  if (userRole === 'aidant') {
    return res.status(403).json({
      success: false,
      error: 'Les aidants ne peuvent pas créer de commandes',
    });
  }

  const {
    patient_id = null,
    target_type = patient_id ? 'patient' : 'personal',
    target_name = null,
    type,
    description,
    address,
    items = [],
    prescription_url = null,
    estimated_amount = null,
    order_type = 'subscription',
    is_paid = false,
  } = req.body;

  // ✅ Déterminer le statut
  let status = 'creee';
  const isPonctual = order_type === 'ponctual';

  if (isPonctual && !is_paid) {
    status = 'attente_paiement';
  } else if (!isPonctual) {
    const { data: subscription } = await supabase
      .from('abonnements')
      .select('id, remaining_orders')
      .eq('user_id', userId)
      .eq('status', 'actif')
      .maybeSingle();

    if (!subscription || subscription.remaining_orders <= 0) {
      status = 'attente_paiement';
    }
  }

  const orderData = {
    user_id: userId,
    patient_id: patient_id || null,
    target_type: target_type || 'personal',
    target_name: target_name || null,
    family_id: userId,
    type: type || 'autre',
    description: description || 'Commande',
    address: address || 'Adresse non spécifiée',
    status,
    estimated_amount: estimated_amount || null,
    items: items || [],
    prescription_url: prescription_url || null,
    order_type: order_type || 'subscription',
    is_paid: is_paid || false,
    is_ponctual: isPonctual || false,
  };

  const { data: order, error } = await supabase
    .from('commandes')
    .insert(orderData)
    .select()
    .single();

  if (error) throw error;

  // ✅ Si commande disponible, notifier les aidants
  if (status === 'creee' || status === 'en_attente') {
    const { data: aidants } = await supabase
      .from('aidants')
      .select('user_id')
      .eq('available', true)
      .eq('is_verified', true);

    if (aidants) {
      for (const aidant of aidants) {
        await createNotification({
          userId: aidant.user_id,
          title: '🛒 Nouvelle commande disponible',
          body: `Commande : ${description}`,
          type: 'commande',
          data: { order_id: order.id, action: 'take' },
        });
      }
    }
  }

  res.status(201).json({
    success: true,
    message: 'Commande créée avec succès',
    data: order,
    requires_payment: status === 'attente_paiement',
  });
});

// ============================================================
// METTRE À JOUR UNE COMMANDE
// ============================================================
const updateOrder = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userRole = req.profile?.role;

  if (!['admin', 'coordinator'].includes(userRole)) {
    return res.status(403).json({
      success: false,
      error: 'Non autorisé',
    });
  }

  const { data, error } = await supabase
    .from('commandes')
    .update({
      ...req.body,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  res.json({ success: true, data });
});

// ============================================================
// PRENDRE UNE COMMANDE
// ============================================================
const takeOrder = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const { data: order, error: fetchError } = await supabase
    .from('commandes')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !order) {
    throw new NotFoundError('Commande');
  }

  if (!['creee', 'en_attente', 'disponible'].includes(order.status)) {
    return res.status(400).json({
      success: false,
      error: 'Cette commande n\'est pas disponible',
    });
  }

  const { data: aidant, error: aidantError } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (aidantError || !aidant) {
    return res.status(403).json({
      success: false,
      error: 'Vous n\'êtes pas un aidant',
    });
  }

  const { data, error } = await supabase
    .from('commandes')
    .update({
      status: 'en_cours',
      aidant_id: aidant.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  await createNotification({
    userId: order.user_id,
    title: '✅ Commande prise en charge',
    body: 'Un aidant a pris votre commande en charge.',
    type: 'commande',
    data: { order_id: id },
  });

  res.json({ success: true, data });
});

// ============================================================
// LIVRER UNE COMMANDE
// ============================================================
const deliverOrder = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const { proof_url } = req.body;
  const userId = req.user.id;

  const { data: order, error: fetchError } = await supabase
    .from('commandes')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !order) {
    throw new NotFoundError('Commande');
  }

  if (order.status !== 'en_cours') {
    return res.status(400).json({
      success: false,
      error: 'Cette commande n\'est pas en cours',
    });
  }

  const { data: aidant } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!aidant || order.aidant_id !== aidant.id) {
    return res.status(403).json({
      success: false,
      error: 'Vous n\'êtes pas l\'aidant assigné',
    });
  }

  const updateData = {
    status: 'livree',
    updated_at: new Date().toISOString(),
  };

  if (proof_url) {
    updateData.proof_url = proof_url;
  }

  const { data, error } = await supabase
    .from('commandes')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  res.json({ success: true, data });
});

// ============================================================
// VALIDER UNE COMMANDE (admin)
// ============================================================
const validateOrder = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userRole = req.profile?.role;

  if (!['admin', 'coordinator'].includes(userRole)) {
    return res.status(403).json({
      success: false,
      error: 'Non autorisé',
    });
  }

  const { data, error } = await supabase
    .from('commandes')
    .update({
      status: 'validee',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  res.json({ success: true, data });
});

// ============================================================
// ANNULER UNE COMMANDE
// ============================================================
const cancelOrder = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userRole = req.profile?.role;

  if (!['admin', 'coordinator'].includes(userRole)) {
    return res.status(403).json({
      success: false,
      error: 'Non autorisé',
    });
  }

  const { data, error } = await supabase
    .from('commandes')
    .update({
      status: 'annulee',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  res.json({ success: true, data });
});

// ============================================================
// CONFIRMER PAIEMENT D'UNE COMMANDE
// ============================================================
const confirmPayment = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const { transaction_id } = req.body;

  const { data: order, error } = await supabase
    .from('commandes')
    .update({
      status: 'creee',
      is_paid: true,
      updated_at: new Date().toISOString(),
      metadata: {
        payment_confirmed_at: new Date().toISOString(),
        transaction_id,
      },
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  res.json({
    success: true,
    message: 'Paiement confirmé',
    data: order,
  });
});

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getOrders,
  getOrderById,
  createOrder,
  updateOrder,
  takeOrder,
  deliverOrder,
  validateOrder,
  cancelOrder,
  confirmPayment,
};
