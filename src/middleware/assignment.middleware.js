// 📁 backend/src/middleware/assignment.middleware.js

const { getActiveAidantForTarget } = require('../services/aidantAssignment.service');
const { supabase } = require('../services/supabase.service');

// ============================================================
// MIDDLEWARE : RÉSOUDRE L'AIDANT ACTIF POUR UNE REQUÊTE
// ============================================================

/**
 * Middleware qui résout automatiquement l'aidant actif pour la cible de la requête
 * et l'attache à req.activeAidant
 * 
 * Utilisation dans les routes :
 * router.get('/visits/:id', resolveActiveAidant, (req, res) => { ... })
 * 
 * Les paramètres sont passés via req.query ou req.params
 * 
 * @param {Object} options
 * @param {string} options.targetType - 'patient' | 'personal_account' | 'family'
 * @param {string} options.targetId - UUID de la cible (peut être un paramètre de route)
 * @param {string} options.familyId - UUID de la famille (optionnel)
 * @param {boolean} options.attachToReq - Si true, attache l'aidant à req.activeAidant (défaut: true)
 * @param {boolean} options.required - Si true, retourne 404 si aucun aidant trouvé (défaut: false)
 */
const resolveActiveAidant = (options = {}) => {
  return async (req, res, next) => {
    try {
      const {
        targetType = 'patient',
        targetId = req.params.id || req.query.targetId,
        familyId = req.query.familyId || req.user?.family_id || null,
        attachToReq = true,
        required = false,
      } = options;

      // ✅ Si targetId est 'me' ou 'my', utiliser l'ID de l'utilisateur
      let resolvedTargetId = targetId;
      if (targetId === 'me' || targetId === 'my') {
        resolvedTargetId = req.user?.id;
      }

      if (!resolvedTargetId) {
        if (required) {
          return res.status(400).json({
            success: false,
            error: 'targetId est requis pour résoudre l\'aidant',
          });
        }
        return next();
      }

      // ✅ Récupérer l'aidant actif
      const aidantId = await getActiveAidantForTarget(
        targetType,
        resolvedTargetId,
        familyId
      );

      // ✅ Si attachToReq, attacher l'aidant à req
      if (attachToReq) {
        req.activeAidant = {
          aidant_id: aidantId,
          target_type: targetType,
          target_id: resolvedTargetId,
        };

        // Récupérer les infos complètes de l'aidant
        if (aidantId) {
          const { data: aidant, error } = await supabase
            .from('profiles')
            .select('id, full_name, email, phone, avatar_url')
            .eq('id', aidantId)
            .single();

          if (!error && aidant) {
            req.activeAidant.profile = aidant;
          }
        }
      }

      // ✅ Si required et aucun aidant trouvé, retourner une erreur
      if (required && !aidantId) {
        return res.status(404).json({
          success: false,
          error: 'Aucun aidant actif trouvé pour cette cible',
          code: 'NO_ACTIVE_AIDANT',
        });
      }

      next();
    } catch (error) {
      console.error('❌ resolveActiveAidant error:', error);
      next(error);
    }
  };
};

// ============================================================
// MIDDLEWARE : VÉRIFIER SI L'AIDANT EST ASSIGNÉ À LA CIBLE
// ============================================================

/**
 * Middleware qui vérifie si l'utilisateur connecté (aidant)
 * est assigné à la cible de la requête
 * 
 * Utilisation dans les routes :
 * router.get('/visits/:id', checkAidantAssignment, (req, res) => { ... })
 */
const checkAidantAssignment = (options = {}) => {
  return async (req, res, next) => {
    try {
      const {
        targetType = 'patient',
        targetId = req.params.id || req.query.targetId,
        familyId = req.query.familyId || req.user?.family_id || null,
        requireAssignment = true,
      } = options;

      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Non authentifié',
        });
      }

      // Vérifier si l'utilisateur est un aidant
      const { data: aidant, error: aidantError } = await supabase
        .from('aidants')
        .select('id, user_id, is_verified, status')
        .eq('user_id', userId)
        .single();

      if (aidantError || !aidant) {
        if (requireAssignment) {
          return res.status(403).json({
            success: false,
            error: 'Vous n\'êtes pas un aidant',
            code: 'NOT_AIDANT',
          });
        }
        return next();
      }

      // Vérifier si l'aidant est assigné à la cible
      const { data: assignment, error: assignError } = await supabase
        .from('aidant_assignments')
        .select('*')
        .eq('aidant_user_id', userId)
        .eq('target_type', targetType)
        .eq('target_id', targetId)
        .eq('status', 'active')
        .maybeSingle();

      if (assignError) {
        console.error('❌ Erreur vérification assignation:', assignError);
      }

      // Si l'aidant n'est pas assigné
      if (!assignment && requireAssignment) {
        return res.status(403).json({
          success: false,
          error: 'Vous n\'êtes pas assigné à cette cible',
          code: 'NOT_ASSIGNED_TO_TARGET',
        });
      }

      // Attacher l'assignation à req
      req.assignment = assignment || null;
      req.isAssignedToTarget = !!assignment;

      next();
    } catch (error) {
      console.error('❌ checkAidantAssignment error:', error);
      next(error);
    }
  };
};

// ============================================================
// MIDDLEWARE : RÉSOUDRE TOUS LES AIDANTS POUR UNE CIBLE
// ============================================================

/**
 * Middleware qui résout tous les aidants (principal + secondaires)
 * pour la cible de la requête
 * 
 * Attache les résultats à req.allAidants
 */
