// 📁 backend/src/services/visitPayment.service.js
 
const { supabase } = require('./supabase.service');
const { createNotification } = require('./notification.service');

// ============================================================
// CONSTANTES - SOURCE UNIQUE DE VÉRITÉ
// ============================================================

const VISIT_STATUS = {
  DRAFT: 'brouillon',
  PLANNED: 'planifiee',
  PENDING: 'en_attente',
  ACCEPTED: 'acceptee',
  IN_PROGRESS: 'en_cours',
  COMPLETED: 'terminee',
  VALIDATED: 'validee',
  CANCELLED: 'annulee',
  REFUSED: 'refusee',
  EXPIRED: 'expire',
};

const VISIT_PAYMENT_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REFUNDED: 'refunded',
};

// ✅ PRIX DES VISITES PONCTUELLES - SOURCE UNIQUE
const VISIT_PONCTUAL_PRICES = {
  '30': 5000,
  '45': 6000,
  '60': 7500,
  '90': 10000,
  '120': 12500,
};

const DEFAULT_VISIT_PRICE = 7500;
const DRAFT_EXPIRY_HOURS = 24;

// ✅ EXPORTER LES CONSTANTES
module.exports.VISIT_PONCTUAL_PRICES = VISIT_PONCTUAL_PRICES;
module.exports.DEFAULT_VISIT_PRICE = DEFAULT_VISIT_PRICE;

/**
 * Calcule le prix d'une visite ponctuelle en fonction de sa durée
 * @param {number} durationMinutes - Durée en minutes (30, 45, 60, 90, 120)
 * @returns {number} Prix en FCFA
 */
const getVisitPrice = (durationMinutes = 60) => {
  const price = VISIT_PONCTUAL_PRICES[durationMinutes.toString()];
  if (price) return price;
  return Math.round((durationMinutes / 60) * DEFAULT_VISIT_PRICE);
};

module.exports.getVisitPrice = getVisitPrice;

 
/**
 * Vérifie si un paiement est requis pour une visite
 * @param {string} userId - ID de l'utilisateur
 * @param {boolean} isPonctual - Si la visite est marquée comme ponctuelle
 * @param {number} durationMinutes - Durée de la visite
 * @returns {Promise<{requiresPayment: boolean, status: string, amount: number}>}
 */
const requiresPayment = async (userId, isPonctual, durationMinutes) => {
  // ✅ CAS 1 : Visite explicitement ponctuelle → Paiement requis
  if (isPonctual) {
    return { 
      requiresPayment: true, 
      status: VISIT_STATUS.DRAFT,
      amount: getVisitPrice(durationMinutes)
    };
  }

  // ✅ CAS 2 : Vérifier l'abonnement
  const { data: subscription, error } = await supabase
    .from('abonnements')
    .select('id, remaining_visits, status')
    .eq('user_id', userId)
    .eq('status', 'actif')
    .maybeSingle();

  if (error || !subscription || subscription.remaining_visits <= 0) {
    // ✅ PAS D'ABONNEMENT OU PLUS DE VISITES → Paiement requis
    return { 
      requiresPayment: true, 
      status: VISIT_STATUS.DRAFT,
      amount: getVisitPrice(durationMinutes)
    };
  }

  // ✅ ABONNEMENT ACTIF AVEC VISITES DISPONIBLES → Pas de paiement
  return { 
    requiresPayment: false, 
    status: VISIT_STATUS.PLANNED,
    amount: 0
  };
};

// ============================================================
// GESTION DES PAIEMENTS
// ============================================================

/**
 * Confirme le paiement d'une visite et la planifie
 * @param {string} visitId - ID de la visite
 * @param {string} transactionId - ID de la transaction FedaPay
 * @param {string} userId - ID de l'utilisateur
 * @returns {Promise<Object>} Visite mise à jour
 */
