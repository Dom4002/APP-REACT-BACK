// 📁 backend/src/services/visit.service.js

const { supabase } = require('./supabase.service');
const { createNotification } = require('./notification.service');
const { 
  getActiveAidantForTarget,
  getAvailableAidantsForFamily,
  getVisitWizardOptions,
  isAidantFull,
  assignAidantToTarget,
} = require('./aidantAssignment.service');
const {
  checkSubscriptionForVisits,
  getVisitPrice,
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

// ============================================================
// CRÉATION DE VISITE
// ============================================================

/**
 * Crée une visite avec gestion complète (abonnement, wizard, aidant)
 * @param {Object} params
 * @param {string} params.userId - UUID de l'utilisateur
 * @param {string} params.patientId - UUID du patient (optionnel)
 * @param {string} params.targetType - 'patient' | 'personal' | 'personal_account'
 * @param {string} params.targetName - Nom de la cible
 * @param {string} params.targetUserId - UUID de l'utilisateur cible
 * @param {string} params.scheduledDate - Date planifiée
 * @param {string} params.scheduledTime - Heure planifiée
 * @param {number} params.durationMinutes - Durée en minutes
 * @param {string} params.notes - Notes
 * @param {boolean} params.isUrgent - Urgent ou non
 * @param {boolean} params.isPonctual - Mode ponctuel
 * @param {string} params.assignmentType - 'ponctuelle' | 'permanente'
 * @param {string} params.aidantId - ID de l'aidant (optionnel)
 * @param {string} params.wizardChoice - 'ponctuelle' | 'permanente' | 'without_aidant'
 * @param {string} params.selectedAidantId - ID de l'aidant sélectionné
 * @param {Object} params.profile - Profil de l'utilisateur
 * @param {Object} params.coordinatorId - ID du coordinateur (optionnel)
 * @returns {Promise<Object>}
 */
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
}) => {
  try {
    // 1. Déterminer la cible finale
    const finalTargetType = targetType || (patientId ? VISIT_TYPES.PATIENT : VISIT_TYPES.PERSONAL);
    const finalTargetName = targetName || (patientId ? null : profile?.full_name);
    const finalUserId = targetUserId || userId;
    const familyId = finalUserId;

    // 2. Vérifier l'abonnement
    const subscriptionCheck = await checkSubscriptionForVisits(finalUserId);
    
    let status = VISIT_STATUS.PLANNED;
    let requiresPayment = false;
    let paymentAmount = 0;
    let subscriptionId = null;

    if (isPonctual) {
      requiresPayment = true;
      status = VISIT_STATUS.DRAFT;
      paymentAmount = getVisitPrice(durationMinutes);
    } else if (subscriptionCheck.hasActiveSubscription && subscriptionCheck.remainingVisits > 0) {
      status = VISIT_STATUS.PLANNED;
      requiresPayment = false;
      subscriptionId = subscriptionCheck.subscription?.id || null;
    } else if (subscriptionCheck.hasActiveSubscription && subscriptionCheck.remainingVisits === 0) {
      requiresPayment = true;
      status = VISIT_STATUS.DRAFT;
      paymentAmount = getVisitPrice(durationMinutes);
    } else {
      requiresPayment = true;
      status = VISIT_STATUS.DRAFT;
      paymentAmount = getVisitPrice(durationMinutes);
    }

    // 3. Déterminer l'aidant à assigner
    let finalAidantId = aidantId || null;

    if (finalAidantId) {
      const convertedId = await getAidantIdFromUserIdOrId(finalAidantId);
      if (convertedId) finalAidantId = convertedId;
    }

    if (!finalAidantId && status !== VISIT_STATUS.DRAFT) {
      const targetTypeForAidant = patientId ? VISIT_TYPES.PATIENT : VISIT_TYPES.PERSONAL_ACCOUNT;
      const targetIdForAidant = patientId || finalUserId;

      let foundId = await getActiveAidantForTarget(targetTypeForAidant, targetIdForAidant, familyId);

      if (foundId) {
        const convertedId = await getAidantIdFromUserIdOrId(foundId);
        if (convertedId) finalAidantId = convertedId;
      } else if (selectedAidantId && wizardChoice) {
        // Wizard: utilisateur a choisi un aidant
        const convertedId = await getAidantIdFromUserIdOrId(selectedAidantId);
        if (convertedId) {
          if (wizardChoice === 'permanente') {
            // Vérifier le quota
            const { data: aidant } = await supabase
              .from('aidants')
              .select('current_assignments, max_assignments')
              .eq('user_id', selectedAidantId)
              .single();

            if (aidant && aidant.current_assignments >= aidant.max_assignments) {
              return {
                success: false,
                error: `Cet aidant est complet (${aidant.current_assignments}/${aidant.max_assignments})`,
                code: 'AIDANT_FULL',
              };
            }
            finalAidantId = convertedId;
          } else if (wizardChoice === 'ponctuelle') {
            finalAidantId = convertedId;
          }
        }
      } else if (!finalAidantId && profile?.role === 'family') {
        // Famille sans aidant assigné → Vérifier si des aidants sont disponibles
        const wizardOptions = await getVisitWizardOptions(
          targetTypeForAidant,
          targetIdForAidant,
          familyId
        );

        if (wizardOptions.allFull) {
          // Tous les aidants sont full → Planifier sans aidant
          if (wizardChoice === 'without_aidant') {
            status = VISIT_STATUS.WAITING_AIDANT;
            finalAidantId = null;
          } else {
            return {
              success: false,
              error: 'Tous les aidants sont complets (4/4). Utilisez "Planifier sans aidant" ou contactez l\'administration.',
              code: 'ALL_AIDANTS_FULL',
              wizard: wizardOptions,
            };
          }
        } else if (wizardOptions.hasAvailableAidants) {
          // Des aidants sont disponibles → Retourner les options
          if (!selectedAidantId || !wizardChoice) {
            return {
              success: false,
              error: 'Veuillez sélectionner un aidant et un type d\'assignation',
              code: 'WIZARD_REQUIRED',
              wizard: wizardOptions,
            };
          }
        }
      }
    }

    // 4. Créer la visite
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
      actions: [],
      notes: notes || null,
      is_urgent: isUrgent || false,
      visit_type: patientId ? VISIT_TYPES.PATIENT : VISIT_TYPES.PERSONAL,
      assignment_type: assignmentType || 'ponctuelle',
      requested_by: userId,
      draft_expires_at: requiresPayment ? new Date(Date.now() + DRAFT_EXPIRY_HOURS * 60 * 60 * 1000).toISOString() : null,
      subscription_id: subscriptionId,
      is_permanent: wizardChoice === 'permanente',
      assigned_by_admin: ['admin', 'coordinator'].includes(profile?.role),
      admin_assigned_at: ['admin', 'coordinator'].includes(profile?.role) ? new Date().toISOString() : null,
      waiting_for_aidant_since: status === VISIT_STATUS.WAITING_AIDANT ? new Date().toISOString() : null,
      metadata: {
        created_by: userId,
        created_at: new Date().toISOString(),
        is_ponctual: isPonctual || requiresPayment,
        requires_payment: requiresPayment,
        is_draft: requiresPayment,
        payment_amount: requiresPayment ? paymentAmount : null,
        target_user_id: finalUserId,
        auto_assigned_aidant: !!finalAidantId && !aidantId && !selectedAidantId,
        subscription_used: subscriptionId ? true : false,
        ponctual_mode: requiresPayment ? true : false,
        wizard_choice: wizardChoice || null,
        waiting_for_aidant: status === VISIT_STATUS.WAITING_AIDANT,
        selected_aidant: selectedAidantId || null,
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

    // 5. Notifications
    const targetDisplay = finalTargetName || 'Patient';

    if (requiresPayment) {
      await createNotification({
        userId: finalUserId,
        title: '💳 Paiement requis pour planifier la visite',
        body: `Un paiement de ${paymentAmount} FCFA est requis pour planifier la visite de ${targetDisplay}.`,
        type: 'visite',
        data: {
          visit_id: visit.id,
          status: VISIT_STATUS.DRAFT,
          action: 'pay',
          amount: paymentAmount,
        },
      });
    } else if (status === VISIT_STATUS.WAITING_AIDANT) {
      // Notification aux admins
      await notifyAdminsForPendingAidant(visit.id, {
        targetName: targetDisplay,
        scheduledDate,
        scheduledTime,
      });

      await createNotification({
        userId: finalUserId,
        title: '⏳ Visite en attente d\'aidant',
        body: `Votre visite pour ${targetDisplay} est en attente d'assignation. L'administration a été notifiée.`,
        type: 'visite',
        data: {
          visit_id: visit.id,
          status: VISIT_STATUS.WAITING_AIDANT,
        },
      });
    } else if (finalAidantId) {
      await createNotification({
        userId: finalAidantId,
        title: '📅 Nouvelle visite à valider',
        body: `Visite pour ${targetDisplay} le ${scheduledDate} à ${scheduledTime}`,
        type: 'visite',
        data: { visit_id: visit.id, action: 'approve' },
      });

      await createNotification({
        userId: finalUserId,
        title: '📅 Nouvelle visite planifiée',
        body: `Une visite pour ${targetDisplay} a été planifiée le ${scheduledDate} à ${scheduledTime}.`,
        type: 'visite',
        data: { visit_id: visit.id, status: VISIT_STATUS.PLANNED },
      });
    }

    return {
      success: true,
      visit,
      requires_payment: requiresPayment,
      payment_amount: requiresPayment ? paymentAmount : null,
      subscription_used: !!subscriptionId,
      waiting_for_aidant: status === VISIT_STATUS.WAITING_AIDANT,
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
// ASSIGNATION D'AIDANT À UNE VISITE
// ============================================================

/**
 * Assigne un aidant à une visite existante
 * @param {string} visitId - UUID de la visite
 * @param {string} aidantUserId - UUID de l'aidant (user_id)
 * @param {string} assignmentType - 'permanente' | 'ponctuelle'
 * @param {string} adminId - UUID de l'admin qui assigne
 * @param {boolean} force - Ignorer le quota
 * @returns {Promise<Object>}
 */
const assignAidantToVisit = async ({
  visitId,
  aidantUserId,
  assignmentType = 'permanente',
  adminId = null,
  force = false,
}) => {
  try {
    // 1. Récupérer la visite
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

    // 2. Vérifier que l'aidant existe
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

    // 3. Vérifier le quota (sauf si force)
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

    // 4. Mettre à jour la visite
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
      console.error('❌ assignAidantToVisit update error:', updateError);
      return {
        success: false,
        error: updateError.message,
        code: 'UPDATE_ERROR',
      };
    }

    // 5. Si permanent, créer l'assignation
    if (isPermanent) {
      const targetType = visit.patient_id ? VISIT_TYPES.PATIENT : VISIT_TYPES.PERSONAL_ACCOUNT;
      const targetId = visit.patient_id || visit.user_id;

      const assignmentResult = await assignAidantToTarget({
        aidantUserId: aidantUserId,
        targetType: targetType,
        targetId: targetId,
        familyId: visit.user_id,
        assignmentType: 'primary',
        createdBy: adminId,
        reason: `Assigné pour la visite ${visitId}${force ? ' (forcé)' : ''}`,
      });

      if (!assignmentResult.success) {
        console.warn('⚠️ Échec création assignation permanente:', assignmentResult.error);
      }
    }

    // 6. Notifications
    const targetDisplay = visit.target_name || visit.patient?.first_name || 'Patient';

    await createNotification({
      userId: aidantUserId,
      title: '📅 Nouvelle visite assignée',
      body: `Vous avez été assigné à la visite de ${targetDisplay} le ${visit.scheduled_date} à ${visit.scheduled_time}`,
      type: 'visite',
      data: {
        visit_id: visitId,
        assignment_type: assignmentType,
        is_permanent: isPermanent,
        forced: force || false,
        action: 'approve',
      },
    });

    await createNotification({
      userId: visit.user_id,
      title: '✅ Un aidant a été assigné à votre visite',
      body: `${aidant.user?.full_name || 'Un aidant'} a été assigné pour la visite de ${targetDisplay}`,
      type: 'visite',
      data: {
        visit_id: visitId,
        assignment_type: assignmentType,
        is_permanent: isPermanent,
      },
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
    return {
      success: false,
      error: error.message,
      code: 'UNKNOWN_ERROR',
    };
  }
};

// ============================================================
// VISITES EN ATTENTE D'AIDANT
// ============================================================

/**
 * Récupère toutes les visites en attente d'aidant
 * @returns {Promise<Array>}
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
      .eq('status', VISIT_STATUS.WAITING_AIDANT)
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

// ============================================================
// VALIDATION DE VISITE SANS AIDANT
// ============================================================

/**
 * Valide une visite créée sans aidant (en attente)
 * @param {string} visitId - UUID de la visite
 * @param {string} adminId - UUID de l'admin qui valide
 * @param {string} aidantId - UUID de l'aidant assigné
 * @param {string} assignmentType - 'permanente' | 'ponctuelle'
 * @returns {Promise<Object>}
 */
const validateVisitWithoutAidant = async ({
  visitId,
  adminId,
  aidantId = null,
  assignmentType = 'permanente',
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

    if (visit.status !== VISIT_STATUS.WAITING_AIDANT) {
      return {
        success: false,
        error: `La visite n'est pas en attente d'aidant. Statut: ${visit.status}`,
        code: 'INVALID_STATUS',
      };
    }

    // Si un aidant est fourni, l'assigner
    if (aidantId) {
      const result = await assignAidantToVisit({
        visitId,
        aidantUserId: aidantId,
        assignmentType,
        adminId,
        force: true,
      });

      if (!result.success) {
        return result;
      }

      return {
        success: true,
        visit: result.visit,
        assigned: true,
        assignment_type: assignmentType,
      };
    }

    // Sinon, marquer comme planifiée sans aidant (en attente)
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

    if (updateError) {
      return {
        success: false,
        error: updateError.message,
        code: 'UPDATE_ERROR',
      };
    }

    return {
      success: true,
      visit: updatedVisit,
      assigned: false,
    };
  } catch (error) {
    console.error('❌ validateVisitWithoutAidant error:', error);
    return {
      success: false,
      error: error.message,
      code: 'UNKNOWN_ERROR',
    };
  }
};

// ============================================================
// NOTIFICATIONS
// ============================================================

/**
 * Notifie les admins d'une visite en attente d'aidant
 */
const notifyAdminsForPendingAidant = async (visitId, { targetName, scheduledDate, scheduledTime }) => {
  try {
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (!admins || admins.length === 0) return;

    for (const admin of admins) {
      await createNotification({
        userId: admin.id,
        title: '🚨 Visite planifiée sans aidant disponible !',
        body: `Visite pour ${targetName} le ${scheduledDate} à ${scheduledTime}. Tous les aidants sont complets (4/4).`,
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

// ============================================================
// FONCTIONS UTILITAIRES
// ============================================================

/**
 * Convertit un user_id en aidant_id
 */
const getAidantIdFromUserIdOrId = async (userIdOrId) => {
  const { data: aidantById, error: errorById } = await supabase
    .from('aidants')
    .select('id')
    .eq('id', userIdOrId)
    .maybeSingle();

  if (!errorById && aidantById) return aidantById.id;

  const { data: aidantByUser, error: errorByUser } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userIdOrId)
    .maybeSingle();

  if (!errorByUser && aidantByUser) return aidantByUser.id;

  return null;
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Constantes
  VISIT_STATUS,
  VISIT_TYPES,
  DRAFT_EXPIRY_HOURS,

  // Création
  createVisit,

  // Assignation
  assignAidantToVisit,

  // Gestion des visites sans aidant
  getPendingAidantVisits,
  validateVisitWithoutAidant,

  // Notifications
  notifyAdminsForPendingAidant,

  // Utilitaires
  getAidantIdFromUserIdOrId,
};
