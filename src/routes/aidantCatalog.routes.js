// 📁 backend/src/routes/aidantCatalog.routes.js

const express = require('express');
const { supabase } = require('../services/supabase.service');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');
const {
  getCatalog,
  getAidant,
  assignAidant,
  getMyAssignments,
  revokeAssignmentController,
  getActiveAidant,
} = require('../controllers/aidantCatalog.controller');
const {
  getAvailableAidantsForFamily,
  getAidantsWithQuota,
} = require('../services/aidantAssignment.service');

// Toutes les routes nécessitent une authentification
router.use(authMiddleware);

// ============================================================
// ⚠️ IMPORTANT : ROUTES SPÉCIFIQUES AVANT LES ROUTES AVEC PARAMÈTRES
// ============================================================

// ============================================================
// ✅ GET /api/aidants/catalog
// Récupère la liste des aidants disponibles avec filtres
// ============================================================
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

// ============================================================
// ✅ GET /api/aidants/active
// Récupère l'aidant actif pour une cible
// ============================================================
router.get('/active', getActiveAidant);

// ============================================================
// ✅ GET /api/aidants/my-assignments
// Récupère les assignations de la famille connectée
// ============================================================
router.get('/my-assignments', roleMiddleware(['family']), getMyAssignments);

// ============================================================
// ✅ POST /api/aidants/assign
// Assigner un aidant à un patient ou à un compte personnel (famille uniquement)
// ============================================================
router.post('/assign', roleMiddleware(['family']), assignAidant);

// ============================================================
// ✅ DELETE /api/aidants/assignments/:id
// Révoquer une assignation (famille uniquement)
// ============================================================
router.delete('/assignments/:id', roleMiddleware(['family']), revokeAssignmentController);

// ============================================================
// ✅ GET /api/aidants/:id
// Récupérer un aidant par ID - ACCESSIBLE À TOUS LES UTILISATEURS AUTHENTIFIÉS
// ============================================================
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

// ============================================================
// 🆕 NOUVELLES ROUTES
// ============================================================

// ============================================================
// ✅ GET /api/aidants/catalog/available-for-family
// Récupère les aidants disponibles pour une famille
// ============================================================
router.get('/catalog/available-for-family', roleMiddleware(['family']), async (req, res) => {
  try {
    const userId = req.user.id;
    const { zone, specialty, minRating } = req.query;

    const aidants = await getAvailableAidantsForFamily(userId, {
      zone,
      specialty,
      minRating: minRating ? parseFloat(minRating) : undefined,
    });

    res.json({
      success: true,
      data: aidants,
      count: aidants.length,
    });
  } catch (error) {
    console.error('❌ Get available aidants for family error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des aidants disponibles',
    });
  }
});

// ============================================================
// ✅ GET /api/aidants/with-quota
// Récupère tous les aidants avec leur quota (admin uniquement)
// ============================================================
router.get('/with-quota', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { available } = req.query;
    const filters = {
      available: available === 'true',
    };

    const aidants = await getAidantsWithQuota(filters);

    res.json({
      success: true,
      data: aidants,
      count: aidants.length,
    });
  } catch (error) {
    console.error('❌ Get aidants with quota error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des aidants',
    });
  }
});

// ============================================================
// ✅ GET /api/aidants/catalog/full
// Récupère les aidants complets (ceux qui ont atteint leur quota)
// ============================================================
router.get('/catalog/full', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { data: aidants, error } = await supabase
      .from('aidants')
      .select(`
        *,
        user:profiles!aidants_user_id_fkey(
          id,
          full_name,
          email,
          phone,
          avatar_url
        )
      `)
      .eq('is_verified', true)
      .eq('status', 'approved');

    if (error) throw error;

    // ✅ Filtrer ceux qui sont full (current_assignments >= max_assignments)
    const fullAidants = (aidants || []).filter(a => {
      const current = a.current_assignments || 0;
      const max = a.max_assignments || 4;
      return current >= max;
    });

    res.json({
      success: true,
      data: fullAidants,
      count: fullAidants.length,
    });
  } catch (error) {
    console.error('❌ Get full aidants error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des aidants complets',
    });
  }
});

