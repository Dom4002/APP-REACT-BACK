// 📁 backend/src/services/notification.service.js

const admin = require('firebase-admin');
const { supabase } = require('./supabase.service');

// ============================================================
// INITIALISATION FIREBASE ADMIN
// ============================================================

if (process.env.FIREBASE_PROJECT_ID) {
  // ✅ Nettoyage robuste des guillemets doubles et des sauts de ligne de Render
  const cleanPrivateKey = process.env.FIREBASE_PRIVATE_KEY
    .replace(/^"|"$/g, '') // Supprime les guillemets au début et à la fin
    .replace(/\\n/g, '\n'); // Restitue les sauts de ligne réels

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: cleanPrivateKey,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

// ============================================================
// CONSTANTES
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
// FONCTIONS EXISTANTES (conservées)
// ============================================================

/**
 * Enregistre un token push pour un utilisateur
 */
const registerToken = async (userId, token, deviceInfo) => {
  try {
    await supabase
      .from('push_tokens')
      .insert({
        user_id: userId,
        token,
        device_info: deviceInfo,
        is_active: true,
        last_used_at: new Date().toISOString(),
      })
      .onConflict('token')
      .merge();
    
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
    await supabase
      .from('push_tokens')
      .delete()
      .eq('token', token);
    return true;
  } catch (error) {
    console.error('❌ Remove token error:', error);
    throw error;
  }
};

/**
 * Envoie une notification push à un utilisateur
 */
const sendPushNotification = async (userId, title, body, data = {}) => {
  try {
    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (!tokens || tokens.length === 0) {
      console.log(`ℹ️ Aucun token pour l'utilisateur ${userId}`);
      return;
    }

    const tokensList = tokens.map(t => t.token);

    if (admin.apps.length > 0) {
      // 🔥 Nettoyage des données pour FCM (doivent être des strings)
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
        android: {
          priority: 'high',
        },
        webpush: {
          headers: {
            Urgency: 'high',
          },
        },
        tokens: tokensList,
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      console.log(`📨 Push envoyé à ${userId}: ${response.successCount} succès, ${response.failureCount} échecs`);

      // ✅ Nettoyer les tokens invalides
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.warn(`⚠️ Token invalide pour ${userId}: ${resp.error?.code}`);
          if (resp.error?.code === 'messaging/registration-token-not-registered' ||
              resp.error?.code === 'messaging/invalid-registration-token') {
            // Supprimer le token invalide
            supabase
              .from('push_tokens')
              .delete()
              .eq('token', tokensList[idx]);
          }
        }
      });

      return response;
    }
  } catch (error) {
    console.error('❌ sendPushNotification error:', error);
    throw error;
  }
};

/**
 * Crée une notification en base et envoie le push
 */
