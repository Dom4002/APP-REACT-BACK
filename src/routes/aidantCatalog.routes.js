// 📁 backend/src/routes/aidantCatalog.routes.js

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const roleMiddleware = require('../middleware/role.middleware');
const {
  getCatalog,
  getAidant,
  assignAidant,
  getMyAssignments,
  revokeAssignmentController,
  getActiveAidant,
} = require('../controllers/aidantCatalog.controller');

// Toutes les routes nécessitent une authentification
router.use(authMiddleware);

// ============================================================
// ⚠️ IMPORTANT : ROUTES SPÉCIFIQUES AVANT LES ROUTES AVEC PARAMÈTRES
// ============================================================

// GET /api/aidants/catalog
// Récupère la liste des aidants disponibles avec filtres
router.get('/catalog', getCatalog);

// GET /api/aidants/active
// Récupère l'aidant actif pour une cible
router.get('/active', getActiveAidant);

// GET /api/aidants/my-assignments
// Récupère les assignations de la famille connectée
router.get('/my-assignments', roleMiddleware(['family']), getMyAssignments);

// POST /api/aidants/assign
// Assigner un aidant à un patient ou à un compte personnel (famille uniquement)
router.post('/assign', roleMiddleware(['family']), assignAidant);

// DELETE /api/aidants/assignments/:id
// Révoquer une assignation (famille uniquement)
router.delete('/assignments/:id', roleMiddleware(['family']), revokeAssignmentController);

// ============================================================
// ✅ ROUTE GET /api/aidants/:id - ACCESSIBLE À TOUS LES UTILISATEURS AUTHENTIFIÉS
// ============================================================
// ✅ IMPORTANT : Cette route doit être accessible à tous les rôles authentifiés
router.get('/:id', authMiddleware, getAidant);

module.exports = router;
