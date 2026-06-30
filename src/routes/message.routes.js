const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { createNotification } = require('../services/notification.service');

router.use(authMiddleware);

// =============================================
// CONVERSATIONS
// =============================================
router.get('/conversations', async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('conversations')
      .select(`
        *,
        participants:profiles!conversations_participant_ids(
          id,
          full_name,
          email,
          role,
          avatar_url
        )
      `)
      .contains('participant_ids', [userId])
      .order('last_message_at', { ascending: false });

    if (error) throw error;

    // Récupérer le dernier message de chaque conversation
    const conversationsWithLastMessage = await Promise.all(
      (data || []).map(async (conv) => {
        const { data: lastMessage } = await supabase
          .from('messages')
          .select('*')
          .eq('conversation_id', conv.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        return { ...conv, last_message: lastMessage };
      })
    );

    res.json(conversationsWithLastMessage);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// MESSAGES D'UNE CONVERSATION
// =============================================
router.get('/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;

    const { data, error } = await supabase
      .from('messages')
      .select(`
        *,
        sender:profiles(*)
      `)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ENVOYER UN MESSAGE
// =============================================
router.post('/', async (req, res) => {
  try {
    const { conversation_id, content, attachment_url } = req.body;
    const userId = req.user.id;

    const { data: message, error } = await supabase
      .from('messages')
      .insert({
        conversation_id,
        sender_id: userId,
        content,
        attachment_url,
        is_read: false,
      })
      .select(`
        *,
        sender:profiles(*)
      `)
      .single();

    if (error) throw error;

    // Mettre à jour last_message_at
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversation_id);

    // Notification aux autres participants
    const { data: conversation } = await supabase
      .from('conversations')
      .select('participant_ids')
      .eq('id', conversation_id)
      .single();

    if (conversation) {
      const otherParticipants = conversation.participant_ids.filter(id => id !== userId);
      for (const participantId of otherParticipants) {
        await createNotification({
          userId: participantId,
          title: 'Nouveau message',
          body: `${req.user.user_metadata?.full_name || 'Utilisateur'}: ${content?.substring(0, 50)}...`,
          type: 'message',
          data: { conversation_id, message_id: message.id },
        });
      }
    }

    res.status(201).json({ success: true, message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// MARQUER COMME LU
// =============================================
router.put('/:messageId/read', async (req, res) => {
  try {
    const { messageId } = req.params;

    const { error } = await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('id', messageId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// TOUT MARQUER COMME LU
// =============================================
router.put('/:conversationId/read-all', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    const { error } = await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('conversation_id', conversationId)
      .neq('sender_id', userId)
      .eq('is_read', false);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// CRÉER UNE CONVERSATION
// =============================================
router.post('/conversations', async (req, res) => {
  try {
    const { participantIds } = req.body;
    const userId = req.user.id;

    const allParticipants = [...new Set([userId, ...participantIds])];

    const { data, error } = await supabase
      .from('conversations')
      .insert({
        participant_ids: allParticipants,
        last_message_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, conversation: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;