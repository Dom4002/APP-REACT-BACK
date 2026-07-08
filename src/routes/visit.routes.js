// 📁 backend/src/routes/visit.routes.js
// ✅ ROUTEUR VISITES COMPLET : ALIGNEMENT DES CONTRAINTES POSTGRES ET FLUX DE PLANIFICATION ROBUSTE

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');
const { createNotification } = require('../services/notification.service');
const { 
  getActiveAidantForTarget,
  getAvailableAidantsForFamily,
  getVisitWizardOptions,
  adminAssignAidantToVisit,
  getPendingAidantVisits,
  isAidantFull,
} = require('../services/aidantAssignment.service');
const {
  getVisitPrice,
  checkSubscriptionForVisits,
  decrementVisit,
} = require('../services/visitPayment.service');

router.use(authMiddleware);

// =============================================
// CONSTANTES - UNIQUES ET CENTRALISÉES
// =============================================
const VISIT_PONCTUAL_PRICES = {
  '30': 5000,
  '45': 6000,
  '60': 7500,
  '90': 10000,
  '120': 12500,
};

const DEFAULT_VISIT_PRICE = 7500;

const getPonctualPrice = (durationMinutes) => {
  const duration = durationMinutes || 60;
  const price = VISIT_PONCTUAL_PRICES[duration.toString()];
  if (price) return price;
  return Math.round((duration / 60) * DEFAULT_VISIT_PRICE);
};

// =============================================
// RÉCUPÉRER L'AIDANT_ID DEPUIS L'USER_ID
// =============================================
const getAidantIdFromUserId = async (userId) => {
  const { data: aidant, error } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userId)
    .single();
  
  if (error || !aidant) return null;
  return aidant.id;
};

// =============================================
// RÉCUPÉRER L'AIDANT_ID DEPUIS UN USER_ID OU AIDANT_ID
// =============================================
const getAidantIdFromUserIdOrId = async (userIdOrId) => {
  // 1. Vérifier si c'est déjà un aidant_id
  const { data: aidantById, error: errorById } = await supabase
    .from('aidants')
    .select('id')
    .eq('id', userIdOrId)
    .maybeSingle();

  if (!errorById && aidantById) {
    return aidantById.id;
  }

  // 2. Vérifier si c'est un user_id
  const { data: aidantByUser, error: errorByUser } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userIdOrId)
    .maybeSingle();

  if (!errorByUser && aidantByUser) {
    return aidantByUser.id;
  }

  return null;
};

// =============================================
// 1️⃣ TOUTES LES ROUTES STATIQUES (SANS :id) - PLACÉES TOUT EN HAUT 🚀
// =============================================

