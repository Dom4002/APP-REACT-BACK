// 📁 backend/src/routes/push.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const roleMiddleware = require('../middleware/role.middleware');
const {
  sendPushToUser,
  sendPushToMultipleUsers,
  sendPushToAvailableAidants,
} = require('../services/push.service');

// ✅ Toutes les routes nécessitent une authentification
router.use(authMiddleware);

// ============================================================
// ENVOYER UNE NOTIFICATION PUSH À UN UTILISATEUR
// ============================================================
router.post('/send', async (req, res) => {
  try {
    const { userId, title, body, data, url } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId est requis'
      });
    }

    if (!title && !body) {
      return res.status(400).json({
        success: false,
        error: 'title ou body est requis'
      });
    }

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

    // ✅ Créer le payload
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

    console.log(`📤 Envoi push à l'utilisateur ${userId}:`, payload.title);

    // ✅ Envoyer la notification push
    const result = await sendPushToUser(userId, payload);

    // ✅ Créer la notification en base
    if (result.success) {
      await supabase
        .from('notifications')
        .insert({
          user_id: userId,
          title: payload.title,
          body: payload.body,
          type: data?.type || 'system',
          data: data || {},
          is_read: false,
          is_sent: true,
          sent_at: new Date().toISOString(),
          is_delivered: true,
          delivered_at: new Date().toISOString(),
        });
    }

    res.json({
      success: result.success,
      message: result.success ? 'Notification push envoyée' : 'Erreur lors de l\'envoi',
      sent: result.sent || 0,
      total: result.total || 0,
      results: result.results || [],
    });
  } catch (error) {
    console.error('❌ Erreur send push:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// ENVOYER À PLUSIEURS UTILISATEURS (ADMIN)
// ============================================================
router.post('/send-multiple', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { userIds, title, body, data, url } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'userIds est requis (tableau)'
      });
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

    console.log(`📤 Envoi push à ${userIds.length} utilisateurs`);

    const results = [];
    for (const userId of userIds) {
      const result = await sendPushToUser(userId, payload);
      results.push({ userId, ...result });
    }

    res.json({
      success: true,
      sent: results.filter(r => r.sent > 0).length,
      total: userIds.length,
      results,
    });
  } catch (error) {
    console.error('❌ Erreur send-multiple:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// ENVOYER À TOUS LES AIDANTS DISPONIBLES (ADMIN)
// ============================================================
router.post('/send-to-aidants', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { title, body, data, url } = req.body;

    const payload = {
      title: title || '📢 Message aux aidants',
      body: body || 'Nouvelle information disponible',
      icon: '/icon-192.png',
      badge: '/icon-72.png',
      data: data || {},
      url: url || '/app',
      tag: data?.tag || `aidants_${Date.now()}`,
      timestamp: new Date().toISOString(),
    };

    console.log('📤 Envoi push à tous les aidants disponibles');

    const result = await sendPushToAvailableAidants(payload);

    res.json({
      success: true,
      sent: result.sent || 0,
      total: result.total || 0,
      results: result.results || [],
    });
  } catch (error) {
    console.error('❌ Erreur send-to-aidants:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// TEST DE NOTIFICATION PUSH (VAPID)
// ============================================================
router.post('/test-vapid', async (req, res) => {
  try {
    const { userId } = req.body;
    const targetUserId = userId || req.user.id;

    console.log(`🧪 Test VAPID pour l'utilisateur: ${targetUserId}`);

    const payload = {
      title: '🔔 Test VAPID',
      body: 'Cette notification push utilise VAPID pour fonctionner en arrière-plan !',
      icon: '/icon-192.png',
      badge: '/icon-72.png',
      data: { test: true, vapid: true },
      url: '/app/notifications',
      tag: `test_vapid_${Date.now()}`,
      timestamp: new Date().toISOString(),
    };

    const result = await sendPushToUser(targetUserId, payload);

    // ✅ Créer la notification en base
    await supabase
      .from('notifications')
      .insert({
        user_id: targetUserId,
        title: payload.title,
        body: payload.body,
        type: 'system',
        data: payload.data,
        is_read: false,
        is_sent: true,
        sent_at: new Date().toISOString(),
        is_delivered: true,
        delivered_at: new Date().toISOString(),
      });

    res.json({
      success: result.success,
      message: result.success ? '✅ Test VAPID réussi !' : '❌ Échec du test VAPID',
      sent: result.sent || 0,
      total: result.total || 0,
      details: result.results || [],
    });
  } catch (error) {
    console.error('❌ Erreur test VAPID:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
