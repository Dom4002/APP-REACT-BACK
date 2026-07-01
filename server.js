// 📁 backend/server.js

require('dotenv').config();
const { validateEnv } = require('./src/config/validateEnv');
validateEnv();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { errorHandler, notFoundHandler } = require('./src/utils/errorHandler');
const { logRequest } = require('./src/config/logger');
const { setupSwagger } = require('./src/config/swagger');
const aidantCatalogRoutes = require('./src/routes/aidantCatalog.routes');
const fileUpload = require('express-fileupload');

const app = express();

const path = require('path');
const fs = require('fs');

// =============================================
// ✅ SERVIR LES FICHIERS STATIQUES (LOGOS)
// =============================================

// 1. Servir tout le dossier assets
app.use('/assets', express.static(path.join(__dirname, 'src/assets')));

// 2. Route spécifique pour les logos
app.get('/logos/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'src/assets/emails', filename);
  
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Logo non trouvé' });
  }
});

console.log('📁 Assets servis depuis /assets');
console.log('📁 Logos disponibles sur /logos/:filename');

const PORT = process.env.PORT || 5000;

// =============================================
// SUPABASE CLIENT
// =============================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =============================================
// MIDDLEWARES
// =============================================
app.use(helmet());
app.set('trust proxy', true);

app.use(logRequest);

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://app-sante-plus-react-front.vercel.app',
    'https://app-sante-plus-react-front-git-main-abouamhster-cmyks-projects.vercel.app'
  ],
  credentials: true,
}));

