// 📁 backend/src/middleware/auth.middleware.js

const { supabase } = require('../services/supabase.service');

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ 
        success: false,
        error: 'Token manquant' 
      });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ 
        success: false,
        error: 'Token invalide' 
      });
    }

    // 1. Vérifier le token
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ 
        success: false,
        error: 'Token invalide ou expiré' 
      });
    }

    // 2. ✅ RÉCUPÉRER LE PROFIL - OBLIGATOIRE
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    // 3. ✅ SI PAS DE PROFIL → BLOQUER
    if (profileError || !profile) {
      console.error('❌ Profil non trouvé pour l\'utilisateur:', user.id);
      
      // ✅ Option 1: Déconnecter l'utilisateur
      await supabase.auth.signOut();
      
      return res.status(403).json({
        success: false,
        error: 'Compte incomplet. Veuillez contacter le support.',
        code: 'PROFILE_NOT_FOUND',
      });
    }

    // 4. ✅ VÉRIFIER QUE LE COMPTE EST ACTIF
    if (!profile.is_active) {
      await supabase.auth.signOut();
      
      return res.status(403).json({
        success: false,
        error: 'Votre compte est désactivé. Veuillez contacter le support.',
        code: 'ACCOUNT_INACTIVE',
      });
    }

    // 5. ✅ VÉRIFIER QUE LE COMPTE EST VALIDÉ (pour les aidants)
    if (profile.role === 'aidant' && !profile.is_active) {
      await supabase.auth.signOut();
      
      return res.status(403).json({
        success: false,
        error: 'Votre compte aidant est en attente de validation.',
        code: 'AIDANT_NOT_APPROVED',
      });
    }

    // 6. ✅ TOUT EST BON
    req.user = user;
    req.profile = profile;
    next();

  } catch (error) {
    console.error('❌ Auth middleware error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Erreur d\'authentification' 
    });
  }
};

module.exports = authMiddleware;
