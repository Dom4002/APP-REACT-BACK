// 📁 backend/src/routes/contract.routes.js

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase.service');
const authMiddleware = require('../middleware/auth.middleware');

// Toutes les routes nécessitent une authentification
router.use(authMiddleware);

// =============================================
// GET /api/contract/status
// Récupère le statut du contrat pour l'utilisateur connecté
// =============================================
router.get('/status', async (req, res) => {
  try {
    const { role } = req.profile;
    const userId = req.user.id;

    // Appeler la fonction SQL get_contract_status
    const { data, error } = await supabase.rpc('get_contract_status', {
      p_user_id: userId,
      p_role: role,
    });

    if (error) throw error;

    res.json({
      success: true,
      ...data,
    });
  } catch (error) {
    console.error('❌ Contract status error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération du statut',
    });
  }
});

// =============================================
// GET /api/contract/active
// Récupère le contrat actif pour le rôle de l'utilisateur
// =============================================
router.get('/active', async (req, res) => {
  try {
    const { role } = req.profile;

    const { data, error } = await supabase
      .from('contracts')
      .select('*')
      .eq('role', role)
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Aucun contrat actif trouvé pour ce rôle',
        });
      }
      throw error;
    }

    // Vérifier si déjà accepté
    const { data: acceptance, error: acceptError } = await supabase
      .from('contract_acceptances')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('contract_id', data.id)
      .maybeSingle();

    if (acceptError) throw acceptError;

    res.json({
      success: true,
      contract: data,
      accepted: !!acceptance,
      needs_acceptance: !acceptance,
    });
  } catch (error) {
    console.error('❌ Active contract error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération du contrat',
    });
  }
});

// =============================================
// POST /api/contract/accept
// Accepte le contrat pour l'utilisateur connecté
// =============================================
router.post('/accept', async (req, res) => {
  try {
    const { contract_id } = req.body;
    const userId = req.user.id;
    const { role } = req.profile;

    if (!contract_id) {
      return res.status(400).json({
        success: false,
        error: 'contract_id est requis',
      });
    }

    // Vérifier que le contrat existe et est actif
    const { data: contract, error: contractError } = await supabase
      .from('contracts')
      .select('*')
      .eq('id', contract_id)
      .eq('is_active', true)
      .single();

    if (contractError || !contract) {
      return res.status(404).json({
        success: false,
        error: 'Contrat non trouvé ou inactif',
      });
    }

    // Vérifier que le contrat correspond au rôle de l'utilisateur
    if (contract.role !== role) {
      return res.status(400).json({
        success: false,
        error: 'Ce contrat ne correspond pas à votre rôle',
      });
    }

    // Vérifier si déjà accepté
    const { data: existing, error: checkError } = await supabase
      .from('contract_acceptances')
      .select('id')
      .eq('user_id', userId)
      .eq('contract_id', contract_id)
      .maybeSingle();

    if (checkError) throw checkError;

    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Contrat déjà accepté',
      });
    }

    // Enregistrer l'acceptation
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;

    // Appeler la fonction SQL accept_contract
    const { data: acceptanceId, error: acceptError } = await supabase.rpc('accept_contract', {
      p_user_id: userId,
      p_contract_id: contract_id,
      p_ip_address: ip,
      p_user_agent: userAgent,
    });

    if (acceptError) throw acceptError;

    // Récupérer l'acceptation complète
    const { data: acceptance, error: fetchError } = await supabase
      .from('contract_acceptances')
      .select(`
        *,
        contract:contracts(*)
      `)
      .eq('id', acceptanceId)
      .single();

    if (fetchError) throw fetchError;

    res.json({
      success: true,
      message: 'Contrat accepté avec succès',
      acceptance,
    });

  } catch (error) {
    console.error('❌ Accept contract error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de l\'acceptation du contrat',
    });
  }
});

// =============================================
// GET /api/contract/history
// Récupère l'historique des acceptations de l'utilisateur
// =============================================
router.get('/history', async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('contract_acceptances')
      .select(`
        *,
        contract:contracts(*)
      `)
      .eq('user_id', userId)
      .order('accepted_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      history: data || [],
    });
  } catch (error) {
    console.error('❌ Contract history error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erreur lors de la récupération de l\'historique',
    });
  }
});

module.exports = router;
