// 📁 backend/src/routes/billing.js
 
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { FedaPay, Transaction } = require('fedapay');

const router = express.Router();

// ============================================================
// CONSTANTES ET CONFIGURATION
// ============================================================
const MAX_RETRY_ATTEMPTS = 8;
const RETRY_DELAY_MS = 1500;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ✅ PRIX DES VISITES PONCTUELLES - SOURCE UNIQUE
const VISIT_PONCTUAL_PRICES = {
  '30': 5000,
  '45': 6000,
  '60': 7500,
  '90': 10000,
  '120': 12500,
};

const DEFAULT_VISIT_PRICE = 7500;

function getPonctualPrice(durationMinutes = 60) {
  const price = VISIT_PONCTUAL_PRICES[durationMinutes.toString()];
  if (price) return price;
  return Math.round((durationMinutes / 60) * DEFAULT_VISIT_PRICE);
}

// ============================================================
// SUPABASE BACKEND CLIENT
// ============================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// FEDAPAY CONFIG
// ============================================================
const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY?.trim();
const FEDAPAY_ENV = (process.env.FEDAPAY_ENV || 'live').trim().toLowerCase();

if (!FEDAPAY_SECRET_KEY) {
  console.error('❌ FEDAPAY_SECRET_KEY manquant dans les variables d\'environnement');
}

console.log('💳 FEDAPAY_ENV:', FEDAPAY_ENV);

// ============================================================
// HEALTH ROUTE
// ============================================================
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'Billing API',
    fedapay_env: FEDAPAY_ENV,
    fedapay_key_loaded: !!FEDAPAY_SECRET_KEY,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// 🔧 FONCTIONS HELPER
// ============================================================

