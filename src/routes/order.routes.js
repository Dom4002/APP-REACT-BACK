// 📁 backend/src/routes/order.routes.js
 
const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { createNotification } = require('../services/notification.service');

router.use(authMiddleware);

// =============================================
// LISTE DES COMMANDES
// =============================================
router.get('/', async (req, res) => {
  try {
    const { user, profile } = req;

    let query = supabase
      .from('commandes')
      .select(`
        *,
        patient:patients(*),
        aidant:aidants(*, user:profiles(*))
      `);

    if (profile.role === 'family') {
      query = query.eq('family_id', user.id);
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();

      if (aidant) {
        query = query.eq('aidant_id', aidant.id);
      } else {
        return res.json([]);
      }
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ GET orders error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ CRÉER UNE COMMANDE - AVEC VÉRIFICATION PAIEMENT
// =============================================
router.post('/', async (req, res) => {
  try {
    console.log('📥 Création commande - Body reçu:', JSON.stringify(req.body, null, 2));
    console.log('📥 Utilisateur ID:', req.user?.id);

    const { 
      patient_id,
      type,
      description,
      address,
      estimated_amount,
      items,
      prescription_url,
      order_type,
      is_paid,
      is_ponctual = false
    } = req.body;

    const { user, profile } = req;

    // ✅ Vérifier les permissions
    if (profile.role === 'aidant') {
      return res.status(403).json({ error: 'Les aidants ne peuvent pas créer de commandes' });
    }

    if (!type) {
      return res.status(400).json({ error: 'Le champ "type" est obligatoire' });
    }
    if (!description) {
      return res.status(400).json({ error: 'Le champ "description" est obligatoire' });
    }
    if (!address) {
      return res.status(400).json({ error: 'Le champ "address" est obligatoire' });
    }

    // ✅ Déterminer le statut initial
    let status = 'creee';
    let requiresPayment = false;

    // ✅ Si mode ponctuel ou pas d'abonnement
    if (is_ponctual || order_type === 'ponctual') {
      status = 'attente_paiement';
      requiresPayment = true;
    }

    // ✅ Vérifier le quota si abonnement
    if (!is_ponctual && patient_id) {
      const { data: subscription } = await supabase
        .from('abonnements')
        .select('id, remaining_orders, status')
        .eq('patient_id', patient_id)
        .eq('status', 'actif')
        .maybeSingle();

      if (subscription && subscription.remaining_orders <= 0) {
        status = 'attente_paiement';
        requiresPayment = true;
      }
    }

    const orderData = {
      patient_id: patient_id || null,
      family_id: user.id,
      type: type,
      description: description,
      address: address,
      estimated_amount: estimated_amount || 0,
      items: items || [],
      prescription_url: prescription_url || null,
      status: status,
      order_type: order_type || (is_ponctual ? 'ponctual' : 'subscription'),
      is_paid: is_paid || false,
      metadata: {
        requires_payment: requiresPayment,
        created_by: user.id,
        created_at: new Date().toISOString(),
      }
    };

    console.log('📦 Données à insérer:', JSON.stringify(orderData, null, 2));

    const { data, error } = await supabase
      .from('commandes')
      .insert(orderData)
      .select('*')
      .single();

    if (error) {
      console.error('❌ Erreur Supabase insertion:', error);
      return res.status(500).json({ error: error.message, details: error });
    }

    console.log('✅ Commande créée avec succès, ID:', data.id);

    let patient = null;
    if (data.patient_id) {
      const { data: patientData } = await supabase
        .from('patients')
        .select('*')
        .eq('id', data.patient_id)
        .single();
      patient = patientData;
    }

    let family = null;
    if (data.family_id) {
      const { data: familyData } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', data.family_id)
        .single();
      family = familyData;
    }

    const fullOrder = {
      ...data,
      patient,
      family,
    };

    // ✅ Notification selon le statut
    if (status === 'attente_paiement') {
      await createNotification({
        userId: user.id,
        title: '💳 Commande en attente de paiement',
        body: `Votre commande "${description}" est en attente de paiement.`,
        type: 'commande',
        data: { order_id: data.id, status: 'attente_paiement' },
      });
    } else {
      // ✅ Notifier l'aidant assigné ou tous les aidants disponibles
      if (data.aidant_id) {
        await createNotification({
          userId: data.aidant_id,
          title: '🛒 Nouvelle commande à prendre',
          body: `Commande de ${family?.full_name || 'un client'} - ${description}`,
          type: 'commande',
          data: { order_id: data.id, action: 'take' },
        });
      } else {
        // ✅ Notifier tous les aidants disponibles
        const { data: aidants } = await supabase
          .from('aidants')
          .select('user_id')
          .eq('available', true)
          .eq('is_verified', true);

        if (aidants && aidants.length > 0) {
          for (const aidant of aidants) {
            await createNotification({
              userId: aidant.user_id,
              title: '🛒 Nouvelle commande disponible',
              body: `Commande de ${family?.full_name || 'un client'} - ${description}`,
              type: 'commande',
              data: { order_id: data.id, action: 'take' },
            });
          }
        }
      }
    }

    res.status(201).json({ success: true, order: fullOrder });
  } catch (error) {
    console.error('❌ Create order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ PRENDRE UNE COMMANDE (par un aidant)
// =============================================
router.post('/:id/take', async (req, res) => {
  try {
    const { id } = req.params;
    const { user } = req;

    const { data: order, error: fetchError } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    if (order.status !== 'creee' && order.status !== 'en_attente') {
      return res.status(400).json({ error: 'Cette commande n\'est pas disponible' });
    }

    // ✅ Vérifier que l'aidant est disponible
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, available, is_verified')
      .eq('user_id', user.id)
      .single();

    if (aidantError || !aidant) {
      return res.status(404).json({ error: 'Aidant non trouvé' });
    }

    if (!aidant.available || !aidant.is_verified) {
      return res.status(403).json({ error: 'Vous n\'êtes pas disponible ou vérifié' });
    }

    // ✅ Si la commande est en attente (visible à tous), prendre en priorité
    // ✅ Si elle est créée, l'aidant assigné la prend
    if (order.status === 'creee' && order.aidant_id && order.aidant_id !== aidant.id) {
      return res.status(403).json({ error: 'Cette commande est déjà assignée à un autre aidant' });
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({
        status: 'en_cours',
        aidant_id: aidant.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    // ✅ Notification à la famille
    if (order.family_id) {
      await createNotification({
        userId: order.family_id,
        title: '✅ Commande prise en charge',
        body: `Un aidant a pris votre commande "${order.description}".`,
        type: 'commande',
        data: { order_id: id, status: 'en_cours' },
      });
    }

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Take order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ CONFIRMER PAIEMENT COMMANDE PONCTUELLE
// =============================================
router.post('/:id/confirm-payment', async (req, res) => {
  try {
    const { id } = req.params;
    const { transaction_id } = req.body;

    const { data: order, error: orderError } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', id)
      .single();

    if (orderError) throw orderError;

    if (order.status !== 'attente_paiement') {
      return res.status(400).json({ error: 'Cette commande n\'est pas en attente de paiement' });
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({
        status: 'creee',
        is_paid: true,
        metadata: {
          ...(order.metadata || {}),
          payment_confirmed_at: new Date().toISOString(),
          transaction_id,
        }
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // ✅ Notifier les aidants disponibles
    const { data: aidants } = await supabase
      .from('aidants')
      .select('user_id')
      .eq('available', true)
      .eq('is_verified', true);

    if (aidants && aidants.length > 0) {
      for (const aidant of aidants) {
        await createNotification({
          userId: aidant.user_id,
          title: '🛒 Nouvelle commande disponible',
          body: `Commande de ${order.family_id} - ${order.description}`,
          type: 'commande',
          data: { order_id: id, action: 'take' },
        });
      }
    }

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ METTRE À JOUR LE STATUT D'UNE COMMANDE
// =============================================
router.post('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    console.log(`📥 Mise à jour statut commande ${id} -> ${status}`);

    if (!status) {
      return res.status(400).json({ error: 'Le champ "status" est obligatoire' });
    }

    const validStatuses = ['creee', 'en_attente', 'en_cours', 'livree', 'validee', 'annulee', 'disponible'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: `Statut invalide. Statuts acceptés: ${validStatuses.join(', ')}` 
      });
    }

    const { data: existingOrder, error: checkError } = await supabase
      .from('commandes')
      .select('status, family_id, aidant_id')
      .eq('id', id)
      .single();

    if (checkError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    if (existingOrder.status === 'validee' || existingOrder.status === 'annulee') {
      return res.status(400).json({ 
        error: `Impossible de modifier une commande ${existingOrder.status}` 
      });
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({ 
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('❌ Erreur mise à jour statut:', error);
      throw error;
    }

    console.log(`✅ Commande ${id} mise à jour -> ${status}`);

    // ✅ Si la commande devient disponible, notifier tous les aidants
    if (status === 'disponible') {
      const { data: aidants } = await supabase
        .from('aidants')
        .select('user_id')
        .eq('available', true)
        .eq('is_verified', true);

      if (aidants && aidants.length > 0) {
        for (const aidant of aidants) {
          await createNotification({
            userId: aidant.user_id,
            title: '🚨 Commande urgente disponible',
            body: `Commande disponible - Premier arrivé, premier servi !`,
            type: 'commande',
            data: { order_id: id, action: 'take', urgency: 'high' },
          });
        }
      }
    }

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Update status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ LIVRER UNE COMMANDE
// =============================================
router.post('/:id/deliver', async (req, res) => {
  try {
    const { id } = req.params;
    const { proof_url } = req.body;

    const { data: existingOrder, error: checkError } = await supabase
      .from('commandes')
      .select('status, family_id')
      .eq('id', id)
      .single();

    if (checkError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    if (existingOrder.status !== 'en_cours') {
      return res.status(400).json({ error: 'Seules les commandes en cours peuvent être livrées' });
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({ 
        status: 'livree',
        proof_url: proof_url || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    // ✅ Notification à la famille
    if (existingOrder.family_id) {
      await createNotification({
        userId: existingOrder.family_id,
        title: '📦 Commande livrée',
        body: `Votre commande a été livrée avec succès !`,
        type: 'commande',
        data: { order_id: id, status: 'livree' },
      });
    }

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Deliver order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ VALIDER UNE COMMANDE (auto ou manuel)
// =============================================
router.post('/:id/validate', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existingOrder, error: checkError } = await supabase
      .from('commandes')
      .select('status, family_id')
      .eq('id', id)
      .single();

    if (checkError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    if (existingOrder.status !== 'livree') {
      return res.status(400).json({ 
        error: 'Seules les commandes livrées peuvent être validées' 
      });
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({ 
        status: 'validee',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    // ✅ Décompter de l'abonnement
    if (data.patient_id) {
      const { data: subscription } = await supabase
        .from('abonnements')
        .select('id, remaining_orders, used_orders, total_orders, user_id')
        .eq('patient_id', data.patient_id)
        .eq('status', 'actif')
        .maybeSingle();

      if (subscription && subscription.remaining_orders > 0) {
        await supabase
          .from('abonnements')
          .update({
            used_orders: subscription.used_orders + 1,
            remaining_orders: subscription.remaining_orders - 1,
            updated_at: new Date().toISOString(),
          })
          .eq('id', subscription.id);
      }
    }

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Validate order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ ANNULER UNE COMMANDE
// =============================================
router.post('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const { user, profile } = req;

    const { data: existingOrder, error: checkError } = await supabase
      .from('commandes')
      .select('status, family_id')
      .eq('id', id)
      .single();

    if (checkError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    // ✅ Seul admin/coord ou famille peuvent annuler
    const canCancel = ['admin', 'coordinator'].includes(profile.role);
    if (!canCancel) {
      if (profile.role === 'family' && existingOrder.family_id !== user.id) {
        return res.status(403).json({ error: 'Non autorisé' });
      }
    }

    if (existingOrder.status === 'validee') {
      return res.status(400).json({ error: 'Impossible d\'annuler une commande validée' });
    }

    if (existingOrder.status === 'annulee') {
      return res.status(400).json({ error: 'Commande déjà annulée' });
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({ 
        status: 'annulee',
        updated_at: new Date().toISOString(),
        metadata: {
          cancelled_by: user.id,
          cancelled_at: new Date().toISOString(),
          cancellation_reason: reason || null,
        }
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    res.json({ success: true, order: data });
  } catch (error) {
    console.error('❌ Cancel order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// RÉCUPÉRER UNE COMMANDE PAR ID
// =============================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, profile } = req;

    const { data, error } = await supabase
      .from('commandes')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Commande non trouvée' });
      }
      throw error;
    }

    if (profile.role === 'family' && data.family_id !== user.id) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();
      
      if (data.aidant_id !== aidant?.id && data.status !== 'disponible') {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }
    }

    let patient = null;
    if (data.patient_id) {
      const { data: patientData } = await supabase
        .from('patients')
        .select('*')
        .eq('id', data.patient_id)
        .single();
      patient = patientData;
    }

    let family = null;
    if (data.family_id) {
      const { data: familyData } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', data.family_id)
        .single();
      family = familyData;
    }

    let aidant = null;
    if (data.aidant_id) {
      const { data: aidantData } = await supabase
        .from('aidants')
        .select('*, user:profiles(*)')
        .eq('id', data.aidant_id)
        .single();
      aidant = aidantData;
    }

    const fullOrder = {
      ...data,
      patient,
      family,
      aidant,
    };

    res.json(fullOrder);
  } catch (error) {
    console.error('❌ Get order error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
