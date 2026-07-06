// 📁 backend/src/routes/push.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');
const { sendPushToUser, sendPushToMultipleUsers } = require('../services/push.service');
const rateLimit = require('express-rate-limit');

// ✅ Rate limiting spécifique pour les push
const pushLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 notifications par minute par utilisateur
  message: { error: 'Trop de notifications envoyées' },
});

router.use(authMiddleware);

// ============================================================
// ENVOYER UNE NOTIFICATION
// ============================================================
router.post('/send', pushLimiter, async (req, res) => {
  try {
    const { userId, title, body, data, url } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId requis' });
    }

    const payload = {
      title: title || 'Santé Plus Services',
      body: body || 'Vous avez une nouvelle notification',
      icon: '/icon-192.png',
      badge: '/icon-72.png',
      data: data || {},
      url: url || '/app',
      tag: data?.tag || `notification_${Date.now()}`,
      timestamp: new Date().toISOString(),
    };

    console.log(`📤 Envoi push à l'utilisateur ${userId}`);

    const result = await sendPushToUser(userId, payload);

    res.json({
      success: result.success,
      message: result.success ? 'Notification envoyée' : 'Erreur lors de l\'envoi',
      sent: result.sent || 0,
      total: result.total || 0,
      queueStats: result.queueStats,
    });
  } catch (error) {
    console.error('❌ Erreur send push:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// ENVOI EN BATCH (ADMIN)
// ============================================================
router.post('/send-batch', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { userIds, title, body, data, url } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, error: 'userIds requis' });
    }

    if (userIds.length > 1000) {
      return res.status(400).json({ success: false, error: 'Maximum 1000 utilisateurs par lot' });
    }

    const payload = {
      title: title || 'Santé Plus Services',
      body: body || 'Vous avez une nouvelle notification',
      icon: '/icon-192.png',
      badge: '/icon-72.png',
      data: data || {},
      url: url || '/app',
      tag: data?.tag || `notification_${Date.now()}`,
      timestamp: new Date().toISOString(),
    };

    console.log(`📤 Envoi batch à ${userIds.length} utilisateurs`);

    const result = await sendPushToMultipleUsers(userIds, payload);

    res.json({
      success: true,
      total: userIds.length,
      results: result,
    });
  } catch (error) {
    console.error('❌ Erreur send-batch:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// STATISTIQUES (ADMIN)
// ============================================================
router.get('/stats', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const [
      { count: total },
      { count: active },
      { count: inactive },
      { data: recent }
    ] = await Promise.all([
      supabase.from('push_tokens').select('*', { count: 'exact', head: true }),
      supabase.from('push_tokens').select('*', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('push_tokens').select('*', { count: 'exact', head: true }).eq('is_active', false),
      supabase.from('push_tokens').select('*').order('last_used_at', { ascending: false }).limit(10),
    ]);

    res.json({
      success: true,
      data: {
        total,
        active,
        inactive,
        recent,
        queueStats: require('../services/push.service').notificationQueue.stats,
      },
    });
  } catch (error) {
    console.error('❌ Erreur stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
