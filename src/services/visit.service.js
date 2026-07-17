// 📁 backend/src/services/visit.service.js
 
const { supabase } = require('./supabase.service');
const { createNotification } = require('./notification.service');
const { getCoordinatesFromAddress } = require('./maps.service'); 
const { 
  getActiveAidantForTarget,
  getAvailableAidantsForFamily,
  getVisitWizardOptions,
} = require('./aidantAssignment.service');
const {
  checkSubscriptionForVisits,
  getVisitPrice,
  decrementVisit,
} = require('./visitPayment.service');

// ============================================================
// CONSTANTES
// ============================================================

const VISIT_STATUS = {
  PLANNED: 'planifiee',
  PENDING: 'en_attente',
  ACCEPTED: 'acceptee',
  IN_PROGRESS: 'en_cours',
  COMPLETED: 'terminee',
  VALIDATED: 'validee',
  CANCELLED: 'annulee',
  REFUSED: 'refusee',
  EXPIRED: 'expire',
  DRAFT: 'brouillon',
  WAITING_AIDANT: 'en_attente_aidant',
  WAITING_PAYMENT: 'attente_paiement',
};

const VISIT_TYPES = {
  PATIENT: 'patient',
  PERSONAL: 'personal',
  PERSONAL_ACCOUNT: 'personal_account',
};

const DRAFT_EXPIRY_HOURS = 24;

// Spécification de la grille de prix ponctuelle unifiée
const VISIT_PONCTUAL_PRICES = {
  '30': 5000,
  '45': 6000,
  '60': 7500,
  '90': 10000,
  '120': 12500,
};

const getPonctualPrice = (durationMinutes = 60) => {
  const price = VISIT_PONCTUAL_PRICES[durationMinutes.toString()];
  if (price) return price;
  return Math.round((durationMinutes / 60) * 7500);
};

// ============================================================
// CRÉATION DE VISITE (SANS AUCUNE ASSIGNATION AUTOMATIQUE)
// ============================================================

const createVisit = async ({
  userId,
  patientId,
  targetType,
  targetName,
  targetUserId,
  scheduledDate,
  scheduledTime,
  durationMinutes = 60,
  notes,
  isUrgent = false,
  isPonctual = false,
  assignmentType = 'ponctuelle',
  aidantId = null,
  wizardChoice = null,
  selectedAidantId = null,
  profile,
  coordinatorId = null,
  address = null,                     
  latitude = null,                    
  longitude = null, 
  metadata = {},  
}) => {
  try {
    // 🔒 SÉCURITÉ : Seuls les admins et coordinateurs peuvent planifier désormais
    const isAdmin = ['admin', 'coordinator'].includes(profile?.role);
    if (!isAdmin) {
      return {
        success: false,
        error: 'Seul le personnel administratif de Santé Plus peut planifier des interventions.',
        code: 'UNAUTHORIZED_ROLE'
      };
    }

    // ✅ AUTO-GÉOCODAGE : Si adresse fournie mais pas de GPS
    if (address && (!latitude || !longitude)) {
      console.log(`🌍 Géocodage auto pour: ${address}`);
      const coords = await getCoordinatesFromAddress(address);
      if (coords) {
        latitude = coords.lat;
        longitude = coords.lng;
        console.log(`✅ Coordonnées trouvées: ${latitude}, ${longitude}`);
      }
    }
   
    const finalTargetType = targetType || (patientId ? VISIT_TYPES.PATIENT : VISIT_TYPES.PERSONAL);
    const finalTargetName = targetName || (patientId ? null : profile?.full_name);
    const finalUserId = targetUserId || userId;

    let status = VISIT_STATUS.PLANNED; 

    // Déterminer l'aidant à assigner
    let finalAidantId = null;
    if (aidantId) {
      finalAidantId = await getAidantIdFromUserIdOrId(aidantId);
    }

    // Créer la visite en base de données
    const visitData = {
      user_id: finalUserId,
      patient_id: patientId || null,
      target_type: finalTargetType,
      target_name: finalTargetName,
      aidant_id: finalAidantId, 
      coordinator_id: coordinatorId || null,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      duration_minutes: durationMinutes || 60,
      status: status,
      address: address || null,
      latitude: latitude || null,
      longitude: longitude || null,
      is_draft: false,                         
      requires_payment: false,                 
      is_ponctual: isPonctual,         
      payment_status: null, 
      payment_amount: null,
      actions: [],
      notes: notes || null,
      is_urgent: isUrgent || false,
      visit_type: 'permanente',
      assignment_type: assignmentType || 'permanente',
      requested_by: userId,
      draft_expires_at: null,
      subscription_id: null,
      is_permanent: true,
      assigned_by_admin: true,
      admin_assigned_at: new Date().toISOString(),
      waiting_for_aidant_since: null,
      metadata: {
        ...metadata,  
        created_by: userId,
        created_at: new Date().toISOString(),
        manual_admin_planning: true,
      },
    };

    const { data: visit, error } = await supabase
      .from('visites')
      .insert(visitData)
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

    if (error) {
      console.error('❌ createVisit error:', error);
      return {
        success: false,
        error: error.message,
        code: 'INSERT_ERROR',
      };
    }

    const targetDisplay = finalTargetName || 'Patient';

    await createNotification({
      userId: finalUserId,
      title: '📅 Nouvelle visite planifiée',
      body: `Une visite pour ${targetDisplay} a été planifiée le ${scheduledDate} à ${scheduledTime} par Santé Plus.`,
      type: 'visite',
      data: { visit_id: visit.id, status: VISIT_STATUS.PLANNED },
    });

    if (finalAidantId && visit.aidant?.user?.id) {
      await createNotification({
        userId: visit.aidant.user.id,
        title: '📅 Nouvelle intervention planifiée',
        body: `Une intervention pour ${targetDisplay} vous a été assignée le ${scheduledDate} à ${scheduledTime}.`,
        type: 'visite',
        data: { visit_id: visit.id },
      });
    }

    return {
      success: true,
      visit,
      requires_payment: false,
      payment_amount: null,
      subscription_used: false,
      waiting_for_aidant: false,
    };
  } catch (error) { 
    console.error('❌ createVisit error:', error);
    return {
      success: false,
      error: error.message,
      code: 'UNKNOWN_ERROR',
    };
  }
};

