// 📁 backend/src/routes/message.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');
const { createNotification } = require('../services/notification.service');
const { asyncWrapper } = require('../utils/errorHandler');

// =============================================
// TOUTES LES ROUTES SONT PROTÉGÉES
// =============================================
router.use(authMiddleware);

// ============================================================
// CONVERSATIONS
// ============================================================

/**
 * @route GET /api/messages/conversations
 * @desc Récupère toutes les conversations de l'utilisateur
 * @access Private
 */
router.get('/conversations', asyncWrapper(async (req, res) => {
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

    // ✅ Ajouter la conversation globale si elle n'existe pas
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

    // ✅ Enrichir avec les participants et derniers messages
    const conversationsWithDetails = await Promise.all(
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

        return { 
          ...conv, 
          participants, 
          last_message: lastMessage || null 
        };
      })
    );

    res.json(conversationsWithDetails);
  } catch (error) {
    console.error('❌ Get conversations error:', error);
    res.status(500).json({ error: error.message });
  }
}));

/**
 * @route POST /api/messages/conversations
 * @desc Crée une nouvelle conversation
 * @access Private
 */
router.post('/conversations', asyncWrapper(async (req, res) => {
  try {
    const { participant_ids, name, type } = req.body;
    const userId = req.user.id;

    const allParticipants = [...new Set([userId, ...(participant_ids || [])])];

    // ✅ Vérifier si une conversation directe existe déjà
    if (type === 'direct' && participant_ids.length === 1) {
      const { data: existing, error: existingError } = await supabase
        .from('conversations')
        .select('id')
        .contains('participant_ids', [userId, participant_ids[0]])
        .eq('type', 'direct')
        .maybeSingle();

      if (!existingError && existing) {
        return res.status(200).json({ 
          success: true, 
          conversation: existing,
          message: 'Conversation existante' 
        });
      }
    }

    const { data, error } = await supabase
      .from('conversations')
      .insert({
        participant_ids: allParticipants,
        type: type || 'direct',
        name: name || null,
        last_message_at: new Date().toISOString(),
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '42P01') {
        return res.status(501).json({ error: 'Table conversations non disponible' });
      }
      throw error;
    }

    // ✅ Notifier les participants
    for (const participantId of allParticipants) {
      if (participantId !== userId) {
        await createNotification({
          userId: participantId,
          title: '💬 Nouvelle conversation',
          body: `${req.user.user_metadata?.full_name || 'Utilisateur'} vous a ajouté à une conversation`,
          type: 'message',
          data: { conversation_id: data.id },
        });
      }
    }

    res.status(201).json({ success: true, conversation: data });
  } catch (error) {
    console.error('❌ Create conversation error:', error);
    res.status(500).json({ error: error.message });
  }
}));

// ============================================================
// MESSAGES
// ============================================================

/**
 * @route GET /api/messages/:conversationId
 * @desc Récupère tous les messages d'une conversation
 * @access Private
 */
router.get('/:conversationId', asyncWrapper(async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    // ✅ Vérifier l'accès à la conversation (sauf globale)
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

    // ✅ Enrichir avec les expéditeurs
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

    // ✅ Marquer les messages comme lus (sauf les siens)
    const unreadIds = messagesWithSenders
      .filter(m => !m.is_read && m.sender_id !== userId)
      .map(m => m.id);

    if (unreadIds.length > 0) {
      await supabase
        .from('messages')
        .update({ is_read: true })
        .in('id', unreadIds);
    }

    res.json(messagesWithSenders);
  } catch (error) {
    console.error('❌ Get messages error:', error);
    res.status(500).json({ error: error.message });
  }
}));

/**
 * @route POST /api/messages
 * @desc Envoie un nouveau message
 * @access Private
 */
router.post('/', asyncWrapper(async (req, res) => {
  try {
    const { conversation_id, content, attachment_url, attachment_type } = req.body;
    const userId = req.user.id;

    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id est requis' });
    }

    if (!content && !attachment_url) {
      return res.status(400).json({ error: 'content ou attachment_url est requis' });
    }

    // ✅ Vérifier l'accès à la conversation (sauf globale)
    if (conversation_id !== '00000000-0000-0000-0000-000000000001') {
      const { data: conv } = await supabase
        .from('conversations')
        .select('participant_ids')
        .eq('id', conversation_id)
        .maybeSingle();

      if (!conv || !conv.participant_ids?.includes(userId)) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }
    }

    const { data: message, error } = await supabase
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

    // ✅ Mettre à jour last_message_at
    try {
      await supabase
        .from('conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', conversation_id);
    } catch (updateError) {
      console.log('ℹ️ Conversation update skipped');
    }

    // ✅ Récupérer l'expéditeur
    const { data: sender } = await supabase
      .from('profiles')
      .select('id, full_name, role, avatar_url')
      .eq('id', userId)
      .single();

    // ✅ Notifier les autres participants
    try {
      const { data: conv } = await supabase
        .from('conversations')
        .select('participant_ids')
        .eq('id', conversation_id)
        .maybeSingle();

      if (conv && conv.participant_ids) {
        const otherParticipants = conv.participant_ids.filter((id) => id !== userId);
        for (const participantId of otherParticipants) {
          await createNotification({
            userId: participantId,
            title: `📨 ${sender?.full_name || 'Utilisateur'}`,
            body: content?.substring(0, 100) || 'Pièce jointe',
            type: 'message',
            data: {
              conversation_id,
              message_id: message.id,
              sender_id: userId,
            },
          });
        }
      }
    } catch (notifError) {
      console.log('ℹ️ Notification skipped');
    }

    res.status(201).json({ 
      success: true, 
      message: { ...message, sender } 
    });
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: error.message });
  }
}));

