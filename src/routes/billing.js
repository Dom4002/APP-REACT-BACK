// 📁 backend/src/routes/billing.js
 
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { FedaPay, Transaction } = require('fedapay');
const axios = require('axios');  

const router = express.Router();

const MAX_RETRY_ATTEMPTS = 8;
const RETRY_DELAY_MS = 1500;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

async function getActiveAidantForTarget(targetType, targetId, familyId) {
  try {
    const { data, error } = await supabase.rpc('get_active_auxiliary_for_target', {
      p_target_type: targetType,
      p_target_id: targetId,
      p_family_id: familyId,
    });

    if (error) {
      console.error('❌ get_active_auxiliary_for_target error:', error);
      return null;
    }

    if (!data) return null;

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
        latitude: orderDataToInsert.latitude || null, // ✅ ENREGISTREMENT GPS DU WEBHOOK
        longitude: orderDataToInsert.longitude || null, // ✅ ENREGISTREMENT GPS DU WEBHOOK
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

    const { data: aidants } = await supabase
      .from('aidants')
      .select('user_id, current_orders, max_orders')
      .eq('available', true)
      .eq('is_verified', true)
      .eq('status', 'approved');

    if (aidants && aidants.length > 0) {
      const availableAidants = aidants.filter(
        a => (a.current_orders || 0) < (a.max_orders || 2)
      );

      if (availableAidants.length > 0) {
        for (const aidant of availableAidants) {
          await supabase.from('notifications').insert({
            user_id: aidant.user_id, 
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

async function processPonctualVisit(paymentRecord, transactionId, visitId, metadata) {
  try {
    console.log('🔄 Traitement d\'une visite ponctuelle en arrière-plan:', visitId);

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
      is_draft: false,                     
      requires_payment: false,             
      payment_status: 'completed',         
      payment_confirmed_at: new Date().toISOString(),
      payment_transaction_id: transactionId,
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

    if (visit.target_type === 'personal' || visit.target_type === 'personal_account') {
      delete updateData.patient_id;
    }

    console.log('📤 Mise à jour visite avec:', JSON.stringify(updateData, null, 2));

    const { data: updatedVisit, error: updateError } = await supabase
      .from('visites')
      .update(updateData)
      .eq('id', visitId) 
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

    if (updateError) {
      console.error('❌ Erreur mise à jour visite:', updateError.message);
      
      if (
        updateError.message.includes('chk_planned_not_draft') || 
        updateError.message.includes('chk_draft_is_draft') || 
        updateError.message.includes('chk_draft_requires_payment')
      ) {
        console.log('🔄 Tentative de récupération fallback...');
        
        if (!aidantId) {
          aidantId = await getActiveAidantForTarget(targetType, targetId, familyId);
        }
        
        const fallbackData = {
          status: 'planifiee',
          is_draft: false,
          requires_payment: false,
          payment_status: 'completed',
          payment_confirmed_at: new Date().toISOString(),
          payment_transaction_id: transactionId,
          patient_id: visit.user_id, 
          aidant_id: aidantId || null,
          target_type: 'personal',
          target_name: visit.target_name || 'Personnel',
          metadata: {
            ...(visit.metadata || {}),
            payment_confirmed_at: new Date().toISOString(),
            transaction_id: transactionId,
            scheduled_from_draft: true,
            payment_completed: true,
            webhook_processed: true,
            webhook_processed_at: new Date().toISOString(),
            aidant_assigned_after_payment: !!aidantId,
            fallback_patient_id_used: true,
          }
        };
        
        const { data: retryVisit, error: retryError } = await supabase
          .from('visites')
          .update(fallbackData)
          .eq('id', visitId)
          .select()
          .single();
        
        if (!retryError && retryVisit) {
          console.log('✅ Visite récupérée avec patient_id fallback:', retryVisit.id);
          
          if (retryVisit.aidant_id) {
            const { data: aidant } = await supabase
              .from('aidants')
              .select('user_id')
              .eq('id', retryVisit.aidant_id)
              .single();

            if (aidant) {
              await supabase.from('notifications').insert({
                user_id: aidant.user_id,
                title: '📅 Nouvelle visite à valider',
                body: `Visite pour ${retryVisit.target_name || 'le patient'} le ${retryVisit.scheduled_date} à ${retryVisit.scheduled_time}`,
                type: 'visite',
                data: { visit_id: visitId, action: 'approve' },
              });
            }
          }

          await supabase.from('notifications').insert({
            user_id: retryVisit.user_id,
            title: '✅ Visite planifiée !',
            body: `Votre visite pour ${retryVisit.target_name || 'Personnel'} a été planifiée avec succès après paiement.`,
            type: 'visite',
            data: { visit_id: visitId, status: 'planifiee' },
          });

          return retryVisit;
        }
      }
      return null;
    }

    console.log('✅ Visite passée de brouillon à planifiee:', visitId);

    const targetDisplay = updatedVisit.target_name || (updatedVisit.patient ? `${updatedVisit.patient.first_name} ${updatedVisit.patient.last_name}` : 'Personnel');

    if (updatedVisit.aidant_id && updatedVisit.aidant?.user?.id) {
      await supabase.from('notifications').insert({
        user_id: updatedVisit.aidant.user.id, 
        title: '📅 Nouvelle visite à valider',
        body: `Visite pour ${targetDisplay} le ${updatedVisit.scheduled_date} à ${updatedVisit.scheduled_time}`,
        type: 'visite',
        data: { visit_id: visitId, action: 'approve' },
      });
    }

    await supabase.from('notifications').insert({
      user_id: updatedVisit.user_id,
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

    return updatedVisit;

  } catch (error) {
    console.error('❌ Erreur processPonctualVisit:', error.message);
    return null;
  }
}

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
      console.error('❌ Erreur:', subCheckError.message);
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
      console.error('❌ Erreur activation:', subError.message);
      return null;
    }

    console.log('✅ Abonnement activé:', subscriptionId);

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
    const authToken = authHeader.replace('Bearer ', '').trim();

    if (!authToken) {
      return res.status(401).json({
        success: false,
        message: 'Token utilisateur manquant',
      });
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(authToken);

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
        .select('id, name, type, price, total_visits, total_orders')
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

    FedaPay.setApiKey(FEDAPAY_SECRET_KEY);
    FedaPay.setEnvironment(FEDAPAY_ENV === 'sandbox' ? 'sandbox' : 'live');

    const metadata = {
      user_id: user.id,
      plan_id: plan_id || null,
      abonnement_id: actualAbonnementId || null,
      order_id: order_id || null,
      is_ponctual: is_ponctual || false,
      source: 'sante_plus_services',
      order_data: is_ponctual && order_data ? JSON.stringify(order_data) : null,
      patient_id: patient_id || null,
      target_type: target_type || 'personal',
      target_name: target_name || finalName,
      is_visit: is_visit || false,
      visit_id: visit_id || null,
      type: is_visit ? 'visit' : (is_ponctual ? 'order' : 'subscription'),
    };

    console.log('📦 Métadonnées envoyées à FedaPay:', metadata);

    const transaction = await Transaction.create({
      description: description || 'Paiement Santé Plus Services',
      amount: Math.round(finalAmount),
      currency: {
        iso: 'XOF',
      },
      callback_url: callbackUrl,
      cancel_url: cancelUrl,
      customer: {
        email: finalEmail,
        firstname: firstName,
        lastname: lastName,
      },
      metadata: metadata,
    });

    console.log('✅ Transaction FedaPay créée:', transaction?.id);

    const paymentUrl =
      transaction?.payment_url ||
      transaction?.url ||
      transaction?.checkout_url;

    if (!paymentUrl) {
      return res.status(500).json({
        success: false,
        message: "FedaPay n'a pas retourné de lien de paiement",
      });
    }

    const checkoutToken = await transaction.generateToken();

    const paymentData = {
      user_id: user.id,
      amount: finalAmount,
      currency: 'XOF',
      method: 'fedapay',
      reference: String(transaction.id),
      status: 'en_attente',
      abonnement_id: actualAbonnementId || null,
      metadata: {
        description: description || 'Paiement Santé Plus',
        plan_id: plan_id || null,
        abonnement_id: actualAbonnementId || null,
        order_id: order_id || null,
        is_ponctual: is_ponctual || false,
        transaction_id: String(transaction.id),
        payment_url: paymentUrl,
        order_data: is_ponctual && order_data ? JSON.stringify(order_data) : null,
        patient_id: patient_id || null,
        target_type: target_type || 'personal',
        target_name: target_name || finalName,
        is_visit: is_visit || false,
        visit_id: visit_id || null,
        type: is_visit ? 'visit' : (is_ponctual ? 'order' : 'subscription'),
      },
    };

    const { data: payment, error: dbError } = await supabase
      .from('paiements')
      .insert(paymentData)
      .select()
      .single();

    if (dbError) {
      console.error('❌ ERREUR SAUVEGARDE PAIEMENT:', dbError.message);

      if (subscriptionRecord && actualAbonnementId) {
        await supabase.from('abonnements').delete().eq('id', actualAbonnementId);
      }

      return res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'enregistrement en base de données',
      });
    }

    console.log('✅ Paiement enregistré en base:', payment?.id);

    if (subscriptionRecord && actualAbonnementId) {
      await supabase.from('notifications').insert({
        user_id: user.id,
        title: '⏳ Abonnement en attente',
        body: `Votre abonnement est en attente de confirmation de paiement.`,
        type: 'paiement',
        data: {
          subscription_id: actualAbonnementId,
          status: 'en_attente',
        },
      });
    }

    const duration = Date.now() - startTime;
    console.log(`⏱️ Paiement généré en ${duration}ms`);

    return res.json({
      success: true,
      payment_url: paymentUrl,
      url: paymentUrl,
      checkout_url: paymentUrl,
      token: checkoutToken.token,
      transaction_id: transaction.id,
      reference: transaction.reference || `FEDAPAY-${transaction.id}`,
      subscription_id: actualAbonnementId,
    });

  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`❌ Erreur création transaction FedaPay (${duration}ms):`, err.message);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Impossible de créer la transaction FedaPay',
    });
  }
});

// ============================================================
// ✅ VÉRIFIER LE STATUT D'UN PAIEMENT
// ============================================================
router.get('/verify-payment', async (req, res) => {
  try {
    const { transaction_id, reference } = req.query;

    if (!transaction_id && !reference) {
      return res.status(400).json({
        success: false,
        message: 'Transaction ID ou référence requis',
      });
    }

    let query = supabase.from('paiements').select('*');

    if (transaction_id) {
      query = query.eq('reference', String(transaction_id));
    } else if (reference) {
      query = query.eq('reference', String(reference));
    }

    const { data, error } = await query.single();

    if (error) {
      return res.status(404).json({
        success: false,
        message: 'Paiement non trouvé',
      });
    }

    try {
      const transaction = await Transaction.retrieve(data.reference);
      if (transaction && transaction.status === 'paid' && data.status !== 'valide') {
        await supabase
          .from('paiements')
          .update({
            status: 'valide',
            paid_at: new Date().toISOString(),
          })
          .eq('id', data.id);

        data.status = 'valide';
      }
    } catch (fedapayError) {
      console.warn('⚠️ Erreur vérification FedaPay:', fedapayError.message);
    }

    res.json({
      success: data.status === 'valide',
      payment: data,
    });
  } catch (error) {
    console.error('❌ Verify payment error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification',
    });
  }
});

