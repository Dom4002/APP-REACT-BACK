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
router.get('/catalog', async (req, res) => {
  try {
    const filters = {
      zone: req.query.zone,
      specialty: req.query.specialty,
      minRating: req.query.minRating ? parseFloat(req.query.minRating) : undefined,
      onlyAvailable: req.query.onlyAvailable !== 'false',
      minExperience: req.query.minExperience ? parseInt(req.query.minExperience) : undefined,
      sortBy: req.query.sortBy || 'rating',
      sortOrder: req.query.sortOrder || 'desc',
      limit: req.query.limit ? parseInt(req.query.limit) : 20,
      offset: req.query.offset ? parseInt(req.query.offset) : 0,
    };

    console.log('📋 Récupération du catalogue avec filtres:', filters);

    // ✅ Construire la requête SANS la relation automatique
    let query = supabase
      .from('aidants')
      .select('*')
      .eq('is_verified', true)
      .eq('status', 'approved');

    if (filters.zone) {
      query = query.contains('zones', [filters.zone]);
    }

    if (filters.specialty) {
      query = query.contains('specialties', [filters.specialty]);
    }

    if (filters.minRating) {
      query = query.gte('rating', filters.minRating);
    }

    if (filters.onlyAvailable !== false) {
      query = query.eq('available', true);
    }

    if (filters.minExperience) {
      query = query.gte('experience_years', filters.minExperience);
    }

    const sortField = filters.sortBy || 'rating';
    const sortOrder = filters.sortOrder || 'desc';
    query = query.order(sortField, { ascending: sortOrder === 'asc' });

    const limit = filters.limit || 20;
    const offset = filters.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data: aidants, error } = await query;
    if (error) throw error;

    // ✅ Récupérer les profils MANUELLEMENT
    const userIds = (aidants || []).map(a => a.user_id).filter(Boolean);
    let profileMap = {};

    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone, avatar_url, role')
        .in('id', userIds);
      
      if (profiles) {
        profileMap = profiles.reduce((acc, p) => {
          acc[p.id] = p;
          return acc;
        }, {});
      }
    }

    // ✅ Fusionner les données
    const aidantsWithProfiles = (aidants || []).map(aidant => ({
      ...aidant,
      user: aidant.user_id ? profileMap[aidant.user_id] || null : null,
    }));

    console.log(`✅ ${aidantsWithProfiles.length} aidants récupérés`);
    res.json({
      success: true,
      data: aidantsWithProfiles,
      count: aidantsWithProfiles.length,
    });
  } catch (error) {
    console.error('❌ Erreur getCatalog:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des aidants',
    });
  }
});

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

// ✅ ROUTE GET /api/aidants/:id - ACCESSIBLE À TOUS LES UTILISATEURS AUTHENTIFIÉS
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('📋 Récupération de l\'aidant:', id);

    // ✅ Récupérer l'aidant SANS la relation automatique
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('*')
      .eq('id', id)
      .single();

    if (aidantError) throw aidantError;
    if (!aidant) {
      return res.status(404).json({
        success: false,
        error: 'Aidant non trouvé',
      });
    }

    // ✅ Récupérer le profil MANUELLEMENT
    let user = null;
    if (aidant.user_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone, avatar_url, role')
        .eq('id', aidant.user_id)
        .single();
      user = profile;
    }

    // ✅ Compter les assignations actives
    const { count: activeAssignments, error: countError } = await supabase
      .from('aidant_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('aidant_user_id', aidant.user_id)
      .eq('status', 'active');

    if (countError) {
      console.error('❌ Erreur comptage assignations:', countError);
    }

    const maxAssignments = aidant.max_assignments || 4;
    const isAvailable = aidant.available && (activeAssignments || 0) < maxAssignments;

    res.json({
      success: true,
      data: {
        ...aidant,
        user,
        active_assignments: activeAssignments || 0,
        max_assignments: maxAssignments,
        is_available: isAvailable,
        availability_status: isAvailable ? 'available' : 
          ((activeAssignments || 0) >= maxAssignments ? 'full' : 'unavailable'),
      },
    });
  } catch (error) {
    console.error('❌ Erreur getAidant:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération de l\'aidant',
    });
  }
});

module.exports = router;
