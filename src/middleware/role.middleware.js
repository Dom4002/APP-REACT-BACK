// 📁 backend/src/middleware/role.middleware.js

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

module.exports = roleMiddleware;
