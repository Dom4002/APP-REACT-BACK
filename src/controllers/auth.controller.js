// 📁 backend/src/controllers/auth.controller.js

const { supabase } = require('../services/supabase.service');
const { asyncWrapper, ValidationError, ConflictError } = require('../utils/errorHandler');
const { sendEmail, templates } = require('../services/email.service');
const { createNotification } = require('../services/notification.service');

// ============================================================
// INSCRIPTION
// ============================================================
const register = asyncWrapper(async (req, res) => {
  const {
    full_name,
    email,
    phone,
    password,
    role = 'family',
    hasPatient = false,
    patientCategory = 'senior',
    patientData = null,
    aidantData = null,
  } = req.body;

  // ✅ Vérifier si l'utilisateur existe déjà
  const { data: existingUser, error: checkError } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (checkError && checkError.code !== 'PGRST116') {
    throw checkError;
  }

  if (existingUser) {
    throw new ConflictError('Un compte existe déjà avec cet email');
  }

  // ✅ Créer l'utilisateur dans Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
    user_metadata: {
      full_name,
      phone,
      role,
    },
  });

  if (authError) {
    console.error('❌ Auth error:', authError);
    throw new ValidationError(authError.message || 'Erreur lors de la création du compte');
  }

  const userId = authData.user.id;

  // ✅ Créer le profil
  const { error: profileError } = await supabase
    .from('profiles')
    .insert({
      id: userId,
      full_name,
      email,
      phone: phone || null,
      role: role === 'aidant' ? 'aidant' : 'family',
      patient_category: hasPatient ? patientCategory : null,
      is_active: role === 'aidant' ? false : true,
      email_verified: false,
      phone_verified: false,
    });

  if (profileError) {
    console.error('❌ Profile error:', profileError);
    throw profileError;
  }

  // ✅ Si c'est un aidant, créer l'enregistrement aidant
  let aidantId = null;
  if (role === 'aidant' && aidantData) {
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .insert({
        user_id: userId,
        specialties: aidantData.specialties || [],
        available: aidantData.availability !== false,
        bio: aidantData.bio || null,
        address: aidantData.address || null,
        zones: aidantData.zones || [],
        experience_years: aidantData.experience_years ? parseInt(aidantData.experience_years) : null,
        status: 'pending',
        is_verified: false,
        max_assignments: 4,
        current_assignments: 0,
      })
      .select()
      .single();

    if (aidantError) {
      console.error('❌ Aidant error:', aidantError);
    } else {
      aidantId = aidant.id;
    }

    // ✅ Notification aux admins
    await supabase.from('notifications').insert({
      user_id: userId,
      title: '🦸 Nouvelle candidature aidant',
      body: `${full_name} a postulé comme aidant.`,
      type: 'system',
      data: { aidant_id: aidantId, action: 'review' },
    });

    // ✅ Notification aux admins
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'coordinator']);

    if (admins) {
      for (const admin of admins) {
        await supabase.from('notifications').insert({
          user_id: admin.id,
          title: '🦸 Nouvelle candidature aidant',
          body: `${full_name} a postulé comme aidant.`,
          type: 'system',
          data: { aidant_id: aidantId, action: 'review' },
        });
      }
    }
  }

  // ✅ Si c'est une famille avec patient, créer le patient
  let patientId = null;
  if (role === 'family' && hasPatient && patientData) {
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
        emergency_contact_name: patientData.emergency_contact_name || null,
        category: patientCategory,
        status: 'active',
        notes: patientData.notes || null,
        allergies: patientData.allergies || null,
        treatments: patientData.treatments || null,
        conditions: patientData.conditions || null,
        medical_history: patientData.medical_history || null,
        created_by: userId,
      })
      .select()
      .single();

    if (patientError) {
      console.error('❌ Patient error:', patientError);
    } else {
      patientId = patient.id;

      // ✅ Lier le patient à la famille
      await supabase
        .from('patient_family_links')
        .insert({
          patient_id: patient.id,
          family_id: userId,
          is_primary: true,
          can_manage_visits: true,
          can_manage_orders: true,
          can_receive_notifications: true,
        });
    }
  }

  // ✅ Enregistrer l'inscription
  await supabase
    .from('inscriptions')
    .insert({
      user_id: userId,
      patient_data: patientData || null,
      offre_id: req.body.offreId || null,
      status: 'en_attente',
      source: req.headers['user-agent'] || 'unknown',
      ip_address: req.ip || req.connection?.remoteAddress || null,
    });

  // ✅ Envoyer email de bienvenue
  try {
    const template = templates.welcome(full_name, patientCategory === 'maman_bebe' ? 'maman' : 'general');
    await sendEmail({
      to: email,
      subject: template.subject,
      htmlContent: template.htmlContent,
    });
  } catch (emailError) {
    console.error('Email welcome error:', emailError);
  }

  res.status(201).json({
    success: true,
    message: role === 'aidant' 
      ? 'Candidature envoyée avec succès. Notre équipe vous contactera.'
      : 'Inscription envoyée avec succès. Votre compte est en attente de validation.',
    data: {
      user_id: userId,
      role,
      patient_id: patientId,
      aidant_id: aidantId,
    },
  });
});