// ============================================================
// ✅ NOUVEAU : DÉMARRER UNE INTERVENTION À LA VOLÉE (AD-HOC)
// ============================================================

const startAdHocVisit = async ({
  aidantUserId,
  targetType, // 'patient' ou 'personal_account' / 'personal'
  targetId,   // patientId ou profileId
  startLat = null,
  startLng = null,
}) => {
  try {
    // 1. Récupérer le profil de l'aidant
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id')
      .eq('user_id', aidantUserId)
      .single();

    if (aidantError || !aidant) {
      return { success: false, error: 'Profil Aidant non trouvé', code: 'AIDANT_NOT_FOUND' };
    }

    let userId = null;
    let patientId = null;
    let targetName = '';
    let address = '';
    let latitude = startLat;
    let longitude = startLng;

    // 2. Résoudre les liens familiaux et récupérer les coordonnées par défaut si existantes
    if (targetType === 'patient') {
      patientId = targetId;
      const { data: link } = await supabase
        .from('patient_family_links')
        .select('family_id')
        .eq('patient_id', patientId)
        .eq('is_primary', true)
        .maybeSingle();

      userId = link?.family_id || aidantUserId;

      const { data: patient } = await supabase
        .from('patients')
        .select('first_name, last_name, address, latitude, longitude')
        .eq('id', patientId)
        .single();

      if (patient) {
        targetName = `${patient.first_name} ${patient.last_name}`;
        address = patient.address || '';
        latitude = startLat || patient.latitude;
        longitude = startLng || patient.longitude;
      }
    } else {
      userId = targetId;
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, address, last_latitude, last_longitude')
        .eq('id', userId)
        .single();

      if (profile) {
        targetName = profile.full_name || 'Compte personnel';
        address = profile.address || '';
        latitude = startLat || profile.last_latitude;
        longitude = startLng || profile.last_longitude;
      }
    }

    const now = new Date();
    const scheduledDate = now.toISOString().split('T')[0];
    const scheduledTime = now.toTimeString().slice(0, 5);
    const reference = `VIS-ADHOC-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    // 3. Insérer directement la visite avec le statut 'en_cours'
    const visitData = {
      reference,
      user_id: userId,
      patient_id: patientId,
      aidant_id: aidant.id,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      duration_minutes: 60, // Durée indicative par défaut
      status: VISIT_STATUS.IN_PROGRESS,
      start_time: now.toISOString(),
      target_type: targetType === 'patient' ? 'patient' : 'personal',
      target_name: targetName,
      address,
      latitude,
      longitude,
      location_start: startLat && startLng ? { lat: startLat, lng: startLng } : null,
      location_track: startLat && startLng ? [{ lat: startLat, lng: startLng, timestamp: now.toISOString() }] : [],
      metadata: {
        ad_hoc: true,
        started_by_aidant: aidantUserId,
        created_at: now.toISOString(),
        location_start: startLat && startLng ? { lat: startLat, lng: startLng } : null,
      }
    };

    const { data: visit, error: insertError } = await supabase
      .from('visites')
      .insert(visitData)
      .select(`
        *,
        patient:patients(*),
        aidant:aidants!visites_aidant_id_fkey (
          id,
          user_id,
          user:profiles!aidants_user_id_fkey (id, full_name, avatar_url)
        )
      `)
      .single();

    if (insertError) throw insertError;

    // 4. Notifier la famille en direct
    await createNotification({
      userId: userId,
      title: '🔄 Visite commencée en direct',
      body: `Votre intervenant a démarré une visite d'accompagnement pour ${targetName}.`,
      type: 'visite',
      data: { visit_id: visit.id, status: VISIT_STATUS.IN_PROGRESS },
    });

    return { success: true, visit };
  } catch (error) {
    console.error('❌ startAdHocVisit error:', error);
    return { success: false, error: error.message, code: 'UNKNOWN_ERROR' };
  }
};

