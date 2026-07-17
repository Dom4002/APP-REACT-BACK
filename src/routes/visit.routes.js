// 📁 backend/src/routes/visit.routes.js
 
const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { getCoordinatesFromAddress } = require('../services/maps.service');
const { roleMiddleware } = require('../middleware/role.middleware');
const { createNotification } = require('../services/notification.service');
const { 
  getActiveAidantForTarget,
  getAvailableAidantsForFamily,
  getVisitWizardOptions,
  adminAssignAidantToVisit,
  getPendingAidantVisits,
} = require('../services/aidantAssignment.service');
const {
  getVisitPrice,
  checkSubscriptionForVisits,
  decrementVisit,
  incrementVisit,  
} = require('../services/visitPayment.service');

// Import direct du service d'ad-hoc
const { startAdHocVisit } = require('../services/visit.service');

router.use(authMiddleware);

// =============================================
// CONSTANTES
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

// RÉCUPÉRER L'AIDANT_ID DEPUIS L'USER_ID
const getAidantIdFromUserId = async (userId) => {
  const { data: aidant, error } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userId)
    .single();
  
  if (error || !aidant) return null;
  return aidant.id;
};

// RÉCUPÉRER L'AIDANT_ID DEPUIS UN USER_ID OU AIDANT_ID
const getAidantIdFromUserIdOrId = async (userIdOrId) => {
  const { data: aidantById, error: errorById } = await supabase
    .from('aidants')
    .select('id')
    .eq('id', userIdOrId)
    .maybeSingle();

  if (!errorById && aidantById) {
    return aidantById.id;
  }

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
// 1️⃣ TOUTES LES ROUTES STATIQUES (SANS :id) 
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

// ✅ 1.3 RÉCUPÉRER LES AIDANTS DISPONIBLES (ADMIN & FAMILLE)
router.get('/available-aidants', async (req, res) => {
  try {
    const isAdmin = ['admin', 'coordinator'].includes(req.profile.role);
    const isFamily = req.profile.role === 'family';

    if (!isFamily && !isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Accès non autorisé',
      });
    }

    let familyId = isFamily ? req.user.id : (req.query.familyId || null);

    if (isAdmin && !familyId && req.query.targetId) {
      if (req.query.targetType === 'patient') {
        const { data: link = null } = await supabase
          .from('patient_family_links')
          .select('family_id')
          .eq('patient_id', req.query.targetId)
          .maybeSingle();
        if (link) familyId = link.family_id;
      } else {
        familyId = req.query.targetId; 
      }
    }

    let aidants = [];

    if (familyId) {
      aidants = await getAvailableAidantsForFamily(familyId, {
        zone: req.query.zone,
        specialty: req.query.specialty,
        minRating: req.query.minRating ? parseFloat(req.query.minRating) : undefined,
      });
    } else {
      const { data: aidantsData } = await supabase
        .from('aidants')
        .select('*')
        .eq('status', 'approved')
        .eq('is_verified', true);

      const userIds = (aidantsData || []).map(a => a.user_id).filter(Boolean);
      let profilesMap = {};
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, email, phone, avatar_url')
          .in('id', userIds);
        if (profiles) profilesMap = profiles.reduce((acc, p) => ({ ...acc, [p.id]: p }), {});
      }

      aidants = (aidantsData || []).map(a => ({
        ...a,
        user: a.user_id ? profilesMap[a.user_id] || null : null,
      }));
    }

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
        const { data: link = null } = await supabase
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

router.get('/geocode', async (req, res) => {
  const { address } = req.query;
  const coords = await getCoordinatesFromAddress(address);
  if (coords) return res.json({ success: true, data: coords });
  res.status(404).json({ success: false, error: 'Adresse non trouvée' });
});

// =============================================
// ✅ 1.6 ROUTE POST /start-adhoc (DÉMARRER À LA VOLÉE - AIDANT)
// =============================================
router.post('/start-adhoc', roleMiddleware(['aidant']), async (req, res) => {
  try {
    const { targetType, targetId, lat, lng } = req.body;
    const aidantUserId = req.user.id;

    if (!targetType || !targetId) {
      return res.status(400).json({ success: false, error: 'targetType et targetId sont requis' });
    }

    const result = await startAdHocVisit({
      aidantUserId,
      targetType,
      targetId,
      startLat: lat,
      startLng: lng
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.status(201).json(result);
  } catch (error) {
    console.error('❌ Router start-adhoc error:', error);
    res.status(500).json({ success: false, error: error.message });
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
      const entrantId = await getAidantIdFromUserId(user.id);
      if (entrantId) {
        query = query.eq('aidant_id', entrantId);
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

// ✅ 2.2 CRÉER UNE VISITE
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
      address = null,                     
      latitude = null,                    
      longitude = null,                   
      metadata = {},  
    } = req.body;

    const canCreate = ['admin', 'coordinator'].includes(profile.role);
    if (!canCreate) {
      return res.status(403).json({ error: 'La planification des visites est gérée par l’administration.' });
    }

    // EXTRACTION DE LA CIBLE
    let finalPatientId = patient_id || null;
    let finalTargetType = target_type || (patient_id ? 'patient' : 'personal');
    let finalTargetName = target_name || null;
    let finalUserId = target_user_id || user.id;

    if (patient_id) {
      const { data: patient, error: patientError } = await supabase
        .from('patients')
        .select('id, first_name, last_name')
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

    const { createVisit } = require('../services/visit.service');

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
      wizardChoice: wizard_choice || null,
      selectedAidantId: selected_aidant_id || null,
      profile: profile,
      coordinatorId: user.id,
      address: address || null,              
      latitude: latitude || null,            
      longitude: longitude || null,          
      metadata: metadata || {},  
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

    res.status(201).json(result);
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
      .select('*')
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

    const { data: audios } = await supabase
      .from('visite_audios')
      .select('*')
      .eq('visite_id', id);

    const fullVisit = {
      ...visit,
      aidant,
      photos: photos || [],
      audios: audios || [], 
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

// ✅ 3.3 APPROUVER UNE VISITE
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

// ✅ 3.4 RÉASSIGNER UNE VISITE
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

    const { data: aidantProfile } = await supabase
      .from('aidants')
      .select('user_id')
      .eq('id', finalAidantId)
      .maybeSingle();

    if (aidantProfile?.user_id) {
      await createNotification({
        userId: aidantProfile.user_id, 
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

// ✅ 3.5 DÉMARRER UNE VISITE
router.post('/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;
    const now = new Date().toISOString();
    const { lat, lng } = req.body;

    const entrantId = await getAidantIdFromUserId(user.id);
    if (!entrantId) {
      return res.status(404).json({ error: 'Aidant non trouvé' });
    }

    const { data: visit, error: fetchError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    if (visit.aidant_id !== entrantId) {
      return res.status(403).json({ error: 'Vous n\'êtes pas assigné à cette visite' });
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
          user:profiles!aidants_user_id_fkey (id, full_name, email, phone)
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


// ✅ 3.6 TERMINER UNE VISITE
router.post('/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;
    const { 
      actions, 
      notes, 
      photos, 
      audio_url,
      duration_minutes,
      lat,
      lng
    } = req.body;
    const now = new Date().toISOString();

    const entrantId = await getAidantIdFromUserId(user.id);
    if (!entrantId) {
      return res.status(404).json({ error: 'Aidant non trouvé' });
    }

    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('aidant_id, patient_id, start_time, metadata, target_name, user_id, subscription_id')
      .eq('id', id)
      .single();

    if (visitError) throw visitError;

    if (visit.aidant_id !== entrantId) {
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
      location_end: lat && lng ? { lat, lng } : null,
      metadata: {
        ...(visit.metadata || {}),
        completed_by: user.id,
        completed_at: now,
        audio_url: audio_url || null,
        photos: photos || [], 
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
          user:profiles!aidants_user_id_fkey (id, full_name)
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
            title: '📋 Visite terminée',
            body: `La visite de ${targetDisplay} est terminée. L'aidant a soumis son rapport.`,
            type: 'visite',
            data: { visit_id: data.id, status: 'terminee' },
          });
        }
      }
    } else {
      await createNotification({
        userId: data.user_id,
        title: '📋 Visite terminée',
        body: `Votre visite personnelle est terminée. L'aidant a soumis son rapport.`,
        type: 'visite',
        data: { visit_id: data.id, status: 'terminee' },
      });
    }

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Complete visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 3.7 VALIDER UNE VISITE
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
          user:profiles!aidants_user_id_fkey (id, full_name)
        )
      `)
      .single();

    if (error) throw error;

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
            body: `La visite de ${targetDisplay} a été validée par Santé Plus.`,
            type: 'visite',
            data: { visit_id: data.id, status: 'validee' },
          });
        }
      }
    } else {
      await createNotification({
        userId: data.user_id,
        title: '✅ Visite validée',
        body: `Votre visite personnelle a été validée par Santé Plus.`,
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

// ✅ 3.8 ANNULER UNE VISITE
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
          const { data: link = null } = await supabase
            .from('patient_family_links')
            .select('family_id')
            .eq('family_id', user.id)
            .eq('patient_id', visit.patient_id)
            .maybeSingle();

          if (!link) return res.status(403).json({ error: 'Non autorisé' });
        } else if (visit.user_id !== user.id) {
          return res.status(403).json({ error: 'Non autorisé' });
        }
      } else {
        return res.status(403).json({ error: 'Non autorisé' });
      }
    }

    const { data, error } = await supabase
      .from('visites')
      .update({
        status: 'annulee',
        updated_at: new Date().toISOString(),
        metadata: {
          ...(visit.metadata || {}),
          cancelled_by: user.id,
          cancelled_at: new Date().toISOString(),
          cancellation_reason: reason || null,
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

module.exports = router;
