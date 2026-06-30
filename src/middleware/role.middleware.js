const roleMiddleware = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.profile) {
      return res.status(401).json({ error: 'Profil non trouvé' });
    }

    if (!allowedRoles.includes(req.profile.role)) {
      return res.status(403).json({
        error: 'Accès non autorisé pour ce rôle',
        required: allowedRoles,
        current: req.profile.role,
      });
    }

    next();
  };
};

module.exports = roleMiddleware;