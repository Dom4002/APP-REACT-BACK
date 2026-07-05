// 📁 backend/src/services/push.service.js

const webpush = require('web-push');
const { supabase } = require('./supabase.service');

// ============================================================
// CONFIGURATION VAPID
// ============================================================

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn('⚠️ VAPID keys manquantes. Les notifications push ne fonctionneront pas.');
  console.warn('📋 Générez les clés avec: npx web-push generate-vapid-keys');
}

webpush.setVapidDetails(
  'mailto:contact@santeplus.bj',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ============================================================
// ENVOYER UNE NOTIFICATION PUSH
// ============================================================

const sendPushNotification = async (subscription, payload) => {
  try {
    if (!subscription || !subscription.endpoint) {
      throw new Error('Abonnement push invalide');
    }

    // ✅ Vérifier que les clés VAPID sont configurées
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      console.warn('⚠️ Clés VAPID manquantes, notification non envoyée');
      return { success: false, error: 'VAPID keys missing' };
    }

    console.log('📤 Envoi notification push vers:', subscription.endpoint.substring(0, 50) + '...');

    const result = await webpush.sendNotification(
      subscription,
      JSON.stringify(payload)
    );

    console.log('✅ Notification push envoyée avec succès');
    return { success: true, result };
  } catch (error) {
    console.error('❌ Erreur envoi push:', error.message);

    // ✅ Si l'abonnement est expiré, le supprimer
    if (error.statusCode === 410 || error.statusCode === 404) {
      console.log('🗑️ Abonnement push expiré, suppression en base...');
      try {
        await supabase
          .from('push_tokens')
          .delete()
          .eq('token', JSON.stringify(subscription));
        console.log('✅ Abonnement push supprimé');
      } catch (dbError) {
        console.error('❌ Erreur suppression abonnement:', dbError);
      }
    }

    return { success: false, error: error.message };
  }
};

// ============================================================
// ENVOYER À UN UTILISATEUR
// ============================================================

const sendPushToUser = async (userId, payload) => {
  try {
    // ✅ Récupérer tous les tokens de l'utilisateur
    const { data: tokens, error } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (error) throw error;

    if (!tokens || tokens.length === 0) {
      console.log(`ℹ️ Aucun token push pour l'utilisateur ${userId}`);
      return { success: false, sent: 0, message: 'Aucun token trouvé' };
    }

    let sent = 0;
    const results = [];

    for (const token of tokens) {
      try {
        // ✅ Le token peut être stocké comme JSON string
        let subscription;
        try {
          subscription = typeof token.token === 'string' 
            ? JSON.parse(token.token) 
            : token.token;
        } catch {
          // Si ce n'est pas du JSON, c'est peut-être un token simple
          subscription = { endpoint: token.token };
        }

        const result = await sendPushNotification(subscription, payload);
        if (result.success) {
          sent++;
        }
        results.push(result);
      } catch (err) {
        console.error('❌ Erreur pour un token:', err.message);
        results.push({ success: false, error: err.message });
      }
    }

    return { success: true, sent, total: tokens.length, results };
  } catch (error) {
    console.error('❌ Erreur sendPushToUser:', error);
    return { success: false, error: error.message };
  }
};

// ============================================================
// ENVOYER À PLUSIEURS UTILISATEURS
// ============================================================

const sendPushToMultipleUsers = async (userIds, payload) => {
  const results = [];
  for (const userId of userIds) {
    const result = await sendPushToUser(userId, payload);
    results.push({ userId, ...result });
  }
  return results;
};

// ============================================================
// ENVOYER À TOUS LES AIDANTS DISPONIBLES
// ============================================================

const sendPushToAvailableAidants = async (payload) => {
  try {
    const { data: aidants, error } = await supabase
      .from('aidants')
      .select('user_id')
      .eq('available', true)
      .eq('is_verified', true)
      .eq('status', 'approved');

    if (error) throw error;

    if (!aidants || aidants.length === 0) {
      console.log('ℹ️ Aucun aidant disponible');
      return { success: true, sent: 0 };
    }

    const userIds = aidants.map(a => a.user_id);
    return await sendPushToMultipleUsers(userIds, payload);
  } catch (error) {
    console.error('❌ Erreur sendPushToAvailableAidants:', error);
    return { success: false, error: error.message };
  }
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  sendPushNotification,
  sendPushToUser,
  sendPushToMultipleUsers,
  sendPushToAvailableAidants,
};
