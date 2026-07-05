// 📁 backend/src/routes/notification.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { createNotification } = require('../services/notification.service');

router.use(authMiddleware);

// =============================================
// LISTE DES NOTIFICATIONS
// =============================================
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ ROUTE DE TEST - SANS AUTH (pour faciliter les tests)
// =============================================
router.post('/test', async (req, res) => {
  try {
    const { userId, title, body, type } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId est requis'
      });
    }

    console.log('📨 Envoi notification de test à:', userId);
    console.log('📨 Titre:', title);
    console.log('📨 Corps:', body);

    // ✅ Vérifier que l'utilisateur existe
    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        success: false,
        error: 'Utilisateur non trouvé'
      });
    }

    // ✅ Créer la notification en base
    const notificationData = {
      user_id: userId,
      title: title || '🔔 Notification de test',
      body: body || 'Ceci est une notification de test depuis le backend.',
      type: type || 'system',
      is_read: false,
      is_sent: true,
      sent_at: new Date().toISOString(),
      is_delivered: true,
      delivered_at: new Date().toISOString(),
      data: {
        test: true,
        timestamp: new Date().toISOString(),
        source: 'test-route'
      }
    };

    const { data: notification, error } = await supabase
      .from('notifications')
      .insert(notificationData)
      .select()
      .single();

    if (error) throw error;

    // ✅ Envoyer une notification push si Firebase est configuré
    try {
      const { sendPushNotification } = require('../services/notification.service');
      await sendPushNotification(
        userId,
        notification.title,
        notification.body,
        notification.data
      );
      console.log('✅ Push notification envoyée');
    } catch (pushError) {
      console.warn('⚠️ Erreur push notification:', pushError.message);
    }

    res.json({
      success: true,
      message: 'Notification de test envoyée avec succès',
      notification: notification,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email
      }
    });
  } catch (error) {
    console.error('❌ Test notification error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// NOMBRE DE NOTIFICATIONS NON LUES
// =============================================
router.get('/unread-count', async (req, res) => {
  try {
    const userId = req.user.id;

    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) throw error;
    res.json({ unread: count || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// MARQUER COMME LU
// =============================================
router.put('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// TOUT MARQUER COMME LU
// =============================================
router.put('/read-all', async (req, res) => {
  try {
    const userId = req.user.id;

    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ENREGISTRER UN TOKEN PUSH
// =============================================
router.post('/register-token', async (req, res) => {
  try {
    const { token, device_info } = req.body;
    const userId = req.user.id;

    // Supprimer l'ancien token s'il existe
    await supabase
      .from('push_tokens')
      .delete()
      .eq('token', token);

    // Enregistrer le nouveau token
    const { error } = await supabase
      .from('push_tokens')
      .insert({
        user_id: userId,
        token,
        device_info: device_info || 'web',
      });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// SUPPRIMER UN TOKEN PUSH
// =============================================
router.post('/remove-token', async (req, res) => {
  try {
    const { token } = req.body;
    const userId = req.user.id;

    if (token && token !== 'all') {
      await supabase
        .from('push_tokens')
        .delete()
        .eq('token', token)
        .eq('user_id', userId);
    } else {
      await supabase
        .from('push_tokens')
        .delete()
        .eq('user_id', userId);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
