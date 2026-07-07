// 📁 backend/src/routes/aidantAssignments.routes.js
// Corrigé et complet pour la synchronisation multi-appareil et multi-type

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');
const {
  getActiveAidant,
  getAllAidants,
  assignAidant,
  revokeAssignmentController,
  getAidantAssignments,
  getTargetAssignments,
  checkAssignment,
} = require('../controllers/aidantAssignment.controller');
const { supabase } = require('../services/supabase.service');
const { 
  mapTargetTypeForResponse, 
  assignAidantToTarget,
  getAvailableAidantsForFamily,
  adminAssignAidantToVisit,
  getPendingAidantVisits,
  revokeAssignment,
} = require('../services/aidantAssignment.service');
const { createNotification } = require('../services/notification.service');

// Toutes les routes nécessitent une authentification
router.use(authMiddleware);

// ============================================================
// ROUTES PUBLIQUES (pour les utilisateurs authentifiés)
// ============================================================

// GET /api/assignments/active
// Récupère l'aidant actif pour une cible
router.get('/active', getActiveAidant);

// GET /api/assignments/all
// Récupère tous les aidants pour une cible
router.get('/all', getAllAidants);

// GET /api/assignments/check
// Vérifie si un aidant est assigné à une cible
router.get('/check', checkAssignment);

// ============================================================
// ✅ ROUTE GET /api/assignments - UTILISE LA VUE
// Récupère toutes les assignations actives (admin uniquement)
// ============================================================
router.get(
  '/',
  roleMiddleware(['admin', 'coordinator']),
  async (req, res) => {
    try {
      // ✅ Utiliser la vue pour les relations
      const { data: assignments, error } = await supabase
        .from('aidant_assignments_view')
        .select('*')
        .eq('status', 'active')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('❌ Assignments error:', error);
        return res.status(500).json({
          success: false,
          error: error.message,
        });
      }

      // ✅ Formater les données avec mapping des types
      const formattedAssignments = (assignments || []).map((item) => ({
        id: item.id,
        aidant_user_id: item.aidant_user_id,
        target_type: mapTargetTypeForResponse(item.target_type),
        target_id: item.target_id,
        assignment_type: item.assignment_type,
        status: item.status,
        priority: item.priority,
        expires_at: item.expires_at,
        created_at: item.created_at,
        updated_at: item.updated_at,
        created_by: item.created_by,
        reason: item.reason,
        aidant: item.aidant_id ? {
          id: item.aidant_id,
          full_name: item.aidant_name,
          email: item.aidant_email,
          phone: item.aidant_phone,
          avatar_url: item.aidant_avatar,
        } : null,
        target_patient: item.target_type === 'patient' && item.patient_id ? {
          id: item.patient_id,
          first_name: item.patient_first_name,
          last_name: item.patient_last_name,
          address: item.patient_address,
          category: item.patient_category,
          status: item.patient_status,
        } : null,
        target_profile: item.target_type !== 'patient' && item.profile_id ? {
          id: item.profile_id,
          full_name: item.profile_name,
          email: item.profile_email,
          phone: item.profile_phone,
          role: item.profile_role,
        } : null,
      }));

      res.json({
        success: true,
        data: formattedAssignments || [],
        count: formattedAssignments?.length || 0,
      });
    } catch (error) {
      console.error('❌ Erreur getAssignments:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de la récupération des assignations',
      });
    }
  }
);

// ============================================================
// ROUTES POUR LES ASSIGNATIONS (CRUD)
// ============================================================

// POST /api/assignments
// Crée une nouvelle assignation
router.post('/', assignAidant);

// DELETE /api/assignments/:id
// Révoque une assignation
router.delete('/:id', revokeAssignmentController);

// ============================================================
// ROUTES POUR RÉCUPÉRER LES ASSIGNATIONS
// ============================================================

