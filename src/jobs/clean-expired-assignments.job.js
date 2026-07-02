// 📁 backend/src/jobs/clean-expired-assignments.job.js

const cron = require('node-cron');
const { supabase } = require('../services/supabase.service');
const { createNotification } = require('../services/notification.service');

// ============================================================
// FONCTION : NETTOYER LES ASSIGNATIONS EXPIRÉES
// ============================================================

/**
 * Nettoie les assignations expirées et notifie les aidants concernés
 * @returns {Promise<Object>} Résultat du nettoyage
 */
const cleanExpiredAssignments = async () => {
  console.log(`🔄 [${new Date().toISOString()}] Nettoyage des assignations expirées...`);

  try {
    // ✅ 1. Récupérer les assignations qui expirent dans les 24h
    const now = new Date();
    const in24Hours = new Date(now);
    in24Hours.setHours(in24Hours.getHours() + 24);

    const { data: expiringSoon, error: expiringError } = await supabase
      .from('aidant_assignments')
      .select(`
        *,
        aidant:profiles!aidant_user_id(
          id,
          full_name,
          email
        ),
        target_patient:patients!target_id(
          id,
          first_name,
          last_name
        ),
        target_profile:profiles!target_id(
          id,
          full_name,
          email
        )
      `)
      .eq('status', 'active')
      .not('expires_at', 'is', null)
      .gte('expires_at', now.toISOString())
      .lt('expires_at', in24Hours.toISOString());

    if (expiringError) {
      console.error('❌ Erreur récupération assignations expirant bientôt:', expiringError);
    }

    // ✅ Notifier les aidants des assignations qui expirent dans les 24h
    if (expiringSoon && expiringSoon.length > 0) {
      console.log(`📅 ${expiringSoon.length} assignations expirent dans les 24h`);

      for (const assignment of expiringSoon) {
        const targetName = assignment.target_type === 'patient'
          ? `${assignment.target_patient?.first_name || ''} ${assignment.target_patient?.last_name || ''}`.trim()
          : assignment.target_profile?.full_name || 'cible';

        await createNotification({
          userId: assignment.aidant_user_id,
          title: '⏰ Assignation bientôt expirée',
          body: `Votre assignation à ${targetName} expire dans moins de 24h (${new Date(assignment.expires_at).toLocaleDateString('fr-FR')}).`,
          type: 'reminder',
          data: {
            assignment_id: assignment.id,
            expires_at: assignment.expires_at,
            target_type: assignment.target_type,
            target_id: assignment.target_id,
          },
        });
      }
    }

    // ✅ 2. Marquer les assignations expirées
    const { data: expired, error: expiredError } = await supabase
      .from('aidant_assignments')
      .update({
        status: 'expired',
        reason: 'Expiration automatique',
        updated_at: new Date().toISOString(),
      })
      .eq('status', 'active')
      .not('expires_at', 'is', null)
      .lt('expires_at', now.toISOString())
      .select(`
        *,
        aidant:profiles!aidant_user_id(
          id,
          full_name,
          email
        ),
        target_patient:patients!target_id(
          id,
          first_name,
          last_name
        ),
        target_profile:profiles!target_id(
          id,
          full_name,
          email
        )
      `);

    if (expiredError) {
      console.error('❌ Erreur mise à jour assignations expirées:', expiredError);
      return { success: false, error: expiredError.message };
    }

    const expiredCount = expired?.length || 0;
    console.log(`🗑️ ${expiredCount} assignations expirées marquées`);

    // ✅ 3. Notifier les aidants des assignations expirées
    if (expired && expired.length > 0) {
      for (const assignment of expired) {
        const targetName = assignment.target_type === 'patient'
          ? `${assignment.target_patient?.first_name || ''} ${assignment.target_patient?.last_name || ''}`.trim()
          : assignment.target_profile?.full_name || 'cible';

        await createNotification({
          userId: assignment.aidant_user_id,
          title: '❌ Assignation expirée',
          body: `Votre assignation à ${targetName} a expiré automatiquement.`,
          type: 'alert',
          data: {
            assignment_id: assignment.id,
            expires_at: assignment.expires_at,
            target_type: assignment.target_type,
            target_id: assignment.target_id,
          },
        });

        // ✅ Notifier les admins
        const { data: admins } = await supabase
          .from('profiles')
          .select('id')
          .in('role', ['admin', 'coordinator']);

        if (admins && admins.length > 0) {
          const adminNotifications = admins.map((admin) => ({
            user_id: admin.id,
            title: '⚠️ Assignation expirée automatiquement',
            body: `L'assignation de ${assignment.aidant?.full_name || 'l\'aidant'} à ${targetName} a expiré.`,
            type: 'alert',
            data: {
              assignment_id: assignment.id,
              aidant_user_id: assignment.aidant_user_id,
              target_type: assignment.target_type,
              target_id: assignment.target_id,
            },
          }));

          await supabase.from('notifications').insert(adminNotifications);
        }

        // ✅ Mettre à jour les compteurs de l'aidant
        const { count: currentCount, error: countError } = await supabase
          .from('aidant_assignments')
          .select('id', { count: 'exact', head: true })
          .eq('aidant_user_id', assignment.aidant_user_id)
          .eq('status', 'active');

        if (!countError) {
          const { data: aidant, error: aidantError } = await supabase
            .from('aidants')
            .select('max_assignments')
            .eq('user_id', assignment.aidant_user_id)
            .single();

          if (!aidantError && aidant) {
            const maxAssignments = aidant.max_assignments || 4;
            await supabase
              .from('aidants')
              .update({
                current_assignments: currentCount || 0,
                available: (currentCount || 0) < maxAssignments,
                updated_at: new Date().toISOString(),
              })
              .eq('user_id', assignment.aidant_user_id);
          }
        }
      }
    }

    // ✅ 4. Nettoyer les assignations qui ont un aidant inactif
    const { data: inactiveAidantAssignments, error: inactiveError } = await supabase
      .from('aidant_assignments')
      .update({
        status: 'inactive',
        reason: 'Aidant inactif',
        updated_at: new Date().toISOString(),
      })
      .eq('status', 'active')
      .in('aidant_user_id', (query) => {
        return query
          .from('profiles')
          .select('id')
          .eq('is_active', false);
      })
      .select();

    if (inactiveError) {
      console.error('❌ Erreur nettoyage aidants inactifs:', inactiveError);
    } else {
      console.log(`🗑️ ${inactiveAidantAssignments?.length || 0} assignations d'aidants inactifs nettoyées`);
    }

    // ✅ 5. Synthèse
    const result = {
      success: true,
      expired: expiredCount,
      expiring_soon: expiringSoon?.length || 0,
      inactive_removed: inactiveAidantAssignments?.length || 0,
      timestamp: new Date().toISOString(),
    };

    console.log(`✅ Nettoyage terminé: ${expiredCount} expirées, ${result.expiring_soon} bientôt expirantes, ${result.inactive_removed} aidants inactifs`);

    return result;
  } catch (error) {
    console.error('❌ Erreur cleanExpiredAssignments:', error);
    return { success: false, error: error.message };
  }
};

