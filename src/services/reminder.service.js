// 📁 backend/src/services/reminder.service.js
// ✅ VERSION CORRIGÉE - AVEC JOBS POUR COMMANDES 15/30MIN

const { supabase } = require('./supabase.service');
const { createNotification } = require('./notification.service');
const { sendEmail, templates } = require('./email.service');

// =============================================
// ENVOYER UN RAPPEL POUR UNE VISITE
// =============================================
const sendVisitReminder = async (visitId) => {
  try {
    const { data: visit, error } = await supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*),
        aidant:aidants(*, user:profiles(*)),
        coordinator:profiles!coordinator_id(*)
      `)
      .eq('id', visitId)
      .single();

    if (error) throw error;
    if (!visit) return;

    const patientName = visit.patient?.first_name || 'Patient';
    const patientAddress = visit.patient?.address || 'Adresse non précisée';
    const scheduledDate = new Date(visit.scheduled_date).toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    const scheduledTime = visit.scheduled_time;

    // ✅ 1. Notification à l'aidant
    if (visit.aidant?.user_id) {
      await createNotification({
        userId: visit.aidant.user_id,
        title: '📅 Rappel de visite',
        body: `Visite prévue pour ${patientName} le ${scheduledDate} à ${scheduledTime}`,
        type: 'reminder',
        data: { visit_id: visit.id, patient_name: patientName, date: scheduledDate, time: scheduledTime },
      });

      try {
        await sendEmail({
          to: visit.aidant.user?.email,
          ...templates.visitReminder({
            patient_name: patientName,
            date: scheduledDate,
            time: scheduledTime,
            address: patientAddress,
            aidant_name: visit.aidant.user?.full_name,
          })
        });
      } catch (emailError) {
        console.error('Email reminder error:', emailError);
      }
    }

    // ✅ 2. Notification à la famille
    if (visit.patient) {
      const { data: links } = await supabase
        .from('patient_family_links')
        .select('family_id')
        .eq('patient_id', visit.patient_id);

      if (links) {
        for (const link of links) {
          await createNotification({
            userId: link.family_id,
            title: '📅 Rappel de visite',
            body: `Une visite est prévue pour ${patientName} le ${scheduledDate} à ${scheduledTime}`,
            type: 'reminder',
            data: { visit_id: visit.id, patient_name: patientName },
          });
        }
      }
    }

    await supabase
      .from('visites')
      .update({
        metadata: {
          ...visit.metadata,
          reminder_sent: {
            sent_at: new Date().toISOString(),
            sent_to: {
              aidant: visit.aidant?.user_id || null,
              families: links?.map(l => l.family_id) || [],
            }
          }
        }
      })
      .eq('id', visitId);

    console.log(`✅ Rappel envoyé pour la visite ${visitId}`);
    return { success: true, visitId };
  } catch (error) {
    console.error('Send visit reminder error:', error);
    return { success: false, error: error.message };
  }
};

// =============================================
// ENVOYER TOUS LES RAPPELS DU JOUR
// =============================================
const sendDailyReminders = async () => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const { data: visits, error } = await supabase
      .from('visites')
      .select('id')
      .eq('scheduled_date', tomorrowStr)
      .eq('status', 'planifiee');

    if (error) throw error;

    let successCount = 0;
    for (const visit of visits) {
      const result = await sendVisitReminder(visit.id);
      if (result.success) successCount++;
    }

    console.log(`✅ ${successCount}/${visits.length} rappels envoyés pour demain`);
    return { success: true, sent: successCount, total: visits.length };
  } catch (error) {
    console.error('Send daily reminders error:', error);
    return { success: false, error: error.message };
  }
};

// =============================================
// ENVOYER UN RAPPEL 1H AVANT LA VISITE
// =============================================
const sendHourReminder = async () => {
  try {
    const now = new Date();
    const inOneHour = new Date(now);
    inOneHour.setHours(inOneHour.getHours() + 1);
    
    const currentTime = now.toTimeString().slice(0, 5);
    const currentDate = now.toISOString().split('T')[0];

    const { data: visits, error } = await supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*),
        aidant:aidants(*, user:profiles(*))
      `)
      .eq('scheduled_date', currentDate)
      .eq('status', 'acceptee')
      .gte('scheduled_time', currentTime)
      .lt('scheduled_time', inOneHour.toTimeString().slice(0, 5));

    if (error) throw error;

    for (const visit of visits) {
      if (visit.aidant?.user_id) {
        await createNotification({
          userId: visit.aidant.user_id,
          title: '⏰ Visite dans 1 heure',
          body: `La visite pour ${visit.patient?.first_name} ${visit.patient?.last_name} est dans 1 heure.`,
          type: 'reminder',
          data: { visit_id: visit.id, urgency: 'high' },
        });
      }
    }

    return { success: true, sent: visits.length };
  } catch (error) {
    console.error('Send hour reminder error:', error);
    return { success: false, error: error.message };
  }
};

