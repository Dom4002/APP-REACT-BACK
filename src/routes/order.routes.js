// 📁 backend/src/routes/order.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { createNotification } = require('../services/notification.service');
const { getActiveAidantForTarget } = require('../services/aidantAssignment.service');

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
      // ✅ Récupérer les commandes de la famille (personnelles + patients)
      query = query.eq('user_id', user.id);
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
// ✅ CRÉER UNE COMMANDE - AVEC ASSIGNATION AUTOMATIQUE DE L'AIDANT
// =============================================
router.post('/', async (req, res) => {
  try {
    console.log('📥 Création commande - Body reçu:', JSON.stringify(req.body, null, 2));
    console.log('📥 Utilisateur ID:', req.user?.id);

    const { 
      patient_id,
      target_type,          // ✅ 'personal' | 'patient'
      target_name,          // ✅ Nom à afficher
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

    // ✅ Déterminer target_type et target_name
    const finalTargetType = target_type || (patient_id ? 'patient' : 'personal');
    const finalTargetName = target_name || (patient_id ? null : profile.full_name);
    const familyId = user.id;

    // ✅ Déterminer le statut initial
    let status = 'creee';
    let requiresPayment = false;

    // ✅ Si mode ponctuel
    if (is_ponctual || order_type === 'ponctual') {
      status = 'attente_paiement';
      requiresPayment = true;
    }

    // ✅ Vérifier le quota sur le compte (pas sur le patient)
    if (!is_ponctual) {
      const { data: subscription } = await supabase
        .from('abonnements')
        .select('id, remaining_orders, status')
        .eq('user_id', user.id)   // ✅ LIÉ AU COMPTE
        .eq('status', 'actif')
        .maybeSingle();

      if (!subscription || subscription.remaining_orders <= 0) {
        status = 'attente_paiement';
        requiresPayment = true;
      }
    }

    // ✅ DÉTERMINER L'AIDANT À ASSIGNER (si pas ponctuel et pas en attente paiement)
    let finalAidantId = null;

    if (status !== 'attente_paiement') {
      // Utiliser le service d'assignation pour trouver l'aidant actif
      const targetTypeForAidant = patient_id ? 'patient' : 'personal_account';
      const targetIdForAidant = patient_id || user.id;
      
      finalAidantId = await getActiveAidantForTarget(
        targetTypeForAidant,
        targetIdForAidant,
        familyId
      );

      if (finalAidantId) {
        console.log(`✅ Aidant automatique trouvé pour la commande: ${finalAidantId}`);
      } else {
        console.log(`ℹ️ Aucun aidant actif trouvé pour la cible ${targetTypeForAidant}/${targetIdForAidant}`);
      }
    }

    const orderData = {
      user_id: user.id,              // ✅ COMPTE QUI PASSE LA COMMANDE
      patient_id: patient_id || null, // ✅ NULL si personnel
      target_type: finalTargetType,
      target_name: finalTargetName,
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
      aidant_id: finalAidantId,  // ✅ Aidant automatique ou null
      metadata: {
        requires_payment: requiresPayment,
        created_by: user.id,
        created_at: new Date().toISOString(),
        auto_assigned_aidant: !!finalAidantId,
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
    const targetDisplay = finalTargetName || (patient ? `${patient.first_name} ${patient.last_name}` : 'Personnel');

    if (status === 'attente_paiement') {
      await createNotification({
        userId: user.id,
        title: '💳 Commande en attente de paiement',
        body: `Votre commande "${description}" pour ${targetDisplay} est en attente de paiement.`,
        type: 'commande',
        data: { order_id: data.id, status: 'attente_paiement' },
      });
    } else {
      // ✅ Si un aidant a été assigné automatiquement
      if (finalAidantId) {
        await createNotification({
          userId: finalAidantId,
          title: '🛒 Nouvelle commande assignée automatiquement',
          body: `Commande de ${targetDisplay} - ${description}`,
          type: 'commande',
          data: { order_id: data.id, action: 'take', auto_assigned: true },
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
              body: `Commande de ${targetDisplay} - ${description}`,
              type: 'commande',
              data: { order_id: data.id, action: 'take' },
            });
          }
        }
      }
    }

    res.status(201).json({
      success: true,
      order: fullOrder,
      auto_assigned_aidant: !!finalAidantId,
    });
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
    const targetDisplay = order.target_name || (order.patient ? `${order.patient.first_name} ${order.patient.last_name}` : 'Personnel');

    if (order.family_id) {
      await createNotification({
        userId: order.family_id,
        title: '✅ Commande prise en charge',
        body: `Un aidant a pris votre commande "${order.description}" pour ${targetDisplay}.`,
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

    // ✅ Récupérer l'aidant actif après paiement
    const targetType = order.patient_id ? 'patient' : 'personal_account';
    const targetId = order.patient_id || order.user_id;
    const familyId = order.family_id || order.user_id;

    let aidantId = order.aidant_id || null;
    if (!aidantId) {
      aidantId = await getActiveAidantForTarget(targetType, targetId, familyId);
      console.log(`✅ Aidant trouvé après paiement de la commande: ${aidantId}`);
    }

    const { data, error } = await supabase
      .from('commandes')
      .update({
        status: 'creee',
        is_paid: true,
        aidant_id: aidantId,  // ✅ Assigner l'aidant si trouvé
        metadata: {
          ...(order.metadata || {}),
          payment_confirmed_at: new Date().toISOString(),
          transaction_id,
          aidant_assigned_after_payment: !!aidantId,
        }
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // ✅ Si un aidant a été trouvé, le notifier directement
    if (aidantId) {
      await createNotification({
        userId: aidantId,
        title: '🛒 Nouvelle commande à prendre',
        body: `Commande de ${order.target_name || 'un client'} - ${order.description}`,
        type: 'commande',
        data: { order_id: id, action: 'take', assigned_after_payment: true },
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
            body: `Commande de ${order.target_name || 'un client'} - ${order.description}`,
            type: 'commande',
            data: { order_id: id, action: 'take' },
          });
        }
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
      .select('status, family_id, aidant_id, user_id, target_name')
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
        const targetDisplay = existingOrder.target_name || 'un client';
        for (const aidant of aidants) {
          await createNotification({
            userId: aidant.user_id,
            title: '🚨 Commande urgente disponible',
            body: `Commande pour ${targetDisplay} - Premier arrivé, premier servi !`,
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
      .select('status, family_id, target_name')
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
    const targetDisplay = existingOrder.target_name || 'un client';

    if (existingOrder.family_id) {
      await createNotification({
        userId: existingOrder.family_id,
        title: '📦 Commande livrée',
        body: `Votre commande pour ${targetDisplay} a été livrée avec succès !`,
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
// ✅ VALIDER UNE COMMANDE (avec décompte)
// =============================================
router.post('/:id/validate', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existingOrder, error: checkError } = await supabase
      .from('commandes')
      .select('status, family_id, user_id, patient_id')
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

    // ✅ Décompter de l'abonnement (sur le compte, pas le patient)
    const { data: subscription, error: subError } = await supabase
      .from('abonnements')
      .select('id, remaining_orders, used_orders, total_orders, user_id')
      .eq('user_id', data.user_id)   // ✅ LIÉ AU COMPTE
      .eq('status', 'actif')
      .maybeSingle();

    if (subscription && !subError && subscription.remaining_orders > 0) {
      await supabase
        .from('abonnements')
        .update({
          used_orders: subscription.used_orders + 1,
          remaining_orders: subscription.remaining_orders - 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', subscription.id);

      // ✅ Notification si plus de commandes
      if (subscription.remaining_orders - 1 === 0) {
        await createNotification({
          userId: subscription.user_id,
          title: '⚠️ Plus de commandes disponibles',
          body: 'Votre abonnement a atteint le nombre maximum de commandes.',
          type: 'system',
          data: { subscription_id: subscription.id },
        });
      }
    }

    // ✅ Notification à la famille
    const targetDisplay = data.target_name || 'un client';

    if (data.family_id) {
      await createNotification({
        userId: data.family_id,
        title: '✅ Commande validée',
        body: `La commande pour ${targetDisplay} a été validée.`,
        type: 'commande',
        data: { order_id: id, status: 'validee' },
      });
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
      .select('status, family_id, user_id')
      .eq('id', id)
      .single();

    if (checkError) {
      return res.status(404).json({ error: 'Commande non trouvée' });
    }

    // ✅ Seul admin/coord ou famille peuvent annuler
    const canCancel = ['admin', 'coordinator'].includes(profile.role);
    if (!canCancel) {
      if (profile.role === 'family' && existingOrder.user_id !== user.id) {
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

    // ✅ Vérification d'accès
    let hasAccess = false;

    if (['admin', 'coordinator'].includes(profile.role)) {
      hasAccess = true;
    } else if (profile.role === 'family') {
      hasAccess = data.user_id === user.id;
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();
      
      if (aidant) {
        hasAccess = data.aidant_id === aidant.id || data.status === 'disponible';
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Accès non autorisé' });
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
