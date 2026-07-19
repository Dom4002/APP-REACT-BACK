// 📁 backend/src/services/aidantCatalog.service.js
// ✅ SERVICE CATALOGUE AIDANTS : COMPTAGE STRICT DES QUOTAS PAR ASSIGNATIONS PERMANENTES (PRIMARY ONLY)

const { supabase } = require('./supabase.service');
const {
  getActiveAidantForTarget,
  getAllAidantsForTarget,
  assignAidantToTarget,
  TARGET_TYPES,
  ASSIGNMENT_TYPES,
  getAvailableAidantsForFamily,
  getAidantsWithQuota,
  isAidantFull,
} = require('./aidantAssignment.service');

const { revokeAssignment: revokeAssignmentNew } = require('./aidantAssignment.service');

// Cache pour les profils
const profileCache = new Map();

// ============================================================
// CONSTANTES
// ============================================================

const DEFAULT_MAX_ASSIGNMENTS = 4;
const DEFAULT_MAX_ORDERS = 2;

// ============================================================
// RÉCUPÉRER LES AIDANTS DISPONIBLES AVEC FILTRES
// ============================================================
const getAvailableAidants = async (filters = {}) => {
  try {
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

    // ✅ Calculer les stats pour chaque aidant
    const aidantsWithStats = await Promise.all((aidants || []).map(async (aidant) => {
      
      // ✅ COHÉRENCE QUOTA : Compter uniquement les assignations permanentes ('primary') actives ! [30]
      const { count: activeAssignments, error: countError } = await supabase
        .from('aidant_assignments')
        .select('id', { count: 'exact', head: true })
        .eq('aidant_user_id', aidant.user_id)
        .eq('status', 'active')
        .eq('assignment_type', 'primary'); // ✅ Filtre d'unicité permanent [30]

      if (countError) {
        console.error('❌ Erreur comptage assignations:', countError);
      }

      const { count: currentOrders, error: ordersError } = await supabase
        .from('commandes')
        .select('id', { count: 'exact', head: true })
        .eq('current_aidant_id', aidant.id)
        .in('status', ['en_cours', 'en_attente']);

      if (ordersError) {
        console.error('❌ Erreur comptage commandes:', ordersError);
      }

      const maxAssignments = aidant.max_assignments || DEFAULT_MAX_ASSIGNMENTS;
      const maxOrders = aidant.max_orders || DEFAULT_MAX_ORDERS;
      const isAvailable = aidant.available && (activeAssignments || 0) < maxAssignments;

      return {
        ...aidant,
        user: aidant.user_id ? profileMap[aidant.user_id] || null : null,
        active_assignments: activeAssignments || 0,
        max_assignments: maxAssignments,
        current_orders: currentOrders || 0,
        max_orders: maxOrders,
        is_available: isAvailable,
        availability_status: isAvailable ? 'available' : 
          ((activeAssignments || 0) >= maxAssignments ? 'full' : 'unavailable'),
        available_slots: Math.max(0, maxAssignments - (activeAssignments || 0)),
        orders_available: Math.max(0, maxOrders - (currentOrders || 0)),
      };
    }));

    // ✅ Filtrer par quota si demandé
    let result = aidantsWithStats;
    if (filters.hasQuota === true) {
      result = result.filter(a => a.available_slots > 0);
    }

    return result;
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

    // ✅ COHÉRENCE QUOTA : Compter uniquement les assignations permanentes ('primary') actives ! 
    const { count: activeAssignments, error: countError } = await supabase
      .from('aidant_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('aidant_user_id', aidant.user_id)
      .eq('status', 'active')
      .eq('assignment_type', 'primary');  

    if (countError) {
      console.error('❌ Erreur comptage assignations:', countError);
    }

    const { count: currentOrders, error: ordersError } = await supabase
      .from('commandes')
      .select('id', { count: 'exact', head: true })
      .eq('current_aidant_id', aidant.id)
      .in('status', ['en_cours', 'en_attente']);

    if (ordersError) {
      console.error('❌ Erreur comptage commandes:', ordersError);
    }

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

    const maxAssignments = aidant.max_assignments || DEFAULT_MAX_ASSIGNMENTS;
    const maxOrders = aidant.max_orders || DEFAULT_MAX_ORDERS;
    const isAvailable = aidant.available && (activeAssignments || 0) < maxAssignments;

    return {
      ...aidant,
      active_assignments: activeAssignments || 0,
      max_assignments: maxAssignments,
      current_orders: currentOrders || 0,
      max_orders: maxOrders,
      avg_rating: Math.round(avgRating * 10) / 10,
      total_reviews: totalReviews,
      is_available: isAvailable,
      availability_status: isAvailable ? 'available' : 
        ((activeAssignments || 0) >= maxAssignments ? 'full' : 'unavailable'),
      available_slots: Math.max(0, maxAssignments - (activeAssignments || 0)),
      orders_available: Math.max(0, maxOrders - (currentOrders || 0)),
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
// ✅ ASSIGNER UN AIDANT (AVEC PATIENT OPTIONNEL)
// ============================================================
const assignAidantToPatient = async (aidantId, familyId, patientId = null, assignmentType = 'permanente') => {
  try {
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, available, max_assignments, current_assignments')
      .eq('id', aidantId)
      .single();

    if (aidantError || !aidant) {
      throw new Error('Aidant non trouvé');
    }

    let targetType = TARGET_TYPES.PERSONAL_ACCOUNT;
    let targetId = familyId;

    if (patientId) {
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

    const assignmentTypeMap = {
      'permanente': ASSIGNMENT_TYPES.PRIMARY,
      'temporaire': ASSIGNMENT_TYPES.TEMPORARY,
      'ponctuelle': ASSIGNMENT_TYPES.SECONDARY,
    };
    const newAssignmentType = assignmentTypeMap[assignmentType] || ASSIGNMENT_TYPES.PRIMARY;

    const result = await assignAidantToTarget({
      aidantUserId: aidant.user_id,
      targetType,
      targetId,
      familyId: familyId,
      assignmentType: newAssignmentType,
      createdBy: familyId,
      reason: patientId ? `Assignation au patient ${patientId}` : 'Assignation personnelle',
      expiresAt: null,
    });

    if (!result.success) {
      throw new Error(result.error);
    }

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
// RÉCUPÉRER LES ASSIGNATIONS D'UNE FAMILLE
// ============================================================
const getFamilyAssignments = async (familyId) => {
  try {
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
      return getFamilyAssignmentsLegacy(familyId);
    }

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
        expires_at: item.expires_at,
        status: item.status,
        assignment_type: item.assignment_type,
      };
    });

    return formattedAssignments;
  } catch (error) {
    console.error('❌ Get family assignments error:', error);
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
// RÉCUPÉRER LES ASSIGNATIONS D'UN AIDANT
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
// ✅ RÉVOQUER UNE ASSIGNATION
// ============================================================
const revokeAssignment = async (assignmentId, familyId) => {
  try {
    // Vérifier l'assignation
    const { data: assignment, error: fetchError } = await supabase
      .from('aidant_assignments')
      .select('*')
      .eq('id', assignmentId)
      .single();

    if (fetchError || !assignment) {
      return revokeAssignmentLegacy(assignmentId, familyId);
    }

    // Utiliser la nouvelle fonction
    const result = await revokeAssignmentNew(assignmentId, familyId, 'Révoqué par l\'utilisateur');

    if (!result.success) {
      throw new Error(result.error);
    }

    // Mettre à jour le cache
    profileCache.delete(assignment.aidant_user_id);

    return result;
  } catch (error) {
    console.error('❌ Revoke assignment error:', error);
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
// 🆕 NOUVELLES FONCTIONS
// ============================================================

// ============================================================
// RÉCUPÉRER LES AIDANTS DISPONIBLES POUR UNE FAMILLE
// ============================================================
const getAvailableAidantsForFamilyCatalog = async (familyId, filters = {}) => {
  try {
    // Utiliser la fonction existante de aidantAssignment.service
    const aidants = await getAvailableAidantsForFamily(familyId, filters);

    // Enrichir avec les informations de commandes
    const aidantsWithOrders = await Promise.all((aidants || []).map(async (aidant) => {
      const { count: currentOrders, error: ordersError } = await supabase
        .from('commandes')
        .select('id', { count: 'exact', head: true })
        .eq('current_aidant_id', aidant.id)
        .in('status', ['en_cours', 'en_attente']);

      if (ordersError) {
        console.error('❌ Erreur comptage commandes:', ordersError);
      }

      const maxOrders = aidant.max_orders || DEFAULT_MAX_ORDERS;

      return {
        ...aidant,
        current_orders: currentOrders || 0,
        max_orders: maxOrders,
        orders_available: Math.max(0, maxOrders - (currentOrders || 0)),
        can_take_order: (currentOrders || 0) < maxOrders,
      };
    }));

    return aidantsWithOrders;
  } catch (error) {
    console.error('❌ getAvailableAidantsForFamilyCatalog error:', error);
    throw error;
  }
};

// ============================================================
// RÉCUPÉRER LES AIDANTS AVEC LEUR QUOTA
// ============================================================
const getAidantsByAvailability = async (filters = {}) => {
  try {
    const aidants = await getAidantsWithQuota(filters);

    // Enrichir avec les informations de commandes
    const aidantsWithOrders = await Promise.all((aidants || []).map(async (aidant) => {
      const { count: currentOrders, error: ordersError } = await supabase
        .from('commandes')
        .select('id', { count: 'exact', head: true })
        .eq('current_aidant_id', aidant.id)
        .in('status', ['en_cours', 'en_attente']);

      if (ordersError) {
        console.error('❌ Erreur comptage commandes:', ordersError);
      }

      const maxOrders = aidant.max_orders || DEFAULT_MAX_ORDERS;

      return {
        ...aidant,
        current_orders: currentOrders || 0,
        max_orders: maxOrders,
        orders_available: Math.max(0, maxOrders - (currentOrders || 0)),
        can_take_order: (currentOrders || 0) < maxOrders,
        is_full: (aidant.current_assignments || 0) >= (aidant.max_assignments || DEFAULT_MAX_ASSIGNMENTS),
        available_slots: Math.max(0, (aidant.max_assignments || DEFAULT_MAX_ASSIGNMENTS) - (aidant.current_assignments || 0)),
      };
    }));

    // Filtrer par disponibilité si demandé
    let result = aidantsWithOrders;
    if (filters.onlyAvailable === true) {
      result = result.filter(a => a.is_available && a.available_slots > 0);
    }

    // Trier
    if (filters.sortBy) {
      const sortField = filters.sortBy;
      const sortOrder = filters.sortOrder || 'desc';
      result = result.sort((a, b) => {
        const aVal = a[sortField] || 0;
        const bVal = b[sortField] || 0;
        return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
      });
    }

    return result;
  } catch (error) {
    console.error('❌ getAidantsByAvailability error:', error);
    throw error;
  }
};

// ============================================================
// VÉRIFIER SI UN AIDANT PEUT PRENDRE UNE COMMANDE
// ============================================================
const canAidantTakeOrder = async (aidantUserId) => {
  try {
    const { data: aidant, error } = await supabase
      .from('aidants')
      .select('id, current_orders, max_orders, available, is_verified, status')
      .eq('user_id', aidantUserId)
      .single();

    if (error || !aidant) {
      return {
        canTake: false,
        reason: 'Aidant non trouvé',
        current: 0,
        max: DEFAULT_MAX_ORDERS,
      };
    }

    if (!aidant.available || !aidant.is_verified || aidant.status !== 'approved') {
      return {
        canTake: false,
        reason: 'Aidant non disponible ou non approuvé',
        current: aidant.current_orders || 0,
        max: aidant.max_orders || DEFAULT_MAX_ORDERS,
      };
    }

    const current = aidant.current_orders || 0;
    const max = aidant.max_orders || DEFAULT_MAX_ORDERS;

    return {
      canTake: current < max,
      reason: current < max ? 'Disponible' : 'Quota atteint',
      current,
      max,
      available: Math.max(0, max - current),
    };
  } catch (error) {
    console.error('❌ canAidantTakeOrder error:', error);
    return {
      canTake: false,
      reason: 'Erreur',
      current: 0,
      max: DEFAULT_MAX_ORDERS,
    };
  }
};

// ============================================================
// RÉCUPÉRER LES AIDANTS PAR SPÉCIALITÉ
// ============================================================
const getAidantsBySpecialty = async (specialty, filters = {}) => {
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
      .eq('status', 'approved')
      .contains('specialties', [specialty]);

    if (filters.available === true) {
      query = query.eq('available', true);
    }

    if (filters.minRating) {
      query = query.gte('rating', filters.minRating);
    }

    const { data: aidants, error } = await query;

    if (error) throw error;

    // Enrichir avec les quotas (Uniquement type 'primary') [30]
    const enriched = await Promise.all((aidants || []).map(async (aidant) => {
      const { count: activeAssignments } = await supabase
        .from('aidant_assignments')
        .select('id', { count: 'exact', head: true })
        .eq('aidant_user_id', aidant.user_id)
        .eq('status', 'active')
        .eq('assignment_type', 'primary'); 

      const maxAssignments = aidant.max_assignments || DEFAULT_MAX_ASSIGNMENTS;

      return {
        ...aidant,
        active_assignments: activeAssignments || 0,
        max_assignments: maxAssignments,
        available_slots: Math.max(0, maxAssignments - (activeAssignments || 0)),
        is_available: aidant.available && (activeAssignments || 0) < maxAssignments,
      };
    }));

    return enriched;
  } catch (error) {
    console.error('❌ getAidantsBySpecialty error:', error);
    throw error;
  }
};

// ============================================================
// RÉCUPÉRER LES AIDANTS PAR ZONE
// ============================================================
const getAidantsByZone = async (zone, filters = {}) => {
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
      .eq('status', 'approved')
      .contains('zones', [zone]);

    if (filters.available === true) {
      query = query.eq('available', true);
    }

    if (filters.minRating) {
      query = query.gte('rating', filters.minRating);
    }

    const { data: aidants, error } = await query;

    if (error) throw error;

    // Enrichir avec les quotas (Uniquement de type 'primary') [30]
    const enriched = await Promise.all((aidants || []).map(async (aidant) => {
      const { count: activeAssignments } = await supabase
        .from('aidant_assignments')
        .select('id', { count: 'exact', head: true })
        .eq('aidant_user_id', aidant.user_id)
        .eq('status', 'active')
        .eq('assignment_type', 'primary');  

      const maxAssignments = aidant.max_assignments || DEFAULT_MAX_ASSIGNMENTS;

      return {
        ...aidant,
        active_assignments: activeAssignments || 0,
        max_assignments: maxAssignments,
        available_slots: Math.max(0, maxAssignments - (activeAssignments || 0)),
        is_available: aidant.available && (activeAssignments || 0) < maxAssignments,
      };
    }));

    return enriched;
  } catch (error) {
    console.error('❌ getAidantsByZone error:', error);
    throw error;
  }
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Fonctions existantes
  getAvailableAidants,
  getAidantById,
  assignAidantToPatient,
  getFamilyAssignments,
  getAidantAssignments,
  revokeAssignment,

  // Nouvelles fonctions
  getAvailableAidantsForFamilyCatalog,
  getAidantsByAvailability,
  canAidantTakeOrder,
  getAidantsBySpecialty,
  getAidantsByZone,
};
