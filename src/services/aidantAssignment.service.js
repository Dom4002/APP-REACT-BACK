// 📁 backend/src/services/aidantAssignment.service.js
// SERVICE DE GESTION DES ASSIGNATIONS D'AIDANTS

const { supabase } = require('./supabase.service');

// ============================================================
// CONSTANTES
// ============================================================

const TARGET_TYPES = {
  PATIENT: 'patient',
  PERSONAL_ACCOUNT: 'personal_account',
  FAMILY: 'family',
};

const ASSIGNMENT_TYPES = {
  PRIMARY: 'primary',
  SECONDARY: 'secondary',
  TEMPORARY: 'temporary',
};

const ASSIGNMENT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  EXPIRED: 'expired',
};

const PRIORITY = {
  PATIENT: 1,
  PERSONAL_ACCOUNT: 2,
  FAMILY: 3,
};

// ============================================================
// FONCTIONS PRINCIPALES
// ============================================================

/**
 * Récupère l'aidant actif pour une cible donnée
 * Utilise la règle de priorité : patient > personal_account > family
 * 
 * @param {string} targetType - 'patient' | 'personal_account' | 'family'
 * @param {string} targetId - UUID de la cible
 * @param {string} familyId - UUID de la famille (optionnel)
 * @returns {Promise<string|null>} - UUID de l'aidant ou null
 */
