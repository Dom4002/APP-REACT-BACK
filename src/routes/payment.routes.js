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
// CONSTANTES
// =============================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(uuid) {
  if (!uuid) return false;
  return UUID_REGEX.test(uuid);
}

// =============================================
// ✅ RÉCUPÉRER L'AIDANT ACTIF
// =============================================
async function getActiveAidantForTarget(targetType, targetId, familyId) {
  try {
    const { data, error } = await supabase.rpc('get_active_aidant_for_target', {
      p_target_type: targetType,
      p_target_id: targetId,
      p_family_id: familyId,
    });

    if (error) {
      console.error('❌ get_active_aidant_for_target error:', error);
      return null;
    }

    if (!data) return null;

    // Vérifier si data est un aidant_id
    const { data: aidantById, error: errorById } = await supabase
      .from('aidants')
      .select('id')
      .eq('id', data)
      .maybeSingle();

    if (!errorById && aidantById) return data;

    // Vérifier si data est un user_id
    const { data: aidantByUser, error: errorByUser } = await supabase
      .from('aidants')
      .select('id')
      .eq('user_id', data)
      .maybeSingle();

    if (!errorByUser && aidantByUser) return aidantByUser.id;

    return null;
  } catch (error) {
    console.error('❌ getActiveAidantForTarget error:', error);
    return null;
  }
}

// =============================================
// ✅ RÉCUPÉRER L'AIDANT_ID DEPUIS UN USER_ID (AVEC CONVERSION)
// =============================================
async function getAidantIdFromUserIdOrId(userIdOrId) {
  // 1. Vérifier si c'est déjà un aidant_id
  const { data: aidantById, error: errorById } = await supabase
    .from('aidants')
    .select('id')
    .eq('id', userIdOrId)
    .maybeSingle();

  if (!errorById && aidantById) {
    return aidantById.id;
  }

  // 2. Vérifier si c'est un user_id
  const { data: aidantByUser, error: errorByUser } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userIdOrId)
    .maybeSingle();

  if (!errorByUser && aidantByUser) {
    return aidantByUser.id;
  }

  return null;
}

// =============================================
// ✅ TRAITER UNE VISITE PONCTUELLE
// =============================================
async function processPonctualVisit(paymentRecord, transactionId, visitId, metadata) {
  try {
    console.log('🔄 Traitement d\'une visite ponctuelle:', visitId);

    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', visitId)
      .single();

    if (visitError) {
      console.error('❌ Visite non trouvée:', visitError.message);
      return null;
    }

    if (visit.status !== 'brouillon') {
      console.log(`ℹ️ La visite ${visitId} n'est pas en brouillon (status: ${visit.status})`);
      return null;
    }

    // ✅ RÉCUPÉRER L'AIDANT ACTIF APRÈS PAIEMENT
    const familyId = visit.user_id;
    const targetType = visit.patient_id ? 'patient' : 'personal_account';
    const targetId = visit.patient_id || visit.user_id;

    let aidantId = visit.aidant_id || null;
    if (!aidantId) {
      const foundId = await getActiveAidantForTarget(targetType, targetId, familyId);
      if (foundId) {
        const convertedId = await getAidantIdFromUserIdOrId(foundId);
        if (convertedId) {
          aidantId = convertedId;
          console.log(`✅ Aidant trouvé après paiement: ${aidantId}`);
        }
      }
    }

    // ✅ CONSTRUIRE L'OBJET DE MISE À JOUR
    const updateData = {
      status: 'planifiee',
      aidant_id: aidantId || null,
      metadata: {
        ...(visit.metadata || {}),
        payment_confirmed_at: new Date().toISOString(),
        transaction_id: transactionId,
        scheduled_from_draft: true,
        payment_completed: true,
        webhook_processed: true,
        webhook_processed_at: new Date().toISOString(),
        aidant_assigned_after_payment: !!aidantId,
      }
    };

    // ✅ Pour les visites personnelles, s'assurer que patient_id est null
    if (visit.target_type === 'personal' || visit.target_type === 'personal_account') {
      updateData.patient_id = null;
    }

    console.log('📤 Mise à jour visite avec:', JSON.stringify(updateData, null, 2));

    const { data: updatedVisit, error: updateError } = await supabase
      .from('visites')
      .update(updateData)
      .eq('id', visitId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Erreur mise à jour visite:', updateError.message);
      return null;
    }

    console.log('✅ Visite passée de brouillon à planifiee:', visitId);

    // ✅ NOTIFICATIONS
    if (updatedVisit.aidant_id) {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('user_id')
        .eq('id', updatedVisit.aidant_id)
        .single();

      if (aidant) {
        await createNotification({
          userId: aidant.user_id,
          title: '📅 Nouvelle visite à valider',
          body: `Visite pour ${updatedVisit.target_name || 'le patient'} le ${updatedVisit.scheduled_date} à ${updatedVisit.scheduled_time}`,
          type: 'visite',
          data: { visit_id: visitId, action: 'approve' },
        });
      }
    }

    const targetDisplay = updatedVisit.target_name || (updatedVisit.patient ? `${updatedVisit.patient.first_name} ${updatedVisit.patient.last_name}` : 'Personnel');

    await createNotification({
      userId: updatedVisit.user_id,
      title: '✅ Visite planifiée !',
      body: `Votre visite pour ${targetDisplay} a été planifiée avec succès après paiement.`,
      type: 'visite',
      data: { visit_id: visitId, status: 'planifiee' },
    });

    return updatedVisit;
  } catch (error) {
    console.error('❌ Erreur processPonctualVisit:', error.message);
    return null;
  }
}

