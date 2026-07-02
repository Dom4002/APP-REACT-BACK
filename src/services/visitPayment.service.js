// 📁 backend/src/services/visitPayment.service.js

const { supabase } = require('./supabase.service');
const { createNotification } = require('./notification.service');

// ============================================================
// CONSTANTES
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

const VISIT_PONCTUAL_PRICES = {
  '30': 5000,
  '45': 6000,
  '60': 7500,
  '90': 10000,
  '120': 12500,
};

const DEFAULT_VISIT_PRICE = 7500;
const DRAFT_EXPIRY_HOURS = 24;

// ============================================================
// FONCTIONS
// ============================================================

const getVisitPrice = (durationMinutes = 60) => {
  const price = VISIT_PONCTUAL_PRICES[durationMinutes.toString()];
  if (price) return price;
  return Math.round((durationMinutes / 60) * DEFAULT_VISIT_PRICE);
};

const requiresPayment = async (userId, isPonctual, durationMinutes) => {
  if (isPonctual) {
    return { 
      requiresPayment: true, 
      status: VISIT_STATUS.DRAFT,
      amount: getVisitPrice(durationMinutes)
    };
  }

  const { data: subscription, error } = await supabase
    .from('abonnements')
    .select('id, remaining_visits, status')
    .eq('user_id', userId)
    .eq('status', 'actif')
    .maybeSingle();

  if (error || !subscription || subscription.remaining_visits <= 0) {
    return { 
      requiresPayment: true, 
      status: VISIT_STATUS.DRAFT,
      amount: getVisitPrice(durationMinutes)
    };
  }

  return { 
    requiresPayment: false, 
    status: VISIT_STATUS.PLANNED,
    amount: 0
  };
};

const confirmVisitPayment = async (visitId, transactionId, userId) => {
  const { data: visit, error: fetchError } = await supabase
    .from('visites')
    .select('*')
    .eq('id', visitId)
    .single();

  if (fetchError) throw new Error('Visite non trouvée');
  if (visit.status !== VISIT_STATUS.DRAFT) {
    throw new Error('Cette visite n\'est pas en attente de paiement');
  }
  if (visit.user_id !== userId) {
    throw new Error('Non autorisé');
  }

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

  const { data: updatedVisit, error: updateError } = await supabase
    .from('visites')
    .update({
      status: VISIT_STATUS.PLANNED,
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
      }
    })
    .eq('id', visitId)
    .select()
    .single();

  if (updateError) throw new Error('Erreur lors de la mise à jour');

  const targetDisplay = updatedVisit.target_name || 'le patient';
  
  await createNotification({
    userId: updatedVisit.user_id,
    title: '✅ Visite planifiée !',
    body: `Votre visite pour ${targetDisplay} a été planifiée avec succès après paiement.`,
    type: 'visite',
    data: { visit_id: visitId, status: VISIT_STATUS.PLANNED },
  });

  if (updatedVisit.aidant_id) {
    await createNotification({
      userId: updatedVisit.aidant_id,
      title: '📅 Nouvelle visite à valider',
      body: `Visite pour ${targetDisplay} le ${updatedVisit.scheduled_date} à ${updatedVisit.scheduled_time}`,
      type: 'visite',
      data: { visit_id: visitId, action: 'approve' },
    });
  }

  return updatedVisit;
};

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

module.exports = {
  VISIT_STATUS,
  VISIT_PAYMENT_STATUS,
  VISIT_PONCTUAL_PRICES,
  DEFAULT_VISIT_PRICE,
  DRAFT_EXPIRY_HOURS,
  getVisitPrice,
  requiresPayment,
  confirmVisitPayment,
  cancelDraftVisit,
  cleanExpiredDrafts,
};