// =============================================
// ✅ VÉRIFIER LES VISITES SANS RÉPONSE (24-48h)
// =============================================
const checkUnapprovedVisits = async () => {
  try {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now);
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const { data: visits, error } = await supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*),
        aidant:aidants(*, user:profiles(*))
      `)
      .eq('status', 'planifiee')
      .lt('created_at', twentyFourHoursAgo.toISOString())
      .is('approved_at', null)
      .is('refused_at', null);

    if (error) throw error;

    for (const visit of visits) {
      // ✅ Passer en statut "expire"
      await supabase
        .from('visites')
        .update({
          status: 'expire',
          metadata: {
            ...(visit.metadata || {}),
            expired_at: new Date().toISOString(),
          }
        })
        .eq('id', visit.id);

      // ✅ Notification à l'admin
      const { data: admins } = await supabase
        .from('profiles')
        .select('id')
        .in('role', ['admin', 'coordinator']);

      if (admins) {
        for (const admin of admins) {
          await createNotification({
            userId: admin.id,
            title: '⚠️ Visite sans réponse - Réassignation nécessaire',
            body: `La visite de ${visit.patient?.first_name} ${visit.patient?.last_name} le ${visit.scheduled_date} n'a pas reçu de réponse.`,
            type: 'alert',
            data: { visit_id: visit.id, action: 'reassign' },
          });
        }
      }
    }

    return { success: true, expired: visits.length };
  } catch (error) {
    console.error('Check unapproved visits error:', error);
    return { success: false, error: error.message };
  }
};

// =============================================
// ✅ VÉRIFIER LES COMMANDES SANS RÉPONSE (15/30 MIN)
// =============================================
const checkUnansweredOrders = async () => {
  try {
    const now = new Date();

    // ✅ 15 minutes - Relance
    const fifteenMinutesAgo = new Date(now);
    fifteenMinutesAgo.setMinutes(fifteenMinutesAgo.getMinutes() - 15);

    // ✅ 30 minutes - Passer en disponible
    const thirtyMinutesAgo = new Date(now);
    thirtyMinutesAgo.setMinutes(thirtyMinutesAgo.getMinutes() - 30);

    // ✅ 1. Commandes en attente depuis 15min (relance)
    const { data: fifteenMinOrders, error: error15 } = await supabase
      .from('commandes')
      .select('*')
      .eq('status', 'en_attente')
      .lt('created_at', fifteenMinutesAgo.toISOString())
      .gt('created_at', thirtyMinutesAgo.toISOString());

    if (error15) throw error15;

    for (const order of fifteenMinOrders) {
      // ✅ Relancer l'aidant assigné
      if (order.aidant_id) {
        await createNotification({
          userId: order.aidant_id,
          title: '⏰ Commande urgente - En attente de prise',
          body: `La commande "${order.description}" est en attente depuis 15 minutes.`,
          type: 'commande',
          data: { order_id: order.id, urgency: 'high' },
        });
      }
    }

    // ✅ 2. Commandes en attente depuis 30min (passer en disponible)
    const { data: thirtyMinOrders, error: error30 } = await supabase
      .from('commandes')
      .select('*')
      .eq('status', 'en_attente')
      .lt('created_at', thirtyMinutesAgo.toISOString());

    if (error30) throw error30;

    for (const order of thirtyMinOrders) {
      // ✅ Passer en disponible
      await supabase
        .from('commandes')
        .update({
          status: 'disponible',
          updated_at: new Date().toISOString(),
          metadata: {
            ...(order.metadata || {}),
            available_at: new Date().toISOString(),
            no_response: true,
          }
        })
        .eq('id', order.id);

      // ✅ Notifier TOUS les aidants disponibles
      const { data: aidants } = await supabase
        .from('aidants')
        .select('user_id')
        .eq('available', true)
        .eq('is_verified', true);

      if (aidants && aidants.length > 0) {
        for (const aidant of aidants) {
          await createNotification({
            userId: aidant.user_id,
            title: '🚨 Commande urgente disponible',
            body: `Commande "${order.description}" - Premier arrivé, premier servi !`,
            type: 'commande',
            data: { order_id: order.id, action: 'take', urgency: 'high' },
          });
        }
      }

      // ✅ Notification à l'admin
      const { data: admins } = await supabase
        .from('profiles')
        .select('id')
        .in('role', ['admin', 'coordinator']);

      if (admins) {
        for (const admin of admins) {
          await createNotification({
            userId: admin.id,
            title: '⚠️ Commande sans réponse - Disponible à tous',
            body: `La commande "${order.description}" est maintenant disponible à tous les aidants.`,
            type: 'alert',
            data: { order_id: order.id, action: 'monitor' },
          });
        }
      }
    }

    return { 
      success: true, 
      relanced: fifteenMinOrders.length,
      available: thirtyMinOrders.length 
    };
  } catch (error) {
    console.error('Check unanswered orders error:', error);
    return { success: false, error: error.message };
  }
};