// GET /api/assignments/aidant/:aidantUserId
// Récupère toutes les assignations d'un aidant
router.get('/aidant/:aidantUserId', getAidantAssignments);

// GET /api/assignments/target/:targetType/:targetId
// Récupère toutes les assignations pour une cible
router.get('/target/:targetType/:targetId', getTargetAssignments);

// ============================================================
// ROUTES ADMIN (avec vérification de rôle)
// ============================================================

// GET /api/assignments/admin/all
// Récupère toutes les assignations (admin uniquement)
router.get(
  '/admin/all',
  roleMiddleware(['admin', 'coordinator']),
  async (req, res) => {
    try {
      // ✅ Utiliser la vue
      const { data: assignments, error } = await supabase
        .from('aidant_assignments_view')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('❌ Erreur getAdminAllAssignments:', error);
        return res.status(500).json({
          success: false,
          error: error.message,
        });
      }

      // ✅ Formater les données avec mapping des types
      const formattedAssignments = (assignments || []).map((item) => ({
        id: item.id,
        aidant_user_id: item.aidant_user_id,
        target_type: mapTargetTypeForResponse(item.target_type),
        target_id: item.target_id,
        assignment_type: item.assignment_type,
        status: item.status,
        priority: item.priority,
        expires_at: item.expires_at,
        created_at: item.created_at,
        updated_at: item.updated_at,
        created_by: item.created_by,
        reason: item.reason,
        aidant: item.aidant_id ? {
          id: item.aidant_id,
          full_name: item.aidant_name,
          email: item.aidant_email,
          phone: item.aidant_phone,
          avatar_url: item.aidant_avatar,
        } : null,
        target_patient: item.target_type === 'patient' && item.patient_id ? {
          id: item.patient_id,
          first_name: item.patient_first_name,
          last_name: item.patient_last_name,
          address: item.patient_address,
          category: item.patient_category,
          status: item.patient_status,
        } : null,
        target_profile: item.target_type !== 'patient' && item.profile_id ? {
          id: item.profile_id,
          full_name: item.profile_name,
          email: item.profile_email,
          phone: item.profile_phone,
          role: item.profile_role,
        } : null,
      }));

      res.json({
        success: true,
        data: formattedAssignments || [],
        count: formattedAssignments?.length || 0,
      });
    } catch (error) {
      console.error('❌ Erreur getAdminAllAssignments:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de la récupération des assignations',
      });
    }
  }
);

// PUT /api/assignments/admin/:id/status
// Met à jour le statut d'une assignation (admin uniquement)
router.put(
  '/admin/:id/status',
  roleMiddleware(['admin', 'coordinator']),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, reason } = req.body;

      if (!status) {
        return res.status(400).json({
          success: false,
          error: 'Le statut est requis',
        });
      }

      const validStatuses = ['active', 'inactive', 'expired'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          error: `Statut invalide. Valeurs acceptées: ${validStatuses.join(', ')}`,
        });
      }

      const { data, error } = await supabase
        .from('aidant_assignments')
        .update({
          status,
          reason: reason || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;

      // ✅ Formater la réponse avec mapping
      const formattedData = {
        ...data,
        target_type: mapTargetTypeForResponse(data.target_type),
      };

      res.json({
        success: true,
        message: 'Statut mis à jour avec succès',
        data: formattedData,
      });
    } catch (error) {
      console.error('❌ Erreur updateAssignmentStatus:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de la mise à jour du statut',
      });
    }
  }
);

// ============================================================
// ROUTES POUR LES MÉTRIQUES (admin uniquement)
// ============================================================

// GET /api/assignments/admin/stats
// Statistiques des assignations (admin uniquement)
router.get(
  '/admin/stats',
  roleMiddleware(['admin', 'coordinator']),
  async (req, res) => {
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
      console.error('❌ Erreur getAssignmentStats:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de la récupération des statistiques',
      });
    }
  }
);

