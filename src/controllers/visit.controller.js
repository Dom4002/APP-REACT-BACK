// 📁 backend/src/controllers/visit.controller.js
 
const { supabase } = require('../services/supabase.service');
const { 
  createVisit,
  startAdHocVisit, // ✅ Récupération du service d'ad-hoc
  assignAidantToVisit,
  getPendingAidantVisits,
  validateVisitWithoutAidant,
} = require('../services/visit.service');
const { 
  getVisitWizardOptions,
  checkAidantForVisit,
} = require('../services/visitPayment.service');
const { createNotification } = require('../services/notification.service');
const { asyncWrapper } = require('../utils/errorHandler');

// ============================================================
// CRÉER UNE VISITE (ADMINISTRATION)
// ============================================================
const createVisitController = asyncWrapper(async (req, res) => {
  try {
    const { user, profile } = req;
    const {
      patient_id,
      target_user_id,
      target_type,
      target_name,
      scheduled_date,
      scheduled_time,
      duration_minutes,
      notes,
      is_urgent,
      is_ponctual = false,
      assignment_type = 'ponctuelle',
      aidant_id = null,
    } = req.body;

    const canCreate = ['admin', 'coordinator'].includes(profile.role);
    if (!canCreate) {
      return res.status(403).json({
        success: false,
        error: 'La planification des visites est réservée à l’administration Santé Plus.',
      });
    }

    let finalPatientId = patient_id || null;
    let finalTargetType = target_type || (patient_id ? 'patient' : 'personal');
    let finalTargetName = target_name || null;
    let finalUserId = target_user_id || user.id;

    if (patient_id) {
      const { data: patient, error: patientError } = await supabase
        .from('patients')
        .select('id, first_name, last_name, category, created_by')
        .eq('id', patient_id)
        .single();

      if (patientError || !patient) {
        return res.status(404).json({ error: 'Patient non trouvé' });
      }
      finalPatientId = patient_id;
      finalTargetType = 'patient';
      finalTargetName = `${patient.first_name} ${patient.last_name}`;
    } else {
      const targetUid = target_user_id || user.id;
      const { data: account, error: accountError } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('id', targetUid)
        .single();

      if (accountError || !account) {
        return res.status(404).json({ error: 'Compte non trouvé' });
      }
      finalPatientId = null;
      finalTargetType = 'personal';
      finalTargetName = account.full_name || 'Personnel';
      finalUserId = targetUid;
    }

    const result = await createVisit({
      userId: user.id,
      patientId: finalPatientId,
      targetType: finalTargetType,
      targetName: finalTargetName,
      targetUserId: finalUserId,
      scheduledDate: scheduled_date,
      scheduledTime: scheduled_time,
      durationMinutes: duration_minutes || 60,
      notes: notes || null,
      isUrgent: is_urgent || false,
      isPonctual: is_ponctual || false,
      assignmentType: assignment_type || 'ponctuelle',
      aidantId: aidant_id || null,
      profile: profile,
      coordinatorId: user.id,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

    res.status(201).json({
      success: true,
      visit: result.visit,
      message: 'Visite planifiée avec succès',
    });
  } catch (error) {
    console.error('❌ createVisitController error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la création de la visite',
    });
  }
});

// ============================================================
// RÉCUPÉRER LES OPTIONS DU WIZARD
// ============================================================
const getWizardOptions = asyncWrapper(async (req, res) => {
  try {
    const { targetType, targetId, familyId } = req.query;
    const userId = req.user.id;
    const userRole = req.profile?.role;

    if (!targetType || !targetId) {
      return res.status(400).json({
        success: false,
        error: 'targetType et targetId sont requis',
      });
    }

    const isAdmin = ['admin', 'coordinator'].includes(userRole);
    const isFamily = userRole === 'family';

    if (!isAdmin && !isFamily) {
      return res.status(403).json({
        success: false,
        error: 'Non autorisé',
      });
    }

    if (isFamily) {
      if (targetType === 'patient') {
        const { data: link } = await supabase
          .from('patient_family_links')
          .select('id')
          .eq('family_id', userId)
          .eq('patient_id', targetId)
          .maybeSingle();

        if (!link) {
          return res.status(403).json({
            success: false,
            error: 'Ce patient ne vous appartient pas',
          });
        }
      } else if (targetType === 'personal_account' || targetType === 'personal') {
        if (targetId !== userId) {
          return res.status(403).json({
            success: false,
            error: 'Ce compte ne vous appartient pas',
          });
        }
      }
    }

    const familyIdParam = isFamily ? userId : (familyId || null);
    const options = await getVisitWizardOptions(targetType, targetId, familyIdParam, userRole);

    res.json({
      success: true,
      data: options,
    });
  } catch (error) {
    console.error('❌ getWizardOptions error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ADMIN : ASSIGNER UN AIDANT À UNE VISITE
// ============================================================
const adminAssignAidant = asyncWrapper(async (req, res) => {
  try {
    const { visitId, aidantId, assignmentType = 'permanente', reason = null, force = false } = req.body;

    if (!visitId || !aidantId) {
      return res.status(400).json({
        success: false,
        error: 'visitId et aidantId sont requis',
      });
    }

    const result = await assignAidantToVisit({
      visitId,
      aidantUserId: aidantId,
      assignmentType,
      adminId: req.user.id,
      reason: reason || `Assigné par admin ${req.user.id}`,
      force,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
        current: result.current,
        max: result.max,
      });
    }

    const { data: visit, error } = await supabase
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
      .eq('id', visitId)
      .single();

    if (error) {
      console.error('❌ Erreur récupération visite:', error);
    }

    res.json({
      success: true,
      message: result.message || 'Aidant assigné avec succès',
      visit: visit || result.visit,
      assignment_type: result.assignment_type,
      is_permanent: result.is_permanent,
      forced: result.forced || false,
    });
  } catch (error) {
    console.error('❌ adminAssignAidant error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de l\'assignation',
    });
  }
});

// ============================================================
// RÉCUPÉRER LES VISITES EN ATTENTE D'AIDANT (ADMIN)
// ============================================================
const getPendingAidantVisitsController = asyncWrapper(async (req, res) => {
  try {
    const visits = await getPendingAidantVisits();

    const visitsWithRelations = await Promise.all(visits.map(async (visit) => {
      let patient = null;
      if (visit.patient_id) {
        const { data } = await supabase
          .from('patients')
          .select('*')
          .eq('id', visit.patient_id)
          .single();
        patient = data;
      }

      let family = null;
      if (visit.user_id) {
        const { data } = await supabase
          .from('profiles')
          .select('id, full_name, email, phone')
          .eq('id', visit.user_id)
          .single();
        family = data;
      }

      return {
        ...visit,
        patient,
        family,
      };
    }));

    res.json({
      success: true,
      data: visitsWithRelations,
      count: visitsWithRelations.length,
    });
  } catch (error) {
    console.error('❌ getPendingAidantVisitsController error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des visites',
    });
  }
});

// ============================================================
// RÉCUPÉRER LES AIDANTS DISPONIBLES POUR UNE FAMILLE (LECTURE SEULE)
// ============================================================
const getAvailableAidants = asyncWrapper(async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetType, targetId, zone, specialty, minRating } = req.query;

    if (req.profile?.role !== 'family') {
      return res.status(403).json({
        success: false,
        error: 'Accès réservé aux familles',
      });
    }

    if (targetType === 'patient' && targetId) {
      const { data: link } = await supabase
        .from('patient_family_links')
        .select('id')
        .eq('family_id', userId)
        .eq('patient_id', targetId)
        .maybeSingle();

      if (!link) {
        return res.status(403).json({
          success: false,
          error: 'Ce patient ne vous appartient pas',
        });
      }
    }

    const { getAvailableAidantsForFamilyCatalog } = require('../services/aidantCatalog.service');
    
    const aidants = await getAvailableAidantsForFamilyCatalog(userId, {
      zone,
      specialty,
      minRating: minRating ? parseFloat(minRating) : undefined,
    });

    res.json({
      success: true,
      data: aidants,
      count: aidants.length,
    });
  } catch (error) {
    console.error('❌ getAvailableAidants error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération des aidants',
    });
  }
});

