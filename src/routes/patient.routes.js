// 📁 backend/src/routes/patient.routes.js
 
const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');

router.use(authMiddleware);

// =============================================
// ✅ LISTE DES PATIENTS - FILTRÉE PAR RÔLE
// =============================================
router.get('/', async (req, res) => {
  try {
    const { user, profile } = req;

    let query = supabase.from('patients').select('*');

    // 👨‍👩‍👦 FAMILLE → Ses patients
    if (profile.role === 'family') {
      const { data: links } = await supabase
        .from('patient_family_links')
        .select('patient_id')
        .eq('family_id', user.id);

      const patientIds = links?.map(l => l.patient_id) || [];
      if (patientIds.length > 0) {
        query = query.in('id', patientIds);
      } else {
        return res.json([]);
      }
    }
    
    // 🦸 AIDANT → Patients assignés via les visites
    else if (profile.role === 'aidant') {
      // 1. Récupérer l'aidant
      const { data: aidant, error: aidantError } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();

      if (aidantError || !aidant) {
        return res.json([]);
      }

      // 2. Récupérer les patients via les visites assignées
      const { data: visits, error: visitsError } = await supabase
        .from('visites')
        .select('patient_id')
        .eq('aidant_id', aidant.id)
        .not('patient_id', 'is', null);

      if (visitsError) {
        console.error('❌ Erreur récupération visites aidant:', visitsError);
        return res.json([]);
      }

      // 3. Extraire les IDs uniques des patients
      const patientIds = [...new Set(visits?.map(v => v.patient_id).filter(Boolean))];
      
      if (patientIds.length > 0) {
        query = query.in('id', patientIds);
      } else {
        return res.json([]);
      }
    }
    // 👔 ADMIN / COORDINATEUR → Tous les patients
    // Pas de filtre supplémentaire

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Get patients error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ PATIENT PAR ID - AVEC VÉRIFICATION PERMISSIONS
// =============================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, profile } = req;

    // 1. Récupérer le patient
    const { data: patient, error } = await supabase
      .from('patients')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Patient non trouvé' });
      }
      throw error;
    }

    // 2. Vérifier les permissions
    let hasAccess = false;

    if (profile.role === 'admin' || profile.role === 'coordinator') {
      hasAccess = true;
    } else if (profile.role === 'family') {
      const { data: link } = await supabase
        .from('patient_family_links')
        .select('id')
        .eq('family_id', user.id)
        .eq('patient_id', id)
        .maybeSingle();
      hasAccess = !!link;
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();

      if (aidant) {
        const { data: visit } = await supabase
          .from('visites')
          .select('id')
          .eq('aidant_id', aidant.id)
          .eq('patient_id', id)
          .limit(1)
          .maybeSingle();
        hasAccess = !!visit;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Accès non autorisé à ce patient' });
    }

    res.json(patient);
  } catch (error) {
    console.error('❌ Get patient by ID error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ CRÉER UN PATIENT - SEULS ADMIN/COORDINATEUR
// =============================================
router.post('/', roleMiddleware(['coordinator', 'admin']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('patients')
      .insert({ ...req.body, created_by: req.user.id })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, patient: data });
  } catch (error) {
    console.error('❌ Create patient error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ MODIFIER UN PATIENT - SEULS ADMIN/COORDINATEUR OU FAMILLE PROPRIÉTAIRE
// =============================================
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, profile } = req;

    // Vérifier si l'utilisateur a le droit de modifier
    let canEdit = false;

    if (profile.role === 'admin' || profile.role === 'coordinator') {
      canEdit = true;
    } else if (profile.role === 'family') {
      const { data: link } = await supabase
        .from('patient_family_links')
        .select('id')
        .eq('family_id', user.id)
        .eq('patient_id', id)
        .maybeSingle();
      canEdit = !!link;
    }

    // ❌ Les aidants ne peuvent PAS modifier les patients
    if (profile.role === 'aidant') {
      return res.status(403).json({ error: 'Les aidants ne peuvent pas modifier les patients' });
    }

    if (!canEdit) {
      return res.status(403).json({ error: 'Non autorisé à modifier ce patient' });
    }

    const { data, error } = await supabase
      .from('patients')
      .update(req.body)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, patient: data });
  } catch (error) {
    console.error('❌ Update patient error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ SUPPRIMER UN PATIENT - SEULS ADMIN/COORDINATEUR
// =============================================
router.delete('/:id', roleMiddleware(['coordinator', 'admin']), async (req, res) => {
  try {
    const { id } = req.params;

    // Vérifier que le patient existe
    const { data: patient, error: checkError } = await supabase
      .from('patients')
      .select('id')
      .eq('id', id)
      .single();

    if (checkError) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }

    // Supprimer les liens familiaux
    await supabase.from('patient_family_links').delete().eq('patient_id', id);

    // Supprimer le patient
    const { error } = await supabase.from('patients').delete().eq('id', id);
    if (error) throw error;

    res.json({ success: true, message: 'Patient supprimé avec succès' });
  } catch (error) {
    console.error('❌ Delete patient error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ VISITES D'UN PATIENT - AVEC VÉRIFICATION PERMISSIONS
// =============================================
router.get('/:id/visits', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, profile } = req;

    // Vérifier l'accès au patient
    let hasAccess = false;

    if (profile.role === 'admin' || profile.role === 'coordinator') {
      hasAccess = true;
    } else if (profile.role === 'family') {
      const { data: link } = await supabase
        .from('patient_family_links')
        .select('id')
        .eq('family_id', user.id)
        .eq('patient_id', id)
        .maybeSingle();
      hasAccess = !!link;
    } else if (profile.role === 'aidant') {
      const { data: aidant } = await supabase
        .from('aidants')
        .select('id')
        .eq('user_id', user.id)
        .single();

      if (aidant) {
        const { data: visit } = await supabase
          .from('visites')
          .select('id')
          .eq('aidant_id', aidant.id)
          .eq('patient_id', id)
          .limit(1)
          .maybeSingle();
        hasAccess = !!visit;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Accès non autorisé aux visites de ce patient' });
    }

    const { data, error } = await supabase
      .from('visites')
      .select('*, aidant:aidants(*, user:profiles(*))')
      .eq('patient_id', id)
      .order('scheduled_date', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Get patient visits error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ ASSIGNER UN AIDANT À UN PATIENT (ADMIN SEULEMENT)
// =============================================
router.post('/:id/assign-aidant', roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { aidantId, assignmentType = 'permanente', expiresAt = null } = req.body;

    // Vérifier que le patient existe
    const { data: patient, error: patientError } = await supabase
      .from('patients')
      .select('id')
      .eq('id', id)
      .single();

    if (patientError) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }

    // Vérifier que l'aidant existe et est approuvé
    const { data: aidant, error: aidantError } = await supabase
      .from('aidants')
      .select('id, user_id, is_verified, status')
      .eq('id', aidantId)
      .single();

    if (aidantError || !aidant) {
      return res.status(404).json({ error: 'Aidant non trouvé' });
    }

    if (!aidant.is_verified || aidant.status !== 'approved') {
      return res.status(400).json({ error: 'Cet aidant n\'est pas approuvé' });
    }

    // Enregistrer l'assignation
    const { data: assignment, error: assignError } = await supabase
      .from('patient_aidant_assignments')
      .insert({
        patient_id: id,
        aidant_id: aidantId,
        assigned_by: req.user.id,
        assignment_type: assignmentType || 'permanente',
        expires_at: expiresAt || null,
      })
      .select()
      .single();

    if (assignError) {
      // Si la table n'existe pas, on utilise patient_family_links
      // ou on crée une entrée dans la table aidants
      console.warn('⚠️ Table patient_aidant_assignments non disponible, utilisation de patient_family_links');
      
      // Vérifier si un lien existe déjà
      const { data: existingLink } = await supabase
        .from('patient_family_links')
        .select('id')
        .eq('patient_id', id)
        .eq('family_id', aidant.user_id)
        .maybeSingle();

      if (!existingLink) {
        await supabase
          .from('patient_family_links')
          .insert({
            patient_id: id,
            family_id: aidant.user_id,
            is_primary: false,
            can_manage_visits: true,
            can_manage_orders: true,
            can_receive_notifications: true,
          });
      }
    }

    // Notification à l'aidant
    await supabase.from('notifications').insert({
      user_id: aidant.user_id,
      title: '📋 Nouveau patient assigné',
      body: `Vous avez été assigné au patient ${patient.first_name} ${patient.last_name}. Type: ${assignmentType || 'permanente'}`,
      type: 'system',
      data: { patient_id: id, assignment_type: assignmentType },
    });

    res.json({ 
      success: true, 
      message: 'Aidant assigné avec succès',
      assignment: assignment || { patient_id: id, aidant_id: aidantId }
    });
  } catch (error) {
    console.error('❌ Assign aidant error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// ✅ RÉCUPÉRER LES AIDANTS D'UN PATIENT
// =============================================
router.get('/:id/aidants', async (req, res) => {
  try {
    const { id } = req.params;
    const { profile } = req;

    // Seuls admin/coord peuvent voir cette info
    if (profile.role !== 'admin' && profile.role !== 'coordinator') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    // Récupérer les aidants assignés via patient_family_links
    const { data: links, error: linksError } = await supabase
      .from('patient_family_links')
      .select(`
        family_id,
        profiles!inner(id, full_name, email, phone)
      `)
      .eq('patient_id', id);

    if (linksError) throw linksError;

    // Filtrer pour ne garder que les aidants
    const aidants = links
      ?.filter(l => l.profiles?.role === 'aidant')
      .map(l => l.profiles) || [];

    res.json(aidants);
  } catch (error) {
    console.error('❌ Get patient aidants error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
