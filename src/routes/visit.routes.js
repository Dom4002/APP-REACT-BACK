// 📁 backend/src/routes/visit.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const roleMiddleware = require('../middleware/role.middleware');
const { createNotification } = require('../services/notification.service');

router.use(authMiddleware);

// =============================================
// CONSTANTES
// =============================================
const VISIT_PONCTUAL_PRICES = {
  '30': 5000,   // 30 min
  '45': 6000,   // 45 min
  '60': 7500,   // 1 heure
  '90': 10000,  // 1h30
  '120': 12500, // 2 heures
};

const DEFAULT_VISIT_PRICE = 7500;

/**
 * Calcule le prix d'une visite ponctuelle en fonction de la durée
 */
const getPonctualPrice = (durationMinutes) => {
  const duration = durationMinutes || 60;
  const price = VISIT_PONCTUAL_PRICES[duration.toString()];
  if (price) return price;
  // Si durée non standard, calcul proportionnel
  return Math.round((duration / 60) * DEFAULT_VISIT_PRICE);
};

// =============================================
// LISTE DES VISITES
// =============================================
router.get('/', async (req, res) => {
  try {
    const { user, profile } = req;

    let query = supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*),
        aidant:aidants(*, user:profiles(*)),
        coordinator:profiles!coordinator_id(*),
        photos:visite_photos(*)
      `);

    if (profile.role === 'family') {
      // ✅ Récupérer les patients liés à la famille
      const { data: links } = await supabase
        .from('patient_family_links')
        .select('patient_id')
        .eq('family_id', user.id);

      const patientIds = links?.map(l => l.patient_id).filter(Boolean) || [];
      
      // ✅ Ajouter les visites personnelles (sans patient)
      query = query.or(`patient_id.in.(${patientIds.length ? patientIds.join(',') : 'null'}), user_id.eq.${user.id}, patient_id.is.null`);
      
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

    const { data, error } = await query.order('scheduled_date', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Get visits error:', error);
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

    const { data, error } = await supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*),
        aidant:aidants(*, user:profiles(*)),
        coordinator:profiles!coordinator_id(*),
        photos:visite_photos(*)
      `)
      .eq('id', id)
      .single();

    if (error) throw error;

    // ✅ Vérification d'accès
    let hasAccess = false;

    if (['admin', 'coordinator'].includes(profile.role)) {
      hasAccess = true;
    } else if (profile.role === 'family') {
      // ✅ La famille peut voir les visites personnelles ET les visites des patients
      if (data.user_id === user.id) {
        hasAccess = true;
      } else if (data.patient_id) {
        const { data: links } = await supabase
          .from('patient_family_links')
          .select('patient_id')
          .eq('family_id', user.id)
          .eq('patient_id', data.patient_id);

        hasAccess = links && links.length > 0;
      }
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();

      hasAccess = data.aidant_id === aidant?.id;
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    res.json(data);
  } catch (error) {
    console.error('Get visit detail error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ CRÉER UNE VISITE - AVEC GESTION DU PAIEMENT
// =============================================
router.post('/', async (req, res) => {
  try {
    const { user, profile } = req;
    const { 
      patient_id,
      target_type,          // ✅ 'personal' | 'patient'
      target_name,          // ✅ Nom à afficher pour l'aidant
      scheduled_date,
      scheduled_time,
      duration_minutes,
      notes,
      is_urgent,
      is_ponctual = false,
      assignment_type = 'ponctuelle',
      aidant_id = null
    } = req.body;

    // ✅ Vérifier les permissions
    const canCreate = ['admin', 'coordinator'].includes(profile.role) || profile.role === 'family';
    if (!canCreate) {
      return res.status(403).json({ error: 'Non autorisé à créer une visite' });
    }

    // ✅ Déterminer target_type et target_name
    const finalTargetType = target_type || (patient_id ? 'patient' : 'personal');
    const finalTargetName = target_name || (patient_id ? null : profile.full_name);

    // ✅ Si c'est une famille et patient_id fourni, vérifier le lien
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

    // =============================================
    // ✅ ÉTAPE 1 : VÉRIFIER SI PAIEMENT REQUIS
    // =============================================
    let requiresPayment = false;
    let status = 'planifiee';
    let paymentAmount = 0;

    // ✅ Si visite explicitement ponctuelle
    if (is_ponctual) {
      requiresPayment = true;
      status = 'brouillon';
      paymentAmount = getPonctualPrice(duration_minutes);
    } else {
      // ✅ Vérifier l'abonnement sur le COMPTE (user_id)
      const { data: subscription, error: subError } = await supabase
        .from('abonnements')
        .select('id, remaining_visits, status')
        .eq('user_id', user.id)
        .eq('status', 'actif')
        .maybeSingle();

      if (subError) {
        console.error('❌ Erreur vérification abonnement:', subError);
      }

      // ✅ Si pas d'abonnement actif ou plus de visites
      if (!subscription || subscription.remaining_visits <= 0) {
        requiresPayment = true;
        status = 'brouillon';
        paymentAmount = getPonctualPrice(duration_minutes);
      }
    }

    // =============================================
    // ✅ ÉTAPE 2 : CRÉER LA VISITE
    // =============================================
    const visitData = {
      user_id: user.id,
      patient_id: patient_id || null,
      target_type: finalTargetType,
      target_name: finalTargetName,
      aidant_id: aidant_id || null,
      coordinator_id: ['admin', 'coordinator'].includes(profile.role) ? user.id : null,
      scheduled_date,
      scheduled_time,
      duration_minutes: duration_minutes || 60,
      status: status, // ✅ 'brouillon' ou 'planifiee'
      actions: [],
      notes: notes || null,
      is_urgent: is_urgent || false,
      visit_type: patient_id ? 'patient' : 'personal',
      assignment_type: assignment_type || 'ponctuelle',
      requested_by: user.id,
      metadata: {
        created_by: user.id,
        created_at: new Date().toISOString(),
        is_ponctual: is_ponctual || requiresPayment,
        requires_payment: requiresPayment,
        is_draft: requiresPayment,
        payment_amount: requiresPayment ? paymentAmount : null,
        scheduled_from_draft: false,
      }
    };

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

    // =============================================
    // ✅ ÉTAPE 3 : NOTIFICATIONS SELON LE STATUT
    // =============================================
    const targetDisplay = finalTargetName || (visit.patient ? `${visit.patient.first_name} ${visit.patient.last_name}` : 'Personnel');

    // ✅ Notification à la famille
    if (requiresPayment) {
      // ✅ Visite en brouillon - Paiement requis
      await createNotification({
        userId: user.id,
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

      // ✅ Retourner avec requires_payment: true pour déclencher le modal
      return res.status(201).json({
        success: true,
        visit,
        requires_payment: true,
        payment_amount: paymentAmount,
        message: 'Visite créée en brouillon. Paiement requis pour la planifier.',
      });
    }

    // ✅ Pas de paiement requis - Visite planifiée directement
    // Notification à la famille
    await createNotification({
      userId: user.id,
      title: '📅 Nouvelle visite planifiée',
      body: `Visite pour ${targetDisplay} le ${visit.scheduled_date} à ${visit.scheduled_time}`,
      type: 'visite',
      data: { visit_id: visit.id, status: 'planifiee' },
    });

    // ✅ Notification à l'aidant assigné
    if (aidant_id) {
      await createNotification({
        userId: aidant_id,
        title: '📅 Nouvelle visite à valider',
        body: `Visite pour ${targetDisplay} le ${visit.scheduled_date} à ${visit.scheduled_time}`,
        type: 'visite',
        data: { visit_id: visit.id, action: 'approve' },
      });
    }

    // ✅ Notification aux admins/coords (pour info)
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (admins && admins.length > 0) {
      for (const admin of admins) {
        await createNotification({
          userId: admin.id,
          title: '📅 Nouvelle visite planifiée',
          body: `Visite pour ${targetDisplay} le ${visit.scheduled_date} à ${visit.scheduled_time}`,
          type: 'system',
          data: { visit_id: visit.id, status: 'planifiee' },
        });
      }
    }

    res.status(201).json({
      success: true,
      visit,
      requires_payment: false,
    });
  } catch (error) {
    console.error('❌ Create visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ CONFIRMER PAIEMENT D'UNE VISITE PONCTUELLE
// =============================================
router.post('/:id/confirm-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { transaction_id } = req.body;
    const userId = req.user.id;

    // ✅ Récupérer la visite
    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', id)
      .single();

    if (visitError) {
      console.error('❌ Erreur récupération visite:', visitError);
      return res.status(404).json({ error: 'Visite non trouvée' });
    }

    // ✅ Vérifier que l'utilisateur est le propriétaire
    if (visit.user_id !== userId) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    // ✅ Vérifier que la visite est en brouillon
    if (visit.status !== 'brouillon') {
      return res.status(400).json({ error: 'Cette visite n\'est pas en attente de paiement' });
    }

    // ✅ Passer la visite de brouillon à planifiee
    const { data: updatedVisit, error: updateError } = await supabase
      .from('visites')
      .update({
        status: 'planifiee',
        metadata: {
          ...(visit.metadata || {}),
          payment_confirmed_at: new Date().toISOString(),
          transaction_id: transaction_id,
          scheduled_from_draft: true,
          payment_completed: true,
        }
      })
      .eq('id', id)
      .select(`
        *,
        patient:patients(*),
        aidant:aidants(*, user:profiles(*))
      `)
      .single();

    if (updateError) {
      console.error('❌ Erreur mise à jour visite:', updateError);
      return res.status(500).json({ error: updateError.message });
    }

    // ✅ Notifier l'aidant assigné
    if (updatedVisit.aidant_id) {
      await createNotification({
        userId: updatedVisit.aidant_id,
        title: '📅 Nouvelle visite à valider',
        body: `Visite pour ${updatedVisit.target_name || 'le patient'} le ${updatedVisit.scheduled_date} à ${updatedVisit.scheduled_time}`,
        type: 'visite',
        data: { visit_id: id, action: 'approve' },
      });
    }

    // ✅ Notification à la famille
    const targetDisplay = updatedVisit.target_name || (updatedVisit.patient ? `${updatedVisit.patient.first_name} ${updatedVisit.patient.last_name}` : 'Personnel');

    await createNotification({
      userId: userId,
      title: '✅ Visite planifiée !',
      body: `Votre visite pour ${targetDisplay} a été planifiée avec succès.`,
      type: 'visite',
      data: { visit_id: id, status: 'planifiee' },
    });

    // ✅ Notification aux admins
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (admins && admins.length > 0) {
      for (const admin of admins) {
        await createNotification({
          userId: admin.id,
          title: '✅ Visite planifiée après paiement',
          body: `Visite pour ${targetDisplay} le ${updatedVisit.scheduled_date} à ${updatedVisit.scheduled_time}`,
          type: 'system',
          data: { visit_id: id, status: 'planifiee' },
        });
      }
    }

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
// ✅ APPROUVER UNE VISITE (par l'aidant)
// =============================================
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;

    const { data: visit, error: fetchError } = await supabase
      .from('visites')
      .select('*, patient:patients(*), aidant:aidants(*)')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    if (visit.aidant_id !== user.id) {
      return res.status(403).json({ error: 'Vous n\'êtes pas assigné à cette visite' });
    }

    if (visit.status !== 'planifiee') {
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

    // ✅ Notification à la famille
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
    console.error('Approve visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ REFUSER UNE VISITE (par l'aidant)
// =============================================
router.post('/:id/refuse', async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;
    const { reason } = req.body;

    const { data: visit, error: fetchError } = await supabase
      .from('visites')
      .select('*, patient:patients(*), aidant:aidants(*)')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    if (visit.aidant_id !== user.id) {
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

    // ✅ Notification à la famille
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

    // ✅ Notification aux admins
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
    console.error('Refuse visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ RÉASSIGNER UNE VISITE (admin)
// =============================================
router.post('/:id/reassign', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { aidant_id, assignment_type } = req.body;

    const { data: visit, error: fetchError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    const { data, error } = await supabase
      .from('visites')
      .update({
        aidant_id,
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

    // ✅ Notification au nouvel aidant
    await createNotification({
      userId: aidant_id,
      title: '📅 Nouvelle visite assignée',
      body: `Vous avez été assigné à une visite pour ${targetDisplay} le ${visit.scheduled_date} à ${visit.scheduled_time}.`,
      type: 'visite',
      data: { visit_id: id, action: 'approve' },
    });

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('Reassign visit error:', error);
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

    const { data: visit, error: fetchError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    if (visit.aidant_id !== user.id) {
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
        aidant:aidants(*, user:profiles(*))
      `)
      .single();

    if (error) throw error;

    // ✅ Notification à la famille
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
    console.error('Start visit error:', error);
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

    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('aidant_id, patient_id, start_time, metadata, target_name, user_id')
      .eq('id', id)
      .single();

    if (visitError) throw visitError;

    if (visit.aidant_id !== user.id) {
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

    // ✅ Notification à la famille
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

    // ✅ Notification aux admins
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
    console.error('Complete visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ VALIDER UNE VISITE (avec décompte)
// =============================================
router.post('/:id/validate', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { comment } = req.body;
    const now = new Date().toISOString();

    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('patient_id, aidant_id, metadata, user_id, target_type, target_name')
      .eq('id', id)
      .single();

    if (visitError) throw visitError;

    // ✅ Vérifier que la visite est terminée
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
        aidant:aidants(*, user:profiles(*))
      `)
      .single();

    if (error) throw error;

    // ✅ VÉRIFIER SI LA VISITE ÉTAIT PONCTUELLE (payée)
    const isPonctual = visit.metadata?.is_ponctual === true || visit.metadata?.is_draft === true;
    const wasPaid = visit.metadata?.payment_completed === true;

    // ✅ Si visite ponctuelle payée, NE PAS DÉCOMPTER DE L'ABONNEMENT
    if (!isPonctual || !wasPaid) {
      // ✅ DÉCOMPTE DE L'ABONNEMENT (sur le compte, pas le patient)
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
          // ✅ Notification si plus de visites
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

    // ✅ Notification à la famille
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

    // ✅ Notification à l'aidant
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
    console.error('Validate visit error:', error);
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

    // ✅ Seul admin/coord ou famille concernée peuvent annuler
    const canCancel = ['admin', 'coordinator'].includes(profile.role);
    if (!canCancel) {
      // ✅ Vérifier si c'est la famille du patient OU la visite personnelle
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

    // ✅ Si la visite est en brouillon, on peut l'annuler sans autre forme de procès
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
    console.error('Cancel visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// AJOUTER UNE PHOTO
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
    console.error('Add photo error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// SUPPRIMER UNE PHOTO
// =============================================
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
    console.error('Delete photo error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// RÉCUPÉRER LES PHOTOS D'UNE VISITE
// =============================================
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
    console.error('Get photos error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// RÉCUPÉRER LES AUDIOS D'UNE VISITE
// =============================================
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
    console.error('Get audios error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// RÉCUPÉRER LES VISITES EN BROUILLON
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
      .eq('status', 'brouillon')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // ✅ Ajouter le prix pour chaque visite
    const visitsWithPrice = (data || []).map(visit => ({
      ...visit,
      payment_amount: getPonctualPrice(visit.duration_minutes || 60),
    }));

    res.json(visitsWithPrice);
  } catch (error) {
    console.error('Get drafts error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
