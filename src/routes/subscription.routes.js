// 📁 backend/src/routes/subscription.routes.js
 

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { createNotification } = require('../services/notification.service');

router.use(authMiddleware);

// =============================================
// CONSTANTES
// =============================================

const getPonctualPrice = (durationMinutes) => {
  const prices = {
    '30': 5000,
    '45': 6000,
    '60': 7500,
    '90': 10000,
    '120': 12500,
  };
  const duration = durationMinutes || 60;
  const price = prices[duration.toString()];
  if (price) return price;
  return Math.round((duration / 60) * 7500);
};

// =============================================
// RÉCUPÉRER LES ABONNEMENTS DE L'UTILISATEUR
// =============================================
router.get('/my', async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('abonnements')
      .select(`
        *,
        offre:offres(*)
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // ✅ Calculer les visites et commandes restantes
    const subscriptions = data?.map(sub => ({
      ...sub,
      remaining_visits: Math.max(0, (sub.total_visits || 0) - (sub.used_visits || 0)),
      remaining_orders: Math.max(0, (sub.total_orders || 0) - (sub.used_orders || 0)),
      is_active: sub.status === 'actif' && new Date(sub.end_date) > new Date(),
    })) || [];

    res.json(subscriptions);
  } catch (error) {
    console.error('❌ Get subscriptions error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ VÉRIFIER SI L'UTILISATEUR A UN ABONNEMENT ACTIF
// =============================================
router.get('/active', async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('abonnements')
      .select(`
        *,
        offre:offres(*)
      `)
      .eq('user_id', userId)
      .eq('status', 'actif')
      .gte('end_date', new Date().toISOString().split('T')[0])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    res.json({
      success: true,
      hasActiveSubscription: !!data,
      subscription: data ? {
        ...data,
        remaining_visits: Math.max(0, (data.total_visits || 0) - (data.used_visits || 0)),
        remaining_orders: Math.max(0, (data.total_orders || 0) - (data.used_orders || 0)),
      } : null,
    });
  } catch (error) {
    console.error('❌ Check active subscription error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// CRÉER UN ABONNEMENT
// =============================================
router.post('/', async (req, res) => {
  try {
    const { offreId, patientId } = req.body;
    const userId = req.user.id;

    // ✅ Vérifier que l'offre existe
    const { data: offre, error: offreError } = await supabase
      .from('offres')
      .select('*')
      .eq('id', offreId)
      .single();

    if (offreError) throw offreError;

    // ✅ Vérifier qu'il n'y a pas déjà un abonnement actif
    const { data: existing, error: existingError } = await supabase
      .from('abonnements')
      .select('id, status')
      .eq('user_id', userId)
      .eq('status', 'actif')
      .gte('end_date', new Date().toISOString().split('T')[0])
      .maybeSingle();

    if (!existingError && existing) {
      return res.status(400).json({
        error: 'Vous avez déjà un abonnement actif',
        existing_subscription_id: existing.id,
      });
    }

    // ✅ Calculer les dates et les totaux
    const startDate = new Date();
    const endDate = new Date();

    let totalVisits = offre.total_visits || offre.visits_per_month || 0;
    let totalOrders = offre.total_orders || 0;

    switch (offre.type) {
      case 'mensuelle':
        endDate.setMonth(endDate.getMonth() + 1);
        totalVisits = totalVisits || offre.visits_per_week * 4 || 0;
        totalOrders = totalOrders || 4;
        break;
      case 'trimestrielle':
        endDate.setMonth(endDate.getMonth() + 3);
        totalVisits = (totalVisits || offre.visits_per_week * 4 || 0) * 3;
        totalOrders = totalOrders * 3 || 12;
        break;
      case 'semestrielle':
        endDate.setMonth(endDate.getMonth() + 6);
        totalVisits = (totalVisits || offre.visits_per_week * 4 || 0) * 6;
        totalOrders = totalOrders * 6 || 24;
        break;
      case 'annuelle':
        endDate.setFullYear(endDate.getFullYear() + 1);
        totalVisits = (totalVisits || offre.visits_per_week * 4 || 0) * 12;
        totalOrders = totalOrders * 12 || 48;
        break;
      default:
        endDate.setMonth(endDate.getMonth() + 1);
        totalVisits = totalVisits || offre.visits_per_week * 4 || 0;
        totalOrders = totalOrders || 4;
    }

    // ✅ Créer l'abonnement
    const { data: subscription, error } = await supabase
      .from('abonnements')
      .insert({
        user_id: userId,
        patient_id: patientId || null,
        offre_id: offreId,
        status: 'actif',
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        auto_renew: true,
        total_visits: totalVisits,
        used_visits: 0,
        remaining_visits: totalVisits,
        total_orders: totalOrders,
        used_orders: 0,
        remaining_orders: totalOrders,
        preferred_days: ['monday', 'wednesday', 'friday'],
        auto_schedule: true,
      })
      .select(`
        *,
        offre:offres(*)
      `)
      .single();

    if (error) throw error;

    // ✅ Notification
    await createNotification({
      userId,
      title: '✅ Abonnement activé',
      body: `Votre abonnement ${offre.name} est actif. Vous disposez de ${totalVisits} visites et ${totalOrders} commandes.`,
      type: 'paiement',
      data: { subscription_id: subscription.id },
    });

    res.status(201).json({ 
      success: true, 
      subscription: {
        ...subscription,
        remaining_visits: totalVisits,
        remaining_orders: totalOrders,
      }
    });
  } catch (error) {
    console.error('❌ Create subscription error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ DÉCOMPTER UNE VISITE (AVEC VÉRIFICATION)
// =============================================
router.post('/:id/use-visit', async (req, res) => {
  try {
    const { id } = req.params;
    const { visitId, isPonctual, wasPaid } = req.body;

    const { data: subscription, error: fetchError } = await supabase
      .from('abonnements')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    if (subscription.status !== 'actif') {
      return res.status(400).json({ error: 'Abonnement non actif' });
    }

    if (subscription.remaining_visits <= 0) {
      return res.status(400).json({ error: 'Plus de visites disponibles' });
    }

    // ✅ Si visite ponctuelle payée, NE PAS DÉCOMPTER
    if (isPonctual && wasPaid) {
      console.log(`ℹ️ Visite ponctuelle payée - Pas de décompte pour l'abonnement ${id}`);
      return res.json({ 
        success: true, 
        subscription,
        message: 'Visite ponctuelle payée - Pas de décompte',
        decremented: false,
      });
    }

    const { data, error } = await supabase
      .from('abonnements')
      .update({
        used_visits: subscription.used_visits + 1,
        remaining_visits: subscription.remaining_visits - 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select(`
        *,
        offre:offres(*)
      `)
      .single();

    if (error) throw error;

    // ✅ Notification si plus de visites
    if (data.remaining_visits === 0) {
      await createNotification({
        userId: subscription.user_id,
        title: '⚠️ Plus de visites disponibles',
        body: 'Votre abonnement a atteint le nombre maximum de visites. Pensez à renouveler.',
        type: 'system',
        data: { subscription_id: data.id },
      });
    }

    // ✅ Notification du décompte
    if (data.remaining_visits > 0) {
      await createNotification({
        userId: subscription.user_id,
        title: '📊 Visite décomptée',
        body: `Il vous reste ${data.remaining_visits} visite(s) sur votre abonnement.`,
        type: 'system',
        data: { subscription_id: data.id, remaining: data.remaining_visits },
      });
    }

    res.json({ 
      success: true, 
      subscription: data,
      decremented: true,
    });
  } catch (error) {
    console.error('❌ Use visit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ DÉCOMPTER UNE COMMANDE (AVEC VÉRIFICATION)
// =============================================
router.post('/:id/use-order', async (req, res) => {
  try {
    const { id } = req.params;
    const { orderId, isPonctual, wasPaid } = req.body;

    const { data: subscription, error: fetchError } = await supabase
      .from('abonnements')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    if (subscription.status !== 'actif') {
      return res.status(400).json({ error: 'Abonnement non actif' });
    }

    if (subscription.remaining_orders <= 0) {
      return res.status(400).json({ error: 'Plus de commandes disponibles' });
    }

    // ✅ Si commande ponctuelle payée, NE PAS DÉCOMPTER
    if (isPonctual && wasPaid) {
      console.log(`ℹ️ Commande ponctuelle payée - Pas de décompte pour l'abonnement ${id}`);
      return res.json({ 
        success: true, 
        subscription,
        message: 'Commande ponctuelle payée - Pas de décompte',
        decremented: false,
      });
    }

    const { data, error } = await supabase
      .from('abonnements')
      .update({
        used_orders: subscription.used_orders + 1,
        remaining_orders: subscription.remaining_orders - 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select(`
        *,
        offre:offres(*)
      `)
      .single();

    if (error) throw error;

    // ✅ Notification si plus de commandes
    if (data.remaining_orders === 0) {
      await createNotification({
        userId: subscription.user_id,
        title: '⚠️ Plus de commandes disponibles',
        body: 'Votre abonnement a atteint le nombre maximum de commandes. Pensez à renouveler.',
        type: 'system',
        data: { subscription_id: data.id },
      });
    }

    // ✅ Notification du décompte
    if (data.remaining_orders > 0) {
      await createNotification({
        userId: subscription.user_id,
        title: '📊 Commande décomptée',
        body: `Il vous reste ${data.remaining_orders} commande(s) sur votre abonnement.`,
        type: 'system',
        data: { subscription_id: data.id, remaining: data.remaining_orders },
      });
    }

    res.json({ 
      success: true, 
      subscription: data,
      decremented: true,
    });
  } catch (error) {
    console.error('❌ Use order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ENREGISTRER LES PRÉFÉRENCES DE VISITE
// =============================================
router.post('/:id/preferences', async (req, res) => {
  try {
    const { id } = req.params;
    const { preferred_days, preferred_time } = req.body;
    const userId = req.user.id;

    // ✅ Vérifier que l'abonnement appartient à l'utilisateur
    const { data: subscription, error: subError } = await supabase
      .from('abonnements')
      .select('user_id')
      .eq('id', id)
      .single();

    if (subError) throw subError;
    if (subscription.user_id !== userId) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    // ✅ Enregistrer les préférences
    const { data, error } = await supabase
      .from('subscription_preferences')
      .upsert({
        subscription_id: id,
        preferred_days: preferred_days || ['monday', 'wednesday', 'friday'],
        preferred_time: preferred_time || '09:00',
        is_auto_generated: false,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'subscription_id' })
      .select()
      .single();

    if (error) throw error;

    // ✅ Mettre à jour l'abonnement avec les préférences
    await supabase
      .from('abonnements')
      .update({ 
        preferred_days: preferred_days || ['monday', 'wednesday', 'friday'],
        auto_schedule: false,
      })
      .eq('id', id);

    // ✅ Générer le planning avec les nouvelles préférences
    await supabase.rpc('generate_auto_schedule', { p_subscription_id: id });

    res.json({ success: true, preferences: data });
  } catch (error) {
    console.error('❌ Save preferences error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// RÉCUPÉRER LES PRÉFÉRENCES DE VISITE
// =============================================
router.get('/:id/preferences', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // ✅ Vérifier que l'abonnement appartient à l'utilisateur
    const { data: subscription, error: subError } = await supabase
      .from('abonnements')
      .select('user_id')
      .eq('id', id)
      .single();

    if (subError) throw subError;
    if (subscription.user_id !== userId) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    const { data, error } = await supabase
      .from('subscription_preferences')
      .select('*')
      .eq('subscription_id', id)
      .maybeSingle();

    if (error) throw error;

    res.json(data || {});
  } catch (error) {
    console.error('❌ Get preferences error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// GÉNÉRER LE PLANNING DES VISITES
// =============================================
router.post('/:id/generate-schedule', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // ✅ Vérifier que l'abonnement appartient à l'utilisateur
    const { data: subscription, error: subError } = await supabase
      .from('abonnements')
      .select('*')
      .eq('id', id)
      .single();

    if (subError) throw subError;
    if (subscription.user_id !== userId) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    // ✅ Appeler la fonction de génération de planning
    const { data, error } = await supabase.rpc('generate_auto_schedule', { 
      p_subscription_id: id 
    });

    if (error) throw error;

    // ✅ Récupérer le planning généré
    const { data: planning, error: planningError } = await supabase
      .from('visite_planning')
      .select('*')
      .eq('subscription_id', id)
      .order('scheduled_date', { ascending: true });

    if (planningError) throw planningError;

    res.json({ 
      success: true, 
      message: 'Planning généré avec succès',
      planning,
    });
  } catch (error) {
    console.error('❌ Generate schedule error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// RÉCUPÉRER LE PLANNING DES VISITES
// =============================================
router.get('/:id/planning', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // ✅ Vérifier que l'abonnement appartient à l'utilisateur
    const { data: subscription, error: subError } = await supabase
      .from('abonnements')
      .select('user_id')
      .eq('id', id)
      .single();

    if (subError) throw subError;
    if (subscription.user_id !== userId) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    const { data, error } = await supabase
      .from('visite_planning')
      .select(`
        *,
        visite:visites(*)
      `)
      .eq('subscription_id', id)
      .order('scheduled_date', { ascending: true });

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error('❌ Get planning error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ANNULER UNE VISITE PLANIFIÉE
// =============================================
router.delete('/planning/:planningId', async (req, res) => {
  try {
    const { planningId } = req.params;
    const userId = req.user.id;

    // ✅ Vérifier que la visite planifiée appartient à l'utilisateur
    const { data: planning, error: fetchError } = await supabase
      .from('visite_planning')
      .select(`
        *,
        subscription:abonnements(user_id)
      `)
      .eq('id', planningId)
      .single();

    if (fetchError) throw fetchError;
    if (planning.subscription.user_id !== userId) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    // ✅ Supprimer la visite planifiée
    const { error } = await supabase
      .from('visite_planning')
      .delete()
      .eq('id', planningId);

    if (error) throw error;

    res.json({ success: true, message: 'Visite planifiée annulée' });
  } catch (error) {
    console.error('❌ Delete planning error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ RENOUVELER UN ABONNEMENT (ACTION MANUELLE)
// =============================================
router.post('/:id/renew', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // ✅ Vérifier que l'abonnement appartient à l'utilisateur
    const { data: subscription, error: subError } = await supabase
      .from('abonnements')
      .select('*, offre:offres(*)')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (subError) throw subError;
    if (!subscription) {
      return res.status(404).json({ error: 'Abonnement non trouvé' });
    }

    // ✅ Vérifier que l'abonnement est expiré ou sur le point d'expirer
    const endDate = new Date(subscription.end_date);
    const today = new Date();
    if (endDate > today) {
      return res.status(400).json({ 
        error: 'Cet abonnement est encore actif',
        expires_at: subscription.end_date,
      });
    }

    // ✅ Calculer la nouvelle date de fin
    const offre = subscription.offre;
    const newStartDate = new Date();
    const newEndDate = new Date();

    switch (offre.type) {
      case 'mensuelle':
        newEndDate.setMonth(newEndDate.getMonth() + 1);
        break;
      case 'trimestrielle':
        newEndDate.setMonth(newEndDate.getMonth() + 3);
        break;
      case 'semestrielle':
        newEndDate.setMonth(newEndDate.getMonth() + 6);
        break;
      case 'annuelle':
        newEndDate.setFullYear(newEndDate.getFullYear() + 1);
        break;
      default:
        newEndDate.setMonth(newEndDate.getMonth() + 1);
    }

    // ✅ Mettre à jour l'abonnement
    const { data, error } = await supabase
      .from('abonnements')
      .update({
        status: 'actif',
        start_date: newStartDate.toISOString().split('T')[0],
        end_date: newEndDate.toISOString().split('T')[0],
        used_visits: 0,
        remaining_visits: subscription.total_visits,
        used_orders: 0,
        remaining_orders: subscription.total_orders,
        renewal_count: (subscription.renewal_count || 0) + 1,
        last_renewal_date: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select(`
        *,
        offre:offres(*)
      `)
      .single();

    if (error) throw error;

    // ✅ Notification
    await createNotification({
      userId,
      title: '🔄 Abonnement renouvelé',
      body: `Votre abonnement ${offre.name} a été renouvelé jusqu'au ${newEndDate.toLocaleDateString('fr-FR')}.`,
      type: 'paiement',
      data: { subscription_id: data.id },
    });

    res.json({
      success: true,
      subscription: {
        ...data,
        remaining_visits: data.total_visits,
        remaining_orders: data.total_orders,
      },
    });
  } catch (error) {
    console.error('❌ Renew subscription error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ ANNULER L'AUTO-RENOUVELLEMENT
// =============================================
router.post('/:id/cancel-auto-renew', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('abonnements')
      .update({
        auto_renew: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select(`
        *,
        offre:offres(*)
      `)
      .single();

    if (error) throw error;

    await createNotification({
      userId,
      title: '⏸️ Auto-renouvellement désactivé',
      body: `L'auto-renouvellement de votre abonnement ${data.offre?.name} a été désactivé.`,
      type: 'paiement',
      data: { subscription_id: data.id },
    });

    res.json({ 
      success: true, 
      subscription: data,
      message: 'Auto-renouvellement désactivé',
    });
  } catch (error) {
    console.error('❌ Cancel auto-renew error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