const resolveAllAidants = (options = {}) => {
  return async (req, res, next) => {
    try {
      const {
        targetType = 'patient',
        targetId = req.params.id || req.query.targetId,
        familyId = req.query.familyId || req.user?.family_id || null,
        attachToReq = true,
      } = options;

      if (!targetId) {
        return next();
      }

      const { getAllAidantsForTarget } = require('../services/aidantAssignment.service');

      const aidants = await getAllAidantsForTarget(targetType, targetId, familyId);

      if (attachToReq) {
        req.allAidants = aidants || [];

        // Enrichir avec les profils
        const aidantIds = aidants.map(a => a.aidant_user_id).filter(Boolean);
        if (aidantIds.length > 0) {
          const { data: profiles, error } = await supabase
            .from('profiles')
            .select('id, full_name, email, phone, avatar_url')
            .in('id', aidantIds);

          if (!error && profiles) {
            const profileMap = profiles.reduce((acc, p) => {
              acc[p.id] = p;
              return acc;
            }, {});

            req.allAidants = req.allAidants.map(a => ({
              ...a,
              profile: profileMap[a.aidant_user_id] || null,
            }));
          }
        }
      }

      next();
    } catch (error) {
      console.error('❌ resolveAllAidants error:', error);
      next(error);
    }
  };
};

// ============================================================
// MIDDLEWARE : VALIDER LA CIBLE
// ============================================================

/**
 * Middleware qui valide que la cible existe et est accessible
 * par l'utilisateur connecté
 */
const validateTarget = (options = {}) => {
  return async (req, res, next) => {
    try {
      const {
        targetType = 'patient',
        targetId = req.params.id || req.query.targetId,
        checkOwnership = false,
      } = options;

      if (!targetId) {
        return next();
      }

      let targetExists = false;
      let targetData = null;

      switch (targetType) {
        case 'patient':
          const { data: patient, error: patientError } = await supabase
            .from('patients')
            .select('*')
            .eq('id', targetId)
            .single();

          if (!patientError && patient) {
            targetExists = true;
            targetData = patient;

            // Vérifier l'accès si checkOwnership
            if (checkOwnership) {
              const userId = req.user?.id;
              const userRole = req.profile?.role;

              if (!['admin', 'coordinator'].includes(userRole)) {
                const { data: link, error: linkError } = await supabase
                  .from('patient_family_links')
                  .select('id')
                  .eq('family_id', userId)
                  .eq('patient_id', targetId)
                  .maybeSingle();

                if (linkError || !link) {
                  return res.status(403).json({
                    success: false,
                    error: 'Accès non autorisé à ce patient',
                    code: 'ACCESS_DENIED',
                  });
                }
              }
            }
          }
          break;

        case 'personal_account':
        case 'family':
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', targetId)
            .single();

          if (!profileError && profile) {
            targetExists = true;
            targetData = profile;

            // Vérifier l'accès si checkOwnership
            if (checkOwnership) {
              const userId = req.user?.id;
              const userRole = req.profile?.role;

              if (!['admin', 'coordinator'].includes(userRole) && targetId !== userId) {
                return res.status(403).json({
                  success: false,
                  error: 'Accès non autorisé à ce compte',
                  code: 'ACCESS_DENIED',
                });
              }
            }
          }
          break;

        default:
          return res.status(400).json({
            success: false,
            error: 'targetType invalide',
            code: 'INVALID_TARGET_TYPE',
          });
      }

      if (!targetExists) {
        return res.status(404).json({
          success: false,
          error: 'Cible non trouvée',
          code: 'TARGET_NOT_FOUND',
        });
      }

      req.targetData = targetData;
      req.targetExists = true;

      next();
    } catch (error) {
      console.error('❌ validateTarget error:', error);
      next(error);
    }
  };
};

// ============================================================
// MIDDLEWARE : CHECK QUOTA AIDANT
// ============================================================

/**
 * Middleware qui vérifie si l'aidant a encore de la place
 * pour de nouvelles assignations
 */
const checkAidantQuota = (options = {}) => {
  return async (req, res, next) => {
    try {
      const { aidantUserId = req.body.aidantUserId || req.query.aidantUserId } = options;

      if (!aidantUserId) {
        return next();
      }

      const { data: aidant, error: aidantError } = await supabase
        .from('aidants')
        .select('id, max_assignments, current_assignments')
        .eq('user_id', aidantUserId)
        .single();

      if (aidantError || !aidant) {
        return res.status(404).json({
          success: false,
          error: 'Aidant non trouvé',
          code: 'AIDANT_NOT_FOUND',
        });
      }

      const maxAssignments = aidant.max_assignments || 4;
      const currentAssignments = aidant.current_assignments || 0;

      if (currentAssignments >= maxAssignments) {
        return res.status(400).json({
          success: false,
          error: `Cet aidant a déjà ${currentAssignments} assignations (maximum ${maxAssignments})`,
          code: 'AIDANT_FULL',
          data: {
            current: currentAssignments,
            max: maxAssignments,
          },
        });
      }

      req.aidantQuota = {
        current: currentAssignments,
        max: maxAssignments,
        available: maxAssignments - currentAssignments,
      };

      next();
    } catch (error) {
      console.error('❌ checkAidantQuota error:', error);
      next(error);
    }
  };
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  resolveActiveAidant,
  checkAidantAssignment,
  resolveAllAidants,
  validateTarget,
  checkAidantQuota,
};
