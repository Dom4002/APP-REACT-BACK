// 📁 backend/src/routes/offers.routes.js
// ✅ OFFRES D'ABONNEMENTS : CALCUL DE PÉRIODE DYNAMIQUE SELON LA DURÉE RÉELLE POUR ÉVITER LES CONFLITS DE CONTRAINTES SQL

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');

// ============================================================
// HELPER : CARTOGRAPHIE ET TRADUCTION DE L'OFFRE DEPUIS LA BASE
// ============================================================
const mapOfferFromDb = (item) => {
  let period = item.type === 'ponctuelle' ? 'intervention' : (item.type || 'mois');
  
  // ✅ Traduire dynamiquement la période d'affichage selon les jours de validité réels
  if (item.category === 'maman_bebe') {
    if (item.duration_days === 14) period = '2 semaines';
    else if (item.duration_days === 21) period = '3 semaines';
    else if (item.duration_days === 28) period = '4 semaines';
    else if (item.duration_days === 35) period = '5 semaines';
  }

  return {
    id: item.id,
    name: item.name,
    category: item.category,
    type: item.type || 'mensuelle',
    description: item.description,
    price: item.price || 0,
    period: period, // ✅ Période dynamique (2, 3, 4, 5 semaines) pour l'affichage
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
  };
};

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

    const offers = (data || []).map(item => mapOfferFromDb(item));

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
// GET /api/offers/categories - Récupérer les offres par catégorie
// ============================================================
router.get('/categories', async (req, res) => {
  try {
    const { category } = req.query;

    if (!category) {
      return res.status(400).json({
        success: false,
        error: 'Le paramètre "category" est requis'
      });
    }

    let query = supabase
      .from('offres')
      .select('*')
      .eq('is_active', true);

    if (category === 'ponctuelle') {
      query = query.or(`category.eq.ponctuelle, type.eq.ponctuelle`);
    } else if (category === 'senior' || category === 'maman_bebe' || category === 'pack_confort') {
      query = query.eq('category', category);
    } else {
      query = query.neq('category', 'ponctuelle').neq('type', 'ponctuelle');
    }

    const { data, error } = await query.order('display_order', { ascending: true });

    if (error) throw error;

    const offers = (data || []).map(item => mapOfferFromDb(item));

    res.json({
      success: true,
      data: offers,
      count: offers.length,
      category: category,
    });
  } catch (error) {
    console.error('❌ GET /offers/categories error:', error);
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

    res.json({ success: true, data: mapOfferFromDb(data) });
  } catch (error) {
    console.error('❌ GET /offers/:id error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================================
// GET /api/offers/type/:type - Récupérer les offres par type
// ============================================================
router.get('/type/:type', async (req, res) => {
  try {
    const { type } = req.params;

    if (!type) {
      return res.status(400).json({
        success: false,
        error: 'Le paramètre "type" est requis'
      });
    }

    const { data, error } = await supabase
      .from('offres')
      .select('*')
      .eq('is_active', true)
      .eq('type', type)
      .order('display_order', { ascending: true });

    if (error) throw error;

    const offers = (data || []).map(item => mapOfferFromDb(item));

    res.json({
      success: true,
      data: offers,
      count: offers.length,
      type: type,
    });
  } catch (error) {
    console.error('❌ GET /offers/type/:type error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// GET /api/offers/ponctual - Récupérer les offres ponctuelles
// ============================================================
router.get('/ponctual', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('offres')
      .select('*')
      .eq('is_active', true)
      .or(`category.eq.ponctuelle, type.eq.ponctuelle`)
      .order('display_order', { ascending: true });

    if (error) throw error;

    const offers = (data || []).map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      type: item.type || 'ponctuelle',
      description: item.description,
      price: item.price || 0,
      period: 'intervention',
      visitsPerWeek: null,
      durationDays: 1,
      features: item.features || ['Service ponctuel', 'Sans engagement', 'Paiement unique'],
      badge: item.badge || '⚡ Ponctuel',
      is_active: item.is_active ?? true,
      is_public: item.is_public ?? true,
      display_order: item.display_order || 0,
      visits_per_month: null,
      total_visits: 1,
      total_orders: 1,
      created_at: item.created_at,
      updated_at: item.updated_at,
    }));

    res.json({
      success: true,
      data: offers,
      count: offers.length,
    });
  } catch (error) {
    console.error('❌ GET /offers/ponctual error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// POST /api/offers - Créer une nouvelle offre
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

    if (!name || !category) {
      return res.status(400).json({
        success: false,
        error: 'Le nom et la catégorie sont obligatoires'
      });
    }

    if (category === 'ponctuelle' || type === 'ponctuelle') {
      const ponctualData = {
        name,
        category: 'ponctuelle',
        type: 'ponctuelle',
        description: description || 'Service ponctuel sans engagement',
        price: price || 0,
        visits_per_week: null,
        duration_days: 1,
        features: features || ['Service ponctuel', 'Sans engagement', 'Paiement unique'],
        badge: badge || '⚡ Ponctuel',
        is_active: is_active ?? true,
        is_public: is_public ?? true,
        display_order: display_order || 0,
        visits_per_month: null,
        total_visits: 1,
        total_orders: 1,
      };

      const { data, error } = await supabase
        .from('offres')
        .insert(ponctualData)
        .select()
        .single();

      if (error) throw error;

      return res.status(201).json({
        success: true,
        message: 'Offre ponctuelle créée avec succès',
        data: mapOfferFromDb(data)
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
      data: mapOfferFromDb(data)
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
// PUT /api/offers/:id - Modifier une offre
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
      data: mapOfferFromDb(data)
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
// DELETE /api/offers/:id - Supprimer une offre
// ============================================================
router.delete('/:id', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

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
// POST /api/offers/sync - Synchroniser les offres
// ============================================================
router.post('/sync', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('offres')
      .select('*')
      .order('display_order', { ascending: true });

    if (error) throw error;

    const offers = (data || []).map(item => mapOfferFromDb(item));

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
