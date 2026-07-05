// 📁 backend/src/jobs/notification-cleanup.job.js

const cron = require('node-cron');
const { supabase } = require('../services/supabase.service');

// ✅ Nettoyer les notifications lues de plus de 30 jours
const cleanupOldNotifications = async () => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data, error } = await supabase
    .from('notifications')
    .delete()
    .eq('is_read', true)
    .lt('created_at', thirtyDaysAgo.toISOString())
    .select();

  if (error) {
    console.error('❌ Erreur nettoyage notifications:', error);
    return;
  }

  console.log(`🗑️ ${data?.length || 0} anciennes notifications supprimées`);
};

// ✅ Nettoyer les tokens push inactifs
const cleanupInactiveTokens = async () => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data, error } = await supabase
    .from('push_tokens')
    .delete()
    .eq('is_active', false)
    .lt('last_used_at', thirtyDaysAgo.toISOString())
    .select();

  if (error) {
    console.error('❌ Erreur nettoyage tokens:', error);
    return;
  }

  console.log(`🗑️ ${data?.length || 0} tokens inactifs supprimés`);
};

// ✅ Schedule: tous les jours à 2h du matin
cron.schedule('0 2 * * *', async () => {
  console.log(`🔄 [${new Date().toISOString()}] Nettoyage des notifications...`);
  await cleanupOldNotifications();
  await cleanupInactiveTokens();
  console.log(`✅ Nettoyage terminé`);
});

module.exports = {
  cleanupOldNotifications,
  cleanupInactiveTokens,
};