const getActiveAidantForTarget = async (targetType, targetId, familyId = null) => {
  try {
    const { data, error } = await supabase.rpc('get_active_aidant_for_target', {
      p_target_type: targetType,
      p_target_id: targetId,
      p_family_id: familyId,
    });

    if (error) {
      console.error('❌ get_active_aidant_for_target error:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('❌ getActiveAidantForTarget error:', error);
    return null;
  }
};

/**
 * Récupère tous les aidants pour une cible (principal + secondaires)
 * 
 * @param {string} targetType - 'patient' | 'personal_account' | 'family'
 * @param {string} targetId - UUID de la cible
 * @param {string} familyId - UUID de la famille (optionnel)
 * @returns {Promise<Array>} - Liste des aidants
 */
const getAllAidantsForTarget = async (targetType, targetId, familyId = null) => {
  try {
    const { data, error } = await supabase.rpc('get_all_aidants_for_target', {
      p_target_type: targetType,
      p_target_id: targetId,
      p_family_id: familyId,
    });

    if (error) {
      console.error('❌ get_all_aidants_for_target error:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('❌ getAllAidantsForTarget error:', error);
    return [];
  }
};

/**
 * Assigne un aidant à une cible
 * 
 * @param {Object} params
 * @param {string} params.aidantUserId - UUID de l'aidant
 * @param {string} params.targetType - 'patient' | 'personal_account' | 'family'
 * @param {string} params.targetId - UUID de la cible
 * @param {string} params.familyId - UUID de la famille (optionnel)
 * @param {string} params.assignmentType - 'primary' | 'secondary' | 'temporary'
 * @param {string} params.createdBy - UUID de l'utilisateur qui crée l'assignation
 * @param {string} params.reason - Motif (optionnel)
 * @param {string} params.expiresAt - Date d'expiration (optionnel)
 * @returns {Promise<Object>} - Résultat de l'assignation
 */
const assignAidantToTarget = async ({
  aidantUserId,
  targetType,
  targetId,
  familyId = null,
  assignmentType = ASSIGNMENT_TYPES.PRIMARY,
  createdBy = null,
  reason = null,
  expiresAt = null,
}) => {
  try {
    // 1. Vérifier que l'aidant existe et est disponible
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, is_verified, status, available')
      .eq('user_id', aidantUserId)
      .single();

    if (aidantError || !aidant) {
      return {
        success: false,
        error: 'Aidant non trouvé',
        code: 'AIDANT_NOT_FOUND',
      };
    }

    if (!aidant.is_verified || aidant.status !== 'approved') {
      return {
        success: false,
        error: 'Cet aidant n\'est pas approuvé',
        code: 'AIDANT_NOT_APPROVED',
      };
    }

    // 2. Vérifier que l'aidant n'a pas atteint son quota max
    const { count: currentAssignments, error: countError } = await supabase
      .from('aidant_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('aidant_user_id', aidantUserId)
      .eq('status', ASSIGNMENT_STATUS.ACTIVE);

    if (countError) {
      console.error('❌ Erreur comptage assignations:', countError);
    }

    const maxAssignments = aidant.max_assignments || 4;
    if ((currentAssignments || 0) >= maxAssignments) {
      return {
        success: false,
        error: `Cet aidant a déjà ${currentAssignments} assignations (maximum ${maxAssignments})`,
        code: 'AIDANT_FULL',
      };
    }

    // 3. Vérifier la validité de la cible
    let targetExists = false;
    let targetName = '';

    switch (targetType) {
      case TARGET_TYPES.PATIENT:
        const { data: patient, error: patientError } = await supabase
          .from('patients')
          .select('id, first_name, last_name')
          .eq('id', targetId)
          .single();

        if (!patientError && patient) {
          targetExists = true;
          targetName = `${patient.first_name} ${patient.last_name}`;
        }
        break;

      case TARGET_TYPES.PERSONAL_ACCOUNT:
      case TARGET_TYPES.FAMILY:
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id, full_name')
          .eq('id', targetId)
          .single();

        if (!profileError && profile) {
          targetExists = true;
          targetName = profile.full_name;
        }
        break;

      default:
        return {
          success: false,
          error: 'Type de cible invalide',
          code: 'INVALID_TARGET_TYPE',
        };
    }

    if (!targetExists) {
      return {
        success: false,
        error: 'Cible non trouvée',
        code: 'TARGET_NOT_FOUND',
      };
    }

    // 4. Appeler la fonction SQL
    const { data: assignmentId, error: assignError } = await supabase.rpc('assign_aidant_to_target', {
      p_aidant_user_id: aidantUserId,
      p_target_type: targetType,
      p_target_id: targetId,
      p_family_id: familyId,
      p_assignment_type: assignmentType,
      p_created_by: createdBy,
      p_reason: reason,
      p_expires_at: expiresAt,
    });

    if (assignError) {
      console.error('❌ assign_aidant_to_target error:', assignError);
      return {
        success: false,
        error: assignError.message || 'Erreur lors de l\'assignation',
        code: 'ASSIGN_ERROR',
      };
    }

    // 5. Récupérer l'assignation créée
    const { data: assignment, error: fetchError } = await supabase
      .from('aidant_assignments')
      .select(`
        *,
        aidant:aidant_user_id(
          id,
          user_id,
          user:profiles!aidants_user_id_fkey(
            id,
            full_name,
            email
          )
        )
      `)
      .eq('id', assignmentId)
      .single();

    if (fetchError) {
      console.error('❌ Erreur récupération assignation:', fetchError);
    }

    // 6. Mettre à jour current_assignments de l'aidant
    await supabase
      .from('aidants')
      .update({
        current_assignments: (currentAssignments || 0) + 1,
        available: (currentAssignments || 0) + 1 < maxAssignments,
        updated_at: new Date().toISOString(),
      })
      .eq('id', aidant.id);

    // 7. Créer les notifications
    await createAssignmentNotifications({
      assignmentId,
      aidantUserId,
      targetType,
      targetId,
      targetName,
      assignmentType,
      createdBy,
    });

    return {
      success: true,
      assignment: assignment || { id: assignmentId },
      target_type: targetType,
      target_name: targetName,
    };
  } catch (error) {
    console.error('❌ assignAidantToTarget error:', error);
    return {
      success: false,
      error: error.message || 'Erreur lors de l\'assignation',
      code: 'UNKNOWN_ERROR',
    };
  }
};

/**
 * Révoque une assignation
 * 
 * @param {string} assignmentId - UUID de l'assignation
 * @param {string} revokedBy - UUID de l'utilisateur qui révoque
 * @param {string} reason - Motif (optionnel)
 * @returns {Promise<Object>} - Résultat de la révocation
 */
const revokeAssignment = async (assignmentId, revokedBy = null, reason = null) => {
  try {
    // 1. Récupérer l'assignation
    const { data: assignment, error: fetchError } = await supabase
      .from('aidant_assignments')
      .select('*')
      .eq('id', assignmentId)
      .single();

    if (fetchError || !assignment) {
      return {
        success: false,
        error: 'Assignation non trouvée',
        code: 'ASSIGNMENT_NOT_FOUND',
      };
    }

    if (assignment.status !== ASSIGNMENT_STATUS.ACTIVE) {
      return {
        success: false,
        error: 'Cette assignation n\'est pas active',
        code: 'ASSIGNMENT_NOT_ACTIVE',
      };
    }

    // 2. Appeler la fonction SQL
    const { data: result, error: revokeError } = await supabase.rpc('revoke_aidant_assignment', {
      p_assignment_id: assignmentId,
      p_revoked_by: revokedBy,
      p_reason: reason,
    });

    if (revokeError) {
      console.error('❌ revoke_aidant_assignment error:', revokeError);
      return {
        success: false,
        error: revokeError.message || 'Erreur lors de la révocation',
        code: 'REVOKE_ERROR',
      };
    }

    if (!result) {
      return {
        success: false,
        error: 'Impossible de révoquer cette assignation',
        code: 'REVOKE_FAILED',
      };
    }

    // 3. Mettre à jour current_assignments de l'aidant
    const { count: currentAssignments, error: countError } = await supabase
      .from('aidant_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('aidant_user_id', assignment.aidant_user_id)
      .eq('status', ASSIGNMENT_STATUS.ACTIVE);

    if (!countError) {
      const { data: aidant, error: aidantError } = await supabase
        .from('aidants')
        .select('max_assignments')
        .eq('user_id', assignment.aidant_user_id)
        .single();

      if (!aidantError && aidant) {
        const maxAssignments = aidant.max_assignments || 4;
        await supabase
          .from('aidants')
          .update({
            current_assignments: currentAssignments || 0,
            available: (currentAssignments || 0) < maxAssignments,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', assignment.aidant_user_id);
      }
    }

    // 4. Notification
    await supabase.from('notifications').insert({
      user_id: assignment.aidant_user_id,
      title: '🔄 Assignation révoquée',
      body: `Votre assignation a été révoquée${reason ? ` : ${reason}` : ''}`,
      type: 'system',
      data: {
        assignment_id: assignmentId,
        revoked_by: revokedBy,
        reason: reason,
      },
    });

    return {
      success: true,
      assignment_id: assignmentId,
    };
  } catch (error) {
    console.error('❌ revokeAssignment error:', error);
    return {
      success: false,
      error: error.message || 'Erreur lors de la révocation',
      code: 'UNKNOWN_ERROR',
    };
  }
};

/**
 * Récupère toutes les assignations d'un aidant
 * 
 * @param {string} aidantUserId - UUID de l'aidant
 * @param {string} status - Statut des assignations (optionnel)
 * @returns {Promise<Array>} - Liste des assignations
 */
const getAssignmentsByAidant = async (aidantUserId, status = null) => {
  try {
    let query = supabase
      .from('aidant_assignments')
      .select(`
        *,
        target_patient:patients!target_id(
          id,
          first_name,
          last_name,
          address
        ),
        target_profile:profiles!target_id(
          id,
          full_name,
          email
        )
      `)
      .eq('aidant_user_id', aidantUserId);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;

    return data || [];
  } catch (error) {
    console.error('❌ getAssignmentsByAidant error:', error);
    return [];
  }
};

/**
 * Récupère toutes les assignations pour une cible
 * 
 * @param {string} targetType - 'patient' | 'personal_account' | 'family'
 * @param {string} targetId - UUID de la cible
 * @param {string} status - Statut des assignations (optionnel)
 * @returns {Promise<Array>} - Liste des assignations
 */
const getAssignmentsByTarget = async (targetType, targetId, status = null) => {
  try {
    let query = supabase
      .from('aidant_assignments')
      .select(`
        *,
        aidant:profiles!aidant_user_id(
          id,
          full_name,
          email
        )
      `)
      .eq('target_type', targetType)
      .eq('target_id', targetId);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;

    return data || [];
  } catch (error) {
    console.error('❌ getAssignmentsByTarget error:', error);
    return [];
  }
};

/**
 * Vérifie si un aidant est assigné à une cible
 * 
 * @param {string} aidantUserId - UUID de l'aidant
 * @param {string} targetType - 'patient' | 'personal_account' | 'family'
 * @param {string} targetId - UUID de la cible
 * @returns {Promise<Object|null>} - L'assignation ou null
 */
const isAidantAssignedToTarget = async (aidantUserId, targetType, targetId) => {
  try {
    const { data, error } = await supabase
      .from('aidant_assignments')
      .select('*')
      .eq('aidant_user_id', aidantUserId)
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .eq('status', ASSIGNMENT_STATUS.ACTIVE)
      .maybeSingle();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('❌ isAidantAssignedToTarget error:', error);
    return null;
  }
};

// ============================================================
// FONCTIONS PRIVÉES (INTERNES)
// ============================================================

/**
 * Crée les notifications pour une assignation
 */
const createAssignmentNotifications = async ({
  assignmentId,
  aidantUserId,
  targetType,
  targetId,
  targetName,
  assignmentType,
  createdBy,
}) => {
  try {
    // 1. Notification à l'aidant
    await supabase.from('notifications').insert({
      user_id: aidantUserId,
      title: '📋 Nouvelle assignation',
      body: `Vous avez été assigné à ${targetName} (${assignmentType})`,
      type: 'system',
      data: {
        assignment_id: assignmentId,
        target_type: targetType,
        target_id: targetId,
        assignment_type: assignmentType,
      },
    });

    // 2. Notification au propriétaire de la cible
    let ownerId = null;

    if (targetType === TARGET_TYPES.PATIENT) {
      // Récupérer la famille du patient
      const { data: links, error: linksError } = await supabase
        .from('patient_family_links')
        .select('family_id')
        .eq('patient_id', targetId)
        .eq('is_primary', true)
        .maybeSingle();

      if (!linksError && links) {
        ownerId = links.family_id;
      }
    } else if (targetType === TARGET_TYPES.PERSONAL_ACCOUNT) {
      ownerId = targetId;
    } else if (targetType === TARGET_TYPES.FAMILY) {
      ownerId = targetId;
    }

    if (ownerId) {
      await supabase.from('notifications').insert({
        user_id: ownerId,
        title: '✅ Aidant assigné',
        body: `Un aidant a été assigné à ${targetName}`,
        type: 'system',
        data: {
          assignment_id: assignmentId,
          aidant_user_id: aidantUserId,
          target_type: targetType,
          target_id: targetId,
          assignment_type: assignmentType,
        },
      });
    }

    // 3. Notification aux admins
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (admins && admins.length > 0) {
      const adminNotifications = admins.map((admin) => ({
        user_id: admin.id,
        title: '📋 Nouvelle assignation créée',
        body: `Un aidant a été assigné à ${targetName} par ${createdBy || 'le système'}`,
        type: 'alert',
        data: {
          assignment_id: assignmentId,
          aidant_user_id: aidantUserId,
          target_type: targetType,
          target_id: targetId,
        },
      }));

      await supabase.from('notifications').insert(adminNotifications);
    }
  } catch (error) {
    console.error('❌ createAssignmentNotifications error:', error);
  }
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Constantes
  TARGET_TYPES,
  ASSIGNMENT_TYPES,
  ASSIGNMENT_STATUS,
  PRIORITY,

  // Fonctions principales
  getActiveAidantForTarget,
  getAllAidantsForTarget,
  assignAidantToTarget,
  revokeAssignment,
  getAssignmentsByAidant,
  getAssignmentsByTarget,
  isAidantAssignedToTarget,
};
