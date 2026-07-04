// 📁 backend/src/services/aidantAssignment.service.js
 
const { supabase } = require('./supabase.service');

// ============================================================
// CONSTANTES - AVEC MAPPING POUR COMPATIBILITÉ FRONTEND
// ============================================================

const TARGET_TYPES = {
  PATIENT: 'patient',
  PERSONAL_ACCOUNT: 'personal_account',
  PERSONAL: 'personal',           // ✅ Alias pour compatibilité frontend
  FAMILY: 'family',
};

// ✅ Mapping pour normaliser les types venant du frontend
const mapTargetType = (type) => {
  if (!type) return type;
  const normalized = type.toLowerCase();
  
  // 🔄 Normaliser 'personal' → 'personal_account'
  if (normalized === 'personal') return TARGET_TYPES.PERSONAL_ACCOUNT;
  if (normalized === 'personal_account') return TARGET_TYPES.PERSONAL_ACCOUNT;
  if (normalized === 'patient') return TARGET_TYPES.PATIENT;
  if (normalized === 'family') return TARGET_TYPES.FAMILY;
  
  return type;
};

// ✅ Mapping inverse pour les réponses (si le frontend attend 'personal')
const mapTargetTypeForResponse = (type) => {
  if (!type) return type;
  if (type === TARGET_TYPES.PERSONAL_ACCOUNT) return 'personal';
  if (type === TARGET_TYPES.PATIENT) return 'patient';
  if (type === TARGET_TYPES.FAMILY) return 'family';
  return type;
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
  PATIENT: 1,           // ✅ Priorité la plus haute
  PERSONAL_ACCOUNT: 2,  // ✅ Priorité intermédiaire (fallback)
  FAMILY: 3,            // ✅ Priorité la plus basse (dernier fallback)
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
    const dbTargetType = mapTargetType(targetType);
    
    const { data, error } = await supabase.rpc('get_active_aidant_for_target', {
      p_target_type: dbTargetType,
      p_target_id: targetId,
      p_family_id: familyId,
    });

    if (error) {
      console.error('❌ get_active_aidant_for_target error:', error);
      return null;
    }

    if (!data) {
      return null;
    }

    // ✅ VÉRIFIER SI data est un aidant_id ou un user_id
    // 1. Vérifier si data est un aidant_id (dans la table aidants)
    const { data: aidantById, error: errorById } = await supabase
      .from('aidants')
      .select('id')
      .eq('id', data)
      .maybeSingle();

    if (!errorById && aidantById) {
      // ✅ data est déjà un aidant_id, le retourner directement
      return data;
    }

    // 2. Vérifier si data est un user_id
    const { data: aidantByUser, error: errorByUser } = await supabase
      .from('aidants')
      .select('id')
      .eq('user_id', data)
      .maybeSingle();

    if (!errorByUser && aidantByUser) {
      // ✅ data est un user_id, retourner l'aidant_id correspondant
      console.log(`🔄 Conversion user_id ${data} → aidant_id ${aidantByUser.id}`);
      return aidantByUser.id;
    }

    console.warn(`⚠️ Aucun aidant trouvé pour ${data}`);
    return null;
  } catch (error) {
    console.error('❌ getActiveAidantForTarget error:', error);
    return null;
  }
};

/**
 * Récupère tous les aidants pour une cible (principal + secondaires)
 * Inclut les aidants du compte et de la famille en fallback
 * 
 * @param {string} targetType - 'patient' | 'personal_account' | 'family'
 * @param {string} targetId - UUID de la cible
 * @param {string} familyId - UUID de la famille (optionnel)
 * @returns {Promise<Array>} - Liste des aidants avec leur priorité
 */