// ============================================================
// VALIDER UNE VISITE EN ATTENTE D'AIDANT
// ============================================================
const validatePendingAidantVisit = asyncWrapper(async (req, res) => {
  try {
    const { id } = req.params;
    const { aidantId, assignmentType = 'permanente' } = req.body;

    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', id)
      .single();

    if (visitError || !visit) {
      return res.status(404).json({
        success: false,
        error: 'Visite non trouvée',
      });
    }

    if (visit.status !== 'en_attente_aidant') {
      return res.status(400).json({
        success: false,
        error: `La visite n'est pas en attente d'aidant. Statut: ${visit.status}`,
      });
    }

    const result = await validateVisitWithoutAidant({
      visitId: id,
      adminId: req.user.id,
      aidantId: aidantId || null,
      assignmentType,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

    res.json({
      success: true,
      message: result.assigned 
        ? 'Aidant assigné avec succès'
        : 'Visite validée sans aidant',
      visit: result.visit,
      assigned: result.assigned,
    });
  } catch (error) {
    console.error('❌ validatePendingAidantVisit error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la validation',
    });
  }
});

// ============================================================
// VÉRIFIER SI UN AIDANT EST DISPONIBLE POUR UNE VISITE
// ============================================================
const checkAidantAvailability = asyncWrapper(async (req, res) => {
  try {
    const { targetType, targetId, familyId } = req.query;
    const userId = req.user.id;

    if (!targetType || !targetId) {
      return res.status(400).json({
        success: false,
        error: 'targetType et targetId sont requis',
      });
    }

    const result = await checkAidantForVisit(
      targetType,
      targetId,
      familyId || userId
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('❌ checkAidantAvailability error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la vérification',
    });
  }
});

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  createVisitController,
  getWizardOptions,
  adminAssignAidant,
  getPendingAidantVisitsController,
  getAvailableAidants,
  validatePendingAidantVisit,
  checkAidantAvailability,
};
