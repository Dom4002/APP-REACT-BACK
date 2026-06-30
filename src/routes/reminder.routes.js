// 📁 backend/src/routes/reminder.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const roleMiddleware = require('../middleware/role.middleware');
const {
  sendVisitReminder,
  sendDailyReminders,
  sendHourReminder,
  checkSubscriptionExpiry,
  checkExpiredSubscriptions,
  checkMissedVisits,
} = require('../services/reminder.service');

router.use(authMiddleware);

// =============================================
// ENVOYER UN RAPPEL POUR UNE VISITE
// =============================================
router.post('/visit/:id', roleMiddleware(['coordinator', 'admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await sendVisitReminder(id);
    
    if (result.success) {
      res.json({ success: true, message: 'Rappel envoyé' });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    console.error('Send reminder error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ENVOYER TOUS LES RAPPELS (ADMIN)
// =============================================
router.post('/send-daily', roleMiddleware(['admin']), async (req, res) => {
  try {
    const result = await sendDailyReminders();
    res.json({ 
      success: result.success, 
      sent: result.sent, 
      total: result.total 
    });
  } catch (error) {
    console.error('Send daily reminders error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// VÉRIFIER LES ABONNEMENTS EXPIRÉS (ADMIN)
// =============================================
router.post('/check-expired', roleMiddleware(['admin']), async (req, res) => {
  try {
    const result = await checkExpiredSubscriptions();
    res.json({ success: result.success, expired: result.expired });
  } catch (error) {
    console.error('Check expired error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// VÉRIFIER LES VISITES MANQUÉES (ADMIN)
// =============================================
router.post('/check-missed', roleMiddleware(['admin']), async (req, res) => {
  try {
    const result = await checkMissedVisits();
    res.json({ success: result.success, notified: result.notified });
  } catch (error) {
    console.error('Check missed visits error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// RÉCUPÉRER LES RAPPELS EN ATTENTE (AIDANT)
// =============================================
router.get('/pending/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // ✅ Vérifier que l'utilisateur demande ses propres rappels
    if (userId !== req.user.id && req.profile.role !== 'admin') {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const inTwoHours = new Date(now);
    inTwoHours.setHours(inTwoHours.getHours() + 2);
    const timeLimit = inTwoHours.toTimeString().slice(0, 5);

    // ✅ Récupérer les visites à venir (prochaines 2h)
    const { data: visits, error } = await supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*)
      `)
      .eq('scheduled_date', today)
      .eq('aidant_id', userId)
      .eq('status', 'planifiee')
      .gte('scheduled_time', now.toTimeString().slice(0, 5))
      .lt('scheduled_time', timeLimit);

    if (error) throw error;

    res.json(visits || []);
  } catch (error) {
    console.error('Get pending reminders error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;