// ============================================================
// 🔔 WEBHOOK FEDAPAY
// ============================================================
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const startTime = Date.now();
  let transactionId = null;

  try {
    let body = req.body;

    if (Buffer.isBuffer(body)) {
      body = JSON.parse(body.toString('utf8'));
    } else if (typeof body === 'string') {
      body = JSON.parse(body);
    } else if (Array.isArray(body) && body.length > 0) {
      body = body[0];
    }

    console.log('📥 Webhook reçu');

    const event = body?.event || body?.name;
    const data = body?.data || body?.entity;

    if (!event) {
      return res.status(200).json({
        success: false,
        message: 'Événement manquant, webhook accepté',
      });
    }

    transactionId = String(data?.id);
    console.log(`📥 Événement reçu: ${event} | Transaction: ${transactionId}`);

    if (event !== 'transaction.approved' && event !== 'transaction.paid') {
      return res.status(200).json({
        success: true,
        message: `Événement ${event} ignoré`,
      });
    }

    const payment = await findPaymentWithRetry(transactionId);

    if (!payment) {
      console.error(`❌ Paiement non trouvé après ${MAX_RETRY_ATTEMPTS} tentatives`);
      return res.status(200).json({
        success: false,
        message: 'Paiement non trouvé, webhook accepté',
      });
    }

    const metadata = payment.metadata || {};
    
    const type = metadata.type || payment.type || 'subscription';
    const isPonctual = metadata.is_ponctual === true || metadata.is_ponctual === 'true' || payment.is_ponctual;
    const subscriptionId = metadata.abonnement_id || payment.abonnement_id || null;
    const orderData = metadata.order_data ? (typeof metadata.order_data === 'string' ? JSON.parse(metadata.order_data) : metadata.order_data) : null;
    const visitId = metadata.visit_id || payment.visit_id || null;

    console.log('📦 Métadonnées extraites:', {
      type,
      isPonctual,
      visitId,
      subscriptionId,
      hasOrderData: !!orderData,
    });

    const { data: updatedPayment, error: updateError } = await supabase
      .from('paiements')
      .update({
        status: 'valide',
        paid_at: new Date().toISOString(),
        provider_reference: transactionId,
      })
      .eq('id', payment.id)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Erreur mise à jour paiement:', updateError.message);
    }

    const paymentRecord = updatedPayment || payment;
    let result = null;

    if (type === 'visit' && visitId) {
      result = await processPonctualVisit(paymentRecord, transactionId, visitId, metadata);
    } 
    else if (type === 'order' || isPonctual) {
      result = await createPonctualOrder(paymentRecord, transactionId, orderData);
    } 
    else if (type === 'subscription' && subscriptionId) {
      result = await activateSubscription(paymentRecord, subscriptionId);
    }

    try {
      let notificationTitle = '✅ Paiement confirmé';
      let notificationBody = `Votre paiement de ${paymentRecord.amount} FCFA a été confirmé.`;

      if (type === 'visit' && result) {
        notificationTitle = '✅ Visite planifiée !';
        notificationBody = `Votre visite a été planifiée avec succès après paiement.`;
      } else if (type === 'order' && result) {
        notificationTitle = '✅ Commande confirmée !';
        notificationBody = `Votre commande a été enregistrée avec succès après paiement.`;
      } else if (type === 'subscription' && result) {
        notificationTitle = '✅ Abonnement activé !';
        notificationBody = `Votre abonnement est maintenant actif.`;
      }

      await supabase.from('notifications').insert({
        user_id: paymentRecord.user_id,
        title: notificationTitle,
        body: notificationBody,
        type: 'paiement',
        data: { 
          payment_id: paymentRecord.id,
          type: type,
          processed: !!result,
        },
      });
    } catch (notifError) {
      console.error('❌ Erreur notification paiement:', notifError.message);
    }

    const duration = Date.now() - startTime;
    console.log(`⏱️ Webhook traité en ${duration}ms`);

    return res.status(200).json({
      success: true,
      message: 'Paiement traité avec succès',
      payment_id: paymentRecord.id,
      type: type,
      processed: !!result,
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ Webhook error (${duration}ms):`, error.message);
    return res.status(200).json({
      success: false,
      message: 'Erreur interne, webhook accepté',
      error: error.message,
    });
  }
});

// ============================================================
// ENDPOINT POUR RÉSOUDRE LES LIENS GOOGLE MAPS COURTS (maps.app.goo.gl)
// ============================================================
router.post('/resolve-maps', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL requise' });
    }

    console.log('🔄 [Google Maps] Résolution du lien court:', url);

    // Effectuer une requête d'en-tête (HEAD) pour suivre la redirection de l'URL Google Maps raccourcie
    const response = await axios.get(url, {
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const finalUrl = response.request.res.responseUrl || url;
    console.log('🎯 [Google Maps] URL longue décodée:', finalUrl);

    res.json({
      success: true,
      finalUrl,
    });
  } catch (error) {
    console.error('❌ Erreur résolution URL Google Maps:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
