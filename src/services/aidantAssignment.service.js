// 📁 backend/src/services/aidantAssignment.service.js
 
const { supabase } = require('./supabase.service');

// ============================================================
// CONSTANTES - AVEC MAPPING POUR COMPATIBILITÉ FRONTEND
// ============================================================

const TARGET_TYPES = {
  PATIENT: 'patient',
  PERSONAL_ACCOUNT: 'personal_account',
  PERSONAL: 'personal',            
  FAMILY: 'family',
};

// ✅ Mapping pour normaliser les types venant du frontend
const mapTargetType = (type) => {
  if (!type) return type;
  const normalized = type.toLowerCase();
  
  if (normalized === 'personal') return TARGET_TYPES.PERSONAL_ACCOUNT;
  if (normalized === 'personal_account') return TARGET_TYPES.PERSONAL_ACCOUNT;
  if (normalized === 'patient') return TARGET_TYPES.PATIENT;
  if (normalized === 'family') return TARGET_TYPES.FAMILY;
  
  return type;
};

// ✅ Mapping inverse pour les réponses
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
      console.log(`ℹ️ Aucun aidant trouvé pour ${targetType}/${targetId}`);
      return null;
    }

    // VÉRIFIER SI data EST UN aidant_id OU un user_id
    const { data: aidantById, error: errorById } = await supabase
      .from('aidants')
      .select('id')
      .eq('id', data)
      .maybeSingle();

    if (!errorById && aidantById) {
      console.log(`✅ getActiveAidantForTarget: data est un aidant_id: ${data}`);
      return data;
    }

    const { data: aidantByUser, error: errorByUser } = await supabase
      .from('aidants')
      .select('id')
      .eq('user_id', data)
      .maybeSingle();

    if (!errorByUser && aidantByUser) {
      console.log(`🔄 Conversion user_id ${data} → aidant_id ${aidantByUser.id}`);
      return aidantByUser.id;
    }

    const { data: aidantByAny, error: errorAny } = await supabase
      .from('aidants')
      .select('id')
      .or(`id.eq.${data}, user_id.eq.${data}`)
      .maybeSingle();

    if (!errorAny && aidantByAny) {
      console.log(`🔄 Fallback: ${data} → aidant_id ${aidantByAny.id}`);
      return aidantByAny.id;
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
 */
const getAllAidantsForTarget = async (targetType, targetId, familyId = null) => {
  try {
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

    const sortedData = (data || []).sort((a, b) => (a.priority || 99) - (b.priority || 99));
    
    return sortedData;
  } catch (error) {
    console.error('❌ getAllAidantsForTarget error:', error);
    return [];
  }
};

/**
 * Assigne un aidant à une cible (Avec paramètre force intégré)
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
  force = false, // ✅ CORRECTIF : Ajout du paramètre force pour ignorer les quotas
}) => {
  try {
    const dbTargetType = mapTargetType(targetType);
    
    // 1. Vérifier que l'aidant existe et est disponible
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, is_verified, status, available, max_assignments, current_assignments')
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

    // 2. Vérifier le quota (seulement si force est désactivé)
    const currentAssignments = aidant.current_assignments || 0;
    const maxAssignments = aidant.max_assignments || 4;
    
    if (!force && currentAssignments >= maxAssignments) {
      return {
        success: false,
        error: `Cet aidant a déjà ${currentAssignments} assignations (maximum ${maxAssignments})`,
        code: 'AIDANT_FULL',
        current: currentAssignments,
        max: maxAssignments,
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

    // 4. Déterminer la priorité
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

    const { data: assignment, error: fetchError } = await supabase
      .from('aidant_assignments_view')
      .select('*')
      .eq('id', assignmentId)
      .single();

    if (fetchError) {
      console.error('❌ Erreur récupération assignation:', fetchError);
    }

    // 6. Mettre à jour current_assignments de l'aidant
    await supabase
      .from('aidants')
      .update({
        current_assignments: currentAssignments + 1,
        available: (currentAssignments + 1) < maxAssignments,
        updated_at: new Date().toISOString(),
      })
      .eq('id', aidant.id);

    // 7. Créer les notifications
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
 */
const revokeAssignment = async (assignmentId, revokedBy = null, reason = null) => {
  try {
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

    const { data: result, error: updateError } = await supabase
      .from('aidant_assignments')
      .update({
        status: ASSIGNMENT_STATUS.INACTIVE,
        revoked_by: revokedBy,
        revoked_at: new Date().toISOString(),
        revocation_reason: reason || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', assignmentId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ revokeAssignment update error:', updateError);
      return {
        success: false,
        error: updateError.message || 'Erreur lors de la révocation',
        code: 'REVOKE_ERROR',
      };
    }

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
      assignment: result,
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
 */
const getAssignmentsByAidant = async (aidantUserId, status = null) => {
  try {
    let query = supabase
      .from('aidant_assignments_view')
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
 * Récupère toutes les assignations pour une cible
 */
const getAssignmentsByTarget = async (targetType, targetId, status = null) => {
  try {
    const dbTargetType = mapTargetType(targetType);
    
    let query = supabase
      .from('aidant_assignments_view')
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
 */
const isAidantAssignedToTarget = async (aidantUserId, targetType, targetId) => {
  try {
    const dbTargetType = mapTargetType(targetType);
    
    const { data, error } = await supabase
      .from('aidant_assignments')
      .select('*')
      .eq('id', aidantUserId)
      .eq('target_type', dbTargetType)
      .eq('target_id', targetId)
      .eq('status', ASSIGNMENT_STATUS.ACTIVE)
      .maybeSingle();

    if (error) throw error;
    
    if (data) {
      data.target_type = mapTargetTypeForResponse(data.target_type);
    }
    
    return data;
  } catch (error) {
    console.error('❌ isAidantAssignedToTarget error:', error);
    return null;
  }
};

/**
 * Vérifie si un aidant est full
 */
const isAidantFull = async (aidantUserId) => {
  try {
    const { data: aidant, error } = await supabase
      .from('aidants')
      .select('current_assignments, max_assignments')
      .eq('user_id', aidantUserId)
      .single();

    if (error || !aidant) {
      return { isFull: true, current: 0, max: 4 };
    }

    const current = aidant.current_assignments || 0;
    const max = aidant.max_assignments || 4;

    return {
      isFull: current >= max,
      current,
      max,
      remaining: Math.max(0, max - current),
    };
  } catch (error) {
    console.error('❌ isAidantFull error:', error);
    return { isFull: true, current: 0, max: 4 };
  }
};

/**
 * Récupère les aidants disponibles pour une famille
 */
const getAvailableAidantsForFamily = async (familyId, filters = {}) => {
  try {
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
      .eq('status', 'approved')
      .eq('is_verified', true);

    if (filters.zone) {
      query = query.contains('zones', [filters.zone]);
    }

    if (filters.specialty) {
      query = query.contains('specialties', [filters.specialty]);
    }

    if (filters.minRating) {
      query = query.gte('rating', filters.minRating);
    }

    const { data: aidants, error } = await query;

    if (error) {
      console.error('❌ getAvailableAidantsForFamily error:', error);
      return [];
    }

    const availableAidants = (aidants || []).filter((aidant) => {
      const current = aidant.current_assignments || 0;
      const max = aidant.max_assignments || 4;
      return current < max;
    });

    return availableAidants.map((aidant) => ({
      ...aidant,
      current_assignments: aidant.current_assignments || 0,
      max_assignments: aidant.max_assignments || 4,
      available_slots: Math.max(0, (aidant.max_assignments || 4) - (aidant.current_assignments || 0)),
      is_available: (aidant.current_assignments || 0) < (aidant.max_assignments || 4),
    }));
  } catch (error) {
    console.error('❌ getAvailableAidantsForFamily error:', error);
    return [];
  }
};

/**
 * Récupère les aidants avec leur quota actuel
 */
const getAidantsWithQuota = async (filters = {}) => {
  try {
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
      .eq('status', 'approved')
      .eq('is_verified', true);

    const { data: aidants, error } = await query;

    if (error) {
      console.error('❌ getAidantsWithQuota error:', error);
      return [];
    }

    return (aidants || []).map((aidant) => ({
      ...aidant,
      current_assignments: aidant.current_assignments || 0,
      max_assignments: aidant.max_assignments || 4,
      available_slots: Math.max(0, (aidant.max_assignments || 4) - (aidant.current_assignments || 0)),
      is_available: (aidant.current_assignments || 0) < (aidant.max_assignments || 4),
    }));
  } catch (error) {
    console.error('❌ getAidantsWithQuota error:', error);
    return [];
  }
};

/**
 * Assigne un aidant à une visite (admin - force)
 */
const adminAssignAidantToVisit = async ({
  visitId,
  aidantUserId,
  assignmentType = 'permanente',
  adminId = null,
  reason = null,
  force = false,
}) => {
  try {
    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', visitId)
      .single();

    if (visitError || !visit) {
      return {
        success: false,
        error: 'Visite non trouvée',
        code: 'VISIT_NOT_FOUND',
      };
    }

    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('*')
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

    const currentAssignments = aidant.current_assignments || 0;
    const maxAssignments = aidant.max_assignments || 4;

    if (!force && currentAssignments >= maxAssignments) {
      return {
        success: false,
        error: `Cet aidant a déjà ${currentAssignments} assignations (maximum ${maxAssignments})`,
        code: 'AIDANT_FULL',
        current: currentAssignments,
        max: maxAssignments,
      };
    }

    const isPermanent = assignmentType === 'permanente';
    const assignmentTypeValue = isPermanent ? ASSIGNMENT_TYPES.PRIMARY : ASSIGNMENT_TYPES.TEMPORARY;

    const updateData = {
      aidant_id: aidant.id,
      status: 'planifiee',
      assignment_type: assignmentType,
      is_permanent: isPermanent,
      assigned_by_admin: true,
      admin_assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (visit.status === 'en_attente_aidant') {
      updateData.waiting_for_aidant_since = null;
    }

    const { data: updatedVisit, error: updateError } = await supabase
      .from('visites')
      .update(updateData)
      .eq('id', visitId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ adminAssignAidantToVisit update error:', updateError);
      return {
        success: false,
        error: updateError.message || 'Erreur lors de la mise à jour de la visite',
        code: 'UPDATE_ERROR',
      };
    }

    if (isPermanent) {
      const targetType = visit.patient_id ? TARGET_TYPES.PATIENT : TARGET_TYPES.PERSONAL_ACCOUNT;
      const targetId = visit.patient_id || visit.user_id;

      // ✅ TRANSMISSION DU PARAMÈTRE FORCE : Permet de contourner le quota dans le service d'assignation
      const assignmentResult = await assignAidantToTarget({
        aidantUserId: aidantUserId,
        targetType: targetType,
        targetId: targetId,
        familyId: visit.user_id,
        assignmentType: ASSIGNMENT_TYPES.PRIMARY,
        createdBy: adminId,
        reason: reason || `Assignation forcée par admin pour la visite ${visitId}`,
        expiresAt: null,
        force: force, // ✅ Transmission de 'force'
      });

      if (!assignmentResult.success) {
        console.warn('⚠️ Échec création assignation permanente:', assignmentResult.error);
      }
    }

    await createAidantAssignmentNotifications({
      visitId,
      aidantUserId,
      targetName: visit.target_name || visit.patient?.first_name || 'Patient',
      assignmentType,
      adminId,
      isPermanent,
      force,
    });

    return {
      success: true,
      message: `Aidant assigné avec succès${force ? ' (force)' : ''}`,
      visit: updatedVisit,
      assignment_type: assignmentType,
      is_permanent: isPermanent,
      forced: force,
      current_assignments: isPermanent ? currentAssignments + 1 : currentAssignments,
    };
  } catch (error) {
    console.error('❌ adminAssignAidantToVisit error:', error);
    return {
      success: false,
      error: error.message || 'Erreur lors de l\'assignation',
      code: 'UNKNOWN_ERROR',
    };
  }
};

/**
 * Crée les notifications pour une assignation admin
 */
const createAidantAssignmentNotifications = async ({
  visitId,
  aidantUserId,
  targetName,
  assignmentType,
  adminId,
  isPermanent,
  force,
}) => {
  try {
    const aidantMessage = isPermanent
      ? `Vous avez été assigné en tant qu'aidant permanent pour ${targetName}${force ? ' (forcé)' : ''}`
      : `Vous avez été assigné pour la visite de ${targetName}${force ? ' (forcé)' : ''}`;

    await supabase.from('notifications').insert({
      user_id: aidantUserId,
      title: '📅 Nouvelle visite assignée',
      body: aidantMessage,
      type: 'visite',
      data: {
        visit_id: visitId,
        assignment_type: assignmentType,
        is_permanent: isPermanent,
        forced: force || false,
        action: 'approve',
      },
    });

    const { data: visit } = await supabase
      .from('visites')
      .select('user_id, patient_id')
      .eq('id', visitId)
      .single();

    if (visit) {
      await supabase.from('notifications').insert({
        user_id: visit.user_id,
        title: '✅ Un aidant a été assigné à votre visite',
        body: `Un aidant a été assigné pour la visite de ${targetName}`,
        type: 'visite',
        data: {
          visit_id: visitId,
          assignment_type: assignmentType,
          is_permanent: isPermanent,
        },
      });
    }

    if (force) {
      const { data: admins } = await supabase
        .from('profiles')
        .select('id')
        .in('role', ['admin', 'coordinator']);

      if (admins && admins.length > 0) {
        const adminNotifications = admins.map((admin) => ({
          user_id: admin.id,
          title: '👔 Assignation forcée effectuée',
          body: `${adminId ? 'Un admin' : 'Le système'} a forcé l'assignation de ${targetName}`,
          type: 'alert',
          data: {
            visit_id: visitId,
            aidant_user_id: aidantUserId,
            assignment_type: assignmentType,
            forced: true,
          },
        }));

        await supabase.from('notifications').insert(adminNotifications);
      }
    }

    if (force && isPermanent) {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('current_assignments, max_assignments')
        .eq('user_id', aidantUserId)
        .single();

      if (aidant && aidant.current_assignments > aidant.max_assignments) {
        const { data: admins } = await supabase
          .from('profiles')
          .select('id')
          .in('role', ['admin', 'coordinator']);

        if (admins && admins.length > 0) {
          const adminNotifications = admins.map((admin) => ({
            user_id: admin.id,
            title: '⚠️ Quota d\'assignations dépassé',
            body: `L'aidant ${aidantUserId} a maintenant ${aidant.current_assignments}/${aidant.max_assignments} assignations`,
            type: 'alert',
            data: {
              aidant_user_id: aidantUserId,
              current: aidant.current_assignments,
              max: aidant.max_assignments,
            },
          }));

          await supabase.from('notifications').insert(adminNotifications);
        }
      }
    }
  } catch (error) {
    console.error('❌ createAidantAssignmentNotifications error:', error);
  }
};

/**
 * Récupère toutes les visites en attente d'aidant
 */
const getPendingAidantVisits = async () => {
  try {
    const { data, error } = await supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*),
        family:profiles!visites_user_id_fkey(
          id,
          full_name,
          email,
          phone
        )
      `)
      .eq('status', 'en_attente_aidant')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('❌ getPendingAidantVisits error:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('❌ getPendingAidantVisits error:', error);
    return [];
  }
};

/**
 * Récupère les options du wizard pour une visite
 */
const getVisitWizardOptions = async (targetType, targetId, familyId) => {
  try {
    const existingAidant = await getActiveAidantForTarget(targetType, targetId, familyId);

    if (existingAidant) {
      return {
        hasAidant: true,
        aidantId: existingAidant,
        options: [
          {
            type: 'auto',
            label: '✅ Aidant automatique',
            description: 'Un aidant est déjà assigné à ce compte',
          },
        ],
        canProceed: true,
      };
    }

    const availableAidants = await getAvailableAidantsForFamily(familyId);

    if (availableAidants.length > 0) {
      return {
        hasAidant: false,
        hasAvailableAidants: true,
        aidants: availableAidants,
        options: [
          {
            type: 'ponctuelle',
            label: '⚡ Pour cette visite uniquement',
            description: 'Ne consomme pas de quota',
            quota: 0,
          },
          {
            type: 'permanente',
            label: '📌 Permanent',
            description: 'Consomme 1 quota',
            quota: 1,
          },
        ],
        canProceed: true,
        allFull: false,
      };
    }

    return {
      hasAidant: false,
      hasAvailableAidants: false,
      aidants: [],
      options: [
        {
          type: 'without_aidant',
          label: '⚡ Planifier sans aidant',
          description: 'L\'admin sera notifié pour assigner un aidant',
          quota: 0,
        },
      ],
      canProceed: true,
      allFull: true,
      message: 'Tous les aidants sont actuellement complets (4/4)',
    };
  } catch (error) {
    console.error('❌ getVisitWizardOptions error:', error);
    return {
      hasAidant: false,
      hasAvailableAidants: false,
      aidants: [],
      options: [],
      canProceed: false,
      error: error.message,
    };
  }
};

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

    let ownerId = null;

    if (targetType === TARGET_TYPES.PATIENT) {
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

module.exports = {
  // Constantes
  TARGET_TYPES,
  ASSIGNMENT_TYPES,
  ASSIGNMENT_STATUS,
  PRIORITY,

  // Fonctions de mapping
  mapTargetType,
  mapTargetTypeForResponse,

  // Fonctions principales existantes
  getActiveAidantForTarget,
  getAllAidantsForTarget,
  assignAidantToTarget,
  revokeAssignment,
  getAssignmentsByAidant,
  getAssignmentsByTarget,
  isAidantAssignedToTarget,

  // 🆕 Nouvelles fonctions
  isAidantFull,
  getAvailableAidantsForFamily,
  getAidantsWithQuota,
  adminAssignAidantToVisit,
  getPendingAidantVisits,
  getVisitWizardOptions,
};
