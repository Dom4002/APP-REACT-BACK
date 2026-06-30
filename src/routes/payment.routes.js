// 📁 backend/src/routes/payment.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const { createTransaction, getTransaction } = require('../services/payment.service');
const { createNotification } = require('../services/notification.service');
const authMiddleware = require('../middleware/auth.middleware');

// Toutes les routes protégées (sauf webhook)
router.use(authMiddleware);

// =============================================
// CRÉER UN PAIEMENT
// =============================================
router.post('/', async (req, res) => {
  try {
    const { amount, description, method, phone, email, orderId, subscriptionId } = req.body;
    const userId = req.user.id;
    const profile = req.profile;

    // Créer la transaction FedaPay
    const transaction = await createTransaction({
      amount,
      description,
      email: email || profile.email,
      firstname: profile.full_name.split(' ')[0] || 'Utilisateur',
      lastname: profile.full_name.split(' ').slice(1).join(' ') || 'Client',
      phone: phone || profile.phone,
      userId,
      orderId,
      subscriptionId,
      callback_url: `${process.env.CLIENT_URL}/payment/confirm`,
      cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
    });

    // Enregistrer le paiement en base
    const { data: payment, error } = await supabase
      .from('paiements')
      .insert({
        user_id: userId,
        amount,
        method,
        reference: transaction.id,
        status: 'en_attente',
        metadata: {
          transactionId: transaction.id,
          orderId,
          subscriptionId,
          payment_url: transaction.url,
        },
      })
      .select()
      .single();

    if (error) throw error;

    // Notification
    await createNotification({
      userId,
      title: 'Paiement initié',
      body: `Votre paiement de ${amount} FCFA a été initié`,
      type: 'paiement',
      data: { payment_id: payment.id },
    });

    res.json({
      success: true,
      payment,
      payment_url: transaction.url,
      transaction_id: transaction.id,
    });
  } catch (error) {
    console.error('Create payment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// WEBHOOK - CONFIRMER UN PAIEMENT (SANS AUTH)
// =============================================
const handleWebhook = async (req, res) => {
  try {
    const { event, data } = req.body;

    console.log('📥 Webhook FedaPay reçu:', event, data?.id);

    if (event === 'transaction.paid') {
      const transactionId = data.id;
      const metadata = data.metadata || {};

      console.log('💰 Transaction payée:', transactionId);
      console.log('📦 Métadonnées:', metadata);

      // 1. Récupérer le paiement en base
      const { data: payment, error } = await supabase
        .from('paiements')
        .update({
          status: 'valide',
          paid_at: new Date().toISOString(),
          provider_reference: transactionId,
        })
        .eq('reference', transactionId)
        .select()
        .single();

      if (error) {
        console.error('❌ Erreur mise à jour paiement:', error);
        return res.status(500).json({ error: error.message });
      }

      if (!payment) {
        console.warn('⚠️ Paiement non trouvé pour transaction:', transactionId);
        return res.status(404).json({ error: 'Paiement non trouvé' });
      }

      // 2. ✅ CRÉER LA COMMANDE SI C'EST UNE COMMANDE PONCTUELLE
      const isPonctual = payment.metadata?.is_ponctual || metadata?.is_ponctual || false;

      if (isPonctual) {
        console.log('📦 Création de la commande ponctuelle via webhook...');

        // Récupérer les données de commande depuis les métadonnées
        const orderData = payment.metadata?.order_data || metadata?.order_data || {};

        // Vérifier si la commande existe déjà (éviter les doublons)
        const { data: existingOrders, error: checkError } = await supabase
          .from('commandes')
          .select('id')
          .eq('family_id', payment.user_id)
          .eq('description', orderData.description || 'Commande ponctuelle')
          .eq('order_type', 'ponctual')
          .eq('is_paid', true)
          .order('created_at', { ascending: false })
          .limit(1);

        if (checkError) {
          console.warn('⚠️ Erreur vérification commande existante:', checkError);
        }

        // Si une commande existe déjà, on ne la recrée pas
        if (existingOrders && existingOrders.length > 0) {
          console.log('ℹ️ Commande déjà créée, skip...');
        } else {
          // Créer la commande
          const { data: order, error: orderError } = await supabase
            .from('commandes')
            .insert({
              patient_id: orderData.patient_id || null,
              family_id: payment.user_id,
              type: orderData.type || 'autre',
              description: orderData.description || 'Commande ponctuelle',
              address: orderData.address || 'Adresse non spécifiée',
              status: 'creee',
              estimated_amount: payment.amount,
              final_amount: payment.amount,
              items: orderData.items || [],
              prescription_url: orderData.prescription_url || null,
              order_type: 'ponctual',
              is_paid: true,
              metadata: {
                payment_id: payment.id,
                transaction_id: transactionId,
                is_ponctual: true,
              },
            })
            .select()
            .single();

          if (orderError) {
            console.error('❌ Erreur création commande:', orderError);
          } else {
            console.log('✅ Commande ponctuelle créée:', order.id);

            // Notification à la famille
            await createNotification({
              userId: payment.user_id,
              title: '✅ Commande créée',
              body: `Votre commande ponctuelle a été créée avec succès après paiement.`,
              type: 'commande',
              data: { order_id: order.id },
            });
          }
        }
      }

      // 3. Si c'est un abonnement, l'activer
      const subscriptionId = payment.metadata?.subscriptionId || metadata?.subscriptionId;
      if (subscriptionId) {
        await supabase
          .from('abonnements')
          .update({ status: 'actif' })
          .eq('id', subscriptionId);
      }

      // 4. Notification de paiement confirmé
      await createNotification({
        userId: payment.user_id,
        title: '✅ Paiement confirmé',
        body: `Votre paiement de ${payment.amount} FCFA a été confirmé.`,
        type: 'paiement',
        data: { payment_id: payment.id },
      });

      return res.json({ success: true });
    }

    // Autres événements
    return res.json({ success: true, event });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Route webhook (sans auth middleware)
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  // Le body est déjà parsé par express.raw
  handleWebhook(req, res);
});

// =============================================
// STATUT D'UN PAIEMENT
// =============================================
router.get('/:reference', async (req, res) => {
  try {
    const { reference } = req.params;

    const { data, error } = await supabase
      .from('paiements')
      .select('*')
      .eq('reference', reference)
      .single();

    if (error) throw error;

    // Vérifier le statut en temps réel avec FedaPay
    const transaction = await getTransaction(reference);
    if (transaction && transaction.status === 'paid' && data.status !== 'valide') {
      await supabase
        .from('paiements')
        .update({ status: 'valide', paid_at: new Date().toISOString() })
        .eq('id', data.id);
      
      data.status = 'valide';
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// HISTORIQUE DES PAIEMENTS
// =============================================
router.get('/history', async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('paiements')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ABONNEMENTS DE L'UTILISATEUR
// =============================================
router.get('/subscriptions', async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('abonnements')
      .select(`
        *,
        offre:offres(*),
        patient:patients(*)
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// SOUSCRIRE À UNE OFFRE
// =============================================
router.post('/subscribe', async (req, res) => {
  try {
    const { offreId, patientId } = req.body;
    const userId = req.user.id;

    // Récupérer l'offre
    const { data: offre, error: offreError } = await supabase
      .from('offres')
      .select('*')
      .eq('id', offreId)
      .single();

    if (offreError) throw offreError;

    // Calculer la date de fin
    const startDate = new Date();
    const endDate = new Date();
    
    switch (offre.type) {
      case 'mensuelle':
        endDate.setMonth(endDate.getMonth() + 1);
        break;
      case 'trimestrielle':
        endDate.setMonth(endDate.getMonth() + 3);
        break;
      case 'annuelle':
        endDate.setFullYear(endDate.getFullYear() + 1);
        break;
      default:
        endDate.setMonth(endDate.getMonth() + 1);
    }

    // Créer l'abonnement
    const { data: subscription, error } = await supabase
      .from('abonnements')
      .insert({
        user_id: userId,
        patient_id: patientId || null,
        offre_id: offreId,
        status: 'en_attente',
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        auto_renew: true,
      })
      .select()
      .single();

    if (error) throw error;

    // Créer le paiement
    const transaction = await createTransaction({
      amount: offre.price,
      description: `Abonnement ${offre.name}`,
      email: req.profile.email,
      firstname: req.profile.full_name.split(' ')[0],
      lastname: req.profile.full_name.split(' ').slice(1).join(' ') || 'Client',
      phone: req.profile.phone,
      userId,
      subscriptionId: subscription.id,
    });

    // Enregistrer le paiement
    await supabase
      .from('paiements')
      .insert({
        user_id: userId,
        abonnement_id: subscription.id,
        amount: offre.price,
        method: 'mobile_money',
        reference: transaction.id,
        status: 'en_attente',
        metadata: {
          transactionId: transaction.id,
          subscriptionId: subscription.id,
          payment_url: transaction.url,
        },
      });

    // Notification
    await createNotification({
      userId,
      title: 'Abonnement en attente',
      body: `Votre abonnement ${offre.name} est en attente de paiement`,
      type: 'paiement',
      data: { subscription_id: subscription.id },
    });

    res.json({
      success: true,
      subscription,
      payment_url: transaction.url,
    });
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ANNULER UN ABONNEMENT
// =============================================
router.post('/subscriptions/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('abonnements')
      .update({ status: 'annule' })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;

    await createNotification({
      userId,
      title: 'Abonnement annulé',
      body: 'Votre abonnement a été annulé avec succès',
      type: 'paiement',
      data: { subscription_id: data.id },
    });

    res.json({ success: true, subscription: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Exporter le handler webhook pour une utilisation dans server.js
module.exports = router;
module.exports.handleWebhook = handleWebhook;