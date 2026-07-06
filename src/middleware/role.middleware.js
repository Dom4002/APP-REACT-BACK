// 📁 backend/src/middleware/role.middleware.js

const { supabase } = require('../services/supabase.service');
const { USER_ROLES } = require('../config/constants');

// ============================================================
// MIDDLEWARE : VÉRIFICATION DES RÔLES
// ============================================================

/**
 * Middleware qui vérifie que l'utilisateur a un des rôles autorisés
 * 
 * Utilisation :
 * router.post('/admin', roleMiddleware(['admin', 'coordinator']), (req, res) => { ... })
 * 
 * @param {Array<string>} allowedRoles - Liste des rôles autorisés
 * @returns {Function} Middleware Express
 */
const roleMiddleware = (allowedRoles) => {
  return (req, res, next) => {
    // ✅ Vérifier que le profil existe
    if (!req.profile) {
      return res.status(403).json({
        success: false,
        error: 'Profil utilisateur introuvable',
        code: 'PROFILE_MISSING',
      });
    }

    // ✅ Vérifier le rôle
    if (!allowedRoles.includes(req.profile.role)) {
      return res.status(403).json({
        success: false,
        error: 'Accès non autorisé pour ce rôle',
        required: allowedRoles,
        current: req.profile.role,
        code: 'ROLE_NOT_ALLOWED',
      });
    }

    next();
  };
};

// ============================================================
// MIDDLEWARE : VÉRIFICATION ADMIN OU COORDINATEUR
// ============================================================

/**
 * Vérifie si l'utilisateur est admin ou coordinateur
 * 
 * Utilisation :
 * router.post('/admin', isAdminOrCoordinator, (req, res) => { ... })
 */
const isAdminOrCoordinator = (req, res, next) => {
  if (!req.profile) {
    return res.status(403).json({
      success: false,
      error: 'Profil utilisateur introuvable',
      code: 'PROFILE_MISSING',
    });
  }

  const role = req.profile.role;
  if (role !== USER_ROLES.ADMIN && role !== USER_ROLES.COORDINATOR) {
    return res.status(403).json({
      success: false,
      error: 'Accès réservé aux administrateurs et coordinateurs',
      required: ['admin', 'coordinator'],
      current: role,
      code: 'ROLE_NOT_ALLOWED',
    });
  }

  next();
};

// ============================================================
// MIDDLEWARE : VÉRIFICATION ADMIN UNIQUEMENT
// ============================================================

/**
 * Vérifie si l'utilisateur est admin
 * 
 * Utilisation :
 * router.delete('/users/:id', isAdminOnly, (req, res) => { ... })
 */
const isAdminOnly = (req, res, next) => {
  if (!req.profile) {
    return res.status(403).json({
      success: false,
      error: 'Profil utilisateur introuvable',
      code: 'PROFILE_MISSING',
    });
  }

  if (req.profile.role !== USER_ROLES.ADMIN) {
    return res.status(403).json({
      success: false,
      error: 'Accès réservé aux administrateurs',
      required: ['admin'],
      current: req.profile.role,
      code: 'ROLE_NOT_ALLOWED',
    });
  }

  next();
};

// ============================================================
// MIDDLEWARE : VÉRIFICATION FAMILLE
// ============================================================

/**
 * Vérifie si l'utilisateur est une famille
 * 
 * Utilisation :
 * router.post('/family', isFamily, (req, res) => { ... })
 */
const isFamily = (req, res, next) => {
  if (!req.profile) {
    return res.status(403).json({
      success: false,
      error: 'Profil utilisateur introuvable',
      code: 'PROFILE_MISSING',
    });
  }

  if (req.profile.role !== USER_ROLES.FAMILY) {
    return res.status(403).json({
      success: false,
      error: 'Accès réservé aux familles',
      required: ['family'],
      current: req.profile.role,
      code: 'ROLE_NOT_ALLOWED',
    });
  }

  next();
};

// ============================================================
// MIDDLEWARE : VÉRIFICATION AIDANT
// ============================================================

/**
 * Vérifie si l'utilisateur est un aidant
 * 
 * Utilisation :
 * router.post('/aidant', isAidant, (req, res) => { ... })
 */
