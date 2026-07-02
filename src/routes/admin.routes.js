// 📁 backend/src/routes/admin.routes.js
 
const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const roleMiddleware = require('../middleware/role.middleware');
const {
  assignAidantToTarget,
  revokeAssignment,
  getAssignmentsByTarget,
  getAssignmentsByAidant,
  TARGET_TYPES,
  ASSIGNMENT_TYPES,
} = require('../services/aidantAssignment.service');

router.use(authMiddleware);
router.use(roleMiddleware(['admin', 'coordinator']));

// =============================================
// ✅ SUPPRIMER UN UTILISATEUR (ADMIN)
// =============================================
router.delete('/users/:id', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Supprimer les assignations de l'utilisateur
    await supabase.from('aidant_assignments').delete().or(`aidant_user_id.eq.${id}, target_id.eq.${id}`);
    
    // 2. Supprimer les données associées
    await supabase.from('patient_family_links').delete().eq('family_id', id);
    await supabase.from('patient_aidant_assignments').delete().eq('family_id', id);
    await supabase.from('inscriptions').delete().eq('user_id', id);
    await supabase.from('notifications').delete().eq('user_id', id);
    await supabase.from('profiles').delete().eq('id', id);

    // 3. Supprimer l'utilisateur Auth (via Service Role)
    const { error } = await supabase.auth.admin.deleteUser(id);
    
    if (error) throw error;

    res.json({ success: true, message: 'Utilisateur supprimé avec succès' });
  } catch (error) {
    console.error('❌ Delete user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// STATISTIQUES - CORRIGÉ
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

    // ✅ UNIQUEMENT LES AIDANTS EN ATTENTE
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

    // ✅ STATS ASSIGNATIONS (NOUVEAU)
    const { count: totalAssignments } = await supabase
      .from('aidant_assignments')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');

    const { count: primaryAssignments } = await supabase
      .from('aidant_assignments')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active')
      .eq('assignment_type', 'primary');

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
      // ✅ NOUVEAUX STATS
      assignments: {
        total: totalAssignments || 0,
        primary: primaryAssignments || 0,
      },
    });
  } catch (error) {
    console.error('❌ Get stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// INSCRIPTIONS - CORRIGÉ POUR NE AFFICHER QUE LES EN ATTENTE
// =============================================
router.get('/registrations', async (req, res) => {
  try {
    // ✅ Récupérer UNIQUEMENT les inscriptions en attente (aidants)
    const { data, error } = await supabase
      .from('inscriptions')
      .select(`
        id,
        user_id,
        patient_data,
        offre_id,
        status,
        comments,
        source,
        created_at,
        updated_at,
        user:profiles!user_id (
          id,
          full_name,
          email,
          phone,
          role
        )
      `)
      .eq('status', 'en_attente')  
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
// ✅ ASSIGNER UN AIDANT (NOUVELLE VERSION ADMIN)
// =============================================
router.post('/assign-aidant', async (req, res) => {
  try {
    const { 
      familyId,          // ID du compte ou de la famille
      aidantId,          // ID de l'aidant (UUID)
      targetType,        // 'patient' | 'personal_account' | 'family'
      targetId,          // ID de la cible
      assignmentType = 'primary',
      reason = null,
      expiresAt = null,
      force = false,
    } = req.body;

    // ✅ Si on utilise l'ancien format (familyId + aidantId)
    // on le convertit en nouveau format
    let finalTargetType = targetType;
    let finalTargetId = targetId;
    let finalFamilyId = familyId;

    if (!targetType && familyId) {
      // Si c'est une assignation à une famille
      finalTargetType = TARGET_TYPES.FAMILY;
      finalTargetId = familyId;
      finalFamilyId = familyId;
    } else if (targetType === TARGET_TYPES.PATIENT && !targetId) {
      return res.status(400).json({
        success: false,
        error: 'Pour un patient, targetId est requis',
      });
    } else if (targetType === TARGET_TYPES.PERSONAL_ACCOUNT && !targetId) {
      finalTargetId = familyId;
    }

    if (!aidantId) {
      return res.status(400).json({
        success: false,
        error: 'aidantId est requis',
      });
    }

    if (!finalTargetType || !finalTargetId) {
      return res.status(400).json({
        success: false,
        error: 'targetType et targetId sont requis, ou familyId',
      });
    }

    // ✅ Vérifier que l'aidant existe
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, is_verified, status, max_assignments')
      .eq('id', aidantId)
      .single();

    if (aidantError || !aidant) {
      return res.status(404).json({
        success: false,
        error: 'Aidant non trouvé',
      });
    }

    if (!aidant.is_verified || aidant.status !== 'approved') {
      return res.status(400).json({
        success: false,
        error: 'Cet aidant n\'est pas approuvé',
      });
    }

    // ✅ Si force = true, on ignore les quotas
    let result;
    if (force) {
      // Supprimer les anciennes assignations pour libérer de la place
      await supabase
        .from('aidant_assignments')
        .update({
          status: 'inactive',
          reason: 'Supprimé pour assignation forcée',
          updated_at: new Date().toISOString(),
        })
        .eq('aidant_user_id', aidant.user_id)
        .eq('status', 'active');

      // Réessayer l'assignation
      result = await assignAidantToTarget({
        aidantUserId: aidant.user_id,
        targetType: finalTargetType,
        targetId: finalTargetId,
        familyId: finalFamilyId || finalTargetId,
        assignmentType: assignmentType,
        createdBy: req.user.id,
        reason: reason || `Assignation forcée par admin (${req.user.id})`,
        expiresAt: expiresAt || null,
      });
    } else {
      result = await assignAidantToTarget({
        aidantUserId: aidant.user_id,
        targetType: finalTargetType,
        targetId: finalTargetId,
        familyId: finalFamilyId || finalTargetId,
        assignmentType: assignmentType,
        createdBy: req.user.id,
        reason: reason || `Assignation par admin (${req.user.id})`,
        expiresAt: expiresAt || null,
      });
    }

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

    // ✅ Notification supplémentaire pour les admins
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (admins && admins.length > 0) {
      const adminNotifications = admins.map((admin) => ({
        user_id: admin.id,
        title: `📋 Assignation ${force ? 'forcée' : ''} effectuée`,
        body: `Un aidant a été assigné par ${req.user.id} à ${finalTargetType} ${finalTargetId}`,
        type: 'alert',
        data: {
          assignment_id: result.assignment?.id,
          aidant_id: aidantId,
          target_type: finalTargetType,
          target_id: finalTargetId,
          forced: force || false,
          assigned_by: req.user.id,
        },
      }));

      await supabase.from('notifications').insert(adminNotifications);
    }

    res.json({
      success: true,
      message: `Aidant assigné avec succès${force ? ' (forcé)' : ''}`,
      data: result,
      forced: force || false,
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
// ✅ RÉCUPÉRER TOUTES LES ASSIGNATIONS (ADMIN)
// =============================================
router.get('/assignments', async (req, res) => {
  try {
    const { status, targetType, targetId } = req.query;

    let query = supabase
      .from('aidant_assignments')
      .select(`
        *,
        aidant:profiles!aidant_user_id(
          id,
          full_name,
          email,
          phone,
          avatar_url
        ),
        target_patient:patients!target_id(
          id,
          first_name,
          last_name,
          address,
          category
        ),
        target_profile:profiles!target_id(
          id,
          full_name,
          email,
          phone
        )
      `);

    if (status) {
      query = query.eq('status', status);
    }
    if (targetType) {
      query = query.eq('target_type', targetType);
    }
    if (targetId) {
      query = query.eq('target_id', targetId);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: data || [],
      count: data?.length || 0,
    });
  } catch (error) {
    console.error('❌ Get assignments error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ RÉVOQUER UNE ASSIGNATION (ADMIN)
// =============================================
router.delete('/assignments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const result = await revokeAssignment(id, req.user.id, reason || `Révoqué par admin (${req.user.id})`);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

    res.json({
      success: true,
      message: 'Assignation révoquée avec succès',
      data: result,
    });
  } catch (error) {
    console.error('❌ Revoke assignment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ STATISTIQUES DES ASSIGNATIONS (ADMIN)
// =============================================
router.get('/assignments/stats', async (req, res) => {
  try {
    const [
      { count: total },
      { count: active },
      { count: inactive },
      { count: expired },
      { count: primary },
      { count: secondary },
      { count: temporary },
    ] = await Promise.all([
      supabase.from('aidant_assignments').select('*', { count: 'exact', head: true }),
      supabase.from('aidant_assignments').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('aidant_assignments').select('*', { count: 'exact', head: true }).eq('status', 'inactive'),
      supabase.from('aidant_assignments').select('*', { count: 'exact', head: true }).eq('status', 'expired'),
      supabase.from('aidant_assignments').select('*', { count: 'exact', head: true }).eq('assignment_type', 'primary'),
      supabase.from('aidant_assignments').select('*', { count: 'exact', head: true }).eq('assignment_type', 'secondary'),
      supabase.from('aidant_assignments').select('*', { count: 'exact', head: true }).eq('assignment_type', 'temporary'),
    ]);

    // Répartition par target_type
    const [
      { count: patients },
      { count: personalAccounts },
      { count: families },
    ] = await Promise.all([
      supabase.from('aidant_assignments').select('*', { count: 'exact', head: true }).eq('target_type', 'patient'),
      supabase.from('aidant_assignments').select('*', { count: 'exact', head: true }).eq('target_type', 'personal_account'),
      supabase.from('aidant_assignments').select('*', { count: 'exact', head: true }).eq('target_type', 'family'),
    ]);

    res.json({
      success: true,
      data: {
        total,
        active,
        inactive,
        expired,
        by_type: {
          primary,
          secondary,
          temporary,
        },
        by_target: {
          patient: patients,
          personal_account: personalAccounts,
          family: families,
        },
      },
    });
  } catch (error) {
    console.error('❌ Get assignment stats error:', error);
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
