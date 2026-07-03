// 📁 backend/src/controllers/visit.controller.js

const { supabase } = require('../services/supabase.service');
const { asyncWrapper, NotFoundError, ValidationError } = require('../utils/errorHandler');
const { createNotification } = require('../services/notification.service');
const { requiresPayment, confirmVisitPayment, cancelDraftVisit } = require('../services/visitPayment.service');

// ============================================================
// RÉCUPÉRER TOUTES LES VISITES
// ============================================================
const getVisits = asyncWrapper(async (req, res) => {
  const userId = req.user.id;
  const userRole = req.profile?.role;

  let query = supabase.from('visites').select('*');

  if (userRole === 'family') {
    const { data: links } = await supabase
      .from('patient_family_links')
      .select('patient_id')
      .eq('family_id', userId);

    const patientIds = links?.map(l => l.patient_id) || [];
    if (patientIds.length > 0) {
      query = query.or(`patient_id.in.(${patientIds.join(',')}), user_id.eq.${userId}`);
    } else {
      query = query.eq('user_id', userId);
    }
  } else if (userRole === 'aidant') {
    const { data: aidant } = await supabase
      .from('aidants')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (aidant) {
      query = query.eq('aidant_id', aidant.id);
    } else {
      return res.json({ success: true, data: [], count: 0 });
    }
  }

  const { data, error } = await query.order('scheduled_date', { ascending: true });
  if (error) throw error;

  res.json({ success: true, data: data || [], count: data?.length || 0 });
});

// ============================================================
// RÉCUPÉRER UNE VISITE PAR ID
// ============================================================
const getVisitById = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const userRole = req.profile?.role;

  const { data: visit, error } = await supabase
    .from('visites')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !visit) {
    throw new NotFoundError('Visite');
  }

  // ✅ Vérifier l'accès
  let hasAccess = ['admin', 'coordinator'].includes(userRole);

  if (!hasAccess && userRole === 'family') {
    hasAccess = visit.user_id === userId;
    if (!hasAccess && visit.patient_id) {
      const { data: link } = await supabase
        .from('patient_family_links')
        .select('id')
        .eq('family_id', userId)
        .eq('patient_id', visit.patient_id)
        .maybeSingle();
      hasAccess = !!link;
    }
  }

  if (!hasAccess && userRole === 'aidant') {
    const { data: aidant } = await supabase
      .from('aidants')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (aidant) {
      hasAccess = visit.aidant_id === aidant.id;
    }
  }

  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      error: 'Accès non autorisé à cette visite',
    });
  }

  res.json({ success: true, data: visit });
});

// ============================================================
// CRÉER UNE VISITE
// ============================================================
const createVisit = asyncWrapper(async (req, res) => {
  const userId = req.user.id;
  const userRole = req.profile?.role;

  if (userRole === 'aidant') {
    return res.status(403).json({
      success: false,
      error: 'Les aidants ne peuvent pas créer de visites',
    });
  }

  const {
    patient_id,
    target_type = patient_id ? 'patient' : 'personal',
    target_name,
    target_user_id,
    scheduled_date,
    scheduled_time,
    duration_minutes = 60,
    notes,
    is_urgent = false,
    visit_type = 'ponctuelle',
    assignment_type = 'ponctuelle',
  } = req.body;

  // ✅ Vérifier le paiement requis
  const isPonctual = visit_type === 'ponctuelle';
  const paymentCheck = await requiresPayment(
    target_user_id || userId,
    isPonctual,
    duration_minutes
  );

  const visitData = {
    user_id: target_user_id || userId,
    patient_id: patient_id || null,
    target_type: target_type,
    target_name: target_name || null,
    scheduled_date,
    scheduled_time,
    duration_minutes: duration_minutes || 60,
    status: paymentCheck.status,
    is_urgent: is_urgent || false,
    notes: notes || null,
    actions: [],
    visit_type: visit_type || 'ponctuelle',
    assignment_type: assignment_type || 'ponctuelle',
    is_draft: paymentCheck.requiresPayment,
    requires_payment: paymentCheck.requiresPayment,
    draft_expires_at: paymentCheck.requiresPayment 
      ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      : null,
    metadata: {
      created_by: userId,
      payment_amount: paymentCheck.requiresPayment ? paymentCheck.amount : null,
      requires_payment: paymentCheck.requiresPayment,
      is_ponctual: isPonctual || paymentCheck.requiresPayment,
    },
  };

  const { data: visit, error } = await supabase
    .from('visites')
    .insert(visitData)
    .select()
    .single();

  if (error) throw error;

  // ✅ Notification si paiement requis
  if (paymentCheck.requiresPayment) {
    await createNotification({
      userId: target_user_id || userId,
      title: '💳 Paiement requis pour planifier la visite',
      body: `Un paiement de ${paymentCheck.amount} FCFA est requis pour planifier la visite.`,
      type: 'visite',
      data: { visit_id: visit.id, action: 'pay', amount: paymentCheck.amount },
    });
  }

  res.status(201).json({
    success: true,
    message: paymentCheck.requiresPayment 
      ? 'Visite créée. Paiement requis pour la planifier.'
      : 'Visite planifiée avec succès',
    data: visit,
    requires_payment: paymentCheck.requiresPayment,
    payment_amount: paymentCheck.requiresPayment ? paymentCheck.amount : null,
  });
});