const createNotification = async ({ userId, title, body, type, data = {} }) => {
  try {
    const { data: notification, error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title,
        body,
        type,
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

    // Envoyer le push en arrière-plan (ne pas attendre)
    sendPushNotification(userId, title, body, data).catch(err => {
      console.warn('⚠️ Erreur push (non bloquante):', err.message);
    });

    return notification;
  } catch (error) {
    console.error('❌ createNotification error:', error);
    throw error;
  }
};

// ============================================================
// NOTIFICATIONS EXISTANTES (conservées)
// ============================================================

const notifyPatientAidants = async (patientId, title, body, type, data = {}) => {
  try {
    const { data: aidants, error } = await supabase
      .from('patient_family_links')
      .select('family_id, profiles!inner(role)')
      .eq('patient_id', patientId)
      .eq('profiles.role', 'aidant');

    if (error) throw error;
    if (!aidants || aidants.length === 0) return;

    for (const link of aidants) {
      await createNotification({
        userId: link.family_id,
        title,
        body,
        type,
        data: { ...data, patient_id: patientId },
      });
    }
  } catch (error) {
    console.error('❌ notifyPatientAidants error:', error);
  }
};

const notifyAdmins = async (title, body, type, data = {}) => {
  try {
    const { data: admins, error } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (error) throw error;
    if (!admins || admins.length === 0) return;

    for (const admin of admins) {
      await createNotification({
        userId: admin.id,
        title,
        body,
        type,
        data,
      });
    }
  } catch (error) {
    console.error('❌ notifyAdmins error:', error);
  }
};

const notifyAvailableAidants = async (title, body, type, data = {}) => {
  try {
    const { data: aidants, error } = await supabase
      .from('aidants')
      .select('user_id')
      .eq('available', true)
      .eq('is_verified', true)
      .eq('status', 'approved');

    if (error) throw error;
    if (!aidants || aidants.length === 0) return;

    for (const aidant of aidants) {
      await createNotification({
        userId: aidant.user_id,
        title,
        body,
        type,
        data,
      });
    }
  } catch (error) {
    console.error('❌ notifyAvailableAidants error:', error);
  }
};

const notifyPatientFamily = async (patientId, title, body, type, data = {}) => {
  try {
    const { data: links, error } = await supabase
      .from('patient_family_links')
      .select('family_id')
      .eq('patient_id', patientId);

    if (error) throw error;
    if (!links || links.length === 0) return;

    for (const link of links) {
      await createNotification({
        userId: link.family_id,
        title,
        body,
        type,
        data: { ...data, patient_id: patientId },
      });
    }
  } catch (error) {
    console.error('❌ notifyPatientFamily error:', error);
  }
};

const notifyAidant = async (aidantUserId, title, body, type, data = {}) => {
  try {
    await createNotification({
      userId: aidantUserId,
      title,
      body,
      type,
      data,
    });
  } catch (error) {
    console.error('❌ notifyAidant error:', error);
  }
};

const notifyFamily = async (familyUserId, title, body, type, data = {}) => {
  try {
    await createNotification({
      userId: familyUserId,
      title,
      body,
      type,
      data,
    });
  } catch (error) {
    console.error('❌ notifyFamily error:', error);
  }
};

// ============================================================
// 🆕 NOUVELLES FONCTIONS POUR LE SYSTÈME COMPLET
// ============================================================

// ============================================================
// 1. COMMANDES
// ============================================================

/**
 * Notifie les aidants disponibles d'une nouvelle commande
 * Filtre ceux qui ont de la place (current_orders < max_orders)
 */
const notifyAvailableAidantsForOrder = async (orderId, { targetDisplay, description, urgency = false }) => {
  try {
    // Récupérer tous les aidants disponibles
    const { data: aidants, error } = await supabase
      .from('aidants')
      .select('user_id, current_orders, max_orders')
      .eq('available', true)
      .eq('is_verified', true)
      .eq('status', 'approved');

    if (error) {
      console.error('❌ notifyAvailableAidantsForOrder error:', error);
      return;
    }

    if (!aidants || aidants.length === 0) {
      console.log('ℹ️ Aucun aidant disponible pour la commande');
      return;
    }

    // Filtrer ceux qui ont de la place (current_orders < max_orders)
    const availableAidants = aidants.filter(a => {
      const current = a.current_orders || 0;
      const max = a.max_orders || 2;
      return current < max;
    });

    if (availableAidants.length === 0) {
      console.log('ℹ️ Tous les aidants ont atteint leur quota de commandes');
      return;
    }

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
        },
      });
    }

    console.log(`✅ ${availableAidants.length} aidants notifiés pour la commande ${orderId}`);
  } catch (error) {
    console.error('❌ notifyAvailableAidantsForOrder error:', error);
  }
};

/**
 * Notifie un aidant qu'une commande lui a été assignée
 */
const notifyAidantOfOrderAssignment = async (aidantUserId, orderId, { targetDisplay, description }) => {
  try {
    await createNotification({
      userId: aidantUserId,
      title: '📦 Commande assignée automatiquement',
      body: `Une commande pour ${targetDisplay} - ${description} vous a été assignée.`,
      type: NOTIFICATION_TYPES.ORDER,
      data: {
        order_id: orderId,
        action: 'take',
        auto_assigned: true,
      },
    });
  } catch (error) {
    console.error('❌ notifyAidantOfOrderAssignment error:', error);
  }
};

/**
 * Notifie la famille qu'une commande a été prise
 */
const notifyFamilyOfOrderTaken = async (familyUserId, orderId, { targetDisplay, description, aidantName }) => {
  try {
    await createNotification({
      userId: familyUserId,
      title: '✅ Commande prise en charge',
      body: `${aidantName || 'Un aidant'} a pris votre commande "${description}" pour ${targetDisplay}.`,
      type: NOTIFICATION_TYPES.ORDER,
      data: {
        order_id: orderId,
        status: 'en_cours',
      },
    });
  } catch (error) {
    console.error('❌ notifyFamilyOfOrderTaken error:', error);
  }
};

