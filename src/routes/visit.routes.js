// 📁 backend/src/routes/visit.routes.js

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
// 2️⃣ ROUTES AVEC LOGIQUE GENERIQUE (ROUTE COMMUNE '/')
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
    } = req.body;

    const canCreate = ['admin', 'coordinator'].includes(profile.role) || profile.role === 'family';
    if (!canCreate) {
      return res.status(403).json({ error: 'Non autorisé à créer une visite' });
    }

    let finalPatientId = null;
    let finalTargetType = 'personal';
    let finalTargetName = target_name || null;
    let finalUserId = null;
    let targetHasPatient = false;
    let familyId = null;

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
      targetHasPatient = true;
    }
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
      targetHasPatient = false;
    }
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
      targetHasPatient = false;
    }
    else if (profile.role === 'family' && !patient_id) {
      finalPatientId = null;
      finalTargetType = 'personal';
      finalTargetName = profile.full_name || 'Personnel';
      finalUserId = user.id;
      familyId = user.id;
      targetHasPatient = false;
    }
    else {
      finalPatientId = null;
      finalTargetType = 'personal';
      finalTargetName = profile.full_name || 'Utilisateur';
      finalUserId = user.id;
      familyId = user.id;
      targetHasPatient = false;
    }

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

    let requiresPayment = false;
    let status = 'planifiee';
    let paymentAmount = 0;
    let subscriptionId = null;

    const subscriptionCheck = await checkSubscriptionForVisits(finalUserId || user.id);
    console.log('📊 Vérification abonnement pour visite:', {
      userId: finalUserId || user.id,
      hasActiveSubscription: subscriptionCheck.hasActiveSubscription,
      remainingVisits: subscriptionCheck.remainingVisits,
    });

    if (is_ponctual) {
      requiresPayment = true;
      status = 'brouillon';
      paymentAmount = getPonctualPrice(duration_minutes);
      console.log('⚡ Visite ponctuelle explicitement demandée');
      
    } else if (subscriptionCheck.hasActiveSubscription && subscriptionCheck.remainingVisits > 0) {
      status = 'planifiee';
      requiresPayment = false;
      subscriptionId = subscriptionCheck.subscription?.id || null;
      console.log('✅ Visite avec abonnement - décompte à la validation');
      
    } else if (subscriptionCheck.hasActiveSubscription && subscriptionCheck.remainingVisits === 0) {
      requiresPayment = true;
      status = 'brouillon';
      paymentAmount = getPonctualPrice(duration_minutes);
      console.log('⚠️ Abonnement actif mais plus de visites - mode ponctuel');
      
    } else {
      requiresPayment = true;
      status = 'brouillon';
      paymentAmount = getPonctualPrice(duration_minutes);
      console.log('❌ Pas d\'abonnement - mode ponctuel');
    }

    let finalAidantId = aidant_id || null;

    if (finalAidantId) {
      const convertedId = await getAidantIdFromUserIdOrId(finalAidantId);
      if (convertedId) {
        finalAidantId = convertedId;
        console.log(`🔄 Aidant fourni converti: ${aidant_id} → ${finalAidantId}`);
      }
    }

    if (!finalAidantId && status !== 'brouillon') {
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
        }
      } else {
        console.log('🔍 Aucun aidant assigné, utilisation du wizard...');
        
        const wizardOptions = await getVisitWizardOptions(
          targetTypeForAidant,
          targetIdForAidant,
          familyId
        );

        if (profile.role === 'family' && wizardOptions.allFull) {
          if (wizard_choice === 'without_aidant') {
            status = 'en_attente_aidant';
            finalAidantId = null;
            console.log('📋 Visite planifiée SANS aidant - en attente');
            
            const { data: admins } = await supabase
              .from('profiles')
              .select('id')
              .in('role', ['admin', 'coordinator']);

            if (admins && admins.length > 0) {
              const targetDisplay2 = finalTargetName || 'Patient';
              for (const admin of admins) {
                await createNotification({
                  userId: admin.id,
                  title: '🚨 Visite planifiée sans aidant disponible !',
                  body: `Visite pour ${targetDisplay2} le ${scheduled_date} à ${scheduled_time}. Tous les aidants sont complets (4/4).`,
                  type: 'alert',
                  data: { 
                    visit_id: null,
                    action: 'assign_aidant',
                    urgency: 'high',
                    target_name: targetDisplay2,
                    scheduled_date,
                    scheduled_time,
                  },
                });
              }
            }

            await createNotification({
              userId: finalUserId,
              title: '⏳ Visite en attente d\'aidant',
              body: `Votre visite pour ${finalTargetName || 'le patient'} est en attente d'assignation d'un aidant. L'administration a été notifiée.`,
              type: 'visite',
              data: { 
                status: 'en_attente_aidant',
                target_name: finalTargetName,
              },
            });

          } else {
            return res.status(400).json({
              success: false,
              error: 'Tous les aidants sont complets (4/4). Utilisez l\'option "Planifier sans aidant" ou contactez l\'administration.',
              code: 'ALL_AIDANTS_FULL',
              allFull: true,
            });
          }
        } 
        else if (profile.role === 'family' && wizardOptions.hasAvailableAidants) {
          if (selected_aidant_id && wizard_choice) {
            const selectedAidantId = await getAidantIdFromUserIdOrId(selected_aidant_id);
            if (selectedAidantId) {
              if (wizard_choice === 'ponctuelle') {
                finalAidantId = selectedAidantId;
                console.log('⚡ Visite ponctuelle assignée à l\'aidant:', finalAidantId);
              } else if (wizard_choice === 'permanente') {
                const quotaCheck = await isAidantFull(selected_aidant_id);
                if (quotaCheck.isFull) {
                  return res.status(400).json({
                    success: false,
                    error: `Cet aidant a déjà ${quotaCheck.current}/${quotaCheck.max} assignations. Choisissez un autre aidant ou passez en mode ponctuel.`,
                    code: 'AIDANT_FULL',
                    current: quotaCheck.current,
                    max: quotaCheck.max,
                  });
                }
                finalAidantId = selectedAidantId;
                
                // TODO: Implémenter assignAidantToTarget si requis côté backend
                console.log('📌 Assignation permanente simulée pour l\'aidant:', finalAidantId);
              }
            } else {
              return res.status(400).json({
                success: false,
                error: 'Aidant sélectionné invalide',
                code: 'INVALID_AIDANT',
              });
            }
          } else {
            return res.status(400).json({
              success: false,
              error: 'Veuillez sélectionner un aidant et un type d\'assignation',
              code: 'WIZARD_REQUIRED',
              wizard: {
                options: wizardOptions.options,
                aidants: wizardOptions.aidants,
                allFull: false,
              },
            });
          }
        }
        else if (['admin', 'coordinator'].includes(profile.role)) {
          if (selected_aidant_id && wizard_choice) {
            const selectedAidantId = await getAidantIdFromUserIdOrId(selected_aidant_id);
            if (selectedAidantId) {
              finalAidantId = selectedAidantId;
              console.log('👔 Admin: Assignation via wizard pour l\'aidant:', finalAidantId);
            }
          } else {
            const allAidants = await getAvailableAidantsForFamily(familyId);
            return res.status(400).json({
              success: false,
              error: 'Veuillez sélectionner un aidant',
              code: 'WIZARD_REQUIRED',
              wizard: {
                options: [
                  { type: 'ponctuelle', label: '⚡ Pour cette visite uniquement', quota: 0 },
                  { type: 'permanente', label: '📌 Permanent', quota: 1 },
                  { type: 'force', label: '👔 Force (dépasse quota)', quota: 'illimité' },
                ],
                aidants: allAidants,
                allFull: false,
                isAdmin: true,
              },
            });
          }
        }
      }
    }
 
    
    const visitData = {
      user_id: finalUserId,
      patient_id: finalPatientId,
      
       target_type: finalTargetType, // déjà 'patient' ou 'personal'
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
      
       visit_type: is_ponctual || requiresPayment ? 'ponctuelle' : 'permanente',
      
       assignment_type: assignment_type || 'ponctuelle',
      
      requested_by: user.id,
      draft_expires_at: requiresPayment ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null,
      subscription_id: subscriptionId,
      
      // ✅ is_permanent : booléen pour les visites permanentes
      is_permanent: wizard_choice === 'permanente',
      
      assigned_by_admin: ['admin', 'coordinator'].includes(profile.role),
      admin_assigned_at: ['admin', 'coordinator'].includes(profile.role) ? new Date().toISOString() : null,
      waiting_for_aidant_since: status === 'en_attente_aidant' ? new Date().toISOString() : null,
      
      metadata: {
        created_by: user.id,
        created_at: new Date().toISOString(),
        is_ponctual: is_ponctual || requiresPayment,
        requires_payment: requiresPayment,
        is_draft: requiresPayment,
        payment_amount: requiresPayment ? paymentAmount : null,
        scheduled_from_draft: false,
        target_user_id: finalUserId,
        target_has_patient: targetHasPatient,
        auto_assigned_aidant: !!finalAidantId && !aidant_id && !selected_aidant_id,
        subscription_used: subscriptionId ? true : false,
        ponctual_mode: requiresPayment ? true : false,
        wizard_choice: wizard_choice || null,
        waiting_for_aidant: status === 'en_attente_aidant',
        assigned_by_admin: ['admin', 'coordinator'].includes(profile.role),
         is_personal_account: finalTargetType === 'personal' && !finalPatientId,
        target_patient_id: finalPatientId,
      }
    };

    console.log('📤 Création visite avec données:', {
      finalUserId,
      finalPatientId,
      finalTargetType,
      finalAidantId,
      status,
      requiresPayment,
      subscriptionId,
      wizard_choice,
    });

    const { data: visit, error: insertError } = await supabase
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

    if (insertError) {
      console.error('❌ Erreur insertion visite:', insertError);
      return res.status(500).json({ error: insertError.message });
    }

    if (status === 'en_attente_aidant') {
      const { data: admins } = await supabase
        .from('profiles')
        .select('id')
        .in('role', ['admin', 'coordinator']);

      if (admins && admins.length > 0) {
        for (const admin of admins) {
          await createNotification({
            userId: admin.id,
            title: '🚨 Visite planifiée sans aidant disponible !',
            body: `Visite pour ${finalTargetName || 'Patient'} le ${scheduled_date} à ${scheduled_time}. Tous les aidants sont complets.`,
            type: 'alert',
            data: { 
              visit_id: visit.id,
              action: 'assign_aidant',
              urgency: 'high',
              target_name: finalTargetName || 'Patient',
              scheduled_date,
              scheduled_time,
            },
          });
        }
      }
    }

    const targetDisplay = finalTargetName || (visit.patient ? `${visit.patient.first_name} ${visit.patient.last_name}` : 'Personnel');

    if (requiresPayment) {
      await createNotification({
        userId: finalUserId,
        title: '💳 Paiement requis pour planifier la visite',
        body: `Un paiement de ${paymentAmount} FCFA est requis pour planifier la visite de ${targetDisplay}.`,
        type: 'visite',
        data: { 
          visit_id: visit.id, 
          status: 'brouillon', 
          action: 'pay',
          amount: paymentAmount,
          requires_payment: true,
        },
      });

      return res.status(201).json({
        success: true,
        visit,
        requires_payment: true,
        payment_amount: paymentAmount,
        message: 'Visite créée en brouillon. Paiement requis pour la planifier.',
      });
    }

    if (status === 'en_attente_aidant') {
      return res.status(201).json({
        success: true,
        visit,
        requires_payment: false,
        waiting_for_aidant: true,
        message: 'Visite créée en attente d\'aidant. L\'administration a été notifiée.',
      });
    }

    await createNotification({
      userId: finalUserId,
      title: '📅 Nouvelle visite planifiée',
      body: `Une visite pour ${targetDisplay} a été planifiée le ${visit.scheduled_date} à ${visit.scheduled_time}.`,
      type: 'visite',
      data: { visit_id: visit.id, status: 'planifiee' },
    });

    // ✅ CORRECTION : Utiliser le user_id de l'aidant pour l'enregistrement (sinon viol de FK sur "notifications")
    if (finalAidantId && visit.aidant?.user_id) {
      await createNotification({
        userId: visit.aidant.user_id, // ✅ ID utilisateur (profiles.id) à la place de l'aidant_id
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
      auto_assigned_aidant: !!finalAidantId && !aidant_id && !selected_aidant_id,
      subscription_used: !!subscriptionId,
      waiting_for_aidant: status === 'en_attente_aidant',
      wizard_choice: wizard_choice || null,
    });
  } catch (error) {
    console.error('❌ Create visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ DÉTAILS D'UNE VISITE (DÉPLACÉ ICI : DYNAMIQUE)
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

// =============================================
// ✅ ADMIN ASSIGNER UN AIDANT À UNE VISITE
// =============================================
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

// =============================================
// ✅ CONFIRMER PAIEMENT - BROUILLON → PLANIFIEE
// =============================================
 
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

    // ✅ CORRECTION : Récupérer l'aidant depuis aidant_id OU metadata.selected_aidant
    let aidantId = visit.aidant_id || visit.metadata?.selected_aidant || null;

    // ✅ Si un aidant est trouvé dans metadata.selected_aidant, le convertir
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

    const { data: updatedVisit, error: updateError } = await supabase
      .from('visites')
      .update({
        status: 'planifiee',
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

    // ✅ CORRECTION : Utiliser updatedVisit.aidant.user_id (profiles.id) à la place de aidantId
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

// =============================================
// ✅ APPROUVER UNE VISITE
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
            data: { visit_id: id, status: 'acceptee' },
          });
        }
      }
    } else {
      await createNotification({
        userId: visit.user_id,
        title: '✅ Visite acceptée',
        body: `L'aidant a accepté votre visite personnelle le ${visit.scheduled_date}.`,
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

// =============================================
// ✅ REFUSER UNE VISITE
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
            data: { visit_id: id, status: 'refusee' },
          });
        }
      }
    } else {
      await createNotification({
        userId: visit.user_id,
        title: '❌ Visite refusée',
        body: `L'aidant a refusé votre visite personnelle le ${visit.scheduled_date}. Motif: ${reason || 'Non spécifié'}`,
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

    // ✅ CORRECTION : Récupérer le user_id de l'aidant dans la table "aidants" avant de l'enregistrer (sinon viol de FK sur "notifications")
    const { data: aidantProfile } = await supabase
      .from('aidants')
      .select('user_id')
      .eq('id', finalAidantId)
      .maybeSingle();

    if (aidantProfile?.user_id) {
      await createNotification({
        userId: aidantProfile.user_id, // ✅ ID utilisateur (profiles.id) à la place de finalAidantId
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

// =============================================
// ✅ DÉMARRER UNE VISITE
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

// =============================================
// ✅ TERMINER UNE VISITE
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

// =============================================
// ✅ VALIDER UNE VISITE (avec décompte ou sans si payée)
// =============================================
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

    const isPonctual = visit.metadata?.is_ponctual === true || visit.metadata?.ponctual_mode === true;
    const wasPaid = visit.metadata?.payment_completed === true;

    if (!isPonctual || !wasPaid) {
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

// =============================================
// ✅ CONVERTIR UN BROUILLON EN VISITE PLANIFIÉE (DÉCOMPTE ABONNEMENT)
// =============================================
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
