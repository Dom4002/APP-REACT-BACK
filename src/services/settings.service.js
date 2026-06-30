// 📁 backend/src/services/settings.service.js

const { supabase } = require('./supabase.service');

/**
 * Récupère tous les paramètres
 */
const getAllSettings = async () => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .order('category', { ascending: true });

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('❌ Get all settings error:', error);
    throw error;
  }
};

/**
 * Récupère les paramètres par catégorie
 */
const getSettingsByCategory = async (category) => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .eq('category', category);

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('❌ Get settings by category error:', error);
    throw error;
  }
};

/**
 * Récupère un paramètre par sa clé
 */
const getSettingByKey = async (key) => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .eq('key', key)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('❌ Get setting by key error:', error);
    return null;
  }
};

/**
 * Met à jour un paramètre
 */
const updateSetting = async (key, value, userId) => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .update({
        value: value,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('key', key)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('❌ Update setting error:', error);
    throw error;
  }
};

/**
 * Met à jour plusieurs paramètres
 */
const updateSettings = async (settings, userId) => {
  try {
    const results = [];
    for (const [key, value] of Object.entries(settings)) {
      const result = await updateSetting(key, value, userId);
      results.push(result);
    }
    return results;
  } catch (error) {
    console.error('❌ Update settings error:', error);
    throw error;
  }
};

/**
 * Récupère les paramètres publics
 */
const getPublicSettings = async () => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('key, value, type, category')
      .eq('is_public', true);

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('❌ Get public settings error:', error);
    throw error;
  }
};

module.exports = {
  getAllSettings,
  getSettingsByCategory,
  getSettingByKey,
  updateSetting,
  updateSettings,
  getPublicSettings,
};