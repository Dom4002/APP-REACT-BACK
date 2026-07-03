// 📁 backend/src/controllers/admin.controller.js

const { supabase } = require('../services/supabase.service');
const { asyncWrapper } = require('../utils/errorHandler');

// ============================================================
// STATISTIQUES ADMIN
// ============================================================
const getStats = asyncWrapper(async (req, res) => {
  const [
    { count: totalUsers },
    { count: activeUsers },
    { count: totalPatients },
    { count: personalAccounts },
    { count: totalAidants },
    { count: pendingRegistrations },
    { count: visitsToday },
    { count: visitsInProgress },
    { count: totalOrders },
    { count: pendingOrders },
  ] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('patients').select('*', { count: 'exact', head: true }),
    supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'family').is('patient_category', null),
    supabase.from('aidants').select('*', { count: 'exact', head: true }),
    supabase.from('inscriptions').select('*', { count: 'exact', head: true }).eq('status', 'en_attente'),
    supabase.from('visites').select('*', { count: 'exact', head: true }).eq('scheduled_date', new Date().toISOString().split('T')[0]),
    supabase.from('visites').select('*', { count: 'exact', head: true }).eq('status', 'en_cours'),
    supabase.from('commandes').select('*', { count: 'exact', head: true }),
    supabase.from('commandes').select('*', { count: 'exact', head: true }).in('status', ['creee', 'en_attente']),
  ]);

  // ✅ Revenus
  const { data: payments } = await supabase
    .from('paiements')
    .select('amount')
    .eq('status', 'valide');

  const totalRevenue = payments?.reduce((sum, p) => sum + Number(p.amount || 0), 0) || 0;

  res.json({
    success: true,
    data: {
      total_users: totalUsers || 0,
      active_users: activeUsers || 0,
      total_patients: totalPatients || 0,
      personal_accounts: personalAccounts || 0,
      total_aidants: totalAidants || 0,
      pending_registrations: pendingRegistrations || 0,
      visits_today: visitsToday || 0,
      visits_in_progress: visitsInProgress || 0,
      total_orders: totalOrders || 0,
      pending_orders: pendingOrders || 0,
      total_revenue: totalRevenue,
    },
  });
});

// ============================================================
// RÉCUPÉRER LES UTILISATEURS
// ============================================================
const getUsers = asyncWrapper(async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;

  res.json({ success: true, data: data || [] });
});

// ============================================================
// METTRE À JOUR LE RÔLE D'UN UTILISATEUR
// ============================================================
const updateUserRole = asyncWrapper(async (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;

  const { data, error } = await supabase
    .from('profiles')
    .update({ role })
    .eq('id', userId)
    .select()
    .single();

  if (error) throw error;

  res.json({
    success: true,
    message: 'Rôle mis à jour',
    data,
  });
});

// ============================================================
// SUPPRIMER UN UTILISATEUR
// ============================================================
const deleteUser = asyncWrapper(async (req, res) => {
  const { userId } = req.params;

  // ✅ Supprimer les données liées
  await supabase.from('patient_family_links').delete().eq('family_id', userId);
  await supabase.from('inscriptions').delete().eq('user_id', userId);
  await supabase.from('notifications').delete().eq('user_id', userId);
  await supabase.from('push_tokens').delete().eq('user_id', userId);
  await supabase.from('profiles').delete().eq('id', userId);

  // ✅ Supprimer l'utilisateur Auth
  await supabase.auth.admin.deleteUser(userId);

  res.json({
    success: true,
    message: 'Utilisateur supprimé',
  });
});

// ============================================================
// RÉCUPÉRER LES INSCRIPTIONS
// ============================================================
const getRegistrations = asyncWrapper(async (req, res) => {
  const { data, error } = await supabase
    .from('inscriptions')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;

  // ✅ Enrichir avec les profils
  const userIds = data?.map(r => r.user_id).filter(Boolean) || [];
  let profilesMap = {};

  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, email, phone, role')
      .in('id', userIds);

    if (profiles) {
      profilesMap = profiles.reduce((acc, p) => {
        acc[p.id] = p;
        return acc;
      }, {});
    }
  }

  const registrations = (data || []).map(r => ({
    ...r,
    user: r.user_id ? profilesMap[r.user_id] || null : null,
  }));

  res.json({ success: true, data: registrations });
});

// ============================================================
// RÉCUPÉRER LES AIDANTS DISPONIBLES
// ============================================================
const getAvailableAidants = asyncWrapper(async (req, res) => {
  const { data, error } = await supabase
    .from('aidants')
    .select(`
      *,
      user:profiles!user_id(*)
    `)
    .eq('available', true)
    .eq('is_verified', true)
    .eq('status', 'approved')
    .order('rating', { ascending: false });

  if (error) throw error;

  res.json({ success: true, data: data || [] });
});

// ============================================================
// RÉCUPÉRER LES OFFRES
// ============================================================
const getOffers = asyncWrapper(async (req, res) => {
  const { data, error } = await supabase
    .from('offres')
    .select('*')
    .order('display_order', { ascending: true });

  if (error) throw error;

  res.json({ success: true, data: data || [] });
});

// ============================================================
// CRÉER UNE OFFRE
// ============================================================
const createOffer = asyncWrapper(async (req, res) => {
  const { data, error } = await supabase
    .from('offres')
    .insert(req.body)
    .select()
    .single();

  if (error) throw error;

  res.status(201).json({
    success: true,
    message: 'Offre créée',
    data,
  });
});

// ============================================================
// METTRE À JOUR UNE OFFRE
// ============================================================
const updateOffer = asyncWrapper(async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('offres')
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
    message: 'Offre mise à jour',
    data,
  });
});

// ============================================================
// SUPPRIMER UNE OFFRE
// ============================================================
const deleteOffer = asyncWrapper(async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('offres')
    .delete()
    .eq('id', id);

  if (error) throw error;

  res.json({
    success: true,
    message: 'Offre supprimée',
  });
});

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getStats,
  getUsers,
  updateUserRole,
  deleteUser,
  getRegistrations,
  getAvailableAidants,
  getOffers,
  createOffer,
  updateOffer,
  deleteOffer,
};
