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
  mapTargetTypeForResponse,
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

    // ✅ Accepter 'personal' et 'personal_account'
    const validTypes = ['patient', 'personal', 'personal_account', 'family'];
    if (!validTypes.includes(targetType)) {
      return res.status(400).json({
        success: false,
        error: 'targetType invalide. Valeurs acceptées: patient, personal, personal_account, family',
      });
    }

    // ✅ VÉRIFICATION DES PERMISSIONS
    const userId = req.user.id;
    const userRole = req.profile?.role;

    let hasPermission = false;

    // Admin/Coordinator ont tout accès
    if (['admin', 'coordinator'].includes(userRole)) {
      hasPermission = true;
    }
    // ✅ Une famille peut accéder à ses assignations personnelles
    else if (userRole === 'family') {
      // ✅ Cas 1 : Assignation personnelle (compte personnel)
      if ((targetType === 'personal' || targetType === 'personal_account') && targetId === userId) {
        hasPermission = true;
      }
      // ✅ Cas 2 : Patient - vérifier le lien
      else if (targetType === 'patient') {
        const { data: link, error: linkError } = await supabase
          .from('patient_family_links')
          .select('id')
          .eq('family_id', userId)
          .eq('patient_id', targetId)
          .maybeSingle();

        if (!linkError && link) {
          hasPermission = true;
        }
      }
      // ✅ Cas 3 : Famille - si targetId correspond à userId
      else if (targetType === 'family' && targetId === userId) {
        hasPermission = true;
      }
    }
    // ✅ Un aidant ne peut voir que ses propres patients
    else if (userRole === 'aidant') {
      // Vérifier via les assignations
      const { data: assignment, error: assignError } = await supabase
        .from('aidant_assignments')
        .select('id')
        .eq('aidant_user_id', userId)
        .eq('target_type', targetType)
        .eq('target_id', targetId)
        .eq('status', 'active')
        .maybeSingle();

      if (!assignError && assignment) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Accès non autorisé à cette cible',
        code: 'ACCESS_DENIED',
      });
    }

    // ✅ Récupérer l'aidant actif
    const aidantId = await getActiveAidantForTarget(targetType, targetId, familyId || null);

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
        target_type: mapTargetTypeForResponse(targetType),
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

    const validTypes = ['patient', 'personal', 'personal_account', 'family'];
    if (!validTypes.includes(targetType)) {
      return res.status(400).json({
        success: false,
        error: 'targetType invalide. Valeurs acceptées: patient, personal, personal_account, family',
      });
    }

    // ✅ VÉRIFICATION DES PERMISSIONS
    const userId = req.user.id;
    const userRole = req.profile?.role;

    let hasPermission = false;

    // Admin/Coordinator ont tout accès
    if (['admin', 'coordinator'].includes(userRole)) {
      hasPermission = true;
    }
    // ✅ Une famille peut accéder à ses assignations personnelles
    else if (userRole === 'family') {
      // ✅ Cas 1 : Assignation personnelle (compte personnel)
      if ((targetType === 'personal' || targetType === 'personal_account') && targetId === userId) {
        hasPermission = true;
      }
      // ✅ Cas 2 : Patient - vérifier le lien
      else if (targetType === 'patient') {
        const { data: link, error: linkError } = await supabase
          .from('patient_family_links')
          .select('id')
          .eq('family_id', userId)
          .eq('patient_id', targetId)
          .maybeSingle();

        if (!linkError && link) {
          hasPermission = true;
        }
      }
      // ✅ Cas 3 : Famille - si targetId correspond à userId
      else if (targetType === 'family' && targetId === userId) {
        hasPermission = true;
      }
    }
    // ✅ Un aidant ne peut voir que ses propres patients
    else if (userRole === 'aidant') {
      // Vérifier via les assignations
      const { data: assignment, error: assignError } = await supabase
        .from('aidant_assignments')
        .select('id')
        .eq('aidant_user_id', userId)
        .eq('target_type', targetType)
        .eq('target_id', targetId)
        .eq('status', 'active')
        .maybeSingle();

      if (!assignError && assignment) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Accès non autorisé à cette cible',
        code: 'ACCESS_DENIED',
      });
    }

    // ✅ Récupérer les aidants
    const aidants = await getAllAidantsForTarget(targetType, targetId, familyId || null);

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
      target_type: mapTargetTypeForResponse(a.target_type),
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

    if (!aidantUserId) {
      return res.status(400).json({
        success: false,
        error: 'aidantUserId est requis',
      });
    }

    if (!targetType || !targetId) {
      return res.status(400).json({
        success: false,
        error: 'targetType et targetId sont requis',
      });
    }

    const validTypes = ['patient', 'personal', 'personal_account', 'family'];
    if (!validTypes.includes(targetType)) {
      return res.status(400).json({
        success: false,
        error: 'targetType invalide. Valeurs acceptées: patient, personal, personal_account, family',
      });
    }

    // ✅ VÉRIFICATION DES PERMISSIONS
    const isAdmin = ['admin', 'coordinator'].includes(userRole);
    let hasPermission = isAdmin;

    if (!hasPermission && (targetType === 'personal' || targetType === TARGET_TYPES.PERSONAL_ACCOUNT)) {
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
        error: 'Non autorisé à effectuer cette assignation',
        code: 'ACCESS_DENIED',
      });
    }

    // ✅ Créer l'assignation
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

    const { data: assignment, error: fetchError } = await supabase
      .from('aidant_assignments')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !assignment) {
      return res.status(404).json({
        success: false,
        error: 'Assignation non trouvée',
        code: 'NOT_FOUND',
      });
    }

    // ✅ VÉRIFICATION DES PERMISSIONS
    const isAdmin = ['admin', 'coordinator'].includes(userRole);
    let hasPermission = isAdmin;

    if (!hasPermission) {
      if (assignment.target_type === TARGET_TYPES.PERSONAL_ACCOUNT || assignment.target_type === 'personal') {
        hasPermission = assignment.target_id === userId;
      }
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
        code: 'ACCESS_DENIED',
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
      data: {
        ...result,
        target_type: mapTargetTypeForResponse(assignment.target_type),
      },
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

    const isAdmin = ['admin', 'coordinator'].includes(userRole);
    const isOwnProfile = aidantUserId === userId;

    if (!isAdmin && !isOwnProfile) {
      return res.status(403).json({
        success: false,
        error: 'Non autorisé à voir ces assignations',
        code: 'ACCESS_DENIED',
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

    const validTypes = ['patient', 'personal', 'personal_account', 'family'];
    if (!validTypes.includes(targetType)) {
      return res.status(400).json({
        success: false,
        error: 'targetType invalide. Valeurs acceptées: patient, personal, personal_account, family',
      });
    }

    // ✅ VÉRIFICATION DES PERMISSIONS
    const isAdmin = ['admin', 'coordinator'].includes(userRole);
    let hasPermission = isAdmin;

    if (!hasPermission && (targetType === 'personal' || targetType === TARGET_TYPES.PERSONAL_ACCOUNT)) {
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
        code: 'ACCESS_DENIED',
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

    const validTypes = ['patient', 'personal', 'personal_account', 'family'];
    if (!validTypes.includes(targetType)) {
      return res.status(400).json({
        success: false,
        error: 'targetType invalide. Valeurs acceptées: patient, personal, personal_account, family',
      });
    }

    const assignment = await isAidantAssignedToTarget(aidantUserId, targetType, targetId);

    res.json({
      success: true,
      data: {
        is_assigned: !!assignment,
        assignment: assignment ? {
          ...assignment,
          target_type: mapTargetTypeForResponse(assignment.target_type),
        } : null,
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