const isAidant = (req, res, next) => {
  if (!req.profile) {
    return res.status(403).json({
      success: false,
      error: 'Profil utilisateur introuvable',
      code: 'PROFILE_MISSING',
    });
  }

  if (req.profile.role !== USER_ROLES.AIDANT) {
    return res.status(403).json({
      success: false,
      error: 'Accès réservé aux aidants',
      required: ['aidant'],
      current: req.profile.role,
      code: 'ROLE_NOT_ALLOWED',
    });
  }

  // ✅ Vérifier que l'aidant est approuvé
  if (!req.profile.is_active) {
    return res.status(403).json({
      success: false,
      error: 'Votre compte aidant n\'est pas actif',
      code: 'AIDANT_NOT_ACTIVE',
    });
  }

  next();
};

// ============================================================
// MIDDLEWARE : VÉRIFICATION AIDANT APPROUVÉ
// ============================================================

/**
 * Vérifie si l'utilisateur est un aidant approuvé
 * 
 * Utilisation :
 * router.post('/missions', isApprovedAidant, (req, res) => { ... })
 */
const isApprovedAidant = async (req, res, next) => {
  if (!req.profile) {
    return res.status(403).json({
      success: false,
      error: 'Profil utilisateur introuvable',
      code: 'PROFILE_MISSING',
    });
  }

  if (req.profile.role !== USER_ROLES.AIDANT) {
    return res.status(403).json({
      success: false,
      error: 'Accès réservé aux aidants',
      required: ['aidant'],
      current: req.profile.role,
      code: 'ROLE_NOT_ALLOWED',
    });
  }

  // ✅ Vérifier que l'aidant est approuvé
  const { data: aidant, error } = await supabase
    .from('aidants')
    .select('is_verified, status, available')
    .eq('user_id', req.user.id)
    .single();

  if (error || !aidant) {
    return res.status(404).json({
      success: false,
      error: 'Profil aidant introuvable',
      code: 'AIDANT_PROFILE_NOT_FOUND',
    });
  }

  if (!aidant.is_verified || aidant.status !== 'approved') {
    return res.status(403).json({
      success: false,
      error: 'Votre compte aidant n\'est pas approuvé',
      code: 'AIDANT_NOT_APPROVED',
      data: {
        is_verified: aidant.is_verified,
        status: aidant.status,
      },
    });
  }

  req.aidantProfile = aidant;

  next();
};

// ============================================================
// MIDDLEWARE : VÉRIFICATION MULTI-RÔLES
// ============================================================

/**
 * Vérifie si l'utilisateur a au moins un des rôles spécifiés
 * 
 * Utilisation :
 * router.post('/protected', hasAnyRole(['admin', 'coordinator', 'family']), (req, res) => { ... })
 */
const hasAnyRole = (roles) => {
  return (req, res, next) => {
    if (!req.profile) {
      return res.status(403).json({
        success: false,
        error: 'Profil utilisateur introuvable',
        code: 'PROFILE_MISSING',
      });
    }

    if (!roles.includes(req.profile.role)) {
      return res.status(403).json({
        success: false,
        error: 'Accès non autorisé',
        required: roles,
        current: req.profile.role,
        code: 'ROLE_NOT_ALLOWED',
      });
    }

    next();
  };
};

// ============================================================
// MIDDLEWARE : VÉRIFICATION PROPRIÉTAIRE OU ADMIN
// ============================================================

/**
 * Vérifie si l'utilisateur est le propriétaire de la ressource ou admin
 * 
 * Utilisation :
 * router.put('/users/:id', isOwnerOrAdmin, (req, res) => { ... })
 */
const isOwnerOrAdmin = (options = {}) => {
  return async (req, res, next) => {
    try {
      const { 
        userIdField = 'id',
        userId = req.params[userIdField] || req.body[userIdField] || req.user?.id,
      } = options;

      if (!req.profile) {
        return res.status(403).json({
          success: false,
          error: 'Profil utilisateur introuvable',
          code: 'PROFILE_MISSING',
        });
      }

      // ✅ Admin a toujours accès
      if (req.profile.role === USER_ROLES.ADMIN || req.profile.role === USER_ROLES.COORDINATOR) {
        return next();
      }

      // ✅ Vérifier que l'utilisateur est le propriétaire
      if (req.user.id !== userId) {
        return res.status(403).json({
          success: false,
          error: 'Vous n\'êtes pas autorisé à accéder à cette ressource',
          code: 'ACCESS_DENIED',
        });
      }

      next();
    } catch (error) {
      console.error('❌ isOwnerOrAdmin error:', error);
      next(error);
    }
  };
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Fonction principale
  roleMiddleware,
  
  // Fonctions dédiées
  isAdminOrCoordinator,
  isAdminOnly,
  isFamily,
  isAidant,
  isApprovedAidant,
  hasAnyRole,
  isOwnerOrAdmin,
};
