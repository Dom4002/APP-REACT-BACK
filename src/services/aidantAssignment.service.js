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
  PATIENT: 1,
  PERSONAL_ACCOUNT: 2,
  FAMILY: 3,
};

// ============================================================
// FONCTIONS EXISTANTES (gardées intactes)
// ============================================================

// ... [Toutes les fonctions existantes: getActiveAidantForTarget, getAllAidantsForTarget, assignAidantToTarget, revokeAssignment, getAssignmentsByAidant, getAssignmentsByTarget, isAidantAssignedToTarget, createAssignmentNotifications]

// ============================================================
// ✅ NOUVELLES FONCTIONS - ADMIN ASSIGNATION
// ============================================================

/**
 * Vérifie si un aidant est full (current_assignments >= max_assignments)
 * @param {string} aidantUserId - UUID de l'aidant (user_id)
 * @returns {Promise<{isFull: boolean, current: number, max: number}>}
 */
const isAidantFull = async (aidantUserId) => {
  try {
    const { data, error } = await supabase
      .from('aidants')
      .select('current_assignments, max_assignments')
      .eq('user_id', aidantUserId)
      .single();

    if (error) {
      console.error('❌ isAidantFull error:', error);
      return { isFull: true, current: 0, max: 4 };
    }

    const current = data?.current_assignments || 0;
    const max = data?.max_assignments || 4;
    
    return {
      isFull: current >= max,
      current,
      max,
    };
  } catch (error) {
    console.error('❌ isAidantFull error:', error);
    return { isFull: true, current: 0, max: 4 };
  }
};

/**
 * Récupère les aidants disponibles pour une famille
 * (ceux qui ont current_assignments < max_assignments)
 * @param {string} familyId - UUID de la famille (optionnel)
 * @returns {Promise<Array>} - Liste des aidants disponibles
 */
const getAvailableAidantsForFamily = async (familyId = null) => {
  try {
    // Récupérer tous les aidants approuvés
    let query = supabase
      .from('aidants')
      .select(`
        *,
        user:profiles!aidants_user_id_fkey (
          id,
          full_name,
          email,
          phone,
          avatar_url
        )
      `)
      .eq('is_verified', true)
      .eq('status', 'approved')
      .eq('available', true);

    const { data: aidants, error } = await query;

    if (error) {
      console.error('❌ getAvailableAidantsForFamily error:', error);
      return [];
    }

    // Filtrer ceux qui ont de la place
    const available = (aidants || []).filter(a => {
      const current = a.current_assignments || 0;
      const max = a.max_assignments || 4;
      return current < max;
    });

    return available;
  } catch (error) {
    console.error('❌ getAvailableAidantsForFamily error:', error);
    return [];
  }
};

/**
 * Récupère tous les aidants avec leur quota (pour admin)
 * @param {boolean} includeFull - Inclure les aidants full
 * @returns {Promise<Array>} - Liste des aidants avec quota
 */
const getAidantsWithQuota = async (includeFull = true) => {
  try {
    const { data: aidants, error } = await supabase
      .from('aidants')
      .select(`
        *,
        user:profiles!aidants_user_id_fkey (
          id,
          full_name,
          email,
          phone,
          avatar_url
        )
      `)
      .eq('is_verified', true)
      .eq('status', 'approved')
      .order('rating', { ascending: false });

    if (error) {
      console.error('❌ getAidantsWithQuota error:', error);
      return [];
    }

    // Enrichir avec les infos de quota
    const enriched = (aidants || []).map(a => {
      const current = a.current_assignments || 0;
      const max = a.max_assignments || 4;
      return {
        ...a,
        current_assignments: current,
        max_assignments: max,
        is_full: current >= max,
        available_slots: Math.max(0, max - current),
      };
    });

    if (!includeFull) {
      return enriched.filter(a => !a.is_full);
    }

    return enriched;
  } catch (error) {
    console.error('❌ getAidantsWithQuota error:', error);
    return [];
  }
};

/**
 * ADMIN - Assigne un aidant à une visite (même si full)
 * @param {Object} params
 * @param {string} params.visitId - UUID de la visite
 * @param {string} params.aidantUserId - UUID de l'aidant (user_id)
 * @param {string} params.assignmentType - 'permanente' | 'ponctuelle'
 * @param {string} params.adminId - UUID de l'admin
 * @param {string} params.reason - Motif (optionnel)
 * @returns {Promise<Object>} - Résultat de l'assignation
 */
