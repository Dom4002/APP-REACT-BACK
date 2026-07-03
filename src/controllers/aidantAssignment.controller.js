// 📁 backend/src/controllers/aidantAssignment.controller.js

const { supabase } = require('../services/supabase.service');

const {
  getActiveAidantForTarget,
  getAllAidantsForTarget,
  assignAidantToTarget,
  revokeAssignment,
  getAssignmentsByAidant,
  getAssignmentsByTarget,
  isAidantAssignedToTarget,
  TARGET_TYPES,
  ASSIGNMENT_TYPES,
} = require('../services/aidantAssignment.service');
const { asyncWrapper } = require('../utils/errorHandler');

// ============================================================
// RÉCUPÉRER L'AIDANT ACTIF POUR UNE CIBLE
// ============================================================
const getActiveAidant = asyncWrapper(async (req, res) => {
  try {
    const { targetType, targetId, familyId } = req.query;

    if (!targetType || !targetId) {
      return res.status(400).json({
        success: false,
        error: 'targetType et targetId sont requis',
      });
    }

    if (!Object.values(TARGET_TYPES).includes(targetType)) {
      return res.status(400).json({
        success: false,
        error: 'targetType invalide. Valeurs acceptées: patient, personal_account, family',
      });
    }

    const aidantId = await getActiveAidantForTarget(targetType, targetId, familyId || null);

    // Si un aidant est trouvé, récupérer ses informations
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
// RÉCUPÉRER TOUS LES AIDANTS POUR UNE CIBLE
// ============================================================
const getAllAidants = asyncWrapper(async (req, res) => {
  try {
    const { targetType, targetId, familyId } = req.query;

    if (!targetType || !targetId) {
      return res.status(400).json({
        success: false,
        error: 'targetType et targetId sont requis',
      });
    }

    if (!Object.values(TARGET_TYPES).includes(targetType)) {
      return res.status(400).json({
        success: false,
        error: 'targetType invalide. Valeurs acceptées: patient, personal_account, family',
      });
    }

    const aidants = await getAllAidantsForTarget(targetType, targetId, familyId || null);

    // Enrichir avec les profils
    const aidantIds = aidants.map(a => a.aidant_user_id).filter(Boolean);
    let profilesMap = {};

    if (aidantIds.length > 0) {
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone, avatar_url')
        .in('id', aidantIds);

      if (!error && profiles) {
        profilesMap = profiles.reduce((acc, p) => {
          acc[p.id] = p;
          return acc;
        }, {});
      }
    }

    const aidantsWithProfiles = aidants.map(a => ({
      ...a,
      profile: profilesMap[a.aidant_user_id] || null,
    }));

    res.json({
      success: true,
      data: aidantsWithProfiles,
      count: aidantsWithProfiles.length,
    });
  } catch (error) {
    console.error('❌ Erreur getAllAidants:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des aidants',
    });
  }
});

// ============================================================
// ASSIGNER UN AIDANT À UNE CIBLE
// ============================================================
const assignAidant = asyncWrapper(async (req, res) => {
  try {
    const {
      aidantUserId,
      targetType,
      targetId,
      familyId,
      assignmentType = ASSIGNMENT_TYPES.PRIMARY,
      reason,
      expiresAt,
    } = req.body;

    const userId = req.user.id;
    const userRole = req.profile?.role;

    // ✅ Validation : aidantUserId est obligatoire
    if (!aidantUserId) {
      return res.status(400).json({
        success: false,
        error: 'aidantUserId est requis',
      });
    }

    // ✅ Validation : targetType et targetId sont obligatoires
    if (!targetType || !targetId) {
      return res.status(400).json({
        success: false,
        error: 'targetType et targetId sont requis',
      });
    }

    if (!Object.values(TARGET_TYPES).includes(targetType)) {
      return res.status(400).json({
        success: false,
        error: 'targetType invalide. Valeurs acceptées: patient, personal_account, family',
      });
    }

    // ✅ Vérification des permissions
    const isAdmin = ['admin', 'coordinator'].includes(userRole);
    let hasPermission = isAdmin;

    if (!hasPermission && targetType === TARGET_TYPES.PERSONAL_ACCOUNT) {
      // Un utilisateur peut s'assigner un aidant pour son propre compte
      hasPermission = targetId === userId;
    }

    if (!hasPermission && targetType === TARGET_TYPES.PATIENT) {
      // Un utilisateur peut s'assigner un aidant pour ses patients
      const { data: links, error: linksError } = await supabase
        .from('patient_family_links')
        .select('id')
        .eq('family_id', userId)
        .eq('patient_id', targetId)
        .maybeSingle();

      if (!linksError && links) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Non autorisé à effectuer cette assignation',
      });
    }

    // ✅ Exécuter l'assignation
    const result = await assignAidantToTarget({
      aidantUserId,
      targetType,
      targetId,
      familyId: familyId || null,
      assignmentType,
      createdBy: userId,
      reason: reason || null,
      expiresAt: expiresAt || null,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

    console.log('✅ Aidant assigné avec succès:', result);

    res.status(201).json({
      success: true,
      message: 'Aidant assigné avec succès',
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
// RÉVOQUER UNE ASSIGNATION
// ============================================================
const revokeAssignmentController = asyncWrapper(async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.user.id;
    const userRole = req.profile?.role;

    console.log('📤 Révocation assignation:', id);

    // ✅ Vérifier que l'assignation existe et appartient à l'utilisateur
    const { data: assignment, error: fetchError } = await supabase
      .from('aidant_assignments')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !assignment) {
      return res.status(404).json({
        success: false,
        error: 'Assignation non trouvée',
      });
    }

    // ✅ Vérification des permissions
    const isAdmin = ['admin', 'coordinator'].includes(userRole);
    let hasPermission = isAdmin;

    if (!hasPermission) {
      // L'utilisateur peut révoquer une assignation sur son propre compte
      if (assignment.target_type === TARGET_TYPES.PERSONAL_ACCOUNT) {
        hasPermission = assignment.target_id === userId;
      }
      // L'utilisateur peut révoquer une assignation sur ses patients
      if (assignment.target_type === TARGET_TYPES.PATIENT) {
        const { data: links, error: linksError } = await supabase
          .from('patient_family_links')
          .select('id')
          .eq('family_id', userId)
          .eq('patient_id', assignment.target_id)
          .maybeSingle();

        if (!linksError && links) {
          hasPermission = true;
        }
      }
    }

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Non autorisé à révoquer cette assignation',
      });
    }

    const result = await revokeAssignment(id, userId, reason || null);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

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
// RÉCUPÉRER LES ASSIGNATIONS D'UN AIDANT
// ============================================================
const getAidantAssignments = asyncWrapper(async (req, res) => {
  try {
    const { aidantUserId } = req.params;
    const { status } = req.query;
    const userId = req.user.id;
    const userRole = req.profile?.role;

    // ✅ Vérification des permissions
    const isAdmin = ['admin', 'coordinator'].includes(userRole);
    const isOwnProfile = aidantUserId === userId;

    if (!isAdmin && !isOwnProfile) {
      return res.status(403).json({
        success: false,
        error: 'Non autorisé à voir ces assignations',
      });
    }

    const assignments = await getAssignmentsByAidant(aidantUserId, status || null);

    res.json({
      success: true,
      data: assignments,
      count: assignments.length,
    });
  } catch (error) {
    console.error('❌ Erreur getAidantAssignments:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des assignations',
    });
  }
});

// ============================================================
// RÉCUPÉRER LES ASSIGNATIONS POUR UNE CIBLE
// ============================================================
const getTargetAssignments = asyncWrapper(async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    const { status } = req.query;
    const userId = req.user.id;
    const userRole = req.profile?.role;

    // ✅ Validation
    if (!Object.values(TARGET_TYPES).includes(targetType)) {
      return res.status(400).json({
        success: false,
        error: 'targetType invalide. Valeurs acceptées: patient, personal_account, family',
      });
    }

    // ✅ Vérification des permissions
    const isAdmin = ['admin', 'coordinator'].includes(userRole);
    let hasPermission = isAdmin;

    if (!hasPermission && targetType === TARGET_TYPES.PERSONAL_ACCOUNT) {
      hasPermission = targetId === userId;
    }

    if (!hasPermission && targetType === TARGET_TYPES.PATIENT) {
      const { data: links, error: linksError } = await supabase
        .from('patient_family_links')
        .select('id')
        .eq('family_id', userId)
        .eq('patient_id', targetId)
        .maybeSingle();

      if (!linksError && links) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Non autorisé à voir ces assignations',
      });
    }

    const assignments = await getAssignmentsByTarget(targetType, targetId, status || null);

    res.json({
      success: true,
      data: assignments,
      count: assignments.length,
    });
  } catch (error) {
    console.error('❌ Erreur getTargetAssignments:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des assignations',
    });
  }
});

// ============================================================
// VÉRIFIER SI UN AIDANT EST ASSIGNÉ À UNE CIBLE
// ============================================================
const checkAssignment = asyncWrapper(async (req, res) => {
  try {
    const { aidantUserId, targetType, targetId } = req.query;

    if (!aidantUserId || !targetType || !targetId) {
      return res.status(400).json({
        success: false,
        error: 'aidantUserId, targetType et targetId sont requis',
      });
    }

    if (!Object.values(TARGET_TYPES).includes(targetType)) {
      return res.status(400).json({
        success: false,
        error: 'targetType invalide. Valeurs acceptées: patient, personal_account, family',
      });
    }

    const assignment = await isAidantAssignedToTarget(aidantUserId, targetType, targetId);

    res.json({
      success: true,
      data: {
        is_assigned: !!assignment,
        assignment: assignment,
      },
    });
  } catch (error) {
    console.error('❌ Erreur checkAssignment:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la vérification',
    });
  }
});

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getActiveAidant,
  getAllAidants,
  assignAidant,
  revokeAssignmentController,
  getAidantAssignments,
  getTargetAssignments,
  checkAssignment,
};
