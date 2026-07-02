// 📁 backend/src/services/aidantCatalog.service.js

const { supabase } = require('./supabase.service');

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

    const aidantsWithStats = await Promise.all((data || []).map(async (aidant) => {
      // ✅ Compter les assignations actives
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

    // ✅ Compter les assignations actives
    const { count: activeAssignments, error: countError } = await supabase
      .from('patient_family_links')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', aidant.user_id);

    if (countError) {
      console.error('❌ Erreur comptage assignations:', countError);
    }

    // ✅ Récupérer les patients assignés
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
    // ✅ 1. Vérifier que l'aidant existe
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, available, max_assignments, current_assignments')
      .eq('id', aidantId)
      .single();

    if (aidantError || !aidant) {
      throw new Error('Aidant non trouvé');
    }

    // ✅ 2. Vérifier que l'aidant n'a pas atteint le max
    const { count: currentCount, error: countError } = await supabase
      .from('patient_family_links')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', aidant.user_id);

    if (countError) {
      console.error('❌ Erreur comptage current_assignments:', countError);
    }

    const currentAssignments = currentCount || 0;
    const maxAssignments = aidant.max_assignments || 4;

    if (currentAssignments >= maxAssignments) {
      throw new Error(`Cet aidant a déjà ${currentAssignments} assignations (maximum ${maxAssignments})`);
    }

    // ✅ 3. Déterminer target_type et target_name
    let targetType = 'personal';
    let targetName = null;
    let isPersonal = true;
    let patient = null;

    // ✅ Si patientId est fourni → assignation à un patient
    if (patientId) {
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
      isPersonal = false;
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
      targetType = 'personal';
      isPersonal = true;
    }

    // ✅ 4. Vérifier que l'assignation n'existe pas déjà
    let query = supabase
      .from('patient_family_links')
      .select('id')
      .eq('family_id', aidant.user_id);

    if (patientId) {
      query = query.eq('patient_id', patientId);
    } else {
      query = query.is('patient_id', null);
    }

    const { data: existing, error: existingError } = await query.maybeSingle();

    if (existingError) {
      console.error('❌ Erreur vérification assignation existante:', existingError);
    }

    if (existing) {
      throw new Error('Cet aidant est déjà assigné à ce destinataire');
    }

    // ✅ 5. Créer l'assignation
    const insertData = {
      family_id: aidant.user_id,
      is_primary: true,
      relationship: assignmentType,
      can_manage_visits: true,
      can_manage_orders: true,
      can_receive_notifications: true,
      target_type: targetType,
    };

    // ✅ patient_id est ajouté UNIQUEMENT si fourni
    if (patientId) {
      insertData.patient_id = patientId;
    }

    const { data: link, error: linkError } = await supabase
      .from('patient_family_links')
      .insert(insertData)
      .select()
      .single();

    if (linkError) {
      console.error('❌ Erreur création patient_family_links:', linkError);
      throw new Error(`Erreur lors de l'assignation: ${linkError.message}`);
    }

    // ✅ 6. Mettre à jour current_assignments de l'aidant
    const newCount = currentAssignments + 1;
    await supabase
      .from('aidants')
      .update({
        current_assignments: newCount,
        available: newCount < maxAssignments,
        updated_at: new Date().toISOString(),
      })
      .eq('id', aidantId);

    // ✅ 7. Récupérer l'aidant mis à jour
    const { data: updatedAidant, error: updateError } = await supabase
      .from('aidants')
      .select('*')
      .eq('id', aidantId)
      .single();

    if (updateError) {
      console.error('❌ Erreur récupération aidant mis à jour:', updateError);
    }

    // ✅ 8. Notifications
    const targetDisplay = isPersonal 
      ? `${targetName} (compte personnel)` 
      : `le patient ${targetName}`;

    // Notification à l'aidant
    await supabase.from('notifications').insert({
      user_id: aidant.user_id,
      title: '📋 Nouvelle assignation',
      body: `Vous avez été assigné à ${targetDisplay} (${assignmentType}).`,
      type: 'system',
      data: { 
        patient_id: patientId || null,
        is_personal: isPersonal,
        assignment_type: assignmentType,
        target_type: targetType,
        target_name: targetName,
      },
    });

    // Notification à la famille
    await supabase.from('notifications').insert({
      user_id: familyId,
      title: isPersonal ? '✅ Aidant assigné à votre compte personnel' : '✅ Aidant assigné au patient',
      body: isPersonal
        ? `Un aidant a été assigné à votre compte personnel (${assignmentType}).`
        : `L'aidant a été assigné à ${targetName} (${assignmentType}).`,
      type: 'system',
      data: { 
        aidant_id: aidantId,
        patient_id: patientId || null,
        is_personal: isPersonal,
        assignment_type: assignmentType,
        target_type: targetType,
        target_name: targetName,
      },
    });

    // ✅ 9. Mettre à jour le cache de l'aidant
    profileCache.delete(aidant.user_id);

    return {
      assignment: link,
      aidant: updatedAidant || aidant,
      is_personal: isPersonal,
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
// RÉVOQUER UNE ASSIGNATION - AVEC NOTIFICATIONS COMPLÈTES
// ============================================================
const revokeAssignment = async (assignmentId, familyId) => {
  try {
    // ✅ 1. Récupérer l'assignation avec toutes les relations
    const { data: link, error: linkError } = await supabase
      .from('patient_family_links')
      .select(`
        id, 
        family_id, 
        patient_id, 
        relationship, 
        target_type,
        created_at,
        family:profiles!family_id(
          id,
          full_name,
          email,
          role
        )
      `)
      .eq('id', assignmentId)
      .eq('family_id', familyId)
      .single();

    if (linkError || !link) {
      throw new Error('Assignation non trouvée ou non autorisée');
    }

    // ✅ 2. Récupérer l'aidant
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select(`
        id,
        user_id,
        specialties,
        available,
        rating,
        user:profiles!user_id(
          id,
          full_name,
          email,
          phone,
          avatar_url,
          role
        )
      `)
      .eq('user_id', link.family_id)
      .single();

    if (aidantError) {
      console.error('❌ Erreur récupération aidant:', aidantError);
    }

    // ✅ 3. Récupérer le patient si existant
    let patient = null;
    let isPersonal = false;
    let targetDisplay = 'compte personnel';
    let targetType = link.target_type || 'personal';

    if (link.patient_id) {
      const { data: patientData, error: patientError } = await supabase
        .from('patients')
        .select('id, first_name, last_name, address, category')
        .eq('id', link.patient_id)
        .single();

      if (!patientError && patientData) {
        patient = patientData;
        targetDisplay = `${patient.first_name} ${patient.last_name}`;
        targetType = 'patient';
      }
    } else {
      // ✅ C'est un compte personnel
      isPersonal = true;
      // ✅ Récupérer les infos du compte personnel
      const { data: personalAccount, error: personalError } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .eq('id', link.family_id)
        .single();

      if (!personalError && personalAccount) {
        targetDisplay = `${personalAccount.full_name} (compte personnel)`;
        targetType = 'personal';
      }
    }

    // ✅ 4. Récupérer le propriétaire du compte (la famille)
    const { data: accountOwner, error: ownerError } = await supabase
      .from('profiles')
      .select('id, full_name, email, role')
      .eq('id', familyId)
      .single();

    if (ownerError) {
      console.error('❌ Erreur récupération propriétaire:', ownerError);
    }

    // ✅ 5. Supprimer l'assignation
    const { error: deleteError } = await supabase
      .from('patient_family_links')
      .delete()
      .eq('id', assignmentId);

    if (deleteError) {
      throw new Error('Erreur lors de la révocation');
    }

    // ✅ 6. Mettre à jour current_assignments de l'aidant
    const { data: updatedAidant, error: updateError } = await supabase
      .from('aidants')
      .select('*')
      .eq('user_id', link.family_id)
      .single();

    if (updateError) {
      console.error('❌ Erreur récupération aidant mis à jour:', updateError);
    }

    // ✅ 7. Déterminer les cibles pour les notifications
    const aidantName = aidant?.user?.full_name || 'un aidant';
    const ownerName = accountOwner?.full_name || 'un utilisateur';
    const assignmentType = link.relationship || 'permanente';
    const now = new Date().toISOString();

    // ✅ 8. Récupérer les membres de la famille du patient (si patient)
    let familyMembers = [];
    if (link.patient_id) {
      const { data: familyLinks, error: familyError } = await supabase
        .from('patient_family_links')
        .select('family_id, profiles!inner(full_name, email, role)')
        .eq('patient_id', link.patient_id)
        .neq('family_id', link.family_id);

      if (!familyError && familyLinks) {
        familyMembers = familyLinks.map(f => ({
          id: f.family_id,
          name: f.profiles?.full_name || 'Membre de la famille',
          email: f.profiles?.email,
          role: f.profiles?.role || 'family',
        }));
      }
    }

    // ✅ 9. ENVOI DES NOTIFICATIONS

    // ✅ 9a. Notification à l'AIDANT
    if (aidant?.user_id) {
      await supabase.from('notifications').insert({
        user_id: aidant.user_id,
        title: '🔄 Assignation révoquée',
        body: isPersonal
          ? `Votre assignation au compte personnel de ${targetDisplay.replace(' (compte personnel)', '')} (${assignmentType}) a été révoquée.`
          : `Votre assignation pour "${targetDisplay}" (${assignmentType}) a été révoquée.`,
        type: 'system',
        data: { 
          assignment_id: assignmentId,
          target_type: targetType,
          target_name: targetDisplay,
          is_personal: isPersonal,
          assignment_type: assignmentType,
          revoked_by: familyId,
          revoked_by_name: ownerName,
          revoked_at: now,
          action: 'assignment_revoked',
        },
      });
    }

    // ✅ 9b. Notification au PROPRIÉTAIRE DU COMPTE (la famille qui a révoqué)
    await supabase.from('notifications').insert({
      user_id: familyId,
      title: isPersonal ? '🔄 Aidant retiré de votre compte personnel' : '🔄 Assignation révoquée',
      body: isPersonal
        ? `L'aidant ${aidantName} n'est plus assigné à votre compte personnel (${assignmentType}).`
        : `L'aidant ${aidantName} n'est plus assigné à "${targetDisplay}" (${assignmentType}).`,
      type: 'system',
      data: { 
        assignment_id: assignmentId,
        aidant_id: aidant?.id || null,
        aidant_name: aidantName,
        target_type: targetType,
        target_name: targetDisplay,
        is_personal: isPersonal,
        assignment_type: assignmentType,
        revoked_at: now,
        action: 'assignment_revoked',
      },
    });

    // ✅ 9c. Notification aux MEMBRES DE LA FAMILLE (si patient)
    if (familyMembers.length > 0) {
      const notifications = familyMembers.map(member => ({
        user_id: member.id,
        title: '🔄 Changement d\'assignation',
        body: `L'aidant ${aidantName} n'est plus assigné à "${targetDisplay}" (${assignmentType}).`,
        type: 'system',
        data: { 
          assignment_id: assignmentId,
          patient_id: link.patient_id,
          aidant_id: aidant?.id || null,
          aidant_name: aidantName,
          target_name: targetDisplay,
          assignment_type: assignmentType,
          revoked_by: familyId,
          revoked_by_name: ownerName,
          revoked_at: now,
          action: 'assignment_revoked',
        },
      }));

      await supabase.from('notifications').insert(notifications);
    }

    // ✅ 9d. Notification aux ADMINISTRATEURS (pour suivi)
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (admins && admins.length > 0) {
      const adminNotifications = admins.map(admin => ({
        user_id: admin.id,
        title: isPersonal ? '🔄 Aidant retiré d\'un compte personnel' : '🔄 Assignation révoquée',
        body: isPersonal
          ? `${aidantName} a été retiré du compte personnel de ${targetDisplay.replace(' (compte personnel)', '')} par ${ownerName}. (${assignmentType})`
          : `${aidantName} a été retiré de "${targetDisplay}" par ${ownerName}. (${assignmentType})`,
        type: 'alert',
        data: { 
          assignment_id: assignmentId,
          aidant_id: aidant?.id || null,
          aidant_name: aidantName,
          patient_id: link.patient_id || null,
          target_name: targetDisplay,
          is_personal: isPersonal,
          family_id: familyId,
          family_name: ownerName,
          assignment_type: assignmentType,
          revoked_at: now,
          action: 'assignment_revoked_admin',
        },
      }));

      await supabase.from('notifications').insert(adminNotifications);
    }

    // ✅ 10. Mettre à jour le cache
    profileCache.delete(link.family_id);
    if (link.patient_id) {
      profileCache.delete(`patient_${link.patient_id}`);
    }

    console.log(`✅ Assignation ${assignmentId} révoquée - Notifications envoyées (${isPersonal ? 'personnel' : 'patient'})`);

    return { 
      success: true, 
      assignment: { 
        id: assignmentId, 
        target: targetDisplay, 
        aidant: aidantName,
        is_personal: isPersonal,
        revoked_at: now,
      },
      aidant: updatedAidant || null,
    };

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
