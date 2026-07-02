// 📁 backend/src/jobs/clean-drafts.job.js

const cron = require('node-cron');
const { cleanExpiredDrafts } = require('../services/visitPayment.service');

// ✅ Nettoyer les brouillons expirés toutes les heures
cron.schedule('0 * * * *', async () => {
  console.log(`🔄 [${new Date().toISOString()}] Nettoyage des brouillons expirés...`);
  try {
    const count = await cleanExpiredDrafts();
    console.log(`✅ ${count || 0} brouillons expirés nettoyés`);
  } catch (error) {
    console.error('❌ Erreur nettoyage brouillons:', error);
  }
});

console.log('✅ Job de nettoyage des brouillons démarré (toutes les heures)');

module.exports = { cleanExpiredDrafts };