// ============================================================
// ✅ GET /api/aidants/catalog/by-specialty/:specialty
// Récupère les aidants par spécialité
// ============================================================
router.get('/catalog/by-specialty/:specialty', async (req, res) => {
  try {
    const { specialty } = req.params;
    const { onlyAvailable } = req.query;

    let query = supabase
      .from('aidants')
      .select(`
        *,
        user:profiles!aidants_user_id_fkey(
          id,
          full_name,
          email,
          phone,
          avatar_url
        )
      `)
      .eq('is_verified', true)
      .eq('status', 'approved')
      .contains('specialties', [specialty]);

    if (onlyAvailable !== 'false') {
      query = query.eq('available', true);
    }

    const { data: aidants, error } = await query.order('rating', { ascending: false });

    if (error) throw error;

    // ✅ Enrichir avec le quota
    const aidantsWithQuota = (aidants || []).map(a => ({
      ...a,
      current_assignments: a.current_assignments || 0,
      max_assignments: a.max_assignments || 4,
      available_slots: Math.max(0, (a.max_assignments || 4) - (a.current_assignments || 0)),
    }));

    res.json({
      success: true,
      data: aidantsWithQuota,
      count: aidantsWithQuota.length,
      specialty,
    });
  } catch (error) {
    console.error('❌ Get aidants by specialty error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des aidants',
    });
  }
});

// ============================================================
// ✅ GET /api/aidants/catalog/by-zone/:zone
// Récupère les aidants par zone
// ============================================================
router.get('/catalog/by-zone/:zone', async (req, res) => {
  try {
    const { zone } = req.params;
    const { onlyAvailable } = req.query;

    let query = supabase
      .from('aidants')
      .select(`
        *,
        user:profiles!aidants_user_id_fkey(
          id,
          full_name,
          email,
          phone,
          avatar_url
        )
      `)
      .eq('is_verified', true)
      .eq('status', 'approved')
      .contains('zones', [zone]);

    if (onlyAvailable !== 'false') {
      query = query.eq('available', true);
    }

    const { data: aidants, error } = await query.order('rating', { ascending: false });

    if (error) throw error;

    const aidantsWithQuota = (aidants || []).map(a => ({
      ...a,
      current_assignments: a.current_assignments || 0,
      max_assignments: a.max_assignments || 4,
      available_slots: Math.max(0, (a.max_assignments || 4) - (a.current_assignments || 0)),
    }));

    res.json({
      success: true,
      data: aidantsWithQuota,
      count: aidantsWithQuota.length,
      zone,
    });
  } catch (error) {
    console.error('❌ Get aidants by zone error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des aidants',
    });
  }
});

// ============================================================
// ✅ GET /api/aidants/stats
// Statistiques des aidants
// ============================================================
router.get('/stats', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const [
      { count: total },
      { count: available },
      { count: full },
      { count: verified },
      { count: pending },
    ] = await Promise.all([
      supabase.from('aidants').select('*', { count: 'exact', head: true }),
      supabase.from('aidants').select('*', { count: 'exact', head: true })
        .eq('available', true)
        .eq('is_verified', true)
        .eq('status', 'approved'),
      supabase.from('aidants').select('*', { count: 'exact', head: true })
        .eq('is_verified', true)
        .eq('status', 'approved')
        .gt('current_assignments', 'max_assignments'),
      supabase.from('aidants').select('*', { count: 'exact', head: true }).eq('is_verified', true),
      supabase.from('aidants').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    ]);

    // ✅ Assignations totales
    const { count: totalAssignments } = await supabase
      .from('aidant_assignments')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');

    // ✅ Quota moyen
    const { data: aidants } = await supabase
      .from('aidants')
      .select('current_assignments, max_assignments')
      .eq('status', 'approved')
      .eq('is_verified', true);

    let avgQuota = 0;
    if (aidants && aidants.length > 0) {
      const totalQuota = aidants.reduce((sum, a) => sum + (a.current_assignments || 0), 0);
      avgQuota = totalQuota / aidants.length;
    }

    res.json({
      success: true,
      data: {
        total,
        available,
        full,
        verified,
        pending,
        totalAssignments,
        avgQuota: Math.round(avgQuota * 10) / 10,
      },
    });
  } catch (error) {
    console.error('❌ Get aidant stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des statistiques',
    });
  }
});

module.exports = router;