// ============================================================
// METTRE À JOUR UNE VISITE
// ============================================================
const updateVisit = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userRole = req.profile?.role;

  if (!['admin', 'coordinator'].includes(userRole)) {
    return res.status(403).json({
      success: false,
      error: 'Non autorisé',
    });
  }

  const { data, error } = await supabase
    .from('visites')
    .update({
      ...req.body,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  res.json({ success: true, data });
});

// ============================================================
// APPOUVER UNE VISITE
// ============================================================
const approveVisit = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const { data: visit, error: fetchError } = await supabase
    .from('visites')
    .select('aidant_id, patient_id, user_id')
    .eq('id', id)
    .single();

  if (fetchError || !visit) {
    throw new NotFoundError('Visite');
  }

  // ✅ Vérifier que l'aidant est assigné
  const { data: aidant } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!aidant || visit.aidant_id !== aidant.id) {
    return res.status(403).json({
      success: false,
      error: 'Vous n\'êtes pas assigné à cette visite',
    });
  }

  const { data, error } = await supabase
    .from('visites')
    .update({
      status: 'acceptee',
      approved_by: userId,
      approved_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  // ✅ Notification à la famille
  await createNotification({
    userId: visit.user_id,
    title: '✅ Visite acceptée',
    body: 'L\'aidant a accepté la visite.',
    type: 'visite',
    data: { visit_id: id },
  });

  res.json({ success: true, data });
});

// ============================================================
// REFUSER UNE VISITE
// ============================================================
const refuseVisit = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const userId = req.user.id;

  const { data: visit, error: fetchError } = await supabase
    .from('visites')
    .select('aidant_id, user_id')
    .eq('id', id)
    .single();

  if (fetchError || !visit) {
    throw new NotFoundError('Visite');
  }

  const { data: aidant } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!aidant || visit.aidant_id !== aidant.id) {
    return res.status(403).json({
      success: false,
      error: 'Vous n\'êtes pas assigné à cette visite',
    });
  }

  const { data, error } = await supabase
    .from('visites')
    .update({
      status: 'refusee',
      refused_by: userId,
      refused_at: new Date().toISOString(),
      refusal_reason: reason || 'Non spécifié',
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  await createNotification({
    userId: visit.user_id,
    title: '❌ Visite refusée',
    body: `L'aidant a refusé la visite. Motif : ${reason || 'Non spécifié'}`,
    type: 'visite',
    data: { visit_id: id },
  });

  res.json({ success: true, data });
});

// ============================================================
// DÉMARRER UNE VISITE
// ============================================================
const startVisit = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const { data: visit, error: fetchError } = await supabase
    .from('visites')
    .select('aidant_id')
    .eq('id', id)
    .single();

  if (fetchError || !visit) {
    throw new NotFoundError('Visite');
  }

  const { data: aidant } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!aidant || visit.aidant_id !== aidant.id) {
    return res.status(403).json({
      success: false,
      error: 'Vous n\'êtes pas assigné à cette visite',
    });
  }

  const { data, error } = await supabase
    .from('visites')
    .update({
      status: 'en_cours',
      start_time: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  res.json({ success: true, data });
});

// ============================================================
// TERMINER UNE VISITE
// ============================================================
const completeVisit = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const { actions, notes, photos } = req.body;
  const userId = req.user.id;

  const { data: visit, error: fetchError } = await supabase
    .from('visites')
    .select('aidant_id')
    .eq('id', id)
    .single();

  if (fetchError || !visit) {
    throw new NotFoundError('Visite');
  }

  const { data: aidant } = await supabase
    .from('aidants')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!aidant || visit.aidant_id !== aidant.id) {
    return res.status(403).json({
      success: false,
      error: 'Vous n\'êtes pas assigné à cette visite',
    });
  }

  const { data, error } = await supabase
    .from('visites')
    .update({
      status: 'terminee',
      end_time: new Date().toISOString(),
      actions: actions || [],
      notes: notes || null,
      report: notes || null,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  res.json({ success: true, data });
});