const getAllAidantsForTarget = async (targetType, targetId, familyId = null) => {
  try {
    // ✅ Normaliser le type pour la base de données
    const dbTargetType = mapTargetType(targetType);
    
    const { data, error } = await supabase.rpc('get_all_aidants_for_target', {
      p_target_type: dbTargetType,
      p_target_id: targetId,
      p_family_id: familyId,
    });

    if (error) {
      console.error('❌ get_all_aidants_for_target error:', error);
      return [];
    }

    // ✅ Trier par priorité (1 = plus haute)
    const sortedData = (data || []).sort((a, b) => (a.priority || 99) - (b.priority || 99));
    
    return sortedData;
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
    // ✅ Normaliser le type pour la base de données
    const dbTargetType = mapTargetType(targetType);
    
    // 1. Vérifier que l'aidant existe et est disponible
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, is_verified, status, available, max_assignments')
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

    switch (dbTargetType) {
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

    // 4. Déterminer la priorité selon le type de cible
    let priority = PRIORITY.PATIENT;
    if (dbTargetType === TARGET_TYPES.PERSONAL_ACCOUNT) {
      priority = PRIORITY.PERSONAL_ACCOUNT;
    } else if (dbTargetType === TARGET_TYPES.FAMILY) {
      priority = PRIORITY.FAMILY;
    }

    // 5. Appeler la fonction SQL
    const { data: assignmentId, error: assignError } = await supabase.rpc('assign_aidant_to_target', {
      p_aidant_user_id: aidantUserId,
      p_target_type: dbTargetType,
      p_target_id: targetId,
      p_family_id: familyId,
      p_assignment_type: assignmentType,
      p_priority: priority,
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

    // 6. Récupérer l'assignation créée via la VUE
    const { data: assignment, error: fetchError } = await supabase
      .from('aidant_assignments_view')  // ✅ Utiliser la vue
      .select('*')
      .eq('id', assignmentId)
      .single();

    if (fetchError) {
      console.error('❌ Erreur récupération assignation:', fetchError);
    }

    // 7. Mettre à jour current_assignments de l'aidant
    await supabase
      .from('aidants')
      .update({
        current_assignments: (currentAssignments || 0) + 1,
        available: (currentAssignments || 0) + 1 < maxAssignments,
        updated_at: new Date().toISOString(),
      })
      .eq('id', aidant.id);

    // 8. Créer les notifications
    await createAssignmentNotifications({
      assignmentId,
      aidantUserId,
      targetType: dbTargetType,
      targetId,
      targetName,
      assignmentType,
      createdBy,
      priority,
    });

    return {
      success: true,
      assignment: assignment || { id: assignmentId },
      target_type: mapTargetTypeForResponse(dbTargetType),
      target_name: targetName,
      priority: priority,
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
 * Récupère toutes les assignations d'un aidant - ✅ UTILISE LA VUE
 * 
 * @param {string} aidantUserId - UUID de l'aidant
 * @param {string} status - Statut des assignations (optionnel)
 * @returns {Promise<Array>} - Liste des assignations
 */
const getAssignmentsByAidant = async (aidantUserId, status = null) => {
  try {
    let query = supabase
      .from('aidant_assignments_view')  // ✅ Utiliser la vue
      .select('*')
      .eq('aidant_user_id', aidantUserId);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query.order('priority', { ascending: true });
    
    if (error) {
      console.error('❌ getAssignmentsByAidant error:', error);
      return [];
    }

    // ✅ Formater les données avec les relations
    const formattedData = (data || []).map((item) => ({
      id: item.id,
      aidant_user_id: item.aidant_user_id,
      target_type: mapTargetTypeForResponse(item.target_type),
      target_id: item.target_id,
      assignment_type: item.assignment_type,
      status: item.status,
      priority: item.priority,
      expires_at: item.expires_at,
      created_at: item.created_at,
      updated_at: item.updated_at,
      created_by: item.created_by,
      reason: item.reason,
      aidant: item.aidant_id ? {
        id: item.aidant_id,
        full_name: item.aidant_name,
        email: item.aidant_email,
        phone: item.aidant_phone,
        avatar_url: item.aidant_avatar,
      } : null,
      target_patient: item.target_type === 'patient' && item.patient_id ? {
        id: item.patient_id,
        first_name: item.patient_first_name,
        last_name: item.patient_last_name,
        address: item.patient_address,
        category: item.patient_category,
        status: item.patient_status,
      } : null,
      target_profile: item.target_type !== 'patient' && item.profile_id ? {
        id: item.profile_id,
        full_name: item.profile_name,
        email: item.profile_email,
        phone: item.profile_phone,
        role: item.profile_role,
      } : null,
    }));

    return formattedData;
  } catch (error) {
    console.error('❌ getAssignmentsByAidant error:', error);
    return [];
  }
};

/**
 * Récupère toutes les assignations pour une cible - ✅ UTILISE LA VUE
 * 
 * @param {string} targetType - 'patient' | 'personal_account' | 'family'
 * @param {string} targetId - UUID de la cible
 * @param {string} status - Statut des assignations (optionnel)
 * @returns {Promise<Array>} - Liste des assignations
 */
const getAssignmentsByTarget = async (targetType, targetId, status = null) => {
  try {
    // ✅ Normaliser le type pour la base de données
    const dbTargetType = mapTargetType(targetType);
    
    let query = supabase
      .from('aidant_assignments_view')  // ✅ Utiliser la vue
      .select('*')
      .eq('target_type', dbTargetType)
      .eq('target_id', targetId);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query.order('priority', { ascending: true });
    
    if (error) {
      console.error('❌ getAssignmentsByTarget error:', error);
      return [];
    }

    // ✅ Formater les données
    const formattedData = (data || []).map((item) => ({
      id: item.id,
      aidant_user_id: item.aidant_user_id,
      target_type: mapTargetTypeForResponse(item.target_type),
      target_id: item.target_id,
      assignment_type: item.assignment_type,
      status: item.status,
      priority: item.priority,
      expires_at: item.expires_at,
      created_at: item.created_at,
      updated_at: item.updated_at,
      created_by: item.created_by,
      reason: item.reason,
      aidant: item.aidant_id ? {
        id: item.aidant_id,
        full_name: item.aidant_name,
        email: item.aidant_email,
        phone: item.aidant_phone,
        avatar_url: item.aidant_avatar,
      } : null,
      target_patient: item.target_type === 'patient' && item.patient_id ? {
        id: item.patient_id,
        first_name: item.patient_first_name,
        last_name: item.patient_last_name,
        address: item.patient_address,
        category: item.patient_category,
        status: item.patient_status,
      } : null,
      target_profile: item.target_type !== 'patient' && item.profile_id ? {
        id: item.profile_id,
        full_name: item.profile_name,
        email: item.profile_email,
        phone: item.profile_phone,
        role: item.profile_role,
      } : null,
    }));

    return formattedData;
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
    // ✅ Normaliser le type pour la base de données
    const dbTargetType = mapTargetType(targetType);
    
    const { data, error } = await supabase
      .from('aidant_assignments')
      .select('*')
      .eq('aidant_user_id', aidantUserId)
      .eq('target_type', dbTargetType)
      .eq('target_id', targetId)
      .eq('status', ASSIGNMENT_STATUS.ACTIVE)
      .maybeSingle();

    if (error) throw error;
    
    // ✅ Transformer pour le frontend
    if (data) {
      data.target_type = mapTargetTypeForResponse(data.target_type);
    }
    
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
  priority,
}) => {
  try {
    const priorityLabel = priority === 1 ? 'prioritaire' : priority === 2 ? 'standard' : 'fallback';
    
    // 1. Notification à l'aidant
    await supabase.from('notifications').insert({
      user_id: aidantUserId,
      title: '📋 Nouvelle assignation',
      body: `Vous avez été assigné à ${targetName} (${assignmentType}) - ${priorityLabel}`,
      type: 'system',
      data: {
        assignment_id: assignmentId,
        target_type: targetType,
        target_id: targetId,
        assignment_type: assignmentType,
        priority: priority,
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
        body: `Un aidant a été assigné à ${targetName} (${assignmentType})`,
        type: 'system',
        data: {
          assignment_id: assignmentId,
          aidant_user_id: aidantUserId,
          target_type: targetType,
          target_id: targetId,
          assignment_type: assignmentType,
          priority: priority,
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
        body: `Un aidant a été assigné à ${targetName} par ${createdBy || 'le système'} (${priorityLabel})`,
        type: 'alert',
        data: {
          assignment_id: assignmentId,
          aidant_user_id: aidantUserId,
          target_type: targetType,
          target_id: targetId,
          priority: priority,
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

  // Fonctions de mapping
  mapTargetType,
  mapTargetTypeForResponse,

  // Fonctions principales
  getActiveAidantForTarget,
  getAllAidantsForTarget,
  assignAidantToTarget,
  revokeAssignment,
  getAssignmentsByAidant,
  getAssignmentsByTarget,
  isAidantAssignedToTarget,
};