// =============================================
// NOTIFICATION POUR EXPIRATION D'ABONNEMENT
// =============================================
const checkSubscriptionExpiry = async () => {
  try {
    const today = new Date();
    const inThreeDays = new Date(today);
    inThreeDays.setDate(inThreeDays.getDate() + 3);
    const inThreeDaysStr = inThreeDays.toISOString().split('T')[0];

    const { data: subscriptions, error } = await supabase
      .from('abonnements')
      .select(`
        *,
        offre:offres(*),
        user:profiles(*)
      `)
      .eq('status', 'actif')
      .eq('end_date', inThreeDaysStr);

    if (error) throw error;

    for (const sub of subscriptions) {
      await createNotification({
        userId: sub.user_id,
        title: '⚠️ Votre abonnement expire bientôt',
        body: `Votre abonnement ${sub.offre?.name} expire dans 3 jours. Pensez à le renouveler.`,
        type: 'reminder',
        data: { subscription_id: sub.id, expiry_date: sub.end_date },
      });

      try {
        await sendEmail({
          to: sub.user?.email,
          ...templates.subscriptionExpired({
            plan_name: sub.offre?.name,
            expiry_date: new Date(sub.end_date).toLocaleDateString('fr-FR'),
          })
        });
      } catch (emailError) {
        console.error('Email expiry error:', emailError);
      }
    }

    return { success: true, sent: subscriptions.length };
  } catch (error) {
    console.error('Check subscription expiry error:', error);
    return { success: false, error: error.message };
  }
};

// =============================================
// NOTIFICATION POUR ABONNEMENT EXPIRE
// =============================================
const checkExpiredSubscriptions = async () => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: subscriptions, error } = await supabase
      .from('abonnements')
      .select(`
        *,
        offre:offres(*),
        user:profiles(*)
      `)
      .eq('status', 'actif')
      .lt('end_date', today);

    if (error) throw error;

    for (const sub of subscriptions) {
      await supabase
        .from('abonnements')
        .update({ status: 'expire' })
        .eq('id', sub.id);

      await createNotification({
        userId: sub.user_id,
        title: '❌ Votre abonnement a expiré',
        body: `Votre abonnement ${sub.offre?.name} a expiré. Pour continuer à bénéficier de nos services, veuillez le renouveler.`,
        type: 'reminder',
        data: { subscription_id: sub.id },
      });
    }

    return { success: true, expired: subscriptions.length };
  } catch (error) {
    console.error('Check expired subscriptions error:', error);
    return { success: false, error: error.message };
  }
};

// =============================================
// NOTIFICATION POUR VISITE NON DEMARRÉE
// =============================================
const checkMissedVisits = async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const oneHourAgo = new Date(now);
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);
    const oneHourAgoStr = oneHourAgo.toTimeString().slice(0, 5);

    const { data: visits, error } = await supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*),
        aidant:aidants(*, user:profiles(*))
      `)
      .eq('scheduled_date', today)
      .eq('status', 'acceptee')
      .lt('scheduled_time', oneHourAgoStr);

    if (error) throw error;

    for (const visit of visits) {
      if (visit.aidant?.user_id) {
        await createNotification({
          userId: visit.aidant.user_id,
          title: '⏰ Visite non démarrée',
          body: `La visite pour ${visit.patient?.first_name} ${visit.patient?.last_name} était prévue à ${visit.scheduled_time}. N'oubliez pas de la démarrer !`,
          type: 'reminder',
          data: { visit_id: visit.id, urgency: 'high' },
        });
      }

      if (visit.patient) {
        const { data: links } = await supabase
          .from('patient_family_links')
          .select('family_id')
          .eq('patient_id', visit.patient_id);

        if (links) {
          for (const link of links) {
            await createNotification({
              userId: link.family_id,
              title: '⏰ Retard de visite',
              body: `La visite de ${visit.patient?.first_name} ${visit.patient?.last_name} n'a pas encore commencé alors qu'elle était prévue à ${visit.scheduled_time}.`,
              type: 'reminder',
              data: { visit_id: visit.id },
            });
          }
        }
      }
    }

    return { success: true, notified: visits.length };
  } catch (error) {
    console.error('Check missed visits error:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendVisitReminder,
  sendDailyReminders,
  sendHourReminder,
  checkUnapprovedVisits,
  checkUnansweredOrders,
  checkSubscriptionExpiry,
  checkExpiredSubscriptions,
  checkMissedVisits,
};
