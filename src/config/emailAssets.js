// 📁 backend/src/config/emailAssets.js

const path = require('path');

// ============================================================
// CONFIGURATION DES LOGOS POUR EMAILS
// ============================================================

// 🔥 En production, utiliser les URLs publiques (hébergées sur Supabase Storage)
// En développement, utiliser les fichiers locaux

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// 📌 Base URL pour les assets 
const BASE_URL = process.env.ASSETS_URL || 'https://mrsrogkjthtnppecndyc.supabase.co/storage/v1/object/public/assets/emails';

// 📌 URLs publiques des logos
const PUBLIC_URLS = {
  // Logo principal (général)
  logoGeneralIcon: `${BASE_URL}/logo-general-icon.png`,
  logoGeneralText: `${BASE_URL}/logo-general-text.png`,
  logoGeneralWhite: `${BASE_URL}/logo-general-white-bg.png`,
  
  // Logo Maman & Bébé
  logoMamanIcon: `${BASE_URL}/logo-maman-icon.png`,
  logoMamanText: `${BASE_URL}/logo-maman-text.png`,
  logoMamanWhite: `${BASE_URL}/logo-maman-white-bg.jpeg`,
};

// 📌 URLs de fallback (en cas d'échec)
const FALLBACK_URLS = {
  logoGeneral: 'https://via.placeholder.com/200x60/1a4a3a/ffffff?text=Sant%C3%A9+Plus',
  logoMaman: 'https://via.placeholder.com/200x60/db4a6d/ffffff?text=Maman+%26+B%C3%A9b%C3%A9',
  logoAidant: 'https://via.placeholder.com/200x60/2c6e5c/ffffff?text=Aidant',
};

// ============================================================
// FONCTION POUR OBTENIR LE LOGO SELON LE CONTEXTE
// ============================================================

const getLogoForEmail = (type = 'general', variant = 'default') => {
  // Déterminer le type de logo
  let logoKey;
  
  if (type === 'maman') {
    logoKey = variant === 'white' ? 'logoMamanWhite' : 'logoMamanIcon';
  } else if (type === 'aidant') {
    logoKey = variant === 'white' ? 'logoGeneralWhite' : 'logoGeneralIcon';
  } else {
    logoKey = variant === 'white' ? 'logoGeneralWhite' : 'logoGeneralIcon';
  }
  
  return PUBLIC_URLS[logoKey] || FALLBACK_URLS.logoGeneral;
};

const getLogoTextForEmail = (type = 'general') => {
  if (type === 'maman') {
    return PUBLIC_URLS.logoMamanText || FALLBACK_URLS.logoMaman;
  }
  return PUBLIC_URLS.logoGeneralText || FALLBACK_URLS.logoGeneral;
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  PUBLIC_URLS,
  FALLBACK_URLS,
  getLogoForEmail,
  getLogoTextForEmail,
  IS_PRODUCTION,
};