// ============================================================
// VALIDER UNE VISITE
// ============================================================
const validateVisit = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userRole = req.profile?.role;

  if (!['admin', 'coordinator'].includes(userRole)) {
    return res.status(403).json({
      success: false,
      error: 'Non autorisé',
    });
  }

  const { data: visit, error: fetchError } = await supabase
    .from('visites')
    .select('user_id, status, metadata')
    .eq('id', id)
    .single();

  if (fetchError || !visit) {
    throw new NotFoundError('Visite');
  }

  if (visit.status !== 'terminee') {
    return res.status(400).json({
      success: false,
      error: 'Seules les visites terminées peuvent être validées',
    });
  }

  const { data, error } = await supabase
    .from('visites')
    .update({
      status: 'validee',
      metadata: {
        ...(visit.metadata || {}),
        validated_by: req.user.id,
        validated_at: new Date().toISOString(),
      },
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  // ✅ Décompter la visite de l'abonnement (sauf si ponctuelle payée)
  const isPonctual = visit.metadata?.is_ponctual === true;
  const wasPaid = visit.metadata?.payment_completed === true;

  if (!isPonctual || !wasPaid) {
    const { data: subscription } = await supabase
      .from('abonnements')
      .select('id, remaining_visits, used_visits')
      .eq('user_id', visit.user_id)
      .eq('status', 'actif')
      .maybeSingle();

    if (subscription && subscription.remaining_visits > 0) {
      await supabase
        .from('abonnements')
        .update({
          used_visits: subscription.used_visits + 1,
          remaining_visits: subscription.remaining_visits - 1,
        })
        .eq('id', subscription.id);
    }
  }

  res.json({ success: true, data });
});

// ============================================================
// ANNULER UNE VISITE
// ============================================================
const cancelVisit = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const userRole = req.profile?.role;

  const { data: visit, error: fetchError } = await supabase
    .from('visites')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !visit) {
    throw new NotFoundError('Visite');
  }

  // ✅ Vérifier les permissions
  let hasAccess = ['admin', 'coordinator'].includes(userRole);

  if (!hasAccess && userRole === 'family') {
    hasAccess = visit.user_id === userId;
  }

  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      error: 'Non autorisé à annuler cette visite',
    });
  }

  const { data, error } = await supabase
    .from('visites')
    .update({
      status: 'annulee',
      metadata: {
        ...(visit.metadata || {}),
        cancelled_by: userId,
        cancelled_at: new Date().toISOString(),
      },
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  res.json({ success: true, data });
});

// ============================================================
// RÉASSIGNER UNE VISITE
// ============================================================
const reassignVisit = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const { aidant_id, assignment_type = 'ponctuelle' } = req.body;
  const userRole = req.profile?.role;

  if (!['admin', 'coordinator'].includes(userRole)) {
    return res.status(403).json({
      success: false,
      error: 'Non autorisé',
    });
  }

  const { data, error } = await supabase
    .from('visites')
    .update({
      aidant_id,
      status: 'planifiee',
      assignment_type: assignment_type || 'ponctuelle',
      assigned_by: req.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  // ✅ Notification à l'aidant
  await createNotification({
    userId: aidant_id,
    title: '📅 Nouvelle visite assignée',
    body: 'Une nouvelle visite vous a été assignée.',
    type: 'visite',
    data: { visit_id: id, action: 'approve' },
  });

  res.json({ success: true, data });
});

// ============================================================
// CONFIRMER PAIEMENT D'UNE VISITE
// ============================================================
const confirmPayment = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const { transaction_id } = req.body;
  const userId = req.user.id;

  if (!transaction_id) {
    throw new ValidationError('transaction_id requis');
  }

  const visit = await confirmVisitPayment(id, transaction_id, userId);

  res.json({
    success: true,
    message: 'Paiement confirmé, visite planifiée',
    data: visit,
  });
});

// ============================================================
// ANNULER UN BROUILLON
// ============================================================
const cancelDraft = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const userId = req.user.id;

  const visit = await cancelDraftVisit(id, userId, reason);

  res.json({
    success: true,
    message: 'Brouillon annulé',
    data: visit,
  });
});

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getVisits,
  getVisitById,
  createVisit,
  updateVisit,
  approveVisit,
  refuseVisit,
  startVisit,
  completeVisit,
  validateVisit,
  cancelVisit,
  reassignVisit,
  confirmPayment,
  cancelDraft,
};