const adminAssignAidantToVisit = async ({
  visitId,
  aidantUserId,
  assignmentType = 'permanente',
  adminId = null,
  reason = null,
}) => {
  try {
    // 1. Vérifier que l'aidant existe et est approuvé
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, is_verified, status, current_assignments, max_assignments')
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

    // 2. Récupérer la visite
    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('*, patient:patients(*)')
      .eq('id', visitId)
      .single();

    if (visitError || !visit) {
      return {
        success: false,
        error: 'Visite non trouvée',
        code: 'VISIT_NOT_FOUND',
      };
    }

    // 3. Vérifier que la visite n'a pas déjà un aidant
    if (visit.aidant_id) {
      return {
        success: false,
        error: 'Cette visite a déjà un aidant assigné',
        code: 'VISIT_HAS_AIDANT',
        current_aidant_id: visit.aidant_id,
      };
    }

    // 4. Déterminer si c'est permanent
    const isPermanent = assignmentType === 'permanente';

    // 5. Mettre à jour la visite
    const updateData = {
      aidant_id: aidant.id,
      status: 'planifiee',
      assignment_type: assignmentType,
      is_permanent: isPermanent,
      assigned_by_admin: true,
      admin_assigned_at: new Date().toISOString(),
      metadata: {
        ...(visit.metadata || {}),
        admin_assigned: true,
        admin_assigned_at: new Date().toISOString(),
        admin_id: adminId,
        assignment_reason: reason || null,
        forced_assignment: aidant.current_assignments >= aidant.max_assignments,
      },
      updated_at: new Date().toISOString(),
    };

    // Si la visite était en attente d'aidant, changer le statut
    if (visit.status === 'en_attente_aidant') {
      updateData.waiting_for_aidant_since = null;
    }

    const { data: updatedVisit, error: updateError } = await supabase
      .from('visites')
      .update(updateData)
      .eq('id', visitId)
      .select(`
        *,
        patient:patients(*),
        aidant:aidants!visites_aidant_id_fkey (
          id,
          user_id,
          specialties,
          available,
          rating,
          total_missions,
          completed_missions,
          cancelled_missions,
          user:profiles!aidants_user_id_fkey (
            id,
            full_name,
            email,
            phone,
            avatar_url
          )
        )
      `)
      .single();

    if (updateError) {
      console.error('❌ adminAssignAidantToVisit update error:', updateError);
      return {
        success: false,
        error: updateError.message || 'Erreur lors de l\'assignation',
        code: 'UPDATE_ERROR',
      };
    }

    // 6. Si permanent, créer l'assignation et incrémenter current_assignments
    let assignment = null;
    let newCurrentAssignments = aidant.current_assignments || 0;

    if (isPermanent) {
      // Créer l'assignation permanente
      const targetType = visit.patient_id ? 'patient' : 'personal_account';
      const targetId = visit.patient_id || visit.user_id;
      const familyId = visit.user_id;

      const result = await assignAidantToTarget({
        aidantUserId: aidant.user_id,
        targetType: targetType,
        targetId: targetId,
        familyId: familyId,
        assignmentType: ASSIGNMENT_TYPES.PRIMARY,
        createdBy: adminId || null,
        reason: reason || `Assigné par admin à la visite ${visitId}`,
        expiresAt: null,
      });

      if (result.success) {
        assignment = result.assignment;
        newCurrentAssignments = (aidant.current_assignments || 0) + 1;

        // Mettre à jour current_assignments (peut dépasser max_assignments)
        await supabase
          .from('aidants')
          .update({
            current_assignments: newCurrentAssignments,
            available: false,
            updated_at: new Date().toISOString(),
          })
          .eq('id', aidant.id);
      }
    }

    // 7. Notifications
    const targetDisplay = visit.target_name || (visit.patient ? `${visit.patient.first_name} ${visit.patient.last_name}` : 'Personnel');

    // À l'aidant
    await supabase.from('notifications').insert({
      user_id: aidant.user_id,
      title: '📅 Nouvelle visite assignée par l\'admin',
      body: `Visite pour ${targetDisplay} le ${visit.scheduled_date} à ${visit.scheduled_time}${isPermanent ? ' (Assignation permanente)' : ' (Ponctuelle)'}`,
      type: 'visite',
      data: {
        visit_id: visitId,
        action: 'approve',
        assigned_by_admin: true,
        is_permanent: isPermanent,
      },
    });

    // À la famille
    if (visit.user_id) {
      await supabase.from('notifications').insert({
        user_id: visit.user_id,
        title: '✅ Un aidant a été assigné à votre visite',
        body: `${aidant.user?.full_name || 'Un aidant'} a été assigné à votre visite du ${visit.scheduled_date}`,
        type: 'visite',
        data: {
          visit_id: visitId,
          aidant_id: aidant.user_id,
          assigned_by_admin: true,
        },
      });
    }

    // Aux admins (si assignment permanent et dépassement)
    if (isPermanent && newCurrentAssignments > (aidant.max_assignments || 4)) {
      const { data: admins } = await supabase
        .from('profiles')
        .select('id')
        .in('role', ['admin', 'coordinator']);

      if (admins && admins.length > 0) {
        const adminNotifications = admins.map((admin) => ({
          user_id: admin.id,
          title: '⚠️ Aidant a dépassé son quota',
          body: `${aidant.user?.full_name || 'L\'aidant'} a maintenant ${newCurrentAssignments} assignations (max ${aidant.max_assignments || 4})`,
          type: 'alert',
          data: {
            aidant_id: aidant.id,
            current_assignments: newCurrentAssignments,
            max_assignments: aidant.max_assignments || 4,
            visit_id: visitId,
          },
        }));

        await supabase.from('notifications').insert(adminNotifications);
      }
    }

    return {
      success: true,
      visit: updatedVisit,
      assignment: assignment,
      is_permanent: isPermanent,
      current_assignments: newCurrentAssignments,
      max_assignments: aidant.max_assignments || 4,
      exceeded_quota: newCurrentAssignments > (aidant.max_assignments || 4),
    };
  } catch (error) {
    console.error('❌ adminAssignAidantToVisit error:', error);
    return {
      success: false,
      error: error.message || 'Erreur lors de l\'assignation admin',
      code: 'UNKNOWN_ERROR',
    };
  }
};