async function findPaymentWithRetry(transactionId) {
  let payment = null;
  let attempts = 0;

  while (attempts < MAX_RETRY_ATTEMPTS && !payment) {
    attempts++;

    if (attempts > 1) {
      console.log(`⏳ Tentative ${attempts}/${MAX_RETRY_ATTEMPTS} - Attente ${RETRY_DELAY_MS}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }

    try {
      const { data, error } = await supabase
        .from('paiements')
        .select('*')
        .eq('reference', transactionId)
        .maybeSingle();

      if (error) {
        console.error(`❌ Erreur recherche paiement (tentative ${attempts}):`, error.message);
        continue;
      }

      if (data) {
        payment = data;
        console.log(`✅ Paiement trouvé après ${attempts} tentative(s):`, payment.id);
        break;
      }
    } catch (err) {
      console.error(`❌ Exception recherche paiement (tentative ${attempts}):`, err.message);
    }
  }

  return payment;
}

function isValidUUID(uuid) {
  if (!uuid) return false;
  return UUID_REGEX.test(uuid);
}

// ============================================================
// ✅ RÉCUPÉRER L'AIDANT ACTIF
// ============================================================
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

    if (!data) {
      return null;
    }

    const { data: aidantById, error: errorById } = await supabase
      .from('aidants')
      .select('id')
      .eq('id', data)
      .maybeSingle();

    if (!errorById && aidantById) {
      return data;
    }

    const { data: aidantByUser, error: errorByUser } = await supabase
      .from('aidants')
      .select('id')
      .eq('user_id', data)
      .maybeSingle();

    if (!errorByUser && aidantByUser) {
      return aidantByUser.id;
    }

    return null;
  } catch (error) {
    console.error('❌ getActiveAidantForTarget error:', error);
    return null;
  }
}

// ============================================================
// ✅ CRÉER UN ABONNEMENT EN ATTENTE
// ============================================================
async function createPendingSubscription(userId, offerId, offer, patientId = null) {
  try {
    const startDate = new Date();
    const endDate = new Date();

    switch (offer.type) {
      case 'trimestrielle':
        endDate.setMonth(endDate.getMonth() + 3);
        break;
      case 'annuelle':
        endDate.setFullYear(endDate.getFullYear() + 1);
        break;
      case 'mensuelle':
      default:
        endDate.setMonth(endDate.getMonth() + 1);
        break;
    }

    const totalVisits = offer.total_visits || 0;
    const totalOrders = offer.total_orders || 0;

    console.log('📝 Création abonnement pour user_id:', userId);

    const subscriptionData = {
      user_id: userId,
      offre_id: offer.id,
      status: 'en_attente',
      start_date: startDate.toISOString().split('T')[0],
      end_date: endDate.toISOString().split('T')[0],
      auto_renew: true,
      total_visits: totalVisits,
      used_visits: 0,        
      remaining_visits: totalVisits, 
      total_orders: totalOrders,
      used_orders: 0,       
      remaining_orders: totalOrders,  
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (patientId) {
      subscriptionData.patient_id = patientId;
      console.log('✅ patient_id ajouté:', patientId);
    }

    const { data: subscription, error } = await supabase
      .from('abonnements')
      .insert(subscriptionData)
      .select()
      .single();

    if (error) {
      console.error('❌ Erreur création abonnement:', error.message);
      return null;
    }

    console.log('✅ Abonnement créé (en attente):', subscription.id);
    return subscription;

  } catch (error) {
    console.error('❌ Erreur createPendingSubscription:', error.message);
    return null;
  }
}

// ============================================================
// ✅ CRÉER UNE COMMANDE PONCTUELLE EN ARRIÈRE-PLAN
// ============================================================
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
      return null;
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

    // 1️⃣ NOTIFICATION À LA FAMILLE
    await supabase.from('notifications').insert({
      user_id: paymentRecord.user_id,
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

    // 2️⃣ ✅ CORRECTIF : NOTIFIER TOUS LES AIDANTS DISPONIBLES ET SOUS LEUR QUOTA !
    const { data: aidants } = await supabase
      .from('aidants')
      .select('user_id, current_orders, max_orders')
      .eq('available', true)
      .eq('is_verified', true)
      .eq('status', 'approved');

    if (aidants && aidants.length > 0) {
      // Filtrer les aidants qui ont de la place
      const availableAidants = aidants.filter(
        a => (a.current_orders || 0) < (a.max_orders || 2)
      );

      if (availableAidants.length > 0) {
        for (const aidant of availableAidants) {
          await supabase.from('notifications').insert({
            user_id: aidant.user_id, // ✅ Vrai ID de profil
            title: '🛒 Nouvelle commande disponible',
            body: `Commande de ${targetName} — ${orderDataToInsert.description}`,
            type: 'commande',
            data: { 
              order_id: newOrder.id, 
              action: 'take' 
            },
          });
        }
        console.log(`📡 [Webhook] ${availableAidants.length} aidants disponibles notifiés pour la commande ${newOrder.id}`);
      } else {
        console.log('ℹ️ Aucun aidant disponible (quotas maximum atteints)');
      }
    }

    return newOrder;

  } catch (error) {
    console.error('❌ Erreur createPonctualOrder:', error.message);
    return null;
  }
}

// ============================================================
// ✅ TRAITER UNE VISITE PONCTUELLE
// ============================================================
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

    const familyId = visit.user_id;
    const targetType = visit.patient_id ? 'patient' : 'personal_account';
    const targetId = visit.patient_id || visit.user_id;

    let aidantId = visit.aidant_id || visit.metadata?.selected_aidant || null;
    if (!aidantId) {
      aidantId = await getActiveAidantForTarget(targetType, targetId, familyId);
      console.log(`✅ Aidant trouvé après paiement: ${aidantId}`);
    }

    const updateData = {
      status: 'planifiee',
      aidant_id: aidantId || null,
      metadata: {
        ...(visit.metadata || {}),
        payment_confirmed_at: new Date().toISOString(),
        transaction_id: transaction_id,
        scheduled_from_draft: true,
        payment_completed: true,
        aidant_assigned_after_payment: !!aidantId,
        selected_aidant: null,
        wizard_choice: null,
      }
    };

    if (visit.target_type === 'personal') {
      delete (updateData as any).patient_id;
    }

    const { data, error } = await supabase
      .from('visites')
      .update(updateData)
      .eq('id', id)
      .select(`
        *,
        patient:patients(*),
        aidant:aidants!visites_aidant_id_fkey (
          id,
          user_id,
          user:profiles!aidants_user_id_fkey (id, full_name)
        )
      `)
      .single();

    if (error) throw error;

    const targetDisplay = data.target_name || (data.patient ? `${data.patient.first_name} ${data.patient.last_name}` : 'Personnel');

    // 1️⃣ NOTIFICATION À L'AIDANT ASSIGNÉ
    if (aidantId && data.aidant?.user?.id) {
      await supabase.from('notifications').insert({
        user_id: data.aidant.user.id, // ✅ ID utilisateur (profiles.id) à la place de l'aidant_id
        title: '📅 Nouvelle visite à valider',
        body: `Visite pour ${targetDisplay} le ${data.scheduled_date} à ${data.scheduled_time}`,
        type: 'visite',
        data: { visit_id: visitId, action: 'approve' },
      });
    }

    // 2️⃣ NOTIFICATION À LA FAMILLE
    await supabase.from('notifications').insert({
      user_id: data.user_id,
      title: '✅ Visite planifiée !',
      body: `Votre visite pour ${targetDisplay} a été planifiée avec succès après paiement.`,
      type: 'visite',
      data: { visit_id: visitId, status: 'planifiee' },
    });

    await supabase
      .from('paiements')
      .update({
        metadata: {
          ...(paymentRecord.metadata || {}),
          visit_processed: true,
          visit_processed_at: new Date().toISOString(),
        }
      })
      .eq('id', paymentRecord.id);

    return data;

  } catch (error) {
    console.error('❌ Erreur processPonctualVisit:', error.message);
    return null;
  }
}

// ============================================================
// ✅ ACTIVER UN ABONNEMENT
// ============================================================
async function activateSubscription(paymentRecord, subscriptionId) {
  try {
    if (!isValidUUID(subscriptionId)) {
      console.error('❌ subscriptionId n\'est pas un UUID valide:', subscriptionId);
      return null;
    }

    const { data: existingSub, error: subCheckError } = await supabase
      .from('abonnements')
      .select('id, status, user_id, total_visits, used_visits, remaining_visits')
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

    // Notification
    await supabase.from('notifications').insert({
      user_id: paymentRecord.user_id,
      title: '✅ Abonnement activé !',
      body: `Votre abonnement est maintenant actif. Profitez de nos services !`,
      type: 'paiement',
      data: {
        subscription_id: subscriptionId,
        status: 'actif',
        remaining_visits: subscription.remaining_visits,
        remaining_orders: subscription.remaining_orders,
      },
    });

    return subscription;

  } catch (error) {
    console.error('❌ Erreur activateSubscription:', error.message);
    return null;
  }
}

// ============================================================
// 💳 GÉNÉRER UN PAIEMENT FEDAPAY
// ============================================================
router.post('/generate-payment', async (req, res) => {
  const startTime = Date.now();

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token utilisateur manquant',
      });
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authData?.user) {
      return res.status(401).json({
        success: false,
        message: 'Session invalide ou expirée',
      });
    }

    const user = authData.user;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('full_name, email, phone')
      .eq('id', user.id)
      .single();

    if (profileError) {
      console.error('❌ Erreur récupération profil:', profileError.message);
    }

    const {
      montant,
      amount,
      description,
      email_client,
      customer_email,
      customer_name,
      plan_id,
      abonnement_id,
      order_id = null,
      is_ponctual = false,
      order_data = null,
      patient_id = null,
      target_type = 'personal',
      target_name = null,
      visit_id = null,
      is_visit = false,
    } = req.body;

    const finalAmount = Number(montant || amount || 0);

    if (!finalAmount || finalAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Montant invalide',
      });
    }

    const finalEmail =
      email_client ||
      customer_email ||
      profile?.email ||
      user.email ||
      'client@santeplus.com';

    const finalName =
      customer_name ||
      profile?.full_name ||
      user.user_metadata?.full_name ||
      user.email?.split('@')[0] ||
      'Client Santé Plus';

    const firstName = finalName.split(' ')[0] || 'Client';
    const lastName = finalName.split(' ').slice(1).join(' ') || 'Santé Plus';

    const frontendUrl =
      process.env.FRONTEND_URL ||
      process.env.CLIENT_URL ||
      'http://localhost:5173';

    const callbackUrl = `${frontendUrl}/payment/confirm`;
    const cancelUrl = `${frontendUrl}/payment/confirm?status=cancel`;

    let subscriptionRecord = null;
    let actualAbonnementId = null;

    if (!is_ponctual && abonnement_id) {
      const { data: offer, error: offerError } = await supabase
        .from('offres')
        .select('id, name, type, price, visits_per_week, duration_days, total_visits, total_orders')
        .eq('id', abonnement_id)
        .single();

      if (offerError) {
        console.error('❌ Offre non trouvée:', offerError.message);
        return res.status(400).json({
          success: false,
          message: 'Offre non trouvée',
        });
      }

      subscriptionRecord = await createPendingSubscription(
        user.id,
        offer.id,
        offer,
        patient_id || null
      );

      if (!subscriptionRecord) {
        return res.status(500).json({
          success: false,
          error: "Erreur lors du verrouillage de l'abonnement",
        });
      }

      actualAbonnementId = subscriptionRecord.id;
    }

    const paymentData = {
      reference: null,
      user_id: user.id,
      amount: finalAmount,
      is_ponctual: is_ponctual,
      is_visit: is_visit,
      visit_id: visit_id || null,
      abonnement_id: actualAbonnementId || null,
      patient_id: patient_id || null,
      type: is_visit ? 'visit' : (is_ponctual ? 'order' : 'subscription'),
    };

    // ✅ Initialiser FedaPay
    FedaPay.setApiKey(FEDAPAY_SECRET_KEY);
    FedaPay.setEnvironment(FEDAPAY_ENV);

    const transaction = await Transaction.create({
      description: description || 'Paiement Santé Plus Services',
      amount: finalAmount,
      currency: { iso: 'XOF' },
      callback_url: callbackUrl,
      customer: {
        firstname: firstName,
        lastname: lastName,
        email: finalEmail,
      }
    });

    const token = await transaction.generateToken();

    // Mettre à jour le paiement avec la référence FedaPay
    paymentData.reference = transaction.id;

    const { error: insertError } = await supabase
      .from('paiements')
      .insert(paymentData);

    if (insertError) {
      console.error('❌ Erreur insertion paiement:', insertError);
      return res.status(500).json({ error: insertError.message });
    }

    res.json({
      success: true,
      token: token.token,
      url: token.url,
      reference: transaction.id,
    });

  } catch (error: any) {
    console.error('❌ Create payment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ✅ WEBHOOK DE CONFIRMATION AUTOMATIQUE FEDAPAY
// ============================================================
router.post('/webhook', async (req, res) => {
  try {
    console.log('📥 Webhook reçu');
    const { event, entity } = req.body;

    if (event !== 'transaction.approved') {
      return res.json({ success: true, message: 'Événement ignoré' });
    }

    const transactionId = entity.id;
    console.log(`📥 Événement reçu: transaction.approved | Transaction: ${transactionId}`);

    // Rechercher le paiement avec retry
    const payment = await findPaymentWithRetry(transactionId);

    if (!payment) {
      console.error(`❌ Impossible de trouver le paiement pour la transaction ${transactionId} après ${MAX_RETRY_ATTEMPTS} tentatives`);
      return res.status(404).json({ error: 'Paiement introuvable' });
    }

    console.log(`✅ Paiement trouvé : ${payment.id}`);

    // Si le paiement est déjà traité, on arrête
    if (payment.status === 'completed') {
      return res.json({ success: true, message: 'Paiement déjà traité' });
    }

    // Mettre à jour le paiement
    const { error: updateError } = await supabase
      .from('paiements')
      .update({
        status: 'completed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', payment.id);

    if (updateError) throw updateError;

    // Récupérer les métadonnées de la transaction FedaPay
    FedaPay.setApiKey(FEDAPAY_SECRET_KEY);
    FedaPay.setEnvironment(FEDAPAY_ENV);
    const transaction = await Transaction.retrieve(transactionId);
    const metadata = transaction.custom_metadata || {};

    const type = metadata.type || payment.type;
    const isPonctual = metadata.is_ponctual === 'true' || payment.is_ponctual;

    console.log('📦 Métadonnées extraites:', {
      type,
      isPonctual,
      visitId: metadata.visit_id || payment.visit_id,
      subscriptionId: metadata.abonnement_id || payment.abonnement_id,
    });

    // 1️⃣ CAS A : COMMANDE PONCTUELLE (Offline creation)
    if (type === 'order' || isPonctual) {
      console.log('📦 Traitement commande ponctuelle...');
      const orderData = metadata.order_data ? JSON.parse(metadata.order_data) : null;
      
      const newOrder = await createPonctualOrder(payment, transactionId, orderData);
      if (newOrder) {
        console.log('✅ Commande ponctuelle créée avec succès');
      }
    } 
    // 2️⃣ CAS B : VISITE PONCTUELLE
    else if (type === 'visit' || payment.is_visit) {
      const visitId = metadata.visit_id || payment.visit_id;
      console.log('🔄 Traitement visite ponctuelle:', visitId);
      const updatedVisit = await processPonctualVisit(payment, transactionId, visitId, metadata);
      if (updatedVisit) {
        console.log('✅ Visite ponctuelle activée avec succès');
      }
    }
    // 3️⃣ CAS C : ABONNEMENT
    else if (type === 'subscription' || payment.abonnement_id) {
      const subId = payment.abonnement_id;
      console.log('📦 Activation de l\'abonnement:', subId);
      const activeSub = await activateSubscription(payment, subId);
      if (activeSub) {
        console.log('✅ Abonnement activé avec succès');
      }
    }

    res.json({ success: true });

  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
module.exports.handleWebhook = handleWebhook;