// ============================================================
// ROUTE FAMILY ASSIGN
// ============================================================
router.post('/family/assign', authMiddleware, async (req, res) => {
  try {
    const { aidantUserId, targetType, targetId, assignmentType, patientId } = req.body;
    const userId = req.user.id;
    const userRole = req.profile?.role;

    if (userRole !== 'family') {
      return res.status(403).json({
        success: false,
        error: 'Seules les familles peuvent effectuer cette action'
      });
    }

    let finalTargetType = targetType || 'personal_account';
    let finalTargetId = targetId || userId;
    let finalFamilyId = userId;

    if (targetType === 'patient' && patientId) {
      const { data: link, error: linkError } = await supabase
        .from('patient_family_links')
        .select('id')
        .eq('family_id', userId)
        .eq('patient_id', patientId)
        .maybeSingle();

      if (linkError || !link) {
        return res.status(403).json({
          success: false,
          error: 'Ce patient ne vous appartient pas'
        });
      }
      finalTargetId = patientId;
    }

    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, is_verified, status, available')
      .eq('id', aidantUserId)
      .single();

    if (aidantError || !aidant) {
      return res.status(404).json({
        success: false,
        error: 'Aidant non trouvé'
      });
    }

    if (!aidant.is_verified || aidant.status !== 'approved') {
      return res.status(400).json({
        success: false,
        error: 'Cet aidant n\'est pas disponible'
      });
    }

    const { count: currentAssignments, error: countError } = await supabase
      .from('aidant_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('aidant_user_id', aidant.user_id)
      .eq('status', 'active');

    if (countError) {
      console.error('❌ Erreur comptage assignations:', countError);
    }

    const maxAssignments = aidant.max_assignments || 4;
    if ((currentAssignments || 0) >= maxAssignments) {
      return res.status(400).json({
        success: false,
        error: `Cet aidant a déjà ${currentAssignments} assignations (maximum ${maxAssignments})`,
        code: 'AIDANT_FULL',
      });
    }

    const result = await assignAidantToTarget({
      aidantUserId: aidant.user_id,
      targetType: finalTargetType,
      targetId: finalTargetId,
      familyId: finalFamilyId,
      assignmentType: assignmentType || 'primary',
      createdBy: userId,
      reason: `Assigné par la famille ${userId}`,
      expiresAt: null,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        code: result.code,
      });
    }

    res.status(201).json({
      success: true,
      message: 'Aidant assigné avec succès',
      data: result,
    });
  } catch (error) {
    console.error('❌ Family assign error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de l\'assignation',
    });
  }
});

