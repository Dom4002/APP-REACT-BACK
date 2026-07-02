// 📁 backend/src/services/aidantCatalog.service.js

const { supabase } = require('./supabase.service');
const {
  getActiveAidantForTarget,
  getAllAidantsForTarget,
  assignAidantToTarget,
  revokeAssignment,
  TARGET_TYPES,
  ASSIGNMENT_TYPES,
} = require('./aidantAssignment.service');

// ✅ Cache pour les profils (pour éviter les appels répétés)
const profileCache = new Map();

// ============================================================
// RÉCUPÉRER LES AIDANTS DISPONIBLES AVEC FILTRES
// ============================================================
const getAvailableAidants = async (filters = {}) => {
  try {
    let query = supabase
      .from('aidants')
      .select(`
        *,
        user:profiles!user_id(
          id,
          full_name,
          email,
          phone,
          avatar_url
        )
      `)
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

    const { data, error } = await query;
    if (error) throw error;

    // ✅ Utiliser les nouvelles assignations pour les statistiques
    const aidantsWithStats = await Promise.all((data || []).map(async (aidant) => {
      // ✅ Compter les assignations actives (nouvelle table)
      const { count: activeAssignments, error: countError } = await supabase
        .from('aidant_assignments')
        .select('id', { count: 'exact', head: true })
        .eq('aidant_user_id', aidant.user_id)
        .eq('status', 'active');

      if (countError) {
        console.error('❌ Erreur comptage assignations:', countError);
        return {
          ...aidant,
          active_assignments: 0,
          max_assignments: aidant.max_assignments || 4,
          avg_rating: aidant.rating || 0,
          total_reviews: 0,
          is_available: aidant.available,
          availability_status: aidant.available ? 'available' : 'unavailable',
        };
      }

      // ✅ Récupérer les avis
      const { data: reviews, error: reviewsError } = await supabase
        .from('aidant_reviews')
        .select('rating')
        .eq('aidant_id', aidant.id);

      const totalReviews = reviews?.length || 0;
      const avgRating = totalReviews > 0
        ? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
        : aidant.rating || 0;

      const maxAssignments = aidant.max_assignments || 4;
      const isAvailable = aidant.available && (activeAssignments || 0) < maxAssignments;

      return {
        ...aidant,
        active_assignments: activeAssignments || 0,
        max_assignments: maxAssignments,
        avg_rating: Math.round(avgRating * 10) / 10,
        total_reviews: totalReviews,
        is_available: isAvailable,
        availability_status: isAvailable ? 'available' : 
          ((activeAssignments || 0) >= maxAssignments ? 'full' : 'unavailable'),
      };
    }));

    return aidantsWithStats;
  } catch (error) {
    console.error('❌ Get available aidants error:', error);
    throw error;
  }
};

