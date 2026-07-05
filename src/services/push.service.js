// 📁 backend/src/services/push.service.js

const webpush = require('web-push');
const { supabase } = require('./supabase.service');

// ============================================================
// CONFIGURATION VAPID
// ============================================================

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn('⚠️ VAPID keys manquantes');
}

webpush.setVapidDetails(
  'mailto:contact@santeplus.bj',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  maxRetries: 3,
  retryDelay: 2000, // 2 secondes
  batchSize: 100, // Nombre de notifications par lot
  rateLimit: 100, // Notifications par seconde
};

// ============================================================
// FILE D'ATTENTE (Queue)
// ============================================================

class NotificationQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.stats = {
      sent: 0,
      failed: 0,
      pending: 0,
    };
  }

  async add(notification) {
    this.queue.push(notification);
    this.stats.pending = this.queue.length;
    
    if (!this.processing) {
      this.process();
    }
  }

  async process() {
    this.processing = true;

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, CONFIG.batchSize);
      await this.sendBatch(batch);
      
      // ✅ Pause pour respecter le rate limit
      await sleep(1000 / CONFIG.rateLimit);
    }

    this.processing = false;
  }

  async sendBatch(batch) {
    const results = await Promise.allSettled(
      batch.map(notification => this.sendOne(notification))
    );

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        this.stats.sent++;
      } else {
        this.stats.failed++;
        console.error(`❌ Échec notification ${batch[index].id}:`, result.reason);
      }
    });

    this.stats.pending = this.queue.length;
  }

  async sendOne(notification) {
    const { subscription, payload, userId } = notification;
    
    let attempts = 0;
    while (attempts < CONFIG.maxRetries) {
      try {
        const result = await webpush.sendNotification(subscription, JSON.stringify(payload));
        
        // ✅ Mettre à jour le dernier envoi
        await supabase
          .from('push_tokens')
          .update({ last_used_at: new Date().toISOString() })
          .eq('token', JSON.stringify(subscription));

        return result;
      } catch (error) {
        attempts++;
        
        if (error.statusCode === 410 || error.statusCode === 404) {
          // ✅ Token expiré, le supprimer
          await supabase
            .from('push_tokens')
            .delete()
            .eq('token', JSON.stringify(subscription));
          throw error;
        }

        if (attempts < CONFIG.maxRetries) {
          await sleep(CONFIG.retryDelay * attempts);
        } else {
          throw error;
        }
      }
    }
  }
}

const notificationQueue = new NotificationQueue();

// ============================================================
// FONCTIONS PRINCIPALES
// ============================================================

const sendPushToUser = async (userId, payload) => {
  try {
    // ✅ Récupérer TOUS les tokens de l'utilisateur
    const { data: tokens, error } = await supabase
      .from('push_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (error) throw error;
    if (!tokens || tokens.length === 0) {
      return { success: false, sent: 0, message: 'Aucun token' };
    }

    let sent = 0;
    const results = [];

    for (const token of tokens) {
      try {
        let subscription;
        try {
          subscription = typeof token.token === 'string' 
            ? JSON.parse(token.token) 
            : token.token;
        } catch {
          subscription = { endpoint: token.token };
        }

        // ✅ Ajouter à la queue
        await notificationQueue.add({
          id: token.id,
          subscription,
          payload,
          userId,
        });

        sent++;
        results.push({ success: true, tokenId: token.id });
      } catch (error) {
        results.push({ success: false, tokenId: token.id, error: error.message });
      }
    }

    // ✅ Créer la notification en base
    await createNotificationInDB(userId, payload);

    return {
      success: true,
      sent,
      total: tokens.length,
      results,
      queueStats: notificationQueue.stats,
    };
  } catch (error) {
    console.error('❌ Erreur sendPushToUser:', error);
    return { success: false, error: error.message };
  }
};

// ============================================================
// ENVOI EN BATCH (BULK)
// ============================================================

const sendPushToMultipleUsers = async (userIds, payload) => {
  const results = [];
  const batchSize = 50;

  for (let i = 0; i < userIds.length; i += batchSize) {
    const batch = userIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(userId => sendPushToUser(userId, payload))
    );
    results.push(...batchResults);
  }

  return results;
};

// ============================================================
// CRÉER UNE NOTIFICATION EN BASE
// ============================================================

const createNotificationInDB = async (userId, payload) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title: payload.title,
        body: payload.body,
        type: payload.data?.type || 'system',
        data: payload.data || {},
        is_read: false,
        is_sent: true,
        sent_at: new Date().toISOString(),
        is_delivered: true,
        delivered_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('❌ Erreur création notification en base:', error);
    return null;
  }
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  sendPushToUser,
  sendPushToMultipleUsers,
  notificationQueue,
};
