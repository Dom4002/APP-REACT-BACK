const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');

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

module.exports = router;