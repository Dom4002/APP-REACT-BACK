// 📁 backend/src/routes/auth.routes.js
 
const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const { sendEmail, templates } = require('../services/email.service');
const authMiddleware = require('../middleware/auth.middleware');
const roleMiddleware = require('../middleware/role.middleware');

// ============================================================
// CONSTANTES
// ============================================================
const MAX_EMAIL_RETRY = 3;
const EMAIL_RETRY_DELAY = 2000;

// ============================================================
// 🔧 FONCTION HELPER - ENVOI EMAIL AVEC RETRY
// ============================================================
async function sendEmailWithRetry(emailData, retryCount = 0) {
  const maxRetries = MAX_EMAIL_RETRY;
  const delay = EMAIL_RETRY_DELAY;

  try {
    console.log(`📧 Tentative ${retryCount + 1}/${maxRetries} - Envoi email à:`, emailData.to);
    const result = await sendEmail(emailData);
    console.log('✅ Email envoyé avec succès');
    return { success: true, result };
  } catch (error) {
    console.error(`❌ Échec envoi email (tentative ${retryCount + 1}):`, error.message);

    if (retryCount < maxRetries - 1) {
      console.log(`⏳ Nouvelle tentative dans ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendEmailWithRetry(emailData, retryCount + 1);
    }

    console.error(`❌ Échec définitif après ${maxRetries} tentatives`);
    return { success: false, error: error.message };
  }
}

// ============================================================
// 🔧 FONCTION HELPER - ENVOI EMAIL AVEC LOG
// ============================================================
async function sendEmailWithLog(emailData, context) {
  const startTime = Date.now();
  console.log(`📧 [${context}] Envoi email à:`, emailData.to);
  console.log(`📧 [${context}] Sujet:`, emailData.subject);

  const result = await sendEmailWithRetry(emailData);

  const duration = Date.now() - startTime;
  if (result.success) {
    console.log(`✅ [${context}] Email envoyé en ${duration}ms`);
  } else {
    console.error(`❌ [${context}] Échec après ${duration}ms:`, result.error);
  }

  return result;
}

// =============================================
// ROUTE DE TEST - VÉRIFIER QUE L'ADMIN EST CONNECTÉ
// =============================================
router.get('/admin/test', authMiddleware, async (req, res) => {
  console.log('🔴 ===== ROUTE TEST ADMIN APPELEE =====');
  console.log('🔴 User:', req.user?.id);
  console.log('🔴 Profile:', req.profile);
  
  res.json({
    success: true,
    message: 'Route admin fonctionne',
    user_id: req.user?.id,
    role: req.profile?.role,
  });
});

// =============================================
// ROUTE DE TEST - APPROUVER UN AIDANT (SANS AUTH POUR TEST)
// =============================================
router.post('/admin/test-approve', async (req, res) => {
  console.log('🔴 ===== ROUTE TEST APPROVE SANS AUTH =====');
  console.log('🔴 Body:', req.body);
  
  try {
    const { aidantId } = req.body;
    
    if (!aidantId) {
      return res.status(400).json({ success: false, error: 'aidantId requis' });
    }
    
    const { data: aidant, error } = await supabase
      .from('aidants')
      .select('*, user:profiles(*)')
      .eq('id', aidantId)
      .single();
      
    if (error || !aidant) {
      return res.status(404).json({ success: false, error: 'Aidant non trouvé' });
    }
    
    console.log('👤 Aidant trouvé:', aidant.user?.email);
    
    await supabase
      .from('profiles')
      .update({ is_active: true, role: 'aidant' })
      .eq('id', aidant.user_id);
      
    await supabase
      .from('aidants')
      .update({ is_verified: true, available: true, status: 'approved' })
      .eq('id', aidantId);
      
    await sendEmail({
      to: aidant.user?.email,
      ...templates.aidantApproved(aidant.user?.full_name || 'Aidant')
    });
    
    res.json({
      success: true,
      message: 'Aidant approuvé avec succès (test sans auth)',
      email_sent: true,
    });
    
  } catch (error) {
    console.error('❌ Erreur test approve:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// ✅ INSCRIPTION - BLOQUÉ POUR LES AIDANTS
// =============================================
router.post('/register', async (req, res) => {
  console.log('📝 ===== REGISTER REQUEST =====');
  console.log('📝 Body:', JSON.stringify(req.body, null, 2));
  
  try {
    const { 
      email, 
      password, 
      full_name, 
      phone, 
      role, 
      hasPatient, 
      patientData, 
      offreId,
      aidantData
    } = req.body;

    // =============================================
    // ❌ BLOQUER L'INSCRIPTION DES AIDANTS
    // =============================================
    if (role === 'aidant') {
      console.warn('⚠️ Tentative d\'inscription aidant bloquée:', email);
      return res.status(403).json({
        success: false,
        error: 'Les inscriptions d\'aidants ne sont pas autorisées sur cette plateforme. Veuillez contacter l\'administration.',
        code: 'AIDANT_REGISTRATION_BLOCKED'
      });
    }

    // =============================================
    // VALIDATION DES CHAMPS COMMUNS
    // =============================================
    console.log('🔍 Vérification des champs...');
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email est obligatoire' });
    }
    if (!password) {
      return res.status(400).json({ success: false, error: 'Mot de passe est obligatoire' });
    }
    if (!full_name) {
      return res.status(400).json({ success: false, error: 'Nom complet est obligatoire' });
    }
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Téléphone est obligatoire' });
    }

    // Validation email
    console.log('🔍 Validation email...');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Email invalide' });
    }

    // Validation mot de passe
    console.log('🔍 Validation mot de passe...');
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    // Validation téléphone
    console.log('🔍 Validation téléphone...');
    const phoneRegex = /^[0-9+\s\-()]{8,15}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ success: false, error: 'Numéro de téléphone invalide' });
    }

    // ✅ Validation patient (uniquement pour famille)
    if (role === 'family' && hasPatient === true) {
      console.log('🔍 Validation patient...');
      if (!patientData) {
        return res.status(400).json({ success: false, error: 'Données du patient manquantes' });
      }
      if (!patientData.first_name) {
        return res.status(400).json({ success: false, error: 'Prénom du patient requis' });
      }
      if (!patientData.last_name) {
        return res.status(400).json({ success: false, error: 'Nom du patient requis' });
      }
      if (!patientData.address) {
        return res.status(400).json({ success: false, error: 'Adresse du patient requise' });
      }
      if (!patientData.category) {
        return res.status(400).json({ success: false, error: 'Catégorie du patient requise' });
      }
    }

    // Vérifier si l'email existe déjà
    console.log('🔍 Vérification email existant...');
    const { data: existingUser, error: checkError } = await supabase
      .from('profiles')
      .select('email')
      .eq('email', email)
      .maybeSingle();

    if (existingUser) {
      console.log('❌ Email déjà utilisé:', email);
      return res.status(400).json({ success: false, error: 'Cet email est déjà utilisé' });
    }

    // =============================================
    // CRÉATION DU COMPTE
    // =============================================
    
    // 1. Créer l'utilisateur
    console.log('🔍 Création de l\'utilisateur...');
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { 
        full_name,
        phone: phone || '',
        role: role || 'family',
      },
    });

    if (authError) {
      console.error('❌ Erreur création auth:', authError);
      return res.status(400).json({
        success: false,
        error: authError.message || 'Erreur lors de la création du compte',
      });
    }

    console.log('✅ Utilisateur créé:', authData.user.id);

    // 2. Créer le profil
    console.log('🔍 Création du profil...');
    
    const isActive = true; // Toujours actif pour les familles
    
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id: authData.user.id,
        full_name,
        email,
        phone: phone || null,
        role: role || 'family',
        patient_category: (role === 'family' && hasPatient && patientData) ? patientData.category : null,
        is_active: isActive,
      }, { onConflict: 'id' });

    if (profileError) {
      console.error('❌ Erreur création profil:', profileError);
      await supabase.auth.admin.deleteUser(authData.user.id);
      return res.status(400).json({
        success: false,
        error: 'Erreur lors de la création du profil',
      });
    }

    console.log('✅ Profil créé (is_active:', isActive, ')');

    // =============================================
    // 3. Si Famille - Créer le patient
    // =============================================
    let patient = null;
    if (role === 'family' && hasPatient && patientData) {
      console.log('🔍 Création du patient...');
      const { data: patientResult, error: patientError } = await supabase
        .from('patients')
        .insert({
          first_name: patientData.first_name,
          last_name: patientData.last_name,
          age: patientData.age ? parseInt(patientData.age) : null,
          gender: patientData.gender || null,
          address: patientData.address,
          phone: patientData.phone || null,
          emergency_contact: patientData.emergency_contact || null,
          category: patientData.category || 'senior',
          notes: patientData.notes || null,
          allergies: patientData.allergies || null,
          treatments: patientData.treatments || null,
          created_by: authData.user.id,
          status: 'active',
        })
        .select()
        .single();

      if (patientError) {
        console.error('❌ Erreur création patient:', patientError);
      } else {
        patient = patientResult;
        console.log('✅ Patient créé:', patient.id);
        
        await supabase
          .from('patient_family_links')
          .insert({
            patient_id: patient.id,
            family_id: authData.user.id,
            is_primary: true,
          });
        console.log('✅ Lien patient-famille créé');
      }
    }

    // =============================================
    // 4. Créer l'inscription
    // =============================================
    console.log('🔍 Création de l\'inscription...');
    
    await supabase
      .from('inscriptions')
      .insert({
        user_id: authData.user.id,
        patient_data: (role === 'family' && patientData) ? patientData : null,
        offre_id: (role === 'family' && offreId) ? offreId : null,
        status: 'en_attente',
        source: 'web',
        comments: null,
      });
    console.log('✅ Inscription créée avec statut: en_attente');

    // =============================================
    // 5. ENVOI EMAIL AVEC RETRY
    // =============================================
    let emailSent = false;
    let emailError = null;

    try {
      console.log('🔍 Envoi email...');
      
      const emailData = { 
        to: email, 
        ...templates.welcome(full_name) 
      };

      const result = await sendEmailWithLog(emailData, 'REGISTER');
      emailSent = result.success;
      emailError = result.success ? null : result.error;

      if (emailSent) {
        console.log('✅ Email envoyé avec succès');
      } else {
        console.warn('⚠️ Email non envoyé mais inscription réussie');
      }

    } catch (emailError) {
      console.error('❌ Erreur email:', emailError);
      emailSent = false;
      emailError = emailError.message;
    }

    // =============================================
    // RÉPONSE SUCCÈS
    // =============================================
    console.log('✅ ===== INSCRIPTION RÉUSSIE =====');
    
    let message = '';
    if (hasPatient) {
      message = 'Inscription réussie. Votre demande est en attente de validation.';
    } else {
      message = 'Compte créé avec succès. Votre demande est en attente de validation.';
    }

    if (!emailSent) {
      message += ' (⚠️ L\'email de confirmation n\'a pas pu être envoyé, mais votre compte est bien créé)';
    }

    res.status(201).json({
      success: true,
      message,
      email_sent: emailSent,
      email_error: emailError,
      user: {
        id: authData.user.id,
        email: authData.user.email,
        full_name,
        role: role || 'family',
        is_active: isActive,
      },
      patient: patient || null,
      isAidant: false,
      requiresValidation: false,
    });

  } catch (error) {
    console.error('❌ ===== ERREUR INSCRIPTION =====');
    console.error(error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Erreur lors de l\'inscription',
    });
  }
});

// =============================================
// CONNEXION - AVEC VÉRIFICATION AIDANT
// =============================================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log('🔍 Login attempt:', email);

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email et mot de passe sont obligatoires',
      });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ 
      email, 
      password 
    });

    if (error) {
      console.error('❌ Login error:', error);
      return res.status(401).json({
        success: false,
        error: 'Email ou mot de passe incorrect',
      });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    // ✅ Vérifier si l'aidant est approuvé
    if (profile?.role === 'aidant' && !profile?.is_active) {
      console.warn('⚠️ Tentative de connexion aidant non approuvé:', email);
      await supabase.auth.signOut();
      return res.status(403).json({
        success: false,
        error: 'Votre compte aidant est en attente de validation par l\'administration.',
        code: 'AIDANT_NOT_APPROVED'
      });
    }

    console.log('✅ Login successful:', data.user.id);

    res.json({ 
      success: true, 
      user: data.user, 
      profile, 
      session: data.session 
    });

  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erreur lors de la connexion' 
    });
  }
});

// =============================================
// ADMIN - TRAITER UNE INSCRIPTION (AVEC EMAIL ET RETRY)
// =============================================
router.post('/admin/process-registration', authMiddleware, roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  const startTime = Date.now();
  let emailSent = false;
  let emailError = null;

  try {
    const { registrationId, status, comments } = req.body;
    const userId = req.user.id;

    console.log(`🔍 [PROCESS] Traitement inscription ${registrationId} → ${status}`);

    const { data: registration, error: regError } = await supabase
      .from('inscriptions')
      .select('*, user:profiles(*)')
      .eq('id', registrationId)
      .single();

    if (regError) throw regError;

    if (!registration) {
      return res.status(404).json({ success: false, error: 'Inscription non trouvée' });
    }

    console.log(`👤 Inscription pour: ${registration.user?.full_name} (${registration.user?.email})`);

    const { error: updateError } = await supabase
      .from('inscriptions')
      .update({
        status,
        comments: comments || null,
        processed_by: userId,
        processed_at: new Date().toISOString(),
      })
      .eq('id', registrationId);

    if (updateError) throw updateError;

    if (status === 'validee') {
      console.log('🔍 Activation du compte...');
      await supabase
        .from('profiles')
        .update({ is_active: true })
        .eq('id', registration.user_id);

      // ✅ Vérifier si c'est un aidant (cas rare, car inscription aidant bloquée)
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', registration.user_id)
        .single();

      if (aidant) {
        await supabase
          .from('aidants')
          .update({ 
            status: 'approved',
            is_verified: true,
            available: true 
          })
          .eq('id', aidant.id);
        console.log('✅ Aidant approuvé:', aidant.id);
      }
    }

    const user = registration.user;
    if (user?.email) {
      console.log(`📧 Envoi email de ${status === 'validee' ? 'validation' : 'refus'}...`);

      let emailData;
      if (status === 'validee') {
        emailData = {
          to: user.email,
          ...templates.registrationValidated({ name: user.full_name }),
        };
      } else {
        emailData = {
          to: user.email,
          subject: '❌ Candidature Santé Plus - Information',
          htmlContent: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f0e8; border-radius: 16px;">
              <div style="background: #1a4a3a; padding: 30px; border-radius: 12px; text-align: center;">
                <h1 style="color: #c9a84c; margin: 0;">Santé Plus</h1>
                <p style="color: white; margin: 5px 0;">Services</p>
              </div>
              <div style="background: white; padding: 30px; border-radius: 12px; margin-top: 20px;">
                <h2 style="color: #1a4a3a;">Bonjour ${user.full_name},</h2>
                <p>Nous vous remercions pour l'intérêt que vous avez porté à Santé Plus Services.</p>
                <p>Après examen de votre candidature, nous ne pouvons pas donner suite à votre demande pour le moment.</p>
                ${comments ? `<p style="color: #666; font-size: 14px;">Motif : ${comments}</p>` : ''}
                <p style="color: #666; font-size: 14px;">Nous vous souhaitons une bonne continuation.</p>
                <p style="color: #666; font-size: 14px;">L'équipe Santé Plus Services</p>
              </div>
            </div>
          `,
        };
      }

      const emailResult = await sendEmailWithLog(emailData, `PROCESS_${status.toUpperCase()}`);
      emailSent = emailResult.success;
      emailError = emailResult.success ? null : emailResult.error;
    }

    await supabase.from('notifications').insert({
      user_id: registration.user_id,
      title: status === 'validee' ? '✅ Inscription validée' : '❌ Inscription refusée',
      body: status === 'validee'
        ? `Votre inscription a été validée. Bienvenue chez Santé Plus Services !`
        : `Votre inscription a été refusée. ${comments || 'Contactez-nous pour plus d\'informations.'}`,
      type: 'system',
      data: { registration_id: registrationId, status },
    });

    const duration = Date.now() - startTime;
    console.log(`✅ [PROCESS] Inscription traitée en ${duration}ms - Email: ${emailSent ? '✅' : '❌'}`);

    res.json({
      success: true,
      message: emailSent 
        ? 'Inscription traitée avec succès. Un email a été envoyé.'
        : 'Inscription traitée avec succès. (⚠️ L\'email n\'a pas pu être envoyé)',
      email_sent: emailSent,
      email_error: emailError,
      registration_id: registrationId,
      status,
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ [PROCESS] Erreur après ${duration}ms:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors du traitement',
      email_sent: emailSent,
      email_error: emailError || error.message,
    });
  }
});

