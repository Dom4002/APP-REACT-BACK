// 📁 backend/src/services/notification.service.js
 
const admin = require('firebase-admin');
const { supabase } = require('./supabase.service');

// ============================================================
// INITIALISATION FIREBASE ADMIN
// ============================================================
if (process.env.FIREBASE_PROJECT_ID) {
  try {
    const cleanPrivateKey = process.env.FIREBASE_PRIVATE_KEY
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/^"|"$/g, '').replace(/\\n/g, '\n')
      : '';

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: cleanPrivateKey,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        }),
      });
      console.log('🔥 Firebase Admin SDK initialisé avec succès');
    }
  } catch (fbErr) {
    console.error('❌ Échec initialisation Firebase Admin SDK:', fbErr.message);
  }
}

// ============================================================
// CONSTANTES DES TYPES DE NOTIFICATIONS (Strictement alignées sur la BD)
// ============================================================
const NOTIFICATION_TYPES = {
  VISIT: 'visite',
  MESSAGE: 'message',
  ORDER: 'commande',
  PAYMENT: 'paiement',
  SYSTEM: 'system',
  ALERT: 'alert',
  REMINDER: 'reminder',
  PROMOTION: 'promotion',
};

// ============================================================
// FONCTIONS CORE
// ============================================================

/**
 * Enregistre un token push pour un utilisateur
 */
const registerToken = async (userId, token, deviceInfo = 'web') => {
  try {
    const tokenStr = typeof token === 'object' ? JSON.stringify(token) : String(token);
    const { error } = await supabase
      .from('push_tokens')
      .upsert(
        {
          user_id: userId,
          token: tokenStr,
          device_info: deviceInfo,
          is_active: true,
          last_used_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'token' }
      );

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('❌ Register token error:', error);
    throw error;
  }
};

/**
 * Supprime un token push
 */
const removeToken = async (token) => {
  try {
    await supabase.from('push_tokens').delete().eq('token', token);
    return true;
  } catch (error) {
    console.error('❌ Remove token error:', error);
    throw error;
  }
};

/**
 * Envoie une notification push FCM réelle à un utilisateur
 */
const sendPushNotification = async (userId, title, body, data = {}) => {
  try {
    const { data: tokens, error } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (error || !tokens || tokens.length === 0) {
      console.log(`ℹ️ Aucun token actif pour l'utilisateur ${userId}`);
      return null;
    }

    const tokensList = tokens.map((t) => t.token);

    if (admin.apps.length > 0) {
      // FCM requiert que les valeurs dans `data` soient des chaînes de caractères
      const cleanData = {};
      if (data) {
        for (const [key, value] of Object.entries(data)) {
          if (value === null || value === undefined) {
            cleanData[key] = '';
          } else if (typeof value === 'object') {
            cleanData[key] = JSON.stringify(value);
          } else {
            cleanData[key] = String(value);
          }
        }
      }

      const message = {
        notification: { title, body },
        data: cleanData,
        android: { priority: 'high' },
        webpush: { headers: { Urgency: 'high' } },
        tokens: tokensList,
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      console.log(`📨 Push envoyé à ${userId}: ${response.successCount} succès, ${response.failureCount} échecs`);

      // Nettoyer les tokens invalides
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errCode = resp.error?.code;
          if (
            errCode === 'messaging/registration-token-not-registered' ||
            errCode === 'messaging/invalid-registration-token'
          ) {
            supabase.from('push_tokens').delete().eq('token', tokensList[idx]);
          }
        }
      });

      return response;
    }
  } catch (error) {
    console.error('❌ sendPushNotification error:', error.message);
  }
};

/**
 * Crée une notification en base et envoie le push
 */
const createNotification = async ({ userId, title, body, type = NOTIFICATION_TYPES.SYSTEM, data = {} }) => {
  try {
    // Vérification du type par rapport au CHECK constraint SQL
    const validTypes = Object.values(NOTIFICATION_TYPES);
    const safeType = validTypes.includes(type) ? type : NOTIFICATION_TYPES.SYSTEM;

    const { data: notification, error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title,
        body,
        type: safeType,
        data,
        is_read: false,
        is_sent: true,
        sent_at: new Date().toISOString(),
        is_delivered: true,
        delivered_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    // Envoi asynchrone du Push FCM
    sendPushNotification(userId, title, body, data).catch((err) => {
      console.warn('⚠️ Erreur push FCM (non bloquante):', err.message);
    });

    return notification;
  } catch (error) {
    console.error('❌ createNotification error:', error.message);
    throw error;
  }
};

// ============================================================
// HELPERS NOTIFICATIONS SPÉCIFIQUES
// ============================================================

const notifyAdmins = async (title, body, type = NOTIFICATION_TYPES.SYSTEM, data = {}) => {
  try {
    const { data: admins, error } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (error || !admins) return;

    for (const adminUser of admins) {
      await createNotification({
        userId: adminUser.id,
        title,
        body,
        type,
        data,
      });
    }
  } catch (error) {
    console.error('❌ notifyAdmins error:', error.message);
  }
};

const notifyAvailableAidantsForOrder = async (orderId, { targetDisplay, description, urgency = false }) => {
  try {
    const { data: aidants, error } = await supabase
      .from('aidants')
      .select('user_id, current_orders, max_orders')
      .eq('available', true)
      .eq('is_verified', true)
      .eq('status', 'approved');

    if (error || !aidants || aidants.length === 0) return;

    const availableAidants = aidants.filter((a) => (a.current_orders || 0) < (a.max_orders || 2));
    if (availableAidants.length === 0) return;

    const title = urgency ? '🚨 Commande urgente disponible' : '🛒 Nouvelle commande disponible';
    const body = urgency
      ? `Commande pour ${targetDisplay} - Premier arrivé, premier servi !`
      : `Commande de ${targetDisplay} - ${description}`;

    for (const aidant of availableAidants) {
      await createNotification({
        userId: aidant.user_id,
        title,
        body,
        type: NOTIFICATION_TYPES.ORDER,
        data: {
          order_id: orderId,
          action: 'take',
          urgency: urgency ? 'high' : 'normal',
          target_name: targetDisplay,
        },
      });
    }
  } catch (error) {
    console.error('❌ notifyAvailableAidantsForOrder error:', error.message);
  }
};

const notifyAdminsForPendingAidant = async (visitId, { targetName, scheduledDate, scheduledTime }) => {
  try {
    await notifyAdmins(
      '🚨 Visite planifiée sans aidant disponible !',
      `Visite pour ${targetName} le ${scheduledDate} à ${scheduledTime}. Tous les aidants sont complets.`,
      NOTIFICATION_TYPES.ALERT,
      { visit_id: visitId, action: 'assign_aidant', urgency: 'high', target_name: targetName }
    );
  } catch (error) {
    console.error('❌ notifyAdminsForPendingAidant error:', error.message);
  }
};

module.exports = {
  NOTIFICATION_TYPES,
  registerToken,
  removeToken,
  sendPushNotification,
  createNotification,
  notifyAdmins,
  notifyAvailableAidantsForOrder,
  notifyAdminsForPendingAidant,
};