const confirmVisitPayment = async (visitId, transactionId, userId) => {
  // 1. Récupérer la visite
  const { data: visit, error: fetchError } = await supabase
    .from('visites')
    .select('*')
    .eq('id', visitId)
    .single();

  if (fetchError) throw new Error('Visite non trouvée');
  
  // 2. Vérifier que la visite est en brouillon
  if (visit.status !== VISIT_STATUS.DRAFT) {
    throw new Error('Cette visite n\'est pas en attente de paiement');
  }
  
  // 3. Vérifier que l'utilisateur est le propriétaire
  if (visit.user_id !== userId) {
    throw new Error('Non autorisé');
  }

  // 4. Vérifier que le brouillon n'est pas expiré
  if (visit.draft_expires_at && new Date() > new Date(visit.draft_expires_at)) {
    await supabase
      .from('visites')
      .update({ 
        status: VISIT_STATUS.EXPIRED,
        metadata: { ...(visit.metadata || {}), expired_reason: 'draft_expired' }
      })
      .eq('id', visitId);
    throw new Error('Le brouillon a expiré. Veuillez recréer la visite.');
  }

  // 5. ✅ RÉCUPÉRER L'AIDANT ACTIF APRÈS PAIEMENT
  const familyId = visit.user_id;
  const targetType = visit.patient_id ? 'patient' : 'personal_account';
  const targetId = visit.patient_id || visit.user_id;

  let aidantId = visit.aidant_id || null;
  if (!aidantId) {
    // ✅ Importer dynamiquement pour éviter la dépendance circulaire
    const { getActiveAidantForTarget } = require('./aidantAssignment.service');
    aidantId = await getActiveAidantForTarget(targetType, targetId, familyId);
    console.log(`✅ Aidant trouvé après paiement: ${aidantId}`);
  }

  // 6. Mettre à jour la visite
  const updateData = {
    status: VISIT_STATUS.PLANNED,
    aidant_id: aidantId || null,
    is_draft: false,
    payment_status: VISIT_PAYMENT_STATUS.COMPLETED,
    payment_transaction_id: transactionId,
    payment_confirmed_at: new Date().toISOString(),
    scheduled_from_draft: true,
    draft_expires_at: null,
    metadata: {
      ...(visit.metadata || {}),
      is_draft: false,
      scheduled_from_draft: true,
      payment_confirmed_at: new Date().toISOString(),
      payment_transaction_id: transactionId,
      payment_status: VISIT_PAYMENT_STATUS.COMPLETED,
      payment_completed: true,
      aidant_assigned_after_payment: !!aidantId,
    }
  };

  // ✅ Pour les visites personnelles, s'assurer que patient_id est null
  if (visit.target_type === 'personal' || visit.target_type === 'personal_account') {
    updateData.patient_id = null;
  }

  const { data: updatedVisit, error: updateError } = await supabase
    .from('visites')
    .update(updateData)
    .eq('id', visitId)
    .select()
    .single();

  if (updateError) {
    console.error('❌ Erreur mise à jour visite:', updateError.message);
    
    // ✅ TENTATIVE DE RÉCUPÉRATION SI PATIENT_ID BLOQUANT
    if (updateError.message.includes('chk_planned_not_draft')) {
      console.log('🔄 Tentative de récupération avec patient_id = user_id...');
      
      if (!aidantId) {
        const { getActiveAidantForTarget } = require('./aidantAssignment.service');
        aidantId = await getActiveAidantForTarget(targetType, targetId, familyId);
      }
      
      const fallbackData = {
        status: VISIT_STATUS.PLANNED,
        patient_id: visit.user_id,
        aidant_id: aidantId || null,
        target_type: 'personal',
        target_name: visit.target_name || 'Personnel',
        is_draft: false,
        payment_status: VISIT_PAYMENT_STATUS.COMPLETED,
        payment_transaction_id: transactionId,
        payment_confirmed_at: new Date().toISOString(),
        scheduled_from_draft: true,
        draft_expires_at: null,
        metadata: {
          ...(visit.metadata || {}),
          is_draft: false,
          scheduled_from_draft: true,
          payment_confirmed_at: new Date().toISOString(),
          payment_transaction_id: transactionId,
          payment_status: VISIT_PAYMENT_STATUS.COMPLETED,
          payment_completed: true,
          aidant_assigned_after_payment: !!aidantId,
          fallback_patient_id_used: true,
        }
      };
      
      const { data: retryVisit, error: retryError } = await supabase
        .from('visites')
        .update(fallbackData)
        .eq('id', visitId)
        .select()
        .single();
      
      if (!retryError && retryVisit) {
        console.log('✅ Visite récupérée avec patient_id fallback:', retryVisit.id);
        return retryVisit;
      }
      
      console.error('❌ Échec de la récupération:', retryError?.message);
      throw new Error(retryError?.message || 'Erreur lors de la mise à jour');
    }
    
    throw new Error(updateError.message);
  }

  console.log('✅ Visite passée de brouillon à planifiee:', visitId);

  // 7. Notifications
  const targetDisplay = updatedVisit.target_name || (updatedVisit.patient ? 
    `${updatedVisit.patient.first_name} ${updatedVisit.patient.last_name}` : 'Personnel');

  // Notification à l'utilisateur
  await createNotification({
    userId: updatedVisit.user_id,
    title: '✅ Visite planifiée !',
    body: `Votre visite pour ${targetDisplay} a été planifiée avec succès après paiement.`,
    type: 'visite',
    data: { visit_id: visitId, status: VISIT_STATUS.PLANNED },
  });

  // Notification à l'aidant (si assigné)
  if (updatedVisit.aidant_id) {
    const { data: aidant } = await supabase
      .from('aidants')
      .select('user_id')
      .eq('id', updatedVisit.aidant_id)
      .single();

    if (aidant) {
      await createNotification({
        userId: aidant.user_id,
        title: '📅 Nouvelle visite à valider',
        body: `Visite pour ${targetDisplay} le ${updatedVisit.scheduled_date} à ${updatedVisit.scheduled_time}`,
        type: 'visite',
        data: { visit_id: visitId, action: 'approve' },
      });
    }
  }

  return updatedVisit;
};

