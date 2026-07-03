// 📁 backend/src/controllers/payment.controller.js

const { supabase } = require('../services/supabase.service');
const { asyncWrapper, NotFoundError } = require('../utils/errorHandler');
const { createTransaction, getTransaction } = require('../services/payment.service');
const { createNotification } = require('../services/notification.service');

// ============================================================
// CRÉER UN PAIEMENT
// ============================================================
const createPayment = asyncWrapper(async (req, res) => {
  const userId = req.user.id;
  const {
    plan_id,
    abonnement_id,
    montant,
    amount,
    description,
    email_client,
    customer_email,
    customer_name,
    is_ponctual = false,
    order_data = null,
    patient_id = null,
    target_type = 'personal',
    target_name = null,
  } = req.body;

  const finalAmount = amount || montant || 0;

  if (finalAmount <= 0) {
    return res.status(400).json({
      success: false,
      error: 'Montant invalide',
    });
  }

  // ✅ Créer la transaction FedaPay
  const transaction = await createTransaction({
    amount: finalAmount,
    description: description || 'Paiement Santé Plus',
    email: email_client || customer_email || req.user.email,
    firstname: customer_name?.split(' ')[0] || 'Client',
    lastname: customer_name?.split(' ').slice(1).join(' ') || 'Santé Plus',
    phone: req.profile?.phone || '',
    userId,
    orderId: order_data?.order_id || null,
    subscriptionId: abonnement_id || null,
    orderData: order_data || null,
    callback_url: `${process.env.CLIENT_URL}/payment/confirm`,
    cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
  });

  // ✅ Enregistrer le paiement en base
  const { data: payment, error } = await supabase
    .from('paiements')
    .insert({
      user_id: userId,
      amount: finalAmount,
      method: 'fedapay',
      reference: transaction.id,
      status: 'en_attente',
      abonnement_id: is_ponctual ? null : (abonnement_id || plan_id || null),
      metadata: {
        description,
        plan_id: plan_id || null,
        transaction_id: transaction.id,
        payment_url: transaction.payment_url || transaction.url,
        is_ponctual,
        order_data: order_data || null,
        patient_id,
        target_type,
        target_name: target_name || null,
      },
    })
    .select()
    .single();

  if (error) {
    console.error('❌ Erreur sauvegarde paiement:', error);
  }

  // ✅ Notifier l'utilisateur
  await createNotification({
    userId,
    title: '💳 Paiement en cours',
    body: `Votre paiement de ${finalAmount} FCFA est en cours de traitement.`,
    type: 'paiement',
    data: { transaction_id: transaction.id, status: 'pending' },
  });

  res.json({
    success: true,
    payment_url: transaction.payment_url || transaction.url,
    transaction_id: transaction.id,
    reference: transaction.id,
    payment,
  });
});

// ============================================================
// VÉRIFIER UN PAIEMENT
// ============================================================
const verifyPayment = asyncWrapper(async (req, res) => {
  const { transaction_id } = req.params;

  const transaction = await getTransaction(transaction_id);

  const status = transaction.status || 'pending';
  const isSuccessful = ['approved', 'paid', 'success'].includes(status);

  // ✅ Mettre à jour le paiement en base
  const { data: payment, error } = await supabase
    .from('paiements')
    .update({
      status: isSuccessful ? 'valide' : 'echoue',
      paid_at: isSuccessful ? new Date().toISOString() : null,
      metadata: {
        ...(transaction.metadata || {}),
        fedapay_status: status,
        verified_at: new Date().toISOString(),
      },
    })
    .eq('reference', transaction_id)
    .select()
    .single();

  if (error) {
    console.error('❌ Erreur mise à jour paiement:', error);
  }

  // ✅ Si paiement réussi, activer l'abonnement
  if (isSuccessful && payment?.abonnement_id) {
    await supabase
      .from('abonnements')
      .update({ status: 'actif' })
      .eq('id', payment.abonnement_id);

    await createNotification({
      userId: payment.user_id,
      title: '✅ Abonnement activé',
      body: 'Votre abonnement est maintenant actif.',
      type: 'paiement',
      data: { subscription_id: payment.abonnement_id },
    });
  }

  res.json({
    success: true,
    status,
    is_successful: isSuccessful,
    payment,
  });
});