/**
 * Notifie la famille qu'une commande a été livrée
 */
const notifyFamilyOfOrderDelivered = async (familyUserId, orderId, { targetDisplay, description }) => {
  try {
    await createNotification({
      userId: familyUserId,
      title: '📦 Commande livrée',
      body: `Votre commande "${description}" pour ${targetDisplay} a été livrée avec succès !`,
      type: NOTIFICATION_TYPES.ORDER,
      data: {
        order_id: orderId,
        status: 'livree',
      },
    });
  } catch (error) {
    console.error('❌ notifyFamilyOfOrderDelivered error:', error);
  }
};

/**
 * Notifie la famille qu'une commande a été validée
 */
const notifyFamilyOfOrderValidated = async (familyUserId, orderId, { targetDisplay, description }) => {
  try {
    await createNotification({
      userId: familyUserId,
      title: '✅ Commande validée',
      body: `Votre commande "${description}" pour ${targetDisplay} a été validée.`,
      type: NOTIFICATION_TYPES.ORDER,
      data: {
        order_id: orderId,
        status: 'validee',
      },
    });
  } catch (error) {
    console.error('❌ notifyFamilyOfOrderValidated error:', error);
  }
};

// ============================================================
// 2. VISITES
// ============================================================

/**
 * Notifie les admins d'une visite en attente d'aidant
 */
const notifyAdminsForPendingAidant = async (visitId, { targetName, scheduledDate, scheduledTime }) => {
  try {
    const { data: admins, error } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (error) {
      console.error('❌ notifyAdminsForPendingAidant error:', error);
      return;
    }

    if (!admins || admins.length === 0) {
      console.log('ℹ️ Aucun admin à notifier');
      return;
    }

    for (const admin of admins) {
      await createNotification({
        userId: admin.id,
        title: '🚨 Visite planifiée sans aidant disponible !',
        body: `Visite pour ${targetName} le ${scheduledDate} à ${scheduledTime}. Tous les aidants sont complets (4/4).`,
        type: NOTIFICATION_TYPES.ALERT,
        data: {
          visit_id: visitId,
          action: 'assign_aidant',
          urgency: 'high',
          target_name: targetName,
          scheduled_date: scheduledDate,
          scheduled_time: scheduledTime,
        },
      });
    }

    console.log(`✅ ${admins.length} admins notifiés pour la visite ${visitId} (en attente d'aidant)`);
  } catch (error) {
    console.error('❌ notifyAdminsForPendingAidant error:', error);
  }
};

/**
 * Notifie un aidant qu'une visite lui a été assignée
 */
const notifyAidantOfVisitAssignment = async (aidantUserId, visitId, { targetName, scheduledDate, scheduledTime, assignmentType = 'permanente', forced = false }) => {
  try {
    const title = forced ? '👔 Visite assignée par l\'admin (forcée)' : '📅 Nouvelle visite assignée';
    const body = `Visite pour ${targetName} le ${scheduledDate} à ${scheduledTime} (${assignmentType})`;

    await createNotification({
      userId: aidantUserId,
      title,
      body,
      type: NOTIFICATION_TYPES.VISIT,
      data: {
        visit_id: visitId,
        action: 'approve',
        assignment_type: assignmentType,
        forced: forced,
      },
    });
  } catch (error) {
    console.error('❌ notifyAidantOfVisitAssignment error:', error);
  }
};

/**
 * Notifie la famille qu'une visite a été planifiée
 */
const notifyFamilyOfVisitPlanned = async (familyUserId, visitId, { targetName, scheduledDate, scheduledTime }) => {
  try {
    await createNotification({
      userId: familyUserId,
      title: '📅 Nouvelle visite planifiée',
      body: `Une visite pour ${targetName} a été planifiée le ${scheduledDate} à ${scheduledTime}.`,
      type: NOTIFICATION_TYPES.VISIT,
      data: {
        visit_id: visitId,
        status: 'planifiee',
      },
    });
  } catch (error) {
    console.error('❌ notifyFamilyOfVisitPlanned error:', error);
  }
};

/**
 * Notifie la famille qu'une visite est en attente d'aidant
 */
