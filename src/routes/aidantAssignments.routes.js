// 📁 backend/src/routes/aidantAssignments.routes.js

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const roleMiddleware = require('../middleware/role.middleware');
const {
  getActiveAidant,
  getAllAidants,
  assignAidant,
  revokeAssignmentController,
  getAidantAssignments,
  getTargetAssignments,
  checkAssignment,
} = require('../controllers/aidantAssignment.controller');

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
      const { supabase } = require('../services/supabase.service');
      
      const { data, error } = await supabase
        .from('aidant_assignments')
        .select(`
          *,
          aidant:profiles!aidant_user_id(
            id,
            full_name,
            email
          ),
          target_patient:patients!target_id(
            id,
            first_name,
            last_name
          ),
          target_profile:profiles!target_id(
            id,
            full_name,
            email
          )
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;

      res.json({
        success: true,
        data: data || [],
        count: data?.length || 0,
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
      const { supabase } = require('../services/supabase.service');

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

      res.json({
        success: true,
        message: 'Statut mis à jour avec succès',
        data,
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
      const { supabase } = require('../services/supabase.service');

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
      console.error('❌ Erreur getAssignmentStats:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de la récupération des statistiques',
      });
    }
  }
);

// ============================================================
// ROUTES POUR L'ADMIN - ASSIGNATION FORCÉE
// ============================================================

// POST /api/assignments/admin/force
// Assignation forcée par un admin (ignore les quotas)
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

      const { supabase } = require('../services/supabase.service');

      // ✅ Validation
      if (!aidantUserId || !targetType || !targetId) {
        return res.status(400).json({
          success: false,
          error: 'aidantUserId, targetType et targetId sont requis',
        });
      }

      // ✅ Vérifier que l'aidant existe
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

      // ✅ Vérifier que la cible existe
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

      // ✅ Appeler la fonction d'assignation
      const { assignAidantToTarget } = require('../services/aidantAssignment.service');

      // Si force = true, on ignore le quota
      // On le fait en passant directement par la fonction SQL
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

      if (!result.success && !force) {
        return res.status(400).json({
          success: false,
          error: result.error,
          code: result.code,
        });
      }

      // Si force = true et l'assignation a échoué à cause du quota, on la force
      if (!result.success && force && result.code === 'AIDANT_FULL') {
        // Supprimer les anciennes assignations pour libérer de la place
        await supabase
          .from('aidant_assignments')
          .update({
            status: 'inactive',
            reason: 'Supprimé pour assignation forcée',
            updated_at: new Date().toISOString(),
          })
          .eq('aidant_user_id', aidantUserId)
          .eq('status', 'active');

        // Réessayer l'assignation
        const retryResult = await assignAidantToTarget({
          aidantUserId,
          targetType,
          targetId,
          familyId: familyId || null,
          assignmentType,
          createdBy: req.user.id,
          reason: reason || `Assignation forcée par admin (quota réinitialisé)`,
          expiresAt: expiresAt || null,
        });

        if (!retryResult.success) {
          return res.status(400).json({
            success: false,
            error: retryResult.error,
            code: retryResult.code,
          });
        }

        return res.status(201).json({
          success: true,
          message: 'Assignation forcée réussie (quota réinitialisé)',
          data: retryResult,
          forced: true,
        });
      }

      res.status(201).json({
        success: true,
        message: 'Assignation réussie',
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

module.exports = router;