// ============================================================
// ROUTES POUR L'ADMIN - ASSIGNATION FORCÉE
// ============================================================
router.post(
  '/admin/force',
  roleMiddleware(['admin', 'coordinator']),
  async (req, res) => {
    try {
      const {
        aidantUserId,
        targetType,
        targetId,
        familyId,
        assignmentType = 'primary',
        reason,
        expiresAt,
        force = false,
      } = req.body;

      if (!aidantUserId || !targetType || !targetId) {
        return res.status(400).json({
          success: false,
          error: 'aidantUserId, targetType et targetId sont requis',
        });
      }

      const { data: aidant, error: aidantError } = await supabase
        .from('aidants')
        .select('id, user_id, is_verified, status')
        .eq('user_id', aidantUserId)
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

      let targetExists = false;
      let targetName = '';

      switch (targetType) {
        case 'patient':
          const { data: patient, error: patientError } = await supabase
            .from('patients')
            .select('id, first_name, last_name')
            .eq('id', targetId)
            .single();

          if (!patientError && patient) {
            targetExists = true;
            targetName = `${patient.first_name} ${patient.last_name}`;
          }
          break;

        case 'personal_account':
        case 'family':
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id, full_name')
            .eq('id', targetId)
            .single();

          if (!profileError && profile) {
            targetExists = true;
            targetName = profile.full_name;
          }
          break;

        default:
          return res.status(400).json({
            success: false,
            error: 'targetType invalide',
          });
      }

      if (!targetExists) {
        return res.status(404).json({
          success: false,
          error: 'Cible non trouvée',
        });
      }

      const { count: currentAssignments, error: countError } = await supabase
        .from('aidant_assignments')
        .select('id', { count: 'exact', head: true })
        .eq('aidant_user_id', aidantUserId)
        .eq('status', 'active');

      if (countError) {
        console.error('❌ Erreur comptage assignations:', countError);
      }

      const maxAssignments = aidant.max_assignments || 4;
      const isFull = (currentAssignments || 0) >= maxAssignments;

      if (isFull && !force) {
        return res.status(400).json({
          success: false,
          error: `Cet aidant a déjà ${currentAssignments} assignations (maximum ${maxAssignments})`,
          code: 'AIDANT_FULL',
          current: currentAssignments || 0,
          max: maxAssignments,
        });
      }

      if (isFull && force) {
        const { data: oldestAssignment, error: oldestError } = await supabase
          .from('aidant_assignments')
          .select('id')
          .eq('aidant_user_id', aidantUserId)
          .eq('status', 'active')
          .order('priority', { ascending: false })
          .order('created_at', { ascending: true })
          .limit(1)
          .single();

        if (oldestError) {
          console.error('❌ Erreur récupération assignation la moins prioritaire:', oldestError);
        } else if (oldestAssignment) {
          await supabase
            .from('aidant_assignments')
            .update({
              status: 'inactive',
              reason: `Supprimé pour assignation forcée par ${req.user.id}`,
              updated_at: new Date().toISOString(),
            })
            .eq('id', oldestAssignment.id);
        }
      }

      const result = await assignAidantToTarget({
        aidantUserId,
        targetType,
        targetId,
        familyId: familyId || null,
        assignmentType,
        createdBy: req.user.id,
        reason: reason || `Assignation forcée par admin${force ? ' (forcée)' : ''}`,
        expiresAt: expiresAt || null,
      });

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error,
          code: result.code,
        });
      }

      res.status(201).json({
        success: true,
        message: `Assignation ${force ? 'forcée ' : ''}réussie`,
        data: result,
        forced: force || false,
      });
    } catch (error) {
      console.error('❌ Erreur forceAssignAidant:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de l\'assignation forcée',
      });
    }
  }
);