const notifyFamilyOfPendingAidant = async (familyUserId, visitId, { targetName }) => {
  try {
    await createNotification({
      userId: familyUserId,
      title: '⏳ Visite en attente d\'aidant',
      body: `Votre visite pour ${targetName} est en attente d'assignation. L'administration a été notifiée.`,
      type: NOTIFICATION_TYPES.VISIT,
      data: {
        visit_id: visitId,
        status: 'en_attente_aidant',
      },
    });
  } catch (error) {
    console.error('❌ notifyFamilyOfPendingAidant error:', error);
  }
};

/**
 * Notifie la famille qu'une visite a été acceptée par l'aidant
 */
const notifyFamilyOfVisitAccepted = async (familyUserId, visitId, { targetName, scheduledDate, aidantName }) => {
  try {
    await createNotification({
      userId: familyUserId,
      title: '✅ Visite acceptée',
      body: `${aidantName || 'L\'aidant'} a accepté la visite pour ${targetName} le ${scheduledDate}.`,
      type: NOTIFICATION_TYPES.VISIT,
      data: {
        visit_id: visitId,
        status: 'acceptee',
      },
    });
  } catch (error) {
    console.error('❌ notifyFamilyOfVisitAccepted error:', error);
  }
};

/**
 * Notifie la famille qu'une visite a été refusée par l'aidant
 */
const notifyFamilyOfVisitRefused = async (familyUserId, visitId, { targetName, scheduledDate, reason }) => {
  try {
    await createNotification({
      userId: familyUserId,
      title: '❌ Visite refusée',
      body: `L'aidant a refusé la visite pour ${targetName} le ${scheduledDate}. Motif: ${reason || 'Non spécifié'}`,
      type: NOTIFICATION_TYPES.VISIT,
      data: {
        visit_id: visitId,
        status: 'refusee',
      },
    });
  } catch (error) {
    console.error('❌ notifyFamilyOfVisitRefused error:', error);
  }
};

/**
 * Notifie la famille qu'une visite est en cours
 */
const notifyFamilyOfVisitInProgress = async (familyUserId, visitId, { targetName, aidantName }) => {
  try {
    await createNotification({
      userId: familyUserId,
      title: '🔄 Visite en cours',
      body: `${aidantName || 'L\'aidant'} a commencé la visite de ${targetName}.`,
      type: NOTIFICATION_TYPES.VISIT,
      data: {
        visit_id: visitId,
        status: 'en_cours',
      },
    });
  } catch (error) {
    console.error('❌ notifyFamilyOfVisitInProgress error:', error);
  }
};

/**
 * Notifie la famille qu'une visite est terminée (en attente validation)
 */
const notifyFamilyOfVisitCompleted = async (familyUserId, visitId, { targetName }) => {
  try {
    await createNotification({
      userId: familyUserId,
      title: '📋 Visite terminée - En attente de validation',
      body: `La visite de ${targetName} est terminée. L'aidant a soumis son rapport.`,
      type: NOTIFICATION_TYPES.VISIT,
      data: {
        visit_id: visitId,
        status: 'terminee',
      },
    });
  } catch (error) {
    console.error('❌ notifyFamilyOfVisitCompleted error:', error);
  }
};

/**
 * Notifie la famille qu'une visite a été validée
 */
const notifyFamilyOfVisitValidated = async (familyUserId, visitId, { targetName }) => {
  try {
    await createNotification({
      userId: familyUserId,
      title: '✅ Visite validée',
      body: `La visite de ${targetName} a été validée.`,
      type: NOTIFICATION_TYPES.VISIT,
      data: {
        visit_id: visitId,
        status: 'validee',
      },
    });
  } catch (error) {
    console.error('❌ notifyFamilyOfVisitValidated error:', error);
  }
};

// ============================================================
// 3. PAIEMENTS
// ============================================================

/**
 * Notifie un utilisateur qu'un paiement est requis
 */
const notifyPaymentRequired = async (userId, { amount, description, type = 'visit', id }) => {
  try {
    const typeLabel = type === 'visit' ? 'visite' : 'commande';
    await createNotification({
      userId,
      title: '💳 Paiement requis',
      body: `Un paiement de ${amount.toLocaleString()} FCFA est requis pour valider votre ${typeLabel} "${description}".`,
      type: NOTIFICATION_TYPES.PAYMENT,
      data: {
        [`${type}_id`]: id,
        action: 'pay',
        amount,
        type,
      },
    });
  } catch (error) {
    console.error('❌ notifyPaymentRequired error:', error);
  }
};

