// 📁 backend/src/services/contract.service.js

const { supabase } = require('./supabase.service');

/**
 * Récupère le contrat actif pour un rôle donné
 */
const getActiveContract = async (role) => {
  try {
    const { data, error } = await supabase
      .from('contracts')
      .select('*')
      .eq('role', role)
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      // Si aucun contrat trouvé, retourner null
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return data;
  } catch (error) {
    console.error('❌ Get active contract error:', error);
    throw error;
  }
};

/**
 * Vérifie si un utilisateur a déjà accepté un contrat spécifique
 */
const hasAcceptedContract = async (userId, contractId) => {
  try {
    const { data, error } = await supabase
      .from('user_contract_acceptances')
      .select('id')
      .eq('user_id', userId)
      .eq('contract_id', contractId)
      .maybeSingle();

    if (error) throw error;
    return !!data;
  } catch (error) {
    console.error('❌ Check contract acceptance error:', error);
    return false;
  }
};

/**
 * Enregistre l'acceptation d'un contrat par un utilisateur
 */
const acceptContract = async (userId, contractId, ip, userAgent) => {
  try {
    const { data, error } = await supabase
      .from('user_contract_acceptances')
      .insert({
        user_id: userId,
        contract_id: contractId,
        ip_address: ip,
        user_agent: userAgent,
      })
      .select(`
        *,
        contract:contracts(*)
      `)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('❌ Accept contract error:', error);
    throw error;
  }
};

/**
 * Récupère la dernière acceptation d'un utilisateur
 */
const getLatestAcceptance = async (userId) => {
  try {
    const { data, error } = await supabase
      .from('user_contract_acceptances')
      .select(`
        *,
        contract:contracts(*)
      `)
      .eq('user_id', userId)
      .order('accepted_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('❌ Get latest acceptance error:', error);
    return null;
  }
};

/**
 * Récupère le statut complet du contrat pour un utilisateur
 */
const getContractStatus = async (userId, role) => {
  try {
    // Récupérer le contrat actif
    const contract = await getActiveContract(role);
    
    if (!contract) {
      return {
        needs_acceptance: false,
        contract: null,
        has_accepted: false,
        latest_acceptance: null,
      };
    }

    // Vérifier si l'utilisateur a accepté ce contrat
    const hasAccepted = await hasAcceptedContract(userId, contract.id);
    
    // Récupérer la dernière acceptation
    let latestAcceptance = null;
    if (hasAccepted) {
      latestAcceptance = await getLatestAcceptance(userId);
    }

    return {
      needs_acceptance: !hasAccepted,
      contract,
      has_accepted: hasAccepted,
      latest_acceptance: latestAcceptance,
    };
  } catch (error) {
    console.error('❌ Get contract status error:', error);
    throw error;
  }
};

module.exports = {
  getActiveContract,
  hasAcceptedContract,
  acceptContract,
  getLatestAcceptance,
  getContractStatus,
};