// =============================================
// ✅ CRÉER UNE COMMANDE PONCTUELLE
// =============================================
async function createPonctualOrder(paymentRecord, transactionId, orderData) {
  try {
    const { data: existingOrders, error: checkError } = await supabase
      .from('commandes')
      .select('id')
      .eq('user_id', paymentRecord.user_id)
      .eq('order_type', 'ponctual')
      .eq('is_paid', true)
      .eq('metadata->>transaction_id', transactionId)
      .limit(1);

    if (checkError) {
      console.error('❌ Erreur vérification commande existante:', checkError.message);
    }

    if (existingOrders && existingOrders.length > 0) {
      console.log('ℹ️ Commande déjà créée pour cette transaction:', transactionId);
      return existingOrders[0];
    }

    const orderDataToInsert = orderData || {};

    const targetType = orderDataToInsert.target_type || 'personal';
    const targetName = orderDataToInsert.target_name || 'Commande personnelle';

    if (!orderDataToInsert.description) {
      orderDataToInsert.description = 'Commande ponctuelle';
    }
    if (!orderDataToInsert.address) {
      orderDataToInsert.address = 'Adresse non spécifiée';
    }
    if (!orderDataToInsert.type) {
      orderDataToInsert.type = 'autre';
    }

    const { data: newOrder, error: orderError } = await supabase
      .from('commandes')
      .insert({
        user_id: paymentRecord.user_id,
        patient_id: orderDataToInsert.patient_id || null,
        target_type: targetType,
        target_name: targetName,
        family_id: paymentRecord.user_id,
        type: orderDataToInsert.type,
        description: orderDataToInsert.description,
        address: orderDataToInsert.address,
        status: 'creee',
        estimated_amount: paymentRecord.amount || 0,
        final_amount: paymentRecord.amount || 0,
        items: orderDataToInsert.items || [],
        prescription_url: orderDataToInsert.prescription_url || null,
        order_type: 'ponctual',
        is_paid: true,
        metadata: {
          payment_id: paymentRecord.id,
          transaction_id: transactionId,
          is_ponctual: true,
        },
      })
      .select()
      .single();

    if (orderError) {
      console.error('❌ Erreur création commande:', orderError.message);
      return null;
    }

    console.log('✅ Commande ponctuelle créée:', newOrder.id);

    await createNotification({
      userId: paymentRecord.user_id,
      title: '✅ Commande confirmée !',
      body: `Votre commande "${orderDataToInsert.description}" pour ${targetName} a été enregistrée avec succès.`,
      type: 'commande',
      data: {
        order_id: newOrder.id,
        status: 'creee',
        target_type: targetType,
        target_name: targetName,
      },
    });

    return newOrder;
  } catch (error) {
    console.error('❌ Erreur createPonctualOrder:', error.message);
    return null;
  }
}

// =============================================
// ✅ ACTIVER UN ABONNEMENT
// =============================================
async function activateSubscription(paymentRecord, subscriptionId) {
  try {
    if (!isValidUUID(subscriptionId)) {
      console.error('❌ subscriptionId n\'est pas un UUID valide:', subscriptionId);
      return null;
    }

    const { data: existingSub, error: subCheckError } = await supabase
      .from('abonnements')
      .select('id, status, user_id')
      .eq('id', subscriptionId)
      .single();

    if (subCheckError) {
      console.error('❌ Abonnement non trouvé:', subCheckError.message);
      return null;
    }

    if (existingSub.status === 'actif') {
      console.log('ℹ️ Abonnement déjà actif:', subscriptionId);
      return existingSub;
    }

    const { data: subscription, error: subError } = await supabase
      .from('abonnements')
      .update({
        status: 'actif',
        updated_at: new Date().toISOString(),
      })
      .eq('id', subscriptionId)
      .select()
      .single();

    if (subError) {
      console.error('❌ Erreur activation abonnement:', subError.message);
      return null;
    }

    console.log('✅ Abonnement activé:', subscriptionId);

    await createNotification({
      userId: paymentRecord.user_id,
      title: '✅ Abonnement activé !',
      body: `Votre abonnement est maintenant actif. Profitez de nos services !`,
      type: 'paiement',
      data: {
        subscription_id: subscriptionId,
        status: 'actif',
      },
    });

    return subscription;
  } catch (error) {
    console.error('❌ Erreur activateSubscription:', error.message);
    return null;
  }
}

