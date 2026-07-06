// 📁 backend/src/jobs/scheduler.js

const cron = require('node-cron');
const { autoValidateOrders } = require('./auto-validate-orders');
const { 
  checkUnapprovedVisits, 
  checkUnansweredOrders,
  sendDailyReminders,
  sendHourReminder,
  checkSubscriptionExpiry,
  checkExpiredSubscriptions,
  checkMissedVisits,
} = require('../services/reminder.service');

const { cleanExpiredDrafts } = require('../services/visitPayment.service');
const { cleanExpiredAssignments } = require('./clean-expired-assignments.job');
const { cleanupOldNotifications, cleanupInactiveTokens } = require('./notification-cleanup.job');

// =============================================
// CRON JOB - TOUTES LES HEURES - Nettoyage des brouillons
// =============================================
cron.schedule('0 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Nettoyage des brouillons expirés...`);
  cleanExpiredDrafts();
});

// =============================================
// CRON JOB - TOUTES LES 15 MINUTES - Vérification des commandes sans réponse
// =============================================
cron.schedule('*/15 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des commandes sans réponse...`);
  checkUnansweredOrders();
});

// =============================================
// CRON JOB - TOUTES LES HEURES - Auto-validation des commandes
// =============================================
cron.schedule('0 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Auto-validation des commandes (12h)...`);
  autoValidateOrders();
});

// =============================================
// CRON JOB - TOUTES LES HEURES - Vérification des visites non approuvées (24h)
// =============================================
cron.schedule('0 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des visites non approuvées (24h)...`);
  checkUnapprovedVisits();
});

// =============================================
// CRON JOB - TOUTES LES HEURES - Vérification des visites manquées (1h après)
// =============================================
cron.schedule('0 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des visites manquées...`);
  checkMissedVisits();
});

// =============================================
// CRON JOB - TOUTES LES HEURES - Rappel 1h avant les visites
// =============================================
cron.schedule('0 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Envoi des rappels 1h avant...`);
  sendHourReminder();
});

// =============================================
// CRON JOB - TOUS LES JOURS À 1H - Nettoyage des assignations expirées
// =============================================
cron.schedule('0 1 * * *', async () => {
  console.log(`[${new Date().toISOString()}] 🔄 Nettoyage des assignations expirées...`);
  try {
    const result = await cleanExpiredAssignments();
    console.log(`✅ Nettoyage terminé: ${result.expired || 0} expirées, ${result.expiring_soon || 0} bientôt expirantes`);
  } catch (error) {
    console.error('❌ Erreur nettoyage assignations expirées:', error);
  }
});

// =============================================
// CRON JOB - TOUS LES JOURS À 2H - Nettoyage des notifications
// =============================================
cron.schedule('0 2 * * *', async () => {
  console.log(`[${new Date().toISOString()}] 🔄 Nettoyage des notifications...`);
  try {
    await cleanupOldNotifications();
    await cleanupInactiveTokens();
    console.log('✅ Nettoyage des notifications terminé');
  } catch (error) {
    console.error('❌ Erreur nettoyage notifications:', error);
  }
});

// =============================================
// CRON JOB - TOUS LES JOURS À 3H - Vérification des abonnements à expirer (3 jours)
// =============================================
cron.schedule('0 3 * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des abonnements à expirer (3 jours)...`);
  checkSubscriptionExpiry();
});

// =============================================
// CRON JOB - TOUS LES JOURS À 8H - Rappel des visites du jour
// =============================================
cron.schedule('0 8 * * *', () => {
  console.log(`[${new Date().toISOString()}] 📅 Rappel des visites du jour...`);
  sendDailyReminders();
});

// =============================================
// CRON JOB - TOUS LES JOURS À 20H - Rappel des visites de demain
// =============================================
cron.schedule('0 20 * * *', () => {
  console.log(`[${new Date().toISOString()}] 📅 Rappel des visites de demain...`);
  sendDailyReminders();
});

// =============================================
// CRON JOB - TOUS LES JOURS À 23H - Vérification des abonnements expirés
// =============================================
cron.schedule('0 23 * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des abonnements expirés...`);
  checkExpiredSubscriptions();
});

// =============================================
// 🆕 CRON JOB - TOUTES LES 30 MINUTES - Vérification des visites en attente d'aidant
// =============================================
cron.schedule('*/30 * * * *', async () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des visites en attente d'aidant...`);
  try {
    const { getPendingAidantVisits } = require('../services/visit.service');
    const { notifyAdminsForPendingAidant } = require('../services/notification.service');
    
    const pendingVisits = await getPendingAidantVisits();
    
    if (pendingVisits.length > 0) {
      console.log(`📋 ${pendingVisits.length} visite(s) en attente d'aidant`);
      
      for (const visit of pendingVisits) {
        // Vérifier si la notification a déjà été envoyée
        const lastNotified = visit.metadata?.last_aidant_notification;
        const now = new Date();
        
        if (lastNotified) {
          const lastNotifiedDate = new Date(lastNotified);
          const diffMinutes = (now.getTime() - lastNotifiedDate.getTime()) / (1000 * 60);
          
          // Ne pas renvoyer de notification si moins de 30 minutes
          if (diffMinutes < 30) {
            continue;
          }
        }
        
        // Envoyer la notification
        await notifyAdminsForPendingAidant(visit.id, {
          targetName: visit.target_name || visit.patient?.first_name || 'Patient',
          scheduledDate: visit.scheduled_date,
          scheduledTime: visit.scheduled_time,
        });
        
        // Mettre à jour la date de dernière notification
        await supabase
          .from('visites')
          .update({
            metadata: {
              ...(visit.metadata || {}),
              last_aidant_notification: now.toISOString(),
            }
          })
          .eq('id', visit.id);
        
        console.log(`✅ Notification renvoyée pour la visite ${visit.id}`);
      }
    }
  } catch (error) {
    console.error('❌ Erreur vérification visites en attente d\'aidant:', error);
  }
});

