const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { createNotification } = require('../services/notification.service');

// ============================================================
// ✅ TEST NOTIFICATION (SANS AUTH POUR LES TESTS RAPIDES)
// ============================================================
router.post('/test', async (req, res) => {
  try {
    const { userId, title, body } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId est requis'
      });
    }

    console.log(`📨 Envoi notification test à: ${userId}`);

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
      title: title || '🔔 Test notification',
      body: body || 'Ceci est une notification de test.',
      type: 'system',
      is_read: false,
      is_sent: true,
      sent_at: new Date().toISOString(),
      is_delivered: true,
      delivered_at: new Date().toISOString(),
      data: { 
        test: true, 
        source: 'test-route',
        timestamp: new Date().toISOString()
      }
    };

    const { data: notification, error } = await supabase
      .from('notifications')
      .insert(notificationData)
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ Notification test créée: ${notification.id}`);

    // ✅ Renvoyer la notification dans la réponse
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 🔐 TOUTES LES AUTRES ROUTES CI-DESSOUS NÉCESSITENT UNE AUTH
// ============================================================
router.use(authMiddleware);

// ============================================================
// LISTE DES NOTIFICATIONS
// ============================================================
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

// ============================================================
// NOMBRE DE NOTIFICATIONS NON LUES
// ============================================================
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

// ============================================================
// MARQUER COMME LU
// ============================================================
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

// ============================================================
// TOUT MARQUER COMME LU
// ============================================================
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

// ============================================================
// ENREGISTRER UN TOKEN PUSH (MULTI-APPAREIL CORRIGÉ)
// ============================================================
router.post('/register-token', async (req, res) => {
  try {
    const { token, device_info } = req.body;
    const userId = req.user.id;

    if (!token) {
      return res.status(400).json({ 
        success: false, 
        error: 'Token requis' 
      });
    }

    // ✅ Réalisation d'un UPSERT (Insertion ou mise à jour du token propre à l'appareil)
    // Cela préserve les sessions ouvertes sur d'autres mobiles ou ordinateurs
    const { error } = await supabase
      .from('push_tokens')
      .upsert({
        user_id: userId,
        token: typeof token === 'object' ? JSON.stringify(token) : token,
        device_info: device_info || 'web',
        is_active: true,
        last_used_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'token' // Contrainte d'unicité (UNIQUE ou PRIMARY KEY) sur la colonne 'token'
      });

    if (error) throw error;

    console.log(`✅ Token push enregistré/mis à jour pour l'utilisateur ${userId}`);
    res.json({ success: true, message: 'Token enregistré' });
  } catch (error) {
    console.error('❌ Register token error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// SUPPRIMER UN TOKEN PUSH
// ============================================================
router.post('/remove-token', async (req, res) => {
  try {
    const { token } = req.body;
    const userId = req.user.id;

    if (token && token !== 'all') {
      await supabase
        .from('push_tokens')
        .delete()
        .eq('user_id', userId)
        .eq('token', token);
    } else {
      await supabase
        .from('push_tokens')
        .delete()
        .eq('user_id', userId);
    }

    console.log(`✅ Token push supprimé pour l'utilisateur ${userId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Remove token error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// ✅ GET TOKENS (admin uniquement)
// ============================================================
router.get('/tokens', async (req, res) => {
  try {
    const userId = req.user.id;

    // ✅ Vérifier que l'utilisateur est admin
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single();

    if (profileError || (profile.role !== 'admin' && profile.role !== 'coordinator')) {
      return res.status(403).json({ success: false, error: 'Non autorisé' });
    }

    const { data, error } = await supabase
      .from('push_tokens')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Get tokens error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
