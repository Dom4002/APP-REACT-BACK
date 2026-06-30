// 📁 backend/src/services/adminSetup.service.js

const { supabase } = require('./supabase.service');
const { sendEmail, templates } = require('./email.service');

/**
 * Vérifie si le PIN est valide
 */
const verifyPin = async (pin) => {
  try {
    const { data, error } = await supabase
      .from('admin_pin')
      .select('pin_code, is_active')
      .eq('is_active', true)
      .single();

    if (error) throw error;
    if (!data) return false;

    return data.pin_code === pin && data.is_active === true;
  } catch (error) {
    console.error('❌ Verify PIN error:', error);
    return false;
  }
};

/**
 * Génère un code OTP aléatoire à 6 chiffres
 */
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Envoie un OTP par email
 */
const sendOTP = async (email, ip, userAgent) => {
  try {
    // Générer l'OTP
    const otp = generateOTP();
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 10);

    // Supprimer les anciens OTP pour cet email
    await supabase
      .from('admin_setup')
      .delete()
      .eq('email', email)
      .eq('is_used', false);

    // Enregistrer l'OTP en base
    const { data, error } = await supabase
      .from('admin_setup')
      .insert({
        email,
        otp_code: otp,
        otp_expires_at: expiresAt.toISOString(),
        ip_address: ip,
        user_agent: userAgent,
      })
      .select()
      .single();

    if (error) throw error;

    // Envoyer l'email
    const template = templates.otp(otp, 10);
    
    await sendEmail({
      to: email,
      subject: template.subject,
      htmlContent: template.htmlContent,
    });

    console.log('📧 OTP envoyé à:', email);
    console.log('📧 Code:', otp);

    return { success: true, otp, expiresAt };
  } catch (error) {
    console.error('❌ Send OTP error:', error);
    throw error;
  }
};

/**
 * Vérifie l'OTP (sans le marquer comme utilisé)
 * Utilisé pour la validation en temps réel
 */
const verifyOTP = async (email, otp) => {
  try {
    // ✅ S'assurer que l'OTP est une chaîne
    const otpString = String(otp).trim();

    console.log('🔍 verifyOTP - email:', email);
    console.log('🔍 verifyOTP - otp:', otpString);

    const { data, error } = await supabase
      .from('admin_setup')
      .select('*')
      .eq('email', email)
      .eq('otp_code', otpString)
      .eq('is_used', false)
      .gte('otp_expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        console.log('⚠️ Aucun OTP trouvé pour:', email, 'avec le code:', otpString);
        return { success: false, error: 'Code invalide ou expiré' };
      }
      throw error;
    }

    console.log('✅ OTP trouvé:', data.id);

    // ✅ NE PAS MARQUER COMME UTILISÉ ICI
    return { success: true, data };
  } catch (error) {
    console.error('❌ Verify OTP error:', error);
    return { success: false, error: 'Erreur lors de la vérification' };
  }
};

/**
 * Consomme un OTP (vérifie ET marque comme utilisé)
 * Utilisé pour la création du compte
 */
const consumeOTP = async (email, otp) => {
  try {
    // ✅ S'assurer que l'OTP est une chaîne
    const otpString = String(otp).trim();

    console.log('🔍 consumeOTP - email:', email);
    console.log('🔍 consumeOTP - otp:', otpString);

    // D'abord, vérifier que l'OTP existe et est valide
    const { data, error } = await supabase
      .from('admin_setup')
      .select('*')
      .eq('email', email)
      .eq('otp_code', otpString)
      .eq('is_used', false)
      .gte('otp_expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        console.log('⚠️ Aucun OTP à consommer pour:', email, 'avec le code:', otpString);
        return { success: false, error: 'Code invalide ou expiré' };
      }
      throw error;
    }

    console.log('✅ OTP consommé:', data.id);

    // ✅ Marquer comme utilisé
    await supabase
      .from('admin_setup')
      .update({ is_used: true })
      .eq('id', data.id);

    return { success: true, data };
  } catch (error) {
    console.error('❌ Consume OTP error:', error);
    return { success: false, error: 'Erreur lors de la consommation du code' };
  }
};

/**
 * Crée un compte admin/coordinateur
 */
const createAdminAccount = async (userData) => {
  try {
    const { full_name, email, password, role, phone, otp } = userData;

    console.log('🔍 createAdminAccount - email:', email);
    console.log('🔍 createAdminAccount - otp:', otp);

    // ✅ Consommer l'OTP (vérifier ET marquer comme utilisé)
    const otpResult = await consumeOTP(email, otp);
    if (!otpResult.success) {
      throw new Error(otpResult.error || 'OTP invalide ou expiré');
    }

    console.log('✅ OTP consommé avec succès');

    // 1. Créer l'utilisateur dans Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name,
        phone: phone || '',
        role: role || 'admin',
        is_admin_setup: true,
      },
    });

    if (authError) {
      console.error('❌ Auth error:', authError);
      throw authError;
    }

    console.log('✅ Utilisateur créé:', authData.user.id);

    // 2. Créer le profil
    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        id: authData.user.id,
        full_name,
        email,
        phone: phone || null,
        role: role || 'admin',
        is_active: true,
        email_verified: true,
        phone_verified: true,
      });

    if (profileError) {
      console.error('❌ Profile error:', profileError);
      throw profileError;
    }

    console.log('✅ Profil créé');

    // 3. Notification
    await supabase.from('notifications').insert({
      user_id: authData.user.id,
      title: '👑 Compte administrateur créé',
      body: `Bienvenue ${full_name} ! Vous avez accès à l'administration de Santé Plus Services.`,
      type: 'system',
      data: { role },
    });

    console.log('✅ Notification envoyée');

    return { success: true, user: authData.user };
  } catch (error) {
    console.error('❌ Create admin account error:', error);
    throw error;
  }
};

module.exports = {
  verifyPin,
  sendOTP,
  verifyOTP,
  consumeOTP,
  createAdminAccount,
};