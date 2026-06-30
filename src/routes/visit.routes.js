// 📁 backend/src/routes/visit.routes.js
 
const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const roleMiddleware = require('../middleware/role.middleware');
const { createNotification } = require('../services/notification.service');

router.use(authMiddleware);

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
      const { data: links } = await supabase
        .from('patient_family_links')
        .select('patient_id')
        .eq('family_id', user.id);

      const patientIds = links?.map(l => l.patient_id) || [];
      if (patientIds.length > 0) {
        query = query.in('patient_id', patientIds);
      } else {
        return res.json([]);
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

    if (profile.role === 'family') {
      const { data: links } = await supabase
        .from('patient_family_links')
        .select('patient_id')
        .eq('family_id', user.id)
        .eq('patient_id', data.patient_id);

      if (!links || links.length === 0) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();

      if (data.aidant_id !== aidant?.id) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }
    }

    res.json(data);
  } catch (error) {
    console.error('Get visit detail error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ CRÉER UNE VISITE - AVEC VÉRIFICATION PAIEMENT
// =============================================
router.post('/', async (req, res) => {
  try {
    const { user, profile } = req;
    const { 
      patient_id,
      scheduled_date,
      scheduled_time,
      duration_minutes,
      notes,
      is_urgent,
      is_ponctual = false,
      assignment_type = 'ponctuelle'
    } = req.body;

    // ✅ Vérifier les permissions
    const canCreate = ['admin', 'coordinator'].includes(profile.role) || profile.role === 'family';
    if (!canCreate) {
      return res.status(403).json({ error: 'Non autorisé à créer une visite' });
    }

    // ✅ Si c'est une famille, vérifier le patient
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

    // ✅ Vérifier si un aidant est assigné
    let aidantId = req.body.aidant_id || null;

    // ✅ Déterminer le statut initial
    let status = 'planifiee';
    
    // ✅ Vérifier le paiement si mode ponctuel
    if (is_ponctual) {
      // Enregistrer en attente de paiement
      status = 'attente_paiement';
    }

    // ✅ Si abonnement, vérifier le quota
    if (!is_ponctual && patient_id) {
      const { data: subscription } = await supabase
        .from('abonnements')
        .select('id, remaining_visits, status')
        .eq('patient_id', patient_id)
        .eq('status', 'actif')
        .maybeSingle();

      if (subscription && subscription.remaining_visits <= 0) {
        // Quota épuisé, passer en mode ponctuel
        status = 'attente_paiement';
      }
    }

    const visitData = {
      patient_id: patient_id || null,
      aidant_id: aidantId,
      coordinator_id: user.id,
      scheduled_date,
      scheduled_time,
      duration_minutes: duration_minutes || 60,
      status,
      actions: [],
      notes: notes || null,
      is_urgent: is_urgent || false,
      visit_type: 'ponctuelle',
      assignment_type: assignment_type || 'ponctuelle',
      requested_by: user.id,
      metadata: {
        created_by: user.id,
        created_at: new Date().toISOString(),
        is_ponctual,
        requires_payment: status === 'attente_paiement',
      }
    };

    const { data, error } = await supabase
      .from('visites')
      .insert(visitData)
      .select(`
        *,
        patient:patients(*),
        aidant:aidants(*, user:profiles(*))
      `)
      .single();

    if (error) throw error;

    // ✅ Notification à la famille
    if (data.patient) {
      const { data: links } = await supabase
        .from('patient_family_links')
        .select('family_id')
        .eq('patient_id', data.patient_id);

      if (links) {
        for (const link of links) {
          const message = status === 'attente_paiement'
            ? `Visite planifiée pour ${data.patient.first_name} ${data.patient.last_name}. Paiement requis pour validation.`
            : `Visite planifiée pour ${data.patient.first_name} ${data.patient.last_name} le ${data.scheduled_date} à ${data.scheduled_time}`;
          
          await createNotification({
            userId: link.family_id,
            title: status === 'attente_paiement' ? '💳 Visite en attente de paiement' : '📅 Nouvelle visite planifiée',
            body: message,
            type: 'visite',
            data: { visit_id: data.id, status: data.status },
          });
        }
      }
    }

    // ✅ Notification à l'aidant si assigné et pas en attente de paiement
    if (aidantId && status !== 'attente_paiement') {
      await createNotification({
        userId: aidantId,
        title: '📅 Nouvelle visite à valider',
        body: `Visite pour ${data.patient?.first_name || 'Patient'} le ${data.scheduled_date} à ${data.scheduled_time}`,
        type: 'visite',
        data: { visit_id: data.id, action: 'approve' },
      });
    }

    res.status(201).json({ success: true, visit: data });
  } catch (error) {
    console.error('Create visit error:', error);
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

    const { data: visit, error: visitError } = await supabase
      .from('visites')
      .select('*')
      .eq('id', id)
      .single();

    if (visitError) throw visitError;

    if (visit.status !== 'attente_paiement') {
      return res.status(400).json({ error: 'Cette visite n\'est pas en attente de paiement' });
    }

    // ✅ Passer en planifiée
    const { data, error } = await supabase
      .from('visites')
      .update({
        status: 'planifiee',
        metadata: {
          ...(visit.metadata || {}),
          payment_confirmed_at: new Date().toISOString(),
          transaction_id,
        }
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // ✅ Notifier l'aidant assigné
    if (visit.aidant_id) {
      await createNotification({
        userId: visit.aidant_id,
        title: '📅 Visite validée - Paiement confirmé',
        body: `La visite pour ${visit.patient_id} est maintenant validée.`,
        type: 'visite',
        data: { visit_id: id, action: 'approve' },
      });
    }

    res.json({ success: true, visit: data });
  } catch (error) {
    console.error('Confirm payment error:', error);
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

    // ✅ Vérifier que l'aidant est bien assigné
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
            body: `L'aidant a accepté la visite pour ${visit.patient.first_name} ${visit.patient.last_name} le ${visit.scheduled_date}.`,
            type: 'visite',
            data: { visit_id: id, status: 'acceptee' },
          });
        }
      }
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
            body: `L'aidant a refusé la visite pour ${visit.patient.first_name} ${visit.patient.last_name} le ${visit.scheduled_date}. Motif: ${reason || 'Non spécifié'}`,
            type: 'visite',
            data: { visit_id: id, status: 'refusee' },
          });
        }
      }
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
          body: `L'aidant a refusé la visite pour ${visit.patient?.first_name} ${visit.patient?.last_name} le ${visit.scheduled_date}.`,
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

    // ✅ Notification au nouvel aidant
    await createNotification({
      userId: aidant_id,
      title: '📅 Nouvelle visite assignée',
      body: `Vous avez été assigné à une visite le ${visit.scheduled_date} à ${visit.scheduled_time}.`,
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
            body: `${data.aidant?.user?.full_name || 'L\'aidant'} a commencé la visite de ${data.patient.first_name} ${data.patient.last_name}.`,
            type: 'visite',
            data: { visit_id: data.id, status: 'en_cours' },
          });
        }
      }
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
      .select('aidant_id, patient_id, start_time, metadata')
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
            body: `La visite de ${data.patient.first_name} ${data.patient.last_name} est terminée. L'aidant a soumis son rapport.`,
            type: 'visite',
            data: { visit_id: data.id, status: 'terminee' },
          });
        }
      }
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
          body: `${data.aidant?.user?.full_name || 'Un aidant'} a terminé la visite de ${data.patient?.first_name} ${data.patient?.last_name}. À valider.`,
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
      .select('patient_id, aidant_id, metadata')
      .eq('id', id)
      .single();

    if (visitError) throw visitError;

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

    // ✅ DÉCOMPTE DE L'ABONNEMENT
    if (data.patient_id) {
      const { data: subscription, error: subError } = await supabase
        .from('abonnements')
        .select('id, remaining_visits, used_visits, total_visits, user_id')
        .eq('patient_id', data.patient_id)
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
    }

    // ✅ Notification à la famille
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
            body: `La visite de ${data.patient.first_name} ${data.patient.last_name} a été validée.`,
            type: 'visite',
            data: { visit_id: data.id, status: 'validee' },
          });
        }
      }
    }

    // ✅ Notification à l'aidant
    if (data.aidant?.user_id) {
      await createNotification({
        userId: data.aidant.user_id,
        title: '✅ Visite validée',
        body: `La visite de ${data.patient?.first_name} ${data.patient?.last_name} a été validée.`,
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
      // Vérifier si c'est la famille du patient
      if (profile.role === 'family' && visit.patient_id) {
        const { data: link } = await supabase
          .from('patient_family_links')
          .select('family_id')
          .eq('family_id', user.id)
          .eq('patient_id', visit.patient_id)
          .maybeSingle();

        if (!link) {
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

module.exports = router;
