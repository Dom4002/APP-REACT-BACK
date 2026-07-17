// 📁 backend/src/controllers/aidantCatalog.controller.js

const { supabase } = require('../services/supabase.service');

const {
  getAvailableAidants,
  getAidantById,
  assignAidantToPatient,
  getFamilyAssignments,
  revokeAssignment,
} = require('../services/aidantCatalog.service');
const { asyncWrapper } = require('../utils/errorHandler');
const { getActiveAidantForTarget } = require('../services/aidantAssignment.service');

// ============================================================
// RÉCUPÉRER LE CATALOGUE DES AIDANTS
// ============================================================
const getCatalog = asyncWrapper(async (req, res) => {
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

    const aidants = await getAvailableAidants(filters);

    console.log(`✅ ${aidants.length} aidants récupérés`);
    res.json({
      success: true,
      data: aidants,
      count: aidants.length,
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
// RÉCUPÉRER UN AIDANT PAR ID
// ============================================================
const getAidant = asyncWrapper(async (req, res) => {
  try {
    const { id } = req.params;
    console.log('📋 Récupération de l\'aidant:', id);

    const aidant = await getAidantById(id);

    if (!aidant) {
      return res.status(404).json({
        success: false,
        error: 'Aidant non trouvé',
      });
    }

    res.json({
      success: true,
      data: aidant,
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
// RÉCUPÉRER LES ASSIGNATIONS DE LA FAMILLE
// ============================================================
const getMyAssignments = asyncWrapper(async (req, res) => {
  try {
    const familyId = req.user.id;
    console.log('📋 Récupération des assignations pour la famille:', familyId);

    const assignments = await getFamilyAssignments(familyId);

    console.log(`✅ ${assignments.length} assignations récupérées`);
    res.json({
      success: true,
      data: assignments,
      count: assignments.length,
    });
  } catch (error) {
    console.error('❌ Erreur getMyAssignments:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des assignations',
    });
  }
});

// ============================================================
// ASSIGNER UN AIDANT - AVEC patientId OPTIONNEL (ADMIN UNIQUEMENT)
// ============================================================
const assignAidant = asyncWrapper(async (req, res) => {
  try {
    const { aidantId, patientId, assignmentType = 'permanente' } = req.body;
    const adminId = req.user.id;
    const userRole = req.profile?.role;

    // 🔒 Sécurité : Bloquer les comptes famille
    if (userRole !== 'admin' && userRole !== 'coordinator') {
      return res.status(403).json({
        success: false,
        error: "Non autorisé. Seule l'administration de Santé Plus peut modifier les attributions d'aidants.",
        code: 'FORBIDDEN_ACTION'
      });
    }

    if (!aidantId) {
      return res.status(400).json({
        success: false,
        error: 'aidantId est requis',
      });
    }

    const result = await assignAidantToPatient(
      aidantId,
      adminId,
      patientId || null,
      assignmentType
    );

    res.status(201).json({
      success: true,
      message: 'Aidant assigné avec succès par l’administration',
      data: result,
    });
  } catch (error) {
    console.error('❌ Erreur assignAidant:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de l\'assignation',
    });
  }
});

// ============================================================
// RÉVOQUER UNE ASSIGNATION - AVEC NOTIFICATIONS COMPLÈTES (ADMIN UNIQUEMENT)
// ============================================================
const revokeAssignmentController = asyncWrapper(async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const userRole = req.profile?.role;

    // 🔒 Sécurité : Bloquer les comptes famille
    if (userRole !== 'admin' && userRole !== 'coordinator') {
      return res.status(403).json({
        success: false,
        error: "Non autorisé. Seule l'administration de Santé Plus peut révoquer des attributions.",
        code: 'FORBIDDEN_ACTION'
      });
    }

    const result = await revokeAssignment(id, adminId);

    res.json({
      success: true,
      message: 'Assignation révoquée avec succès',
      data: result,
    });
  } catch (error) {
    console.error('❌ Erreur revokeAssignment:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la révocation',
    });
  }
});

// ============================================================
// ✅ RÉCUPÉRER L'AIDANT ACTIF POUR UNE CIBLE
// ============================================================
const getActiveAidant = asyncWrapper(async (req, res) => {
  try {
    const { targetType, targetId, familyId } = req.query;
    const userId = req.user.id;

    if (!targetType || !targetId) {
      return res.status(400).json({
        success: false,
        error: 'targetType et targetId sont requis',
      });
    }

    // ✅ Vérifier les permissions
    const isAdmin = ['admin', 'coordinator'].includes(req.profile?.role);
    let hasAccess = isAdmin;

    if (!hasAccess) {
      if (targetType === 'personal_account') {
        hasAccess = targetId === userId;
      } else if (targetType === 'patient') {
        const { data: link } = await supabase
          .from('patient_family_links')
          .select('id')
          .eq('family_id', userId)
          .eq('patient_id', targetId)
          .maybeSingle();
        hasAccess = !!link;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'Accès non autorisé à cette cible',
      });
    }

    const aidantId = await getActiveAidantForTarget(
      targetType,
      targetId,
      familyId || null
    );

    // Récupérer les infos de l'aidant
    let aidant = null;
    if (aidantId) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone, avatar_url')
        .eq('id', aidantId)
        .single();

      if (!error && data) {
        aidant = data;
      }
    }

    res.json({
      success: true,
      data: {
        aidant_id: aidantId,
        aidant: aidant,
        target_type: targetType,
        target_id: targetId,
      },
    });
  } catch (error) {
    console.error('❌ Erreur getActiveAidant:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération de l\'aidant actif',
    });
  }
});

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getCatalog,
  getAidant,
  assignAidant,
  getMyAssignments,
  revokeAssignmentController,
  getActiveAidant,
};
