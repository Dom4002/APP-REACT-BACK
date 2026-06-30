// 📁 backend/src/routes/adminSetup.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const {
  verifyPin,
  sendOTP,
  verifyOTP,
  createAdminAccount,
} = require('../services/adminSetup.service');

// =============================================
// ROUTE: POST /api/admin-setup/verify-pin
// Vérifie le PIN
// =============================================
router.post('/verify-pin', async (req, res) => {
  try {
    const { pin } = req.body;

    if (!pin) {
      return res.status(400).json({
        success: false,
        error: 'PIN requis',
      });
    }

    const isValid = await verifyPin(pin);

    if (!isValid) {
      return res.status(401).json({
        success: false,
        error: 'PIN incorrect',
      });
    }

    res.json({
      success: true,
      message: 'PIN valide',
    });
  } catch (error) {
    console.error('❌ Verify PIN error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la vérification',
    });
  }
});

// =============================================
// ROUTE: POST /api/admin-setup/send-otp
// Envoie un OTP par email
// =============================================
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email requis',
      });
    }

    // Vérifier si l'email est déjà utilisé
    const { data: existingUser } = await supabase
      .from('profiles')
      .select('email')
      .eq('email', email)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Cet email est déjà utilisé',
      });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await sendOTP(email, ip, userAgent);

    res.json({
      success: true,
      message: 'Code OTP envoyé par email',
      expires_in: 10,
    });
  } catch (error) {
    console.error('❌ Send OTP error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de l\'envoi du code',
    });
  }
});

// =============================================
// ROUTE: POST /api/admin-setup/verify-otp
// Vérifie l'OTP
// =============================================
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    console.log('🔍 verify-otp - email:', email);
    console.log('🔍 verify-otp - otp:', otp);
    console.log('🔍 verify-otp - type:', typeof otp);

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        error: 'Email et OTP requis',
      });
    }

    // ✅ S'assurer que l'OTP est une chaîne
    const otpString = String(otp).trim();

    const result = await verifyOTP(email, otpString);

    if (!result.success) {
      return res.status(401).json({
        success: false,
        error: result.error || 'Code invalide',
      });
    }

    res.json({
      success: true,
      message: 'OTP validé',
    });
  } catch (error) {
    console.error('❌ Verify OTP error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la vérification',
    });
  }
});

// =============================================
// ROUTE: POST /api/admin-setup/create
// Crée le compte admin/coordinateur
// =============================================
router.post('/create', async (req, res) => {
  try {
    const { full_name, email, password, role, phone, otp } = req.body;

    console.log('🔍 create - email:', email);
    console.log('🔍 create - otp:', otp);
    console.log('🔍 create - type:', typeof otp);

    // Vérifications
    if (!full_name || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        error: 'Tous les champs sont requis',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Le mot de passe doit contenir au moins 6 caractères',
      });
    }

    if (!otp) {
      return res.status(400).json({
        success: false,
        error: 'OTP requis',
      });
    }

    // ✅ S'assurer que l'OTP est une chaîne
    const otpString = String(otp).trim();

    // Créer le compte
    const result = await createAdminAccount({
      full_name,
      email,
      password,
      role,
      phone,
      otp: otpString,
    });

    res.json({
      success: true,
      message: 'Compte créé avec succès',
      user: result.user,
    });
  } catch (error) {
    console.error('❌ Create admin error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la création du compte',
    });
  }
});

module.exports = router;