// 📁 backend/src/services/notification.service.js

const admin = require('firebase-admin');
const { supabase } = require('./supabase.service');

// ✅ Initialisation Firebase Admin (backend seulement)
if (process.env.FIREBASE_PROJECT_ID) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

// ✅ Enregistrer le token (backend)
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

// ✅ Supprimer le token (backend)
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

// ✅ Envoyer les notifications push (backend)
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
      return response;
    }

  } catch (error) {
    console.error('Send push notification error:', error);
    throw error;
  }
};

// ✅ Créer une notification en base + envoyer push (backend)
const createNotification = async ({ userId, title, body, type, data = {} }) => {
  try {
    // Sauvegarder en base
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

    // Envoyer push
    await sendPushNotification(userId, title, body, data);

    return notification;
  } catch (error) {
    console.error('Create notification error:', error);
    throw error;
  }
};

module.exports = {
  registerToken,
  removeToken,
  sendPushNotification,
  createNotification,
};