// =============================================
// 🆕 CRON JOB - TOUTES LES HEURES - Vérification des commandes en cours (quota)
// =============================================
cron.schedule('0 * * * *', async () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des commandes en cours...`);
  try {
    const { supabase } = require('../services/supabase.service');
    const { checkAidantOrderQuota } = require('../services/order.service');
    
    // Récupérer les commandes en cours depuis plus de 4h (potentiellement abandonnées)
    const fourHoursAgo = new Date();
    fourHoursAgo.setHours(fourHoursAgo.getHours() - 4);
    
    const { data: stuckOrders, error } = await supabase
      .from('commandes')
      .select('id, aidant_id, taken_at')
      .eq('status', 'en_cours')
      .lt('taken_at', fourHoursAgo.toISOString());
    
    if (error) {
      console.error('❌ Erreur récupération commandes bloquées:', error);
      return;
    }
    
    if (stuckOrders && stuckOrders.length > 0) {
      console.log(`⚠️ ${stuckOrders.length} commande(s) bloquée(s) depuis plus de 4h`);
      
      for (const order of stuckOrders) {
        // Récupérer l'aidant
        const { data: aidant } = await supabase
          .from('aidants')
          .select('user_id')
          .eq('id', order.aidant_id)
          .single();
        
        if (aidant) {
          // Décrémenter le quota
          const { decrementAidantOrders } = require('../services/order.service');
          await decrementAidantOrders(aidant.user_id);
          
          // Mettre à jour la commande
          await supabase
            .from('commandes')
            .update({
              status: 'disponible',
              updated_at: new Date().toISOString(),
              metadata: {
                auto_released: true,
                released_at: new Date().toISOString(),
              }
            })
            .eq('id', order.id);
          
          console.log(`✅ Commande ${order.id} libérée automatiquement`);
        }
      }
    }
  } catch (error) {
    console.error('❌ Erreur vérification commandes bloquées:', error);
  }
});

// =============================================
// 🆕 CRON JOB - TOUS LES JOURS À 4H - Nettoyage des visites en attente d'aidant expirées
// =============================================
cron.schedule('0 4 * * *', async () => {
  console.log(`[${new Date().toISOString()}] 🔄 Nettoyage des visites en attente d'aidant expirées...`);
  try {
    const { supabase } = require('../services/supabase.service');
    const { createNotification } = require('../services/notification.service');
    
    // Visites en attente d'aidant depuis plus de 48h
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    
    const { data: expiredVisits, error } = await supabase
      .from('visites')
      .select('*')
      .eq('status', 'en_attente_aidant')
      .lt('created_at', twoDaysAgo.toISOString());
    
    if (error) {
      console.error('❌ Erreur récupération visites expirées:', error);
      return;
    }
    
    if (expiredVisits && expiredVisits.length > 0) {
      console.log(`🗑️ ${expiredVisits.length} visite(s) en attente d'aidant expirée(s)`);
      
      for (const visit of expiredVisits) {
        await supabase
          .from('visites')
          .update({
            status: 'expire',
            metadata: {
              ...(visit.metadata || {}),
              expired_reason: 'waiting_aidant_timeout',
              expired_at: new Date().toISOString(),
            }
          })
          .eq('id', visit.id);
        
        // Notification à la famille
        await createNotification({
          userId: visit.user_id,
          title: '⏰ Visite expirée - Aucun aidant disponible',
          body: `Votre visite pour ${visit.target_name || 'le patient'} a expirée car aucun aidant n'était disponible. Veuillez contacter l'administration.`,
          type: 'visite',
          data: {
            visit_id: visit.id,
            status: 'expire',
          },
        });
      }
    }
  } catch (error) {
    console.error('❌ Erreur nettoyage visites expirées:', error);
  }
});

// =============================================
// LOG DE DÉMARRAGE
// =============================================
console.log('✅ Scheduler démarré avec les jobs suivants:');
console.log('  - Nettoyage des brouillons expirés (toutes les heures)');
console.log('  - Auto-validation des commandes (toutes les heures)');
console.log('  - Vérification des visites non approuvées (toutes les heures)');
console.log('  - Vérification des commandes sans réponse (toutes les 15min)');
console.log('  - Vérification des visites manquées (toutes les heures)');
console.log('  - Rappel 1h avant les visites (toutes les heures)');
console.log('  - Nettoyage des assignations expirées (tous les jours à 1h)');
console.log('  - Nettoyage des notifications (tous les jours à 2h)');
console.log('  - Rappel des visites (8h et 20h)');
console.log('  - Vérification des abonnements expirés (23h)');
console.log('  - Vérification des abonnements à expirer (3h)');
console.log('  🆕 Vérification des visites en attente d\'aidant (toutes les 30min)');
console.log('  🆕 Vérification des commandes bloquées (toutes les heures)');
console.log('  🆕 Nettoyage des visites en attente d\'aidant expirées (tous les jours à 4h)');

// =============================================
// EXPORT POUR LES TESTS
// =============================================
module.exports = {
  cron,
  autoValidateOrders,
  checkUnapprovedVisits,
  checkUnansweredOrders,
  sendDailyReminders,
  sendHourReminder,
  checkSubscriptionExpiry,
  checkExpiredSubscriptions,
  checkMissedVisits,
  cleanExpiredAssignments,
  cleanExpiredDrafts,
  cleanupOldNotifications,
  cleanupInactiveTokens,
};
