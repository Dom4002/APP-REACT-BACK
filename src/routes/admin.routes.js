// 📁 backend/src/routes/admin.routes.js
 
const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const roleMiddleware = require('../middleware/role.middleware');

router.use(authMiddleware);
router.use(roleMiddleware(['admin', 'coordinator']));



// =============================================
// ✅ SUPPRIMER UN UTILISATEUR (ADMIN)
// =============================================
router.delete('/users/:id', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Supprimer les données associées
    await supabase.from('patient_family_links').delete().eq('family_id', id);
    await supabase.from('patient_aidant_assignments').delete().eq('family_id', id);
    await supabase.from('inscriptions').delete().eq('user_id', id);
    await supabase.from('notifications').delete().eq('user_id', id);
    await supabase.from('profiles').delete().eq('id', id);

    // 2. Supprimer l'utilisateur Auth (via Service Role)
    const { error } = await supabase.auth.admin.deleteUser(id);
    
    if (error) throw error;

    res.json({ success: true, message: 'Utilisateur supprimé avec succès' });
  } catch (error) {
    console.error('❌ Delete user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// STATISTIQUES - AVEC NOUVEAUX STATUTS
// =============================================
router.get('/stats', async (req, res) => {
  try {
    const { count: patientsCount } = await supabase
      .from('patients')
      .select('*', { count: 'exact', head: true });

    const { count: familiesCount } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'family');

    const { count: aidantsCount } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'aidant');

    const today = new Date().toISOString().split('T')[0];
    const { count: visitsToday } = await supabase
      .from('visites')
      .select('*', { count: 'exact', head: true })
      .eq('scheduled_date', today);

    const { count: visitsInProgress } = await supabase
      .from('visites')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'en_cours');

    // ✅ Nouveaux statuts pour les alertes
    const { count: pendingRegistrations } = await supabase
      .from('inscriptions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'en_attente');

    // ✅ Visites en attente d'approbation (24-48h)
    const { count: visitsWaitingApproval } = await supabase
      .from('visites')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'planifiee')
      .is('approved_at', null)
      .is('refused_at', null);

    // ✅ Visites expirées (sans réponse)
    const { count: visitsExpired } = await supabase
      .from('visites')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'expire');

    // ✅ Commandes en attente (30min)
    const { count: ordersWaiting } = await supabase
      .from('commandes')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'en_attente');

    // ✅ Commandes disponibles (urgentes)
    const { count: ordersAvailable } = await supabase
      .from('commandes')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'disponible');

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: payments } = await supabase
      .from('paiements')
      .select('amount')
      .eq('status', 'valide')
      .gte('created_at', startOfMonth.toISOString());

    const revenue = payments?.reduce((sum, p) => sum + p.amount, 0) || 0;

    res.json({
      patients: patientsCount || 0,
      families: familiesCount || 0,
      aidants: aidantsCount || 0,
      visitsToday: visitsToday || 0,
      visitsInProgress: visitsInProgress || 0,
      pendingRegistrations: pendingRegistrations || 0,
      visitsWaitingApproval: visitsWaitingApproval || 0,
      visitsExpired: visitsExpired || 0,
      ordersWaiting: ordersWaiting || 0,
      ordersAvailable: ordersAvailable || 0,
      revenue,
    });
  } catch (error) {
    console.error('❌ Get stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// INSCRIPTIONS
// =============================================
router.get('/registrations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('inscriptions')
      .select(`
        *,
        user:profiles(*),
        offre:offres(*)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Get registrations error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// TRAITER UNE INSCRIPTION
// =============================================
router.put('/registrations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, comments } = req.body;

    const { data, error } = await supabase
      .from('inscriptions')
      .update({
        status,
        comments,
        processed_by: req.user.id,
        processed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, registration: data });
  } catch (error) {
    console.error('❌ Process registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// LISTE DES UTILISATEURS
// =============================================
router.get('/users', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Get users error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ CRÉER UN AIDANT (ADMIN SEULEMENT)
// =============================================
router.post('/aidants', async (req, res) => {
  try {
    const { userId, specialties, available, bio, address, zones, experience_years } = req.body;

    // Vérifier que l'utilisateur existe
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const { data: aidant, error } = await supabase
      .from('aidants')
      .insert({
        user_id: userId,
        specialties: specialties || [],
        available: available !== undefined ? available : true,
        bio: bio || null,
        address: address || null,
        zones: zones || [],
        experience_years: experience_years || null,
        rating: 0,
        total_missions: 0,
        is_verified: false,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from('profiles').update({ role: 'aidant' }).eq('id', userId);

    // Notification à l'aidant
    await supabase.from('notifications').insert({
      user_id: userId,
      title: '📋 Compte aidant créé',
      body: `Votre compte aidant a été créé par l'administration. En attente de validation.`,
      type: 'system',
      data: { aidant_id: aidant.id },
    });

    res.json({ success: true, aidant });
  } catch (error) {
    console.error('❌ Create aidant error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ ASSIGNER UN AIDANT À UNE FAMILLE
// =============================================
router.post('/assign-aidant', async (req, res) => {
  try {
    const { familyId, aidantId, assignmentType = 'permanente', expiresAt = null } = req.body;

    // Vérifier que la famille existe
    const { data: family, error: familyError } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', familyId)
      .eq('role', 'family')
      .single();

    if (familyError || !family) {
      return res.status(404).json({ error: 'Famille non trouvée' });
    }

    // Vérifier que l'aidant existe et est approuvé
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, is_verified, status')
      .eq('id', aidantId)
      .single();

    if (aidantError || !aidant) {
      return res.status(404).json({ error: 'Aidant non trouvé' });
    }

    if (!aidant.is_verified || aidant.status !== 'approved') {
      return res.status(400).json({ error: 'Cet aidant n\'est pas approuvé' });
    }

    // Vérifier si un lien existe déjà
    const { data: existingLink } = await supabase
      .from('patient_family_links')
      .select('id')
      .eq('family_id', familyId)
      .eq('family_id', aidant.user_id)
      .maybeSingle();

    if (!existingLink) {
      // Créer un lien entre l'aidant et la famille
      // Note: patient_id est null car c'est une assignation à la famille
      await supabase
        .from('patient_family_links')
        .insert({
          patient_id: null,
          family_id: familyId,
          is_primary: false,
          can_manage_visits: true,
          can_manage_orders: true,
          can_receive_notifications: true,
          metadata: {
            aidant_id: aidantId,
            assignment_type: assignmentType,
            expires_at: expiresAt,
            assigned_by: req.user.id,
            assigned_at: new Date().toISOString(),
          }
        });
    }

    // Notification à l'aidant
    await supabase.from('notifications').insert({
      user_id: aidant.user_id,
      title: '📋 Nouvelle famille assignée',
      body: `Vous avez été assigné à une nouvelle famille. Type: ${assignmentType}`,
      type: 'system',
      data: { family_id: familyId, assignment_type: assignmentType },
    });

    // Notification à la famille
    await supabase.from('notifications').insert({
      user_id: familyId,
      title: '🦸 Aidant assigné',
      body: `Un aidant a été assigné à votre famille.`,
      type: 'system',
      data: { aidant_id: aidantId },
    });

    res.json({ 
      success: true, 
      message: 'Aidant assigné avec succès',
      assignment: { family_id: familyId, aidant_id: aidantId, assignment_type: assignmentType }
    });
  } catch (error) {
    console.error('❌ Assign aidant error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ RÉCUPÉRER LES AIDANTS DISPONIBLES
// =============================================
router.get('/aidants/available', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('aidants')
      .select(`
        *,
        user:profiles(*)
      `)
      .eq('available', true)
      .eq('is_verified', true)
      .eq('status', 'approved')
      .order('rating', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Get available aidants error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// OFFRES
// =============================================
router.get('/offers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('offres')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Get offers error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/offers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('offres')
      .insert(req.body)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, offer: data });
  } catch (error) {
    console.error('❌ Create offer error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/offers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('offres')
      .update(req.body)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, offer: data });
  } catch (error) {
    console.error('❌ Update offer error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
