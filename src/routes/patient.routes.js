// 📁 backend/src/routes/patient.routes.js
// ✅ ROUTEUR PATIENTS : RÉSOLUTION DES ATTRIBUTIONS ACTIVES DE L'AIDANT (PATIENTS & COMPTES EN DIRECT)

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');

router.use(authMiddleware);

// =============================================
// ✅ LISTE DES PATIENTS - FILTRÉE PAR RÔLE AVEC REPLI D'ASSIGNATIONS SECURISE
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
      
      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;
      return res.json(data);
    }
    
    // 🦸 AIDANT → Patients et Comptes Personnels assignés via active aidant_assignments (Bypasse RLS)
    else if (profile.role === 'aidant') {
      console.log('🦸 Aidant connecté - Résolution des bénéficiaires assignés');

      // 1. Récupérer les assignations actives pour cet aidant (par son user_id)
      const { data: assignments, error: assignmentsError } = await supabase
        .from('aidant_assignments')
        .select('target_type, target_id')
        .eq('aidant_user_id', user.id)
        .eq('status', 'active');

      if (assignmentsError) {
        console.error('❌ Erreur récupération assignations aidant:', assignmentsError);
        return res.json([]);
      }

      if (!assignments || assignments.length === 0) {
        return res.json([]);
      }

      // Filtrer les cibles
      const patientIds = assignments
        .filter(a => a.target_type === 'patient')
        .map(a => a.target_id);

      const personalAccountIds = assignments
        .filter(a => a.target_type === 'personal_account' || a.target_type === 'personal')
        .map(a => a.target_id);

      let finalPatients = [];

      // Charger les vrais patients rattachés
      if (patientIds.length > 0) {
        const { data: dbPatients, error: dbPatientsError } = await supabase
          .from('patients')
          .select('*')
          .in('id', patientIds);

        if (!dbPatientsError && dbPatients) {
          finalPatients = [...dbPatients];
        }
      }

      // Charger les comptes personnels suivis en direct (et les mapper au format Patient pour le frontend)
      if (personalAccountIds.length > 0) {
        const { data: dbProfiles, error: dbProfilesError } = await supabase
          .from('profiles')
          .select('id, full_name, email, phone, avatar_url, patient_category')
          .in('id', personalAccountIds);

        if (!dbProfilesError && dbProfiles) {
          const mappedPersonalProfiles = dbProfiles.map(p => ({
            id: p.id,
            first_name: p.full_name,
            last_name: '(Compte Personnel)', // Indication visuelle claire de l'abonné
            age: null,
            gender: null,
            address: 'Adresse du compte de l\'abonné', 
            latitude: null, // Propriété requise pour l'interface Proche/Patient
            longitude: null, // Propriété requise pour l'interface Proche/Patient
            phone: p.phone,
            emergency_contact: null,
            emergency_contact_name: null,
            category: p.patient_category || 'senior', // Type de profil
            status: 'active',
            notes: 'Abonné suivi en direct sur son compte personnel',
            allergies: null,
            treatments: null,
            conditions: null,
            medical_history: null,
            preferred_language: 'fr',
            special_requirements: null,
            created_by: p.id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            target_type: 'personal_account', // Utilisé pour l'aiguillage actif
          }));

          finalPatients = [...finalPatients, ...mappedPersonalProfiles];
        }
      }

      return res.json(finalPatients);
    }
    
    // 👔 ADMIN / COORDINATEUR → Tous les patients
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

    const { data: patient, error } = await supabase
      .from('patients')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Fallback : Vérifier s'il s'agit d'un profil de compte personnel
        const { data: userProfile, error: profileErr } = await supabase
          .from('profiles')
          .select('id, full_name, email, phone, avatar_url, patient_category')
          .eq('id', id)
          .single();

        if (!profileErr && userProfile) {
          const mappedProfile = {
            id: userProfile.id,
            first_name: userProfile.full_name,
            last_name: '(Compte Personnel)',
            age: null,
            gender: null,
            address: 'Adresse personnelle',
            latitude: null,
            longitude: null,
            phone: userProfile.phone,
            category: userProfile.patient_category || 'senior',
            status: 'active',
            notes: 'Suivi direct du compte personnel',
            preferred_language: 'fr',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            target_type: 'personal_account',
          };
          return res.json(mappedProfile);
        }

        return res.status(404).json({ error: 'Bénéficiaire non trouvé' });
      }
      throw error;
    }

    // Permissions
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
      const { data: assignment } = await supabase
        .from('aidant_assignments')
        .select('id')
        .eq('aidant_user_id', user.id)
        .eq('target_id', id)
        .eq('status', 'active')
        .maybeSingle();
      hasAccess = !!assignment;
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Accès non autorisé' });
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
// ✅ MODIFIER UN PATIENT
// =============================================
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { user, profile } = req;

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
// ✅ SUPPRIMER UN PATIENT
// =============================================
router.delete('/:id', roleMiddleware(['coordinator', 'admin']), async (req, res) => {
  try {
    const { id } = req.params;

    const { data: patient, error: checkError } = await supabase
      .from('patients')
      .select('id')
      .eq('id', id)
      .single();

    if (checkError) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }

    await supabase.from('patient_family_links').delete().eq('patient_id', id);

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
      const { data: assignment } = await supabase
        .from('aidant_assignments')
        .select('id')
        .eq('aidant_user_id', user.id)
        .eq('target_id', id)
        .eq('status', 'active')
        .maybeSingle();
      hasAccess = !!assignment;
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Accès non autorisé' });
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

    const { data: patient, error: patientError } = await supabase
      .from('patients')
      .select('id')
      .eq('id', id)
      .single();

    if (patientError) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }

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
      console.warn('⚠️ Table patient_aidant_assignments non disponible, utilisation de patient_family_links');
      
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

    if (profile.role !== 'admin' && profile.role !== 'coordinator') {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const { data: links, error: linksError } = await supabase
      .from('patient_family_links')
      .select(`
        family_id,
        profiles!inner(id, full_name, email, phone)
      `)
      .eq('patient_id', id);

    if (linksError) throw linksError;

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
