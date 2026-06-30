// 📁 backend/src/jobs/auto-validate-orders.js

const { supabase } = require('../services/supabase.service');

const autoValidateOrders = async () => {
  const twelveHoursAgo = new Date();
  twelveHoursAgo.setHours(twelveHoursAgo.getHours() - 12);

  const { data: orders, error } = await supabase
    .from('commandes')
    .update({ status: 'validee' })
    .eq('status', 'livree')
    .lt('updated_at', twelveHoursAgo.toISOString())
    .select();

  if (error) {
    console.error('❌ Auto-validate error:', error);
    return;
  }

  console.log(`✅ ${orders?.length || 0} commandes validées automatiquement`);
  return orders;
};

module.exports = { autoValidateOrders };