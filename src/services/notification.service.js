// 📁 backend/src/services/notification.service.js
 
const admin = require('firebase-admin');
const { supabase } = require('./supabase.service');

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

// =============================================
// ✅ ENREGISTRER LE TOKEN
// =============================================
const registerToken = async (userId, token, deviceInfo) => {
  try {
    await supabase
      .from('push_tokens')
      .insert({
        user_id: userId,
        token,
        device_info: deviceInfo,
      })
      .onConflict('token')
      .merge();
    
    return true;
  } catch (error) {
    console.error('Register token error:', error);
    throw error;
  }
};

// =============================================
// ✅ SUPPRIMER LE TOKEN
// =============================================
const removeToken = async (token) => {
  try {
    await supabase
      .from('push_tokens')
      .delete()
      .eq('token', token);
    return true;
  } catch (error) {
    console.error('Remove token error:', error);
    throw error;
  }
};

// =============================================
// ✅ ENVOYER LES NOTIFICATIONS PUSH
// =============================================
// ✅ Envoyer les notifications push (backend) avec logs d'erreurs précis
const sendPushNotification = async (userId, title, body, data = {}) => {
  try {
    // Récupérer les tokens
    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId);

    if (!tokens || tokens.length === 0) return;

    const tokensList = tokens.map(t => t.token);

    // Envoyer via Firebase Admin (backend)
    if (admin.apps.length > 0) {
      const message = {
        notification: { title, body },
        data: data,
        tokens: tokensList,
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      console.log('Push notification sent:', response);

      // 🔥 CORRECTIF DE LOGS : Afficher la cause exacte du rejet par Google
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(`❌ Échec d'envoi pour le token n°${idx + 1} (${tokensList[idx].substring(0, 15)}...) :`, {
            code: resp.error?.code,
            message: resp.error?.message
          });
        }
      });

      return response;
    }

  } catch (error) {
    console.error('Send push notification error:', error);
    throw error;
  }
};
// =============================================
// ✅ CRÉER UNE NOTIFICATION EN BASE + ENVOYER PUSH
// =============================================
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
      })
      .select()
      .single();

    if (error) throw error;

    await sendPushNotification(userId, title, body, data);

    return notification;
  } catch (error) {
    console.error('Create notification error:', error);
    throw error;
  }
};

// =============================================
// ✅ ENVOYER UNE NOTIFICATION À TOUS LES AIDANTS D'UN PATIENT
// =============================================
const notifyPatientAidants = async (patientId, title, body, type, data = {}) => {
  try {
    // Récupérer les aidants assignés à ce patient
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
    console.error('Notify patient aidants error:', error);
  }
};

// =============================================
// ✅ ENVOYER UNE NOTIFICATION À TOUS LES ADMINISTRATEURS
// =============================================
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
    console.error('Notify admins error:', error);
  }
};

// =============================================
// ✅ ENVOYER UNE NOTIFICATION À TOUS LES AIDANTS DISPONIBLES
// =============================================
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
    console.error('Notify available aidants error:', error);
  }
};

// =============================================
// ✅ ENVOYER UNE NOTIFICATION À LA FAMILLE D'UN PATIENT
// =============================================
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
    console.error('Notify patient family error:', error);
  }
};

// =============================================
// ✅ ENVOYER UNE NOTIFICATION À UN AIDANT SPÉCIFIQUE
// =============================================
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
    console.error('Notify aidant error:', error);
  }
};

// =============================================
// ✅ ENVOYER UNE NOTIFICATION À UNE FAMILLE SPÉCIFIQUE
// =============================================
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
    console.error('Notify family error:', error);
  }
};

module.exports = {
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
};