const assignAidantToVisit = async ({
  visitId,
  aidantUserId,
  assignmentType = 'permanente',
  adminId = null,
  force = false,
}) => {
  try {
    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', visitId)
      .single();

    if (visitError || !visit) {
      return { success: false, error: 'Visite non trouvée', code: 'VISIT_NOT_FOUND' };
    }

    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('*')
      .eq('user_id', aidantUserId)
      .single();

    if (aidantError || !aidant) {
      return { success: false, error: 'Aidant non trouvé', code: 'AIDANT_NOT_FOUND' };
    }

    if (!aidant.is_verified || aidant.status !== 'approved') {
      return { success: false, error: 'Cet aidant n\'est pas approuvé', code: 'AIDANT_NOT_APPROVED' };
    }

    const currentAssignments = aidant.current_assignments || 0;
    const maxAssignments = aidant.max_assignments || 4;

    if (!force && assignmentType === 'permanente' && currentAssignments >= maxAssignments) {
      return {
        success: false,
        error: `Cet aidant est complet (${currentAssignments}/${maxAssignments})`,
        code: 'AIDANT_FULL',
        current: currentAssignments,
        max: maxAssignments,
      };
    }

    const isPermanent = assignmentType === 'permanente';

    const updateData = {
      aidant_id: aidant.id,
      status: VISIT_STATUS.PLANNED,
      assignment_type: assignmentType,
      is_permanent: isPermanent,
      assigned_by_admin: true,
      admin_assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (visit.status === VISIT_STATUS.WAITING_AIDANT) {
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
          user:profiles!aidants_user_id_fkey (id, full_name, email, phone)
        )
      `)
      .single();

    if (updateError) {
      console.error('❌ assignAidantToVisit update error:', updateError);
      return { success: false, error: updateError.message, code: 'UPDATE_ERROR' };
    }

    if (isPermanent) {
      const targetType = visit.patient_id ? VISIT_TYPES.PATIENT : VISIT_TYPES.PERSONAL_ACCOUNT;
      const targetId = visit.patient_id || visit.user_id;

      // Import dynamique d'attribution pour éviter les cycles de dépendance
      const { assignAidantToTarget } = require('./aidantAssignment.service');

      await assignAidantToTarget({
        aidantUserId,
        targetType,
        targetId,
        familyId: visit.user_id,
        assignmentType: 'primary',
        createdBy: adminId,
        reason: `Assigné pour la visite ${visitId}${force ? ' (forcé)' : ''}`,
      });
    }

    const targetDisplay = visit.target_name || visit.patient?.first_name || 'Patient';

    await createNotification({
      userId: aidantUserId,
      title: '📅 Nouvelle visite assignée',
      body: `Vous avez été assigné à la visite de ${targetDisplay} le ${visit.scheduled_date} à ${visit.scheduled_time}`,
      type: 'visite',
      data: { visit_id: visitId, action: 'approve' },
    });

    await createNotification({
      userId: visit.user_id,
      title: '✅ Un aidant a été assigné à votre visite',
      body: `Un aidant a été assigné pour la visite de ${targetDisplay}`,
      type: 'visite',
      data: { visit_id: visitId },
    });

    return {
      success: true,
      visit: updatedVisit,
      assignment_type: assignmentType,
      is_permanent: isPermanent,
      forced: force || false,
    };
  } catch (error) { 
    console.error('❌ assignAidantToVisit error:', error);
    return { success: false, error: error.message, code: 'UNKNOWN_ERROR' };
  }
};

const getPendingAidantVisits = async () => {
  try {
    const { data, error } = await supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*),
        family:profiles!visites_user_id_fkey(id, full_name, email, phone)
      `)
      .eq('status', VISIT_STATUS.WAITING_AIDANT)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('❌ getPendingAidantVisits error:', error);
    return [];
  }
};

