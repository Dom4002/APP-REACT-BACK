// 📁 backend/src/routes/notifications.routes.js
// ✅ ROUTES NOTIFICATIONS HTTP ET ADMIN API

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { sendPushNotification } = require('../services/notification.service');

// ============================================================
// TEST NOTIFICATION (Public pour debug)
// ============================================================
router.post('/test', async (req, res) => {
  try {
    const { userId, title, body } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId est requis' });
    }

    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
    }

    const notificationData = {
      user_id: userId,
      title: title || '🔔 Test notification',
      body: body || 'Ceci est une notification de test.',
      type: 'system',
      is_read: false,
      is_sent: true,
      sent_at: new Date().toISOString(),
      is_delivered: true,
      delivered_at: new Date().toISOString(),
      data: { test: true, source: 'test-route', timestamp: new Date().toISOString() },
    };

    const { data: notification, error } = await supabase
      .from('notifications')
      .insert(notificationData)
      .select()
      .single();

    if (error) throw error;

    await sendPushNotification(userId, notification.title, notification.body, notification.data);

    res.json({
      success: true,
      message: 'Notification de test créée et push envoyé',
      notification,
      user,
    });
  } catch (error) {
    console.error('❌ Test notification error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// AUTH MIDDLEWARE REQUIS POUR LES AUTRES ROUTES
// ============================================================
router.use(authMiddleware);

// LISTE DES NOTIFICATIONS UTILISATEUR
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// COMPTEUR NON LUES
router.get('/unread-count', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false);

    if (error) throw error;
    res.json({ unread: count || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// MARQUER COMME LUE
router.put('/:id/read', async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// TOUT MARQUER COMME LU
router.put('/read-all', async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .eq('is_read', false);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ENREGISTRER UN TOKEN PUSH
router.post('/register-token', async (req, res) => {
  try {
    const { token, device_info } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Token requis' });

    const tokenStr = typeof token === 'object' ? JSON.stringify(token) : String(token);

    const { error } = await supabase
      .from('push_tokens')
      .upsert(
        {
          user_id: req.user.id,
          token: tokenStr,
          device_info: device_info || 'web',
          is_active: true,
          last_used_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'token' }
      );

    if (error) throw error;
    res.json({ success: true, message: 'Token enregistré' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// SUPPRIMER UN TOKEN PUSH
router.post('/remove-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (token && token !== 'all') {
      await supabase.from('push_tokens').delete().eq('user_id', req.user.id).eq('token', token);
    } else {
      await supabase.from('push_tokens').delete().eq('user_id', req.user.id);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// OBTENIR LES TOKENS (ADMIN)
router.get('/tokens', async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', req.user.id).single();
    if (!profile || (profile.role !== 'admin' && profile.role !== 'coordinator')) {
      return res.status(403).json({ success: false, error: 'Non autorisé' });
    }

    const { data, error } = await supabase.from('push_tokens').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
