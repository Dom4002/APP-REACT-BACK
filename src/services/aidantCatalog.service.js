// 📁 backend/src/services/aidantCatalog.service.js

const { supabase } = require('./supabase.service');

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

    const aidantsWithStats = await Promise.all((data || []).map(async (aidant) => {
      const { count: activeAssignments, error: countError } = await supabase
        .from('patient_family_links')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', aidant.user_id);

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

      const { data: reviews, error: reviewsError } = await supabase
        .from('aidant_reviews')
        .select('rating')
        .eq('aidant_id', aidant.id);

      const totalReviews = reviews?.length || 0;
      const avgRating = totalReviews > 0
        ? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
        : aidant.rating || 0;

      const maxAssignments = aidant.max_assignments || 4;
      const isAvailable = aidant.available && activeAssignments < maxAssignments;

      return {
        ...aidant,
        active_assignments: activeAssignments || 0,
        max_assignments: maxAssignments,
        avg_rating: Math.round(avgRating * 10) / 10,
        total_reviews: totalReviews,
        is_available: isAvailable,
        availability_status: isAvailable ? 'available' : 
          (activeAssignments >= maxAssignments ? 'full' : 'unavailable'),
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

    const { count: activeAssignments, error: countError } = await supabase
      .from('patient_family_links')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', aidant.user_id);

    if (countError) {
      console.error('❌ Erreur comptage assignations:', countError);
    }

    const { data: patients, error: patientsError } = await supabase
      .from('patient_family_links')
      .select(`
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
          category
        )
      `)
      .eq('family_id', aidant.user_id);

    if (patientsError) {
      console.error('❌ Erreur récupération patients:', patientsError);
    }

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
    };
  } catch (error) {
    console.error('❌ Get aidant by ID error:', error);
    throw error;
  }
};

// ============================================================
// ✅ ASSIGNER UN AIDANT - PERSONNEL OU PATIENT
// ============================================================
const assignAidantToPatient = async (aidantId, familyId, patientId = null, assignmentType = 'permanente') => {
  try {
    // 1. Vérifier que l'aidant existe
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, available, max_assignments, current_assignments')
      .eq('id', aidantId)
      .single();

    if (aidantError || !aidant) {
      throw new Error('Aidant non trouvé');
    }

    // 2. Vérifier que l'aidant n'a pas atteint le max
    const { count: currentCount, error: countError } = await supabase
      .from('patient_family_links')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', aidant.user_id);

    if (countError) throw countError;

    const maxAssignments = aidant.max_assignments || 4;
    if (currentCount >= maxAssignments) {
      throw new Error(`Cet aidant a déjà ${currentCount} assignations (maximum ${maxAssignments})`);
    }

    // 3. Déterminer target_type et target_name
    let targetType = 'personal';
    let targetName = null;
    let assignToId = familyId;
    let patient = null;

    if (patientId) {
      // ✅ Assignation à un patient
      const { data: patientData, error: patientError } = await supabase
        .from('patients')
        .select('id, first_name, last_name')
        .eq('id', patientId)
        .single();

      if (patientError || !patientData) {
        throw new Error('Patient non trouvé');
      }
      patient = patientData;
      targetType = 'patient';
      targetName = `${patient.first_name} ${patient.last_name}`;
      assignToId = patientId;
    } else {
      // ✅ Assignation personnelle (au compte)
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('id', familyId)
        .single();

      if (profileError || !profileData) {
        throw new Error('Compte non trouvé');
      }
      targetName = profileData.full_name;
    }

    // 4. Vérifier que l'assignation n'existe pas déjà
    const queryField = patientId ? 'patient_id' : 'family_id';
    const queryValue = patientId || familyId;

    const { data: existing, error: existingError } = await supabase
      .from('patient_family_links')
      .select('id')
      .eq(queryField, queryValue)
      .eq('family_id', aidant.user_id)
      .maybeSingle();

    if (existing) {
      throw new Error('Déjà assigné');
    }

    // 5. Créer l'assignation
    const { data: link, error: linkError } = await supabase
      .from('patient_family_links')
      .insert({
        patient_id: patientId || null,
        family_id: aidant.user_id,
        target_type: targetType,
        is_primary: true,
        can_manage_visits: true,
        can_manage_orders: true,
        can_receive_notifications: true,
        relationship: assignmentType,
      })
      .select()
      .single();

    if (linkError) {
      console.error('❌ Erreur création patient_family_links:', linkError);
      throw new Error('Erreur lors de l\'assignation');
    }

    // 6. Mettre à jour current_assignments
    const newCount = currentCount + 1;
    await supabase
      .from('aidants')
      .update({
        current_assignments: newCount,
        available: newCount < maxAssignments,
        updated_at: new Date().toISOString(),
      })
      .eq('id', aidantId);

    // 7. Récupérer l'aidant mis à jour
    const { data: updatedAidant, error: updateError } = await supabase
      .from('aidants')
      .select('*')
      .eq('id', aidantId)
      .single();

    if (updateError) {
      console.error('❌ Erreur récupération aidant mis à jour:', updateError);
    }

    // 8. Notifications
    const targetDisplay = targetType === 'patient' ? `le patient ${targetName}` : `${targetName} (personnel)`;

    await supabase.from('notifications').insert({
      user_id: aidant.user_id,
      title: '📋 Nouvelle assignation',
      body: `Vous avez été assigné à ${targetDisplay} (${assignmentType}).`,
      type: 'system',
      data: { 
        patient_id: patientId,
        is_personal: !patientId,
        assignment_type: assignmentType,
        target_type: targetType,
        target_name: targetName,
      },
    });

    await supabase.from('notifications').insert({
      user_id: familyId,
      title: '✅ Aidant assigné avec succès',
      body: `L'aidant a été assigné à ${targetDisplay} (${assignmentType}).`,
      type: 'system',
      data: { 
        aidant_id: aidantId,
        patient_id: patientId,
        is_personal: !patientId,
        assignment_type: assignmentType,
        target_type: targetType,
        target_name: targetName,
      },
    });

    return {
      assignment: link,
      aidant: updatedAidant || aidant,
      is_personal: !patientId,
      target_type: targetType,
      target_name: targetName,
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
    console.error('❌ Get family assignments error:', error);
    throw error;
  }
};

// ============================================================
// RÉCUPÉRER LES ASSIGNATIONS D'UN AIDANT
// ============================================================
const getAidantAssignments = async (aidantUserId) => {
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
    console.error('❌ Get aidant assignments error:', error);
    throw error;
  }
};

// ============================================================
// RÉVOQUER UNE ASSIGNATION
// ============================================================
const revokeAssignment = async (assignmentId, familyId) => {
  try {
    const { data: link, error: linkError } = await supabase
      .from('patient_family_links')
      .select('id, family_id, patient_id, relationship, target_type')
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

    await new Promise(resolve => setTimeout(resolve, 100));

    const { data: updatedAidant, error: updateError } = await supabase
      .from('aidants')
      .select('*')
      .eq('user_id', familyId)
      .single();

    if (updateError) {
      console.error('❌ Erreur récupération aidant mis à jour:', updateError);
    }

    const targetDisplay = link.target_type === 'patient' 
      ? 'patient' 
      : 'personnel';

    await supabase.from('notifications').insert({
      user_id: familyId,
      title: '🔄 Assignation révoquée',
      body: `L'assignation ${targetDisplay} (${link.relationship || 'permanente'}) a été révoquée.`,
      type: 'system',
      data: { assignment_id: assignmentId },
    });

    return updatedAidant || { success: true };
  } catch (error) {
    console.error('❌ Revoke assignment error:', error);
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
