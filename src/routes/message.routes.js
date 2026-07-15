// 📁 backend/src/routes/message.routes.js
 
const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');
const { createNotification } = require('../services/notification.service');
const { asyncWrapper } = require('../utils/errorHandler');

router.use(authMiddleware);

// ============================================================
// HELPER : ASSURER L'EXISTENCE DES CANAUX REQUIS (AUTO-GÉNÉRATION SANS CRASH)
// ============================================================
const ensureRequiredConversations = async (userId, role) => {
  try {
    const { data: admins } = await supabase.from('profiles').select('id').in('role', ['admin', 'coordinator']);
    const adminIds = (admins || []).map(a => a.id);

    if (role === 'family') {
      // 1. Récupérer les aidants actifs rattachés à cette famille (via assignations actives)
      const { data: assignments } = await supabase
        .from('aidant_assignments')
        .select('aidant_user_id')
        .eq('target_id', userId)
        .eq('status', 'active');

      const { data: visits } = await supabase
        .from('visites')
        .select('aidant_id')
        .eq('user_id', userId);

      const aidantIdsFromDb = [
        ...(assignments || []).map(a => a.aidant_user_id),
        ...(visits || []).map(v => v.aidant_id)
      ].filter(Boolean);

      // Résoudre les user_ids de ces aidants
      const aidantUserIds = [];
      if (aidantIdsFromDb.length > 0) {
        const { data: aidantsData } = await supabase
          .from('aidants')
          .select('user_id')
          .in('id', aidantIdsFromDb);
        if (aidantsData) {
          aidantsData.forEach(a => {
            if (a.user_id) aidantUserIds.push(a.user_id);
          });
        }
      }

      // 2. Créer le groupe de coordination global pour la famille s'il n'existe pas
      if (aidantUserIds.length > 0) {
        const globalGroupParticipants = [...new Set([userId, ...aidantUserIds, ...adminIds])];
        
        const { data: existingGroup } = await supabase
          .from('conversations')
          .select('id')
          .contains('participant_ids', [userId])
          .eq('type', 'group')
          .maybeSingle();

        if (!existingGroup) {
          const { data: familyProfile } = await supabase.from('profiles').select('full_name').eq('id', userId).single();
          const groupName = `💬 Groupe Coordination - Famille ${familyProfile?.full_name || 'Services'}`;

          const { data: newGroup } = await supabase
            .from('conversations')
            .insert({
              participant_ids: globalGroupParticipants,
              type: 'group',
              name: groupName,
              last_message_at: new Date().toISOString(),
              is_active: true,
            })
            .select()
            .single();

          if (newGroup) {
            for (const pid of globalGroupParticipants) {
              await supabase.from('conversation_participants').insert({ conversation_id: newGroup.id, user_id: pid });
            }
          }
        }
      }

      // 3. Assurer une conversation directe avec l'équipe de coordination administrative
      if (adminIds.length > 0) {
        const directAdminParticipants = [userId, adminIds[0]];
        const { data: existingDirectAdmin } = await supabase
          .from('conversations')
          .select('id')
          .contains('participant_ids', directAdminParticipants)
          .eq('type', 'direct')
          .maybeSingle();

        if (!existingDirectAdmin) {
          const { data: newDirect } = await supabase
            .from('conversations')
            .insert({
              participant_ids: directAdminParticipants,
              type: 'direct',
              name: '👔 Équipe de Coordination',
              last_message_at: new Date().toISOString(),
              is_active: true,
            })
            .select()
            .single();

          if (newDirect) {
            for (const pid of directAdminParticipants) {
              await supabase.from('conversation_participants').insert({ conversation_id: newDirect.id, user_id: pid });
            }
          }
        }
      }
    }

    if (role === 'aidant') {
      // Pour l'aidant, assurer la conversation directe avec l'équipe de coordination administrative
      if (adminIds.length > 0) {
        const directAdminParticipants = [userId, adminIds[0]];
        const { data: existingDirectAdmin } = await supabase
          .from('conversations')
          .select('id')
          .contains('participant_ids', directAdminParticipants)
          .eq('type', 'direct')
          .maybeSingle();

        if (!existingDirectAdmin) {
          const { data: newDirect } = await supabase
            .from('conversations')
            .insert({
              participant_ids: directAdminParticipants,
              type: 'direct',
              name: '👔 Équipe de Coordination',
              last_message_at: new Date().toISOString(),
              is_active: true,
            })
            .select()
            .single();

          if (newDirect) {
            for (const pid of directAdminParticipants) {
              await supabase.from('conversation_participants').insert({ conversation_id: newDirect.id, user_id: pid });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('⚠️ [Auto-chat-gen] Error ensuring conversations:', err.message);
  }
};

// ============================================================
// CONVERSATIONS
// ============================================================

router.get('/conversations', asyncWrapper(async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.profile.role;

    // Assurer l'existence des conversations requises
    await ensureRequiredConversations(userId, userRole);

    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .contains('participant_ids', [userId])
      .order('last_message_at', { ascending: false });

    if (error) {
      console.error('❌ Conversations error:', error);
      return res.json([]);
    }

    const conversations = data || [];

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

router.post('/conversations', asyncWrapper(async (req, res) => {
  try {
    const { participant_ids, name, type } = req.body;
    const userId = req.user.id;

    const allParticipants = [...new Set([userId, ...(participant_ids || [])])];

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

    if (error) throw error;

    for (const pid of allParticipants) {
      await supabase.from('conversation_participants').insert({
        conversation_id: data.id,
        user_id: pid
      });
    }

    for (const participantId of allParticipants) {
      if (participantId !== userId) {
        // ✅ CORRECTIF DE SYNTAXE : Ajout des backticks (``) pour libérer l'envoi de la notification
        await createNotification({
          userId: participantId,
          title: '💬 Nouvelle conversation',
          body: `${req.profile?.full_name || 'Un utilisateur'} vous a ajouté à une conversation`,
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

router.get('/:conversationId', asyncWrapper(async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    const { data: conv } = await supabase
      .from('conversations')
      .select('participant_ids')
      .eq('id', conversationId)
      .maybeSingle();

    if (conv && !conv.participant_ids?.includes(userId)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
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

    const { data: conv } = await supabase
      .from('conversations')
      .select('participant_ids')
      .eq('id', conversation_id)
      .maybeSingle();

    if (!conv || !conv.participant_ids?.includes(userId)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
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
      if (conv && conv.participant_ids) {
        const otherParticipants = conv.participant_ids.filter((id) => id !== userId);
        for (const participantId of otherParticipants) {
          // ✅ CORRECTIF DE SYNTAXE REQUIS : Ajout des backticks (``) pour libérer l'envoi de la notification
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

    res.status(201).json({ success: true, message: { ...message, sender } });
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: error.message });
  }
}));

router.put('/:messageId/read', asyncWrapper(async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    const { data: message, error: checkError } = await supabase
      .from('messages')
      .select('conversation_id, sender_id')
      .eq('id', messageId)
      .single();

    if (checkError || !message) {
      return res.status(404).json({ error: 'Message non trouvé' });
    }

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

module.exports = router;