// ============================================================
// GESTION DES BROUILLONS
// ============================================================

/**
 * Annule un brouillon de visite
 * @param {string} visitId - ID de la visite
 * @param {string} userId - ID de l'utilisateur
 * @param {string} reason - Motif d'annulation (optionnel)
 * @returns {Promise<Object>} Visite annulée
 */
const cancelDraftVisit = async (visitId, userId, reason = null) => {
  const { data: visit, error: fetchError } = await supabase
    .from('visites')
    .select('*')
    .eq('id', visitId)
    .single();

  if (fetchError) throw new Error('Visite non trouvée');
  if (visit.user_id !== userId) throw new Error('Non autorisé');
  if (visit.status !== VISIT_STATUS.DRAFT) {
    throw new Error('Cette visite n\'est pas un brouillon');
  }

  const { data, error } = await supabase
    .from('visites')
    .update({
      status: VISIT_STATUS.CANCELLED,
      metadata: {
        ...(visit.metadata || {}),
        cancelled_reason: reason || 'Draft cancelled by user',
        cancelled_at: new Date().toISOString(),
      }
    })
    .eq('id', visitId)
    .select()
    .single();

  if (error) throw error;
  return data;
};

/**
 * Nettoie les brouillons expirés (job cron)
 * @returns {Promise<number>} Nombre de brouillons nettoyés
 */
const cleanExpiredDrafts = async () => {
  const now = new Date().toISOString();

  const { data: expiredDrafts, error } = await supabase
    .from('visites')
    .select('id, user_id, target_name')
    .eq('status', VISIT_STATUS.DRAFT)
    .lt('draft_expires_at', now);

  if (error) {
    console.error('❌ Erreur récupération brouillons expirés:', error);
    return 0;
  }

  for (const draft of expiredDrafts) {
    await supabase
      .from('visites')
      .update({
        status: VISIT_STATUS.EXPIRED,
        metadata: {
          expired_reason: 'draft_expired_auto',
          expired_at: new Date().toISOString(),
        }
      })
      .eq('id', draft.id);

    await createNotification({
      userId: draft.user_id,
      title: '⏰ Brouillon de visite expiré',
      body: `Votre brouillon de visite pour ${draft.target_name || 'le patient'} a expiré. Vous pouvez en créer un nouveau.`,
      type: 'visite',
      data: { visit_id: draft.id, status: 'expired' },
    });

    console.log(`🗑️ Brouillon ${draft.id} expiré et nettoyé`);
  }

  return expiredDrafts.length;
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Constantes
  VISIT_STATUS,
  VISIT_PAYMENT_STATUS,
  VISIT_PONCTUAL_PRICES,
  DEFAULT_VISIT_PRICE,
  DRAFT_EXPIRY_HOURS,
  
  // Fonctions de prix
  getVisitPrice,
  requiresPayment,
  
  // Gestion des paiements
  confirmVisitPayment,
  
  // Gestion des brouillons
  cancelDraftVisit,
  cleanExpiredDrafts,
};
