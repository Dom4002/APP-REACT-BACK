// 📁 backend/src/routes/push.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');

// ✅ Toutes les routes nécessitent une authentification
router.use(authMiddleware);

// ============================================================
// TEST VAPID - ROUTE DE TEST POUR VÉRIFIER LES PUSH
// ============================================================
router.post('/test-vapid', async (req, res) => {
  try {
    const userId = req.body.userId || req.user.id;
    
    console.log(`🧪 Test VAPID pour l'utilisateur: ${userId}`);

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

    // ✅ Récupérer les tokens push de l'utilisateur
    const { data: tokens, error: tokensError } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (tokensError) throw tokensError;

    if (!tokens || tokens.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Aucun token push trouvé pour cet utilisateur'
      });
    }

    console.log(`📋 ${tokens.length} token(s) push trouvés`);

    // ✅ Créer la notification en base
    const { data: notification, error: notifError } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title: '🔔 Test VAPID',
        body: 'Cette notification push utilise VAPID pour fonctionner en arrière-plan !',
        type: 'system',
        data: { test: true, vapid: true },
        is_read: false,
        is_sent: true,
        sent_at: new Date().toISOString(),
        is_delivered: true,
        delivered_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (notifError) {
      console.error('❌ Erreur création notification:', notifError);
    }

    res.json({
      success: true,
      message: '✅ Notification push test créée en base',
      notification: notification || null,
      tokens_found: tokens.length,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email
      }
    });

  } catch (error) {
    console.error('❌ Erreur test VAPID:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================================
// ENVOYER UNE NOTIFICATION PUSH (AVEC VAPID)
// ============================================================
router.post('/send', async (req, res) => {
  try {
    const { userId, title, body, data } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId est requis'
      });
    }

    // ✅ Créer la notification en base
    const { data: notification, error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title: title || 'Santé Plus Services',
        body: body || 'Vous avez une nouvelle notification',
        type: data?.type || 'system',
        data: data || {},
        is_read: false,
        is_sent: true,
        sent_at: new Date().toISOString(),
        is_delivered: true,
        delivered_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Notification push envoyée',
      notification
    });
  } catch (error) {
    console.error('❌ Erreur send push:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