// ============================================================
// CONNEXION (backend)
// ============================================================
const login = asyncWrapper(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new ValidationError('Email et mot de passe requis');
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return res.status(401).json({
      success: false,
      error: 'Email ou mot de passe incorrect',
    });
  }

  // ✅ Récupérer le profil
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  res.json({
    success: true,
    data: {
      user: data.user,
      profile,
      session: data.session,
    },
  });
});

// ============================================================
// RÉCUPÉRER L'UTILISATEUR CONNECTÉ
// ============================================================
const getMe = asyncWrapper(async (req, res) => {
  res.json({
    success: true,
    data: {
      user: req.user,
      profile: req.profile,
    },
  });
});

// ============================================================
// CHANGER DE RÔLE
// ============================================================
const switchRole = asyncWrapper(async (req, res) => {
  const { role } = req.body;
  const userId = req.user.id;

  // ✅ Vérifier que l'utilisateur peut changer de rôle
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
      error: 'Non autorisé à passer en admin',
    });
  }

  if (!allowedRoles.includes(role) && role !== 'admin') {
    return res.status(400).json({
      success: false,
      error: 'Rôle invalide',
    });
  }

  const { error } = await supabase
    .from('profiles')
    .update({ role })
    .eq('id', userId);

  if (error) throw error;

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  res.json({
    success: true,
    message: 'Rôle mis à jour',
    data: profile,
  });
});

// ============================================================
// AJOUTER UN PATIENT (PROCHE)
// ============================================================
const addPatient = asyncWrapper(async (req, res) => {
  const userId = req.user.id;
  const {
    first_name,
    last_name,
    age,
    gender,
    address,
    phone,
    emergency_contact,
    emergency_contact_name,
    category,
    notes,
    allergies,
    treatments,
    conditions,
    medical_history,
  } = req.body;

  // ✅ Créer le patient
  const { data: patient, error } = await supabase
    .from('patients')
    .insert({
      first_name,
      last_name,
      age: age ? parseInt(age) : null,
      gender: gender || null,
      address,
      phone: phone || null,
      emergency_contact: emergency_contact || null,
      emergency_contact_name: emergency_contact_name || null,
      category: category || 'senior',
      status: 'active',
      notes: notes || null,
      allergies: allergies || null,
      treatments: treatments || null,
      conditions: conditions || null,
      medical_history: medical_history || null,
      created_by: userId,
    })
    .select()
    .single();

  if (error) throw error;

  // ✅ Lier à la famille
  await supabase
    .from('patient_family_links')
    .insert({
      patient_id: patient.id,
      family_id: userId,
      is_primary: true,
      can_manage_visits: true,
      can_manage_orders: true,
      can_receive_notifications: true,
    });

  // ✅ Mettre à jour la catégorie du profil
  if (category) {
    await supabase
      .from('profiles')
      .update({ patient_category: category })
      .eq('id', userId);
  }

  res.status(201).json({
    success: true,
    message: 'Proche ajouté avec succès',
    data: patient,
  });
});

// ============================================================
// SUPPRIMER LE COMPTE
// ============================================================
const deleteAccount = asyncWrapper(async (req, res) => {
  const { userId } = req.body;
  const requestingUserId = req.user.id;

  // ✅ Vérifier les permissions
  if (userId !== requestingUserId) {
    const isAdmin = ['admin', 'coordinator'].includes(req.profile?.role);
    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Non autorisé',
      });
    }
  }

  // ✅ Supprimer les données liées
  await supabase.from('patient_family_links').delete().eq('family_id', userId);
  await supabase.from('inscriptions').delete().eq('user_id', userId);
  await supabase.from('notifications').delete().eq('user_id', userId);
  await supabase.from('push_tokens').delete().eq('user_id', userId);
  await supabase.from('profiles').delete().eq('id', userId);

  // ✅ Supprimer l'utilisateur Auth
  if (userId === requestingUserId) {
    await supabase.auth.admin.deleteUser(userId);
  }

  res.json({
    success: true,
    message: 'Compte supprimé avec succès',
  });
});