// =============================================
// CRÉER UN PAIEMENT
// =============================================
router.post('/', async (req, res) => {
  try {
    const { 
      amount, 
      description, 
      method, 
      phone, 
      email, 
      orderId, 
      subscriptionId,
      is_ponctual = false,
      is_visit = false,
      visit_id = null,
      order_data = null,
      patient_id = null,
      target_type = 'personal',
      target_name = null,
      metadata = {},
    } = req.body;
    
    const userId = req.user.id;
    const profile = req.profile;

    console.log('📥 Création paiement:', {
      userId,
      amount,
      is_ponctual,
      is_visit,
      visit_id,
      subscriptionId,
      patient_id,
    });

    // Créer la transaction FedaPay
    const transaction = await createTransaction({
      amount,
      description: description || 'Santé Plus Services',
      email: email || profile.email,
      firstname: profile.full_name.split(' ')[0] || 'Utilisateur',
      lastname: profile.full_name.split(' ').slice(1).join(' ') || 'Client',
      phone: phone || profile.phone,
      userId,
      orderId,
      subscriptionId,
      callback_url: `${process.env.CLIENT_URL}/payment/confirm`,
      cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
      // ✅ Passer les métadonnées complètes
      orderData: order_data || null,
      is_ponctual,
      is_visit,
      visit_id,
      patient_id,
      target_type,
      target_name,
      type: is_visit ? 'visit' : (is_ponctual ? 'order' : 'subscription'),
    });

    // Enregistrer le paiement en base
    const paymentData = {
      user_id: userId,
      amount,
      method: method || 'fedapay',
      reference: transaction.id,
      status: 'en_attente',
      abonnement_id: is_ponctual ? null : (subscriptionId || null),
      metadata: {
        transactionId: transaction.id,
        orderId,
        subscriptionId: is_ponctual ? null : (subscriptionId || null),
        payment_url: transaction.url,
        is_ponctual: is_ponctual || false,
        is_visit: is_visit || false,
        visit_id: visit_id || null,
        order_data: order_data || null,
        patient_id: patient_id || null,
        target_type: target_type || 'personal',
        target_name: target_name || profile.full_name || 'Client',
        type: is_visit ? 'visit' : (is_ponctual ? 'order' : 'subscription'),
        ...metadata,
      },
    };

    const { data: payment, error } = await supabase
      .from('paiements')
      .insert(paymentData)
      .select()
      .single();

    if (error) throw error;

    console.log('✅ Paiement enregistré en base:', payment.id);

    // Notification
    await createNotification({
      userId,
      title: '💳 Paiement initié',
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
    console.error('❌ Create payment error:', error);
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
      console.log('📦 Métadonnées complètes:', JSON.stringify(metadata, null, 2));

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

      console.log('✅ Paiement trouvé:', payment.id, 'Type:', metadata.type);

      // ✅ DÉTERMINER LE TYPE DE TRAITEMENT
      const paymentMetadata = payment.metadata || {};
      const type = paymentMetadata.type || metadata.type || 'subscription';
      const isPonctual = paymentMetadata.is_ponctual || metadata.is_ponctual || false;
      const isVisit = paymentMetadata.is_visit || metadata.is_visit || false;
      const visitId = paymentMetadata.visit_id || metadata.visit_id || null;
      const subscriptionId = paymentMetadata.subscriptionId || metadata.subscriptionId || null;
      const orderData = paymentMetadata.order_data || metadata.order_data || null;

      console.log('📋 Type détecté:', type);
      console.log('📋 isPonctual:', isPonctual);
      console.log('📋 isVisit:', isVisit);
      console.log('📋 visitId:', visitId);
      console.log('📋 subscriptionId:', subscriptionId);

      let result = null;

      // ✅ CAS 1 : VISITE PONCTUELLE
      if (isVisit && visitId) {
        console.log('🔄 Traitement d\'une visite ponctuelle:', visitId);
        result = await processPonctualVisit(payment, transactionId, visitId, paymentMetadata);
        if (result) {
          console.log('✅ Visite ponctuelle traitée avec succès');
        } else {
          console.warn('⚠️ La visite ponctuelle n\'a pas pu être traitée, mais le paiement est validé');
        }
      }

      // ✅ CAS 2 : COMMANDE PONCTUELLE
      else if (isPonctual || type === 'order') {
        console.log('📦 Traitement commande ponctuelle...');
        result = await createPonctualOrder(payment, transactionId, orderData);
        if (result) {
          console.log('✅ Commande ponctuelle traitée avec succès');
        } else {
          console.warn('⚠️ La commande ponctuelle n\'a pas pu être créée, mais le paiement est validé');
        }
      }

      // ✅ CAS 3 : ABONNEMENT
      else if (subscriptionId || type === 'subscription') {
        const subId = subscriptionId || payment.abonnement_id || null;
        console.log('📦 Activation de l\'abonnement:', subId);
        if (subId) {
          result = await activateSubscription(payment, subId);
          if (result) {
            console.log('✅ Abonnement activé avec succès');
          } else {
            console.warn('⚠️ L\'abonnement n\'a pas pu être activé, mais le paiement est validé');
          }
        } else {
          console.warn('⚠️ Aucun abonnement associé à ce paiement');
        }
      }

      // ✅ CAS 4 : FALLBACK - Vérifier les métadonnées
      else {
        console.warn('⚠️ Aucun type spécifique détecté, vérification des métadonnées...');
        
        // Vérifier si c'est une visite
        if (visitId) {
          result = await processPonctualVisit(payment, transactionId, visitId, paymentMetadata);
        }
        // Vérifier si c'est un abonnement
        else if (subscriptionId || payment.abonnement_id) {
          const subId = subscriptionId || payment.abonnement_id;
          result = await activateSubscription(payment, subId);
        }
        // Vérifier si c'est une commande
        else if (orderData) {
          result = await createPonctualOrder(payment, transactionId, orderData);
        }
      }

      // ✅ 5. Mettre à jour le paiement avec le résultat du traitement
      await supabase
        .from('paiements')
        .update({
          metadata: {
            ...(payment.metadata || {}),
            processed: !!result,
            processed_at: new Date().toISOString(),
            processed_type: type,
          }
        })
        .eq('id', payment.id);

      // ✅ 6. Notification de paiement confirmé (si pas déjà envoyée)
      let notificationTitle = '✅ Paiement confirmé';
      let notificationBody = `Votre paiement de ${payment.amount} FCFA a été confirmé.`;

      if (isVisit && result) {
        notificationTitle = '✅ Visite planifiée !';
        notificationBody = `Votre visite a été planifiée avec succès après paiement.`;
      } else if (isPonctual && result) {
        notificationTitle = '✅ Commande confirmée !';
        notificationBody = `Votre commande a été enregistrée avec succès après paiement.`;
      } else if (subscriptionId && result) {
        notificationTitle = '✅ Abonnement activé !';
        notificationBody = `Votre abonnement est maintenant actif.`;
      }

      await createNotification({
        userId: payment.user_id,
        title: notificationTitle,
        body: notificationBody,
        type: 'paiement',
        data: {
          payment_id: payment.id,
          type: type,
          processed: !!result,
        },
      });

      console.log('✅ Webhook traité avec succès');
      return res.json({ success: true, type, processed: !!result });

    } else if (event === 'transaction.canceled') {
      console.log('⚠️ Transaction annulée:', data?.id);
      return res.json({ success: true, event });
    }

    // Autres événements
    console.log('ℹ️ Événement ignoré:', event);
    return res.json({ success: true, event });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Route webhook (sans auth middleware)
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
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
        total_visits: offre.total_visits || 0,
        remaining_visits: offre.total_visits || 0,
        total_orders: offre.total_orders || 0,
        remaining_orders: offre.total_orders || 0,
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
      type: 'subscription',
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
          type: 'subscription',
        },
      });

    // Notification
    await createNotification({
      userId,
      title: '⏳ Abonnement en attente',
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
    console.error('❌ Subscribe error:', error);
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
      title: '❌ Abonnement annulé',
      body: 'Votre abonnement a été annulé avec succès',
      type: 'paiement',
      data: { subscription_id: data.id },
    });

    res.json({ success: true, subscription: data });
  } catch (error) {
    console.error('❌ Cancel subscription error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Exporter le handler webhook pour une utilisation dans server.js
module.exports = router;
module.exports.handleWebhook = handleWebhook;