/**
 * Notifie un utilisateur qu'un paiement a été confirmé
 */
const notifyPaymentConfirmed = async (userId, { amount, description, type = 'visit', id }) => {
  try {
    const typeLabel = type === 'visit' ? 'visite' : 'commande';
    await createNotification({
      userId,
      title: '✅ Paiement confirmé',
      body: `Votre paiement de ${amount.toLocaleString()} FCFA pour la ${typeLabel} "${description}" a été confirmé.`,
      type: NOTIFICATION_TYPES.PAYMENT,
      data: {
        [`${type}_id`]: id,
        status: 'payé',
      },
    });
  } catch (error) {
    console.error('❌ notifyPaymentConfirmed error:', error);
  }
};

// ============================================================
// 4. RAPPELS
// ============================================================

/**
 * Envoie un rappel de visite 24h avant
 */
const sendVisitReminder = async (visitId, { targetName, scheduledDate, scheduledTime, aidantName, familyId, aidantUserId }) => {
  try {
    // Rappel à la famille
    if (familyId) {
      await createNotification({
        userId: familyId,
        title: '⏰ Rappel de visite',
        body: `Visite pour ${targetName} demain le ${scheduledDate} à ${scheduledTime}.`,
        type: NOTIFICATION_TYPES.REMINDER,
        data: {
          visit_id: visitId,
          action: 'view',
        },
      });
    }

    // Rappel à l'aidant
    if (aidantUserId) {
      await createNotification({
        userId: aidantUserId,
        title: '⏰ Rappel de visite',
        body: `Visite pour ${targetName} demain le ${scheduledDate} à ${scheduledTime}.`,
        type: NOTIFICATION_TYPES.REMINDER,
        data: {
          visit_id: visitId,
          action: 'prepare',
        },
      });
    }
  } catch (error) {
    console.error('❌ sendVisitReminder error:', error);
  }
};

// ============================================================
// 5. EXPIRATIONS
// ============================================================

/**
 * Notifie les admins qu'une visite est expirée
 */
const notifyVisitExpired = async (visitId, { targetName, scheduledDate, reason = 'Sans réponse de l\'aidant' }) => {
  try {
    await notifyAdmins(
      '⏰ Visite expirée - Réassignation nécessaire',
      `La visite de ${targetName} le ${scheduledDate} a expiré. Motif: ${reason}`,
      NOTIFICATION_TYPES.ALERT,
      {
        visit_id: visitId,
        action: 'reassign',
        urgency: 'high',
      }
    );
  } catch (error) {
    console.error('❌ notifyVisitExpired error:', error);
  }
};

/**
 * Notifie qu'une commande est disponible (urgente)
 */
const notifyOrderAvailable = async (orderId, { targetDisplay, description }) => {
  try {
    await notifyAvailableAidantsForOrder(orderId, {
      targetDisplay,
      description,
      urgency: true,
    });
  } catch (error) {
    console.error('❌ notifyOrderAvailable error:', error);
  }
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Fonctions existantes
  registerToken,
  removeToken,
  sendPushNotification,
  createNotification,
  notifyPatientAidants,
  notifyAdmins,
  notifyAvailableAidants,
  notifyPatientFamily,
  notifyAidant,
  notifyFamily,

  // 🆕 Commandes
  notifyAvailableAidantsForOrder,
  notifyAidantOfOrderAssignment,
  notifyFamilyOfOrderTaken,
  notifyFamilyOfOrderDelivered,
  notifyFamilyOfOrderValidated,

  // 🆕 Visites
  notifyAdminsForPendingAidant,
  notifyAidantOfVisitAssignment,
  notifyFamilyOfVisitPlanned,
  notifyFamilyOfPendingAidant,
  notifyFamilyOfVisitAccepted,
  notifyFamilyOfVisitRefused,
  notifyFamilyOfVisitInProgress,
  notifyFamilyOfVisitCompleted,
  notifyFamilyOfVisitValidated,

  // 🆕 Paiements
  notifyPaymentRequired,
  notifyPaymentConfirmed,

  // 🆕 Rappels
  sendVisitReminder,

  // 🆕 Expirations
  notifyVisitExpired,
  notifyOrderAvailable,
};