// ============================================================
// RÉCUPÉRER L'HISTORIQUE DES PAIEMENTS
// ============================================================
const getPaymentHistory = asyncWrapper(async (req, res) => {
  const userId = req.user.id;

  const { data, error } = await supabase
    .from('paiements')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  res.json({ success: true, data: data || [] });
});

// ============================================================
// RÉCUPÉRER LES ABONNEMENTS
// ============================================================
const getSubscriptions = asyncWrapper(async (req, res) => {
  const userId = req.user.id;

  const { data, error } = await supabase
    .from('abonnements')
    .select(`
      *,
      offre:offres(*)
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  res.json({ success: true, data: data || [] });
});

// ============================================================
// SOUSCRIRE À UN ABONNEMENT
// ============================================================
const subscribe = asyncWrapper(async (req, res) => {
  const userId = req.user.id;
  const { offre_id, patient_id = null, start_date = null, end_date = null } = req.body;

  if (!offre_id) {
    return res.status(400).json({
      success: false,
      error: 'offre_id est requis',
    });
  }

  // ✅ Récupérer l'offre
  const { data: offre, error: offreError } = await supabase
    .from('offres')
    .select('*')
    .eq('id', offre_id)
    .single();

  if (offreError || !offre) {
    throw new NotFoundError('Offre');
  }

  const start = start_date ? new Date(start_date) : new Date();
  const duration = offre.duration_days || 30;
  const end = end_date ? new Date(end_date) : new Date(start);
  end.setDate(end.getDate() + duration);

  const { data: subscription, error } = await supabase
    .from('abonnements')
    .insert({
      user_id: userId,
      patient_id: patient_id || null,
      offre_id,
      status: 'en_attente',
      start_date: start.toISOString().split('T')[0],
      end_date: end.toISOString().split('T')[0],
      auto_renew: true,
      total_visits: offre.total_visits || 0,
      remaining_visits: offre.total_visits || 0,
      total_orders: offre.total_orders || 0,
      remaining_orders: offre.total_orders || 0,
    })
    .select(`
      *,
      offre:offres(*)
    `)
    .single();

  if (error) throw error;

  res.status(201).json({
    success: true,
    message: 'Abonnement créé, en attente de paiement',
    data: subscription,
  });
});

// ============================================================
// ANNULER UN ABONNEMENT
// ============================================================
const cancelSubscription = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const { data, error } = await supabase
    .from('abonnements')
    .update({
      status: 'annule',
      cancellation_date: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select(`
      *,
      offre:offres(*)
    `)
    .single();

  if (error) throw error;

  res.json({
    success: true,
    message: 'Abonnement annulé',
    data,
  });
});

// ============================================================
// WEBHOOK FEDAPAY
// ============================================================
const webhook = asyncWrapper(async (req, res) => {
  console.log('📥 Webhook FedaPay reçu:', req.body);

  const { transaction, status } = req.body;

  if (!transaction || !transaction.id) {
    return res.status(400).json({ error: 'Données invalides' });
  }

  const isSuccessful = ['approved', 'paid', 'success'].includes(status);

  // ✅ Mettre à jour le paiement
  const { data: payment, error } = await supabase
    .from('paiements')
    .update({
      status: isSuccessful ? 'valide' : 'echoue',
      paid_at: isSuccessful ? new Date().toISOString() : null,
      provider_reference: transaction.id,
      metadata: {
        webhook_status: status,
        webhook_received_at: new Date().toISOString(),
      },
    })
    .eq('reference', transaction.id)
    .select()
    .single();

  if (error) {
    console.error('❌ Erreur webhook:', error);
    return res.status(500).json({ error: error.message });
  }

  // ✅ Si paiement réussi, activer l'abonnement
  if (isSuccessful && payment?.abonnement_id) {
    await supabase
      .from('abonnements')
      .update({ status: 'actif' })
      .eq('id', payment.abonnement_id);

    await createNotification({
      userId: payment.user_id,
      title: '✅ Paiement confirmé',
      body: 'Votre paiement a été confirmé avec succès.',
      type: 'paiement',
      data: { transaction_id: transaction.id },
    });
  }

  res.json({ success: true });
});

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  createPayment,
  verifyPayment,
  getPaymentHistory,
  getSubscriptions,
  subscribe,
  cancelSubscription,
  webhook,
};