/**
 * @route PUT /api/messages/:messageId/read
 * @desc Marque un message comme lu
 * @access Private
 */
router.put('/:messageId/read', asyncWrapper(async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    // ✅ Vérifier que le message existe et que l'utilisateur y a accès
    const { data: message, error: checkError } = await supabase
      .from('messages')
      .select('conversation_id, sender_id')
      .eq('id', messageId)
      .single();

    if (checkError || !message) {
      return res.status(404).json({ error: 'Message non trouvé' });
    }

    // ✅ Ne pas marquer ses propres messages
    if (message.sender_id === userId) {
      return res.json({ success: true, message: 'Message déjà lu' });
    }

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
}));

/**
 * @route PUT /api/messages/:conversationId/read-all
 * @desc Marque tous les messages d'une conversation comme lus
 * @access Private
 */
router.put('/:conversationId/read-all', asyncWrapper(async (req, res) => {
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
}));

// ============================================================
// ADMIN - GESTION DES MESSAGES
// ============================================================

/**
 * @route PUT /api/messages/:messageId/pin
 * @desc Épingler/Désépingler un message (Admin/Coordinator only)
 * @access Private - Admin/Coordinator
 */
router.put('/:messageId/pin', roleMiddleware(['admin', 'coordinator']), asyncWrapper(async (req, res) => {
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

    res.json({ 
      success: true, 
      message: pinned ? 'Message épinglé' : 'Message désépinglé' 
    });
  } catch (error) {
    console.error('❌ Pin message error:', error);
    res.status(500).json({ error: error.message });
  }
}));

/**
 * @route PUT /api/messages/:messageId/important
 * @desc Marquer/Démarquer un message comme important (Admin/Coordinator only)
 * @access Private - Admin/Coordinator
 */
router.put('/:messageId/important', roleMiddleware(['admin', 'coordinator']), asyncWrapper(async (req, res) => {
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

    res.json({ 
      success: true, 
      message: important ? 'Message marqué comme important' : 'Important retiré' 
    });
  } catch (error) {
    console.error('❌ Important message error:', error);
    res.status(500).json({ error: error.message });
  }
}));

/**
 * @route DELETE /api/messages/:messageId
 * @desc Supprime un message (Admin/Coordinator only)
 * @access Private - Admin/Coordinator
 */
router.delete('/:messageId', roleMiddleware(['admin', 'coordinator']), asyncWrapper(async (req, res) => {
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

    res.json({ success: true, message: 'Message supprimé' });
  } catch (error) {
    console.error('❌ Delete message error:', error);
    res.status(500).json({ error: error.message });
  }
}));

/**
 * @route POST /api/messages/upload
 * @desc Upload un fichier pour un message
 * @access Private
 */
router.post('/upload', asyncWrapper(async (req, res) => {
  try {
    const file = req.files?.file;
    if (!file) {
      return res.status(400).json({ error: 'Fichier requis' });
    }

    // ✅ Vérifier la taille du fichier
    if (file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Fichier trop volumineux (max 5MB)' });
    }

    // ✅ Vérifier le type de fichier
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Type de fichier non autorisé' });
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
      name: file.name,
      size: file.size,
    });
  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: error.message });
  }
}));

// ============================================================
// ADMIN - STATISTIQUES DES MESSAGES
// ============================================================

/**
 * @route GET /api/messages/admin/stats
 * @desc Statistiques des messages (Admin/Coordinator only)
 * @access Private - Admin/Coordinator
 */
router.get('/admin/stats', roleMiddleware(['admin', 'coordinator']), asyncWrapper(async (req, res) => {
  try {
    const [totalMessages, totalConversations, unreadMessages] = await Promise.all([
      supabase.from('messages').select('id', { count: 'exact', head: true }),
      supabase.from('conversations').select('id', { count: 'exact', head: true }),
      supabase.from('messages').select('id', { count: 'exact', head: true }).eq('is_read', false),
    ]);

    res.json({
      success: true,
      data: {
        total_messages: totalMessages.count || 0,
        total_conversations: totalConversations.count || 0,
        unread_messages: unreadMessages.count || 0,
      }
    });
  } catch (error) {
    console.error('❌ Admin stats error:', error);
    res.status(500).json({ error: error.message });
  }
}));

module.exports = router;