// ============================================================
// ✅ ROUTE : ADMIN ASSIGNER UN AIDANT À UNE VISITE
// ============================================================
router.post(
  '/admin/assign-to-visit',
  roleMiddleware(['admin', 'coordinator']),
  async (req, res) => {
    try {
      const { visitId, aidantId, assignmentType = 'permanente', reason = null, force = false } = req.body;

      if (!visitId || !aidantId) {
        return res.status(400).json({
          success: false,
          error: 'visitId et aidantId sont requis',
        });
      }

      const result = await adminAssignAidantToVisit({
        visitId,
        aidantUserId: aidantId,
        assignmentType,
        adminId: req.user.id,
        reason: reason || `Assigné par admin ${req.user.id}`,
        force,
      });

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error,
          code: result.code,
          current: result.current,
          max: result.max,
        });
      }

      const { data: visit, error } = await supabase
        .from('visites')
        .select(`
          *,
          patient:patients(*),
          aidant:aidants!visites_aidant_id_fkey (
            id,
            user_id,
            specialties,
            available,
            rating,
            total_missions,
            completed_missions,
            cancelled_missions,
            user:profiles!aidants_user_id_fkey (
              id,
              full_name,
              email,
              phone,
              avatar_url
            )
          )
        `)
        .eq('id', visitId)
        .single();

      if (error) {
        console.error('❌ Erreur récupération visite:', error);
      }

      res.json({
        success: true,
        message: result.message,
        visit: visit || result.visit,
        assignment_type: result.assignment_type,
        is_permanent: result.is_permanent,
        forced: result.forced,
        current_assignments: result.current_assignments,
      });
    } catch (error) {
      console.error('❌ Admin assign aidant to visit error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// ============================================================
// ✅ ROUTE : RÉCUPÉRER LES VISITES EN ATTENTE D'AIDANT
// ============================================================
router.get(
  '/admin/pending-aidant',
  roleMiddleware(['admin', 'coordinator']),
  async (req, res) => {
    try {
      const visits = await getPendingAidantVisits();

      const visitsWithRelations = await Promise.all(visits.map(async (visit) => {
        let patient = null;
        if (visit.patient_id) {
          const { data } = await supabase
            .from('patients')
            .select('*')
            .eq('id', visit.patient_id)
            .single();
          patient = data;
        }

        let family = null;
        if (visit.user_id) {
          const { data } = await supabase
            .from('profiles')
            .select('id, full_name, email, phone')
            .eq('id', visit.user_id)
            .single();
          family = data;
        }

        return {
          ...visit,
          patient,
          family,
        };
      }));

      res.json({
        success: true,
        data: visitsWithRelations,
        count: visitsWithRelations.length,
      });
    } catch (error) {
      console.error('❌ Get pending aidant visits error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// ============================================================
// ✅ ROUTE : RÉCUPÉRER LES AIDANTS DISPONIBLES POUR UNE FAMILLE
// ============================================================
router.get(
  '/available-for-family',
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const userRole = req.profile?.role;

      if (userRole !== 'family') {
        return res.status(403).json({
          success: false,
          error: 'Accès réservé aux familles',
        });
      }

      const { zone, specialty, minRating } = req.query;

      const aidants = await getAvailableAidantsForFamily(userId, {
        zone,
        specialty,
        minRating: minRating ? parseFloat(minRating) : undefined,
      });

      res.json({
        success: true,
        data: aidants,
        count: aidants.length,
      });
    } catch (error) {
      console.error('❌ Get available aidants for family error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// ============================================================
// ✅ ROUTE : RÉCUPÉRER TOUTES LES ASSIGNATIONS (AVEC STATUT)
// ============================================================
router.get(
  '/admin/all-with-status',
  roleMiddleware(['admin', 'coordinator']),
  async (req, res) => {
    try {
      const { status, targetType, targetId, aidantUserId } = req.query;

      let query = supabase
        .from('aidant_assignments_view')
        .select('*');

      if (status) {
        query = query.eq('status', status);
      }
      if (targetType) {
        query = query.eq('target_type', targetType);
      }
      if (targetId) {
        query = query.eq('target_id', targetId);
      }
      if (aidantUserId) {
        query = query.eq('aidant_user_id', aidantUserId);
      }

      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) {
        console.error('❌ Get all assignments with status error:', error);
        return res.status(500).json({
          success: false,
          error: error.message,
        });
      }

      const formattedAssignments = (data || []).map((item) => ({
        id: item.id,
        aidant_user_id: item.aidant_user_id,
        target_type: mapTargetTypeForResponse(item.target_type),
        target_id: item.target_id,
        assignment_type: item.assignment_type,
        status: item.status,
        priority: item.priority,
        expires_at: item.expires_at,
        created_at: item.created_at,
        updated_at: item.updated_at,
        created_by: item.created_by,
        reason: item.reason,
        aidant: item.aidant_id ? {
          id: item.aidant_id,
          full_name: item.aidant_name,
          email: item.aidant_email,
          phone: item.aidant_phone,
          avatar_url: item.aidant_avatar,
        } : null,
        target_patient: item.target_type === 'patient' && item.patient_id ? {
          id: item.patient_id,
          first_name: item.patient_first_name,
          last_name: item.patient_last_name,
          address: item.patient_address,
          category: item.patient_category,
          status: item.patient_status,
        } : null,
        target_profile: item.target_type !== 'patient' && item.profile_id ? {
          id: item.profile_id,
          full_name: item.profile_name,
          email: item.profile_email,
          phone: item.profile_phone,
          role: item.profile_role,
        } : null,
      }));

      res.json({
        success: true,
        data: formattedAssignments || [],
        count: formattedAssignments?.length || 0,
      });
    } catch (error) {
      console.error('❌ Get all assignments with status error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de la récupération des assignations',
      });
    }
  }
);

// ============================================================
// ✅ ROUTE POUR LES FAMILLES
// ============================================================
router.get(
  '/my',
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const userRole = req.profile?.role;

      if (userRole !== 'family') {
        return res.status(403).json({
          success: false,
          error: 'Accès réservé aux familles',
        });
      }

      const { data: assignments, error } = await supabase
        .from('aidant_assignments_view')
        .select('*')
        .or(`target_id.eq.${userId}, target_type.eq.family`)
        .eq('status', 'active')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('❌ Assignments error:', error);
        return res.status(500).json({
          success: false,
          error: error.message,
        });
      }

      const formattedAssignments = (assignments || []).map((item) => ({
        id: item.id,
        aidant_user_id: item.aidant_user_id,
        target_type: mapTargetTypeForResponse(item.target_type),
        target_id: item.target_id,
        assignment_type: item.assignment_type,
        status: item.status,
        priority: item.priority,
        expires_at: item.expires_at,
        created_at: item.created_at,
        updated_at: item.updated_at,
        created_by: item.created_by,
        reason: item.reason,
        aidant: item.aidant_id ? {
          id: item.aidant_id,
          full_name: item.aidant_name,
          email: item.aidant_email,
          phone: item.aidant_phone,
          avatar_url: item.aidant_avatar,
        } : null,
        target_patient: item.target_type === 'patient' && item.patient_id ? {
          id: item.patient_id,
          first_name: item.patient_first_name,
          last_name: item.patient_last_name,
          address: item.patient_address,
          category: item.patient_category,
          status: item.patient_status,
        } : null,
        target_profile: item.target_type !== 'patient' && item.profile_id ? {
          id: item.profile_id,
          full_name: item.profile_name,
          email: item.profile_email,
          phone: item.profile_phone,
          role: item.profile_role,
        } : null,
      }));

      res.json({
        success: true,
        data: formattedAssignments || [],
        count: formattedAssignments?.length || 0,
      });
    } catch (error) {
      console.error('❌ Erreur getMyAssignments:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de la récupération des assignations',
      });
    }
  }
);

// ============================================================
// ✅ ROUTE : ADMIN RÉVOQUER UNE ASSIGNATION AVEC NOTIFICATION
// ============================================================
router.delete(
  '/admin/:id/revoke',
  roleMiddleware(['admin', 'coordinator']),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const { data: assignment, error: fetchError } = await supabase
        .from('aidant_assignments')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchError) {
        return res.status(404).json({
          success: false,
          error: 'Assignation non trouvée',
        });
      }

      const result = await revokeAssignment(id, req.user.id, reason || `Révoqué par admin (${req.user.id})`);

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error,
          code: result.code,
        });
      }

      if (assignment.aidant_user_id) {
        await createNotification({
          userId: assignment.aidant_user_id,
          title: '🔄 Assignation révoquée par l\'administration',
          body: `Votre assignation a été révoquée${reason ? ` : ${reason}` : ''}`,
          type: 'system',
          data: {
            assignment_id: id,
            revoked_by: req.user.id,
            reason: reason || 'Non spécifié',
          },
        });
      }

      res.json({
        success: true,
        message: 'Assignation révoquée avec succès',
        data: result,
      });
    } catch (error) {
      console.error('❌ Admin revoke assignment error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de la révocation',
      });
    }
  }
);

module.exports = router;
 
