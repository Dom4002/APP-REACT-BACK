// 📁 backend/src/jobs/auto-validate-orders.js
// ✅ SCRIPT DE NETTOYAGE ARRIÈRE-PLAN : AUTO-VALIDATION SÉCURISÉE DES LIVRAISONS CASH APRÈS 48H

const { autoValidateExpiredCashOrders } = require('../services/order.service');

const runAutoValidationJob = async () => {
  const startTime = Date.now();
  console.log('⏰ [Cron Job] Démarrage du script d\'auto-validation des livraisons Cash (Délai 48h)...');

  try {
    // Appelle la routine d'auto-validation du service de commande
    const validatedCount = await autoValidateExpiredCashOrders();

    const duration = Date.now() - startTime;
    if (validatedCount > 0) {
      console.log(`✅ [Cron Job] Succès : ${validatedCount} commande(s) cash expirée(s) ont été validée(s) automatiquement (${duration}ms).`);
    } else {
      console.log(`ℹ️ [Cron Job] Terminé : Aucune livraison cash en attente d'expiration trouvée (${duration}ms).`);
    }
  } catch (error) {
    console.error('❌ [Cron Job] Erreur lors de l\'auto-validation des livraisons Cash:', error.message);
  }
};

// Exécuter le job immédiatement si lancé directement en ligne de commande
if (require.main === module) {
  runAutoValidationJob()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runAutoValidationJob };
