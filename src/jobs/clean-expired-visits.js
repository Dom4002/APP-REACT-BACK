// 📁 backend/src/jobs/clean-expired-visits.js

const { supabase } = require('../services/supabase.service');
const { createNotification } = require('../services/notification.service');

// ============================================================
// CONSTANTES
// ============================================================

const EXPIRY_HOURS = 24;
const BATCH_SIZE = 50;

// ============================================================
// FONCTION PRINCIPALE
// ============================================================

/**
 * Nettoie les visites expirées (planifiées sans réponse depuis 24-48h)
 * @returns {Promise<Object>} - Résultat de l'opération
 */
const cleanExpiredVisits = async () => {
  console.log(`🔄 [${new Date().toISOString()}] Nettoyage des visites expirées...`);

  try {
    const now = new Date();
    const expiryThreshold = new Date(now);
    expiryThreshold.setHours(expiryThreshold.getHours() - EXPIRY_HOURS);

    // ✅ Récupérer les visites planifiées sans réponse depuis 24h
    const { data: visits, error } = await supabase
      .from('visites')
      .select(`
        *,
        patient:patients(*),
        aidant:aidants!visites_aidant_id_fkey(
          id,
          user_id,
          user:profiles!aidants_user_id_fkey(
            id,
            full_name,
            email
          )
        ),
        family:profiles!visites_user_id_fkey(
          id,
          full_name,
          email
        )
      `)
      .eq('status', 'planifiee')
      .is('approved_at', null)
      .is('refused_at', null)
      .lt('created_at', expiryThreshold.toISOString())
      .limit(BATCH_SIZE);

    if (error) {
      console.error('❌ Erreur récupération visites:', error);
      return { success: false, error: error.message };
    }

    if (!visits || visits.length === 0) {
      console.log('ℹ️ Aucune visite expirée à nettoyer');
      return { success: true, expired: 0 };
    }

    console.log(`📅 ${visits.length} visites expirées à nettoyer`);

    let expired = 0;
    let errors = 0;

    for (const visit of visits) {
      try {
        // ✅ Mettre à jour le statut de la visite
        const { data: updatedVisit, error: updateError } = await supabase
          .from('visites')
          .update({
            status: 'expire',
            metadata: {
              ...(visit.metadata || {}),
              expired_at: new Date().toISOString(),
              expired_reason: 'Aucune réponse de l\'aidant dans les 24h',
              expired_from: 'clean_expired_visits_job',
            },
            updated_at: new Date().toISOString(),
          })
          .eq('id', visit.id)
          .select()
          .single();

        if (updateError) {
          console.error(`❌ Erreur expiration visite ${visit.id}:`, updateError);
          errors++;
          continue;
        }

        // ✅ Notification à l'aidant
        if (visit.aidant?.user_id) {
          await createNotification({
            userId: visit.aidant.user_id,
            title: '⏰ Visite expirée',
            body: `Vous n'avez pas répondu à la visite pour ${visit.patient?.first_name || 'le patient'} le ${visit.scheduled_date}. La visite a été marquée comme expirée.`,
            type: 'visite',
            data: {
              visit_id: visit.id,
              status: 'expire',
              action: 'reassign',
            },
          });
        }

        // ✅ Notification à la famille
        if (visit.user_id) {
          await createNotification({
            userId: visit.user_id,
            title: '⏰ Visite expirée - Réassignation nécessaire',
            body: `La visite pour ${visit.patient?.first_name || 'le patient'} le ${visit.scheduled_date} n'a pas reçu de réponse de l'aidant. Notre équipe va procéder à une réassignation.`,
            type: 'visite',
            data: {
              visit_id: visit.id,
              status: 'expire',
              action: 'reassign',
            },
          });
        }

        // ✅ Notification aux admins
        const { data: admins } = await supabase
          .from('profiles')
          .select('id')
          .in('role', ['admin', 'coordinator']);

        if (admins && admins.length > 0) {
          for (const admin of admins) {
            await createNotification({
              userId: admin.id,
              title: '⚠️ Visite expirée - Réassignation nécessaire',
              body: `La visite de ${visit.patient?.first_name || 'le patient'} le ${visit.scheduled_date} n'a pas reçu de réponse. Réassignation nécessaire.`,
              type: 'alert',
              data: {
                visit_id: visit.id,
                action: 'reassign',
                urgency: 'high',
              },
            });
          }
        }

        expired++;
        console.log(`✅ Visite ${visit.id} marquée comme expirée`);

      } catch (error) {
        console.error(`❌ Erreur traitement visite ${visit.id}:`, error);
        errors++;
      }
    }

    console.log(`✅ Nettoyage terminé: ${expired} visites expirées, ${errors} erreurs`);

    return {
      success: true,
      expired,
      errors,
      total: visits.length,
    };
  } catch (error) {
    console.error('❌ cleanExpiredVisits error:', error);
    return { success: false, error: error.message };
  }
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = { cleanExpiredVisits };