/**
 * Récupère toutes les visites en attente d'aidant
 * @param {Object} filters - Filtres optionnels
 * @returns {Promise<Array>} - Liste des visites
 */
const getPendingAidantVisits = async (filters = {}) => {
  try {
    let query = supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*),
        aidant:aidants!visites_aidant_id_fkey (
          id,
          user_id,
          specialties,
          available,
          rating,
          total_missions,
          completed_missions,
          cancelled_missions,
          user:profiles!aidants_user_id_fkey (
            id,
            full_name,
            email,
            phone,
            avatar_url
          )
        )
      `)
      .eq('status', 'en_attente_aidant')
      .is('aidant_id', null)
      .order('waiting_for_aidant_since', { ascending: true });

    // Filtre par date
    if (filters.date) {
      query = query.eq('scheduled_date', filters.date);
    }

    // Filtre par patient
    if (filters.patientId) {
      query = query.eq('patient_id', filters.patientId);
    }

    // Filtre par famille
    if (filters.familyId) {
      query = query.eq('user_id', filters.familyId);
    }

    const { data, error } = await query;

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
 * Compte les visites en attente d'aidant
 * @param {string} familyId - UUID de la famille (optionnel)
 * @returns {Promise<number>}
 */
const countPendingAidantVisits = async (familyId = null) => {
  try {
    let query = supabase
      .from('visites')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'en_attente_aidant')
      .is('aidant_id', null);

    if (familyId) {
      query = query.eq('user_id', familyId);
    }

    const { count, error } = await query;

    if (error) {
      console.error('❌ countPendingAidantVisits error:', error);
      return 0;
    }

    return count || 0;
  } catch (error) {
    console.error('❌ countPendingAidantVisits error:', error);
    return 0;
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

  // Fonctions principales existantes
  getActiveAidantForTarget,
  getAllAidantsForTarget,
  assignAidantToTarget,
  revokeAssignment,
  getAssignmentsByAidant,
  getAssignmentsByTarget,
  isAidantAssignedToTarget,
  createAssignmentNotifications,

  // ✅ NOUVELLES FONCTIONS
  isAidantFull,
  getAvailableAidantsForFamily,
  getAidantsWithQuota,
  adminAssignAidantToVisit,
  getPendingAidantVisits,
  countPendingAidantVisits,
};