// ============================================================
// MOT DE PASSE OUBLIÉ
// ============================================================
const forgotPassword = asyncWrapper(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new ValidationError('Email requis');
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.CLIENT_URL}/reset-password`,
  });

  if (error) throw error;

  res.json({
    success: true,
    message: 'Email de réinitialisation envoyé',
  });
});

// ============================================================
// RÉINITIALISER LE MOT DE PASSE
// ============================================================
const resetPassword = asyncWrapper(async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    throw new ValidationError('Token et mot de passe requis');
  }

  // ✅ Vérifier le token via Supabase
  const { error } = await supabase.auth.updateUser({
    password,
  });

  if (error) throw error;

  res.json({
    success: true,
    message: 'Mot de passe réinitialisé avec succès',
  });
});

// ============================================================
// ADMIN - APPROUVER UN AIDANT
// ============================================================
const approveAidant = asyncWrapper(async (req, res) => {
  const { aidantId, comments } = req.body;

  // ✅ Récupérer l'aidant
  const { data: aidant, error: fetchError } = await supabase
    .from('aidants')
    .select('user_id')
    .eq('id', aidantId)
    .single();

  if (fetchError || !aidant) {
    return res.status(404).json({
      success: false,
      error: 'Aidant non trouvé',
    });
  }

  // ✅ Mettre à jour l'aidant
  const { error: updateError } = await supabase
    .from('aidants')
    .update({
      status: 'approved',
      is_verified: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', aidantId);

  if (updateError) throw updateError;

  // ✅ Mettre à jour le profil
  await supabase
    .from('profiles')
    .update({ is_active: true })
    .eq('id', aidant.user_id);

  // ✅ Notification à l'aidant
  await supabase.from('notifications').insert({
    user_id: aidant.user_id,
    title: '✅ Compte aidant approuvé',
    body: `Votre compte a été approuvé. Vous pouvez maintenant accepter des missions.`,
    type: 'system',
    data: { aidant_id: aidantId },
  });

  // ✅ Email à l'aidant
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', aidant.user_id)
    .single();

  if (profile) {
    try {
      const template = templates.aidantApproved(profile.full_name);
      await sendEmail({
        to: profile.email,
        subject: template.subject,
        htmlContent: template.htmlContent,
      });
    } catch (emailError) {
      console.error('Email aidant approved error:', emailError);
    }
  }

  res.json({
    success: true,
    message: 'Aidant approuvé avec succès',
    data: aidant,
  });
});

// ============================================================
// ADMIN - REFUSER UN AIDANT
// ============================================================
const rejectAidant = asyncWrapper(async (req, res) => {
  const { aidantId, comments } = req.body;

  // ✅ Récupérer l'aidant
  const { data: aidant, error: fetchError } = await supabase
    .from('aidants')
    .select('user_id')
    .eq('id', aidantId)
    .single();

  if (fetchError || !aidant) {
    return res.status(404).json({
      success: false,
      error: 'Aidant non trouvé',
    });
  }

  // ✅ Mettre à jour l'aidant
  const { error: updateError } = await supabase
    .from('aidants')
    .update({
      status: 'rejected',
      is_verified: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', aidantId);

  if (updateError) throw updateError;

  // ✅ Notification à l'aidant
  await supabase.from('notifications').insert({
    user_id: aidant.user_id,
    title: '❌ Candidature aidant refusée',
    body: `Votre candidature n'a pas été retenue. ${comments ? `Motif : ${comments}` : ''}`,
    type: 'system',
    data: { aidant_id: aidantId },
  });

  // ✅ Email à l'aidant
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', aidant.user_id)
    .single();

  if (profile) {
    try {
      const template = templates.aidantRejected(profile.full_name);
      await sendEmail({
        to: profile.email,
        subject: template.subject,
        htmlContent: template.htmlContent,
      });
    } catch (emailError) {
      console.error('Email aidant rejected error:', emailError);
    }
  }

  res.json({
    success: true,
    message: 'Candidature aidant refusée',
    data: aidant,
  });
});

// ============================================================
// ADMIN - TRAITER UNE INSCRIPTION
// ============================================================
const processRegistration = asyncWrapper(async (req, res) => {
  const { registrationId, status, comments } = req.body;
  const adminId = req.user.id;

  // ✅ Vérifier l'inscription
  const { data: registration, error: fetchError } = await supabase
    .from('inscriptions')
    .select('*')
    .eq('id', registrationId)
    .single();

  if (fetchError || !registration) {
    return res.status(404).json({
      success: false,
      error: 'Inscription non trouvée',
    });
  }

  // ✅ Mettre à jour l'inscription
  const { data: updated, error: updateError } = await supabase
    .from('inscriptions')
    .update({
      status,
      comments: comments || null,
      processed_by: adminId,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', registrationId)
    .select()
    .single();

  if (updateError) throw updateError;

  // ✅ Si validée, activer le compte
  if (status === 'validee' && registration.user_id) {
    await supabase
      .from('profiles')
      .update({ is_active: true })
      .eq('id', registration.user_id);

    // ✅ Notification à l'utilisateur
    await supabase.from('notifications').insert({
      user_id: registration.user_id,
      title: '✅ Inscription validée',
      body: 'Votre inscription a été validée. Bienvenue chez Santé Plus Services !',
      type: 'system',
      data: { registration_id: registrationId },
    });

    // ✅ Email de bienvenue
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', registration.user_id)
      .single();

    if (profile) {
      try {
        const template = templates.registrationValidated({
          name: profile.full_name,
        });
        await sendEmail({
          to: profile.email,
          subject: template.subject,
          htmlContent: template.htmlContent,
        });
      } catch (emailError) {
        console.error('Email registration validated error:', emailError);
      }
    }
  }

  res.json({
    success: true,
    message: 'Inscription traitée avec succès',
    data: updated,
  });
});

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  register,
  login,
  getMe,
  switchRole,
  addPatient,
  deleteAccount,
  forgotPassword,
  resetPassword,
  approveAidant,
  rejectAidant,
  processRegistration,
};