// ⚠️ IMPORTANT : Webhook FedaPay DOIT être AVANT express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ✅ File upload pour les messages
app.use(fileUpload({
  limits: { fileSize: 5 * 1024 * 1024 },
  abortOnLimit: true,
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de requêtes, veuillez réessayer plus tard' },
  validate: {
    xForwardedForHeader: false,
    trustProxy: false,
  },
});
app.use('/api', limiter);

// =============================================
// MIDDLEWARES D'AUTH (IMPORTÉS)
// =============================================
const authMiddleware = require('./src/middleware/auth.middleware');
const roleMiddleware = require('./src/middleware/role.middleware');

// =============================================
// ROUTES
// =============================================
const authRoutes = require('./src/routes/auth.routes');
const patientRoutes = require('./src/routes/patient.routes');
const visitRoutes = require('./src/routes/visit.routes');
const orderRoutes = require('./src/routes/order.routes');
const messageRoutes = require('./src/routes/message.routes');
const paymentRoutes = require('./src/routes/payment.routes');
const adminRoutes = require('./src/routes/admin.routes');
const notificationRoutes = require('./src/routes/notification.routes');
const billingRoutes = require('./src/routes/billing');
const reminderRoutes = require('./src/routes/reminder.routes');
const assessmentRoutes = require('./src/routes/assessment.routes');
const contractRoutes = require('./src/routes/contract.routes');
const adminSetupRoutes = require('./src/routes/adminSetup.routes');
const settingsRoutes = require('./src/routes/settings.routes');
const offerRoutes = require('./src/routes/offers.routes');

app.use('/api/auth', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/visits', visitRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/contract', contractRoutes);
app.use('/api/admin-setup', adminSetupRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/aidants', aidantCatalogRoutes);

// ============================================================
// MESSAGES - CONVERSATIONS (ROUTES AJOUTÉES DIRECTEMENT)
// ============================================================

// ✅ Récupérer les conversations de l'utilisateur
app.get('/api/messages/conversations', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .contains('participant_ids', [userId])
      .order('last_message_at', { ascending: false });

    if (error) {
      console.error('❌ Conversations error:', error);
      return res.json([]);
    }

    let conversations = data || [];

    const hasGlobal = conversations.some(c => c.id === '00000000-0000-0000-0000-000000000001');
    if (!hasGlobal) {
      conversations.unshift({
        id: '00000000-0000-0000-0000-000000000001',
        participant_ids: [userId],
        type: 'global',
        name: '💬 Général',
        last_message_at: new Date().toISOString(),
        is_active: true,
        participants: [],
        last_message: null,
      });
    }

    const conversationsWithParticipants = await Promise.all(
      conversations.map(async (conv) => {
        const participantIds = (conv.participant_ids || []).filter((id) => id !== userId);
        let participants = [];

        if (participantIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, full_name, role, avatar_url')
            .in('id', participantIds);

          if (profiles) {
            participants = profiles;
          }
        }

        const { data: lastMessage } = await supabase
          .from('messages')
          .select('*')
          .eq('conversation_id', conv.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        return { ...conv, participants, last_message: lastMessage || null };
      })
    );

    res.json(conversationsWithParticipants);
  } catch (error) {
    console.error('❌ Get conversations error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Créer une nouvelle conversation
app.post('/api/messages/conversations', authMiddleware, async (req, res) => {
  try {
    const { participant_ids, name, type } = req.body;
    const userId = req.user.id;

    const allParticipants = [...new Set([userId, ...(participant_ids || [])])];

    const { data, error } = await supabase
      .from('conversations')
      .insert({
        participant_ids: allParticipants,
        type: type || 'direct',
        name: name || null,
        last_message_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      if (error.code === '42P01') {
        return res.status(501).json({ error: 'Table conversations non disponible' });
      }
      throw error;
    }

    res.status(201).json({ success: true, conversation: data });
  } catch (error) {
    console.error('❌ Create conversation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Récupérer les messages d'une conversation
app.get('/api/messages/:conversationId', authMiddleware, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    if (conversationId !== '00000000-0000-0000-0000-000000000001') {
      const { data: conv } = await supabase
        .from('conversations')
        .select('participant_ids')
        .eq('id', conversationId)
        .maybeSingle();

      if (conv && !conv.participant_ids?.includes(userId)) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }
    }

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(200);

    if (error) {
      console.error('❌ Messages error:', error);
      return res.json([]);
    }

    const senderIds = [...new Set(data?.map(m => m.sender_id).filter(Boolean))];
    let profilesMap = {};

    if (senderIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, role, avatar_url')
        .in('id', senderIds);

      if (profiles) {
        profilesMap = profiles.reduce((acc, p) => {
          acc[p.id] = p;
          return acc;
        }, {});
      }
    }

    const messagesWithSenders = (data || []).map(message => ({
      ...message,
      sender: profilesMap[message.sender_id] || null,
    }));

    res.json(messagesWithSenders);
  } catch (error) {
    console.error('❌ Get messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Envoyer un message avec pièces jointes
app.post('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { conversation_id, content, attachment_url, attachment_type } = req.body;
    const userId = req.user.id;

    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id est requis' });
    }

    if (!content && !attachment_url) {
      return res.status(400).json({ error: 'content ou attachment_url est requis' });
    }

    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id,
        sender_id: userId,
        content: content || null,
        is_read: false,
        attachment_url: attachment_url || null,
        attachment_type: attachment_type || null,
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Insert message error:', error);
      return res.status(500).json({ error: error.message });
    }

    try {
      await supabase
        .from('conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', conversation_id);
    } catch (updateError) {
      console.log('ℹ️ Conversation update skipped');
    }

    const { data: sender } = await supabase
      .from('profiles')
      .select('id, full_name, role, avatar_url')
      .eq('id', userId)
      .single();

    try {
      const { data: conv } = await supabase
        .from('conversations')
        .select('participant_ids')
        .eq('id', conversation_id)
        .maybeSingle();

      if (conv && conv.participant_ids) {
        const otherParticipants = conv.participant_ids.filter((id) => id !== userId);
        for (const participantId of otherParticipants) {
          await supabase.from('notifications').insert({
            user_id: participantId,
            title: `📨 ${sender?.full_name || 'Utilisateur'}`,
            body: content?.substring(0, 100) || 'Pièce jointe',
            type: 'message',
            data: {
              conversation_id,
              message_id: data.id,
              sender_id: userId,
            },
          });
        }
      }
    } catch (notifError) {
      console.log('ℹ️ Notification skipped');
    }

    res.status(201).json({ success: true, message: data });
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Marquer un message comme lu
app.put('/api/messages/:messageId/read', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;

    const { error } = await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('id', messageId);

    if (error) {
      console.error('❌ Mark read error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Mark read error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Tout marquer comme lu dans une conversation
app.put('/api/messages/:conversationId/read-all', authMiddleware, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    const { error } = await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('conversation_id', conversationId)
      .neq('sender_id', userId)
      .eq('is_read', false);

    if (error) {
      console.error('❌ Mark all read error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Mark all read error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Épingler/Désépingler un message (admin seulement)
app.put('/api/messages/:messageId/pin', authMiddleware, roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { messageId } = req.params;
    const { pinned } = req.body;

    const { error } = await supabase
      .from('messages')
      .update({ is_pinned: pinned })
      .eq('id', messageId);

    if (error) {
      console.error('❌ Pin error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Pin message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Marquer comme important (admin seulement)
app.put('/api/messages/:messageId/important', authMiddleware, roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { messageId } = req.params;
    const { important } = req.body;

    const { error } = await supabase
      .from('messages')
      .update({ is_important: important })
      .eq('id', messageId);

    if (error) {
      console.error('❌ Important error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Important message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Supprimer un message (admin seulement)
app.delete('/api/messages/:messageId', authMiddleware, roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { messageId } = req.params;

    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('id', messageId);

    if (error) {
      console.error('❌ Delete error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Delete message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Upload de fichier pour messages
app.post('/api/messages/upload', authMiddleware, async (req, res) => {
  try {
    const file = req.files?.file;
    if (!file) {
      return res.status(400).json({ error: 'Fichier requis' });
    }

    const userId = req.user.id;
    const fileExt = file.name.split('.').pop();
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${fileExt}`;
    const filePath = `messages/${userId}/${fileName}`;

    const { data, error } = await supabase.storage
      .from('messages')
      .upload(filePath, file.data, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (error) {
      console.error('❌ Upload error:', error);
      return res.status(500).json({ error: error.message });
    }

    const { data: { publicUrl } } = supabase.storage
      .from('messages')
      .getPublicUrl(filePath);

    res.json({
      success: true,
      url: publicUrl,
      type: file.mimetype.startsWith('image/') ? 'image' : 'document',
    });
  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ REDIRECTION FEDAPAY
// =============================================
app.post('/payment/confirm', express.json(), async (req, res) => {
  console.log('📥 Redirection FedaPay reçue:', req.body);
  
  const { transaction_id, status } = req.body;
  
  if (status === 'approved' || status === 'paid') {
    await supabase
      .from('paiements')
      .update({ status: 'valide', paid_at: new Date().toISOString() })
      .eq('reference', transaction_id);
  }
  
  res.redirect(`${process.env.CLIENT_URL}/payment/confirm?status=${status}&transaction_id=${transaction_id}`);
});

// =============================================
// HEALTH CHECK
// =============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Santé Plus API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Santé Plus API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

app.get('/billing/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Billing API',
    fedapay_env: process.env.FEDAPAY_ENV || 'live',
    timestamp: new Date().toISOString(),
  });
});

// =============================================
// SWAGGER DOCUMENTATION
// =============================================
setupSwagger(app);

// =============================================
// 404 - Route non trouvée
// =============================================
app.use(notFoundHandler);

// =============================================
// GESTIONNAIRE D'ERREURS GLOBAL
// =============================================
app.use(errorHandler);

// =============================================
// START SERVER
// =============================================
app.listen(PORT, () => {
  console.log(`🚀 Santé Plus API running on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📚 Swagger: http://localhost:${PORT}/api/docs`);
  console.log(`💳 Webhook FedaPay: http://localhost:${PORT}/api/billing/webhook`);
  console.log(`↩️ Redirection FedaPay: http://localhost:${PORT}/payment/confirm`);
});

module.exports = app;
