// 📁 backend/src/jobs/clean-expired-visits.js
 
const { cleanExpiredDrafts } = require('../services/visitPayment.service');

const runVisitCleanupJob = async () => {
  const startTime = Date.now();
  console.log('⏰ [Cron Job] Démarrage du script d\'expiration des brouillons de visites (Délai 24h)...');

  try {
    // Appelle la fonction de nettoyage du service financier des visites
    const expiredCount = await cleanExpiredDrafts();

    const duration = Date.now() - startTime;
    if (expiredCount > 0) {
      console.log(`✅ [Cron Job] Succès : ${expiredCount} brouillon(s) de visite expiré(s) ont été archivé(s) (${duration}ms).`);
    } else {
      console.log(`ℹ️ [Cron Job] Terminé : Aucun brouillon en souffrance à expirer (${duration}ms).`);
    }
  } catch (error) {
    console.error('❌ [Cron Job] Erreur lors de l\'expiration des visites en brouillon:', error.message);
  }
};

// Exécuter le job immédiatement si lancé directement en ligne de commande
if (require.main === module) {
  runVisitCleanupJob()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runVisitCleanupJob };
