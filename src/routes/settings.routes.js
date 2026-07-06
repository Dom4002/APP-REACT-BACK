// 📁 backend/src/routes/settings.routes.js

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');
const {
  getAllSettings,
  getSettingsByCategory,
  getSettingByKey,
  updateSetting,
  updateSettings,
  getPublicSettings,
} = require('../services/settings.service');

// Toutes les routes nécessitent une authentification
router.use(authMiddleware);

// =============================================
// GET /api/settings
// Récupère tous les paramètres (admin uniquement)
// =============================================
router.get('/', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const settings = await getAllSettings();
    res.json({ success: true, data: settings });
  } catch (error) {
    console.error('❌ Get settings error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// GET /api/settings/public
// Récupère les paramètres publics
// =============================================
router.get('/public', async (req, res) => {
  try {
    const settings = await getPublicSettings();
    res.json({ success: true, data: settings });
  } catch (error) {
    console.error('❌ Get public settings error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// GET /api/settings/category/:category
// Récupère les paramètres par catégorie
// =============================================
router.get('/category/:category', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { category } = req.params;
    const settings = await getSettingsByCategory(category);
    res.json({ success: true, data: settings });
  } catch (error) {
    console.error('❌ Get settings by category error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// GET /api/settings/:key
// Récupère un paramètre spécifique
// =============================================
router.get('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const setting = await getSettingByKey(key);
    
    if (!setting) {
      return res.status(404).json({ success: false, error: 'Paramètre non trouvé' });
    }
    
    res.json({ success: true, data: setting });
  } catch (error) {
    console.error('❌ Get setting error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// PUT /api/settings/:key
// Met à jour un paramètre
// =============================================
router.put('/:key', roleMiddleware(['admin']), async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    const userId = req.user.id;

    if (value === undefined) {
      return res.status(400).json({ success: false, error: 'La valeur est requise' });
    }

    const setting = await updateSetting(key, value, userId);
    res.json({ success: true, data: setting });
  } catch (error) {
    console.error('❌ Update setting error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// PUT /api/settings
// Met à jour plusieurs paramètres
// =============================================
router.put('/', roleMiddleware(['admin']), async (req, res) => {
  try {
    const { settings } = req.body;
    const userId = req.user.id;

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ success: false, error: 'Les paramètres sont requis' });
    }

    const results = await updateSettings(settings, userId);
    res.json({ success: true, data: results });
  } catch (error) {
    console.error('❌ Update settings error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
