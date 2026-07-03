// 📁 backend/src/controllers/patient.controller.js

const { supabase } = require('../services/supabase.service');
const { asyncWrapper, NotFoundError, ValidationError } = require('../utils/errorHandler');

// ============================================================
// RÉCUPÉRER TOUS LES PATIENTS
// ============================================================
const getPatients = asyncWrapper(async (req, res) => {
  const userId = req.user.id;
  const userRole = req.profile?.role;

  let query = supabase.from('patients').select('*');

  // 👔 Admin / Coordinator → Tous les patients
  if (['admin', 'coordinator'].includes(userRole)) {
    // Pas de filtre
  }
  // 👨‍👩‍👦 Family → Ses patients
  else if (userRole === 'family') {
    const { data: links } = await supabase
      .from('patient_family_links')
      .select('patient_id')
      .eq('family_id', userId);

    const patientIds = links?.map(l => l.patient_id) || [];
    if (patientIds.length === 0) {
      return res.json({ success: true, data: [], count: 0 });
    }
    query = query.in('id', patientIds);
  }
  // 🦸 Aidant → Ses patients assignés
  else if (userRole === 'aidant') {
    const { data: assignments } = await supabase
      .from('aidant_assignments')
      .select('target_id')
      .eq('aidant_user_id', userId)
      .eq('target_type', 'patient')
      .eq('status', 'active');

    const patientIds = assignments?.map(a => a.target_id) || [];
    if (patientIds.length === 0) {
      return res.json({ success: true, data: [], count: 0 });
    }
    query = query.in('id', patientIds);
  }

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;

  res.json({ success: true, data: data || [], count: data?.length || 0 });
});

// ============================================================
// RÉCUPÉRER UN PATIENT PAR ID
// ============================================================
const getPatientById = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const userRole = req.profile?.role;

  const { data: patient, error } = await supabase
    .from('patients')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !patient) {
    throw new NotFoundError('Patient');
  }

  // ✅ Vérifier l'accès
  let hasAccess = ['admin', 'coordinator'].includes(userRole);

  if (!hasAccess && userRole === 'family') {
    const { data: link } = await supabase
      .from('patient_family_links')
      .select('id')
      .eq('family_id', userId)
      .eq('patient_id', id)
      .maybeSingle();
    hasAccess = !!link;
  }

  if (!hasAccess && userRole === 'aidant') {
    const { data: assignment } = await supabase
      .from('aidant_assignments')
      .select('id')
      .eq('aidant_user_id', userId)
      .eq('target_type', 'patient')
      .eq('target_id', id)
      .eq('status', 'active')
      .maybeSingle();
    hasAccess = !!assignment;
  }

  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      error: 'Accès non autorisé à ce patient',
    });
  }

  res.json({ success: true, data: patient });
});

// ============================================================
// CRÉER UN PATIENT
// ============================================================
const createPatient = asyncWrapper(async (req, res) => {
  const userId = req.user.id;
  const userRole = req.profile?.role;

  if (userRole === 'aidant') {
    return res.status(403).json({
      success: false,
      error: 'Les aidants ne peuvent pas créer de patients',
    });
  }

  const {
    first_name,
    last_name,
    age,
    gender,
    address,
    phone,
    emergency_contact,
    emergency_contact_name,
    category = 'senior',
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
      category,
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
    message: 'Patient créé avec succès',
    data: patient,
  });
});

// ============================================================
// METTRE À JOUR UN PATIENT
// ============================================================
const updatePatient = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const userRole = req.profile?.role;

  if (userRole === 'aidant') {
    return res.status(403).json({
      success: false,
      error: 'Les aidants ne peuvent pas modifier les patients',
    });
  }

  // ✅ Vérifier l'accès
  let hasAccess = ['admin', 'coordinator'].includes(userRole);

  if (!hasAccess && userRole === 'family') {
    const { data: link } = await supabase
      .from('patient_family_links')
      .select('id')
      .eq('family_id', userId)
      .eq('patient_id', id)
      .maybeSingle();
    hasAccess = !!link;
  }

  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      error: 'Non autorisé à modifier ce patient',
    });
  }

  const { data, error } = await supabase
    .from('patients')
    .update({
      ...req.body,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  res.json({
    success: true,
    message: 'Patient mis à jour',
    data,
  });
});

// ============================================================
// SUPPRIMER UN PATIENT
// ============================================================
const deletePatient = asyncWrapper(async (req, res) => {
  const { id } = req.params;
  const userRole = req.profile?.role;

  if (!['admin', 'coordinator'].includes(userRole)) {
    return res.status(403).json({
      success: false,
      error: 'Non autorisé à supprimer des patients',
    });
  }

  // ✅ Supprimer les liens
  await supabase.from('patient_family_links').delete().eq('patient_id', id);
  await supabase.from('aidant_assignments').delete().eq('target_type', 'patient').eq('target_id', id);

  // ✅ Supprimer le patient
  const { error } = await supabase
    .from('patients')
    .delete()
    .eq('id', id);

  if (error) throw error;

  res.json({
    success: true,
    message: 'Patient supprimé',
  });
});

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getPatients,
  getPatientById,
  createPatient,
  updatePatient,
  deletePatient,
};