const validateVisitWithoutAidant = async ({
  visitId,
  adminId,
  aidantId = null,
  assignmentType = 'permanente',
}) => {
  try {
    const { data: visit, error: visitError } = await supabase.from('visites').select('*').eq('id', visitId).single();
    if (visitError || !visit) return { success: false, error: 'Visite non trouvée', code: 'VISIT_NOT_FOUND' };

    if (visit.status !== VISIT_STATUS.WAITING_AIDANT) {
      return { success: false, error: 'Statut invalide', code: 'INVALID_STATUS' };
    }

    if (aidantId) {
      const result = await assignAidantToVisit({
        visitId,
        aidantUserId: aidantId,
        assignmentType,
        adminId,
        force: true,
      });
      if (!result.success) return result;
      return { success: true, visit: result.visit, assigned: true, assignment_type: assignmentType };
    }

    const { data: updatedVisit, error: updateError } = await supabase
      .from('visites')
      .update({
        status: VISIT_STATUS.PLANNED,
        metadata: {
          ...(visit.metadata || {}),
          validated_without_aidant: true,
          validated_without_aidant_at: new Date().toISOString(),
          validated_by: adminId,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', visitId)
      .select()
      .single();

    if (updateError) return { success: false, error: updateError.message, code: 'UPDATE_ERROR' };

    return { success: true, visit: updatedVisit, assigned: false };
  } catch (error) { 
    console.error('❌ validateVisitWithoutAidant error:', error);
    return { success: false, error: error.message, code: 'UNKNOWN_ERROR' };
  }
};

const notifyAdminsForPendingAidant = async (visitId, { targetName, scheduledDate, scheduledTime }) => {
  try {
    const { data: admins } = await supabase.from('profiles').select('id').in('role', ['admin', 'coordinator']);
    if (!admins) return;

    for (const admin of admins) {
      await createNotification({
        userId: admin.id,
        title: '🚨 Visite planifiée sans aidant disponible !',
        body: `Visite pour ${targetName} le ${scheduledDate} à ${scheduledTime}.`,
        type: 'alert',
        data: {
          visit_id: visitId,
          action: 'assign_aidant',
          urgency: 'high',
          target_name: targetName,
          scheduled_date: scheduledDate,
          scheduled_time: scheduledTime,
        },
      });
    }
  } catch (error) {
    console.error('❌ notifyAdminsForPendingAidant error:', error);
  }
};

const getAidantIdFromUserIdOrId = async (userIdOrId) => {
  const { data: aidantById } = await supabase.from('aidants').select('id').eq('id', userIdOrId).maybeSingle();
  if (aidantById) return aidantById.id;

  const { data: aidantByUser = null } = await supabase.from('aidants').select('id').eq('user_id', userIdOrId).maybeSingle();
  if (aidantByUser) return aidantByUser.id;

  return null;
};

module.exports = {
  VISIT_STATUS,
  VISIT_TYPES,
  DRAFT_EXPIRY_HOURS,
  createVisit,
  startAdHocVisit, // ✅ EXPORT DE LA VISITE À LA VOLÉE
  assignAidantToVisit,
  getPendingAidantVisits,
  validateVisitWithoutAidant,
  notifyAdminsForPendingAidant,
};
