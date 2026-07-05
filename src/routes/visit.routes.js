// 📁 backend/src/routes/visit.routes.js
 

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const roleMiddleware = require('../middleware/role.middleware');
const { createNotification } = require('../services/notification.service');
const { getActiveAidantForTarget } = require('../services/aidantAssignment.service');

// ✅ IMPORTER LE SERVICE DE PAIEMENT
const {
  getVisitPrice,
  requiresPayment,
  confirmVisitPayment,
  cancelDraftVisit,
  VISIT_STATUS,
} = require('../services/visitPayment.service');

router.use(authMiddleware);

// =============================================
// CONSTANTES
// =============================================

// ✅ RÉCUPÉRER L'AIDANT_ID DEPUIS L'USER_ID
const getAidantIdFromUserId = async (userId) => {
  const { data: aidant, error } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userId)
    .single();
  
  if (error || !aidant) return null;
  return aidant.id;
};

// ✅ RÉCUPÉRER L'AIDANT_ID DEPUIS UN USER_ID OU AIDANT_ID
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
// RÉCUPÉRER LES COMPTES DISPONIBLES POUR L'ADMIN
// =============================================
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

// =============================================
// LISTE DES VISITES
// =============================================
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
      // Toutes les visites
    } else if (profile.role === 'family') {
      if (patientIds.length > 0) {
        query = query.or(`patient_id.in.(${patientIds.join(',')}), user_id.eq.${user.id}`);
      } else {
        query = query.eq('user_id', user.id);
      }
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();

      if (aidant) {
        query = query.eq('aidant_id', aidant.id);
      } else {
        return res.json([]);
      }
    }

    const { data: visits, error } = await query.order('scheduled_date', { ascending: true });
    if (error) throw error;

    // ✅ Récupérer les aidants manuellement
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
    console.error('❌ Get visits error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// DÉTAILS D'UNE VISITE
// =============================================
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

    // ✅ Vérifier l'accès
    let hasAccess = false;
    if (['admin', 'coordinator'].includes(profile.role)) {
      hasAccess = true;
    } else if (profile.role === 'family') {
      if (visit.user_id === user.id) {
        hasAccess = true;
      } else if (visit.patient_id) {
        const { data: links } = await supabase
          .from('patient_family_links')
          .select('patient_id')
          .eq('family_id', user.id)
          .eq('patient_id', visit.patient_id);
        hasAccess = links && links.length > 0;
      }
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();

      if (aidant) {
        hasAccess = visit.aidant_id === aidant.id;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    // ✅ Récupérer l'aidant manuellement
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

    // ✅ Récupérer les photos
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

// =============================================
// ✅ CRÉER UNE VISITE - AVEC LOGIQUE UNIFIÉE
// =============================================
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
      aidant_id = null
    } = req.body;

    const canCreate = ['admin', 'coordinator'].includes(profile.role) || profile.role === 'family';
    if (!canCreate) {
      return res.status(403).json({ error: 'Non autorisé à créer une visite' });
    }

    // ✅ DÉTERMINER LA CIBLE
    let finalPatientId = null;
    let finalTargetType = 'personal';
    let finalTargetName = target_name || null;
    let finalUserId = null;
    let familyId = null;

    // ✅ Cas 1: L'admin planifie pour un patient
    if (patient_id) {
      const { data: patient, error: patientError } = await supabase
        .from('patients')
        .select('id, first_name, last_name, category, created_by')
        .eq('id', patient_id)
        .single();

      if (patientError || !patient) {
        return res.status(404).json({ error: 'Patient non trouvé' });
      }

      const { data: familyLinks } = await supabase
        .from('patient_family_links')
        .select('family_id')
        .eq('patient_id', patient_id)
        .limit(1);

      finalPatientId = patient_id;
      finalTargetType = 'patient';
      finalTargetName = `${patient.first_name} ${patient.last_name}`;
      
      if (familyLinks && familyLinks.length > 0) {
        finalUserId = familyLinks[0].family_id;
        familyId = familyLinks[0].family_id;
      } else {
        finalUserId = patient.created_by || patient_id;
        familyId = patient.created_by || patient_id;
      }
    }

    // ✅ Cas 2: L'admin planifie pour un compte personnel (sans patient)
    else if (target_user_id) {
      const { data: account, error: accountError } = await supabase
        .from('profiles')
        .select('id, full_name, email, role, patient_category')
        .eq('id', target_user_id)
        .single();

      if (accountError || !account) {
        return res.status(404).json({ error: 'Compte non trouvé' });
      }

      const { data: links, error: linksError } = await supabase
        .from('patient_family_links')
        .select('patient_id')
        .eq('family_id', target_user_id)
        .limit(1);

      const hasPatient = links && links.length > 0;

      if (hasPatient) {
        return res.status(400).json({ 
          error: 'Ce compte a des patients. Veuillez choisir un patient spécifique ou utiliser target_type "account" pour planifier pour le compte lui-même.',
          hasPatient: true,
        });
      }

      finalPatientId = null;
      finalTargetType = 'personal';
      finalTargetName = account.full_name || 'Compte personnel';
      finalUserId = target_user_id;
      familyId = target_user_id;
    }

    // ✅ Cas 3: L'admin planifie pour un compte AVEC patients (planification personnelle)
    else if (target_type === 'account' && target_user_id) {
      const { data: account, error: accountError } = await supabase
        .from('profiles')
        .select('id, full_name, email, role, patient_category')
        .eq('id', target_user_id)
        .single();

      if (accountError || !account) {
        return res.status(404).json({ error: 'Compte non trouvé' });
      }

      finalPatientId = null;
      finalTargetType = 'personal';
      finalTargetName = `${account.full_name} (compte)`;
      finalUserId = target_user_id;
      familyId = target_user_id;
    }

    // ✅ Cas 4: Une famille crée pour elle-même
    else if (profile.role === 'family' && !patient_id) {
      finalPatientId = null;
      finalTargetType = 'personal';
      finalTargetName = profile.full_name || 'Personnel';
      finalUserId = user.id;
      familyId = user.id;
    }

    // ✅ Fallback
    else {
      finalPatientId = null;
      finalTargetType = 'personal';
      finalTargetName = profile.full_name || 'Utilisateur';
      finalUserId = user.id;
      familyId = user.id;
    }

    // ✅ VÉRIFICATION DES PERMISSIONS POUR LA FAMILLE
    if (profile.role === 'family' && patient_id) {
      const { data: link } = await supabase
        .from('patient_family_links')
        .select('patient_id')
        .eq('family_id', user.id)
        .eq('patient_id', patient_id)
        .maybeSingle();

      if (!link) {
        return res.status(403).json({ error: 'Vous n\'êtes pas lié à ce patient' });
      }
    }

    // ✅ VÉRIFICATION DU PAIEMENT REQUIS - Utilise le service
    const paymentCheck = await requiresPayment(
      finalUserId,
      is_ponctual,
      duration_minutes || 60
    );

    const requiresPayment = paymentCheck.requiresPayment;
    const status = paymentCheck.status;
    const paymentAmount = paymentCheck.amount;

    // ✅ DÉTERMINER L'AIDANT À ASSIGNER
    let finalAidantId = aidant_id || null;

    // Si un aidant_id est fourni, vérifier s'il s'agit d'un user_id ou aidant_id
    if (finalAidantId) {
      const convertedId = await getAidantIdFromUserIdOrId(finalAidantId);
      if (convertedId) {
        finalAidantId = convertedId;
        console.log(`🔄 Aidant fourni converti: ${aidant_id} → ${finalAidantId}`);
      }
    }

    // Si pas d'aidant fourni et pas de paiement requis, chercher automatiquement
    if (!finalAidantId && status !== VISIT_STATUS.DRAFT) {
      const targetTypeForAidant = finalPatientId ? 'patient' : 'personal_account';
      const targetIdForAidant = finalPatientId || finalUserId;
      
      let foundId = await getActiveAidantForTarget(
        targetTypeForAidant,
        targetIdForAidant,
        familyId
      );

      if (foundId) {
        const convertedId = await getAidantIdFromUserIdOrId(foundId);
        if (convertedId) {
          finalAidantId = convertedId;
          console.log(`✅ Aidant automatique trouvé pour la visite: ${finalAidantId}`);
        } else {
          console.log(`⚠️ L'aidant trouvé ${foundId} n'est pas valide`);
        }
      } else {
        console.log(`ℹ️ Aucun aidant actif trouvé pour la cible ${targetTypeForAidant}/${targetIdForAidant}`);
      }
    }

    // ✅ CRÉATION DE LA VISITE
    const visitData = {
      user_id: finalUserId,
      patient_id: finalPatientId,
      target_type: finalTargetType,
      target_name: finalTargetName,
      aidant_id: finalAidantId,
      coordinator_id: ['admin', 'coordinator'].includes(profile.role) ? user.id : null,
      scheduled_date,
      scheduled_time,
      duration_minutes: duration_minutes || 60,
      status: status,
      actions: [],
      notes: notes || null,
      is_urgent: is_urgent || false,
      visit_type: finalPatientId ? 'patient' : 'personal',
      assignment_type: assignment_type || 'ponctuelle',
      requested_by: user.id,
      is_draft: requiresPayment,
      requires_payment: requiresPayment,
      draft_expires_at: requiresPayment ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null,
      metadata: {
        created_by: user.id,
        created_at: new Date().toISOString(),
        is_ponctual: is_ponctual || requiresPayment,
        requires_payment: requiresPayment,
        is_draft: requiresPayment,
        payment_amount: requiresPayment ? paymentAmount : null,
        scheduled_from_draft: false,
        target_user_id: finalUserId,
        auto_assigned_aidant: !!finalAidantId && !aidant_id,
      }
    };

    console.log('📤 Création visite avec données:', {
      finalUserId,
      finalPatientId,
      finalTargetType,
      finalAidantId,
      status,
      requiresPayment,
      paymentAmount,
    });

    const { data: visit, error: insertError } = await supabase
      .from('visites')
      .insert(visitData)
      .select(`
        *,
        patient:patients(*),
        aidant:aidants(*, user:profiles(*))
      `)
      .single();

    if (insertError) {
      console.error('❌ Erreur insertion visite:', insertError);
      return res.status(500).json({ error: insertError.message });
    }

    const targetDisplay = finalTargetName || (visit.patient ? `${visit.patient.first_name} ${visit.patient.last_name}` : 'Personnel');

    // ✅ SI PAIEMENT REQUIS
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
          requires_payment: true,
        },
      });

      const { data: admins } = await supabase
        .from('profiles')
        .select('id')
        .in('role', ['admin', 'coordinator']);

      if (admins) {
        for (const admin of admins) {
          await createNotification({
            userId: admin.id,
            title: '📅 Visite créée en brouillon',
            body: `Visite pour ${targetDisplay} - En attente de paiement.`,
            type: 'system',
            data: { visit_id: visit.id, status: VISIT_STATUS.DRAFT },
          });
        }
      }

      return res.status(201).json({
        success: true,
        visit,
        requires_payment: true,
        payment_amount: paymentAmount,
        message: 'Visite créée en brouillon. Paiement requis pour la planifier.',
      });
    }

    // ✅ PAS DE PAIEMENT REQUIS
    await createNotification({
      userId: finalUserId,
      title: '📅 Nouvelle visite planifiée',
      body: `Une visite pour ${targetDisplay} a été planifiée le ${visit.scheduled_date} à ${visit.scheduled_time}.`,
      type: 'visite',
      data: { visit_id: visit.id, status: VISIT_STATUS.PLANNED },
    });

    if (finalAidantId) {
      await createNotification({
        userId: finalAidantId,
        title: '📅 Nouvelle visite à valider',
        body: `Visite pour ${targetDisplay} le ${visit.scheduled_date} à ${visit.scheduled_time}`,
        type: 'visite',
        data: { visit_id: visit.id, action: 'approve' },
      });
    }

    res.status(201).json({
      success: true,
      visit,
      requires_payment: false,
      auto_assigned_aidant: !!finalAidantId && !aidant_id,
    });
  } catch (error) {
    console.error('❌ Create visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ CONFIRMER PAIEMENT - BROUILLON → PLANIFIEE
// =============================================
router.post('/:id/confirm-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { transaction_id } = req.body;
    const userId = req.user.id;

    const updatedVisit = await confirmVisitPayment(id, transaction_id, userId);

    res.json({ 
      success: true, 
      visit: updatedVisit,
      message: 'Visite planifiée avec succès après paiement',
    });
  } catch (error) {
    console.error('❌ Confirm payment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ ANNULER UN BROUILLON
// =============================================
router.post('/:id/cancel-draft', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { reason } = req.body;

    const visit = await cancelDraftVisit(id, userId, reason);

    res.json({ 
      success: true, 
      visit,
      message: 'Brouillon annulé avec succès',
    });
  } catch (error) {
    console.error('❌ Cancel draft error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ OBTENIR LE PRIX D'UNE VISITE PONCTUELLE
// =============================================
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
    const price = getVisitPrice(duration);

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

// =============================================
// ✅ RÉCUPÉRER LES VISITES EN BROUILLON
// =============================================
router.get('/drafts/my', async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*),
        aidant:aidants(*, user:profiles(*))
      `)
      .eq('user_id', userId)
      .eq('status', VISIT_STATUS.DRAFT)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const visitsWithPrice = (data || []).map(visit => ({
      ...visit,
      payment_amount: getVisitPrice(visit.duration_minutes || 60),
    }));

    res.json(visitsWithPrice);
  } catch (error) {
    console.error('❌ Get drafts error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ CONVERTIR UN BROUILLON EN VISITE PLANIFIÉE (DÉCOMPTE ABONNEMENT)
// =============================================
router.post('/:id/convert-to-subscription', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // 1. Récupérer la visite
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

    if (visit.status !== VISIT_STATUS.DRAFT) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cette visite n\'est pas en attente de paiement' 
      });
    }

    // 2. Vérifier l'abonnement actif
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

    // 3. Récupérer l'aidant actif
    const familyId = visit.user_id;
    const targetType = visit.patient_id ? 'patient' : 'personal_account';
    const targetId = visit.patient_id || visit.user_id;

    let aidantId = visit.aidant_id || null;
    if (!aidantId) {
      aidantId = await getActiveAidantForTarget(targetType, targetId, familyId);
      console.log(`✅ Aidant trouvé pour la conversion: ${aidantId}`);
    }

    // 4. Mettre à jour la visite
    const { data: updatedVisit, error: updateError } = await supabase
      .from('visites')
      .update({
        status: VISIT_STATUS.PLANNED,
        aidant_id: aidantId || null,
        metadata: {
          ...(visit.metadata || {}),
          converted_from_draft: true,
          converted_at: new Date().toISOString(),
          subscription_id: subscription.id,
          subscription_used: true,
          payment_required: false,
          aidant_assigned_after_conversion: !!aidantId,
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

    // 5. Décompter de l'abonnement
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

    // 6. Notification de succès
    const targetDisplay = updatedVisit.target_name || (updatedVisit.patient ? 
      `${updatedVisit.patient.first_name} ${updatedVisit.patient.last_name}` : 'Personnel');

    await createNotification({
      userId: userId,
      title: '✅ Visite validée avec votre abonnement',
      body: `Visite du ${visit.scheduled_date} validée. Il vous reste ${newRemaining} visite(s).`,
      type: 'visite',
      data: { 
        visit_id: id, 
        status: VISIT_STATUS.PLANNED,
        remaining_visits: newRemaining,
      },
    });

    // 7. Notifier l'aidant si assigné
    if (updatedVisit.aidant_id) {
      await createNotification({
        userId: updatedVisit.aidant_id,
        title: '📅 Nouvelle visite à valider',
        body: `Visite pour ${targetDisplay} le ${updatedVisit.scheduled_date} à ${updatedVisit.scheduled_time}`,
        type: 'visite',
        data: { visit_id: id, action: 'approve' },
      });
    }

    // 8. Si plus de visites restantes, envoyer une alerte
    if (newRemaining === 0) {
      await createNotification({
        userId: userId,
        title: '📊 Plus de visites disponibles',
        body: 'Vous avez utilisé toutes vos visites. Pensez à renouveler votre abonnement.',
        type: 'system',
        data: { subscription_id: subscription.id },
      });
    }

    res.json({ 
      success: true, 
      visit: updatedVisit,
      remaining_visits: newRemaining,
      used_visits: newUsed,
      aidant_assigned: !!aidantId,
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

// =============================================
// APPROUVER UNE VISITE
// =============================================
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;

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

    if (visit.status !== VISIT_STATUS.PLANNED && visit.status !== VISIT_STATUS.PENDING) {
      return res.status(400).json({ error: 'Cette visite ne peut pas être approuvée' });
    }

    const { data, error } = await supabase
      .from('visites')
      .update({
        status: VISIT_STATUS.ACCEPTED,
        approved_by: user.id,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    const targetDisplay = visit.target_name || (visit.patient ? `${visit.patient.first_name} ${visit.patient.last_name}` : 'Personnel');

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
            body: `L'aidant a accepté la visite pour ${targetDisplay} le ${visit.scheduled_date}.`,
            type: 'visite',
            data: { visit_id: id, status: VISIT_STATUS.ACCEPTED },
          });
        }
      }
    } else {
      await createNotification({
        userId: visit.user_id,
        title: '✅ Visite acceptée',
        body: `L'aidant a accepté votre visite personnelle le ${visit.scheduled_date}.`,
        type: 'visite',
        data: { visit_id: id, status: VISIT_STATUS.ACCEPTED },
      });
    }

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Approve visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// REFUSER UNE VISITE
// =============================================
router.post('/:id/refuse', async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;
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
        status: VISIT_STATUS.REFUSED,
        refused_by: user.id,
        refused_at: new Date().toISOString(),
        refusal_reason: reason || 'Non spécifié',
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    const targetDisplay = visit.target_name || (visit.patient ? `${visit.patient.first_name} ${visit.patient.last_name}` : 'Personnel');

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
            body: `L'aidant a refusé la visite pour ${targetDisplay} le ${visit.scheduled_date}. Motif: ${reason || 'Non spécifié'}`,
            type: 'visite',
            data: { visit_id: id, status: VISIT_STATUS.REFUSED },
          });
        }
      }
    } else {
      await createNotification({
        userId: visit.user_id,
        title: '❌ Visite refusée',
        body: `L'aidant a refusé votre visite personnelle le ${visit.scheduled_date}. Motif: ${reason || 'Non spécifié'}`,
        type: 'visite',
        data: { visit_id: id, status: VISIT_STATUS.REFUSED },
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
          body: `L'aidant a refusé la visite pour ${targetDisplay} le ${visit.scheduled_date}.`,
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

// =============================================
// RÉASSIGNER UNE VISITE (admin)
// =============================================
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
        status: VISIT_STATUS.PLANNED,
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

    await createNotification({
      userId: finalAidantId,
      title: '📅 Nouvelle visite assignée',
      body: `Vous avez été assigné à une visite pour ${targetDisplay} le ${visit.scheduled_date} à ${visit.scheduled_time}.`,
      type: 'visite',
      data: { visit_id: id, action: 'approve' },
    });

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Reassign visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// DÉMARRER UNE VISITE
// =============================================
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

    if (visit.status !== VISIT_STATUS.ACCEPTED) {
      return res.status(400).json({ error: 'La visite doit être acceptée avant de démarrer' });
    }

    const updateData = {
      status: VISIT_STATUS.IN_PROGRESS,
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
        aidant:aidants(*, user:profiles(*))
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
            data: { visit_id: data.id, status: VISIT_STATUS.IN_PROGRESS },
          });
        }
      }
    } else {
      await createNotification({
        userId: data.user_id,
        title: '🔄 Visite en cours',
        body: `${data.aidant?.user?.full_name || 'L\'aidant'} a commencé votre visite personnelle.`,
        type: 'visite',
        data: { visit_id: data.id, status: VISIT_STATUS.IN_PROGRESS },
      });
    }

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Start visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// TERMINER UNE VISITE
// =============================================
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
      status: VISIT_STATUS.COMPLETED,
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
        aidant:aidants(*, user:profiles(*))
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
            data: { visit_id: data.id, status: VISIT_STATUS.COMPLETED },
          });
        }
      }
    } else {
      await createNotification({
        userId: data.user_id,
        title: '📋 Visite terminée - En attente de validation',
        body: `Votre visite personnelle est terminée. L'aidant a soumis son rapport.`,
        type: 'visite',
        data: { visit_id: data.id, status: VISIT_STATUS.COMPLETED },
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

// =============================================
// VALIDER UNE VISITE (avec décompte ou sans si payée)
// =============================================
router.post('/:id/validate', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { comment } = req.body;
    const now = new Date().toISOString();

    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('patient_id, aidant_id, metadata, user_id, target_type, target_name, status')
      .eq('id', id)
      .single();

    if (visitError) throw visitError;

    if (visit.status !== VISIT_STATUS.COMPLETED) {
      return res.status(400).json({ error: 'Seules les visites terminées peuvent être validées' });
    }

    const { data, error } = await supabase
      .from('visites')
      .update({
        status: VISIT_STATUS.VALIDATED,
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
        aidant:aidants(*, user:profiles(*))
      `)
      .single();

    if (error) throw error;

    // ✅ VÉRIFIER SI LA VISITE ÉTAIT PONCTUELLE (payée)
    const isPonctual = visit.metadata?.is_ponctual === true || visit.metadata?.is_draft === true;
    const wasPaid = visit.metadata?.payment_completed === true;

    // ✅ Si visite ponctuelle payée, NE PAS DÉCOMPTER DE L'ABONNEMENT
    if (!isPonctual || !wasPaid) {
      const { data: subscription, error: subError } = await supabase
        .from('abonnements')
        .select('id, remaining_visits, used_visits, total_visits, user_id')
        .eq('user_id', data.user_id)
        .eq('status', 'actif')
        .maybeSingle();

      if (subscription && !subError && subscription.remaining_visits > 0) {
        const { error: updateError } = await supabase
          .from('abonnements')
          .update({
            used_visits: subscription.used_visits + 1,
            remaining_visits: subscription.remaining_visits - 1,
            updated_at: new Date().toISOString(),
          })
          .eq('id', subscription.id);

        if (updateError) {
          console.error('❌ Erreur décompte visites:', updateError);
        } else {
          if (subscription.remaining_visits - 1 === 0) {
            await createNotification({
              userId: subscription.user_id,
              title: '⚠️ Plus de visites disponibles',
              body: 'Votre abonnement a atteint le nombre maximum de visites. Pensez à renouveler.',
              type: 'system',
              data: { subscription_id: subscription.id },
            });
          }

          await createNotification({
            userId: subscription.user_id,
            title: '📊 Visite décomptée',
            body: `Il vous reste ${subscription.remaining_visits - 1} visite(s) sur votre abonnement.`,
            type: 'system',
            data: { subscription_id: subscription.id, remaining: subscription.remaining_visits - 1 },
          });
        }
      }
    } else {
      console.log(`ℹ️ Visite ponctuelle payée - Pas de décompte d'abonnement pour la visite ${id}`);
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
            title: '✅ Visite validée',
            body: `La visite de ${targetDisplay} a été validée.`,
            type: 'visite',
            data: { visit_id: data.id, status: VISIT_STATUS.VALIDATED },
          });
        }
      }
    } else {
      await createNotification({
        userId: data.user_id,
        title: '✅ Visite validée',
        body: `Votre visite personnelle a été validée.`,
        type: 'visite',
        data: { visit_id: data.id, status: VISIT_STATUS.VALIDATED },
      });
    }

    if (data.aidant?.user_id) {
      await createNotification({
        userId: data.aidant.user_id,
        title: '✅ Visite validée',
        body: `La visite de ${targetDisplay} a été validée.`,
        type: 'visite',
        data: { visit_id: data.id, status: VISIT_STATUS.VALIDATED },
      });
    }

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('❌ Validate visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ANNULER UNE VISITE
// =============================================
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

    const isDraft = visit.status === VISIT_STATUS.DRAFT;

    const { data, error } = await supabase
      .from('visites')
      .update({
        status: VISIT_STATUS.CANCELLED,
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

// =============================================
// PHOTOS & AUDIOS
// =============================================
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

module.exports = router;
