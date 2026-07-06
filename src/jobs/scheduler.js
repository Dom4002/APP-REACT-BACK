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

// =============================================
// CRON JOB - TOUTES LES HEURES - Nettoyage des brouillons
// =============================================
cron.schedule('0 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Nettoyage des brouillons expirés...`);
  cleanExpiredDrafts();
});

// =============================================
// CRON JOB - TOUTES LES 15 MINUTES
// =============================================

// ✅ Vérification des commandes sans réponse (15min / 30min)
cron.schedule('*/15 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des commandes sans réponse...`);
  checkUnansweredOrders();
});

// =============================================
// CRON JOB - TOUTES LES HEURES
// =============================================

// 1. Auto-validation des commandes (toutes les heures)
cron.schedule('0 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Auto-validation des commandes...`);
  autoValidateOrders();
});

// 2. Vérification des visites non approuvées (24h)
cron.schedule('0 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des visites non approuvées (24h)...`);
  checkUnapprovedVisits();
});

// 3. Vérification des visites manquées (1h après)
cron.schedule('0 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des visites manquées...`);
  checkMissedVisits();
});

// 4. Rappel 1h avant les visites
cron.schedule('0 * * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Envoi des rappels 1h avant...`);
  sendHourReminder();
});

// =============================================
// CRON JOB - TOUS LES JOURS À 1H
// =============================================

// ✅ Nettoyage des assignations expirées (tous les jours à 1h)
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
// CRON JOB - TOUS LES JOURS À 8H
// =============================================
cron.schedule('0 8 * * *', () => {
  console.log(`[${new Date().toISOString()}] 📅 Rappel des visites du jour...`);
  sendDailyReminders();
});

// =============================================
// CRON JOB - TOUS LES JOURS À 20H
// =============================================
cron.schedule('0 20 * * *', () => {
  console.log(`[${new Date().toISOString()}] 📅 Rappel des visites de demain...`);
  sendDailyReminders();
});

// =============================================
// CRON JOB - TOUS LES JOURS À 23H
// =============================================
cron.schedule('0 23 * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des abonnements expirés...`);
  checkExpiredSubscriptions();
});

// =============================================
// CRON JOB - TOUS LES JOURS À 3H
// =============================================
cron.schedule('0 3 * * *', () => {
  console.log(`[${new Date().toISOString()}] 🔄 Vérification des abonnements à expirer (3 jours)...`);
  checkSubscriptionExpiry();
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
console.log('  - Rappel des visites (8h et 20h)');
console.log('  - Vérification des abonnements expirés (23h)');
console.log('  - Vérification des abonnements à expirer (3h)');

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
};
