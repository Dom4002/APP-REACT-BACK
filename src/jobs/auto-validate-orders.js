// 📁 backend/src/jobs/auto-validate-orders.js

const { supabase } = require('../services/supabase.service');
const { createNotification } = require('../services/notification.service');
const { decrementOrder } = require('../services/visitPayment.service');

// ============================================================
// CONSTANTES
// ============================================================

const AUTO_VALIDATION_HOURS = 12;
const BATCH_SIZE = 50;

// ============================================================
// FONCTION PRINCIPALE
// ============================================================

/**
 * Auto-valide les commandes livrées depuis plus de 12h
 * @returns {Promise<Object>} - Résultat de l'opération
 */
const autoValidateOrders = async () => {
  console.log(`🔄 [${new Date().toISOString()}] Auto-validation des commandes...`);

  try {
    const now = new Date();
    const autoValidationThreshold = new Date(now);
    autoValidationThreshold.setHours(autoValidationThreshold.getHours() - AUTO_VALIDATION_HOURS);

    // ✅ Récupérer les commandes livrées depuis plus de 12h
    const { data: orders, error } = await supabase
      .from('commandes')
      .select(`
        *,
        family:profiles!commandes_family_id_fkey(
          id,
          full_name,
          email
        )
      `)
      .eq('status', 'livree')
      .lt('updated_at', autoValidationThreshold.toISOString())
      .is('auto_validation_at', null)
      .limit(BATCH_SIZE);

    if (error) {
      console.error('❌ Erreur récupération commandes:', error);
      return { success: false, error: error.message };
    }

    if (!orders || orders.length === 0) {
      console.log('ℹ️ Aucune commande à auto-valider');
      return { success: true, validated: 0 };
    }

    console.log(`📦 ${orders.length} commandes à auto-valider`);

    let validated = 0;
    let errors = 0;

    for (const order of orders) {
      try {
        // ✅ Vérifier que 12h se sont écoulées depuis la livraison
        const deliveredAt = new Date(order.metadata?.delivered_at || order.updated_at);
        const diffHours = (now.getTime() - deliveredAt.getTime()) / (1000 * 60 * 60);

        if (diffHours < AUTO_VALIDATION_HOURS) {
          console.log(`⏳ Commande ${order.id}: ${Math.round(AUTO_VALIDATION_HOURS - diffHours)}h restantes`);
          continue;
        }

        // ✅ Mettre à jour la commande
        const { data: updatedOrder, error: updateError } = await supabase
          .from('commandes')
          .update({
            status: 'validee',
            is_auto_validated: true,
            updated_at: new Date().toISOString(),
            metadata: {
              ...(order.metadata || {}),
              auto_validated_at: new Date().toISOString(),
              auto_validation_delay: AUTO_VALIDATION_HOURS,
            },
          })
          .eq('id', order.id)
          .select()
          .single();

        if (updateError) {
          console.error(`❌ Erreur validation commande ${order.id}:`, updateError);
          errors++;
          continue;
        }

        // ✅ Décompter de l'abonnement si nécessaire
        const isPonctual = order.order_type === 'ponctual' || order.metadata?.ponctual_mode === true;
        const wasPaid = order.is_paid === true;

        if (!isPonctual || !wasPaid) {
          if (order.subscription_id) {
            const result = await decrementOrder(order.subscription_id);
            if (result.success) {
              console.log(`✅ Commande ${order.id} décomptée de l'abonnement ${order.subscription_id}`);
            } else {
              console.warn(`⚠️ Échec décompte commande ${order.id}:`, result.error);
            }
          }
        }

        // ✅ Notification à la famille
        if (order.family_id) {
          await createNotification({
            userId: order.family_id,
            title: '✅ Commande auto-validée',
            body: `Votre commande "${order.description || 'Commande'}" a été automatiquement validée.`,
            type: 'commande',
            data: {
              order_id: order.id,
              status: 'validee',
              auto_validated: true,
            },
          });
        }

        validated++;
        console.log(`✅ Commande ${order.id} auto-validée`);

      } catch (error) {
        console.error(`❌ Erreur traitement commande ${order.id}:`, error);
        errors++;
      }
    }

    console.log(`✅ Auto-validation terminée: ${validated} validées, ${errors} erreurs`);

    return {
      success: true,
      validated,
      errors,
      total: orders.length,
    };
  } catch (error) {
    console.error('❌ autoValidateOrders error:', error);
    return { success: false, error: error.message };
  }
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = { autoValidateOrders };
