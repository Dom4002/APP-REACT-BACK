// 📁 backend/src/jobs/reminder.job.js

const cron = require('node-cron');
const {
  sendDailyReminders,
  sendHourReminder,
  checkSubscriptionExpiry,
  checkExpiredSubscriptions,
  checkMissedVisits,
  checkUnapprovedVisits,
  checkUnansweredOrders,
} = require('../services/reminder.service');
const { cleanExpiredDrafts } = require('../services/visitPayment.service');
const { autoValidateOrders } = require('./auto-validate-orders');
const { cleanExpiredVisits } = require('./clean-expired-visits');

// =============================================
// EXÉCUTER TOUS LES JOBS
// =============================================
const runAllJobs = async () => {
  console.log('🔄 Début des jobs de rappel...');
  
  try {
    // 1. Rappels des visites du lendemain
    console.log('📅 Envoi des rappels de visite...');
    await sendDailyReminders();
    
    // 2. Vérification des abonnements expirés
    console.log('📅 Vérification des abonnements...');
    await checkExpiredSubscriptions();
    
    // 3. Vérification des visites manquées
    console.log('📅 Vérification des visites manquées...');
    await checkMissedVisits();
    
    // 4. Rappels d'expiration des abonnements
    console.log('📅 Vérification des abonnements à expirer...');
    await checkSubscriptionExpiry();
    
    // 5. Vérification des visites non approuvées (24h)
    console.log('📅 Vérification des visites non approuvées...');
    await checkUnapprovedVisits();

    // 6. ✅ Nettoyage des brouillons expirés
    console.log('📅 Nettoyage des brouillons expirés...');
    await cleanExpiredDrafts();

    // 7. ✅ Auto-validation des commandes
    console.log('📅 Auto-validation des commandes...');
    await autoValidateOrders();

    // 8. ✅ Nettoyage des visites expirées
    console.log('📅 Nettoyage des visites expirées...');
    await cleanExpiredVisits();

    // 9. ✅ Vérification des commandes sans réponse (15min / 30min)
    console.log('📅 Vérification des commandes sans réponse...');
    await checkUnansweredOrders();

    console.log('✅ Tous les jobs sont terminés');
  } catch (error) {
    console.error('❌ Erreur lors des jobs:', error);
  }
};

// =============================================
// CRON JOB - TOUTES LES HEURES
// =============================================
const runHourlyJob = async () => {
  console.log('🔄 Job horaire...');
  try {
    // 1. Rappel 1h avant les visites
    await sendHourReminder();
    
    // 2. Vérification des visites manquées
    await checkMissedVisits();
    
    // 3. Vérification des visites non approuvées (24h)
    await checkUnapprovedVisits();

    // 4. ✅ Auto-validation des commandes
    await autoValidateOrders();

    // 5. ✅ Vérification des commandes sans réponse
    await checkUnansweredOrders();

    // 6. ✅ Nettoyage des brouillons expirés
    await cleanExpiredDrafts();

    console.log('✅ Job horaire terminé');
  } catch (error) {
    console.error('❌ Erreur job horaire:', error);
  }
};

// =============================================
// CRON JOB - TOUS LES JOURS À 8H
// =============================================
const runDailyJob = async () => {
  console.log('🔄 Job quotidien...');
  try {
    // 1. Rappels des visites du jour
    await sendDailyReminders();
    
    // 2. Vérification des abonnements à expirer
    await checkSubscriptionExpiry();
    
    // 3. Vérification des abonnements expirés
    await checkExpiredSubscriptions();
    
    // 4. Vérification des visites non approuvées
    await checkUnapprovedVisits();

    // 5. ✅ Nettoyage des brouillons expirés
    await cleanExpiredDrafts();

    // 6. ✅ Nettoyage des visites expirées
    await cleanExpiredVisits();

    // 7. ✅ Auto-validation des commandes
    await autoValidateOrders();

    console.log('✅ Job quotidien terminé');
  } catch (error) {
    console.error('❌ Erreur job quotidien:', error);
  }
};

// =============================================
// CRON JOB - TOUTES LES 15 MINUTES
// =============================================
const runFifteenMinuteJob = async () => {
  console.log('🔄 Job 15 minutes...');
  try {
    // ✅ Vérification des commandes sans réponse (15min / 30min)
    await checkUnansweredOrders();
    console.log('✅ Job 15 minutes terminé');
  } catch (error) {
    console.error('❌ Erreur job 15 minutes:', error);
  }
};

// =============================================
// SCHEDULER - Lancement automatique des jobs
// =============================================
const startScheduler = () => {
  console.log('🚀 Démarrage du scheduler...');

  // ⏰ Toutes les 15 minutes - Commandes sans réponse
  cron.schedule('*/15 * * * *', () => {
    console.log(`🔄 [${new Date().toISOString()}] Job 15min - Commandes sans réponse...`);
    runFifteenMinuteJob();
  });

  // ⏰ Toutes les heures - Jobs horaires
  cron.schedule('0 * * * *', () => {
    console.log(`🔄 [${new Date().toISOString()}] Job horaire - Visites, commandes, brouillons...`);
    runHourlyJob();
  });

  // ⏰ Tous les jours à 8h - Rappels des visites du jour
  cron.schedule('0 8 * * *', () => {
    console.log(`🔄 [${new Date().toISOString()}] Job quotidien - Rappels des visites...`);
    runDailyJob();
  });

  // ⏰ Tous les jours à 20h - Rappels des visites du lendemain
  cron.schedule('0 20 * * *', () => {
    console.log(`🔄 [${new Date().toISOString()}] Job quotidien - Rappels des visites du lendemain...`);
    sendDailyReminders();
  });

  // ⏰ Tous les jours à 23h - Vérification des abonnements expirés
  cron.schedule('0 23 * * *', () => {
    console.log(`🔄 [${new Date().toISOString()}] Job quotidien - Abonnements expirés...`);
    checkExpiredSubscriptions();
  });

  // ⏰ Tous les jours à 3h - Vérification des abonnements à expirer
  cron.schedule('0 3 * * *', () => {
    console.log(`🔄 [${new Date().toISOString()}] Job quotidien - Abonnements à expirer...`);
    checkSubscriptionExpiry();
  });

  // ⏰ Tous les jours à 2h - Nettoyage des visites expirées
  cron.schedule('0 2 * * *', () => {
    console.log(`🔄 [${new Date().toISOString()}] Job quotidien - Nettoyage des visites expirées...`);
    cleanExpiredVisits();
  });

  // ⏰ Tous les jours à 4h - Nettoyage des brouillons expirés
  cron.schedule('0 4 * * *', () => {
    console.log(`🔄 [${new Date().toISOString()}] Job quotidien - Nettoyage des brouillons expirés...`);
    cleanExpiredDrafts();
  });

  console.log('✅ Scheduler démarré avec succès');
  console.log('📋 Jobs planifiés:');
  console.log('   - */15: Commandes sans réponse');
  console.log('   - 0 *: Jobs horaires (visites, commandes, brouillons)');
  console.log('   - 8h: Rappels des visites du jour');
  console.log('   - 20h: Rappels des visites du lendemain');
  console.log('   - 23h: Abonnements expirés');
  console.log('   - 3h: Abonnements à expirer');
  console.log('   - 2h: Nettoyage des visites expirées');
  console.log('   - 4h: Nettoyage des brouillons expirés');
};

// =============================================
// EXPORTS
// =============================================
module.exports = {
  runAllJobs,
  runHourlyJob,
  runDailyJob,
  runFifteenMinuteJob,
  startScheduler,
  autoValidateOrders,
  cleanExpiredVisits,
};