// =============================================
// MOT DE PASSE OUBLIÉ
// =============================================
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email est obligatoire',
      });
    }

    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'Aucun compte trouvé avec cet email' 
      });
    }

    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.CLIENT_URL}/reset-password`,
    });

    if (error) {
      console.error('❌ Reset password error:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Erreur lors de l\'envoi',
      });
    }

    const resetLink = `${process.env.CLIENT_URL}/reset-password?token=${data?.access_token || ''}`;
    
    try {
      await sendEmailWithLog({ 
        to: email, 
        ...templates.forgotPassword(user.full_name, resetLink) 
      }, 'FORGOT_PASSWORD');
    } catch (emailError) {
      console.error('❌ Email sending error:', emailError);
    }

    res.json({ 
      success: true, 
      message: 'Un email de réinitialisation a été envoyé' 
    });

  } catch (error) {
    console.error('❌ Forgot password error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erreur lors du traitement' 
    });
  }
});

// =============================================
// RÉINITIALISATION MOT DE PASSE
// =============================================
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        error: 'Token et mot de passe sont obligatoires',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Le mot de passe doit contenir au moins 6 caractères',
      });
    }

    const { error } = await supabase.auth.updateUser(password);
    
    if (error) {
      console.error('❌ Reset password error:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Erreur lors de la réinitialisation',
      });
    }

    res.json({ 
      success: true, 
      message: 'Mot de passe réinitialisé avec succès' 
    });

  } catch (error) {
    console.error('❌ Reset password error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erreur lors de la réinitialisation' 
    });
  }
});

// =============================================
// UTILISATEUR ACTUEL
// =============================================
router.get('/me', authMiddleware, async (req, res) => {
  try {
    res.json({ 
      success: true,
      user: req.user, 
      profile: req.profile 
    });
  } catch (error) {
    console.error('❌ Get me error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erreur lors du chargement du profil' 
    });
  }
});

// =============================================
// CHANGER DE RÔLE - BLOQUÉ POUR LES AIDANTS
// =============================================
router.post('/switch-role', authMiddleware, async (req, res) => {
  try {
    const { role } = req.body;
    const { id } = req.user;

    if (!role) {
      return res.status(400).json({
        success: false,
        error: 'Rôle est obligatoire',
      });
    }

    // ❌ Les aidants ne peuvent pas changer de rôle
    if (req.profile.role === 'aidant') {
      return res.status(403).json({
        success: false,
        error: 'Les aidants ne peuvent pas changer de rôle',
      });
    }

    const allowedRoles = ['family', 'coordinator'];
    if (role === 'admin' && req.profile.role !== 'admin') {
      return res.status(403).json({ 
        success: false,
        error: 'Non autorisé à passer en admin' 
      });
    }

    if (!allowedRoles.includes(role) && role !== 'admin') {
      return res.status(400).json({ 
        success: false,
        error: 'Rôle invalide' 
      });
    }

    const { error } = await supabase
      .from('profiles')
      .update({ role })
      .eq('id', id);

    if (error) {
      console.error('❌ Switch role error:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Erreur lors du changement de rôle',
      });
    }

    res.json({ 
      success: true, 
      message: 'Rôle mis à jour', 
      role 
    });

  } catch (error) {
    console.error('❌ Switch role error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erreur lors du changement de rôle' 
    });
  }
});

// =============================================
// AJOUTER UN PATIENT - SEULS LES FAMILLES PEUVENT
// =============================================
router.post('/add-patient', authMiddleware, async (req, res) => {
  try {
    const { patientData, offreId } = req.body;
    const userId = req.user.id;

    // ❌ Les aidants ne peuvent pas ajouter de patients
    if (req.profile.role === 'aidant') {
      return res.status(403).json({
        success: false,
        error: 'Les aidants ne peuvent pas ajouter de patients',
      });
    }

    if (!patientData) {
      return res.status(400).json({
        success: false,
        error: 'Données du patient requises',
      });
    }

    if (!patientData.first_name || !patientData.last_name || !patientData.address) {
      return res.status(400).json({
        success: false,
        error: 'Prénom, nom et adresse sont obligatoires',
      });
    }

    const { data: patient, error: patientError } = await supabase
      .from('patients')
      .insert({
        first_name: patientData.first_name,
        last_name: patientData.last_name,
        age: patientData.age ? parseInt(patientData.age) : null,
        gender: patientData.gender || null,
        address: patientData.address,
        phone: patientData.phone || null,
        emergency_contact: patientData.emergency_contact || null,
        category: patientData.category || 'senior',
        notes: patientData.notes || null,
        allergies: patientData.allergies || null,
        treatments: patientData.treatments || null,
        created_by: userId,
      })
      .select()
      .single();

    if (patientError) {
      console.error('❌ Patient creation error:', patientError);
      return res.status(400).json({
        success: false,
        error: patientError.message || 'Erreur lors de la création du patient',
      });
    }

    await supabase
      .from('patient_family_links')
      .insert({
        patient_id: patient.id,
        family_id: userId,
        is_primary: true,
      });

    await supabase
      .from('profiles')
      .update({ 
        patient_category: patientData.category || 'senior' 
      })
      .eq('id', userId);

    res.json({ 
      success: true, 
      message: 'Patient ajouté avec succès', 
      patient 
    });

  } catch (error) {
    console.error('❌ Add patient error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Erreur lors de l\'ajout du patient' 
    });
  }
});

// =============================================
// SUPPRIMER LE COMPTE (avec droits admin)
// =============================================
router.post('/delete-account', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    const { user } = req;

    // ✅ Vérifier que l'utilisateur n'a pas de missions en cours
    if (req.profile.role === 'aidant') {
      const { data: activeVisits } = await supabase
        .from('visites')
        .select('id')
        .eq('aidant_id', userId)
        .in('status', ['planifiee', 'en_attente', 'acceptee', 'en_cours'])
        .limit(1);

      if (activeVisits && activeVisits.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Vous ne pouvez pas supprimer votre compte car vous avez des missions en cours.',
        });
      }
    }

    if (userId !== user.id && req.profile.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Non autorisé à supprimer ce compte',
      });
    }

    // ✅ 1. Récupérer TOUS les patients liés
    const { data: patientLinks, error: linkError } = await supabase
      .from('patient_family_links')
      .select('patient_id')
      .eq('family_id', userId);

    if (linkError) {
      console.error('❌ Erreur récupération liens:', linkError);
    }

    const patientIds = patientLinks?.map(l => l.patient_id) || [];

    // ✅ 2. Supprimer les patients
    if (patientIds.length > 0) {
      const { error: deleteError } = await supabase
        .from('patients')
        .delete()
        .in('id', patientIds);

      if (deleteError) {
        console.error('❌ Erreur suppression patients:', deleteError);
      }
    }

    // ✅ 3. Supprimer les liens
    await supabase
      .from('patient_family_links')
      .delete()
      .eq('family_id', userId);

    // ✅ 4. Supprimer les inscriptions
    await supabase
      .from('inscriptions')
      .delete()
      .eq('user_id', userId);

    // ✅ 5. Supprimer les notifications
    await supabase
      .from('notifications')
      .delete()
      .eq('user_id', userId);

    // ✅ 6. Supprimer les tokens push
    await supabase
      .from('push_tokens')
      .delete()
      .eq('user_id', userId);

    // ✅ 7. Supprimer le profil
    await supabase
      .from('profiles')
      .delete()
      .eq('id', userId);

    // ✅ 8. Supprimer l'utilisateur Auth
    const { error } = await supabase.auth.admin.deleteUser(userId);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Compte et tous ses proches supprimés avec succès',
      patients_deleted: patientIds.length,
    });

  } catch (error) {
    console.error('❌ Delete account error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la suppression',
    });
  }
});

// =============================================
// ADMIN - APPROUVER UN AIDANT AVEC EMAIL
// =============================================
router.post('/admin/approve-aidant', authMiddleware, roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  const startTime = Date.now();
  let emailSent = false;
  let emailError = null;

  console.log('🔴 ===== ROUTE APPROVE AIDANT APPELEE =====');
  console.log('🔴 Body:', JSON.stringify(req.body, null, 2));
  console.log('🔴 User ID:', req.user?.id);
  console.log('🔴 User Role:', req.profile?.role);

  try {
    const { aidantId, comments } = req.body;
    const { user, profile } = req;

    if (profile.role !== 'admin' && profile.role !== 'coordinator') {
      return res.status(403).json({
        success: false,
        error: 'Non autorisé à approuver des aidants',
      });
    }

    console.log(`🔍 [APPROVE] Début approbation aidant ${aidantId}`);

    // ✅ ÉTAPE 1 : Récupérer l'aidant
    console.log('🔍 [APPROVE] Récupération de l\'aidant...');
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('*')
      .eq('id', aidantId)
      .single();

    if (aidantError || !aidant) {
      console.error('❌ [APPROVE] Erreur récupération aidant:', aidantError);
      return res.status(404).json({
        success: false,
        error: 'Aidant non trouvé',
      });
    }

    // ✅ ÉTAPE 2 : Récupérer le profil utilisateur
    const { data: userProfile, error: userProfileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', aidant.user_id)
      .single();

    if (userProfileError) {
      console.error('❌ [APPROVE] Erreur récupération profil:', userProfileError);
    }

    const userEmail = userProfile?.email || null;
    const userName = userProfile?.full_name || 'Aidant';

    console.log(`👤 [APPROVE] Aidant trouvé: ${userName} (${userEmail})`);
    console.log(`👤 [APPROVE] Statut actuel: is_active=${userProfile?.is_active}, aidant_status=${aidant.status}`);

    // ✅ ÉTAPE 3 : Mettre à jour le profil
    console.log('🔍 [APPROVE] Mise à jour du profil...');
    const { error: profileUpdateError } = await supabase
      .from('profiles')
      .update({ 
        is_active: true,
        role: 'aidant',
      })
      .eq('id', aidant.user_id);

    if (profileUpdateError) {
      console.error('❌ [APPROVE] Erreur mise à jour profil:', profileUpdateError);
      return res.status(500).json({
        success: false,
        error: 'Erreur lors de la mise à jour du profil',
      });
    }
    console.log('✅ [APPROVE] Profil mis à jour');

    // ✅ ÉTAPE 4 : Mettre à jour l'aidant
    console.log('🔍 [APPROVE] Mise à jour de l\'aidant...');
    const { error: aidantUpdateError } = await supabase
      .from('aidants')
      .update({ 
        is_verified: true,
        available: true,
        status: 'approved',
        updated_at: new Date().toISOString(),
      })
      .eq('id', aidantId);

    if (aidantUpdateError) {
      console.error('❌ [APPROVE] Erreur mise à jour aidant:', aidantUpdateError);
      return res.status(500).json({
        success: false,
        error: 'Erreur lors de la mise à jour de l\'aidant',
      });
    }
    console.log('✅ [APPROVE] Aidant mis à jour');

    // ✅ ÉTAPE 5 : Mettre à jour l'inscription
    console.log('🔍 [APPROVE] Mise à jour de l\'inscription...');
    await supabase
      .from('inscriptions')
      .update({ 
        status: 'validee',
        comments: comments || 'Candidature aidant approuvée',
        processed_by: user.id,
        processed_at: new Date().toISOString(),
      })
      .eq('user_id', aidant.user_id);
    console.log('✅ [APPROVE] Inscription mise à jour');

    // ✅ ÉTAPE 6 : Envoyer la notification
    console.log('🔍 [APPROVE] Envoi notification...');
    await supabase.from('notifications').insert({
      user_id: aidant.user_id,
      title: '✅ Compte aidant validé !',
      body: `Félicitations ${userName} ! Votre compte a été validé. Vous pouvez maintenant accepter des missions et commencer à travailler.`,
      type: 'system',
      is_read: false,
    });
    console.log('✅ [APPROVE] Notification envoyée');

    // ✅ ÉTAPE 7 : Envoyer l'email
    if (userEmail) {
      console.log(`📧 [APPROVE] Envoi email à: ${userEmail}`);
      console.log(`📧 [APPROVE] Nom destinataire: ${userName}`);

      try {
        const emailData = { 
          to: userEmail, 
          ...templates.aidantApproved(userName) 
        };

        const emailResult = await sendEmailWithLog(emailData, 'APPROVE');
        emailSent = emailResult.success;
        emailError = emailResult.success ? null : emailResult.error;

        if (emailSent) {
          console.log('✅ [APPROVE] Email d\'approbation envoyé avec succès');
        } else {
          console.warn('⚠️ [APPROVE] Échec envoi email:', emailError);
        }
      } catch (emailErr) {
        console.error('❌ [APPROVE] Erreur email:', emailErr);
        emailSent = false;
        emailError = emailErr.message;
      }
    } else {
      console.warn('⚠️ [APPROVE] Email manquant pour l\'aidant');
      emailSent = false;
      emailError = 'Email destinataire manquant';
    }

    const duration = Date.now() - startTime;
    console.log(`✅ [APPROVE] Aidant approuvé en ${duration}ms - Email: ${emailSent ? '✅' : '❌'}`);

    res.json({
      success: true,
      message: emailSent 
        ? 'Aidant approuvé avec succès. Un email de confirmation a été envoyé.'
        : 'Aidant approuvé avec succès. (⚠️ L\'email n\'a pas pu être envoyé)',
      email_sent: emailSent,
      email_error: emailError,
      aidant_id: aidantId,
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ [APPROVE] Erreur après ${duration}ms:`, error);
    console.error('❌ [APPROVE] Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de l\'approbation',
      email_sent: emailSent,
      email_error: emailError || error.message,
    });
  }
});