// ✅ 1.1 RÉCUPÉRER LES COMPTES DISPONIBLES POUR L'ADMIN
router.get('/accounts', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { data: accounts, error: accountsError } = await supabase
      .from('profiles')
      .select('id, full_name, email, phone, role, patient_category, is_active')
      .eq('role', 'family')
      .order('full_name');

    if (accountsError) throw accountsError;

    const accountsWithPatients = await Promise.all((accounts || []).map(async (account) => {
      const { data: links, error: linksError } = await supabase
        .from('patient_family_links')
        .select('patient_id, patient:patients(id, first_name, last_name, address, category)')
        .eq('family_id', account.id);

      const patients = links?.map(l => l.patient).filter(Boolean) || [];

      return {
        ...account,
        has_patient: patients.length > 0,
        patients: patients,
        display_name: patients.length > 0 
          ? `${account.full_name} (${patients.length} proche${patients.length > 1 ? 's' : ''})` 
          : `${account.full_name} (👤 Compte personnel)`,
        type: patients.length > 0 ? 'account_with_patients' : 'personal_account',
      };
    }));

    res.json({
      success: true,
      data: accountsWithPatients,
    });
  } catch (error) {
    console.error('❌ Get accounts error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 1.2 RÉCUPÉRER LES VISITES EN ATTENTE D'AIDANT (ADMIN uniquement)
router.get('/pending-aidant', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const visits = await getPendingAidantVisits();
    
    // Enrichir avec les relations
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
    console.error('❌ Get pending aidant visits error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 1.3 RÉCUPÉRER LES AIDANTS DISPONIBLES POUR UNE FAMILLE
router.get('/available-aidants', async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetType, targetId } = req.query;

    if (req.profile.role !== 'family') {
      return res.status(403).json({
        success: false,
        error: 'Accès réservé aux familles',
      });
    }

    const aidants = await getAvailableAidantsForFamily(userId, {
      zone: req.query.zone,
      specialty: req.query.specialty,
      minRating: req.query.minRating ? parseFloat(req.query.minRating) : undefined,
    });

    res.json({
      success: true,
      data: aidants,
      count: aidants.length,
    });
  } catch (error) {
    console.error('❌ Get available aidants error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 1.4 RÉCUPÉRER LES OPTIONS DU WIZARD
router.get('/wizard-options', async (req, res) => {
  try {
    const { targetType, targetId } = req.query;
    const userId = req.user.id;

    if (!targetType || !targetId) {
      return res.status(400).json({
        success: false,
        error: 'targetType et targetId sont requis',
      });
    }

    const isAdmin = ['admin', 'coordinator'].includes(req.profile.role);
    const isFamily = req.profile.role === 'family';

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

    const familyId = isFamily ? userId : (req.body.familyId || null);
    const options = await getVisitWizardOptions(targetType, targetId, familyId || userId);

    res.json({
      success: true,
      data: options,
    });
  } catch (error) {
    console.error('❌ Get wizard options error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 1.5 RÉCUPÉRER LES VISITES EN BROUILLON (DRAFTS)
router.get('/drafts/my', async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
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
      .eq('user_id', userId)
      .eq('status', 'brouillon')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const visitsWithPrice = (data || []).map(visit => ({
      ...visit,
      payment_amount: getPonctualPrice(visit.duration_minutes || 60),
    }));

    res.json(visitsWithPrice);
  } catch (error) {
    console.error('❌ Get drafts error:', error);
    res.status(500).json({ error: error.message });
  }
});


// =============================================
// 2️⃣ ROUTES DE MANIPULATION D'ÉCRITURE (ROUTE GENERIQUE '/')
// =============================================

// ✅ 2.1 LISTE DE TOUTES LES VISITES
router.get('/', async (req, res) => {
  try {
    const { user, profile } = req;

    let patientIds = [];
    if (profile.role === 'family') {
      const { data: links } = await supabase
        .from('patient_family_links')
        .select('patient_id')
        .eq('family_id', user.id);
      patientIds = links?.map(l => l.patient_id).filter(Boolean) || [];
    }

    let query = supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*)
      `);

    if (profile.role === 'admin' || profile.role === 'coordinator') {
      // Admin/Coord → toutes les visites
    } else if (profile.role === 'family') {
      if (patientIds.length > 0) {
        query = query.or(`patient_id.in.(${patientIds.join(',')}), user_id.eq.${user.id}`);
      } else {
        query = query.eq('user_id', user.id);
      }
    } else if (profile.role === 'aidant') {
      const aidantId = await getAidantIdFromUserId(user.id);
      if (aidantId) {
        query = query.eq('aidant_id', aidantId);
      } else {
        return res.json([]);
      }
    }

    const { data: visits, error } = await query.order('scheduled_date', { ascending: true });
    if (error) throw error;

    const aidantIds = [...new Set(
      (visits || [])
        .filter(v => v.aidant_id)
        .map(v => v.aidant_id)
    )];

    let aidantMap = {};
    if (aidantIds.length > 0) {
      const { data: aidants } = await supabase
        .from('aidants')
        .select('*')
        .in('id', aidantIds);

      if (aidants) {
        const userIds = aidants.map(a => a.user_id).filter(Boolean);
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

        aidantMap = aidants.reduce((acc, a) => {
          acc[a.id] = {
            ...a,
            user: a.user_id ? profileMap[a.user_id] || null : null,
          };
          return acc;
        }, {});
      }
    }

    const visitsWithAidants = (visits || []).map(visit => ({
      ...visit,
      aidant: visit.aidant_id ? aidantMap[visit.aidant_id] || null : null,
    }));

    res.json(visitsWithAidants);
  } catch (error) {
    console.error('❌ GET visits error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 2.2 CRÉER UNE VISITE (S'appuie sur visit.service.js)
router.post('/', async (req, res) => {
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
      wizard_choice = null,
      selected_aidant_id = null,
    } = req.body;

    const canCreate = ['admin', 'coordinator'].includes(profile.role) || profile.role === 'family';
    if (!canCreate) {
      return res.status(403).json({ error: 'Non autorisé à créer une visite' });
    }

    const { createVisit } = require('../services/visit.service');

    const result = await createVisit({
      userId: user.id,
      patientId: patient_id || null,
      targetType: target_type || (patient_id ? 'patient' : 'personal'),
      targetName: target_name || null,
      targetUserId: target_user_id || user.id,
      scheduledDate: scheduled_date,
      scheduledTime: scheduled_time,
      durationMinutes: duration_minutes || 60,
      notes: notes || null,
      isUrgent: is_urgent || false,
      isPonctual: is_ponctual || false,
      assignmentType: assignment_type || 'ponctuelle',
      aidantId: aidant_id || null,
      wizardChoice: wizard_choice || null,
      selectedAidantId: selected_aidant_id || null,
      profile: profile,
      coordinatorId: ['admin', 'coordinator'].includes(profile.role) ? user.id : null,
    });

    if (!result.success) {
      if (result.code === 'WIZARD_REQUIRED' || result.code === 'ALL_AIDANTS_FULL') {
        return res.status(400).json({
          success: false,
          error: result.error,
          code: result.code,
          wizard: result.wizard,
        });
      }
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

    res.status(201).json({
      success: true,
      visit: result.visit,
      requires_payment: result.requires_payment,
      payment_amount: result.payment_amount,
      subscription_used: result.subscription_used,
      waiting_for_aidant: result.waiting_for_aidant,
    });
  } catch (error) {
    console.error('❌ Erreur création visite (route):', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// 3️⃣ ROUTES DYNAMIQUES (AVEC :id)
// =============================================

// ✅ 3.1 DÉTAILS D’UNE VISITE PAR ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, profile } = req;

    const { data: visit, error } = await supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*)
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Visite non trouvée' });
      }
      throw error;
    }

    let hasAccess = false;

    if (['admin', 'coordinator'].includes(profile.role)) {
      hasAccess = true;
    } else if (profile.role === 'family') {
      if (visit.user_id === user.id) {
        hasAccess = true;
      } else if (visit.patient_id) {
        const { data: links } = await supabase
          .from('patient_family_links')
          .select('id')
          .eq('family_id', user.id)
          .eq('patient_id', visit.patient_id)
          .maybeSingle();
        hasAccess = !!links;
      }
    } else if (profile.role === 'aidant') {
      const aidantId = await getAidantIdFromUserId(user.id);
      if (aidantId) {
        hasAccess = visit.aidant_id === aidantId;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    let aidant = null;
    if (visit.aidant_id) {
      const { data: aidantData } = await supabase
        .from('aidants')
        .select('*')
        .eq('id', visit.aidant_id)
        .single();

      if (aidantData) {
        let userProfile = null;
        if (aidantData.user_id) {
          const { data: profileData } = await supabase
            .from('profiles')
            .select('id, full_name, email, phone, avatar_url, role')
            .eq('id', aidantData.user_id)
            .single();
          userProfile = profileData;
        }
        aidant = { ...aidantData, user: userProfile };
      }
    }

    const { data: photos } = await supabase
      .from('visite_photos')
      .select('*')
      .eq('visite_id', id);

    const fullVisit = {
      ...visit,
      aidant,
      photos: photos || [],
    };

    res.json(fullVisit);
  } catch (error) {
    console.error('❌ Get visit detail error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.2 ADMIN ASSIGNER UN AIDANT À UNE VISITE
router.post('/admin/assign-aidant', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { visitId, aidantId, assignmentType = 'permanente', reason = null, force = false } = req.body;

    if (!visitId || !aidantId) {
      return res.status(400).json({
        success: false,
        error: 'visitId et aidantId sont requis',
      });
    }

    const result = await adminAssignAidantToVisit({
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
      message: result.message,
      visit: visit || result.visit,
      assignment_type: result.assignment_type,
      is_permanent: result.is_permanent,
      forced: result.forced,
      current_assignments: result.current_assignments,
    });
  } catch (error) {
    console.error('❌ Admin assign aidant error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.3 CONFIRMER PAIEMENT - BROUILLON → PLANIFIEE AVEC FLUX DES CONTRAINTES
router.post('/:id/confirm-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { transaction_id } = req.body;
    const userId = req.user.id;

    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', id)
      .single();

    if (visitError) {
      return res.status(404).json({ error: 'Visite non trouvée' });
    }

    if (visit.user_id !== userId) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    if (visit.status !== 'brouillon') {
      return res.status(400).json({ error: 'Cette visite n\'est pas en attente de paiement' });
    }

    const familyId = visit.user_id;
    const targetType = visit.patient_id ? 'patient' : 'personal_account';
    const targetId = visit.patient_id || visit.user_id;

    let aidantId = visit.aidant_id || visit.metadata?.selected_aidant || null;

    if (aidantId) {
      const convertedId = await getAidantIdFromUserIdOrId(aidantId);
      if (convertedId) {
        aidantId = convertedId;
        console.log(`🔄 Aidant sélectionné dans wizard récupéré: ${aidantId}`);
      } else {
        aidantId = null;
        console.warn(`⚠️ Aidant sélectionné dans wizard introuvable, réassignation automatique`);
      }
    }

    if (!aidantId) {
      let foundId = await getActiveAidantForTarget(targetType, targetId, familyId);
      if (foundId) {
        const convertedId = await getAidantIdFromUserIdOrId(foundId);
        if (convertedId) {
          aidantId = convertedId;
          console.log(`✅ Aidant automatique trouvé après paiement: ${aidantId}`);
        }
      }
    }

    // ✅ CORRECTION DE TOUTES LES CONTRAINTES POSTGRESQL "chk_draft_is_draft" & "chk_draft_requires_payment"
    const { data: updatedVisit, error: updateError } = await supabase
      .from('visites')
      .update({
        status: 'planifiee',
        is_draft: false,            // 🔓 Lève la contrainte chk_draft_is_draft
        requires_payment: false,    // 🔓 Lève la contrainte chk_draft_requires_payment
        is_paid: true,              // Enregistre l'état payé
        aidant_id: aidantId,
        metadata: {
          ...(visit.metadata || {}),
          payment_confirmed_at: new Date().toISOString(),
          transaction_id: transaction_id,
          scheduled_from_draft: true,
          payment_completed: true,
          aidant_assigned_after_payment: !!aidantId,
          selected_aidant: null,
          wizard_choice: null,
        }
      })
      .eq('id', id)
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
      return res.status(500).json({ error: updateError.message });
    }

    const targetDisplay = updatedVisit.target_name || (updatedVisit.patient ? `${updatedVisit.patient.first_name} ${updatedVisit.patient.last_name}` : 'Personnel');

    if (aidantId && updatedVisit.aidant?.user_id) {
      await createNotification({
        userId: updatedVisit.aidant.user_id, // ✅ ID utilisateur (profiles.id) à la place de l'aidant_id
        title: '📅 Nouvelle visite à valider',
        body: `Visite pour ${targetDisplay} le ${updatedVisit.scheduled_date} à ${updatedVisit.scheduled_time}`,
        type: 'visite',
        data: { visit_id: id, action: 'approve' },
      });
    }

    await createNotification({
      userId: userId,
      title: '✅ Visite planifiée !',
      body: `Votre visite pour ${targetDisplay} a été planifiée avec succès${aidantId ? ' et un aidant a été assigné' : ''}.`,
      type: 'visite',
      data: { visit_id: id, status: 'planifiee' },
    });

    res.json({ 
      success: true, 
      visit: updatedVisit,
      aidant_assigned: !!aidantId,
      message: `Visite planifiée avec succès après paiement${aidantId ? ' et aidant assigné' : ''}`,
    });
  } catch (error) {
    console.error('❌ Confirm payment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.4 OBTENIR LE PRIX D'UNE VISITE PONCTUELLE
router.get('/:id/price', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: visit, error } = await supabase
      .from('visites')
      .select('duration_minutes, metadata')
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Visite non trouvée' });
    }

    const duration = visit.duration_minutes || 60;
    const price = getPonctualPrice(duration);

    res.json({
      success: true,
      duration_minutes: duration,
      price: price,
      currency: 'XOF',
    });
  } catch (error) {
    console.error('❌ Get visit price error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.5 APPROUVER UNE VISITE
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, profile } = req;

    const aidantId = await getAidantIdFromUserId(user.id);
    if (!aidantId) {
      return res.status(404).json({ error: 'Aidant non trouvé' });
    }

    const { data: visit, error: fetchError } = await supabase
      .from('visites')
      .select('*, patient:patients(*), aidant:aidants(*)')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    if (visit.aidant_id !== aidantId) {
      return res.status(403).json({ error: 'Vous n\'êtes pas assigné à cette visite' });
    }

    if (visit.status !== 'planifiee' && visit.status !== 'en_attente') {
      return res.status(400).json({ error: 'Cette visite ne peut pas être approuvée' });
    }

    const { data, error } = await supabase
      .from('visites')
      .update({
        status: 'acceptee',
        approved_by: user.id,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    const targetDisplay = visit.target_name || (visit.patient ? `${visit.patient.first_name} ${visit.patient.last_name}` : 'Personnel');
    const aidantName = profile?.full_name || 'L\'aidant';

    if (visit.patient) {
      const { data: links } = await supabase
        .from('patient_family_links')
        .select('family_id')
        .eq('patient_id', visit.patient_id);

      if (links) {
        for (const link of links) {
          await createNotification({
            userId: link.family_id,
            title: '✅ Visite acceptée',
            body: `L'aidant ${aidantName} a accepté la visite pour ${targetDisplay} le ${visit.scheduled_date}.`,
            type: 'visite',
            data: { visit_id: id, status: 'acceptee' },
          });
        }
      }
    } else {
      await createNotification({
        userId: visit.user_id,
        title: '✅ Visite acceptée',
        body: `L'aidant ${aidantName} a accepté votre visite personnelle le ${visit.scheduled_date}.`,
        type: 'visite',
        data: { visit_id: id, status: 'acceptee' },
      });
    }

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Approve visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.6 REFUSER UNE VISITE
router.post('/:id/refuse', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, profile } = req;
    const { reason } = req.body;

    const aidantId = await getAidantIdFromUserId(user.id);
    if (!aidantId) {
      return res.status(404).json({ error: 'Aidant non trouvé' });
    }

    const { data: visit, error: fetchError } = await supabase
      .from('visites')
      .select('*, patient:patients(*), aidant:aidants(*)')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    if (visit.aidant_id !== aidantId) {
      return res.status(403).json({ error: 'Vous n\'êtes pas assigné à cette visite' });
    }

    const { data, error } = await supabase
      .from('visites')
      .update({
        status: 'refusee',
        refused_by: user.id,
        refused_at: new Date().toISOString(),
        refusal_reason: reason || 'Non spécifié',
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    const targetDisplay = visit.target_name || (visit.patient ? `${visit.patient.first_name} ${visit.patient.last_name}` : 'Personnel');
    const aidantName = profile?.full_name || 'L\'aidant';

    if (visit.patient) {
      const { data: links } = await supabase
        .from('patient_family_links')
        .select('family_id')
        .eq('patient_id', visit.patient_id);

      if (links) {
        for (const link of links) {
          await createNotification({
            userId: link.family_id,
            title: '❌ Visite refusée',
            body: `L'aidant ${aidantName} a refusé la visite pour ${targetDisplay} le ${visit.scheduled_date}. Motif: ${reason || 'Non spécifié'}`,
            type: 'visite',
            data: { visit_id: id, status: 'refusee' },
          });
        }
      }
    } else {
      await createNotification({
        userId: visit.user_id,
        title: '❌ Visite refusée',
        body: `L'aidant ${aidantName} a refusé votre visite personnelle le ${visit.scheduled_date}. Motif: ${reason || 'Non spécifié'}`,
        type: 'visite',
        data: { visit_id: id, status: 'refusee' },
      });
    }

    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (admins) {
      for (const admin of admins) {
        await createNotification({
          userId: admin.id,
          title: '⚠️ Visite refusée - Réassignation nécessaire',
          body: `L'aidant ${aidantName} a refusé la visite pour ${targetDisplay} le ${visit.scheduled_date}.`,
          type: 'alert',
          data: { visit_id: id, action: 'reassign' },
        });
      }
    }

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Refuse visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.7 RÉASSIGNER UNE VISITE
router.post('/:id/reassign', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { aidant_id, assignment_type } = req.body;

    let finalAidantId = aidant_id;
    if (finalAidantId) {
      const convertedId = await getAidantIdFromUserIdOrId(finalAidantId);
      if (convertedId) {
        finalAidantId = convertedId;
      } else {
        return res.status(400).json({ error: 'Aidant invalide' });
      }
    }

    const { data: visit, error: fetchError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    const { data, error } = await supabase
      .from('visites')
      .update({
        aidant_id: finalAidantId,
        status: 'planifiee',
        assignment_type: assignment_type || 'ponctuelle',
        approved_at: null,
        refused_at: null,
        refusal_reason: null,
        assigned_by: req.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    const targetDisplay = visit.target_name || (visit.patient ? `${visit.patient.first_name} ${visit.patient.last_name}` : 'Personnel');

    // ✅ Récupérer le user_id de l'aidant
    const { data: aidantProfile } = await supabase
      .from('aidants')
      .select('user_id')
      .eq('id', finalAidantId)
      .maybeSingle();

    if (aidantProfile?.user_id) {
      await createNotification({
        userId: aidantProfile.user_id, // ✅ ID utilisateur de profil (profiles.id) à la place de l'aidant_id
        title: '📅 Nouvelle visite assignée',
        body: `Vous avez été assigné à une visite pour ${targetDisplay} le ${visit.scheduled_date} à ${visit.scheduled_time}.`,
        type: 'visite',
        data: { visit_id: id, action: 'approve' },
      });
    }

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Reassign visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.8 DÉMARRER UNE VISITE
router.post('/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;
    const now = new Date().toISOString();
    const { lat, lng } = req.body;

    const aidantId = await getAidantIdFromUserId(user.id);
    if (!aidantId) {
      return res.status(404).json({ error: 'Aidant non trouvé' });
    }

    const { data: visit, error: fetchError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    if (visit.aidant_id !== aidantId) {
      return res.status(403).json({ error: 'Vous n\'êtes pas assigné à cette visite' });
    }

    if (visit.status !== 'acceptee') {
      return res.status(400).json({ error: 'La visite doit être acceptée avant de démarrer' });
    }

    const updateData = {
      status: 'en_cours',
      start_time: now,
    };

    if (lat && lng) {
      updateData.location_start = { lat, lng };
    }

    const { data, error } = await supabase
      .from('visites')
      .update(updateData)
      .eq('id', id)
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

    if (error) throw error;

    const targetDisplay = data.target_name || (data.patient ? `${data.patient.first_name} ${data.patient.last_name}` : 'Personnel');

    if (data.patient) {
      const { data: links } = await supabase
        .from('patient_family_links')
        .select('family_id')
        .eq('patient_id', data.patient_id);

      if (links) {
        for (const link of links) {
          await createNotification({
            userId: link.family_id,
            title: '🔄 Visite en cours',
            body: `${data.aidant?.user?.full_name || 'L\'aidant'} a commencé la visite de ${targetDisplay}.`,
            type: 'visite',
            data: { visit_id: data.id, status: 'en_cours' },
          });
        }
      }
    } else {
      await createNotification({
        userId: data.user_id,
        title: '🔄 Visite en cours',
        body: `${data.aidant?.user?.full_name || 'L\'aidant'} a commencé votre visite personnelle.`,
        type: 'visite',
        data: { visit_id: data.id, status: 'en_cours' },
      });
    }

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Start visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.9 TERMINER UNE VISITE
router.post('/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;
    const { 
      actions, 
      notes, 
      photos, 
      audio_url,
      signature_url,
      duration_minutes,
      lat,
      lng
    } = req.body;
    const now = new Date().toISOString();

    const aidantId = await getAidantIdFromUserId(user.id);
    if (!aidantId) {
      return res.status(404).json({ error: 'Aidant non trouvé' });
    }

    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('aidant_id, patient_id, start_time, metadata, target_name, user_id')
      .eq('id', id)
      .single();

    if (visitError) throw visitError;

    if (visit.aidant_id !== aidantId) {
      return res.status(403).json({ error: 'Vous n\'êtes pas assigné à cette visite' });
    }

    let calculatedDuration = duration_minutes;
    if (!calculatedDuration && visit.start_time) {
      const start = new Date(visit.start_time);
      const end = new Date(now);
      calculatedDuration = Math.round((end.getTime() - start.getTime()) / (1000 * 60));
    }

    const updateData = {
      status: 'terminee',
      end_time: now,
      actions: actions || [],
      notes: notes || '',
      report: notes || '',
      metadata: {
        ...(visit.metadata || {}),
        completed_by: user.id,
        completed_at: now,
        audio_url: audio_url || null,
        signature_url: signature_url || null,
        duration_minutes: calculatedDuration,
        end_location: lat && lng ? { lat, lng } : null,
      }
    };

    const { data, error } = await supabase
      .from('visites')
      .update(updateData)
      .eq('id', id)
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

    if (error) throw error;

    if (photos && photos.length > 0) {
      for (const photoUrl of photos) {
        await supabase.from('visite_photos').insert({
          visite_id: id,
          photo_url: photoUrl,
          photo_type: 'proof',
          uploaded_by: user.id,
        });
      }
    }

    if (audio_url) {
      await supabase.from('visite_audios').insert({
        visite_id: id,
        audio_url: audio_url,
        uploaded_by: user.id,
      });
    }

    const targetDisplay = data.target_name || (data.patient ? `${data.patient.first_name} ${data.patient.last_name}` : 'Personnel');

    if (data.patient) {
      const { data: links } = await supabase
        .from('patient_family_links')
        .select('family_id')
        .eq('patient_id', data.patient_id);

      if (links) {
        for (const link of links) {
          await createNotification({
            userId: link.family_id,
            title: '📋 Visite terminée - En attente de validation',
            body: `La visite de ${targetDisplay} est terminée. L'aidant a soumis son rapport.`,
            type: 'visite',
            data: { visit_id: data.id, status: 'terminee' },
          });
        }
      }
    } else {
      await createNotification({
        userId: data.user_id,
        title: '📋 Visite terminée - En attente de validation',
        body: `Votre visite personnelle est terminée. L'aidant a soumis son rapport.`,
        type: 'visite',
        data: { visit_id: data.id, status: 'terminee' },
      });
    }

    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (admins) {
      for (const admin of admins) {
        await createNotification({
          userId: admin.id,
          title: '📋 Nouveau rapport de visite',
          body: `${data.aidant?.user?.full_name || 'Un aidant'} a terminé la visite de ${targetDisplay}. À valider.`,
          type: 'system',
          data: { visit_id: data.id, action: 'validate' },
        });
      }
    }

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Complete visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.10 VALIDER UNE VISITE
router.post('/:id/validate', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { comment } = req.body;
    const now = new Date().toISOString();

    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('patient_id, aidant_id, metadata, user_id, target_type, target_name, status, subscription_id')
      .eq('id', id)
      .single();

    if (visitError) throw visitError;

    if (visit.status !== 'terminee') {
      return res.status(400).json({ error: 'Seules les visites terminées peuvent être validées' });
    }

    const { data, error } = await supabase
      .from('visites')
      .update({
        status: 'validee',
        metadata: {
          ...(visit.metadata || {}),
          validated_by: req.user.id,
          validated_at: now,
          validation_comment: comment || null,
        }
      })
      .eq('id', id)
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

    if (error) throw error;

    const isOnctual = visit.metadata?.is_ponctual === true || visit.metadata?.ponctual_mode === true;
    const wasPaid = visit.metadata?.payment_completed === true;

    if (!isOnctual || !wasPaid) {
      if (visit.subscription_id) {
        const result = await decrementVisit(visit.subscription_id);
        if (result.success) {
          console.log(`...`);
        } else {
          console.warn(`...`, result.error);
        }
      } else {
        const { data: subscription, error: subError } = await supabase
          .from('abonnements')
          .select('id, remaining_visits, used_visits, total_visits, user_id')
          .eq('user_id', data.user_id)
          .eq('status', 'actif')
          .maybeSingle();

        if (subscription && !subError && subscription.remaining_visits > 0) {
          const result = await decrementVisit(subscription.id);
          if (result.success) {
            console.log(`...`);
          }
        }
      }
    } else {
      console.log(`ℹ️ Visite ponctuelle payée - Pas de décompte d'abonnement pour la visite ${id}`);
    }

    const targetDisplay = data.target_name || (data.patient ? `${data.patient.first_name} ${data.patient.last_name}` : 'Personnel');

    if (data.patient) {
      const { data: links = [] } = await supabase
        .from('patient_family_links')
        .select('family_id')
        .eq('patient_id', data.patient_id);

      if (links) {
        for (const link of links) {
          await createNotification({
            userId: link.family_id,
            title: '✅ Visite validée',
            body: `La visite de ${targetDisplay} a été validée.`,
            type: 'visite',
            data: { visit_id: data.id, status: 'validee' },
          });
        }
      }
    } else {
      await createNotification({
        userId: data.user_id,
        title: '✅ Visite validée',
        body: `Votre visite personnelle a été validée.`,
        type: 'visite',
        data: { visit_id: data.id, status: 'validee' },
      });
    }

    if (data.aidant?.user_id) {
      await createNotification({
        userId: data.aidant.user_id,
        title: '✅ Visite validée',
        body: `La visite de ${targetDisplay} a été validée.`,
        type: 'visite',
        data: { visit_id: data.id, status: 'validee' },
      });
    }

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Validate visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.11 ANNULER UNE VISITE
router.post('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, profile } = req;
    const { reason } = req.body;

    const { data: visit, error: fetchError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    const canCancel = ['admin', 'coordinator'].includes(profile.role);
    if (!canCancel) {
      if (profile.role === 'family') {
        if (visit.patient_id) {
          const { data: link } = await supabase
            .from('patient_family_links')
            .select('family_id')
            .eq('family_id', user.id)
            .eq('patient_id', visit.patient_id)
            .maybeSingle();

          if (!link) {
            return res.status(403).json({ error: 'Non autorisé' });
          }
        } else if (visit.user_id !== user.id) {
          return res.status(403).json({ error: 'Non autorisé' });
        }
      } else {
        return res.status(403).json({ error: 'Non autorisé' });
      }
    }

    const isDraft = visit.status === 'brouillon';

    const { data, error } = await supabase
      .from('visites')
      .update({
        status: 'annulee',
        metadata: {
          ...(visit.metadata || {}),
          cancelled_by: user.id,
          cancelled_at: new Date().toISOString(),
          cancellation_reason: reason || null,
          cancelled_from_draft: isDraft,
        }
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Cancel visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.12 PHOTOS & PIÈCES JOINTES
router.post('/:id/photos', async (req, res) => {
  try {
    const { id } = req.params;
    const { photo_url, caption, photo_type } = req.body;

    const { data, error } = await supabase
      .from('visite_photos')
      .insert({
        visite_id: id,
        photo_url,
        caption: caption || null,
        photo_type: photo_type || 'other',
        uploaded_by: req.user.id,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, photo: data });
  } catch (error) {
    console.error('❌ Add photo error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/photos/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;

    const { data: photo, error: fetchError } = await supabase
      .from('visite_photos')
      .select('uploaded_by, visite_id')
      .eq('id', photoId)
      .single();

    if (fetchError) throw fetchError;

    if (photo.uploaded_by !== req.user.id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', req.user.id)
        .single();

      if (!['admin', 'coordinator'].includes(profile?.role)) {
        return res.status(403).json({ error: 'Non autorisé' });
      }
    }

    const { error } = await supabase
      .from('visite_photos')
      .delete()
      .eq('id', photoId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Delete photo error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/photos', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('visite_photos')
      .select('*')
      .eq('visite_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Get photos error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/audios', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('visite_audios')
      .select('*')
      .eq('visite_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Get audios error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.13 CONVERTIR UN BROUILLON VERS ABONNEMENT
router.post('/:id/convert-to-subscription', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (visitError) {
      return res.status(404).json({ 
        success: false, 
        error: 'Visite non trouvée' 
      });
    }

    if (visit.status !== 'brouillon') {
      return res.status(400).json({ 
        success: false, 
        error: 'Cette visite n\'est pas en attente de paiement' 
      });
    }

    const { data: subscription, error: subError } = await supabase
      .from('abonnements')
      .select('id, remaining_visits, used_visits, total_visits, status, user_id')
      .eq('user_id', userId)
      .eq('status', 'actif')
      .maybeSingle();

    if (subError || !subscription) {
      return res.status(400).json({ 
        success: false, 
        error: 'Aucun abonnement actif trouvé' 
      });
    }

    if (subscription.remaining_visits <= 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Plus de visites disponibles dans votre abonnement' 
      });
    }

    const { data: updatedVisit, error: updateError } = await supabase
      .from('visites')
      .update({
        status: 'planifiee',
        is_draft: false, // ✅ CORRECTION CONTRAINTE POSTGRES
        metadata: {
          ...(visit.metadata || {}),
          converted_from_draft: true,
          converted_at: new Date().toISOString(),
          subscription_id: subscription.id,
          subscription_used: true,
          payment_required: false,
        }
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Erreur mise à jour visite:', updateError);
      return res.status(500).json({ 
        success: false, 
        error: updateError.message 
      });
    }

    const newRemaining = subscription.remaining_visits - 1;
    const newUsed = subscription.used_visits + 1;

    const { error: subUpdateError } = await supabase
      .from('abonnements')
      .update({
        used_visits: newUsed,
        remaining_visits: newRemaining,
        updated_at: new Date().toISOString(),
      })
      .eq('id', subscription.id);

    if (subUpdateError) {
      console.error('❌ Erreur mise à jour abonnement:', subUpdateError);
    }

    await createNotification({
      userId: userId,
      title: '✅ Visite validée avec votre abonnement',
      body: `Visite du ${visit.scheduled_date} validée. Il vous reste ${newRemaining} visite(s).`,
      type: 'visite',
      data: { 
        visit_id: id, 
        status: 'planifiee',
        remaining_visits: newRemaining,
      },
    });

    if (newRemaining === 0) {
      await createNotification({
        userId: userId,
        title: '📊 Plus de visites disponibles',
        body: 'Vous avez utilisé toutes vos visites. Pensez à renouveler votre abonnement.',
        type: 'system',
        data: { subscription_id: subscription.id },
      });
    }

    if (updatedVisit.aidant_id) {
      await createNotification({
        userId: updatedVisit.aidant_id,
        title: '📅 Nouvelle visite à valider',
        body: `Visite pour ${updatedVisit.target_name || 'le patient'} le ${updatedVisit.scheduled_date} à ${updatedVisit.scheduled_time}`,
        type: 'visite',
        data: { visit_id: id, action: 'approve' },
      });
    }

    res.json({ 
      success: true, 
      visit: updatedVisit,
      remaining_visits: newRemaining,
      used_visits: newUsed,
      message: 'Visite validée avec succès avec votre abonnement',
    });

  } catch (error) {
    console.error('❌ Convert to subscription error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;
_----
 
