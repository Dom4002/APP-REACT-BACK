// 📁 backend/src/jobs/reminder.job.js

const cron = require('node-cron');
const {
  sendDailyReminders,
  sendHourReminder,
  checkSubscriptionExpiry,
  checkExpiredSubscriptions,
  checkMissedVisits,
  checkUnapprovedVisits,
} = require('../services/reminder.service');

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
    
    // 5. ✅ Vérification des visites non approuvées (24h)
    console.log('📅 Vérification des visites non approuvées...');
    await checkUnapprovedVisits();
    
    console.log('✅ Tous les jobs sont terminés');
  } catch (error) {
    console.error('❌ Erreur lors des jobs:', error);
  }
};

// =============================================
// CRON JOB - Toutes les heures
// =============================================
const runHourlyJob = async () => {
  console.log('🔄 Job horaire...');
  try {
    await sendHourReminder();
    await checkMissedVisits();
    await checkUnapprovedVisits();
    console.log('✅ Job horaire terminé');
  } catch (error) {
    console.error('❌ Erreur job horaire:', error);
  }
};

// =============================================
// CRON JOB - Tous les jours à 8h
// =============================================
const runDailyJob = async () => {
  console.log('🔄 Job quotidien...');
  try {
    await sendDailyReminders();
    await checkSubscriptionExpiry();
    await checkExpiredSubscriptions();
    await checkUnapprovedVisits();
    console.log('✅ Job quotidien terminé');
  } catch (error) {
    console.error('❌ Erreur job quotidien:', error);
  }
};

// =============================================
// SCHEDULER - Lancement automatique des jobs
// =============================================
const startScheduler = () => {
  console.log('🚀 Démarrage du scheduler...');

  // ⏰ Toutes les heures - Vérification des visites non approuvées
  cron.schedule('0 * * * *', () => {
    console.log(`🔄 [${new Date().toISOString()}] Job horaire - Visites non approuvées...`);
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

  console.log('✅ Scheduler démarré avec succès');
  console.log('📋 Jobs planifiés:');
  console.log('   - Toutes les heures: Vérification des visites non approuvées');
  console.log('   - 8h: Rappels des visites du jour');
  console.log('   - 20h: Rappels des visites du lendemain');
  console.log('   - 23h: Vérification des abonnements expirés');
};

// =============================================
// EXPORTS
// =============================================
module.exports = {
  runAllJobs,
  runHourlyJob,
  runDailyJob,
  startScheduler,
};