// =============================================
// ADMIN - REFUSER UN AIDANT AVEC EMAIL
// =============================================
router.post('/admin/reject-aidant', authMiddleware, roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  const startTime = Date.now();
  let emailSent = false;
  let emailError = null;

  console.log('🔴 ===== ROUTE REJECT AIDANT APPELEE =====');
  console.log('🔴 Body:', JSON.stringify(req.body, null, 2));

  try {
    const { aidantId, comments } = req.body;
    const { user, profile } = req;

    console.log(`🔍 [REJECT] Début refus aidant ${aidantId}`);

    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('*, user:profiles(*)')
      .eq('id', aidantId)
      .single();

    if (aidantError || !aidant) {
      console.error('❌ Erreur récupération aidant:', aidantError);
      return res.status(404).json({
        success: false,
        error: 'Aidant non trouvé',
      });
    }

    console.log(`👤 Aidant trouvé: ${aidant.user?.full_name} (${aidant.user?.email})`);

    await supabase
      .from('aidants')
      .update({ 
        is_verified: false,
        status: 'rejected',
        updated_at: new Date().toISOString(),
      })
      .eq('id', aidantId);

    await supabase
      .from('inscriptions')
      .update({ 
        status: 'refusee',
        comments: comments || 'Candidature aidant refusée',
        processed_by: user.id,
        processed_at: new Date().toISOString(),
      })
      .eq('user_id', aidant.user_id);

    await supabase.from('notifications').insert({
      user_id: aidant.user_id,
      title: '❌ Candidature non retenue',
      body: `Bonjour ${aidant.user?.full_name || 'Aidant'}, nous vous remercions pour votre intérêt. Votre candidature n'a pas été retenue pour le moment.`,
      type: 'system',
      is_read: false,
    });

    console.log('📧 Envoi email de refus...');
    if (aidant.user?.email) {
      const emailResult = await sendEmailWithLog(
        { 
          to: aidant.user.email, 
          ...templates.aidantRejected(aidant.user?.full_name || 'Aidant') 
        },
        'REJECT'
      );

      emailSent = emailResult.success;
      emailError = emailResult.success ? null : emailResult.error;
    } else {
      console.warn('⚠️ [REJECT] Email manquant pour l\'aidant');
      emailSent = false;
      emailError = 'Email destinataire manquant';
    }

    const duration = Date.now() - startTime;
    console.log(`✅ [REJECT] Aidant refusé en ${duration}ms - Email: ${emailSent ? '✅' : '❌'}`);

    res.json({
      success: true,
      message: emailSent 
        ? 'Aidant refusé. Un email de notification a été envoyé.'
        : 'Aidant refusé. (⚠️ L\'email n\'a pas pu être envoyé)',
      email_sent: emailSent,
      email_error: emailError,
      aidant_id: aidantId,
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ [REJECT] Erreur après ${duration}ms:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors du refus',
      email_sent: emailSent,
      email_error: emailError || error.message,
    });
  }
});

module.exports = router;