// ============================================================
// JOB CRON : TOUS LES JOURS À 1H
// ============================================================

const startCleanExpiredAssignmentsJob = () => {
  console.log('🔄 Démarrage du job de nettoyage des assignations expirées...');

  // ⏰ Tous les jours à 1h du matin
  cron.schedule('0 1 * * *', async () => {
    console.log(`🔄 [${new Date().toISOString()}] Job de nettoyage des assignations expirées...`);
    await cleanExpiredAssignments();
  });

  // ⏰ Optionnel : Toutes les heures pour les expirations précises
  cron.schedule('0 * * * *', async () => {
    console.log(`🔄 [${new Date().toISOString()}] Vérification rapide des assignations expirées...`);
    await cleanExpiredAssignments();
  });

  console.log('✅ Job de nettoyage des assignations expirées démarré');
};

// ============================================================
// FONCTION : EXÉCUTION MANUELLE (pour tests)
// ============================================================

const runCleanExpiredAssignments = async () => {
  console.log('🚀 Exécution manuelle du nettoyage des assignations expirées...');
  const result = await cleanExpiredAssignments();
  console.log('📊 Résultat:', result);
  return result;
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  cleanExpiredAssignments,
  startCleanExpiredAssignmentsJob,
  runCleanExpiredAssignments,
};
