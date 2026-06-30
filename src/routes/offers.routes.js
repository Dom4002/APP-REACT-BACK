// 📁 backend/src/routes/offers.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const roleMiddleware = require('../middleware/role.middleware');

// ============================================================
// GET /api/offers - Récupérer toutes les offres actives
// ============================================================
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('offres')
      .select('*')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) throw error;

    // Transformer les données pour le frontend
    const offers = (data || []).map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      type: item.type || 'mensuelle',
      description: item.description,
      price: item.price || 0,
      period: item.type === 'ponctuelle' ? 'intervention' : (item.type || 'mois'),
      visitsPerWeek: item.visits_per_week || null,
      durationDays: item.duration_days || null,
      features: item.features || [],
      badge: item.badge || null,
      is_active: item.is_active ?? true,
      is_public: item.is_public ?? true,
      display_order: item.display_order || 0,
      visits_per_month: item.visits_per_month || null,
      total_visits: item.total_visits || null,
      total_orders: item.total_orders || null,
      created_at: item.created_at,
      updated_at: item.updated_at,
    }));

    res.json({ 
      success: true, 
      data: offers,
      count: offers.length 
    });
  } catch (error) {
    console.error('❌ GET /offers error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================================
// GET /api/offers/:id - Récupérer une offre par ID
// ============================================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('offres')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ 
          success: false, 
          error: 'Offre non trouvée' 
        });
      }
      throw error;
    }

    const offer = {
      id: data.id,
      name: data.name,
      category: data.category,
      type: data.type || 'mensuelle',
      description: data.description,
      price: data.price || 0,
      period: data.type === 'ponctuelle' ? 'intervention' : (data.type || 'mois'),
      visitsPerWeek: data.visits_per_week || null,
      durationDays: data.duration_days || null,
      features: data.features || [],
      badge: data.badge || null,
      is_active: data.is_active ?? true,
      is_public: data.is_public ?? true,
      display_order: data.display_order || 0,
      visits_per_month: data.visits_per_month || null,
      total_visits: data.total_visits || null,
      total_orders: data.total_orders || null,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };

    res.json({ success: true, data: offer });
  } catch (error) {
    console.error('❌ GET /offers/:id error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================================
// POST /api/offers - Créer une nouvelle offre (Admin/Coord uniquement)
// ============================================================
router.post('/', authMiddleware, roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const {
      name,
      category,
      type,
      description,
      price,
      visits_per_week,
      duration_days,
      features,
      badge,
      is_active,
      is_public,
      display_order,
      visits_per_month,
      total_visits,
      total_orders,
    } = req.body;

    // Validation
    if (!name || !category) {
      return res.status(400).json({
        success: false,
        error: 'Le nom et la catégorie sont obligatoires'
      });
    }

    const { data, error } = await supabase
      .from('offres')
      .insert({
        name,
        category,
        type: type || 'mensuelle',
        description: description || null,
        price: price || 0,
        visits_per_week: visits_per_week || null,
        duration_days: duration_days || null,
        features: features || [],
        badge: badge || null,
        is_active: is_active ?? true,
        is_public: is_public ?? true,
        display_order: display_order || 0,
        visits_per_month: visits_per_month || null,
        total_visits: total_visits || null,
        total_orders: total_orders || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Offre créée avec succès',
      data: {
        id: data.id,
        name: data.name,
        category: data.category,
        type: data.type,
        description: data.description,
        price: data.price,
        visits_per_week: data.visits_per_week,
        duration_days: data.duration_days,
        features: data.features,
        badge: data.badge,
        is_active: data.is_active,
        is_public: data.is_public,
        display_order: data.display_order,
        visits_per_month: data.visits_per_month,
        total_visits: data.total_visits,
        total_orders: data.total_orders,
        created_at: data.created_at,
        updated_at: data.updated_at,
      }
    });
  } catch (error) {
    console.error('❌ POST /offers error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// PUT /api/offers/:id - Modifier une offre (Admin/Coord uniquement)
// ============================================================
router.put('/:id', authMiddleware, roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      category,
      type,
      description,
      price,
      visits_per_week,
      duration_days,
      features,
      badge,
      is_active,
      is_public,
      display_order,
      visits_per_month,
      total_visits,
      total_orders,
    } = req.body;

    // Vérifier que l'offre existe
    const { data: existing, error: checkError } = await supabase
      .from('offres')
      .select('id')
      .eq('id', id)
      .single();

    if (checkError) {
      if (checkError.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Offre non trouvée'
        });
      }
      throw checkError;
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (category !== undefined) updateData.category = category;
    if (type !== undefined) updateData.type = type;
    if (description !== undefined) updateData.description = description;
    if (price !== undefined) updateData.price = price;
    if (visits_per_week !== undefined) updateData.visits_per_week = visits_per_week;
    if (duration_days !== undefined) updateData.duration_days = duration_days;
    if (features !== undefined) updateData.features = features;
    if (badge !== undefined) updateData.badge = badge;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (is_public !== undefined) updateData.is_public = is_public;
    if (display_order !== undefined) updateData.display_order = display_order;
    if (visits_per_month !== undefined) updateData.visits_per_month = visits_per_month;
    if (total_visits !== undefined) updateData.total_visits = total_visits;
    if (total_orders !== undefined) updateData.total_orders = total_orders;

    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('offres')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Offre mise à jour avec succès',
      data: {
        id: data.id,
        name: data.name,
        category: data.category,
        type: data.type,
        description: data.description,
        price: data.price,
        visits_per_week: data.visits_per_week,
        duration_days: data.duration_days,
        features: data.features,
        badge: data.badge,
        is_active: data.is_active,
        is_public: data.is_public,
        display_order: data.display_order,
        visits_per_month: data.visits_per_month,
        total_visits: data.total_visits,
        total_orders: data.total_orders,
        created_at: data.created_at,
        updated_at: data.updated_at,
      }
    });
  } catch (error) {
    console.error('❌ PUT /offers/:id error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// DELETE /api/offers/:id - Supprimer une offre (Admin uniquement)
// ============================================================
router.delete('/:id', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    // Vérifier que l'offre n'est pas utilisée par des abonnements actifs
    const { data: subscriptions, error: subError } = await supabase
      .from('abonnements')
      .select('id')
      .eq('offre_id', id)
      .eq('status', 'actif')
      .limit(1);

    if (subError) throw subError;

    if (subscriptions && subscriptions.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cette offre est utilisée par des abonnements actifs. Désactivez-la plutôt que de la supprimer.'
      });
    }

    // Soft delete : désactiver plutôt que supprimer
    const { error } = await supabase
      .from('offres')
      .update({ 
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Offre désactivée avec succès'
    });
  } catch (error) {
    console.error('❌ DELETE /offers/:id error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// POST /api/offers/sync - Synchroniser les offres (Admin uniquement)
// ============================================================
router.post('/sync', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
  try {
    // Récupérer toutes les offres (actives et inactives)
    const { data, error } = await supabase
      .from('offres')
      .select('*')
      .order('display_order', { ascending: true });

    if (error) throw error;

    const offers = (data || []).map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      type: item.type || 'mensuelle',
      description: item.description,
      price: item.price || 0,
      period: item.type === 'ponctuelle' ? 'intervention' : (item.type || 'mois'),
      visitsPerWeek: item.visits_per_week || null,
      durationDays: item.duration_days || null,
      features: item.features || [],
      badge: item.badge || null,
      is_active: item.is_active ?? true,
      is_public: item.is_public ?? true,
      display_order: item.display_order || 0,
      visits_per_month: item.visits_per_month || null,
      total_visits: item.total_visits || null,
      total_orders: item.total_orders || null,
      created_at: item.created_at,
      updated_at: item.updated_at,
    }));

    res.json({
      success: true,
      data: offers,
      count: offers.length,
      message: 'Synchronisation terminée'
    });
  } catch (error) {
    console.error('❌ POST /offers/sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
