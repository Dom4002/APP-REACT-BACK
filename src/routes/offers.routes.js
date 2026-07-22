// 📁 backend/src/routes/offers.routes.js
// ✅ OFFRES D'ABONNEMENTS : CATALOGUE DYNAMIQUE ET GESTION ADMIN

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
    period: period,
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
    res.json({ success: true, data: (data || []).map(mapOfferFromDb), count: data?.length || 0 });
  } catch (error) {
    console.error('❌ GET /offers error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// GET /api/offers/categories - Récupérer les offres par catégorie
// ============================================================
router.get('/categories', async (req, res) => {
  try {
    const { category } = req.query;
    let query = supabase.from('offres').select('*').eq('is_active', true);

    if (category === 'ponctuelle') {
      query = query.or(`category.eq.ponctuelle, type.eq.ponctuelle`);
    } else if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query.order('display_order', { ascending: true });
    if (error) throw error;
    res.json({ success: true, data: (data || []).map(mapOfferFromDb) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// GET /api/offers/:id - Récupérer une offre par ID
// ============================================================
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('offres').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ success: false, error: 'Offre non trouvée' });
    res.json({ success: true, data: mapOfferFromDb(data) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// POST /api/offers - Créer une nouvelle offre
// ============================================================
router.post('/', authMiddleware, roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { data, error } = await supabase.from('offres').insert(req.body).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, data: mapOfferFromDb(data) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// PUT /api/offers/:id - Modifier une offre (Logique Dynamique)
// ============================================================
router.put('/:id', authMiddleware, roleMiddleware(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;

    // Liste des champs modifiables (évite les erreurs d'injection ou champs protégés)
    const allowedFields = [
      'name', 'category', 'type', 'description', 'price', 
      'visits_per_week', 'duration_days', 'features', 'badge', 
      'is_active', 'is_public', 'display_order', 'visits_per_month', 
      'total_visits', 'total_orders'
    ];

    const updateData = {};
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('offres')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ success: false, error: 'Offre non trouvée' });
      throw error;
    }

    res.json({ success: true, message: 'Offre mise à jour', data: mapOfferFromDb(data) });
  } catch (error) {
    console.error('❌ PUT /offers/:id error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// DELETE /api/offers/:id - Désactiver une offre
// ============================================================
router.delete('/:id', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
  try {
    const { error } = await supabase
      .from('offres')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true, message: 'Offre désactivée' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