// ============================================================
// RÉCUPÉRER UN AIDANT PAR ID AVEC DÉTAILS
// ============================================================
const getAidantById = async (aidantId) => {
  try {
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select(`
        *,
        user:profiles!user_id(
          id,
          full_name,
          email,
          phone,
          avatar_url
        )
      `)
      .eq('id', aidantId)
      .single();

    if (aidantError) throw aidantError;

    // ✅ Compter les assignations actives (nouvelle table)
    const { count: activeAssignments, error: countError } = await supabase
      .from('aidant_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('aidant_user_id', aidant.user_id)
      .eq('status', 'active');

    if (countError) {
      console.error('❌ Erreur comptage assignations:', countError);
    }

    // ✅ Récupérer les patients assignés (via la nouvelle table)
    const { data: assignments, error: assignmentsError } = await supabase
      .from('aidant_assignments')
      .select(`
        id,
        target_type,
        target_id,
        assignment_type,
        status,
        created_at,
        expires_at,
        target_patient:patients!target_id(
          id,
          first_name,
          last_name,
          address,
          category,
          status
        ),
        target_profile:profiles!target_id(
          id,
          full_name,
          email,
          phone,
          role
        )
      `)
      .eq('aidant_user_id', aidant.user_id)
      .eq('status', 'active');

    if (assignmentsError) {
      console.error('❌ Erreur récupération assignations:', assignmentsError);
    }

    // ✅ Transformer les assignations en format compatible
    const patients = (assignments || [])
      .filter(a => a.target_type === 'patient' && a.target_patient)
      .map(a => ({
        patient_id: a.target_id,
        patient: a.target_patient,
        is_primary: a.assignment_type === 'primary',
        relationship: a.assignment_type,
        created_at: a.created_at,
        target_type: a.target_type,
      }));

    // ✅ Récupérer les avis
    const { data: reviews, error: reviewsError } = await supabase
      .from('aidant_reviews')
      .select(`
        id,
        rating,
        comment,
        categories,
        created_at,
        family:profiles!family_id(
          full_name
        )
      `)
      .eq('aidant_id', aidantId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (reviewsError) {
      console.error('❌ Erreur récupération avis:', reviewsError);
    }

    const totalReviews = reviews?.length || 0;
    const avgRating = totalReviews > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
      : aidant.rating || 0;

    const maxAssignments = aidant.max_assignments || 4;
    const isAvailable = aidant.available && (activeAssignments || 0) < maxAssignments;

    return {
      ...aidant,
      active_assignments: activeAssignments || 0,
      max_assignments: maxAssignments,
      avg_rating: Math.round(avgRating * 10) / 10,
      total_reviews: totalReviews,
      is_available: isAvailable,
      availability_status: isAvailable ? 'available' : 
        ((activeAssignments || 0) >= maxAssignments ? 'full' : 'unavailable'),
      patients: patients || [],
      reviews: reviews || [],
      assignments: assignments || [],
    };
  } catch (error) {
    console.error('❌ Get aidant by ID error:', error);
    throw error;
  }
};

// ============================================================
// ✅ ASSIGNER UN AIDANT - PERSONNEL OU PATIENT (NOUVELLE VERSION)
// ============================================================
const assignAidantToPatient = async (aidantId, familyId, patientId = null, assignmentType = 'permanente') => {
  try {
    // ✅ 1. Récupérer l'aidant
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, available, max_assignments, current_assignments')
      .eq('id', aidantId)
      .single();

    if (aidantError || !aidant) {
      throw new Error('Aidant non trouvé');
    }

    // ✅ 2. Déterminer la cible
    let targetType = TARGET_TYPES.PERSONAL_ACCOUNT;
    let targetId = familyId;

    if (patientId) {
      // Vérifier que le patient existe
      const { data: patient, error: patientError } = await supabase
        .from('patients')
        .select('id, first_name, last_name')
        .eq('id', patientId)
        .single();

      if (patientError || !patient) {
        throw new Error('Patient non trouvé');
      }

      targetType = TARGET_TYPES.PATIENT;
      targetId = patientId;
    }

    // ✅ 3. Vérifier que l'assignation n'existe pas déjà
    const { data: existing, error: existingError } = await supabase
      .from('aidant_assignments')
      .select('id')
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .eq('status', 'active')
      .maybeSingle();

    if (existingError) {
      console.error('❌ Erreur vérification assignation existante:', existingError);
    }

    if (existing) {
      throw new Error('Cet aidant est déjà assigné à ce destinataire');
    }

    // ✅ 4. Convertir le type d'assignation
    const assignmentTypeMap = {
      'permanente': ASSIGNMENT_TYPES.PRIMARY,
      'temporaire': ASSIGNMENT_TYPES.TEMPORARY,
      'ponctuelle': ASSIGNMENT_TYPES.SECONDARY,
    };
    const newAssignmentType = assignmentTypeMap[assignmentType] || ASSIGNMENT_TYPES.PRIMARY;

    // ✅ 5. Appeler le nouveau service d'assignation
    const result = await assignAidantToTarget({
      aidantUserId: aidant.user_id,
      targetType,
      targetId,
      familyId: familyId,
      assignmentType: newAssignmentType,
      createdBy: familyId, // La famille qui assigne
      reason: patientId ? `Assignation au patient ${patientId}` : 'Assignation personnelle',
      expiresAt: null,
    });

    if (!result.success) {
      throw new Error(result.error);
    }

    // ✅ 6. Récupérer les informations pour la réponse
    const targetName = patientId 
      ? (await supabase.from('patients').select('first_name, last_name').eq('id', patientId).single()).data
      : (await supabase.from('profiles').select('full_name').eq('id', familyId).single()).data;

    const isPersonal = !patientId;

    return {
      assignment: result.assignment,
      aidant: result.aidant || aidant,
      is_personal: isPersonal,
      target_type: targetType,
      target_name: isPersonal ? targetName?.full_name : `${targetName?.first_name} ${targetName?.last_name}`,
    };
  } catch (error) {
    console.error('❌ Assign aidant error:', error);
    throw error;
  }
};

// ============================================================
// RÉCUPÉRER LES ASSIGNATIONS D'UNE FAMILLE (NOUVELLE VERSION)
// ============================================================
const getFamilyAssignments = async (familyId) => {
  try {
    // ✅ Récupérer les assignations de la famille via la nouvelle table
    const { data: assignments, error: assignmentsError } = await supabase
      .from('aidant_assignments')
      .select(`
        id,
        target_type,
        target_id,
        assignment_type,
        status,
        created_at,
        expires_at,
        aidant:profiles!aidant_user_id(
          id,
          full_name,
          email,
          phone,
          avatar_url,
          role
        ),
        target_patient:patients!target_id(
          id,
          first_name,
          last_name,
          address,
          category,
          status
        ),
        target_profile:profiles!target_id(
          id,
          full_name,
          email,
          phone,
          role
        )
      `)
      .or(`target_id.eq.${familyId}, target_type.eq.family`)
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (assignmentsError) {
      console.error('❌ Erreur récupération assignations:', assignmentsError);
      // Fallback sur l'ancienne table
      return getFamilyAssignmentsLegacy(familyId);
    }

    // ✅ Transformer en format compatible avec l'ancien système
    const formattedAssignments = (assignments || []).map((item) => {
      const isPatient = item.target_type === 'patient';
      const isPersonal = item.target_type === 'personal_account';

      return {
        id: item.id,
        patient_id: isPatient ? item.target_id : null,
        is_primary: item.assignment_type === 'primary',
        relationship: item.assignment_type,
        created_at: item.created_at,
        target_type: item.target_type,
        patient: isPatient ? item.target_patient : null,
        family: item.target_profile || null,
        aidant: {
          id: item.aidant?.id,
          user_id: item.aidant?.id,
          specialties: [],
          available: true,
          rating: 0,
          user: item.aidant || null,
        },
        is_personal: isPersonal,
        target_name: isPatient 
          ? `${item.target_patient?.first_name || ''} ${item.target_patient?.last_name || ''}`.trim()
          : item.target_profile?.full_name || 'Compte personnel',
      };
    });

    return formattedAssignments;
  } catch (error) {
    console.error('❌ Get family assignments error:', error);
    // Fallback sur l'ancienne table
    return getFamilyAssignmentsLegacy(familyId);
  }
};

// ============================================================
// RÉCUPÉRER LES ASSIGNATIONS D'UNE FAMILLE (LEGACY - FALLBACK)
// ============================================================
const getFamilyAssignmentsLegacy = async (familyId) => {
  try {
    const { data, error } = await supabase
      .from('patient_family_links')
      .select(`
        id,
        patient_id,
        is_primary,
        relationship,
        created_at,
        target_type,
        patient:patients(
          id,
          first_name,
          last_name,
          address,
          category,
          status
        ),
        family:profiles!family_id(
          id,
          full_name,
          email,
          phone
        )
      `)
      .eq('family_id', familyId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const assignmentsWithAidant = await Promise.all((data || []).map(async (item) => {
      const { data: aidant, error: aidantError } = await supabase
        .from('aidants')
        .select(`
          id,
          user_id,
          specialties,
          available,
          rating,
          user:profiles!user_id(
            full_name,
            email,
            phone,
            avatar_url
          )
        `)
        .eq('user_id', item.family_id)
        .maybeSingle();

      return {
        ...item,
        aidant: aidant || null,
      };
    }));

    return assignmentsWithAidant || [];
  } catch (error) {
    console.error('❌ Get family assignments legacy error:', error);
    throw error;
  }
};

// ============================================================
// RÉCUPÉRER LES ASSIGNATIONS D'UN AIDANT (NOUVELLE VERSION)
// ============================================================
const getAidantAssignments = async (aidantUserId) => {
  try {
    const { data, error } = await supabase
      .from('aidant_assignments')
      .select(`
        id,
        target_type,
        target_id,
        assignment_type,
        status,
        created_at,
        expires_at,
        target_patient:patients!target_id(
          id,
          first_name,
          last_name,
          address,
          category,
          status
        ),
        target_profile:profiles!target_id(
          id,
          full_name,
          email,
          phone,
          role
        )
      `)
      .eq('aidant_user_id', aidantUserId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Erreur récupération assignations aidant:', error);
      return getAidantAssignmentsLegacy(aidantUserId);
    }

    // ✅ Transformer en format compatible
    const formattedAssignments = (data || []).map((item) => {
      const isPatient = item.target_type === 'patient';
      const isPersonal = item.target_type === 'personal_account';

      return {
        id: item.id,
        patient_id: isPatient ? item.target_id : null,
        is_primary: item.assignment_type === 'primary',
        relationship: item.assignment_type,
        created_at: item.created_at,
        target_type: item.target_type,
        patient: isPatient ? item.target_patient : null,
        family: isPersonal ? item.target_profile : null,
        is_personal: isPersonal,
        target_name: isPatient 
          ? `${item.target_patient?.first_name || ''} ${item.target_patient?.last_name || ''}`.trim()
          : item.target_profile?.full_name || 'Compte personnel',
        expires_at: item.expires_at,
        status: item.status,
        assignment_type: item.assignment_type,
      };
    });

    return formattedAssignments;
  } catch (error) {
    console.error('❌ Get aidant assignments error:', error);
    return getAidantAssignmentsLegacy(aidantUserId);
  }
};

// ============================================================
// RÉCUPÉRER LES ASSIGNATIONS D'UN AIDANT (LEGACY - FALLBACK)
// ============================================================
const getAidantAssignmentsLegacy = async (aidantUserId) => {
  try {
    const { data, error } = await supabase
      .from('patient_family_links')
      .select(`
        id,
        patient_id,
        is_primary,
        relationship,
        created_at,
        target_type,
        patient:patients(
          id,
          first_name,
          last_name,
          address,
          category,
          status
        ),
        family:profiles!family_id(
          id,
          full_name,
          email,
          phone,
          role
        )
      `)
      .eq('family_id', aidantUserId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('❌ Get aidant assignments legacy error:', error);
    throw error;
  }
};

// ============================================================
// RÉVOQUER UNE ASSIGNATION (NOUVELLE VERSION)
// ============================================================
const revokeAssignment = async (assignmentId, familyId) => {
  try {
    // ✅ 1. Récupérer l'assignation
    const { data: assignment, error: fetchError } = await supabase
      .from('aidant_assignments')
      .select('*')
      .eq('id', assignmentId)
      .single();

    if (fetchError || !assignment) {
      // Fallback sur l'ancienne table
      return revokeAssignmentLegacy(assignmentId, familyId);
    }

    // ✅ 2. Vérifier les permissions
    const isAdmin = ['admin', 'coordinator'].includes(req?.profile?.role);
    const isOwner = assignment.target_id === familyId || assignment.target_type === 'family';

    if (!isAdmin && !isOwner) {
      throw new Error('Non autorisé à révoquer cette assignation');
    }

    // ✅ 3. Récupérer les informations pour les notifications
    const { data: aidant, error: aidantError } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .eq('id', assignment.aidant_user_id)
      .single();

    let targetName = 'cible';
    if (assignment.target_type === 'patient') {
      const { data: patient } = await supabase
        .from('patients')
        .select('first_name, last_name')
        .eq('id', assignment.target_id)
        .single();
      if (patient) {
        targetName = `${patient.first_name} ${patient.last_name}`;
      }
    } else {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', assignment.target_id)
        .single();
      if (profile) {
        targetName = profile.full_name;
      }
    }

    const isPersonal = assignment.target_type === 'personal_account';

    // ✅ 4. Appeler la fonction de révocation
    const result = await revokeAssignment(assignmentId, familyId, 'Révoqué par l\'utilisateur');

    if (!result.success) {
      throw new Error(result.error);
    }

    // ✅ 5. Notifications
    await supabase.from('notifications').insert({
      user_id: assignment.aidant_user_id,
      title: '🔄 Assignation révoquée',
      body: `Votre assignation à ${targetName} a été révoquée.`,
      type: 'system',
      data: {
        assignment_id: assignmentId,
        target_type: assignment.target_type,
        target_id: assignment.target_id,
        is_personal: isPersonal,
      },
    });

    // ✅ 6. Mettre à jour le cache
    profileCache.delete(assignment.aidant_user_id);

    return result;
  } catch (error) {
    console.error('❌ Revoke assignment error:', error);
    // Fallback sur l'ancienne méthode
    return revokeAssignmentLegacy(assignmentId, familyId);
  }
};

// ============================================================
// RÉVOQUER UNE ASSIGNATION (LEGACY - FALLBACK)
// ============================================================
const revokeAssignmentLegacy = async (assignmentId, familyId) => {
  try {
    const { data: link, error: linkError } = await supabase
      .from('patient_family_links')
      .select('*')
      .eq('id', assignmentId)
      .eq('family_id', familyId)
      .single();

    if (linkError || !link) {
      throw new Error('Assignation non trouvée ou non autorisée');
    }

    const { error: deleteError } = await supabase
      .from('patient_family_links')
      .delete()
      .eq('id', assignmentId);

    if (deleteError) {
      throw new Error('Erreur lors de la révocation');
    }

    return { success: true, assignment: link };
  } catch (error) {
    console.error('❌ Revoke assignment legacy error:', error);
    throw error;
  }
};

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getAvailableAidants,
  getAidantById,
  assignAidantToPatient,
  getFamilyAssignments,
  getAidantAssignments,
  revokeAssignment,
};
